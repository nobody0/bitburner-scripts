import { describe, expect, test } from "bun:test";
import { goDemands } from "../shared/strategy/go/demand.ts";
import { rankGoGames } from "../shared/strategy/go/rewards.ts";
import { GO_OPPONENTS } from "../shared/strategy/go/rules.ts";
import { goGamePaysForRam } from "../game/lib/features/remaining.ts";
import { estimatedForecast, unknownForecast } from "../shared/strategy/progression/forecast.ts";
import { NOMINAL_VALUE_SEC_PER_WEIGHT } from "../shared/strategy/access/value.ts";
import type { Need, NeedKind } from "../shared/strategy/needs.ts";

function need(kind: NeedKind, subject?: string, extra?: Partial<Need>): Need {
  return {
    by: "progression",
    kind,
    ...(subject ? { subject } : {}),
    target: 1,
    have: 0,
    weight: 10,
    urgency: "blocking",
    ...extra,
  };
}

const unknownNode = unknownForecast(0, "node", "test");
const unknownInstall = unknownForecast(0, "install", "test");
/** installHorizonSec's fallback when neither forecast is usable. */
const FALLBACK_RUNWAY = 3_600;

/** A mature run: the farm earns almost everything, Hacknet a rounding error. */
const FARM_LED = { hacking: 0.8, hacknet: 0.03, career: 0.17 } as const;

describe("Go target demands", () => {
  test("a new game must repay the productive RAM it displaces", () => {
    // Four GB on a 400 GB fleet costs roughly 1% of throughput.
    expect(goGamePaysForRam(0.02, 400)).toBe(true);
    expect(goGamePaysForRam(0.00185, 400)).toBe(false);
    expect(goGamePaysForRam(0, 400)).toBe(false);
  });

  test("idle arena RAM displaces nothing, so any positive utility plays", () => {
    // The same marginal 0.00185 refused above is free money once the free
    // arena covers the whole 4 GB dodge…
    expect(goGamePaysForRam(0.00185, 400, 4)).toBe(true);
    expect(goGamePaysForRam(0.00185, 400, 100)).toBe(true);
    // …half-covered halves the bar…
    expect(goGamePaysForRam(0.00185, 400, 2)).toBe(false);
    expect(goGamePaysForRam(0.0051, 400, 2)).toBe(true);
    // …and zero utility still never plays.
    expect(goGamePaysForRam(0, 400, 400)).toBe(false);
  });

  test("uses typed critical-path resources and ignores noncritical parallel work", () => {
    const install = estimatedForecast(0, "install", [
      { what: "renamed primary work", resource: "reputation", sec: 600, measured: true, mode: "parallel" },
      { what: "misleading reputation words", resource: "money", sec: 300, measured: true, mode: "parallel" },
      { what: "finish", resource: "install", sec: 60, measured: false, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      incomeShares: { hacking: 1 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    // Only the 600s reputation part may feed the reputation opponent: if the
    // misleadingly-labelled money part leaked in by its wording, the demand
    // would exceed 600s.
    expect(demands.Daedalus?.seconds).toBe(600);
  });

  test("maps open bottlenecks to their actual opponent rewards", () => {
    const demands = goDemands({
      horizons: { install: unknownInstall, node: unknownNode },
      incomeShares: { hacknet: 1 },
      crimeIncome: { successChance: 0.5, perSec: 10, careerBestPerSec: 10 },
      openNeeds: [
        need("karma"),
        need("combatSkills"),
        need("companyRep", "ECorp"),
        need("hacknetRam"),
        need("skill", "hacking"),
      ],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands["Slum Snakes"]?.seconds).toBeGreaterThan(0);
    expect(demands.Tetrads?.seconds).toBeGreaterThan(0);
    expect(demands.Daedalus?.seconds).toBeGreaterThan(0);
    expect(demands.Netburners?.seconds).toBeGreaterThan(0);
    expect(demands.Illuminati?.seconds).toBeGreaterThan(0);
    expect(demands["????????????"]?.seconds).toBeGreaterThan(0);
  });

  test("offers a hacking-income bottleneck to both yield and cycle-speed rewards", () => {
    const install = estimatedForecast(0, "install", [
      { what: "cash for the next package", resource: "money", sec: 600, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      incomeShares: { hacking: 1 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands["The Black Hand"]?.seconds).toBe(600);
    expect(demands.Illuminati?.seconds).toBe(600);
  });

  test("maps an augmentation-package route component to its live producers", () => {
    const node = estimatedForecast(0, "node", [
      { what: "final augmentation package", resource: "augmentations", sec: 1_000, measured: false, mode: "sequential" },
      { what: "install count package", resource: "install", sec: 300, measured: false, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install: unknownInstall, node },
      incomeShares: { hacking: 1 },
      openNeeds: [],
      canEarnFactionRep: false,
      canRunBladeburner: false,
    });
    // Money at full hacking share; the reputation half needs a faction API.
    expect(demands["The Black Hand"]?.seconds).toBe(1_000);
    expect(demands["The Black Hand"]?.share).toBeCloseTo(1, 9);
    expect(demands.Illuminati?.seconds).toBe(1_000);
    expect(demands.Daedalus).toBeUndefined();
  });

  test("an augmentation package reaches reputation at half weight once factions are reachable", () => {
    const node = estimatedForecast(0, "node", [
      { what: "final augmentation package", resource: "augmentations", sec: 1_000, measured: false, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install: unknownInstall, node },
      incomeShares: { hacking: 1 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: false,
    });
    expect(demands.Daedalus?.seconds).toBe(500);
    expect(demands.Daedalus?.share).toBeCloseTo(1, 9);
  });

  test("a money bottleneck reaches each producer at that producer's measured share", () => {
    const install = estimatedForecast(0, "install", [
      { what: "cash gate", resource: "money", sec: 1_000, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      incomeShares: { hacking: 0.4, hacknet: 0.35, career: 0.25 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    // Seconds are the SAME bottleneck for everyone; the share is the whole
    // distinction, and `seconds * share` is what the ranker charges against.
    for (const opponent of ["The Black Hand", "Illuminati", "Netburners"] as const) {
      expect(demands[opponent]?.seconds, opponent).toBe(1_000);
    }
    expect(demands["The Black Hand"]?.share).toBeCloseTo(0.4, 9);
    expect(demands.Illuminati?.share).toBeCloseTo(0.4, 9);
    expect(demands.Netburners?.share).toBeCloseTo(0.35, 9);
    // No published crime chance, so no crime money leg is invented.
    expect(demands["Slum Snakes"]).toBeUndefined();
  });

  test("faction reputation and individual combat gates activate their exact rewards", () => {
    const demands = goDemands({
      horizons: { install: unknownInstall, node: unknownNode },
      incomeShares: {},
      openNeeds: [need("factionRep", "Tian Di Hui"), need("skill", "strength")],
      canEarnFactionRep: true,
      canRunBladeburner: false,
    });
    expect(demands.Daedalus).toBeDefined();
    expect(demands.Tetrads).toBeDefined();
    // Exactness: with no income shares and no other needs, an opponent fed by
    // neither gate gets no demand at all.
    expect(demands.Illuminati).toBeUndefined();
  });

  test("a need restating a priced blocker adds its own measured value and stays inside the runway", () => {
    const install = estimatedForecast(0, "install", [
      { what: "faction package", resource: "reputation", sec: 600, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      incomeShares: {},
      openNeeds: [need("factionRep", "CyberSec", { valueSec: 200 })],
      canEarnFactionRep: true,
      canRunBladeburner: false,
    });
    // No bespoke double-charge guard any more: the runway is what bounds
    // overlapping evidence. 600 + 200 clamps back to the 600s install horizon.
    expect(demands.Daedalus?.seconds).toBe(600);
  });

  test("does not target a forecast resource with no active consumer", () => {
    const node = estimatedForecast(0, "node", [
      { what: "future faction grind", resource: "reputation", sec: 50_000, measured: false, mode: "sequential" },
      { what: "future black ops", resource: "combat", sec: 50_000, measured: false, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install: unknownInstall, node },
      incomeShares: {},
      openNeeds: [],
      canEarnFactionRep: false,
      canRunBladeburner: false,
    });
    expect(demands.Daedalus).toBeUndefined();
    expect(demands.Tetrads).toBeUndefined();
  });

  test("does not value transient Go power past the next install", () => {
    const node = estimatedForecast(0, "node", [
      { what: "activate package", resource: "install", sec: 300, measured: false, mode: "sequential" },
      { what: "post-install regrow", resource: "hacking", sec: 4_500, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install: unknownInstall, node },
      incomeShares: { hacking: 1 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    // The 4,500s post-install regrow part must not be valued: whatever demand
    // survives is bounded by the 300s pre-install runway.
    expect(demands.Illuminati?.seconds ?? 0).toBeLessThanOrEqual(300);
    expect(demands["????????????"]).toBeUndefined();
  });
});

describe("Go demand attribution", () => {
  /** Both forecasts in `saturatingMoney` run 9,000s, so that is the runway. */
  const SATURATED_RUNWAY = 9_000;

  /** Money evidence far in excess of the horizon, restated three ways to verify
   * that clipping preserves each opponent's attribution share. */
  function saturatingMoney(): Parameters<typeof goDemands>[0] {
    return {
      horizons: {
        install: estimatedForecast(0, "install", [
          { what: "cash gate", resource: "money", sec: 9_000, measured: true, mode: "sequential" },
        ]),
        node: estimatedForecast(0, "node", [
          { what: "final package", resource: "augmentations", sec: 9_000, measured: false, mode: "sequential" },
        ]),
      },
      incomeShares: FARM_LED,
      openNeeds: [need("money")],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    };
  }

  test("a three-percent producer is never credited more than three percent of the runway", () => {
    const demands = goDemands(saturatingMoney());
    const netburners = demands.Netburners!;
    const blackHand = demands["The Black Hand"]!;
    // Both see the same saturated bottleneck…
    expect(netburners.seconds).toBe(blackHand.seconds);
    expect(netburners.seconds).toBeLessThanOrEqual(SATURATED_RUNWAY);
    // …and the share is what separates them, exactly as measured.
    expect(netburners.share).toBeCloseTo(0.03, 9);
    expect(blackHand.share).toBeCloseTo(0.8, 9);
    expect(netburners.seconds * netburners.share).toBeLessThanOrEqual(0.031 * SATURATED_RUNWAY);
  });

  test("a hacknet capacity gate is a money gate, priced at hacknet's share of money", () => {
    const demands = goDemands({
      horizons: { install: unknownInstall, node: unknownNode },
      incomeShares: FARM_LED,
      openNeeds: [need("hacknetRam")],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    // Buying Hacknet RAM spends dollars from every income source, so a source
    // receives credit only in proportion to its share of the money rate.
    expect(demands.Netburners?.share).toBeCloseTo(0.03, 9);
    expect(demands["The Black Hand"]?.share).toBeCloseTo(0.8, 9);
  });

  test("four combat fields are one combat gate, not four", () => {
    const node = estimatedForecast(0, "node", [
      { what: "black ops stats", resource: "combat", sec: 1_000, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install: unknownInstall, node },
      incomeShares: FARM_LED,
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands.Tetrads?.seconds).toBe(1_000);
    expect(demands.Tetrads?.share).toBeCloseTo(1, 9);
  });

  test("crime money is priced at the crime slice of career income and capped by its success headroom", () => {
    const install = estimatedForecast(0, "install", [
      { what: "cash gate", resource: "money", sec: 1_000, measured: true, mode: "sequential" },
    ]);
    const base = {
      horizons: { install, node: unknownNode },
      incomeShares: { hacking: 0.5, career: 0.5 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    } as const;

    const nearCap = goDemands({ ...base, crimeIncome: { successChance: 0.99, perSec: 10, careerBestPerSec: 10 } });
    expect(nearCap["Slum Snakes"]?.share).toBeCloseTo(0.5, 9);
    expect(nearCap["Slum Snakes"]?.gainCap).toBeCloseTo(0.01, 9);

    const roomToGrow = goDemands({ ...base, crimeIncome: { successChance: 0.5, perSec: 10, careerBestPerSec: 10 } });
    expect(roomToGrow["Slum Snakes"]?.gainCap).toBeCloseTo(0.5, 9);

    // At the cap the reward delivers nothing, whatever the multiplier.
    const capped = goDemands({ ...base, crimeIncome: { successChance: 1, perSec: 10, careerBestPerSec: 10 } });
    expect(capped["Slum Snakes"]?.gainCap).toBe(0);
  });

  test("a career share earned by salary is not credited to a crime-success reward", () => {
    const install = estimatedForecast(0, "install", [
      { what: "cash gate", resource: "money", sec: 1_000, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      incomeShares: { career: 0.5, hacking: 0.5 },
      // The job pays ten times what the best crime does.
      crimeIncome: { successChance: 0.5, perSec: 1, careerBestPerSec: 10 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands["Slum Snakes"]?.share).toBeCloseTo(0.05, 9);
  });

  test("without a published crime chance no crime money demand is invented", () => {
    const install = estimatedForecast(0, "install", [
      { what: "cash gate", resource: "money", sec: 1_000, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      incomeShares: { career: 0.9, hacking: 0.1 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands["Slum Snakes"]).toBeUndefined();
  });

  test("a need is priced by its measured value, not by claiming the whole runway", () => {
    const measured = goDemands({
      horizons: { install: unknownInstall, node: unknownNode },
      incomeShares: { hacking: 1 },
      openNeeds: [need("money", undefined, { valueSec: 120 })],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(measured["The Black Hand"]?.seconds).toBe(120);

    const nominal = goDemands({
      horizons: { install: unknownInstall, node: unknownNode },
      incomeShares: { hacking: 1 },
      openNeeds: [need("money")],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(nominal["The Black Hand"]?.seconds).toBe(10 * NOMINAL_VALUE_SEC_PER_WEIGHT);
    expect(nominal["The Black Hand"]?.seconds).toBeLessThan(FALLBACK_RUNWAY);
  });

  test("with nothing measured, hacking is assumed half the economy and nobody else any of it", () => {
    const install = estimatedForecast(0, "install", [
      { what: "cash gate", resource: "money", sec: 1_000, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      incomeShares: {},
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands["The Black Hand"]?.share).toBeCloseTo(0.5, 9);
    expect(demands.Illuminati?.share).toBeCloseTo(0.5, 9);
    expect(demands.Netburners).toBeUndefined();
  });
});

describe("demand-to-ranking seam", () => {
  /** The live state from the reported run: a mature farm, saturating money
   * evidence, reputation on the critical path, and a long Netburners streak
   * that had already grown its bonus well past everyone else's. */
  function rank(shares: Readonly<Record<string, number>>) {
    const demands = goDemands({
      horizons: {
        install: estimatedForecast(0, "install", [
          { what: "cash gate", resource: "money", sec: 9_000, measured: true, mode: "sequential" },
          { what: "faction package", resource: "reputation", sec: 9_000, measured: true, mode: "sequential" },
        ]),
        node: estimatedForecast(0, "node", [
          { what: "final package", resource: "augmentations", sec: 9_000, measured: false, mode: "sequential" },
        ]),
      },
      incomeShares: shares,
      openNeeds: [need("money"), need("factionRep", "Daedalus")],
      canEarnFactionRep: true,
      canRunBladeburner: false,
    });
    const ranked = rankGoGames({
      opponents: GO_OPPONENTS,
      stats: [
        { opponent: "Netburners", wins: 105, losses: 0, winStreak: 105, rep: 100_000, bonusPercent: 21.4 },
        { opponent: "The Black Hand", wins: 51, losses: 1, winStreak: 2, rep: 100_000, bonusPercent: 14.3 },
        { opponent: "Illuminati", wins: 22, losses: 5, winStreak: 1, rep: 0, bonusPercent: 16 },
        { opponent: "Daedalus", wins: 112, losses: 3, winStreak: 73, rep: 0, bonusPercent: 28.2 },
      ],
      joinedFactions: new Set(["Netburners", "The Black Hand", "Tetrads", "Slum Snakes"]),
      factionFavor: {},
      demands,
      goPower: 1,
      hasSourceFile14: false,
      favorRepCap: 100_000,
      installRemainingSec: 3_600,
    });
    return { demands, order: ranked.map((candidate) => candidate.opponent), ranked };
  }

  test("a rounding-error income source does not outrank the actual bottleneck", () => {
    const { order, ranked } = rank(FARM_LED);
    const netburners = order.indexOf("Netburners");
    for (const better of ["Daedalus", "Illuminati", "The Black Hand"] as const) {
      expect(order.indexOf(better), `${better} must outrank Netburners`).toBeLessThan(netburners);
    }
    // Not merely last: priced at what three percent of the economy is worth.
    expect(ranked[netburners]!.utilityPerSec * 60).toBeLessThan(2);
  });

  test("the same machinery puts Netburners first when Hacknet really is the economy", () => {
    // No opponent is weighted up or down anywhere — only the measured shares
    // differ, and the ranking follows them.
    expect(rank({ hacknet: 0.9, hacking: 0.05, career: 0.05 }).order[0]).toBe("Netburners");
  });
});

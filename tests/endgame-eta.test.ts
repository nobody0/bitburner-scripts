import { describe, expect, test } from "bun:test";
import {
  BLACK_OP_COUNT,
  DAEDALUS_MONEY,
  RED_PILL_REP,
  stepEndgame,
  type EndgameView,
} from "../shared/strategy/progression/endgame.ts";
import {
  FALLBACK_SEC_PER_BLACK_OP,
  FALLBACK_SEC_PER_CHARISMA_LEVEL,
  labyrinthWalkFallbackSec,
  optionalInstallErasedSec,
  ROUTE_DWELL_MS,
  chooseRoute,
  noRates,
  regrowInstallOverride,
  routeEtas,
  type RouteChoice,
  type RouteRates,
} from "../shared/strategy/progression/eta.ts";
import {
  FORECAST_RECALIBRATION_MS,
  FORECAST_STALE_MS,
  estimatedForecast,
  forecastAt,
  installForecast,
  nodeForecast,
  shouldReforecast,
  unknownForecast,
  usableForecastSec,
} from "../shared/strategy/progression/forecast.ts";
import { freshEndgameView as view } from "./fixtures/endgame-view.ts";

function etasFor(v: EndgameView, rates: RouteRates = noRates()) {
  return routeEtas(v, stepEndgame(v), rates);
}

describe("route ETAs", () => {
  test("every route always has a FINITE estimate — no annihilation by Infinity", () => {
    // The unworkable-faction lesson (spec/progress.md): an Infinity divides a
    // route's value to nothing and removes it from the comparison entirely,
    // when the honest statement is "probably slow, still a route".
    for (const eta of etasFor(view())) {
      expect(Number.isFinite(eta.etaSec), `${eta.id} is not finite`).toBe(true);
    }
  });

  test("with no measured rates, every part is marked unmeasured", () => {
    const daedalus = etasFor(view()).find((eta) => eta.id === "daedalus")!;
    expect(daedalus.parts.length).toBeGreaterThan(0);
    for (const part of daedalus.parts) expect(part.measured).toBe(false);
  });

  test("a measured rate shortens the estimate and marks the part", () => {
    const slow = etasFor(view()).find((eta) => eta.id === "daedalus")!;
    const fast = etasFor(view(), { ...noRates(), moneyPerSec: 1e9, hackingSkillPerSec: 5, augsPerSec: 0.01, daedalusRepPerSec: 5_000 }).find(
      (eta) => eta.id === "daedalus",
    )!;
    expect(fast.etaSec).toBeLessThan(slow.etaSec);
    expect(fast.parts.some((part) => part.measured)).toBe(true);
  });

  test("a complete route estimates zero", () => {
    const v = view({ inBladeburner: true, blackOpsComplete: BLACK_OP_COUNT });
    const blade = etasFor(v).find((eta) => eta.id === "bladeburner")!;
    expect(blade.complete).toBe(true);
    expect(blade.etaSec).toBe(0);
  });

  test("owning the pill collapses the Red Pill routes to the shared tail", () => {
    const v = view({ ownsRedPill: true, sourceFiles: { "15": 1 } });
    const etas = etasFor(v);
    const daedalus = etas.find((eta) => eta.id === "daedalus")!;
    const labyrinth = etas.find((eta) => eta.id === "labyrinth")!;
    // Same remaining work: install + regrow. Neither prices the walk or the
    // Daedalus grind it never needs again.
    expect(daedalus.etaSec).toBe(labyrinth.etaSec);
    expect(daedalus.parts.map((part) => part.what)).toEqual(["install", "regrow"]);
  });

  test("installed pill below the daemon level prices only the remaining climb", () => {
    const v = view({ ownsRedPill: true, redPillInstalled: true, hackingSkill: 100 });
    const daedalus = etasFor(v, { ...noRates(), hackingSkillPerSec: 1 }).find((eta) => eta.id === "daedalus")!;
    // BN1 world daemon is 3000: 2900 levels at 1/sec.
    expect(daedalus.parts).toEqual([{ what: "regrow", resource: "hacking", sec: 2_900, measured: true }]);
  });

  test("the Daedalus invite gate is priced as the SLOWEST parallel track", () => {
    // Money is the only slow track here; augs and skill are done.
    const v = view({ augCount: 30, hackingSkill: 2_500, money: 0 });
    const daedalus = etasFor(v, { ...noRates(), moneyPerSec: 1e6 }).find((eta) => eta.id === "daedalus")!;
    const gate = daedalus.parts.find((part) => part.what.startsWith("invite gate"))!;
    expect(gate.what).toContain("money");
    expect(gate.sec).toBeCloseTo(DAEDALUS_MONEY / 1e6, 5);
  });

  test("the Daedalus invite publishes money and its measured faster skill branch in parallel", () => {
    const v = view({ augCount: 30, hackingSkill: 10, lowestCombatSkill: 10, money: 0 });
    const hacking = etasFor(v, {
      ...noRates(),
      moneyPerSec: 1e6,
      hackingSkillPerSec: 10,
      combatSkillPerSec: 0.01,
    }).find((eta) => eta.id === "daedalus")!;
    expect(hacking.needs).toEqual([
      expect.objectContaining({ kind: "money", target: DAEDALUS_MONEY }),
      expect.objectContaining({ kind: "skill", subject: "hacking", target: 2_500 }),
    ]);

    const combat = etasFor(v, {
      ...noRates(),
      moneyPerSec: 1e6,
      hackingSkillPerSec: 0.01,
      combatSkillPerSec: 10,
    }).find((eta) => eta.id === "daedalus")!;
    expect(combat.needs).toEqual([
      expect.objectContaining({ kind: "money", target: DAEDALUS_MONEY }),
      expect.objectContaining({ kind: "combatSkills", target: 1_500 }),
    ]);
  });

  test("the pending count install does not request invitation work that prestige will erase", () => {
    const daedalus = etasFor(view({ augCount: 29, money: 0, hackingSkill: 1, lowestCombatSkill: 1 }))
      .find((eta) => eta.id === "daedalus")!;
    expect(daedalus.needs).toEqual([
      expect.objectContaining({ kind: "augCount", target: 30 }),
    ]);
  });

  test("black ops overlap with the rank climb — slower of the two, not the sum", () => {
    const done = 10;
    const v = view({ inBladeburner: true, blackOpsComplete: done, bladeburnerRank: 399_999 });
    const blade = etasFor(v, { ...noRates(), bladeburnerRankPerSec: 1 }).find((eta) => eta.id === "bladeburner")!;
    // Rank is 1 second away; the remaining ops at the fallback dominate.
    expect(blade.etaSec).toBe((BLACK_OP_COUNT - done) * FALLBACK_SEC_PER_BLACK_OP);
  });

  test("the labyrinth walk is an explicit unmeasured maze-scaled guess", () => {
    const v = view({ sourceFiles: { "15": 1 } });
    const labyrinth = etasFor(v).find((eta) => eta.id === "labyrinth")!;
    expect(labyrinth.available).toBe(true);
    const walk1 = labyrinth.parts.find((part) => part.what === "labyrinth stage 1")!;
    expect(walk1).toMatchObject({ sec: labyrinthWalkFallbackSec(0), measured: false });
    // Later labs stitch far larger mazes; a flat constant hid a ten-fold spread.
    const walk5 = labyrinth.parts.find((part) => part.what === "labyrinth stage 5")!;
    expect(walk5.sec).toBeGreaterThan(walk1.sec * 5);
  });

  test("every labyrinth stage prices its charisma gate as sequential route time", () => {
    const v = view({ bitNode: 15, darknetFullAccess: true, charismaSkill: 100 });
    const labyrinth = etasFor(v).find((eta) => eta.id === "labyrinth")!;
    const charisma = labyrinth.parts.filter((part) => part.resource === "charisma");
    // Five stages in BN15, each behind its own gate; the installs between
    // them reset charisma to 1, so no stage's climb is free.
    expect(charisma).toHaveLength(5);
    // Linear fallback: the first stage climbs from live skill, later stages
    // from the post-install floor.
    expect(charisma[0]!.sec).toBe((300 - 100) * FALLBACK_SEC_PER_CHARISMA_LEVEL);
    expect(charisma[4]!.sec).toBe((3_000 - 1) * FALLBACK_SEC_PER_CHARISMA_LEVEL);
  });

  test("a measured charisma exp rate prices the ladder in closed form with a shared stack", () => {
    const v = view({ bitNode: 15, darknetFullAccess: true, charismaSkill: 100 });
    const rates: RouteRates = {
      ...noRates(),
      charismaExp: 1_000,
      charismaExpPerSec: 100,
      charismaSkillMult: 1.1,
      augsPerSec: 1 / 600,
      charismaCatalog: { augs: [{ skillLn: Math.log(1.5), expLn: Math.log(1.25) }] },
    };
    const labyrinth = etasFor(v, rates).find((eta) => eta.id === "labyrinth")!;
    const charisma = labyrinth.parts.filter((part) => part.resource === "charisma");
    expect(charisma).toHaveLength(5);
    for (const leg of charisma) expect(leg.measured).toBe(true);
    // One shared acquisition budget for the whole ladder, not one per stage.
    const stacks = labyrinth.parts.filter((part) => part.what.startsWith("charisma multiplier stack"));
    expect(stacks.length).toBeLessThanOrEqual(1);
  });

  test("Daedalus prices queued unique augs as acquired but still requires their install", () => {
    const queued = Array.from({ length: 10 }, (_, index) => `queued-${index}`);
    const v = view({ augCount: 20, queuedAugs: queued });
    const daedalus = etasFor(v).find((eta) => eta.id === "daedalus")!;
    expect(daedalus.parts.find((part) => part.what === "final augmentation package")!.sec).toBe(0);
    expect(daedalus.parts.some((part) => part.what === "install Daedalus count package")).toBe(true);
    expect(daedalus.nextMandatoryInstall).toMatchObject({ sec: 0 });
  });

  test("a banked direct skill multiplier reduces only the post-install gate", () => {
    const v = view({ augCount: 29, queuedAugs: ["closing-slot"] });
    const ordinary = etasFor(v, { ...noRates(), moneyPerSec: 1e12, hackingSkillPerSec: 1 })
      .find((eta) => eta.id === "daedalus")!;
    const boosted = etasFor(v, {
      ...noRates(),
      moneyPerSec: 1e12,
      hackingSkillPerSec: 1,
      postInstallHackingSkillMult: 2,
    }).find((eta) => eta.id === "daedalus")!;
    const ordinaryGate = ordinary.parts.find((part) => part.what.startsWith("post-install invite gate"))!;
    const boostedGate = boosted.parts.find((part) => part.what.startsWith("post-install invite gate"))!;
    expect(boostedGate.resource).toBe("hacking");
    expect(boostedGate.sec).toBeLessThan(ordinaryGate.sec);
  });

  test("queued NeuroFlux counts once toward Daedalus only when not already installed", () => {
    const fresh = view({ augCount: 29, queuedAugs: ["NeuroFlux Governor", "NeuroFlux Governor"] });
    const freshEta = etasFor(fresh).find((eta) => eta.id === "daedalus")!;
    expect(freshEta.parts.find((part) => part.what === "final augmentation package")!.sec).toBe(0);

    const stacked = view({
      augCount: 29,
      installedAugs: { "NeuroFlux Governor": 10 },
      queuedAugs: ["NeuroFlux Governor", "NeuroFlux Governor"],
    });
    const stackedEta = etasFor(stacked).find((eta) => eta.id === "daedalus")!;
    expect(stackedEta.parts.find((part) => part.what === "final augmentation package")!.sec).toBeGreaterThan(0);
  });

  test("labyrinth ETA includes every remaining mandatory reward install", () => {
    const v = view({ bitNode: 15, darknetFullAccess: true, charismaSkill: 300 });
    const labyrinth = etasFor(v).find((eta) => eta.id === "labyrinth")!;
    expect(labyrinth.parts.filter((part) => part.resource === "install")).toHaveLength(5);
    // The first stage's gate is already met, so its remaining lead time is
    // exactly the walk.
    expect(labyrinth.nextMandatoryInstall).toMatchObject({ sec: labyrinthWalkFallbackSec(0) });
  });

  test("a live walker's measured pace replaces the current stage's walk fallback", () => {
    const v = view({ bitNode: 15, darknetFullAccess: true, charismaSkill: 300 });
    const rates: RouteRates = { ...noRates(), labyrinthWalks: { 0: { sec: 120, measured: true } } };
    const labyrinth = etasFor(v, rates).find((eta) => eta.id === "labyrinth")!;
    expect(labyrinth.parts.find((part) => part.what === "labyrinth stage 1")).toMatchObject({ sec: 120, measured: true });
    // Stages with no walker keep the fallback.
    expect(labyrinth.parts.find((part) => part.what === "labyrinth stage 2")).toMatchObject({
      sec: labyrinthWalkFallbackSec(1),
      measured: false,
    });
  });

  test("an optional reset is charged the route progress it erases", () => {
    const rates: RouteRates = { ...noRates(), moneyPerSec: 1e6, hackingSkillPerSec: 1 };
    // Nothing banked, skill at the floor: a reset erases nothing.
    expect(optionalInstallErasedSec(
      [{ kind: "money", target: 1e11, have: 0 }],
      view({ money: 0 }),
      rates,
    )).toBe(0);
    // Banked gate money is re-earned at the measured income rate.
    expect(optionalInstallErasedSec(
      [{ kind: "money", target: 1e11, have: 5e8 }],
      view({ money: 5e8 }),
      rates,
    )).toBe(500);
    // A live climb toward a skill gate is re-earned too (linear tracker here),
    // and the two add: both are erased by the same reset.
    const both = optionalInstallErasedSec(
      [
        { kind: "money", target: 1e11, have: 5e8 },
        { kind: "skill", subject: "hacking", target: 2_500, have: 1_600 },
      ],
      view({ money: 5e8, hackingSkill: 1_600 }),
      rates,
    );
    expect(both).toBe(500 + 1_599);
    // Count and reputation needs are not erased-progress: installs ADVANCE
    // the count gate, and reputation converts to favor at the reset.
    expect(optionalInstallErasedSec(
      [
        { kind: "augCount", target: 30, have: 20 },
        { kind: "factionRep", subject: "Daedalus", target: 2.5e6, have: 1e6 },
      ],
      view({}),
      rates,
    )).toBe(0);
    // A charisma gate mid-climb (the labyrinth ladder) counts the same way.
    expect(optionalInstallErasedSec(
      [{ kind: "charisma", target: 2_500, have: 1_900 }],
      view({ bitNode: 15, charismaSkill: 1_900 }),
      { ...noRates(), charismaSkillPerSec: 2 },
    )).toBe(1_899 / 2);
  });

  test("route evaluation for all BitNodes remains comfortably below the 10ms budget", () => {
    const started = performance.now();
    let evaluated = 0;
    for (let repeat = 0; repeat < 100; repeat++) {
      for (let bitNode = 1; bitNode <= 15; bitNode++) {
        const v = view({ bitNode, darknetFullAccess: true, bladeburnerAvailable: true });
        etasFor(v);
        evaluated++;
      }
    }
    const perPlanMs = (performance.now() - started) / evaluated;
    expect(perPlanMs).toBeLessThan(10);
  });
});

describe("route choice", () => {
  const etas = (daedalus: number, labyrinth: number) => [
    { id: "daedalus" as const, available: true, complete: false, etaSec: daedalus, parts: [] },
    { id: "labyrinth" as const, available: true, complete: false, etaSec: labyrinth, parts: [] },
  ];

  test("first decision picks the fastest available route and reports a switch", () => {
    const { choice, switched } = chooseRoute(undefined, etas(1_000, 500), 0);
    expect(choice?.route).toBe("labyrinth");
    expect(switched).toBe(true);
  });

  test("no available route yields no choice", () => {
    const unavailable = etas(1, 1).map((eta) => ({ ...eta, available: false }));
    expect(chooseRoute(undefined, unavailable, 0)).toEqual({ choice: undefined, switched: false });
  });

  test("a mechanically available but unexecutable route cannot lock the run", () => {
    const routes = etas(1_000, 1).map((eta) =>
      eta.id === "labyrinth" ? { ...eta, actionable: false } : eta,
    );
    expect(chooseRoute(undefined, routes, 0).choice?.route).toBe("daedalus");
  });

  test("a complete route wins immediately, margin and dwell notwithstanding", () => {
    const previous: RouteChoice = { route: "daedalus", etaSec: 100, decidedAt: 0 };
    const done = [...etas(100, 5_000), { id: "bladeburner" as const, available: true, complete: true, etaSec: 0, parts: [] }];
    const { choice, switched } = chooseRoute(previous, done, 1);
    expect(choice?.route).toBe("bladeburner");
    expect(switched).toBe(true);
  });

  test("hysteresis: a marginally faster challenger does not flap the route", () => {
    const previous: RouteChoice = { route: "daedalus", etaSec: 1_000, decidedAt: 0 };
    // 10% faster is within the 25% margin — stay, even after the dwell.
    const { choice, switched } = chooseRoute(previous, etas(1_000, 900), ROUTE_DWELL_MS + 1);
    expect(switched).toBe(false);
    expect(choice?.route).toBe("daedalus");
    expect(choice?.decidedAt).toBe(0);
  });

  test("dwell: even a decisive challenger waits out the hold", () => {
    const previous: RouteChoice = { route: "daedalus", etaSec: 1_000, decidedAt: 0 };
    const early = chooseRoute(previous, etas(1_000, 100), ROUTE_DWELL_MS - 1);
    expect(early.switched).toBe(false);
    const late = chooseRoute(previous, etas(1_000, 100), ROUTE_DWELL_MS + 1);
    expect(late.switched).toBe(true);
    expect(late.choice?.route).toBe("labyrinth");
    expect(late.choice?.decidedAt).toBe(ROUTE_DWELL_MS + 1);
  });

  test("an incumbent that stops being available is replaced at once", () => {
    const previous: RouteChoice = { route: "labyrinth", etaSec: 100, decidedAt: 0 };
    const gone = etas(1_000, 100).map((eta) => (eta.id === "labyrinth" ? { ...eta, available: false } : eta));
    const { choice, switched } = chooseRoute(previous, gone, 1);
    expect(choice?.route).toBe("daedalus");
    expect(switched).toBe(true);
  });

  test("staying refreshes the estimate but keeps the decision time", () => {
    const previous: RouteChoice = { route: "daedalus", etaSec: 1_000, decidedAt: 42 };
    const { choice } = chooseRoute(previous, etas(800, 5_000), ROUTE_DWELL_MS * 2);
    expect(choice).toMatchObject({ route: "daedalus", etaSec: 800, decidedAt: 42 });
  });
});

describe("anchored uncapped forecasts", () => {
  test("a multi-day estimate stays uncapped and counts down", () => {
    const week = estimatedForecast(1_000, "week", [
      { what: "long route", resource: "other", sec: 7 * 86_400, measured: true, mode: "sequential" },
    ]);
    expect(week.remainingSec).toBe(7 * 86_400);
    expect(forecastAt(week, 3_601_000)).toMatchObject({ state: "stale", remainingSec: 7 * 86_400 - 3_600 });
  });

  test("re-estimates every minute or when the structural basis changes", () => {
    const forecast = estimatedForecast(1_000, "same", [
      { what: "work", resource: "other", sec: 100, measured: true, mode: "sequential" },
    ]);
    expect(shouldReforecast(forecast, 1_000 + FORECAST_RECALIBRATION_MS - 1, "same")).toBe(false);
    expect(shouldReforecast(forecast, 1_000 + FORECAST_RECALIBRATION_MS, "same")).toBe(true);
    expect(shouldReforecast(forecast, 2_000, "changed")).toBe(true);
    const unknown = unknownForecast(1_000, "same", "waiting for a package");
    expect(shouldReforecast(unknown, 1_000 + FORECAST_RECALIBRATION_MS - 1, "same")).toBe(false);
    expect(shouldReforecast(unknown, 2_000, "changed")).toBe(true);
  });

  test("a complete route publishes NO node forecast", () => {
    // Completion is a separately armed transaction (or manual without SF4).
    // Publishing a 0-second economic horizon would freeze every horizon-gated
    // purchase while that handoff is pending.
    const done = nodeForecast(0, { id: "daedalus", available: true, complete: true, etaSec: 0, parts: [] }, "basis");
    expect(done.state).toBe("unknown");
    expect(usableForecastSec(done)).toBeUndefined();
  });

  test("unknown and stale stay explicit", () => {
    expect(usableForecastSec(unknownForecast(0, "route", "no route"))).toBeUndefined();
    const forecast = estimatedForecast(0, "route", [
      { what: "work", resource: "other", sec: 100, measured: true, mode: "sequential" },
    ]);
    const stale = forecastAt(forecast, FORECAST_STALE_MS + 1);
    expect(stale.state).toBe("stale");
    expect(usableForecastSec(stale)).toBeUndefined();
  });

  test("install ETA is the critical parallel path plus final sweep", () => {
    const forecast = installForecast(0, {
      installNow: false,
      queuedCount: 1,
      phase: "finishUp",
      workMeasured: true,
      moneyMeasured: true,
      finalSweepReady: false,
      intent: {
        faction: "Daedalus", repTarget: 1_000, augmentations: ["a"], value: 1, etaSec: 700, rate: 1,
        marginalRate: 1, unlockSec: 100, repSec: 500, moneySec: 300, favorAfterInstall: 0,
        totalCost: 1, purchaseCost: 1, donationCost: 0, purpose: "augmentations",
      },
    }, "package");
    expect(forecast).toMatchObject({
      state: "estimated",
      remainingSec: 660,
      confidence: "mixed",
      components: [
        { critical: true, measured: true },
        { critical: false, measured: true },
        { critical: true, measured: false },
      ],
    });

    const cadenceHeld = installForecast(0, {
      installNow: false,
      queuedCount: 0,
      phase: "start",
      workMeasured: true,
      moneyMeasured: true,
      finalSweepReady: false,
      cadenceSec: 900,
      intent: {
        faction: "CyberSec", repTarget: 100, augmentations: ["a"], value: 1, etaSec: 100, rate: 1,
        marginalRate: 1, unlockSec: 0, repSec: 100, moneySec: 0, favorAfterInstall: 0,
        totalCost: 1, purchaseCost: 1, donationCost: 0, purpose: "augmentations",
      },
    }, "cadence");
    expect(cadenceHeld).toMatchObject({ state: "estimated", remainingSec: 960 });

    const trancheHeld = installForecast(0, {
      installNow: false,
      queuedCount: 0,
      phase: "start",
      workMeasured: true,
      moneyMeasured: true,
      finalSweepReady: false,
      cadenceSec: 0,
      countCadenceReady: false,
      intent: {
        faction: "CyberSec", repTarget: 100, augmentations: ["a"], value: 1, etaSec: 1, rate: 1,
        marginalRate: 1, unlockSec: 0, repSec: 0, moneySec: 0, favorAfterInstall: 0,
        totalCost: 1, purchaseCost: 1, donationCost: 0, purpose: "augmentations",
      },
    }, "count tranche");
    expect(trancheHeld).toMatchObject({
      state: "unknown",
      reason: "the funded augmentation set has not reached the route's reset tranche",
    });

    // With the route's own funding leg available, the tranche hold is an
    // honest lower bound, not an unknown that installHorizonSec would replace
    // with a one-hour amortization window.
    const trancheBounded = installForecast(0, {
      installNow: false,
      queuedCount: 0,
      phase: "start",
      workMeasured: true,
      moneyMeasured: true,
      finalSweepReady: false,
      cadenceSec: 500,
      countCadenceReady: false,
      routePackageSec: { sec: 7_200, measured: true },
      intent: {
        faction: "CyberSec", repTarget: 100, augmentations: ["a"], value: 1, etaSec: 1, rate: 1,
        marginalRate: 1, unlockSec: 0, repSec: 0, moneySec: 0, favorAfterInstall: 0,
        totalCost: 1, purchaseCost: 1, donationCost: 0, purpose: "augmentations",
      },
    }, "count tranche bounded");
    expect(trancheBounded).toMatchObject({ state: "estimated", remainingSec: 7_260 });

    // No committed package yet, but the route knows how long assembling one
    // takes: forecast that bound instead of reporting nothing.
    const packageBounded = installForecast(0, {
      installNow: false,
      queuedCount: 0,
      phase: "start",
      workMeasured: false,
      moneyMeasured: false,
      finalSweepReady: false,
      routePackageSec: { sec: 5_400, measured: false },
    }, "package bounded");
    expect(packageBounded).toMatchObject({ state: "estimated", remainingSec: 5_460 });

    const committed = installForecast(0, {
      installNow: false,
      installWanted: true,
      queuedCount: 0,
      phase: "finishUp",
      workMeasured: true,
      moneyMeasured: true,
      finalSweepReady: false,
      committedPackageSec: 293,
    }, "committed");
    expect(committed).toMatchObject({
      state: "estimated",
      remainingSec: 353,
      components: [
        { what: "finish committed augmentation package", measured: true },
        { what: "committed install blockers and final sweep", measured: false },
      ],
    });
  });

  test("an unsafe route stage exposes only its mandatory install horizon", () => {
    const held = installForecast(0, {
      installNow: false,
      queuedCount: 2,
      phase: "finishUp",
      workMeasured: true,
      moneyMeasured: true,
      finalSweepReady: false,
      optionalInstallAllowed: false,
      mandatory: { sec: 900, measured: true },
    }, "held");
    expect(held).toMatchObject({ state: "estimated", remainingSec: 960 });

    const noMandatory = installForecast(0, {
      installNow: false,
      queuedCount: 2,
      phase: "finishUp",
      workMeasured: true,
      moneyMeasured: true,
      finalSweepReady: false,
      optionalInstallAllowed: false,
    }, "held");
    expect(noMandatory.state).toBe("unknown");

    // A route stage that forbids optional installs and mandates none means
    // install-mortal state survives to node end: forecast the node bound so
    // installHorizonSec does not substitute a one-hour window.
    const nodeBounded = installForecast(0, {
      installNow: false,
      queuedCount: 2,
      phase: "finishUp",
      workMeasured: true,
      moneyMeasured: true,
      finalSweepReady: false,
      optionalInstallAllowed: false,
      nodeRemainingSec: 3_000,
    }, "held to node end");
    expect(nodeBounded).toMatchObject({ state: "estimated", remainingSec: 3_000 });
  });
});

describe("endgame view invariants the driver relies on", () => {
  test("BN1 daedalus rep gap prices the full 2.5m at the fallback when idle", () => {
    const v = view({ augCount: 30, hackingSkill: 2_500, money: DAEDALUS_MONEY });
    const daedalus = etasFor(v).find((eta) => eta.id === "daedalus")!;
    const rep = daedalus.parts.find((part) => part.what === "daedalus reputation")!;
    expect(rep.sec).toBeGreaterThan(0);
    expect(rep.measured).toBe(false);
    expect(rep.sec * 50).toBeCloseTo(RED_PILL_REP, 0);
  });

  test("the projected work rate replaces the fallback before Daedalus work is measured", () => {
    const v = view({ augCount: 30, hackingSkill: 2_500, money: DAEDALUS_MONEY });
    const daedalus = etasFor(v, { ...noRates(), daedalusRepPerSecProjected: 12.5 })
      .find((eta) => eta.id === "daedalus")!;
    const rep = daedalus.parts.find((part) => part.what === "daedalus reputation")!;
    expect(rep.measured).toBe(false);
    expect(rep.sec * 12.5).toBeCloseTo(RED_PILL_REP, 0);
  });

  test("the donation route is priced and wins when favor banking beats the grind", () => {
    const v = view({ augCount: 30, hackingSkill: 2_500, money: DAEDALUS_MONEY });
    // Work rate 12.5/s makes the direct grind 2.5e6/12.5 = 200,000s. The
    // donation path: 462,000-ish unlock rep at the same rate + one install
    // overhead + $2.5e12 of donation at $1e9/s = ~40,458s. It must win, and
    // the parts must say what they are.
    const daedalus = etasFor(v, {
      ...noRates(),
      moneyPerSec: 1e9,
      daedalusRepPerSecProjected: 12.5,
      daedalusDonateUnlockRepGap: 462_000,
      daedalusDonationDollarsPerRep: 1e6,
    }).find((eta) => eta.id === "daedalus")!;
    const unlock = daedalus.parts.find((part) => part.what === "daedalus favor unlock reputation")!;
    const install = daedalus.parts.find((part) => part.what === "daedalus favor-banking install")!;
    const donate = daedalus.parts.find((part) => part.what === "daedalus reputation donation")!;
    expect(daedalus.parts.find((part) => part.what === "daedalus reputation")).toBeUndefined();
    expect(unlock.sec).toBeCloseTo(462_000 / 12.5, 0);
    expect(install.sec).toBeGreaterThan(0);
    expect(donate.sec).toBeCloseTo((RED_PILL_REP * 1e6 - DAEDALUS_MONEY) / 1e9, 0);
  });

  test("unlocked donation skips the banking install and buys only the remaining gap", () => {
    const v = view({ augCount: 30, hackingSkill: 2_500, money: DAEDALUS_MONEY });
    const daedalus = etasFor(v, {
      ...noRates(),
      moneyPerSec: 1e9,
      daedalusRepPerSecProjected: 12.5,
      daedalusDonateUnlockRepGap: 0,
      daedalusDonationDollarsPerRep: 1e6,
      daedalusDonationUnlocked: true,
    }).find((eta) => eta.id === "daedalus")!;
    expect(daedalus.parts.find((part) => part.what === "daedalus favor-banking install")).toBeUndefined();
    const donate = daedalus.parts.find((part) => part.what === "daedalus reputation donation")!;
    expect(donate.sec).toBeCloseTo((RED_PILL_REP * 1e6 - DAEDALUS_MONEY) / 1e9, 0);
  });
});
/** The post-Red-Pill regrow guard is a SHORT-tail protection, and it inverts
 * when the remaining climb is longer than installing and re-climbing. The
 * inversion is a deliberately surprising decision, so it must carry a reason
 * the run record can show. */
describe("regrow install override", () => {
  const rates = (overrides: Partial<RouteRates> = {}): RouteRates => ({
    ...noRates(),
    hackingSkillPerSec: 0.01,
    postInstallHackingSkillMult: 10,
    ...overrides,
  });

  test("a long remaining climb inverts the guard and says why", () => {
    const override = regrowInstallOverride({
      stage: "world-daemon-regrow",
      optionalInstallAllowed: false,
      worldDaemonSkill: 3_000,
      hackingSkill: 10,
      rates: rates(),
    });
    expect(override).toBe(true);
  });

  test("a short tail leaves the guard standing", () => {
    expect(regrowInstallOverride({
      stage: "world-daemon-regrow",
      optionalInstallAllowed: false,
      worldDaemonSkill: 3_000,
      hackingSkill: 2_999,
      rates: rates(),
    })).toBe(false);
  });

  test("only a REFUSAL on the regrow stage can be overridden", () => {
    const inverted = {
      worldDaemonSkill: 3_000,
      hackingSkill: 10,
      rates: rates(),
    };
    // The guard already allows it — there is nothing to override.
    expect(regrowInstallOverride({
      ...inverted, stage: "world-daemon-regrow", optionalInstallAllowed: true,
    })).toBe(false);
    // A different stage carries a different guard, with its own reasons.
    expect(regrowInstallOverride({
      ...inverted, stage: "red-pill", optionalInstallAllowed: false,
    })).toBe(false);
    // Without a measured skill rate neither path can be priced.
    expect(regrowInstallOverride({
      ...inverted,
      stage: "world-daemon-regrow",
      optionalInstallAllowed: false,
      rates: rates({ hackingSkillPerSec: 0 }),
    })).toBe(false);
  });
});

describe("acquisition-aware skill climbs", () => {
  test("the invite gate prices buy-the-stack-then-climb when the direct climb is hopeless", () => {
    // Current mult 1, exp rate measured: 2500 directly needs e^((2500+200)/32)
    // ~ e^84 experience — effectively never. With a shelf of strong hacking
    // augs and a measured acquisition rate, the plan is to buy k and climb.
    const v = view({ augCount: 30, hackingSkill: 100, money: DAEDALUS_MONEY });
    const daedalus = etasFor(v, {
      ...noRates(),
      moneyPerSec: 1e9,
      hackingExp: 1_000,
      hackingExpPerSec: 1e6,
      hackingSkillMult: 1,
      augsPerSec: 1 / 600,
      hackingCatalog: {
        augs: Array.from({ length: 20 }, () => ({ skillLn: Math.log(1.5), expLn: Math.log(1.2) })),
      },
    }).find((eta) => eta.id === "daedalus")!;
    const stack = daedalus.parts.find((part) => part.what.includes("hacking skill multiplier stack"));
    const climb = daedalus.parts.find((part) => part.what.includes("invite gate (hacking skill)"));
    expect(stack).toBeDefined();
    expect(stack!.resource).toBe("augmentations");
    // The whole plan lands in hours, not centuries.
    const gateSec = daedalus.parts
      .filter((part) => part.what.includes("invite gate") && part.hidden !== true)
      .reduce((sum, part) => sum + part.sec, 0);
    expect(gateSec).toBeLessThan(48 * 3600);
    expect(climb ?? stack).toBeDefined();
  });
});

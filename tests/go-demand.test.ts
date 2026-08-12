import { describe, expect, test } from "bun:test";
import { goDemands } from "../shared/strategy/go/demand.ts";
import { goGamePaysForRam } from "../game/lib/features/remaining.ts";
import { estimatedForecast, unknownForecast } from "../shared/strategy/progression/forecast.ts";
import type { Need, NeedKind } from "../shared/strategy/needs.ts";

function need(kind: NeedKind, subject?: string): Need {
  return {
    by: "progression",
    kind,
    ...(subject ? { subject } : {}),
    target: 1,
    have: 0,
    weight: 10,
    urgency: "blocking",
    why: `${kind} bottleneck`,
  };
}

const unknownNode = unknownForecast(0, "node", "test");

describe("Go target demands", () => {
  test("a new game must repay the productive RAM it displaces", () => {
    // Four GB on a 400 GB fleet costs roughly 1% of throughput.
    expect(goGamePaysForRam(0.02, 400)).toBe(true);
    expect(goGamePaysForRam(0.00185, 400)).toBe(false);
    expect(goGamePaysForRam(0, 400)).toBe(false);
  });

  test("uses typed critical-path resources and ignores noncritical parallel work", () => {
    const install = estimatedForecast(0, "install", [
      { what: "renamed primary work", resource: "reputation", sec: 600, measured: true, mode: "parallel" },
      { what: "misleading reputation words", resource: "money", sec: 300, measured: true, mode: "parallel" },
      { what: "finish", resource: "install", sec: 60, measured: false, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      sinceInstall: { total: 100, hacking: 100, hacknet: 0 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands.Daedalus?.why).toContain("renamed primary work");
    expect(demands["The Black Hand"]?.why ?? "").not.toContain("misleading reputation words");
  });

  test("maps open bottlenecks to their actual opponent rewards", () => {
    const demands = goDemands({
      horizons: { install: unknownForecast(0, "install", "test"), node: unknownNode },
      sinceInstall: { total: 100, hacking: 0, hacknet: 100 },
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
      sinceInstall: { total: 100, hacking: 100, hacknet: 0 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands["The Black Hand"]?.seconds).toBeGreaterThan(0);
    expect(demands.Illuminati?.seconds).toBeGreaterThan(0);
  });

  test("maps an augmentation-package route component to its live producers", () => {
    const node = estimatedForecast(0, "node", [
      { what: "final augmentation package", resource: "augmentations", sec: 1_000, measured: false, mode: "sequential" },
      { what: "install count package", resource: "install", sec: 300, measured: false, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install: unknownForecast(0, "install", "test"), node },
      sinceInstall: { total: 100, hacking: 100, hacknet: 0 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: false,
    });
    expect(demands["The Black Hand"]?.seconds).toBe(1_000);
    expect(demands.Illuminati?.seconds).toBe(1_000);
    expect(demands.Daedalus?.seconds).toBe(500);
  });

  test("attributes a money bottleneck only to producers with known reward elasticity", () => {
    const install = estimatedForecast(0, "install", [
      { what: "cash gate", resource: "money", sec: 1_000, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      sinceInstall: { total: 100, hacking: 40, hacknet: 35 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands["The Black Hand"]?.seconds).toBe(400);
    expect(demands.Illuminati?.seconds).toBe(400);
    expect(demands.Netburners?.seconds).toBe(350);
    expect(demands["Slum Snakes"]).toBeUndefined();
  });

  test("faction reputation and individual combat gates activate their exact rewards", () => {
    const demands = goDemands({
      horizons: { install: unknownForecast(0, "install", "test"), node: unknownNode },
      sinceInstall: { total: 0, hacking: 0, hacknet: 0 },
      openNeeds: [need("factionRep", "Tian Di Hui"), need("skill", "strength")],
      canEarnFactionRep: true,
      canRunBladeburner: false,
    });
    expect(demands.Daedalus?.why).toContain("factionRep bottleneck");
    expect(demands.Tetrads?.why).toContain("skill bottleneck");
  });

  test("a qualitative need does not double-charge an already-priced forecast blocker", () => {
    const install = estimatedForecast(0, "install", [
      { what: "faction package", resource: "reputation", sec: 600, measured: true, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install, node: unknownNode },
      sinceInstall: { total: 0, hacking: 0, hacknet: 0 },
      openNeeds: [need("factionRep", "CyberSec")],
      canEarnFactionRep: true,
      canRunBladeburner: false,
    });
    expect(demands.Daedalus?.seconds).toBe(600);
    expect(demands.Daedalus?.why).toContain("factionRep bottleneck");
  });

  test("does not target a forecast resource with no active consumer", () => {
    const node = estimatedForecast(0, "node", [
      { what: "future faction grind", resource: "reputation", sec: 50_000, measured: false, mode: "sequential" },
      { what: "future black ops", resource: "combat", sec: 50_000, measured: false, mode: "sequential" },
    ]);
    const demands = goDemands({
      horizons: { install: unknownForecast(0, "install", "test"), node },
      sinceInstall: { total: 0, hacking: 0, hacknet: 0 },
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
      horizons: { install: unknownForecast(0, "install", "test"), node },
      sinceInstall: { total: 0, hacking: 0, hacknet: 0 },
      openNeeds: [],
      canEarnFactionRep: true,
      canRunBladeburner: true,
    });
    expect(demands.Illuminati?.why ?? "").not.toContain("post-install regrow");
    expect(demands["????????????"]).toBeUndefined();
  });
});

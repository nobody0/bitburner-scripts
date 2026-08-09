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
  LABYRINTH_WALK_SEC,
  ROUTE_DWELL_MS,
  chooseRoute,
  noRates,
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

  test("owning the pill collapses both Red Pill routes to the shared tail", () => {
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
    expect(daedalus.parts).toEqual([{ what: "regrow", sec: 2_900, measured: true }]);
  });

  test("the Daedalus invite gate is priced as the SLOWEST parallel track", () => {
    // Money is the only slow track here; augs and skill are done.
    const v = view({ augCount: 30, hackingSkill: 2_500, money: 0 });
    const daedalus = etasFor(v, { ...noRates(), moneyPerSec: 1e6 }).find((eta) => eta.id === "daedalus")!;
    const gate = daedalus.parts.find((part) => part.what.startsWith("invite gate"))!;
    expect(gate.what).toContain("money");
    expect(gate.sec).toBeCloseTo(DAEDALUS_MONEY / 1e6, 5);
  });

  test("black ops overlap with the rank climb — slower of the two, not the sum", () => {
    const v = view({ inBladeburner: true, blackOpsComplete: 10, bladeburnerRank: 399_999 });
    const blade = etasFor(v, { ...noRates(), bladeburnerRankPerSec: 1 }).find((eta) => eta.id === "bladeburner")!;
    // Rank is 1 second away; the 10 remaining ops at the fallback dominate.
    expect(blade.etaSec).toBe(10 * FALLBACK_SEC_PER_BLACK_OP);
  });

  test("the labyrinth walk is an explicit unmeasured guess", () => {
    const v = view({ sourceFiles: { "15": 1 } });
    const labyrinth = etasFor(v).find((eta) => eta.id === "labyrinth")!;
    expect(labyrinth.available).toBe(true);
    expect(labyrinth.parts[0]).toMatchObject({ what: "labyrinth walk", sec: LABYRINTH_WALK_SEC, measured: false });
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

  test("a complete route wins immediately, margin and dwell notwithstanding", () => {
    const previous: RouteChoice = { route: "daedalus", etaSec: 100, decidedAt: 0, why: "" };
    const done = [...etas(100, 5_000), { id: "bladeburner" as const, available: true, complete: true, etaSec: 0, parts: [] }];
    const { choice, switched } = chooseRoute(previous, done, 1);
    expect(choice?.route).toBe("bladeburner");
    expect(switched).toBe(true);
  });

  test("hysteresis: a marginally faster challenger does not flap the route", () => {
    const previous: RouteChoice = { route: "daedalus", etaSec: 1_000, decidedAt: 0, why: "" };
    // 10% faster is within the 25% margin — stay, even after the dwell.
    const { choice, switched } = chooseRoute(previous, etas(1_000, 900), ROUTE_DWELL_MS + 1);
    expect(switched).toBe(false);
    expect(choice?.route).toBe("daedalus");
    expect(choice?.decidedAt).toBe(0);
  });

  test("dwell: even a decisive challenger waits out the hold", () => {
    const previous: RouteChoice = { route: "daedalus", etaSec: 1_000, decidedAt: 0, why: "" };
    const early = chooseRoute(previous, etas(1_000, 100), ROUTE_DWELL_MS - 1);
    expect(early.switched).toBe(false);
    const late = chooseRoute(previous, etas(1_000, 100), ROUTE_DWELL_MS + 1);
    expect(late.switched).toBe(true);
    expect(late.choice?.route).toBe("labyrinth");
    expect(late.choice?.decidedAt).toBe(ROUTE_DWELL_MS + 1);
  });

  test("an incumbent that stops being available is replaced at once", () => {
    const previous: RouteChoice = { route: "labyrinth", etaSec: 100, decidedAt: 0, why: "" };
    const gone = etas(1_000, 100).map((eta) => (eta.id === "labyrinth" ? { ...eta, available: false } : eta));
    const { choice, switched } = chooseRoute(previous, gone, 1);
    expect(choice?.route).toBe("daedalus");
    expect(switched).toBe(true);
  });

  test("staying refreshes the estimate but keeps the decision time", () => {
    const previous: RouteChoice = { route: "daedalus", etaSec: 1_000, decidedAt: 42, why: "" };
    const { choice } = chooseRoute(previous, etas(800, 5_000), ROUTE_DWELL_MS * 2);
    expect(choice).toMatchObject({ route: "daedalus", etaSec: 800, decidedAt: 42 });
  });
});

describe("anchored uncapped forecasts", () => {
  test("a multi-day estimate stays uncapped and counts down", () => {
    const week = estimatedForecast(1_000, "week", [
      { what: "long route", sec: 7 * 86_400, measured: true, mode: "sequential" },
    ]);
    expect(week.remainingSec).toBe(7 * 86_400);
    expect(forecastAt(week, 3_601_000)).toMatchObject({ state: "stale", remainingSec: 7 * 86_400 - 3_600 });
  });

  test("re-estimates every ten minutes or when the structural basis changes", () => {
    const forecast = estimatedForecast(1_000, "same", [
      { what: "work", sec: 100, measured: true, mode: "sequential" },
    ]);
    expect(shouldReforecast(forecast, 1_000 + FORECAST_RECALIBRATION_MS - 1, "same")).toBe(false);
    expect(shouldReforecast(forecast, 1_000 + FORECAST_RECALIBRATION_MS, "same")).toBe(true);
    expect(shouldReforecast(forecast, 2_000, "changed")).toBe(true);
    const unknown = unknownForecast(1_000, "same", "waiting for a package");
    expect(shouldReforecast(unknown, 1_000 + FORECAST_RECALIBRATION_MS - 1, "same")).toBe(false);
    expect(shouldReforecast(unknown, 2_000, "changed")).toBe(true);
  });

  test("a complete route publishes NO node forecast", () => {
    // The act that ends the node is deliberately unwired (a human clicks), so
    // "done" can persist indefinitely. Publishing a 0-second estimate for it
    // would freeze every horizon-gated purchase in the meantime.
    const done = nodeForecast(0, { id: "daedalus", available: true, complete: true, etaSec: 0, parts: [] }, "basis");
    expect(done.state).toBe("unknown");
    expect(usableForecastSec(done)).toBeUndefined();
  });

  test("unknown and stale stay explicit", () => {
    expect(usableForecastSec(unknownForecast(0, "route", "no route"))).toBeUndefined();
    const forecast = estimatedForecast(0, "route", [
      { what: "work", sec: 100, measured: true, mode: "sequential" },
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
        totalCost: 1, purchaseCost: 1, donationCost: 0, purpose: "augmentations", why: "test",
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
});

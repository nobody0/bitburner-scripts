import { describe, expect, test } from "bun:test";
import {
  BLACK_OP_COUNT,
  DAEDALUS_MONEY,
  RED_PILL_REP,
  stepEndgame,
  type EndgameView,
} from "../shared/strategy/progression/endgame.ts";
import {
  DEFAULT_HORIZON_SEC,
  FALLBACK_SEC_PER_BLACK_OP,
  HORIZON_CEIL_SEC,
  HORIZON_FLOOR_SEC,
  INSTALL_CADENCE_SEC,
  LABYRINTH_WALK_SEC,
  PLAN_STALE_MS,
  ROUTE_DWELL_MS,
  chooseRoute,
  expectedEndFrom,
  horizonSecFrom,
  noRates,
  planningHorizonSec,
  routeEtas,
  type RouteChoice,
  type RouteRates,
} from "../shared/strategy/progression/eta.ts";
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

describe("horizon", () => {
  test("no decision falls back to the pre-existing constant", () => {
    expect(horizonSecFrom(undefined, 1_000)).toBe(DEFAULT_HORIZON_SEC);
  });

  test("derives remaining seconds from the expected end, clamped both ways", () => {
    expect(horizonSecFrom(601_000, 1_000)).toBe(600);
    // A run past its expected end still plans a floor, never zero or negative.
    expect(horizonSecFrom(0, 1_000)).toBe(HORIZON_FLOOR_SEC);
    // A week-long guess adds nothing over a day.
    expect(horizonSecFrom(7 * 86_400_000, 0)).toBe(HORIZON_CEIL_SEC);
  });

  test("the planning horizon is capped by the install cadence", () => {
    // THE 24x BUG THIS PINS: a fallback-guessed multi-day node ETA must not
    // widen hacknet/stock payback windows to the 24h ceiling — an install
    // destroys what those features buy, and installs come much sooner than
    // the node's end. Short expected ends still pass through un-capped.
    expect(planningHorizonSec(7 * 86_400_000, 0)).toBe(INSTALL_CADENCE_SEC);
    expect(planningHorizonSec(601_000, 1_000)).toBe(600);
    expect(planningHorizonSec(undefined, 1_000)).toBe(Math.min(DEFAULT_HORIZON_SEC, INSTALL_CADENCE_SEC));
  });

  test("a stale plan stops steering: quiet publisher falls back to the default", () => {
    const now = 10_000_000;
    // Fresh enough: the expected end is honoured.
    expect(planningHorizonSec(now + 600_000, now, now - 60_000)).toBe(600);
    // Refresh went quiet: the aging expectedEndAt would otherwise decay the
    // horizon to the floor over hours; treat the plan as absent instead.
    expect(planningHorizonSec(now + 600_000, now, now - PLAN_STALE_MS - 1)).toBe(DEFAULT_HORIZON_SEC);
    // No freshness marker at all (old records) behaves as fresh.
    expect(planningHorizonSec(now + 600_000, now)).toBe(600);
  });
});

describe("expected end publication", () => {
  const etaOf = (complete: boolean) => [
    { id: "daedalus" as const, available: true, complete, etaSec: 0, parts: [] },
  ];

  test("a complete route publishes NO expected end", () => {
    // THE STALL THIS PINS: etaSec 0 -> expectedEndAt = now would floor every
    // feature's horizon at 60s for the rest of the run — and the act half
    // that would actually end the node is deliberately unwired, so that
    // state persists until a human clicks. Absent reads as the default.
    const choice: RouteChoice = { route: "daedalus", etaSec: 0, decidedAt: 0, why: "" };
    expect(expectedEndFrom(choice, etaOf(true), 5_000)).toBeUndefined();
    expect(planningHorizonSec(expectedEndFrom(choice, etaOf(true), 5_000), 5_000)).toBe(DEFAULT_HORIZON_SEC);
  });

  test("an incomplete route publishes decision time plus the estimate", () => {
    const choice: RouteChoice = { route: "daedalus", etaSec: 120, decidedAt: 0, why: "" };
    expect(expectedEndFrom(choice, etaOf(false), 5_000)).toBe(125_000);
    expect(expectedEndFrom(undefined, etaOf(false), 5_000)).toBeUndefined();
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

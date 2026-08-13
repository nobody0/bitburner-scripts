import { describe, expect, test } from "bun:test";
import {
  GO_DISPATCH_GUARD_MS,
  goChooseSeedTarget,
  goDispatchDelayMs,
  goNextRolloverAt,
  goPhaseAgrees,
  goPredictedPlaytime,
  type GoTickPhase,
} from "../shared/strategy/go/tick.ts";
import {
  alignedAiSeed,
  GO_ENGINE_CYCLE_MS,
  GO_WHRNG_PERIOD_MS,
  normalizeGoPlaytime,
} from "../shared/strategy/go/rng.ts";
import { goSeedSetKey } from "../shared/strategy/go/neural/worker-protocol.ts";

describe("go engine-tick alignment", () => {
  // Anchor: tick 10,000 was observed to begin at wall clock 1,000.
  const phase: GoTickPhase = { wallAt: 1_000, playtime: 10_000 };

  test("the rollover is one cycle after the anchor, then every cycle", () => {
    expect(goNextRolloverAt(phase, 1_000)).toBe(1_200);
    expect(goNextRolloverAt(phase, 1_050)).toBe(1_200);
    expect(goNextRolloverAt(phase, 1_199)).toBe(1_200);
    expect(goNextRolloverAt(phase, 1_200)).toBe(1_400);
    expect(goNextRolloverAt(phase, 5_437)).toBe(5_600);
  });

  test("the anchor predicts the tick value, which is how drift is detected", () => {
    expect(goPredictedPlaytime(phase, 1_000)).toBe(10_000);
    expect(goPredictedPlaytime(phase, 1_199)).toBe(10_000);
    expect(goPredictedPlaytime(phase, 1_200)).toBe(10_200);
    expect(goPredictedPlaytime(phase, 2_600)).toBe(11_600);
    expect(goPhaseAgrees(phase, 10_200, 1_250)).toBe(true);
    // A throttled browser advances totalPlaytime more slowly than wall time.
    expect(goPhaseAgrees(phase, 10_000, 1_250)).toBe(false);
  });

  test("worker clock confirmations and cache keys wrap at the WHRNG period", () => {
    expect(normalizeGoPlaytime(GO_WHRNG_PERIOD_MS + 400)).toBe(400);
    expect(normalizeGoPlaytime(-200)).toBe(GO_WHRNG_PERIOD_MS - 200);
    expect(goSeedSetKey([400, 600])).toBe(goSeedSetKey([
      GO_WHRNG_PERIOD_MS + 400,
      GO_WHRNG_PERIOD_MS + 600,
    ]));
  });

  test("a comfortable margin dispatches in the current cycle without waiting", () => {
    const target = goChooseSeedTarget(phase, 10_000, 1_050);
    expect(target.waitsForRollover).toBe(false);
    expect(target.targetPlaytime).toBe(10_000);
    expect(target.marginMs).toBe(150);
    expect(goDispatchDelayMs(target, 1_060)).toBe(0);
    // The forecast seed follows from the tick we will dispatch in.
    expect(alignedAiSeed(target.targetPlaytime, 0)).toBe(10_200);
  });

  test("inside the guard band it targets the next cycle and waits past the rollover", () => {
    const nowWall = 1_199; // One millisecond remains.
    const target = goChooseSeedTarget(phase, 10_000, nowWall);
    expect(target.waitsForRollover).toBe(true);
    // Only the synchronous read-to-call boundary is guarded.
    expect(target.targetPlaytime).toBe(10_200);
    expect(target.marginMs).toBe(GO_ENGINE_CYCLE_MS);
    expect(alignedAiSeed(target.targetPlaytime, 0)).toBe(10_400);
    // Computing the move consumes part of the wait; the remainder is slept,
    // plus one millisecond so the rollover has certainly been applied.
    expect(goDispatchDelayMs(target, nowWall)).toBe(2);
    expect(goDispatchDelayMs(target, nowWall + 10)).toBe(0);
    // Even if computation overran the rollover, the delay never goes negative.
    expect(goDispatchDelayMs(target, 1_260)).toBe(0);
  });

  test("the guard band boundary belongs to the current cycle", () => {
    const exactlyAtGuard = 1_200 - GO_DISPATCH_GUARD_MS;
    expect(goChooseSeedTarget(phase, 10_000, exactlyAtGuard).waitsForRollover).toBe(false);
    expect(goChooseSeedTarget(phase, 10_000, exactlyAtGuard + 1).waitsForRollover).toBe(true);
  });

  test("every wall-clock offset yields a dispatch with at least the guard margin", () => {
    // Exhaustive over one cycle: no phase may produce a dispatch that lands
    // with less headroom than the guard band, which is the invariant that
    // keeps the predicted reply seed correct.
    for (let offset = 0; offset < GO_ENGINE_CYCLE_MS; offset++) {
      const nowWall = 1_000 + offset;
      const target = goChooseSeedTarget(phase, goPredictedPlaytime(phase, nowWall), nowWall);
      expect(target.marginMs).toBeGreaterThanOrEqual(GO_DISPATCH_GUARD_MS);
      const dispatchAt = nowWall + goDispatchDelayMs(target, nowWall);
      // The tick in force at dispatch must be the tick we forecast for.
      expect(goPredictedPlaytime(phase, dispatchAt)).toBe(target.targetPlaytime);
    }
  });
});

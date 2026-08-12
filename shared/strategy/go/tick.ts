/** Engine-tick phase tracking for WHRNG seed alignment.
 *
 * `Player.totalPlaytime` advances in 200 ms engine cycles, and the faction AI
 * seeds its WHRNG from the value observed after its first waitCycle. The seed
 * our forecast assumes is therefore fixed by the tick we dispatch in, so a
 * rollover between reading the clock and calling `go.makeMove` silently
 * invalidates the prediction.
 *
 * Reading `totalPlaytime` alone cannot tell us where we are inside a cycle:
 * the value is a step function. Observing one transition anchors the phase,
 * after which the wall clock extrapolates it. Everything here is pure so the
 * policy is unit-tested rather than inferred from live behaviour.
 */
import { GO_ENGINE_CYCLE_MS } from "./rng.ts";

export interface GoTickPhase {
  /** Wall clock (Date.now) at which `playtime` was first observed. */
  wallAt: number;
  /** The engine tick value observed at `wallAt`. */
  playtime: number;
}

/** Default guard band. Dispatching this close to a rollover risks landing in
 * the next cycle, so the engine deliberately targets that next cycle instead
 * and waits for it. */
export const GO_ROLLOVER_GUARD_MS = 20;

/** Wall clock of the next rollover after `nowWall`, given an anchor. */
export function goNextRolloverAt(phase: GoTickPhase, nowWall: number): number {
  const elapsed = nowWall - phase.wallAt;
  const sinceRollover = ((elapsed % GO_ENGINE_CYCLE_MS) + GO_ENGINE_CYCLE_MS) % GO_ENGINE_CYCLE_MS;
  return nowWall + (GO_ENGINE_CYCLE_MS - sinceRollover);
}

/** The tick value the anchor implies for `nowWall`. Comparing this against a
 * fresh `getPlayer()` read is how a stale or drifted anchor is detected. */
export function goPredictedPlaytime(phase: GoTickPhase, nowWall: number): number {
  const elapsed = Math.max(0, nowWall - phase.wallAt);
  return phase.playtime + Math.floor(elapsed / GO_ENGINE_CYCLE_MS) * GO_ENGINE_CYCLE_MS;
}

/** True when the anchor still explains an observed tick. A browser that
 * throttles timers advances totalPlaytime more slowly than the wall clock, so
 * this is checked on every turn rather than assumed. */
export function goPhaseAgrees(phase: GoTickPhase, observedPlaytime: number, nowWall: number): boolean {
  return goPredictedPlaytime(phase, nowWall) === observedPlaytime;
}

export interface GoSeedTarget {
  /** Tick to dispatch in; the reply forecast is derived from this. */
  targetPlaytime: number;
  /** Wall clock of the rollover into the targeted cycle. Dispatch waits for
   * this when `waitsForRollover` is set. */
  rolloverAt: number;
  /** True when the current cycle was too close to its end to use safely. */
  waitsForRollover: boolean;
  /** Milliseconds of headroom the dispatch is expected to have once it is in
   * the targeted cycle. */
  marginMs: number;
}

/** Pick the cycle to dispatch in.
 *
 * Within the guard band the current cycle is abandoned in favour of the next
 * one: waiting a few milliseconds buys a full cycle of margin, whereas racing
 * the rollover risks a wrong seed and a wasted turn. */
export function goChooseSeedTarget(
  phase: GoTickPhase,
  observedPlaytime: number,
  nowWall: number,
  guardMs = GO_ROLLOVER_GUARD_MS,
): GoSeedTarget {
  const rolloverAt = goNextRolloverAt(phase, nowWall);
  const remaining = rolloverAt - nowWall;
  if (remaining < guardMs) {
    return {
      targetPlaytime: observedPlaytime + GO_ENGINE_CYCLE_MS,
      rolloverAt,
      waitsForRollover: true,
      marginMs: GO_ENGINE_CYCLE_MS,
    };
  }
  return { targetPlaytime: observedPlaytime, rolloverAt, waitsForRollover: false, marginMs: remaining };
}

/** Milliseconds to sleep before dispatching, once the move is computed. The
 * extra millisecond covers the case where the rollover has not been applied
 * yet at the instant the timer fires. */
export function goDispatchDelayMs(target: GoSeedTarget, nowWall: number): number {
  if (!target.waitsForRollover) return 0;
  return Math.max(0, target.rolloverAt - nowWall) + 1;
}

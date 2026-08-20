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

/** Only the synchronous verified-read to Go-call gap needs protection. Neural
 * work is already pushed ahead by the worker and is never budgeted into this
 * guard. */
export const GO_DISPATCH_GUARD_MS = 2;

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
  guardMs = GO_DISPATCH_GUARD_MS,
  notBeforePlaytime?: number,
): GoSeedTarget {
  const rolloverAt = goNextRolloverAt(phase, nowWall);
  const remaining = rolloverAt - nowWall;
  if (notBeforePlaytime !== undefined && notBeforePlaytime > observedPlaytime) {
    // A committed playbook entry is bound to one exact engine tick. Waiting
    // whole cycles for it reuses the ordinary rollover-wait dispatch path;
    // the caller keeps such waits short by only dispatching near the target.
    const cycles = Math.ceil((notBeforePlaytime - observedPlaytime) / GO_ENGINE_CYCLE_MS);
    return {
      targetPlaytime: observedPlaytime + cycles * GO_ENGINE_CYCLE_MS,
      rolloverAt: rolloverAt + (cycles - 1) * GO_ENGINE_CYCLE_MS,
      waitsForRollover: true,
      marginMs: GO_ENGINE_CYCLE_MS,
    };
  }
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
  return Math.max(0, target.rolloverAt + 1 - nowWall);
}

/** How the wall time between "Black owns the turn" and the irreversible Go
 * call was spent. The named segments are disjoint and ordered; `residualMs`
 * carries whatever they do not cover rather than being folded into a
 * neighbour, so the seven always sum to `totalMs`. */
export interface GoDispatchBreakdown {
  totalMs: number;
  /** Opponent promise resolved until planning started: controller wake, turn
   * claim admission, and the probe/hydrate work ahead of the plan. */
  admitMs: number;
  /** Provisional planning on the page: worker install, evaluate, playbook. */
  prepareMs: number;
  /** RAM broker admission and dodge stub launch. */
  leaseMs: number;
  /** Seed-exact evaluation inside the stub, summed across boundary retries. */
  finalizeMs: number;
  /** Deliberate sleep waiting for the target engine tick. Intended latency. */
  alignMs: number;
  /** Verified public read until the Go call. Should be near zero. */
  dispatchMs: number;
  residualMs: number;
}

export interface GoDispatchLatencyInput {
  /** Wall time the previous opponent promise resolved, or the cold-start
   * boundary where a complete actionable Black position first appeared. */
  turnReadyAt: number;
  planStartedAt: number;
  /** End of provisional planning on the page. */
  preparedAt: number;
  /** Wall time the RAM-leased action was requested. */
  actionStartedAt: number;
  /** Wall time the dodge stub body began running. */
  stubEnteredAt: number;
  /** Seed-exact evaluation cost inside the stub, summed over retries. */
  finalizeMs: number;
  /** Deliberate sleep waiting for the target tick, summed over retries. */
  alignMs: number;
  /** The verified public read that authorised the dispatch. */
  verifiedAt: number;
  dispatchedAt: number;
}

/** Split the wall time between "Black owns the turn" and the irreversible Go
 * call into disjoint, ordered segments.
 *
 * The point of the split is that one of these segments — `alignMs` — is time
 * we chose to spend to land on the intended engine tick. Reading the total
 * alone cannot distinguish that from a worker that took too long, which is the
 * failure the breakdown exists to expose. */
export function goDispatchLatency(input: GoDispatchLatencyInput): GoDispatchBreakdown {
  const totalMs = Math.max(0, input.dispatchedAt - input.turnReadyAt);
  const span = (from: number, to: number) => Math.min(totalMs, Math.max(0, to - from));
  const admitMs = span(input.turnReadyAt, input.planStartedAt);
  const prepareMs = span(input.planStartedAt, input.preparedAt);
  const leaseMs = span(input.actionStartedAt, input.stubEnteredAt);
  const finalizeMs = Math.min(totalMs, Math.max(0, input.finalizeMs));
  const alignMs = Math.min(totalMs, Math.max(0, input.alignMs));
  const dispatchMs = span(input.verifiedAt, input.dispatchedAt);
  const named = admitMs + prepareMs + leaseMs + finalizeMs + alignMs + dispatchMs;
  return {
    totalMs,
    admitMs,
    prepareMs,
    leaseMs,
    finalizeMs,
    alignMs,
    dispatchMs,
    residualMs: Math.max(0, totalMs - named),
  };
}

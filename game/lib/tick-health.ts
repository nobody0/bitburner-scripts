/** Engine-tick lateness: the controller's own timer, measured against its
 * absolute deadline.
 *
 * The game engine, `netscriptDelay`, and this controller all share one thread
 * and one timer queue, so a pass that overruns its slot does not merely delay
 * itself — it delays `Engine.start`'s next cycle and every in-flight operation's
 * completion timer with it.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/engine.tsx#L415-L441
 *
 * A live run measured 107 s of mean landing error while `pumpMaxMs` — the only
 * cost signal we had — was reporting a healthy-looking 92 ms peak: peak pass
 * cost cannot distinguish "one expensive pass" from "the thread is gone". This
 * measures the consequence directly, and it is free: the controller already
 * computes the quantity at its sleep boundary and throws it away.
 *
 * Deliberately not `landingError`: that is a lagging indicator (a late landing
 * only appears one weaken-time after the cause) and it is confounded with real
 * scheduling jitter. It stays the slow confirmation metric it already is. */

/** ~10 tick time constant: long enough that a single slow pass does not swing
 * the reading, short enough to react inside a few seconds. */
const LATENESS_ALPHA = 0.1;

let latenessEma = 0;
let latenessMax = 0;
let seeded = false;
let sampledSinceDrain = 0;

/** Record one observed tick lateness in ms. Negative means early, which the
 * timer cannot really be; it is clamped rather than allowed to pull the mean
 * below zero. */
export function noteTickLateness(ms: number): void {
  const late = ms > 0 ? ms : 0;
  // Seed on the first sample. An EMA started at zero would spend its whole
  // time constant claiming the thread is healthy, which is the window a stall
  // happens in.
  latenessEma = seeded ? latenessEma + LATENESS_ALPHA * (late - latenessEma) : late;
  seeded = true;
  if (late > latenessMax) latenessMax = late;
  sampledSinceDrain++;
}

/** Publication drain: the mean is the smoothed reading, which survives the
 * drain because it describes a trend rather than a window; the max is per
 * window. */
export function takeTickLateness(): { meanMs: number; maxMs: number } | undefined {
  if (sampledSinceDrain === 0) return undefined;
  const value = { meanMs: latenessEma, maxMs: latenessMax };
  latenessMax = 0;
  sampledSinceDrain = 0;
  return value;
}

export function resetTickHealth(): void {
  latenessEma = 0;
  latenessMax = 0;
  seeded = false;
  sampledSinceDrain = 0;
}

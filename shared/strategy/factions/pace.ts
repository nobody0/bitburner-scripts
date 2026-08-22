import type { CurveResource } from "../progression/regrowth.ts";
import type { WorkType } from "./rep.ts";

/** Converting a gap to seconds when the rate is ACCELERATING.
 *
 * Every faction ETA used to divide a gap by a spot rate: `repGap / repPerSec`,
 * `shortfall / incomePerSec`. That is right for one short package and wrong for
 * a multi-package budget, because rates in Bitburner do not hold still within a
 * cycle — skills, rooted hosts, RAM and income unlock one another, so the second
 * hour of a cycle is not priced like the first. A spot-rate divide makes a
 * far-off faction look permanently unreachable when it would in fact be cheap by
 * the time we got there, which is exactly the judgement a joint portfolio has to
 * make.
 *
 * `progression/regrowth.ts` already fits cumulative cycle progress to `y = a·t^p`
 * with a bounded exponent and anchors sparse fresh-cycle samples to the previous
 * cycle's shape. This module reuses that FIT and applies it as a correction to a
 * measured spot rate, rather than calling `cycleProgressEta` to invert the curve
 * outright. Two reasons:
 *
 *  - The level is better measured elsewhere. `FactionMemory.measuredRepPerSec` is
 *    a per-faction EWMA of observed reputation deltas, and its docstring is
 *    explicit that reality beats the formula. The curve supplies the SHAPE; the
 *    EWMA supplies the level. Inverting the cumulative curve would throw the
 *    better level away.
 *  - Reputation has no cumulative curve to invert. `CyclePoint` tracks money,
 *    hacking and combat only; reputation is earned against the skill that drives
 *    the chosen work type, so the shape has to be borrowed from that skill.
 *
 * The correction may only ever SHORTEN an estimate — the same rule
 * `cycleProgressEta` enforces with its `fallbackSec` ceiling, and for the same
 * measured reason: the acceleration this exists to capture cannot lengthen a
 * wait, so when the arithmetic says it does, it is reading noise. */

/** How fast the run is accelerating, as a DIGEST rather than a curve.
 *
 * The samples themselves — up to 240 `CyclePoint`s — live in progression's
 * memory and stay there. Everything this module does needs only the fitted
 * exponent per resource, so that is what crosses the feature boundary and the
 * telemetry wire: four numbers instead of a table. Absent means "no signal yet"
 * and every conversion here degrades to the spot-rate answer. */
export interface CyclePace {
  /** Elapsed seconds since the current augmentation prestige. */
  elapsedSec: number;
  /** Fitted exponent of cumulative progress per resource, from
   * `cycleProgressExponent`. 1 is a stationary rate; above 1 accelerates. */
  exponent: Partial<Record<CurveResource, number>>;
}

/** Which cumulative curve drives reputation for a work type.
 *
 * Faction reputation per second is a function of the skills the work type reads
 * (`FACTION_WORK_EXP`, `rep.ts:165`): hacking contracts scale with hacking
 * skill, security and field work with the four combat stats. Field work also
 * reads charisma, which has NO curve — see the note in
 * `spec/strategy/features/factions.md`. */
export function repCurveResource(workType: WorkType): CurveResource {
  return workType === "hacking" ? "hacking" : "combat";
}

/** Fitted exponent for a resource, or 1 (a stationary rate) with no signal. */
export function curveExponent(pace: CyclePace | undefined, resource: CurveResource): number {
  const exponent = pace?.exponent[resource];
  return exponent !== undefined && Number.isFinite(exponent) && exponent > 0 ? exponent : 1;
}

/** Seconds to close a gap that a spot rate would close in `spotSec`, given a
 * cumulative curve `y = a·t^p` observed to elapsed time `e`.
 *
 * The instantaneous rate is `y'(t) = a·p·t^(p-1)`, so the progress made between
 * `e` and `e + T` is `a·((e+T)^p − e^p)`, while the spot rate would have made
 * `a·p·e^(p-1)·spotSec` in the same nominal budget. Equating the two inverts in
 * closed form:
 *
 *     T = ( e^p + spotSec·p·e^(p-1) )^(1/p) − e
 *
 * which is `spotSec` exactly at `p = 1`, and strictly less above it. No search,
 * no iteration: this runs once per (faction, reputation breakpoint) on a
 * frontier that is rebuilt hundreds of times a tick. */
export function pacedSec(spotSec: number, elapsedSec: number, exponent: number): number {
  if (!(spotSec > 0)) return 0;
  if (!Number.isFinite(spotSec)) return spotSec;
  const e = elapsedSec;
  const p = exponent;
  if (!(e > 0) || !Number.isFinite(e) || !(p > 0) || !Number.isFinite(p) || p === 1) return spotSec;
  const paced = Math.pow(Math.pow(e, p) + spotSec * p * Math.pow(e, p - 1), 1 / p) - e;
  if (!Number.isFinite(paced) || paced <= 0) return spotSec;
  // May only shorten. A decelerating fit (p < 1) is the estimator reading a
  // stalled window as the future regime; the spot rate is the honest answer
  // there, and `cycleProgressEta` bounds its own extrapolation the same way.
  return Math.min(spotSec, paced);
}

/** `pacedSec` against a pace digest, for a named resource. */
export function pacedSecFor(
  spotSec: number,
  pace: CyclePace | undefined,
  resource: CurveResource,
): number {
  if (!pace) return spotSec;
  return pacedSec(spotSec, pace.elapsedSec, curveExponent(pace, resource));
}

/** Inverse of {@link pacedSec}: recover the spot-rate estimate a paced figure
 * came from.
 *
 * A frontier package is paced once, at the cycle position the frontier was
 * built at. A PORTFOLIO then puts several packages in sequence, and the second
 * one is not worked at that position — it is worked after the first has
 * finished, by which time the rate has moved again. Re-pacing it needs the
 * underlying spot estimate back, and the closed form inverts exactly:
 *
 *     spotSec = ( (e+T)^p − e^p ) / ( p·e^(p-1) )
 *
 * Identity wherever {@link pacedSec} is the identity, so a package built with
 * no curve signal round-trips unchanged. */
export function spotSecFromPaced(paced: number, elapsedSec: number, exponent: number): number {
  if (!(paced > 0)) return 0;
  if (!Number.isFinite(paced)) return paced;
  const e = elapsedSec;
  const p = exponent;
  if (!(e > 0) || !Number.isFinite(e) || !(p > 0) || !Number.isFinite(p) || p === 1) return paced;
  const spot = (Math.pow(e + paced, p) - Math.pow(e, p)) / (p * Math.pow(e, p - 1));
  // `pacedSec` clamps a decelerating fit back to the spot answer, and that
  // clamp is not invertible. Never report a spot estimate SHORTER than the
  // paced one it came from: that would be the correction lengthening a wait,
  // which is the thing it is not allowed to do.
  return Number.isFinite(spot) && spot > paced ? spot : paced;
}

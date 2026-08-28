/** Compact observations of one augmentation-install cycle. Cumulative
 * progress is intentional: rates in Bitburner accelerate as skills, rooted
 * hosts, RAM and income unlock one another, so a last-window derivative is
 * not a model of a fresh prestige. */
export interface CyclePoint {
  sec: number;
  money: number;
  hacking: number;
  combat: number;
}

/** One completed augmentation-prestige cycle. Unlike a sliding aug-count
 * derivative, this remains informative after the install step has aged out
 * of a sampling window. */
export interface AugmentationCycle {
  sec: number;
  augmentations: number;
}

/** A faster observed "cycle" is a startup/resume artifact: the controller
 * inherited queued augmentations or completed reputation work and merely
 * pressed install. It did not observe the acquisition work from prestige, so
 * using it to forecast a fresh cycle is invalid. */
export const MIN_AUGMENTATION_CYCLE_SAMPLE_SEC = 60;

export type CurveResource = "money" | "hacking" | "combat";

export interface CurveEstimate {
  sec: number;
  measured: boolean;
  exponent?: number;
}

/** Bounded retention used by the game driver: keep the cold two-hour shape
 * and the latest two-hour regime. A sliding window is invalid for prestige
 * forecasts because its zero no longer means a fresh install. */
export function retainCycleCurve(points: CyclePoint[], maxPoints = 240, coldPoints = 120): void {
  const max = Math.max(2, Math.floor(maxPoints));
  const cold = Math.max(1, Math.min(max - 1, Math.floor(coldPoints)));
  while (points.length > max) points.splice(cold, 1);
}

/** Recent completed cycles, exponentially weighted toward the latest regime.
 * A cycle with no new unique augmentation is not acquisition evidence. */
export function augmentationAcquisitionRate(cycles: readonly AugmentationCycle[]): number {
  let weightedAugs = 0;
  let weightedSec = 0;
  let weight = 1;
  for (let index = cycles.length - 1; index >= 0; index--) {
    const cycle = cycles[index]!;
    if (cycle.sec >= MIN_AUGMENTATION_CYCLE_SAMPLE_SEC && cycle.augmentations > 0) {
      weightedAugs += cycle.augmentations * weight;
      weightedSec += cycle.sec * weight;
      weight *= 0.5;
    }
  }
  return weightedSec > 0 ? weightedAugs / weightedSec : 0;
}

function progress(point: CyclePoint, resource: CurveResource): number {
  return resource === "money"
    ? Math.max(0, point.money)
    : Math.max(0, point[resource] - 1);
}

function usableProgress(
  points: readonly CyclePoint[],
  resource: CurveResource,
): { t: number; y: number }[] {
  return points
    .map((point) => ({ t: Math.max(0, point.sec), y: progress(point, resource) }))
    .filter((point) => point.t > 0 && point.y > 0)
    .sort((a, b) => a.t - b.t);
}

function observedProgressAt(
  points: readonly CyclePoint[],
  resource: CurveResource,
  sec: number,
): number | undefined {
  const usable = usableProgress(points, resource);
  if (usable.length === 0 || sec <= 0) return undefined;
  let before = { t: 0, y: 0 };
  for (const point of usable) {
    if (point.t >= sec) {
      const share = (sec - before.t) / Math.max(1e-9, point.t - before.t);
      return before.y + (point.y - before.y) * Math.max(0, Math.min(1, share));
    }
    before = point;
  }
  return before.y;
}

/** Power exponent of the recent cumulative-progress curve. A linear stream is
 * 1; an accelerating bootstrap is >1. Kept on the same bounded fit used by
 * cycleProgressEta so prediction and reset cadence cannot disagree about the
 * observed shape. */
export function cycleProgressExponent(
  points: readonly CyclePoint[],
  resource: CurveResource,
): number | undefined {
  const usable = usableProgress(points, resource);
  if (usable.length < 2) return undefined;
  const last = usable.at(-1)!;
  const first = usable.find((point) => point.t >= last.t * 0.25 && point.y < last.y) ?? usable[0]!;
  const raw = first.t < last.t && first.y < last.y
    ? Math.log(last.y / first.y) / Math.log(last.t / first.t)
    : 1;
  return Math.max(0.5, Math.min(4, Number.isFinite(raw) ? raw : 1));
}

/** Fit y = a*t^p to the informative span and invert it. The exponent is
 * bounded: this is a planning heuristic, and one lucky crime payout must not
 * imply an infinite future money engine. Known crossings interpolate rather
 * than extrapolate. */
export function cycleProgressEta(
  points: readonly CyclePoint[],
  resource: CurveResource,
  target: number,
  fallbackSec: number,
  outputScale = 1,
): CurveEstimate {
  const wanted = Math.max(0, target) / Math.max(1e-9, outputScale);
  if (wanted <= 0) return { sec: 0, measured: true };
  const usable = usableProgress(points, resource);
  if (usable.length < 2) return { sec: Math.max(0, fallbackSec), measured: false };

  let before = { t: 0, y: 0 };
  for (const point of usable) {
    if (point.y >= wanted) {
      const share = (wanted - before.y) / Math.max(1e-9, point.y - before.y);
      return { sec: before.t + (point.t - before.t) * Math.max(0, Math.min(1, share)), measured: true };
    }
    before = point;
  }

  const last = usable.at(-1)!;
  const exponent = cycleProgressExponent(points, resource) ?? 1;
  const totalSec = last.t * Math.pow(wanted / last.y, 1 / exponent);
  // EXTRAPOLATION MAY NOT BE WORSE THAN THE RECENT RATE. `fallbackSec` is the
  // caller's linear estimate at the rate measured over its recent window; this
  // fit is cumulative since cycle start, so far outside the observed span it can
  // read the slow bootstrap as the future regime and compound it. Cap that
  // extrapolation at the recent linear rate so it cannot distort downstream
  // marginals and starve other route work. The
  // acceleration this fit exists to capture can only SHORTEN an estimate; when
  // it lengthens one it is extrapolating noise.
  const bounded = fallbackSec > 0 ? Math.min(totalSec, fallbackSec) : totalSec;
  return { sec: Math.max(last.t, bounded), measured: true, exponent };
}

/** Estimate a fresh cycle with the preceding completed cycle as a shape prior.
 *
 * Two observations just after prestige are enough to fit a power curve, but
 * nowhere near enough to extrapolate a $10k bootstrap to $100b. A
 * completed cycle gives us the missing cold-start shape. We scale that shape
 * by progress observed at the same elapsed time (so SF12 and newly installed
 * augmentations move the prediction), then phase toward the current fit as it
 * covers a material share of the target.
 *
 * The 4x guard is epistemic, not a claim about game mechanics: before 25% of
 * the target is observed, one sparse fit may revise a measured prior by at
 * most fourfold. Once the target is crossed, interpolation is exact and the
 * guard disappears. */
export function cycleProgressEtaWithPrior(
  current: readonly CyclePoint[],
  prior: readonly CyclePoint[] | undefined,
  resource: CurveResource,
  target: number,
  fallbackSec: number,
): CurveEstimate {
  const currentEstimate = cycleProgressEta(current, resource, target, fallbackSec);
  if (!prior || prior.length < 2) return currentEstimate;

  const currentUsable = usableProgress(current, resource);
  const last = currentUsable.at(-1);
  const currentProgress = last?.y ?? 0;
  if (currentProgress >= Math.max(0, target)) return currentEstimate;

  const priorAtSameTime = last ? observedProgressAt(prior, resource, last.t) : undefined;
  const observedScale = priorAtSameTime && priorAtSameTime > 0
    ? currentProgress / priorAtSameTime
    : 1;
  const scale = Math.max(0.25, Math.min(4, Number.isFinite(observedScale) ? observedScale : 1));
  const priorEstimate = cycleProgressEta(prior, resource, target, fallbackSec, scale);
  if (!currentEstimate.measured || !last || target <= 0) return priorEstimate;

  const maturity = Math.max(0, Math.min(1, currentProgress / Math.max(1e-9, target * 0.25)));
  const boundedCurrentSec = Math.max(priorEstimate.sec / 4, Math.min(priorEstimate.sec * 4, currentEstimate.sec));
  // Geometric interpolation is appropriate for multiplicative growth and
  // prevents a still-noisy large estimate dominating at tiny maturity.
  const sec = priorEstimate.sec * Math.pow(boundedCurrentSec / Math.max(1e-9, priorEstimate.sec), maturity);
  return {
    sec: Math.max(last.t, sec),
    // The blend is only as measured as the prior it is anchored to: when the
    // prior has no usable points for this resource its estimate is the raw
    // fallback constant, and flagging that measured would let curvePart
    // subtract elapsed cycle time from a number that never included it.
    measured: priorEstimate.measured,
    ...(currentEstimate.exponent !== undefined ? { exponent: currentEstimate.exponent } : {}),
  };
}

/** Paired-benchmark arithmetic shared by the darknet optimality lanes.
 *
 * The lab lane (`dnet-lab.ts`) grew its own copy first; the spread and farm
 * lanes reuse this one so the three lanes cannot disagree about what a paired
 * 95% CI is. Case N of both series must be the same generated world — the
 * caller's seed discipline, not this module's.
 */

export interface PairedComparison {
  baseline: string;
  candidate: string;
  cases: number;
  candidateBetter: number;
  tied: number;
  candidateWorse: number;
  /** Sum over cases; sign follows the caller's metric (lower-is-better keeps
   *  "negative means the candidate wins"). */
  delta: number;
  ratio: number;
  meanDelta: number;
  ci95Low: number;
  ci95High: number;
}

/** Paired mean-difference with a normal-approximation 95% CI, the same shape
 * `compareLabRuns` reports. `lowerIsBetter` only affects the win/loss counts. */
export function pairedComparison(
  baseline: { name: string; values: readonly number[] },
  candidate: { name: string; values: readonly number[] },
  lowerIsBetter = true,
): PairedComparison {
  if (baseline.values.length !== candidate.values.length || baseline.values.length === 0) {
    throw new Error("paired comparisons require equally sized, non-empty series");
  }
  let candidateBetter = 0;
  let tied = 0;
  let candidateWorse = 0;
  const deltas: number[] = [];
  for (let i = 0; i < baseline.values.length; i++) {
    const delta = candidate.values[i]! - baseline.values[i]!;
    deltas.push(delta);
    const wins = lowerIsBetter ? delta < 0 : delta > 0;
    const loses = lowerIsBetter ? delta > 0 : delta < 0;
    if (wins) candidateBetter++;
    else if (loses) candidateWorse++;
    else tied++;
  }
  const baseTotal = baseline.values.reduce((sum, v) => sum + v, 0);
  const candTotal = candidate.values.reduce((sum, v) => sum + v, 0);
  const meanDelta = (candTotal - baseTotal) / deltas.length;
  const variance = deltas.length < 2
    ? 0
    : deltas.reduce((sum, d) => sum + (d - meanDelta) ** 2, 0) / (deltas.length - 1);
  const margin95 = 1.96 * Math.sqrt(variance / deltas.length);
  return {
    baseline: baseline.name,
    candidate: candidate.name,
    cases: deltas.length,
    candidateBetter,
    tied,
    candidateWorse,
    delta: candTotal - baseTotal,
    ratio: baseTotal === 0 ? Infinity : candTotal / baseTotal,
    meanDelta,
    ci95Low: meanDelta - margin95,
    ci95High: meanDelta + margin95,
  };
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** The benchmark CLIs' one flag convention: the token after `--name`, or
 * undefined when the flag is absent. Shared so every lane parses alike. */
export function valueAfter(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

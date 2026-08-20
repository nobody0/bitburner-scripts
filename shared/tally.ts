/** Tallies maintained by increment instead of recomputed by walking.
 *
 * The dispatcher keeps several sums over ledgers that hold one entry per
 * in-flight op or resident process — tens of thousands at depth — so they are
 * updated at the two transitions that move an entry rather than re-derived per
 * pass. That trade only holds if the increments are exactly reversible.
 *
 * They are not, quite: subtract-then-add on floats is not associative, so a
 * tally that should reach exactly zero can retain a residue like 1e-15. Left
 * alone, that keeps a drained host or role alive forever and makes "is this
 * empty" unanswerable. Every subtraction here collapses the residue, and that
 * is the whole reason these live in one place instead of being written out at
 * each call site. */

/** Below this a tally is drained. Well under the smallest real allocation
 * (`WORKER_RAM.hack`, 1.7 GB) and well above accumulated float residue. */
const DRAINED_GB = 1e-9;

export function addGb(tally: Map<string, number>, key: string, gb: number): void {
  tally.set(key, (tally.get(key) ?? 0) + gb);
}

/** Subtract, dropping the key entirely once it drains. */
export function subGb(tally: Map<string, number>, key: string, gb: number): void {
  const left = (tally.get(key) ?? 0) - gb;
  if (left > DRAINED_GB) tally.set(key, left);
  else tally.delete(key);
}

/** Subtract from a fixed-key tally, which has no key to drop — collapse the
 * residue to a true zero instead. */
export function drainGb(held: number, gb: number): number {
  const left = held - gb;
  return Math.abs(left) > DRAINED_GB ? left : 0;
}

/** Move a per-key counter by `delta`, dropping the key when it reaches zero.
 * Integer counts, so no residue: absence and zero mean the same thing. */
export function bump(counts: Map<string, number>, key: string, delta: number): void {
  const left = (counts.get(key) ?? 0) + delta;
  if (left > 0) counts.set(key, left);
  else counts.delete(key);
}

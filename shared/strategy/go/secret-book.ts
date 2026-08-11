/** Offline arena-distilled 19x19 w0r1d_d43m0n policy.
 *
 * Keys preserve offline nodes and our stones while masking white placements.
 * This is the coarsest useful public-state abstraction on the fixed BitVerse
 * board: exact boards do not recur because seven handicap routers are sampled
 * at the start of every game. The trainer replays every candidate against the
 * complete real board and history, and runtime still checks legality and the
 * one exact opponent forecast allowed on 19x19.
 */
// Intentionally empty until a daemon-specific correction passes held-out
// arena validation. The trainer considers ordinary, sacrifice, and forced-
// defense candidates; its first qualifying training correction regressed the
// disjoint corpus and was therefore pruned rather than shipped.
const ENTRIES = [] as const satisfies readonly (readonly [string, number])[];

const POLICY = new Map<string, number>(ENTRIES);

export const secretPolicySize = ENTRIES.length;

export function secretPolicyKey(rows: readonly string[]): string {
  return rows.join("").replaceAll("O", ".");
}

export function secretPolicyMove(rows: readonly string[]): readonly [number, number] | undefined {
  const encoded = POLICY.get(secretPolicyKey(rows));
  const size = rows.length;
  return encoded === undefined || size === 0 ? undefined : [Math.floor(encoded / size), encoded % size];
}

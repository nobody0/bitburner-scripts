/** Identity of the game world's current prestige epoch.
 *
 * `currentNode` alone is insufficient: installing augmentations stays in the
 * same node, and a Source-File reset may enter the same BitNode again. The two
 * timestamps are the authoritative discriminators exposed by getResetInfo(). */
export interface ResetIdentity {
  currentNode: number;
  lastAugReset: number;
  lastNodeReset: number;
}

/** The game-world transition between two observations. `none` also covers the
 * first observation in a fresh JavaScript realm: with no earlier identity
 * there is no stale world state to invalidate. */
export type ResetKind = "none" | "augmentation" | "bitnode";
export type PrestigeKind = Exclude<ResetKind, "none">;

/** Classify prestige in strongest-first order. A BitNode reset also performs
 * augmentation prestige and therefore advances both timestamps. Comparing
 * for inequality rather than `>` also handles loading an older save into a
 * still-live realm without mistaking its cached state for the loaded world. */
export function classifyReset(
  before: ResetIdentity | undefined,
  after: ResetIdentity | undefined,
): ResetKind {
  if (!before || !after) return "none";
  if (before.currentNode !== after.currentNode || before.lastNodeReset !== after.lastNodeReset) return "bitnode";
  if (before.lastAugReset !== after.lastAugReset) return "augmentation";
  return "none";
}

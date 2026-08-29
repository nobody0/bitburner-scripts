/** The complete ordered BitNode route. Repeated nodes express partial unlocks;
 * disabled nodes remain visible in-place so enabling one cannot silently
 * change the intended order. BN12 is the infinite fallback after the enabled
 * finite milestones. Historical context lives in
 * spec/strategy/speedrun-benchmark.md.
 *
 * The route starts fresh in BN4: Singularity is node-native there, so nothing
 * is injected. The first completed BitNode is 4.1 inside the 4.3 milestone,
 * and BN1 levels 1-3 are all earned at the 1.3 entry. */

export interface BitNodeMilestone {
  node: number;
  level: number;
}

export const BITNODE_SPEEDRUN_PLAN: readonly BitNodeMilestone[] = [
  { node: 4, level: 3 },
  { node: 1, level: 3 },
  { node: 15, level: 3 },
  { node: 14, level: 1 },
  { node: 5, level: 1 },
  { node: 2, level: 3 },
  { node: 14, level: 3 },
  { node: 5, level: 3 },
  { node: 12, level: 3 },
  { node: 8, level: 3 },
  { node: 10, level: 3 },
  { node: 9, level: 3 },
  { node: 13, level: 3 },
  { node: 6, level: 3 },
  { node: 7, level: 3 },
  { node: 11, level: 3 },
  { node: 3, level: 3 },
];

/** Remove a node here when its controller is ready. Every milestone for that
 * node becomes live without moving or duplicating route entries. */
export const DISABLED_BITNODES: ReadonlySet<number> = new Set([
  2, 3, 6, 7, 8, 9, 10, 11, 13,
]);

export const BITNODE_FALLBACK = 12;

/** Operator hold at the irreversible boundary. While held, progression still
 * finishes and publishes the route plus next destination, but never arms or
 * dispatches destroyW0r1dD43m0n.
 *
 * Held by default: in the live game the boundary is one-way and the operator
 * decides when to cross it. A simulated route leg is the exception — its goal
 * IS the destruction, so `bn:<n>` is unreachable by construction while the
 * hold stands. The simulator lifts it per run and restores it afterwards
 * (`GameRunOptions.allowBitNodeCompletion`); nothing else should. */
let stallBitNodeCompletion = true;

export function isBitNodeCompletionStalled(): boolean {
  return stallBitNodeCompletion;
}

/** Returns the previous value so a caller can restore it. */
export function setBitNodeCompletionStall(stalled: boolean): boolean {
  const previous = stallBitNodeCompletion;
  stallBitNodeCompletion = stalled;
  return previous;
}

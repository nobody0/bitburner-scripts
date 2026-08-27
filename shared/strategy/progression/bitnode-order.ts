/** The complete ordered BitNode route. Repeated nodes express partial unlocks;
 * disabled nodes remain visible in-place so enabling one cannot silently
 * change the intended order. BN12 is the infinite fallback after the enabled
 * finite milestones. Historical context lives in
 * spec/strategy/speedrun-benchmark.md. */

export interface BitNodeMilestone {
  node: number;
  level: number;
}

export const BITNODE_SPEEDRUN_PLAN: readonly BitNodeMilestone[] = [
  { node: 1, level: 1 },
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

/** Operator hold at the irreversible boundary. While true, progression still
 * finishes and publishes the route plus next destination, but never arms or
 * dispatches destroyW0r1dD43m0n. Set false to resume automatic completion. */
export const STALL_BITNODE_COMPLETION = true;

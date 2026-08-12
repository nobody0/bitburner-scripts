/** Ordered live milestones. Repeated nodes express partial unlocks; BN12 is
 * the infinite fallback after the enabled finite milestones. The historical
 * and provisional full routes live in spec/strategy/speedrun-benchmark.md. */

export interface BitNodeMilestone {
  node: number;
  level: number;
}

export const BITNODE_SPEEDRUN_PLAN: readonly BitNodeMilestone[] = [
  { node: 4, level: 3 },
  { node: 1, level: 3 },
  { node: 5, level: 1 },
  { node: 5, level: 3 },
  { node: 12, level: 3 },
];

export const BITNODE_FALLBACK = 12;

/** Choose the first enabled milestone that will remain incomplete after this
 * destruction.
 *
 * `destroyW0r1dD43m0n` awards the CURRENT node's Source-File inside
 * enterBitNode(), after its `nextBN` argument has already been chosen. Project
 * that pending +1 here; otherwise every milestone is run one extra time. */
export function nextBitNode(
  currentNode: number | undefined,
  sourceFiles: Readonly<Record<string, number>>,
  plan: readonly BitNodeMilestone[] = BITNODE_SPEEDRUN_PLAN,
  fallback = BITNODE_FALLBACK,
): number {
  for (const milestone of plan) {
    const held = sourceFiles[String(milestone.node)] ?? 0;
    const afterCurrentCompletion = held + (currentNode === milestone.node ? 1 : 0);
    if (afterCurrentCompletion < milestone.level) return milestone.node;
  }
  return fallback;
}

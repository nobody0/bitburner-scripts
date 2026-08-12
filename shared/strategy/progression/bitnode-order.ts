/** The one editable cross-BitNode speedrun plan.
 * Historical order, timings, rules, and checkpoint roadmap:
 * spec/strategy/speedrun-benchmark.md.
 *
 * Entries are ordered milestones, not independent priorities. Repeated nodes
 * deliberately express partial unlocks: for example BN5.1 is taken early,
 * then BN5 is revisited until SF5.3 after the intervening milestones.
 *
 * To keep a BitNode out of live automation, comment out its entry below. The
 * full route remains visible in-place as the basis for the eventual fresh-save
 * to all finite Source-Files speedrun. BN12 is both an early SF12.3 milestone
 * and the safe infinite fallback once every enabled milestone is satisfied.
 *
 * BN14 and BN15 did not exist when the original ordering was written. Their
 * intended positions below are reasoned starting points, documented in the
 * benchmark, and remain disabled until their controllers are ready. */

export interface BitNodeMilestone {
  node: number;
  level: number;
}

export const BITNODE_SPEEDRUN_PLAN: readonly BitNodeMilestone[] = [
  { node: 4, level: 3 },
  { node: 1, level: 3 },
  { node: 5, level: 1 },

  // Commented milestones are intentionally disabled until their controllers
  // are ready. Uncomment a line to put it back into the live route.
  // Take SF15.1 early for the portable darknet and alternative Red Pill route.
  // { node: 15, level: 1 },
  // { node: 2, level: 3 },

  // Finish BN14 as soon as SF2 makes gangs available. Gang income gives harsh
  // BN14 a viable economy; the complete SF14 then buffs nearly the whole run.
  // { node: 14, level: 3 },

  { node: 5, level: 3 },
  { node: 12, level: 3 },

  // Finish SF15 after the core multipliers make its two repeat runs cheaper.
  // { node: 15, level: 3 },
  // { node: 8, level: 3 },
  // { node: 10, level: 3 },
  // { node: 9, level: 3 },
  // { node: 13, level: 3 },
  // { node: 7, level: 1 },
  // { node: 6, level: 3 },
  // { node: 7, level: 3 },
  // { node: 11, level: 3 },
  // { node: 3, level: 3 },
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

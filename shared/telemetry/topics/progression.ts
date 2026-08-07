import type { MoneySource } from "@ns";

/** Progression feature — the meta layer. Problem: pick the destroy order and
 * the augmentation/reset cadence that minimises total wall-clock to a target
 * source-file set.
 *
 * SERIALIZATION: ResetInfo hands back `ownedAugs`, `ownedSF` and
 * `bitNodeOptions.sourceFileOverrides` as Maps. `JSON.stringify(new Map())`
 * is `{}` — every one of them is flattened with Object.fromEntries before it
 * reaches the wire. Same rule for every topic in this directory. */

export interface Progression {
  bitNode: number;
  /** SF number -> active level. Level n on SF k means BN k was completed n
   * times, so this doubles as "which BitNodes are done". */
  sourceFiles: Record<string, number>;
  /** Augmentation name -> level (level matters for NeuroFlux Governor). */
  ownedAugs: Record<string, number>;
  augCount: number;
  lastAugReset: number;
  lastNodeReset: number;
  /** Flattened BitNodeOptions; sourceFileOverrides is a Map upstream. */
  bitNodeOptions?: {
    sourceFileOverrides: Record<string, number>;
    intelligenceOverride?: number;
    restrictHomePCUpgrade?: boolean;
    disableGang?: boolean;
    disableCorporation?: boolean;
    disableBladeburner?: boolean;
    disableHacknetServer?: boolean;
    disableSleeveExpAndAugmentation?: boolean;
  };
  /** Only present with SF5/BN5 — ns.getBitNodeMultipliers throws otherwise. */
  multipliers?: Record<string, number>;
  /** Per-feature money attribution: the cross-feature "what is actually
   * paying" view, and the cheapest signal for which feature to optimise. */
  moneySources?: { sinceInstall: MoneySource; sinceStart: MoneySource };
}

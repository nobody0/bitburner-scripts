/** Per-leg entrance state derived from the speedrun route.
 *
 * A leg is ONE BitNode completion. BITNODE_SPEEDRUN_PLAN milestones are
 * shorthand — `{node: 4, level: 3}` means "complete BN4 three times" — so the
 * derivation decomposes each milestone into its individual completions:
 * `bn4.1`, `bn4.2`, `bn4.3`. A later milestone decomposes only into the
 * levels still missing: `{node: 14, level: 3}` after `14.1` yields `bn14.2`
 * and `bn14.3`, never a repeat of `bn14.1`.
 *
 * Source-File state is fully determined by the route order — mid-milestone
 * legs hold their own node's partial level (`bn4.2` enters BN4 owning SF4.1).
 * Intelligence is not derivable: it is whatever the previous leg actually
 * finished with, so a leg's entrance intelligence prefers the measured exit
 * of the leg before it and falls back to a coarse estimate. The measured
 * exits live in the route-legs ledger (sim/tests/baselines/route-legs.json);
 * this module stays pure and takes them as an argument. */

import { BITNODE_SPEEDRUN_PLAN, DISABLED_BITNODES, type BitNodeMilestone } from "./bitnode-order.ts";

export const SPEEDRUN_ROUTE_ID = "all-sf3-bn4-first";

export interface RouteLeg {
  /** 0-based completion index across the whole route. Informational; `leg`
   * is the durable name. */
  index: number;
  node: number;
  /** The Source-File level THIS single completion earns. */
  level: number;
  /** Stable name, `bn<node>.<level>` — unique because levels only rise. */
  leg: string;
  /** The BITNODE_SPEEDRUN_PLAN entry this completion belongs to, written
   * `<node>.<targetLevel>` — so a leg can say which milestone's shorthand it
   * came from (`bn4.2` belongs to `4.3`). */
  milestone: string;
  /** Every Source-File earned by earlier completions, absolute levels —
   * including this node's own partial level mid-milestone. */
  entranceSourceFiles: Readonly<Record<string, number>>;
  /** Measured exit of the previous leg when recorded, else the estimate. */
  entranceIntelligence: number;
  intelligenceSource: "measured" | "estimated";
  enabled: boolean;
}

export function deriveRouteLegs(
  plan: readonly BitNodeMilestone[] = BITNODE_SPEEDRUN_PLAN,
  measuredExitIntelligence: Readonly<Record<string, number>> = {},
): readonly RouteLeg[] {
  const accumulated: Record<string, number> = {};
  const legs: RouteLeg[] = [];
  let sf5LegIndex = -1;
  for (const { node, level } of plan) {
    const key = String(node);
    for (let earned = (accumulated[key] ?? 0) + 1; earned <= level; earned += 1) {
      const index = legs.length;
      if (sf5LegIndex === -1 && node === 5) sf5LegIndex = index;
      const previous = legs[index - 1];
      const measured = previous ? measuredExitIntelligence[previous.leg] : undefined;
      // The estimate stays 0 through the 5.1 completion (installs zero
      // intelligence without owned SF5), then grows by 10 per completion.
      const estimate = sf5LegIndex === -1 || index <= sf5LegIndex ? 0 : 10 * (index - sf5LegIndex);
      legs.push({
        index,
        node,
        level: earned,
        leg: `bn${node}.${earned}`,
        milestone: `${node}.${level}`,
        entranceSourceFiles: { ...accumulated },
        entranceIntelligence: measured ?? estimate,
        intelligenceSource: measured !== undefined ? "measured" : "estimated",
        enabled: !DISABLED_BITNODES.has(node),
      });
      accumulated[key] = earned;
    }
  }
  return legs;
}

/** Naming convention for the sim profile covering a leg. shared/ cannot see
 * sim/, so existence is checked sim-side against PROFILES. */
export function routeLegProfileId(leg: Pick<RouteLeg, "node" | "level">): string {
  return `leg-bn${leg.node}.${leg.level}`;
}

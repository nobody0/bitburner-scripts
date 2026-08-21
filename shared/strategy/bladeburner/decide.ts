/** Bladeburner action selection.
 *
 * Objective: climb rank quickly while keeping risky Black Ops behind an
 * explicit confidence policy. Failed Black Ops can lose rank and deal enough
 * damage to hospitalise the player, but failure does not consume the op.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Bladeburner/Bladeburner.ts#L1014-L1080
 *
 * Three constraints shape every choice:
 *  - **stamina**, which multiplies success chance below a threshold, so acting
 *    while exhausted is worse than resting;
 *  - **chaos**, which rises with activity and lowers success chance, and is
 *    actively managed here with Diplomacy;
 *  - **the success-chance INTERVAL**. The game reports `[min, max]` because
 *    the player's estimate is imprecise, and acting on the optimistic end is
 *    exactly how a Black Op gets failed. Every decision here uses the LOWER
 *    bound.
 *
 * Pinned upstream mechanics:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Bladeburner/Bladeburner.ts#L166-L169
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Bladeburner/Actions/Action.ts#L90-L101
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L138-L181 */

export interface BladeburnerAction {
  type: "general" | "contract" | "operation" | "blackop";
  name: string;
  /** `[min, max]` estimate. The lower bound is what decisions use. */
  chance: [number, number];
  timeMs: number;
  /** Remaining count; Infinity for general actions. */
  countRemaining: number;
  level: number;
  /** Level-adjusted base rank gained on success, before completion variance. */
  rankGain: number;
  /** Level-adjusted base rank lost on failure, before completion variance. */
  rankLoss: number;
  /** Rank required to attempt (Black Ops only). */
  rankNeeded?: number;
}

export interface BladeburnerView {
  rank: number;
  skillPoints: number;
  /** `[current, max]`. */
  stamina: [number, number];
  city: string;
  chaos: number;
  actions: BladeburnerAction[];
  /** Skill name -> {level, upgradeCost}. */
  skills: Record<string, { level: number; upgradeCost: number }>;
  current?: { type: string; name: string };
}

export type BladeburnerDecision =
  | { action: { type: "stop" }; ranked: ScoredBladeburner[] }
  | { action: { type: "continue" }; ranked: ScoredBladeburner[] }
  | { action: { type: "act"; actionType: string; name: string }; ranked: ScoredBladeburner[] }
  | { action: { type: "upgrade"; skill: string }; ranked: ScoredBladeburner[] };

export interface ScoredBladeburner {
  name: string;
  actionType: string;
  /** Pessimistic expected net rank per second, including failure loss. */
  rankPerSec: number;
  chanceLow: number;
}

/** Below this fraction of max stamina, the game penalises success chance —
 * so acting is worse than resting. */
export const STAMINA_FLOOR = 0.5;
/** Chaos above this materially degrades every action in the city. */
export const CHAOS_CEILING = 50;
/** Strategy confidence threshold for a Black Op. Failure can lose rank and
 * deal damage, while success permanently advances the ordered operation list. */
export const BLACKOP_CONFIDENCE = 0.95;

export function stepBladeburner(view: BladeburnerView): BladeburnerDecision {
  const ranked: ScoredBladeburner[] = view.actions
    .filter((action) => action.countRemaining > 0)
    .map((action) => {
      const chanceLow = action.chance[0];
      const seconds = action.timeMs / 1000;
      return {
        name: action.name,
        actionType: action.type,
        rankPerSec: seconds > 0
          ? (chanceLow * action.rankGain - (1 - chanceLow) * action.rankLoss) / seconds
          : 0,
        chanceLow,
      };
    })
    .sort((a, b) => b.rankPerSec - a.rankPerSec || (a.name < b.name ? -1 : 1));

  // Stamina first: acting below the floor reduces success chance, so resting
  // is strictly faster than pushing through.
  const [current, max] = view.stamina;
  if (max > 0 && current / max < STAMINA_FLOOR) {
    return { action: { type: "stop" }, ranked };
  }

  // Chaos suppresses success chance across the city; this policy switches to
  // Diplomacy once it crosses the upstream difficulty threshold.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Bladeburner/Actions/Action.ts#L90-L101
  if (view.chaos > CHAOS_CEILING) {
    const diplomacy = view.actions.find((action) => action.name === "Diplomacy");
    if (diplomacy) {
      return {
        action: { type: "act", actionType: "general", name: "Diplomacy" },
        ranked,
      };
    }
  }

  // Skill upgrades improve Bladeburner performance. Spending the cheapest
  // available level first is a strategy policy, not an upstream optimum.
  const affordable = Object.entries(view.skills)
    .filter(([, skill]) => skill.upgradeCost <= view.skillPoints)
    .sort((a, b) => a[1].upgradeCost - b[1].upgradeCost || (a[0] < b[0] ? -1 : 1));
  if (affordable.length > 0) {
    const [name] = affordable[0]!;
    return {
      action: { type: "upgrade", skill: name },
      ranked,
    };
  }

  // Black Ops only above the policy confidence bar, using the pessimistic end.
  const blackOp = view.actions.find(
    (action) => action.type === "blackop" && action.countRemaining > 0 && (action.rankNeeded ?? 0) <= view.rank,
  );
  if (blackOp) {
    if (blackOp.chance[0] >= BLACKOP_CONFIDENCE) {
      return {
        action: { type: "act", actionType: "blackop", name: blackOp.name },
        ranked,
      };
    }
    // Not confident enough — fall through to ordinary actions rather than
    // gambling. This is the "without dying" constraint doing its job.
  }

  const best = ranked.find((entry) => entry.actionType !== "blackop");
  if (!best) {
    return { action: { type: "stop" }, ranked };
  }
  if (view.current?.name === best.name) {
    return { action: { type: "continue" }, ranked };
  }
  return {
    action: { type: "act", actionType: best.actionType, name: best.name },
    ranked,
  };
}

import { formatNumber, formatScientific } from "../../format.ts";

/** Bladeburner action selection.
 *
 * Objective: climb rank fastest WITHOUT DYING. The second half is a hard
 * constraint, not a preference — failing a Black Op hospitalises the player,
 * which costs far more time than the operation was worth, and a planner that
 * maximised expected rank alone would take those odds happily.
 *
 * Three constraints shape every choice:
 *  - **stamina**, which multiplies success chance below a threshold, so acting
 *    while exhausted is worse than resting;
 *  - **chaos**, which rises with activity and lowers success chance, and is
 *    reduced only by Diplomacy;
 *  - **the success-chance INTERVAL**. The game reports `[min, max]` because
 *    the player's estimate is imprecise, and acting on the optimistic end is
 *    exactly how a Black Op gets failed. Every decision here uses the LOWER
 *    bound. */

export interface BladeburnerAction {
  type: "general" | "contract" | "operation" | "blackop";
  name: string;
  /** `[min, max]` estimate. The lower bound is what decisions use. */
  chance: [number, number];
  timeMs: number;
  /** Remaining count; Infinity for general actions. */
  countRemaining: number;
  level: number;
  /** Rank gained on success. */
  rankGain: number;
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
  | { action: { type: "rest"; why: string }; ranked: ScoredBladeburner[]; why: string }
  | { action: { type: "act"; actionType: string; name: string; why: string }; ranked: ScoredBladeburner[]; why: string }
  | { action: { type: "upgrade"; skill: string; why: string }; ranked: ScoredBladeburner[]; why: string };

export interface ScoredBladeburner {
  name: string;
  actionType: string;
  /** Expected rank per second at the PESSIMISTIC chance. */
  rankPerSec: number;
  chanceLow: number;
  why: string;
}

/** Below this fraction of max stamina, the game penalises success chance —
 * so acting is worse than resting. */
export const STAMINA_FLOOR = 0.5;
/** Chaos above this materially degrades every action in the city. */
export const CHAOS_CEILING = 50;
/** A Black Op is irreversible and failing one hospitalises. Only attempt above
 * this PESSIMISTIC success chance. */
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
        rankPerSec: seconds > 0 ? (chanceLow * action.rankGain) / seconds : 0,
        chanceLow,
        why: `${(chanceLow * 100).toFixed(0)}% (pessimistic) for ${formatNumber(action.rankGain)} rank in ${Math.round(seconds)}s`,
      };
    })
    .sort((a, b) => b.rankPerSec - a.rankPerSec || (a.name < b.name ? -1 : 1));

  // Stamina first: acting below the floor reduces success chance, so resting
  // is strictly faster than pushing through.
  const [current, max] = view.stamina;
  if (max > 0 && current / max < STAMINA_FLOOR) {
    return {
      action: {
        type: "rest",
        why: `stamina ${Math.round(current)}/${Math.round(max)} is below the ${STAMINA_FLOOR * 100}% floor, which penalises every action`,
      },
      ranked,
      why: "resting",
    };
  }

  // Chaos suppresses success chance across the city; Diplomacy is the only
  // thing that reduces it.
  if (view.chaos > CHAOS_CEILING) {
    const diplomacy = view.actions.find((action) => action.name === "Diplomacy");
    if (diplomacy) {
      return {
        action: {
          type: "act",
          actionType: "general",
          name: "Diplomacy",
          why: `chaos ${Math.round(view.chaos)} is above ${CHAOS_CEILING} and is degrading every action`,
        },
        ranked,
        why: "reducing chaos",
      };
    }
  }

  // Skill points are free rank once spent, so never sit on them.
  const affordable = Object.entries(view.skills)
    .filter(([, skill]) => skill.upgradeCost <= view.skillPoints)
    .sort((a, b) => a[1].upgradeCost - b[1].upgradeCost || (a[0] < b[0] ? -1 : 1));
  if (affordable.length > 0) {
    const [name, skill] = affordable[0]!;
    return {
      action: { type: "upgrade", skill: name, why: `${view.skillPoints} skill points, ${name} costs ${skill.upgradeCost}` },
      ranked,
      why: "spending skill points",
    };
  }

  // Black Ops only above the confidence bar, and only at the PESSIMISTIC end.
  const blackOp = view.actions.find(
    (action) => action.type === "blackop" && action.countRemaining > 0 && (action.rankNeeded ?? 0) <= view.rank,
  );
  if (blackOp) {
    if (blackOp.chance[0] >= BLACKOP_CONFIDENCE) {
      return {
        action: { type: "act", actionType: "blackop", name: blackOp.name, why: `${(blackOp.chance[0] * 100).toFixed(1)}% pessimistic success` },
        ranked,
        why: "black op",
      };
    }
    // Not confident enough — fall through to ordinary actions rather than
    // gambling. This is the "without dying" constraint doing its job.
  }

  const best = ranked.find((entry) => entry.actionType !== "blackop");
  if (!best) {
    return { action: { type: "rest", why: "no action available" }, ranked, why: "idle" };
  }
  if (view.current?.name === best.name) {
    return { action: { type: "rest", why: `already running ${best.name}` }, ranked, why: "continuing" };
  }
  return {
    action: { type: "act", actionType: best.actionType, name: best.name, why: best.why },
    ranked,
    why: `${formatScientific(best.rankPerSec)} rank/sec at the pessimistic chance`,
  };
}

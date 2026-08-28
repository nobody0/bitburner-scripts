/** Bladeburner action selection.
 *
 * Objective: climb rank quickly while keeping risky Black Ops behind an
 * explicit confidence policy. Failed Black Ops can lose rank and deal enough
 * damage to hospitalise the player, but failure does not consume the op.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Bladeburner/Bladeburner.ts#L1014-L1080
 *
 * Three constraints shape every choice:
 *  - **stamina**, which multiplies success chance below a threshold; this
 *    policy idles rather than making penalised attempts;
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
  chaos: number;
  actions: BladeburnerAction[];
  /** Skill name -> next-level cost. */
  skills: Record<string, { upgradeCost: number }>;
  current?: { name: string };
}

export type BladeburnerDecision = {
  action:
    | { type: "stop"; reason: "stamina" | "no-action" }
    | { type: "continue"; actionType: BladeburnerAction["type"]; name: string }
    | { type: "act"; actionType: BladeburnerAction["type"]; name: string }
    | { type: "upgrade"; skill: string };
  ranked: ScoredBladeburner[];
};

export interface ScoredBladeburner {
  name: string;
  actionType: BladeburnerAction["type"];
  /** Pessimistic expected net rank per second, including failure loss. */
  rankPerSec: number;
  chanceLow: number;
}

/** Below this fraction of max stamina, the game penalises success chance. */
export const STAMINA_FLOOR = 0.5;
/** Chaos above this materially degrades every action in the city. */
export const CHAOS_CEILING = 50;
/** Strategy confidence threshold for a Black Op. Failure can lose rank and
 * deal damage, while success permanently advances the ordered operation list. */
export const BLACKOP_CONFIDENCE = 0.95;

function selectAction(
  view: BladeburnerView,
  ranked: ScoredBladeburner[],
  actionType: BladeburnerAction["type"],
  name: string,
): BladeburnerDecision {
  return view.current?.name === name
    ? { action: { type: "continue", actionType, name }, ranked }
    : { action: { type: "act", actionType, name }, ranked };
}

export function stepBladeburner(view: BladeburnerView): BladeburnerDecision {
  // getBlackOpNames is explicitly ordered upstream. Completed ops report 0;
  // the first remaining row is the only Black Op whose predecessor gate can
  // be satisfied, regardless of how much rank later rows require.
  const nextBlackOp = view.actions.find((action) => action.type === "blackop" && action.countRemaining >= 1);
  const ranked: ScoredBladeburner[] = view.actions
    // Levelable counts regrow fractionally, but upstream availability requires
    // a full count (`count >= 1`) before startAction will accept the action.
    .filter((action) =>
      action.countRemaining >= 1
      && (action.type !== "blackop"
        || (action === nextBlackOp && action.rankNeeded !== undefined && action.rankNeeded <= view.rank)),
    )
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
    .sort((a, b) => b.rankPerSec - a.rankPerSec || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Stamina first: this conservative policy avoids attempts while the game is
  // applying its below-half success penalty. Stamina regenerates either way,
  // so this is a risk policy, not a claim that idling is always throughput-optimal.
  const [current, max] = view.stamina;
  if (max > 0 && current / max < STAMINA_FLOOR) {
    return { action: { type: "stop", reason: "stamina" }, ranked };
  }

  // Chaos suppresses success chance across the city; this policy switches to
  // Diplomacy once it crosses the upstream difficulty threshold.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Bladeburner/Actions/Action.ts#L90-L101
  if (view.chaos > CHAOS_CEILING) {
    const diplomacy = view.actions.find((action) => action.name === "Diplomacy");
    if (diplomacy) {
      return selectAction(view, ranked, diplomacy.type, diplomacy.name);
    }
  }

  // Buy only skills that improve rank throughput or this policy's chance
  // information. Cheapest-first is a strategy policy, not an upstream optimum.
  const affordable = Object.entries(view.skills)
    .filter(([name, skill]) =>
      name !== "Hands of Midas"
      && name !== "Hyperdrive"
      && Number.isFinite(skill.upgradeCost)
      && skill.upgradeCost <= view.skillPoints,
    )
    .sort((a, b) => a[1].upgradeCost - b[1].upgradeCost || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (affordable.length > 0) {
    const [name] = affordable[0]!;
    return {
      action: { type: "upgrade", skill: name },
      ranked,
    };
  }

  // Black Ops only above the policy confidence bar, using the pessimistic end.
  const blackOp = nextBlackOp?.rankNeeded !== undefined && nextBlackOp.rankNeeded <= view.rank
    ? nextBlackOp
    : undefined;
  if (blackOp) {
    if (blackOp.chance[0] >= BLACKOP_CONFIDENCE) {
      return selectAction(view, ranked, blackOp.type, blackOp.name);
    }
    // Not confident enough — fall through to ordinary actions rather than
    // gambling. This is the "without dying" constraint doing its job.
  }

  const best = ranked.find((entry) => entry.actionType !== "blackop");
  if (!best) {
    return { action: { type: "stop", reason: "no-action" }, ranked };
  }
  return selectAction(view, ranked, best.actionType, best.name);
}

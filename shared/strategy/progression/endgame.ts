import { bitNodeMultipliers, worldDaemonSkill } from "../../features/bitnode.ts";
import { formatMoney, formatScientific } from "../../format.ts";

/** How a BitNode actually ends, and what is still missing.
 *
 * Split from ./decide.ts because that file answers "when do I install", a
 * question about the reset LOOP. This one answers "how does the loop stop",
 * which turns out not to be a single path — and hard-coding the obvious one is
 * the mistake it exists to prevent.
 *
 * Three routes reach the same place (`enterBitNode`), and they share almost no
 * prerequisites:
 *
 *  - **Daedalus** — 30 augs (node-dependent), $100b, hacking 2500 or combat
 *    1500, then 2,500,000 reputation for The Red Pill.
 *  - **Darknet labyrinth** — the lab reward sequence ends in The Red Pill in
 *    every node whose `DarknetLabyrinthRewardsTheRedPill` is non-zero, which
 *    is every node except BN8. Needs the dark web, so BN15 or SF15.
 *  - **Bladeburner** — completing ALL black operations satisfies
 *    `ns.singularity.destroyW0r1dD43m0n` on its own, with no Red Pill and no
 *    hacking requirement whatsoever. Operation Daedalus, the last one, needs
 *    rank 400,000.
 *
 * The two Red Pill routes converge on one more step that is easy to miss and
 * expensive to discover late: the aug must be INSTALLED, because the
 * `The-Cave -> w0r1d_d43m0n` link is created during the install, and an
 * install resets hacking to 1. So "reach the world-daemon level" is a climb
 * that happens AFTER the install that carries the pill, never before. */

export const RED_PILL = "The Red Pill";
export const RED_PILL_REP = 2_500_000;
export const DAEDALUS_MONEY = 100e9;
export const DAEDALUS_HACKING = 2500;
export const DAEDALUS_COMBAT = 1500;
/** Rank for Operation Daedalus, the last black op (Bladeburner/data). */
export const BLACK_OP_FINAL_RANK = 400_000;
/** The count the game checks for "all black ops complete". */
export const BLACK_OP_COUNT = 20;

export type RouteId = "daedalus" | "labyrinth" | "bladeburner";

export interface EndgameView {
  bitNode: number | undefined;
  /** SF12 level, which is the only thing that moves BN12's requirements. */
  sf12Level?: number;
  /** Active source-file levels, SF n -> level. */
  sourceFiles: Record<string, number>;
  augCount: number;
  ownsRedPill: boolean;
  /** True once an install has happened while owning the pill — i.e. the
   *  world daemon is actually in the network graph. */
  redPillInstalled: boolean;
  money: number;
  hackingSkill: number;
  /** Lowest of the four combat skills, for Daedalus's alternative branch. */
  lowestCombatSkill: number;
  daedalusRep: number;
  inBladeburner: boolean;
  /** Completed black operations, when known. Optional because the reading may
   *  not have landed yet — and "unknown" must stay expressible: a fabricated 0
   *  here would re-price already-completed ops into the route estimate and
   *  feed a phantom 0->N jump into the rate tracker. Absent reads as 0 for
   *  the completeness check (never complete on no data) and is skipped by the
   *  rate sampler. */
  blackOpsComplete?: number;
  /** Current Bladeburner rank, when known — ./eta.ts prices the rank climb to
   *  the final black op from it. Optional because the detail probe may not
   *  have reported yet; absent reads as rank 0. */
  bladeburnerRank?: number;
}

export interface RouteStatus {
  id: RouteId;
  /** Can this route be pursued in this node at all? */
  available: boolean;
  /** Every requirement met — the node can be ended right now. */
  complete: boolean;
  /** The single next thing this route is waiting on. */
  blocker: string;
}

export interface EndgameDecision {
  routes: RouteStatus[];
  /** The route closest to completion that is actually available. */
  best: RouteStatus | undefined;
  /** Hacking level w0r1d_d43m0n needs here, or undefined if the node is
   *  unknown. Both Red Pill routes end here. */
  worldDaemonSkill: number | undefined;
  /** The regrow is pending: we own and installed the pill but the skill reset
   *  put the target out of reach again. Named because a planner that misses it
   *  under-estimates the run by a whole climb. */
  awaitingRegrow: boolean;
  why: string;
}

function sf(view: EndgameView, n: number): number {
  return view.sourceFiles[String(n)] ?? 0;
}

/** Does this node's labyrinth hand out The Red Pill? Every node but BN8. */
export function labyrinthOffersRedPill(bitNode: number | undefined, sf12Level = 0): boolean {
  const mults = bitNodeMultipliers(bitNode, sf12Level);
  if (!mults) return false;
  return (mults.DarknetLabyrinthRewardsTheRedPill ?? 1) !== 0;
}

/** Augmentations Daedalus demands here — 30 in BN1, 20 in BN15, 35 in BN6/7,
 * and a function of the level in BN12. */
export function daedalusAugsRequired(bitNode: number | undefined, sf12Level = 0): number | undefined {
  return bitNodeMultipliers(bitNode, sf12Level)?.DaedalusAugsRequirement;
}

export function stepEndgame(view: EndgameView): EndgameDecision {
  const sf12 = view.sf12Level ?? sf(view, 12);
  const wdSkill = worldDaemonSkill(view.bitNode, sf12);
  const augsNeeded = daedalusAugsRequired(view.bitNode, sf12);
  const hasWorldDaemonSkill = wdSkill !== undefined && view.hackingSkill >= wdSkill;

  // Shared tail of both Red Pill routes. Owning the pill is not enough: the
  // link is created on install, and the install resets the skill.
  const redPillTail = (): { complete: boolean; blocker: string } => {
    if (!view.ownsRedPill) return { complete: false, blocker: `acquire ${RED_PILL}` };
    if (!view.redPillInstalled) {
      return { complete: false, blocker: `install ${RED_PILL} (creates the w0r1d_d43m0n link)` };
    }
    if (!hasWorldDaemonSkill) {
      return { complete: false, blocker: `hacking ${view.hackingSkill} of ${wdSkill ?? "?"} after the install` };
    }
    return { complete: true, blocker: "" };
  };

  const routes: RouteStatus[] = [];

  // Both Red Pill routes are ACQUISITION strategies sharing one tail. Once the
  // pill is owned it no longer matters which one produced it, so the tail
  // takes over completely — continuing to report "Daedalus reputation 0 of
  // 2.5e6" for a player holding the pill would be nonsense, and would make a
  // labyrinth run look permanently blocked on a faction it never needed.
  const tail = redPillTail();

  // --- Daedalus -----------------------------------------------------------
  {
    const meetsSkills =
      view.hackingSkill >= DAEDALUS_HACKING || view.lowestCombatSkill >= DAEDALUS_COMBAT;
    let blocker: string;
    if (augsNeeded === undefined) blocker = "BitNode unknown";
    else if (view.ownsRedPill) blocker = tail.blocker;
    else if (view.augCount < augsNeeded) blocker = `${view.augCount} of ${augsNeeded} augmentations`;
    else if (view.money < DAEDALUS_MONEY) blocker = `${formatMoney(view.money)} of ${formatMoney(DAEDALUS_MONEY)}`;
    else if (!meetsSkills) blocker = `hacking ${DAEDALUS_HACKING} or combat ${DAEDALUS_COMBAT}`;
    else if (view.daedalusRep < RED_PILL_REP) {
      blocker = `Daedalus reputation ${formatScientific(view.daedalusRep)} of ${formatScientific(RED_PILL_REP)}`;
    } else blocker = tail.blocker;
    routes.push({
      id: "daedalus",
      available: augsNeeded !== undefined,
      complete: augsNeeded !== undefined && tail.complete,
      blocker,
    });
  }

  // --- Darknet labyrinth --------------------------------------------------
  {
    const available =
      labyrinthOffersRedPill(view.bitNode, sf12) && (view.bitNode === 15 || sf(view, 15) > 0);
    routes.push({
      id: "labyrinth",
      available,
      complete: available && tail.complete,
      blocker: !available
        ? view.bitNode === 8
          ? "BN8 disables the labyrinth's Red Pill"
          : "requires BN15 or SF15 for dark web access"
        : view.ownsRedPill
          ? tail.blocker
          : "walk the labyrinth",
    });
  }

  // --- Bladeburner --------------------------------------------------------
  {
    // No Red Pill and no hacking requirement: all black ops is sufficient on
    // its own, which is why this route is checked independently rather than
    // as a variation of the others.
    const complete = view.inBladeburner && (view.blackOpsComplete ?? 0) >= BLACK_OP_COUNT;
    routes.push({
      id: "bladeburner",
      available: view.inBladeburner,
      complete,
      blocker: !view.inBladeburner
        ? "not in the Bladeburner division"
        : complete
          ? ""
          : `${view.blackOpsComplete ?? "?"} of ${BLACK_OP_COUNT} black operations`,
    });
  }

  const usable = routes.filter((route) => route.available);
  const best = usable.find((route) => route.complete) ?? usable[0];

  const awaitingRegrow = view.ownsRedPill && view.redPillInstalled && !hasWorldDaemonSkill;

  // Once the pill is owned, `daedalus` and `labyrinth` are the same remaining
  // work and both report the shared tail — so naming one of them would invent
  // a history. A labyrinth run must not be told it finished "the daedalus
  // route". Bladeburner is unaffected: it never touches the pill.
  const redPillRouteChosen = best?.id === "daedalus" || best?.id === "labyrinth";
  const subject = redPillRouteChosen && view.ownsRedPill ? `${RED_PILL}` : `${best?.id} route`;

  const why = best
    ? best.complete
      ? `${subject} is complete — the node can be ended now`
      : `${subject}: ${best.blocker}`
    : "no endgame route is available in this BitNode";

  return { routes, best, worldDaemonSkill: wdSkill, awaitingRegrow, why };
}

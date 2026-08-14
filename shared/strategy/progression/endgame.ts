import { bitNodeMultipliers, worldDaemonSkill } from "../../features/bitnode.ts";
import { formatMoney, formatScientific } from "../../format.ts";

/** How a BitNode actually ends, and what is still missing.
 *
 * Split from ./decide.ts because that file answers "when do I install", a
 * question about the reset LOOP. This one answers "how does the loop stop",
 * which turns out not to be a single path — and hard-coding the obvious one is
 * the mistake it exists to prevent.
 *
 * Four routes reach the same place (`enterBitNode`), and they share almost no
 * prerequisites:
 *
 *  - **Daedalus** — 30 augs (node-dependent), $100b, hacking 2500 or combat
 *    1500, then 2,500,000 reputation for The Red Pill.
 *  - **Gang** — in BN2, create a gang and earn 2,500,000 gang-faction
 *    reputation for The Red Pill.
 *  - **Darknet labyrinth** — the lab reward sequence ends in The Red Pill in
 *    every node whose `DarknetLabyrinthRewardsTheRedPill` is non-zero, which
 *    is every node except BN8. Needs the dark web, so BN15 or SF15.
 *  - **Bladeburner** — completing ALL black operations satisfies
 *    `ns.singularity.destroyW0r1dD43m0n` on its own, with no Red Pill and no
 *    hacking requirement whatsoever. Operation Daedalus, the last one, needs
 *    rank 400,000.
 *
 * The three Red Pill routes converge on one more step that is easy to miss and
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
export const GANG_KARMA = -54_000;
export const GANG_FACTIONS = [
  "Slum Snakes",
  "Tetrads",
  "The Syndicate",
  "The Dark Army",
  "Speakers for the Dead",
  "NiteSec",
  "The Black Hand",
] as const;
/** Once this fraction of Daedalus's installed-count gate is permanent, begin
 * consolidating resets into substantial partial batches. A reset in this region must cover the
 * fraction below of what remained at cycle start; this rejects a late 20->23
 * or 14->16 style reset without forcing an economically explosive transaction
 * during the first third of the gate. Both are ratios of the live node
 * requirement, never a BN1 count. */
export const DAEDALUS_FINAL_BATCH_FRACTION = 1 / 3;
export const DAEDALUS_LATE_BATCH_PROGRESS_FRACTION = 1 / 2;
/** In the closing quarter, another partial reset only creates another cold
 * bootstrap before the same discrete gate. Finish the remaining unique slots
 * in one transaction so execution matches the route ETA's final package. */
export const DAEDALUS_GATE_CLOSING_FRACTION = 3 / 4;

export type RouteId = "daedalus" | "gang" | "labyrinth" | "bladeburner";

/** Installed in this order. The Red Pill replaces the next reward after four
 * stages in BN15 and follows all six stages elsewhere. These names are game
 * mechanics, not a BitNode strategy policy. */
export const LABYRINTH_AUGMENTATIONS = [
  "The W1ngs of Icarus",
  "The B00ts of Perseus",
  "The H4mmer of Daedalus",
  "The St4ff of Asclepius",
  "The L4w of Bayes",
  "The B1ade of Solomonoff",
] as const;
export const LABYRINTH_CHARISMA = [300, 600, 1_500, 2_500, 3_000, 3_500, 4_000] as const;

export type RouteNeedKind =
  | "money"
  | "karma"
  | "skill"
  | "combatSkills"
  | "charisma"
  | "factionRep"
  | "root"
  | "bladeburnerRank"
  | "augCount";

/** Outcome requested by the high-level route. Feature planners decide how to
 * produce it; no method (crime, university, faction work, etc.) appears here. */
export interface RouteNeed {
  kind: RouteNeedKind;
  subject?: string;
  target: number;
  have: number;
  why: string;
}

export interface MandatoryInstall {
  augmentation: string;
  /** True once the route reward/gate contribution is already queued. */
  ready: boolean;
  why: string;
}

export interface OptionalInstallPolicy {
  allowed: boolean;
  why: string;
}

export interface EndgameView {
  bitNode: number | undefined;
  /** SF12 level, which is the only thing that moves BN12's requirements. */
  sf12Level?: number;
  /** Active source-file levels, SF n -> level. */
  sourceFiles: Record<string, number>;
  augCount: number;
  /** Installed augmentation names/levels and this cycle's projected queue.
   * The latter includes end-loaded faction commitments whose reputation is
   * banked but whose purchase is deliberately deferred to the transaction
   * boundary. They advance no ownership/multiplier checks; they only make a
   * route-mandatory reset actionable. The labyrinth still advances solely
   * from installed rewards. */
  installedAugs?: Record<string, number>;
  queuedAugs?: string[];
  ownsRedPill: boolean;
  /** True once an install has happened while owning the pill — i.e. the
   *  world daemon is actually in the network graph. */
  redPillInstalled: boolean;
  /** destroyW0r1dD43m0n also requires admin rights on the daemon. Fleet
   * upkeep normally supplies this immediately after the pill exposes it. */
  worldDaemonRooted: boolean;
  money: number;
  hackingSkill: number;
  /** Lowest of the four combat skills, for Daedalus's alternative branch. */
  lowestCombatSkill: number;
  daedalusRep: number;
  /** BN2 gang route state. `gangAvailable` means the mechanic is allowed even
   * before a gang has been created. */
  gangAvailable?: boolean;
  inGang?: boolean;
  gangFaction?: string;
  gangFactionRep?: number;
  karma?: number;
  /** An already-joined eligible faction with which gang.createGang can run. */
  gangCreateFaction?: string;
  /** Bladeburner access is distinct from current membership. */
  bladeburnerAvailable?: boolean;
  /** Full darknet access, including the DarkscapeNavigator.exe path. */
  darknetAvailable?: boolean;
  /** Whether the controller can carry out labyrinth traversal. Mechanical
   * availability and executable automation are intentionally distinct. */
  labyrinthAutomationAvailable?: boolean;
  inBladeburner: boolean;
  charismaSkill?: number;
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
  /** False when mechanics permit the route but this controller cannot yet
   * execute it. Such a route is still estimated and reported, but not picked. */
  actionable?: boolean;
  /** Every requirement met — the node can be ended right now. */
  complete: boolean;
  /** The single next thing this route is waiting on. */
  blocker: string;
  /** Stable machine-readable phase for forecasts and consumers. */
  stage: string;
  needs: RouteNeed[];
  /** The next reset that route mechanics require, if one is visible now. */
  mandatoryInstall?: MandatoryInstall;
  /** Whether an economic reset may interrupt this route stage. Mandatory
   * installs always bypass this policy. */
  optionalInstall: OptionalInstallPolicy;
}

export interface EndgameDecision {
  routes: RouteStatus[];
  /** The route closest to completion that is actually available. */
  best: RouteStatus | undefined;
  /** Hacking level w0r1d_d43m0n needs here, or undefined if the node is
   *  unknown. All three Red Pill routes end here. */
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

function hasInstalled(view: EndgameView, name: string): boolean {
  return (view.installedAugs?.[name] ?? 0) > 0;
}

function isQueued(view: EndgameView, name: string): boolean {
  return view.queuedAugs?.includes(name) ?? false;
}

/** The reward which must be installed to advance the current labyrinth. */
export function nextLabyrinthReward(view: EndgameView): string {
  const prerequisiteCount = view.bitNode === 15 ? 4 : LABYRINTH_AUGMENTATIONS.length;
  for (let index = 0; index < prerequisiteCount; index++) {
    const name = LABYRINTH_AUGMENTATIONS[index]!;
    if (!hasInstalled(view, name)) return name;
  }
  return RED_PILL;
}

export function labyrinthStageIndex(view: EndgameView): number {
  const reward = nextLabyrinthReward(view);
  return reward === RED_PILL
    ? (view.bitNode === 15 ? 4 : LABYRINTH_AUGMENTATIONS.length)
    : LABYRINTH_AUGMENTATIONS.indexOf(reward as (typeof LABYRINTH_AUGMENTATIONS)[number]);
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

  // Shared tail of all three Red Pill routes. Owning the pill is not enough: the
  // link is created on install, and the install resets the skill.
  // `optionalInstall` is part of the tail's own policy: the post-Red-Pill
  // regrow is erased by any further reset, and that is true on whichever route
  // produced the pill. Owning it here keeps the three call sites from drifting.
  const redPillTail = (): { complete: boolean; blocker: string; stage: string; needs: RouteNeed[]; mandatoryInstall?: MandatoryInstall; optionalInstall?: OptionalInstallPolicy } => {
    if (!view.ownsRedPill) return { complete: false, blocker: `acquire ${RED_PILL}`, stage: "red-pill", needs: [] };
    if (!view.redPillInstalled) {
      return {
        complete: false,
        blocker: `install ${RED_PILL} (creates the w0r1d_d43m0n link)`,
        stage: "red-pill-install",
        needs: [],
        mandatoryInstall: { augmentation: RED_PILL, ready: isQueued(view, RED_PILL) || view.ownsRedPill, why: "installing The Red Pill creates the world-daemon link" },
      };
    }
    if (!hasWorldDaemonSkill) {
      return {
        complete: false,
        blocker: `hacking ${view.hackingSkill} of ${wdSkill ?? "?"} after the install`,
        stage: "world-daemon-regrow",
        needs: wdSkill === undefined ? [] : [{ kind: "skill", subject: "hacking", target: wdSkill, have: view.hackingSkill, why: "root the world daemon after the Red Pill install" }],
        optionalInstall: { allowed: false, why: "another reset would erase the post-Red-Pill hacking regrow" },
      };
    }
    if (!view.worldDaemonRooted) {
      return {
        complete: false,
        blocker: "root w0r1d_d43m0n",
        stage: "world-daemon-root",
        needs: [{
          kind: "root",
          subject: "w0r1d_d43m0n",
          target: 1,
          have: 0,
          why: "acquire the port openers required to root the world daemon",
        }],
        optionalInstall: { allowed: false, why: "another reset would erase the post-Red-Pill hacking regrow" },
      };
    }
    return { complete: true, blocker: "", stage: "complete", needs: [] };
  };

  const routes: RouteStatus[] = [];

  // All three Red Pill routes are ACQUISITION strategies sharing one tail. Once the
  // pill is owned it no longer matters which one produced it, so the tail
  // takes over completely — continuing to report "Daedalus reputation 0 of
  // 2.5e6" for a player holding the pill would be nonsense, and would make a
  // labyrinth run look permanently blocked on a faction it never needed.
  const tail = redPillTail();

  // --- Daedalus -----------------------------------------------------------
  {
    const available = augsNeeded !== undefined && view.bitNode !== 15;
    const meetsSkills =
      view.hackingSkill >= DAEDALUS_HACKING || view.lowestCombatSkill >= DAEDALUS_COMBAT;
    let blocker: string;
    let stage = "invite";
    const needs: RouteNeed[] = [];
    let mandatoryInstall: MandatoryInstall | undefined;
    let optionalInstall: OptionalInstallPolicy = {
      allowed: true,
      why: "augmentation installs can accelerate the invitation gates",
    };
    if (augsNeeded === undefined) blocker = "BitNode unknown";
    else if (!available) blocker = "Daedalus does not offer The Red Pill in BN15";
    else if (view.ownsRedPill) {
      blocker = tail.blocker;
      stage = tail.stage;
      needs.push(...tail.needs);
      mandatoryInstall = tail.mandatoryInstall;
    }
    else if (view.augCount < augsNeeded) {
      blocker = `${view.augCount} of ${augsNeeded} augmentations`;
      needs.push({ kind: "augCount", target: augsNeeded, have: view.augCount, why: "Daedalus invitation requirement" });
      const queuedUnique = new Set((view.queuedAugs ?? []).filter((name) => name !== "NeuroFlux Governor" || !hasInstalled(view, name))).size;
      if (view.augCount + queuedUnique >= augsNeeded && queuedUnique > 0) {
        mandatoryInstall = { augmentation: "augmentation-count package", ready: true, why: "installing the current queue satisfies the route's installed-augmentation gate" };
      }
      const remainingAtCycleStart = augsNeeded - view.augCount;
      // Judge consolidation by where the cycle STARTED, not merely where a
      // substantial batch would land. A 13 -> 23 install is qualitatively
      // different from the pathological 20 -> 23 install: the former banks
      // more than half the outstanding gate while the latter pays a cold
      // bootstrap for three of ten slots. Before the closing quarter require a
      // half-remaining tranche; after entering it, require complete closure.
      // This keeps the policy node-relative without making the affordable
      // middle-batch window disappear as soon as its projection crosses 3/4.
      const alreadyClosing = view.augCount
        >= Math.ceil(augsNeeded * DAEDALUS_GATE_CLOSING_FRACTION);
      const minimumBatch = alreadyClosing
        ? remainingAtCycleStart
        : Math.ceil(remainingAtCycleStart * DAEDALUS_LATE_BATCH_PROGRESS_FRACTION);
      if (
        view.augCount >= Math.ceil(augsNeeded * DAEDALUS_FINAL_BATCH_FRACTION)
        && queuedUnique < minimumBatch
        && !mandatoryInstall?.ready
      ) {
        optionalInstall = {
          allowed: false,
          why: `the installed count is at ${view.augCount} of ${augsNeeded}; bank at least ${minimumBatch} of the remaining ${remainingAtCycleStart} unique augmentations before paying another reset`,
        };
      }
    }
    else if (view.money < DAEDALUS_MONEY) {
      blocker = `${formatMoney(view.money)} of ${formatMoney(DAEDALUS_MONEY)}`;
      needs.push({ kind: "money", target: DAEDALUS_MONEY, have: view.money, why: "Daedalus invitation requirement" });
    }
    else if (!meetsSkills) {
      blocker = `hacking ${DAEDALUS_HACKING} or combat ${DAEDALUS_COMBAT}`;
      const hackSec = Math.max(0, DAEDALUS_HACKING - view.hackingSkill) * 3;
      const combatSec = Math.max(0, DAEDALUS_COMBAT - view.lowestCombatSkill) * 6;
      needs.push(hackSec <= combatSec
        ? { kind: "skill", subject: "hacking", target: DAEDALUS_HACKING, have: view.hackingSkill, why: "faster branch of the Daedalus skill requirement" }
        : { kind: "combatSkills", target: DAEDALUS_COMBAT, have: view.lowestCombatSkill, why: "faster branch of the Daedalus skill requirement" });
    }
    else if (view.daedalusRep < RED_PILL_REP) {
      blocker = `Daedalus reputation ${formatScientific(view.daedalusRep)} of ${formatScientific(RED_PILL_REP)}`;
      stage = "red-pill-reputation";
      needs.push({ kind: "factionRep", subject: "Daedalus", target: RED_PILL_REP, have: view.daedalusRep, why: "buy The Red Pill" });
      optionalInstall = {
        allowed: true,
        why: "the cadence verdict prices erased reputation against banked favor and activated multipliers",
      };
    } else {
      // End-loading means a reputation-complete Red Pill can be committed in
      // the projected queue without being owned yet.  That is not an optional
      // economic reset: the transaction which buys it and installs it is the
      // route's next mechanical step.  Treating it as optional lets the
      // short-node payback guard veto the only path to completion.
      const pillCommitted = isQueued(view, RED_PILL);
      blocker = pillCommitted
        ? `purchase and install ${RED_PILL} (creates the w0r1d_d43m0n link)`
        : tail.blocker;
      stage = pillCommitted ? "red-pill-install" : tail.stage;
      needs.push(...tail.needs);
      mandatoryInstall = pillCommitted
        ? { augmentation: RED_PILL, ready: true, why: "buying the banked Red Pill and installing it creates the world-daemon link" }
        : tail.mandatoryInstall;
    }
    routes.push({
      id: "daedalus",
      available,
      complete: available && tail.complete,
      blocker,
      stage,
      needs,
      ...(mandatoryInstall ? { mandatoryInstall } : {}),
      optionalInstall: (stage === tail.stage ? tail.optionalInstall : undefined) ?? optionalInstall,
    });
  }

  // --- BN2 gang ----------------------------------------------------------
  {
    const available = view.gangAvailable ?? view.bitNode === 2;
    const rep = view.gangFactionRep ?? 0;
    let blocker = "gang route unavailable";
    let stage = "gang-create";
    const needs: RouteNeed[] = [];
    let mandatoryInstall: MandatoryInstall | undefined;
    if (available) {
      if (view.ownsRedPill) {
        blocker = tail.blocker;
        stage = tail.stage;
        needs.push(...tail.needs);
        mandatoryInstall = tail.mandatoryInstall;
      } else if (!view.inGang) {
        blocker = view.karma !== undefined && view.karma > GANG_KARMA
          ? `karma ${view.karma} of ${GANG_KARMA}`
          : view.gangCreateFaction
            ? `create a gang with ${view.gangCreateFaction}`
            : "join an eligible gang faction";
        if (view.karma !== undefined && view.karma > GANG_KARMA) {
          needs.push({ kind: "karma", target: GANG_KARMA, have: view.karma, why: "create the BN2 gang" });
        }
      } else if (rep < RED_PILL_REP) {
        blocker = `${view.gangFaction ?? "gang faction"} reputation ${formatScientific(rep)} of ${formatScientific(RED_PILL_REP)}`;
        stage = "gang-reputation";
        needs.push({ kind: "factionRep", subject: view.gangFaction ?? "gang faction", target: RED_PILL_REP, have: rep, why: "buy the BN2 gang's Red Pill" });
      } else {
        const pillCommitted = isQueued(view, RED_PILL);
        blocker = pillCommitted
          ? `purchase and install ${RED_PILL} from ${view.gangFaction ?? "the gang faction"}`
          : `acquire ${RED_PILL} from ${view.gangFaction ?? "the gang faction"}`;
        stage = pillCommitted ? "red-pill-install" : "red-pill";
        if (pillCommitted) {
          mandatoryInstall = {
            augmentation: RED_PILL,
            ready: true,
            why: "buying the banked gang Red Pill and installing it creates the world-daemon link",
          };
        }
      }
    }
    routes.push({
      id: "gang",
      available,
      complete: available && tail.complete,
      blocker,
      stage,
      needs,
      ...(mandatoryInstall ? { mandatoryInstall } : {}),
      optionalInstall: (stage === tail.stage ? tail.optionalInstall : undefined)
        ?? (stage === "gang-reputation"
          ? { allowed: true, why: "the gang survives; cadence prices lost faction rep against favor and installed multipliers" }
          : { allowed: true, why: "no route progress would be erased" }),
    });
  }

  // --- Darknet labyrinth --------------------------------------------------
  {
    const available =
      labyrinthOffersRedPill(view.bitNode, sf12)
      && (view.darknetAvailable ?? (view.bitNode === 15 || sf(view, 15) > 0));
    const reward = nextLabyrinthReward(view);
    const stageIndex = labyrinthStageIndex(view);
    const queuedReward = isQueued(view, reward) || (reward === RED_PILL && view.ownsRedPill && !view.redPillInstalled);
    const needs: RouteNeed[] = [];
    const requiredCharisma = LABYRINTH_CHARISMA[Math.min(stageIndex, LABYRINTH_CHARISMA.length - 1)]!;
    if (available && !view.ownsRedPill && !queuedReward && (view.charismaSkill ?? 0) < requiredCharisma) {
      needs.push({ kind: "charisma", target: requiredCharisma, have: view.charismaSkill ?? 0, why: `enter labyrinth stage ${stageIndex + 1}` });
    }
    const mandatoryInstall = available && !view.redPillInstalled && queuedReward
      ? { augmentation: reward, ready: true, why: reward === RED_PILL ? "installing The Red Pill creates the world-daemon link" : "the next labyrinth is selected from installed rewards" }
      : view.ownsRedPill ? tail.mandatoryInstall : undefined;
    routes.push({
      id: "labyrinth",
      available,
      actionable: view.labyrinthAutomationAvailable !== false || view.ownsRedPill,
      complete: available && tail.complete,
      blocker: !available
        ? view.bitNode === 8
          ? "BN8 disables the labyrinth's Red Pill"
          : "requires BN15 or SF15 for dark web access"
        : view.ownsRedPill
          ? tail.blocker
          : queuedReward
            ? `install ${reward} to unlock the next labyrinth`
            : `complete labyrinth stage ${stageIndex + 1} for ${reward}`,
      stage: view.ownsRedPill ? tail.stage : queuedReward ? "labyrinth-install" : `labyrinth-${stageIndex + 1}`,
      needs: view.ownsRedPill ? tail.needs : needs,
      ...(mandatoryInstall ? { mandatoryInstall } : {}),
      optionalInstall: (view.ownsRedPill ? tail.optionalInstall : undefined) ?? {
        allowed: false,
        why: "labyrinth progress advances only through its route-mandatory reward installs",
      },
    });
  }

  // --- Bladeburner --------------------------------------------------------
  {
    // No Red Pill and no hacking requirement: all black ops is sufficient on
    // its own, which is why this route is checked independently rather than
    // as a variation of the others.
    const available = view.bladeburnerAvailable ?? view.inBladeburner;
    const complete = view.inBladeburner && (view.blackOpsComplete ?? 0) >= BLACK_OP_COUNT;
    const needs: RouteNeed[] = [];
    if (available && !view.inBladeburner && view.lowestCombatSkill < 100) {
      needs.push({ kind: "combatSkills", target: 100, have: view.lowestCombatSkill, why: "join the Bladeburner division" });
    } else if (available && view.inBladeburner && !complete) {
      needs.push({ kind: "bladeburnerRank", target: BLACK_OP_FINAL_RANK, have: view.bladeburnerRank ?? 0, why: "unlock the final Black Op" });
    }
    routes.push({
      id: "bladeburner",
      available,
      complete,
      blocker: !available
        ? "Bladeburner access is unavailable"
        : !view.inBladeburner
        ? "not in the Bladeburner division"
        : complete
          ? ""
          : `${view.blackOpsComplete ?? "?"} of ${BLACK_OP_COUNT} black operations`,
      stage: complete ? "complete" : view.inBladeburner ? "black-operations" : "bladeburner-join",
      needs,
      optionalInstall: {
        allowed: true,
        why: "Bladeburner rank and completed Black Ops survive augmentation installs",
      },
    });
  }

  // `actionable` marks a route the controller cannot yet DRIVE, not one the
  // node forbids. Preferring an actionable route is right; publishing no route
  // at all is not — BN15 excludes Daedalus and the labyrinth is its only Red
  // Pill source, so filtering on automation alone would leave that run with no
  // plan, no gate needs and an "undefined route" why-string. Fall back to the
  // mechanically available route so the gates still publish.
  const availableRoutes = routes.filter((route) => route.available);
  const usable = availableRoutes.filter((route) => route.actionable !== false);
  const preferred = usable.length > 0 ? usable : availableRoutes;
  const best = preferred.find((route) => route.complete) ?? preferred[0];

  const awaitingRegrow = view.ownsRedPill && view.redPillInstalled && !hasWorldDaemonSkill;

  // Once the pill is owned, all three acquisition routes are the same remaining
  // work and both report the shared tail — so naming one of them would invent
  // a history. A labyrinth run must not be told it finished "the daedalus
  // route". Bladeburner is unaffected: it never touches the pill.
  const redPillRouteChosen = best?.id === "daedalus" || best?.id === "gang" || best?.id === "labyrinth";
  const subject = redPillRouteChosen && view.ownsRedPill ? `${RED_PILL}` : `${best?.id} route`;

  const why = best
    ? best.complete
      ? `${subject} is complete — the node can be ended now`
      : `${subject}: ${best.blocker}`
    : "no endgame route is available in this BitNode";

  return { routes, best, worldDaemonSkill: wdSkill, awaitingRegrow, why };
}

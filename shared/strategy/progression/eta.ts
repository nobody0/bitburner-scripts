import {
  BLACK_OP_COUNT,
  BLACK_OP_FINAL_RANK,
  DAEDALUS_COMBAT,
  DAEDALUS_HACKING,
  DAEDALUS_MONEY,
  RED_PILL_REP,
  daedalusAugsRequired,
  labyrinthStageIndex,
  LABYRINTH_AUGMENTATIONS,
  type EndgameDecision,
  type EndgameView,
  type RouteNeed,
  type RouteId,
} from "./endgame.ts";
import { cycleProgressEtaWithPrior, type CyclePoint, type CurveResource } from "./regrowth.ts";
import { expForSkill } from "../../formulas.ts";

/** Per-route time-to-finish HEURISTICS, and the route choice built on them.
 *
 * Nothing here is a measured constant. Every figure is an estimate computed
 * NOW from the current game state and the rates the progression driver has
 * observed this run — always computable, never "unknown". The telemetry log
 * records the estimate next to its per-part breakdown and, at the node reset,
 * the actual elapsed time; that closes two separate feedback loops:
 *
 *  1. CALIBRATION — predicted vs actual, per part, tunes these formulas and
 *     fallback constants.
 *  2. OPTIMIZATION — a part that is honestly slow is a feature to improve,
 *     which changes the game, not this file.
 *
 * The fallback constants answer "we have no measured rate yet". They are
 * deliberately pessimistic and FINITE: an Infinity here would annihilate a
 * route from the comparison entirely (the same class of bug as the unworkable
 * -faction ETA that emptied the whole factions objective — see
 * spec/progress.md), when the honest statement is "probably slow, still a
 * route". */

// --- fallback rates (heuristic v1 — tuned from runs/*.jsonl) ----------------

/** Seconds per augmentation acquired, when no acquisition rate is measured. */
export const FALLBACK_SEC_PER_AUG = 1_800;
/** Money per second, when no income rate is measured. */
export const FALLBACK_MONEY_PER_SEC = 250_000;
/** Seconds per hacking level, when no growth rate is measured. */
export const FALLBACK_SEC_PER_HACK_LEVEL = 3;
/** Seconds per combat level (lowest of the four), when unmeasured. */
export const FALLBACK_SEC_PER_COMBAT_LEVEL = 6;
/** Daedalus reputation per second, when not currently working for them. */
export const FALLBACK_DAEDALUS_REP_PER_SEC = 50;
/** Seconds per black operation, when no completion rate is measured. */
export const FALLBACK_SEC_PER_BLACK_OP = 3_600;
/** Bladeburner rank per second, when no growth rate is measured. */
export const FALLBACK_RANK_PER_SEC = 5;
/** Gang-faction reputation per second before a measured signal exists. */
export const FALLBACK_GANG_REP_PER_SEC = 50;
/** Creating/joining a gang is a bounded route prerequisite whose detailed
 * faction/karma work is delegated through needs. */
export const FALLBACK_GANG_START_SEC = 3_600;
/** The labyrinth walk itself. The mechanic is simulated, but this route
 * fallback has not yet been calibrated from completed walks. */
export const LABYRINTH_WALK_SEC = 7_200;
/** Install + requeue overhead around the Red Pill install. */
export const INSTALL_OVERHEAD_SEC = 300;
/** The post-install climb is faster than the first one (the installed
 *  augmentations are exactly what the run just bought), so the regrow is
 *  discounted rather than priced at the pre-install rate. */
export const REGROW_DISCOUNT = 0.5;

/** Observed per-second rates, measured by the progression driver over this
 * run. Zero or negative means "no signal yet" and selects the fallback. */
export interface RouteRates {
  moneyPerSec: number;
  hackingSkillPerSec: number;
  combatSkillPerSec: number;
  augsPerSec: number;
  daedalusRepPerSec: number;
  gangRepPerSec: number;
  blackOpsPerSec: number;
  bladeburnerRankPerSec: number;
  /** Current hacking experience, for closed-form climb pricing. */
  hackingExp?: number;
  /** Measured hacking experience per second. The skill curve is exactly
   * level = mult * (32*ln(exp + 534.6) - 200), so with an exp rate the time to
   * any level is computable in closed form — extrapolating the LEVEL rate
   * instead systematically underprices high targets (measured: the regrow leg
   * priced 2.6h at 3.5h into a run whose real regrow took 13.8h, collapsing
   * the hacking channel's worth exactly when augmentations were chosen). */
  hackingExpPerSec?: number;
  /** Effective live hacking skill multiplier (player mult x node mult). */
  hackingSkillMult?: number;
  /** Hacking power still on the shelf: per-augmentation ln-multipliers of
   * every unowned catalogue augmentation carrying hacking skill/exp mults,
   * sorted strongest-first. Lets a climb leg price "assemble the best k, then
   * climb" as a real plan and choose k itself. */
  hackingCatalog?: { augs: readonly { skillLn: number; expLn: number }[] };
  /** Formula-projected Daedalus work rep/sec at the invite gate, for pricing
   * the reputation leg before any Daedalus work has been measured. Derived by
   * the driver from the transcribed rep formulas; never a live measurement. */
  daedalusRepPerSecProjected?: number;
  /** Reputation still to EARN at Daedalus (over current rep and favor) for
   * favor to cross the donation threshold at the next install. 0 when the
   * earned total already crosses it. */
  daedalusDonateUnlockRepGap?: number;
  /** Dollars per reputation point when donating to Daedalus. */
  daedalusDonationDollarsPerRep?: number;
  /** Favor is already past the donation threshold right now. */
  daedalusDonationUnlocked?: boolean;
  /** Direct stat-multiplier gain already committed to the next end-loaded
   * install. It changes the experience needed for a post-prestige level; the
   * benefit is forecast only and never applied to live progress. */
  postInstallHackingSkillMult: number;
  postInstallCombatSkillMult: number;
  /** Fresh-cycle cumulative curve. A prior completed cycle is supplied during
   * the sparse opening minutes after prestige. */
  cycle?: {
    points: readonly CyclePoint[];
    elapsedSec: number;
    /** Last completed prestige cycle. It anchors sparse fresh-cycle samples;
     * current observations scale it and eventually replace it. */
    priorPoints?: readonly CyclePoint[];
  };
}
export function noRates(): RouteRates {
  return {
    moneyPerSec: 0,
    hackingSkillPerSec: 0,
    combatSkillPerSec: 0,
    augsPerSec: 0,
    daedalusRepPerSec: 0,
    gangRepPerSec: 0,
    blackOpsPerSec: 0,
    bladeburnerRankPerSec: 0,
    postInstallHackingSkillMult: 1,
    postInstallCombatSkillMult: 1,
  };
}

/** One additive component of a route's estimate. `measured` marks whether the
 * figure came from an observed rate or a fallback constant — the calibration
 * loop needs to know which formula produced the error. */
export interface EtaPart {
  what: string;
  /** Machine-readable resource behind the diagnostic label. Consumers such
   * as the Go reward selector must not infer strategy from UI prose. */
  resource: ProgressResource;
  sec: number;
  measured: boolean;
  /** A required AND-parallel leg masked behind a slower sibling. It does not
   * add to the route total (the sibling's window covers it), but it is real
   * future work in its resource: the marginals price it so a dependency
   * hidden behind a parallel maximum is never worth zero. Measured without
   * this: the invite money gate masked the hacking climb and the hacking
   * channel's worth collapsed 80x exactly when augmentations were chosen. */
  hidden?: boolean;
}

export type ProgressResource =
  | "augmentations"
  | "money"
  | "hacking"
  | "reputation"
  | "combat"
  | "install"
  | "other";

export interface RouteEta {
  id: RouteId;
  available: boolean;
  actionable?: boolean;
  complete: boolean;
  etaSec: number;
  parts: EtaPart[];
  stage?: string;
  needs?: RouteNeed[];
  /** Time until the next reset required by route mechanics. Optional means no
   * route-mandatory reset is currently predictable; economic cadence may
   * still choose an earlier install. */
  nextMandatoryInstall?: { sec: number; measured: boolean };
}

function curvePart(
  what: string,
  resource: CurveResource,
  targetProgress: number,
  fallbackSec: number,
  rates: RouteRates,
  remaining = false,
): EtaPart {
  const curve = rates.cycle;
  if (!curve) return { what, resource, sec: fallbackSec, measured: false };
  const estimate = cycleProgressEtaWithPrior(
    curve.points,
    curve.priorPoints,
    resource,
    targetProgress,
    fallbackSec,
  );
  return {
    what,
    resource,
    // `elapsedSec` may only be subtracted from a MEASURED estimate, which is
    // cumulative from cycle start. The unmeasured branch returns `fallbackSec`
    // verbatim, and every caller passing `remaining` supplies that fallback as
    // a remaining-time figure already — subtracting again would drag an
    // unmeasured part to 0 s simply because the cycle has been running a while,
    // and a 0 s gate collapses the whole node forecast.
    sec: Math.max(0, estimate.sec - (remaining && estimate.measured ? curve.elapsedSec : 0)),
    measured: estimate.measured,
  };
}

function part(
  what: string,
  resource: ProgressResource,
  gap: number,
  ratePerSec: number,
  fallbackRatePerSec: number,
): EtaPart {
  if (gap <= 0) return { what, resource, sec: 0, measured: true };
  const measured = ratePerSec > 0;
  const rate = measured ? ratePerSec : fallbackRatePerSec;
  return { what, resource, sec: gap / rate, measured };
}

function total(parts: EtaPart[]): number {
  return parts.reduce((sum, entry) => sum + (entry.hidden ? 0 : entry.sec), 0);
}

function moneyGatePart(view: EndgameView, rates: RouteRates, afterReset: boolean): EtaPart {
  const gap = afterReset ? DAEDALUS_MONEY : Math.max(0, DAEDALUS_MONEY - view.money);
  const fallback = gap / (rates.moneyPerSec > 0 ? rates.moneyPerSec : FALLBACK_MONEY_PER_SEC);
  const latestEarned = rates.cycle?.points.at(-1)?.money ?? 0;
  return curvePart(
    "money",
    "money",
    afterReset ? DAEDALUS_MONEY : latestEarned + gap,
    fallback,
    rates,
    !afterReset,
  );
}

/** The shared tail of all three Red Pill routes: install the pill, then climb back
 * to the world-daemon level after the reset wiped hacking to 1. */
function redPillTail(view: EndgameView, wdSkill: number | undefined, rates: RouteRates, deepFuture = false): EtaPart[] {
  const parts: EtaPart[] = [];
  const skill = wdSkill ?? 3000;
  if (!view.redPillInstalled) {
    parts.push({ what: "install", resource: "install", sec: INSTALL_OVERHEAD_SEC, measured: false });
    parts.push(...postInstallRegrow(skill, rates, deepFuture));
  } else if (view.hackingSkill < skill) {
    parts.push(part("regrow", "hacking", skill - view.hackingSkill, rates.hackingSkillPerSec, 1 / FALLBACK_SEC_PER_HACK_LEVEL));
  } else if (!view.worldDaemonRooted) {
    // Fleet upkeep performs this as soon as the five port openers and daemon
    // are visible. It is short, but it is a real destroy-API precondition.
    parts.push({ what: "root world daemon", resource: "other", sec: 1, measured: false });
  }
  return parts;
}

/** The post-Red-Pill regrow guard ("never reset again") protects a SHORT
 * tail. When the remaining climb to the daemon's destroy gate is LONGER than
 * installing the queued augmentations and re-climbing with their multipliers,
 * the guard inverts: the reset IS the fastest path to the gate. Both paths are
 * compared in measured seconds rather than either being hardcoded.
 *
 * Returns true when the guard should be overridden; false when it stands. */
export function regrowInstallOverride(input: {
  /** Route stage; only "world-daemon-regrow" carries this guard. */
  stage?: string;
  /** The guard's own verdict. Only a REFUSAL can be overridden. */
  optionalInstallAllowed?: boolean;
  /** Hacking skill the daemon's destroy gate requires. */
  worldDaemonSkill?: number;
  hackingSkill: number;
  rates: RouteRates;
}): boolean {
  const gate = input.worldDaemonSkill;
  if (
    input.optionalInstallAllowed !== false
    || input.stage !== "world-daemon-regrow"
    || gate === undefined
    || input.hackingSkill >= gate
    || input.rates.hackingSkillPerSec <= 0
  ) {
    return false;
  }
  const remainNowSec = (gate - input.hackingSkill) / input.rates.hackingSkillPerSec;
  const remainAfterSec = INSTALL_OVERHEAD_SEC
    + postInstallRegrow(gate, input.rates).reduce((sum, part) => sum + part.sec, 0);
  return remainAfterSec < remainNowSec;
}

/** Closed-form time to a hacking level from the exact skill curve and a
 * measured experience rate. Returns undefined without that evidence. */
function hackingClimbSec(
  targetLevel: number,
  startExp: number,
  effectiveMult: number,
  rates: RouteRates,
): number | undefined {
  const expRate = rates.hackingExpPerSec;
  if (expRate === undefined || !(expRate > 0) || !(effectiveMult > 0)) return undefined;
  const needed = Math.max(0, expForSkill(Math.ceil(targetLevel), effectiveMult) - Math.max(0, startExp));
  return needed / expRate;
}

/** "Assemble the best k hacking augmentations, then climb" — the minimum over
 * k of acquisition plus the closed-form climb with that stack. Returns
 * undefined when the closed form has no evidence to price with. */
function stackedClimbPlan(
  targetLevel: number,
  startExp: number,
  baseMult: number,
  rates: RouteRates,
  label: string,
): EtaPart[] | undefined {
  const direct = hackingClimbSec(targetLevel, startExp, baseMult, rates);
  if (direct === undefined) return undefined;
  const catalog = rates.hackingCatalog;
  const baseExpRate = rates.hackingExpPerSec ?? 0;
  if (catalog && catalog.augs.length > 0 && baseExpRate > 0) {
    const secPerAug = 1 / (rates.augsPerSec > 0 ? rates.augsPerSec : 1 / FALLBACK_SEC_PER_AUG);
    let best = { total: direct, k: 0, acquireSec: 0, climbSec: direct };
    let skillLnSum = 0;
    let expLnSum = 0;
    for (let k = 1; k <= catalog.augs.length; k++) {
      const entry = catalog.augs[k - 1]!;
      skillLnSum += entry.skillLn;
      expLnSum += entry.expLn;
      const acquireSec = k * secPerAug;
      if (acquireSec >= best.total) break;
      const climbSec = Math.max(0, expForSkill(Math.ceil(targetLevel), baseMult * Math.exp(skillLnSum)) - Math.max(0, startExp))
        / (baseExpRate * Math.exp(expLnSum));
      const totalSec = acquireSec + climbSec;
      if (totalSec < best.total) best = { total: totalSec, k, acquireSec, climbSec };
    }
    if (best.k > 0) {
      return [
        {
          what: `${label} multiplier stack (${best.k} augmentations)`,
          resource: "augmentations",
          sec: best.acquireSec,
          measured: rates.augsPerSec > 0,
        },
        { what: label, resource: "hacking", sec: best.climbSec, measured: true },
      ];
    }
  }
  return [{ what: label, resource: "hacking", sec: direct, measured: true }];
}

export function postInstallRegrow(skill: number, rates: RouteRates, deepFuture = false): EtaPart[] {
  // Prefer the exact curve when the multiplier stack at climb time is
  // actually KNOWN — the live multiplier plus this cycle's committed package.
  // A leg on the far side of a future install whose contents are not yet
  // chosen (deepFuture) must not be priced at today's multiplier: the curve
  // is exponential in 1/mult, so that produced a 2.1e30-hour "regrow" that
  // poisoned every downstream comparison, when the truthful statement is
  // "the stack that install buys is what makes this leg affordable".
  const committedMult = rates.hackingSkillMult !== undefined
    ? rates.hackingSkillMult * Math.max(1, rates.postInstallHackingSkillMult)
    : undefined;
  const closed = !deepFuture && committedMult !== undefined
    ? hackingClimbSec(skill, 0, committedMult, rates)
    : undefined;
  if (closed !== undefined && committedMult !== undefined) {
    // The climb with what we HAVE, versus assembling more of the hacking
    // catalogue first: the curve is exponential in 1/mult, so once the
    // current stack prices the climb in days, acquisition is the real plan.
    const plan = stackedClimbPlan(skill, 0, committedMult, rates, "regrow");
    if (plan) return plan;
  }
  const equivalentSkill = skill / Math.max(1, rates.postInstallHackingSkillMult);
  const rate = rates.hackingSkillPerSec > 0 ? rates.hackingSkillPerSec : 1 / FALLBACK_SEC_PER_HACK_LEVEL;
  return [curvePart("regrow", "hacking", equivalentSkill - 1, (equivalentSkill / rate) * REGROW_DISCOUNT, rates)];
}

/** Estimate every route from the current state. Pure; the decision supplies
 * availability/completeness, this adds time. */
export function routeEtas(view: EndgameView, decision: EndgameDecision, rates: RouteRates): RouteEta[] {
  const sf12 = view.sf12Level ?? Number(view.sourceFiles["12"] ?? 0);
  const wdSkill = decision.worldDaemonSkill;
  const out: RouteEta[] = [];

  for (const route of decision.routes) {
    const parts: EtaPart[] = [];
    let nextMandatoryInstall: RouteEta["nextMandatoryInstall"];
    // Most routes can publish their mechanical needs verbatim. Daedalus's
    // invitation is different: money AND one of two skill branches advance in
    // parallel, and choosing that branch requires the same measured curve the
    // ETA uses. Keep the executable priorities coupled to the forecast rather
    // than letting stepEndgame's rate-free fallback choose a different path.
    let needs = route.needs;

    // Availability is a mechanical gate. Do not spend the route budget
    // decomposing an impossible route; keep a finite zero diagnostic instead.
    if (!route.available) {
      out.push({ id: route.id, available: false, complete: false, etaSec: 0, parts, stage: route.stage, needs: route.needs });
      continue;
    }

    if (!route.complete) {
      if (route.id === "daedalus") {
        if (!view.ownsRedPill) {
          const augsNeeded = daedalusAugsRequired(view.bitNode, sf12) ?? 30;
          const installedNames = new Set(Object.keys(view.installedAugs ?? {}));
          const queuedUnique = new Set(
            // Multiple queued NeuroFlux levels collapse to one installed
            // augmentation object, so Set deliberately counts them once.
            (view.queuedAugs ?? []).filter((name) => !installedNames.has(name)),
          ).size;
          const acquired = Math.min(augsNeeded, view.augCount + queuedUnique);
          const countInstallPending = view.augCount < augsNeeded;

          if (countInstallPending) {
            // Queued unique augmentations have already been acquired; they do
            // not satisfy Daedalus until one install makes the batch permanent.
            const acquire = part(
              "final augmentation package",
              "augmentations",
              augsNeeded - acquired,
              rates.augsPerSec,
              1 / FALLBACK_SEC_PER_AUG,
            );
            parts.push(acquire);
            parts.push({ what: "install Daedalus count package", resource: "install", sec: INSTALL_OVERHEAD_SEC, measured: false });
            nextMandatoryInstall = { sec: acquire.sec, measured: acquire.measured };

            // Money and skills reset at that install, so progress made toward
            // those invitation branches before it cannot be credited twice.
            const afterReset: EndgameView = {
              ...view,
              money: 0,
              hackingSkill: 1,
              lowestCombatSkill: 1,
            };
            const postMoney = moneyGatePart(afterReset, rates, true);
            const postSkill = skillPart(afterReset, rates, true);
            const postSkillSec = postSkill.reduce((sum, part) => sum + part.sec, 0);
            if (postMoney.sec >= postSkillSec) {
              parts.push({ ...postMoney, what: `post-install invite gate (${postMoney.what})` });
              for (const gatePart of postSkill) {
                if (!(gatePart.sec > 0)) continue;
                parts.push({ ...gatePart, what: `post-install invite gate (${gatePart.what}, parallel)`, hidden: true });
              }
            } else {
              for (const gatePart of postSkill) {
                parts.push({ ...gatePart, what: `post-install invite gate (${gatePart.what})` });
              }
              if (postMoney.sec > 0) {
                parts.push({ ...postMoney, what: `post-install invite gate (${postMoney.what}, parallel)`, hidden: true });
              }
            }
          } else {
            // With the count gate already installed, money and the two skill
            // branches accrue in parallel from the live state.
            const skill = skillPart(view, rates);
            const skillSec = skill.reduce((sum, part) => sum + part.sec, 0);
            const liveMoney = moneyGatePart(view, rates, false);
            if (liveMoney.sec >= skillSec) {
              parts.push({ ...liveMoney, what: `invite gate (${liveMoney.what})` });
              for (const gatePart of skill) {
                if (!(gatePart.sec > 0)) continue;
                parts.push({ ...gatePart, what: `invite gate (${gatePart.what}, parallel)`, hidden: true });
              }
            } else {
              for (const gatePart of skill) {
                parts.push({ ...gatePart, what: `invite gate (${gatePart.what})` });
              }
              if (liveMoney.sec > 0) {
                parts.push({ ...liveMoney, what: `invite gate (${liveMoney.what}, parallel)`, hidden: true });
              }
            }

            const inviteNeeds: RouteNeed[] = [];
            if (view.money < DAEDALUS_MONEY) {
              inviteNeeds.push({ kind: "money", target: DAEDALUS_MONEY, have: view.money });
            }
            if (view.hackingSkill < DAEDALUS_HACKING && view.lowestCombatSkill < DAEDALUS_COMBAT) {
              inviteNeeds.push(skill[skill.length - 1]!.resource === "combat"
                ? { kind: "combatSkills", target: DAEDALUS_COMBAT, have: view.lowestCombatSkill }
                : { kind: "skill", subject: "hacking", target: DAEDALUS_HACKING, have: view.hackingSkill });
            }
            // Once both invitation gates are satisfied stepEndgame has already
            // advanced to Daedalus reputation, which remains sequential and
            // must be preserved unchanged.
            if (inviteNeeds.length > 0) needs = inviteNeeds;
          }
          // Reputation is sequential: it only starts once Daedalus invites.
          // Two ways to close it, priced against each other:
          //  - work: the measured rate once Daedalus work has started, else the
          //    formula-projected rate at the invite gate. The tracker is zero
          //    for the whole run before any Daedalus work exists, which left
          //    this leg at the flat fallback (2.5e6/50 = 13.9h — 36% of the
          //    entire route estimate on a cold BN1) and inflated the
          //    reputation channel's worth everywhere downstream.
          //  - donate: earn only the favor-unlock reputation, bank it at an
          //    install, then buy the requirement with money. Favor activates
          //    only at a reset, so one cycle overhead is charged unless the
          //    count install is already pending on this route.
          const repGap = RED_PILL_REP - (countInstallPending ? 0 : view.daedalusRep);
          const measuredRepRate = rates.daedalusRepPerSec;
          const projectedRepRate = rates.daedalusRepPerSecProjected ?? 0;
          const repWorkRate = measuredRepRate > 0
            ? measuredRepRate
            : projectedRepRate > 0 ? projectedRepRate : FALLBACK_DAEDALUS_REP_PER_SEC;
          const repWorkSec = Math.max(0, repGap) / repWorkRate;
          const donateUnlockGap = rates.daedalusDonateUnlockRepGap;
          const dollarsPerRep = rates.daedalusDonationDollarsPerRep ?? 0;
          const donationUnlocked = rates.daedalusDonationUnlocked === true;
          // Rep resets at the favor-banking install, so the donation buys the
          // full requirement; with donations already unlocked it buys only the
          // remaining gap and no install is needed.
          const donateRep = donationUnlocked ? Math.max(0, repGap) : RED_PILL_REP;
          const donateParts: EtaPart[] | undefined =
            donateUnlockGap !== undefined && dollarsPerRep > 0 && rates.moneyPerSec > 0
              ? [
                  {
                    what: "daedalus favor unlock reputation",
                    resource: "reputation" as const,
                    sec: (donationUnlocked ? 0 : Math.max(0, donateUnlockGap)) / repWorkRate,
                    measured: measuredRepRate > 0,
                  },
                  // The count install precedes the invite and so cannot bank
                  // Daedalus favor: without unlocked donations the banking
                  // install is always an extra reset after the unlock grind.
                  ...(donationUnlocked
                    ? []
                    : [{
                        what: "daedalus favor-banking install",
                        resource: "install" as const,
                        sec: INSTALL_OVERHEAD_SEC,
                        measured: false,
                      }]),
                  {
                    what: "daedalus reputation donation",
                    resource: "money" as const,
                    // Donations spend the BANK, not just the flow: pricing the
                    // full amount against income made an already-affordable
                    // donation look like hours whenever income dipped, and the
                    // route fell back to a 30h reputation grind.
                    sec: Math.max(0, donateRep * dollarsPerRep - view.money) / rates.moneyPerSec,
                    measured: false,
                  },
                ]
              : undefined;
          if (donateParts && total(donateParts) < repWorkSec) {
            parts.push(...donateParts);
          } else {
            parts.push({
              what: "daedalus reputation",
              resource: "reputation",
              sec: repWorkSec,
              measured: measuredRepRate > 0,
            });
          }
        }
        // The regrow's multiplier stack is unknowable until the count install
        // chooses it; after that the current queue IS the stack.
        parts.push(...redPillTail(
          view,
          wdSkill,
          rates,
          view.augCount < (daedalusAugsRequired(view.bitNode, sf12) ?? 30),
        ));
      } else if (route.id === "gang") {
        if (!view.ownsRedPill) {
          if (!view.inGang) {
            parts.push({ what: "create gang", resource: "other", sec: FALLBACK_GANG_START_SEC, measured: false });
          }
          const rep = part(
            "gang faction reputation",
            "reputation",
            RED_PILL_REP - (view.gangFactionRep ?? 0),
            rates.gangRepPerSec,
            FALLBACK_GANG_REP_PER_SEC,
          );
          parts.push(rep);
        }
        parts.push(...redPillTail(view, wdSkill, rates));
      } else if (route.id === "labyrinth") {
        if (view.ownsRedPill) {
          parts.push(...redPillTail(view, wdSkill, rates));
        } else {
          const first = labyrinthStageIndex(view);
          const final = view.bitNode === 15 ? 4 : LABYRINTH_AUGMENTATIONS.length;
          const firstQueued = route.mandatoryInstall?.ready === true;
          for (let stage = first; stage <= final; stage++) {
            if (!(stage === first && firstQueued)) {
              parts.push({ what: `labyrinth stage ${stage + 1}`, resource: "other", sec: LABYRINTH_WALK_SEC, measured: false });
            }
            parts.push({ what: `install labyrinth reward ${stage + 1}`, resource: "install", sec: INSTALL_OVERHEAD_SEC, measured: false });
          }
          nextMandatoryInstall = { sec: firstQueued ? 0 : LABYRINTH_WALK_SEC, measured: firstQueued };
          parts.push(...postInstallRegrow(wdSkill ?? 3000, rates));
        }
      } else {
        if (!view.inBladeburner) {
          parts.push(part(
            "Bladeburner join combat skills",
            "combat",
            100 - view.lowestCombatSkill,
            rates.combatSkillPerSec,
            1 / FALLBACK_SEC_PER_COMBAT_LEVEL,
          ));
        }
        // Black ops earn rank as they complete, so the rank climb and the op
        // sequence overlap: the estimate is the slower of the two.
        const remainingOps = Math.max(0, BLACK_OP_COUNT - (view.blackOpsComplete ?? 0));
        const ops = part("black operations", "combat", remainingOps, rates.blackOpsPerSec, 1 / FALLBACK_SEC_PER_BLACK_OP);
        const rank = part(
          "bladeburner rank",
          "combat",
          BLACK_OP_FINAL_RANK - (view.bladeburnerRank ?? 0),
          rates.bladeburnerRankPerSec,
          FALLBACK_RANK_PER_SEC,
        );
        const slowest = ops.sec >= rank.sec ? ops : rank;
        parts.push(slowest);
      }
    }

    if (route.mandatoryInstall?.ready) {
      nextMandatoryInstall = { sec: 0, measured: true };
    }

    out.push({
      id: route.id,
      available: route.available,
      ...(route.actionable !== undefined ? { actionable: route.actionable } : {}),
      complete: route.complete,
      etaSec: total(parts),
      parts,
      stage: route.stage,
      needs,
      ...(nextMandatoryInstall ? { nextMandatoryInstall } : {}),
    });
  }
  return out;
}

/** Daedalus accepts hacking 2500 OR all four combat skills at 1500 — whichever
 * climb is faster is the one the estimate prices. */
function skillPart(view: EndgameView, rates: RouteRates, afterInstall = false): EtaPart[] {
  const hackingGain = afterInstall ? Math.max(1, rates.postInstallHackingSkillMult) : 1;
  const combatGain = afterInstall ? Math.max(1, rates.postInstallCombatSkillMult) : 1;
  // For the same experience, skill is proportional to the direct stat
  // multiplier. Invert the future multiplier into a current-curve-equivalent
  // target; this prices a banked augmentation without pretending it is active.
  const hackTarget = DAEDALUS_HACKING / hackingGain;
  const combatTarget = DAEDALUS_COMBAT / combatGain;
  const hackGap = Math.max(0, hackTarget - view.hackingSkill);
  const combatGap = Math.max(0, combatTarget - view.lowestCombatSkill);
  const hackFallback = hackGap / (rates.hackingSkillPerSec > 0 ? rates.hackingSkillPerSec : 1 / FALLBACK_SEC_PER_HACK_LEVEL);
  const combatFallback = combatGap / (rates.combatSkillPerSec > 0 ? rates.combatSkillPerSec : 1 / FALLBACK_SEC_PER_COMBAT_LEVEL);
  // The hacking branch is a PLAN, not just a rate: the climb is exponential
  // in 1/mult, so "buy the best k hacking augmentations, then climb" is often
  // the fastest path to the gate and must be priced as such — the invite gate
  // read 30-80h on the combat branch while the run owned the money to make
  // the hacking branch trivial.
  const hackParts: EtaPart[] = (rates.hackingSkillMult !== undefined
    ? stackedClimbPlan(
        DAEDALUS_HACKING,
        afterInstall ? 0 : rates.hackingExp ?? 0,
        rates.hackingSkillMult * hackingGain,
        rates,
        "hacking skill",
      )
    : undefined)
    ?? [curvePart("hacking skill", "hacking", hackTarget - 1, hackFallback, rates, view.hackingSkill > 1)];
  const combat = curvePart("combat skills", "combat", combatTarget - 1, combatFallback, rates, view.lowestCombatSkill > 1);
  const hackSec = hackParts.reduce((sum, part) => sum + part.sec, 0);
  return hackSec <= combat.sec ? hackParts : [combat];
}

// --- route choice -----------------------------------------------------------

/** A challenger must beat the incumbent's CURRENT estimate by this much. */
export const ROUTE_SWITCH_MARGIN = 0.25;
/** Minimum hold before a switch, so wobbling estimates cannot flap the run's
 * whole priority structure. */
export const ROUTE_DWELL_MS = 600_000;

export interface RouteChoice {
  route: RouteId;
  etaSec: number;
  decidedAt: number;
}

export interface RouteDecision {
  choice: RouteChoice | undefined;
  /** True when the route CHANGED this call — the telemetry event trigger. */
  switched: boolean;
}

/** Pick the fastest available route, with hysteresis against the incumbent.
 *
 * The failure mode this guards is flapping: two routes with similar estimates
 * trading places as the numbers wobble, dragging every feature's priorities
 * with them. A challenger needs a real margin AND the incumbent must have held
 * for the dwell — the same shape as the hacking evaluator's target switch. */
export function chooseRoute(
  previous: RouteChoice | undefined,
  etas: readonly RouteEta[],
  now: number,
  opts: { switchMargin?: number; dwellMs?: number } = {},
): RouteDecision {
  const margin = opts.switchMargin ?? ROUTE_SWITCH_MARGIN;
  const dwellMs = opts.dwellMs ?? ROUTE_DWELL_MS;

  // Automation-blocked routes are a last resort, not a disqualification: a node
  // whose only mechanically available route cannot be driven yet (BN15's
  // labyrinth) must still get a published route, or every consumer of
  // `plan.route` — faction weights, Go demand, the install brake — loses its
  // input. Mirrors the same fallback in `stepEndgame`.
  const availableEtas = etas.filter((eta) => eta.available);
  const actionable = availableEtas.filter((eta) => eta.actionable !== false);
  const usable = actionable.length > 0 ? actionable : availableEtas;
  if (usable.length === 0) return { choice: undefined, switched: false };

  // A complete route ends the node NOW; nothing outranks that.
  const done = usable.find((eta) => eta.complete);
  if (done) {
    return {
      choice: {
        route: done.id,
        etaSec: 0,
        decidedAt: previous?.route === done.id ? previous.decidedAt : now,
      },
      switched: previous?.route !== done.id,
    };
  }

  const best = usable.reduce((a, b) => (b.etaSec < a.etaSec ? b : a));
  const incumbent = previous ? usable.find((eta) => eta.id === previous.route) : undefined;

  if (!incumbent) {
    return {
      choice: {
        route: best.id,
        etaSec: best.etaSec,
        decidedAt: now,
      },
      // First decision, or the incumbent stopped being available — either way
      // the published route changes, which is what the event marks.
      switched: true,
    };
  }

  const challengerWins =
    best.id !== incumbent.id &&
    best.etaSec < incumbent.etaSec * (1 - margin) &&
    now - (previous?.decidedAt ?? 0) >= dwellMs;

  if (challengerWins) {
    return {
      choice: {
        route: best.id,
        etaSec: best.etaSec,
        decidedAt: now,
      },
      switched: true,
    };
  }

  return {
    choice: {
      route: incumbent.id,
      etaSec: incumbent.etaSec,
      decidedAt: previous!.decidedAt,
    },
    switched: false,
  };
}

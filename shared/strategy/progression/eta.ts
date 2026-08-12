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
/** The labyrinth walk itself. Unmodelled mechanic, so this is a pure guess —
 *  marked unmeasured in the parts so the calibration loop can see it. */
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
  nextMandatoryInstall?: { sec: number; measured: boolean; why: string };
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
  return parts.reduce((sum, entry) => sum + entry.sec, 0);
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
function redPillTail(view: EndgameView, wdSkill: number | undefined, rates: RouteRates): EtaPart[] {
  const parts: EtaPart[] = [];
  const skill = wdSkill ?? 3000;
  if (!view.redPillInstalled) {
    parts.push({ what: "install", resource: "install", sec: INSTALL_OVERHEAD_SEC, measured: false });
    parts.push(postInstallRegrow(skill, rates));
  } else if (view.hackingSkill < skill) {
    parts.push(part("regrow", "hacking", skill - view.hackingSkill, rates.hackingSkillPerSec, 1 / FALLBACK_SEC_PER_HACK_LEVEL));
  } else if (!view.worldDaemonRooted) {
    // Fleet upkeep performs this as soon as the five port openers and daemon
    // are visible. It is short, but it is a real destroy-API precondition.
    parts.push({ what: "root world daemon", resource: "other", sec: 1, measured: false });
  }
  return parts;
}

function postInstallRegrow(skill: number, rates: RouteRates): EtaPart {
  const equivalentSkill = skill / Math.max(1, rates.postInstallHackingSkillMult);
  const rate = rates.hackingSkillPerSec > 0 ? rates.hackingSkillPerSec : 1 / FALLBACK_SEC_PER_HACK_LEVEL;
  return curvePart("regrow", "hacking", equivalentSkill - 1, (equivalentSkill / rate) * REGROW_DISCOUNT, rates);
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
            nextMandatoryInstall = {
              sec: acquire.sec,
              measured: acquire.measured,
              why: route.mandatoryInstall?.why ?? "the installed-augmentation gate requires the final package to be reset in",
            };

            // Money and skills reset at that install, so progress made toward
            // those invitation branches before it cannot be credited twice.
            const afterReset: EndgameView = {
              ...view,
              money: 0,
              hackingSkill: 1,
              lowestCombatSkill: 1,
            };
            const postResetGate = [
              moneyGatePart(afterReset, rates, true),
              skillPart(afterReset, rates, true),
            ];
            const slowest = postResetGate.reduce((a, b) => (b.sec > a.sec ? b : a));
            parts.push({ ...slowest, what: `post-install invite gate (${slowest.what})` });
          } else {
            // With the count gate already installed, money and the two skill
            // branches accrue in parallel from the live state.
            const skill = skillPart(view, rates);
            const gate = [moneyGatePart(view, rates, false), skill];
            const slowest = gate.reduce((a, b) => (b.sec > a.sec ? b : a));
            parts.push({ ...slowest, what: `invite gate (${slowest.what})` });

            const inviteNeeds: RouteNeed[] = [];
            if (view.money < DAEDALUS_MONEY) {
              inviteNeeds.push({
                kind: "money",
                target: DAEDALUS_MONEY,
                have: view.money,
                why: "parallel Daedalus invitation money gate",
              });
            }
            if (view.hackingSkill < DAEDALUS_HACKING && view.lowestCombatSkill < DAEDALUS_COMBAT) {
              inviteNeeds.push(skill.resource === "combat"
                ? {
                    kind: "combatSkills",
                    target: DAEDALUS_COMBAT,
                    have: view.lowestCombatSkill,
                    why: "measured faster branch of the parallel Daedalus skill gate",
                  }
                : {
                    kind: "skill",
                    subject: "hacking",
                    target: DAEDALUS_HACKING,
                    have: view.hackingSkill,
                    why: "measured faster branch of the parallel Daedalus skill gate",
                  });
            }
            // Once both invitation gates are satisfied stepEndgame has already
            // advanced to Daedalus reputation, which remains sequential and
            // must be preserved unchanged.
            if (inviteNeeds.length > 0) needs = inviteNeeds;
          }
          // Reputation is sequential: it only starts once Daedalus invites.
          parts.push(
            part(
              "daedalus reputation",
              "reputation",
              RED_PILL_REP - (countInstallPending ? 0 : view.daedalusRep),
              rates.daedalusRepPerSec,
              FALLBACK_DAEDALUS_REP_PER_SEC,
            ),
          );
        }
        parts.push(...redPillTail(view, wdSkill, rates));
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
          nextMandatoryInstall = {
            sec: firstQueued ? 0 : LABYRINTH_WALK_SEC,
            measured: firstQueued,
            why: route.mandatoryInstall?.why ?? "the current labyrinth reward must be installed before the next stage",
          };
          parts.push(postInstallRegrow(wdSkill ?? 3000, rates));
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
      nextMandatoryInstall = { sec: 0, measured: true, why: route.mandatoryInstall.why };
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
function skillPart(view: EndgameView, rates: RouteRates, afterInstall = false): EtaPart {
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
  const hack = curvePart("hacking skill", "hacking", hackTarget - 1, hackFallback, rates, view.hackingSkill > 1);
  const combat = curvePart("combat skills", "combat", combatTarget - 1, combatFallback, rates, view.lowestCombatSkill > 1);
  return hack.sec <= combat.sec ? hack : combat;
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
  why: string;
}

export interface RouteDecision {
  choice: RouteChoice | undefined;
  /** True when the route CHANGED this call — the telemetry event trigger. */
  switched: boolean;
}

function hours(sec: number): string {
  return sec >= 3_600 ? `~${(sec / 3_600).toFixed(1)}h` : `~${Math.max(1, Math.round(sec / 60))}m`;
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
        why: `${done.id} route is complete — the node can be ended now`,
      },
      switched: previous?.route !== done.id,
    };
  }

  const best = usable.reduce((a, b) => (b.etaSec < a.etaSec ? b : a));
  const incumbent = previous ? usable.find((eta) => eta.id === previous.route) : undefined;

  if (!incumbent) {
    const runnerUp = usable.filter((eta) => eta.id !== best.id).sort((a, b) => a.etaSec - b.etaSec)[0];
    return {
      choice: {
        route: best.id,
        etaSec: best.etaSec,
        decidedAt: now,
        why: runnerUp
          ? `${best.id} is the fastest route: ${hours(best.etaSec)} (vs ${runnerUp.id} ${hours(runnerUp.etaSec)})`
          : `${best.id} is the only available route: ${hours(best.etaSec)}`,
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
        why: `switching to ${best.id}: ${hours(best.etaSec)} beats ${incumbent.id} ${hours(incumbent.etaSec)} by >${Math.round(margin * 100)}%`,
      },
      switched: true,
    };
  }

  return {
    choice: {
      route: incumbent.id,
      etaSec: incumbent.etaSec,
      decidedAt: previous!.decidedAt,
      why:
        best.id === incumbent.id
          ? `${incumbent.id} remains the fastest route: ${hours(incumbent.etaSec)}`
          : `staying on ${incumbent.id} (${hours(incumbent.etaSec)}): ${best.id} at ${hours(best.etaSec)} is within the switch margin or dwell`,
    },
    switched: false,
  };
}

import {
  BLACK_OP_COUNT,
  BLACK_OP_FINAL_RANK,
  DAEDALUS_COMBAT,
  DAEDALUS_HACKING,
  DAEDALUS_MONEY,
  RED_PILL_REP,
  daedalusAugsRequired,
  type EndgameDecision,
  type EndgameView,
  type RouteId,
} from "./endgame.ts";

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
  blackOpsPerSec: number;
  bladeburnerRankPerSec: number;
}
export function noRates(): RouteRates {
  return {
    moneyPerSec: 0,
    hackingSkillPerSec: 0,
    combatSkillPerSec: 0,
    augsPerSec: 0,
    daedalusRepPerSec: 0,
    blackOpsPerSec: 0,
    bladeburnerRankPerSec: 0,
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
  complete: boolean;
  etaSec: number;
  parts: EtaPart[];
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

/** The shared tail of both Red Pill routes: install the pill, then climb back
 * to the world-daemon level after the reset wiped hacking to 1. */
function redPillTail(view: EndgameView, wdSkill: number | undefined, rates: RouteRates): EtaPart[] {
  const parts: EtaPart[] = [];
  const skill = wdSkill ?? 3000;
  const rate = rates.hackingSkillPerSec > 0 ? rates.hackingSkillPerSec : 1 / FALLBACK_SEC_PER_HACK_LEVEL;
  if (!view.redPillInstalled) {
    parts.push({ what: "install", resource: "install", sec: INSTALL_OVERHEAD_SEC, measured: false });
    // The whole climb from 1, discounted for the freshly installed set.
    parts.push({
      what: "regrow",
      resource: "hacking",
      sec: (skill / rate) * REGROW_DISCOUNT,
      measured: rates.hackingSkillPerSec > 0,
    });
  } else if (view.hackingSkill < skill) {
    parts.push(part("regrow", "hacking", skill - view.hackingSkill, rates.hackingSkillPerSec, 1 / FALLBACK_SEC_PER_HACK_LEVEL));
  }
  return parts;
}

/** Estimate every route from the current state. Pure; the decision supplies
 * availability/completeness, this adds time. */
export function routeEtas(view: EndgameView, decision: EndgameDecision, rates: RouteRates): RouteEta[] {
  const sf12 = view.sf12Level ?? Number(view.sourceFiles["12"] ?? 0);
  const wdSkill = decision.worldDaemonSkill;
  const out: RouteEta[] = [];

  for (const route of decision.routes) {
    const parts: EtaPart[] = [];

    if (!route.complete) {
      if (route.id === "daedalus") {
        if (!view.ownsRedPill) {
          const augsNeeded = daedalusAugsRequired(view.bitNode, sf12) ?? 30;
          // Augs, money and skill accrue in PARALLEL while the run plays, so
          // the estimate takes the slowest of the three, not their sum.
          const gate = [
            part("augmentations", "augmentations", augsNeeded - view.augCount, rates.augsPerSec, 1 / FALLBACK_SEC_PER_AUG),
            part("money", "money", DAEDALUS_MONEY - view.money, rates.moneyPerSec, FALLBACK_MONEY_PER_SEC),
            skillPart(view, rates),
          ];
          const slowest = gate.reduce((a, b) => (b.sec > a.sec ? b : a));
          parts.push({ ...slowest, what: `invite gate (${slowest.what})` });
          // Reputation is sequential: it only starts once Daedalus invites.
          parts.push(
            part("daedalus reputation", "reputation", RED_PILL_REP - view.daedalusRep, rates.daedalusRepPerSec, FALLBACK_DAEDALUS_REP_PER_SEC),
          );
        }
        parts.push(...redPillTail(view, wdSkill, rates));
      } else if (route.id === "labyrinth") {
        if (!view.ownsRedPill) parts.push({ what: "labyrinth walk", resource: "other", sec: LABYRINTH_WALK_SEC, measured: false });
        parts.push(...redPillTail(view, wdSkill, rates));
      } else {
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

    out.push({
      id: route.id,
      available: route.available,
      complete: route.complete,
      etaSec: total(parts),
      parts,
    });
  }
  return out;
}

/** Daedalus accepts hacking 2500 OR all four combat skills at 1500 — whichever
 * climb is faster is the one the estimate prices. */
function skillPart(view: EndgameView, rates: RouteRates): EtaPart {
  const hack = part("hacking skill", "hacking", DAEDALUS_HACKING - view.hackingSkill, rates.hackingSkillPerSec, 1 / FALLBACK_SEC_PER_HACK_LEVEL);
  const combat = part(
    "combat skills",
    "combat",
    DAEDALUS_COMBAT - view.lowestCombatSkill,
    rates.combatSkillPerSec,
    1 / FALLBACK_SEC_PER_COMBAT_LEVEL,
  );
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

  const usable = etas.filter((eta) => eta.available);
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

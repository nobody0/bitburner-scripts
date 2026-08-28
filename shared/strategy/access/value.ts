import { expForSkill, hackTimeSeconds, type HackContext } from "../../formulas.ts";

/** Backdoor economics: what an `installBackdoor` costs and what it saves.
 *
 * Pure and no-ns, so the game driver, the needs producers and the simulator
 * all price a backdoor identically. Everything here is denominated the same
 * way as the rest of the strategy layer: seconds of BitNode completion time
 * ("BN-seconds") on the value side, wall-clock seconds on the cost side.
 *
 * Three distinct reasons a backdoor is worth having, each with its own
 * converter below:
 *  - it satisfies a faction invite requirement (`backdoorInstalled`);
 *  - it multiplies a company's required reputation by 0.75 — BOTH for the
 *    megacorp faction's companyRep invite gate and for job promotions;
 *  - it discounts university/gym costs by 10% while training there.
 * (Backdoors have no stock-market effect; there is deliberately no such
 * valuation here.) */

/** `CompanyRequiredReputationMultiplier` — applied by the game whenever any
 * server with the company's `organizationName` is backdoored. The live game
 * serializes the ALREADY-EFFECTIVE number in `getFactionInviteRequirements`
 * (there is no OR-branch to interpret), so before the backdoor exists this
 * discount is invisible to the requirement tree and must be modeled as domain
 * knowledge here.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Constants.ts#L111
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Company/utils.ts */
export const COMPANY_REQUIRED_REP_MULTIPLIER = 0.75;

/** University/gym cost discount for a backdoored location server.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Formulas.ts#L99-L121 */
export const TRAINING_BACKDOOR_COST_MULTIPLIER = 0.9;

/** Ranking fallback when a skill wait cannot be measured: seconds per missing
 * hacking level, matching `NOMINAL_SEC_PER_UNIT.skill` in
 * factions/requirements.ts so both fallbacks use the same scale. */
export const NOMINAL_SEC_PER_SKILL = 30;

export interface BackdoorCostInput {
  requiredHackingSkill: number;
  hackDifficulty: number;
  /** Precomputed player/BitNode hacking context (shared/formulas.ts). */
  ctx: HackContext;
  /** Current hacking exp and the player's hacking skill multiplier, for the
   * exp gap when the skill requirement is not met yet. */
  hackingExp: number;
  hackingSkillMult: number;
  /** Measured fleet hacking exp per second. Absent = unmeasured, which falls
   * back to the nominal per-level rate rather than fabricating a rate. */
  expPerSec?: number;
}

export interface BackdoorCost {
  /** Wall-clock seconds `installBackdoor` itself takes, at the skill we will
   * actually have when it becomes possible (never faster than "at exactly the
   * required skill"). installBackdoor sleeps hackTime / 4.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L518-L533 */
  actionSec: number;
  /** Seconds until the hacking-skill requirement is met (0 when it already
   * is). Measured from the fleet exp rate when available. */
  skillWaitSec: number;
  totalSec: number;
}

export function backdoorCostSeconds(input: BackdoorCostInput): BackdoorCost {
  const required = Math.max(1, input.requiredHackingSkill);
  const difficulty = Math.max(1, input.hackDifficulty);
  const ctx = input.ctx;

  // hackTime at the LATER of the current skill and the requirement: the
  // action cannot start below the requirement, so pricing it at the current
  // (lower) skill would overstate the cost of exactly the servers whose value
  // is dominated by the wait, and double-count the gap skillWaitSec covers.
  const effectiveSkill = Math.max(ctx.skill, required);
  const actionSec = effectiveSkill === ctx.skill
    ? hackTimeSeconds(ctx, difficulty, required) / 4
    : (5 * ((2.5 * (required * difficulty) + 500) / (effectiveSkill + 50))) / ctx.speedDenom / 4;

  let skillWaitSec = 0;
  const skillGap = required - ctx.skill;
  if (skillGap > 0) {
    const expGap = Math.max(0, expForSkill(required, input.hackingSkillMult) - input.hackingExp);
    skillWaitSec = input.expPerSec !== undefined && input.expPerSec > 0
      ? expGap / input.expPerSec
      : skillGap * NOMINAL_SEC_PER_SKILL;
  }

  return { actionSec, skillWaitSec, totalSec: actionSec + skillWaitSec };
}

/** Nominal company rep per second when no measured rate exists — the inverse
 * of `NOMINAL_SEC_PER_UNIT.companyRep` (0.1 sec/rep) in requirements.ts.
 * Deliberately modest: before we actually work at the company the discount is
 * speculative, which is exactly the "deprioritize corps we are not working
 * for" behaviour, with no per-company rule. */
export const NOMINAL_COMPANY_REP_PER_SEC = 10;

export interface CompanyBackdoorInput {
  /** The UNDISCOUNTED requirement — what the game reports while the server is
   * not backdoored. */
  repTarget: number;
  repHave: number;
  /** Measured company rep per second; absent = unmeasured. */
  repPerSec?: number;
}

/** Wall-clock seconds of company-rep grinding a backdoor removes: the time to
 * reach the full target minus the time to reach 0.75x it. When rep already
 * exceeds the discounted target, the backdoor completes the requirement by
 * itself and the whole remaining grind is saved. */
export function companyBackdoorSavedSeconds(input: CompanyBackdoorInput): number {
  const rate = input.repPerSec !== undefined && input.repPerSec > 0
    ? input.repPerSec
    : NOMINAL_COMPANY_REP_PER_SEC;
  const remainingNow = Math.max(0, input.repTarget - input.repHave);
  const remainingAfter = Math.max(0, input.repTarget * COMPANY_REQUIRED_REP_MULTIPLIER - input.repHave);
  return (remainingNow - remainingAfter) / rate;
}

/** $/sec a backdoor saves while training at the location: the discount off
 * the CURRENT (undiscounted) drain. Callers convert to BN-seconds with the
 * measured money marginal (`moneyRateValue`). */
export function trainingBackdoorSavedRate(costPerSec: number): number {
  return Math.max(0, costPerSec) * (1 - TRAINING_BACKDOOR_COST_MULTIPLIER);
}

export interface FactionGateInput {
  /** Remaining planning horizon (route/node seconds) — the most a gate can be
   * worth, since an unlocked faction cannot save more time than remains. */
  horizonSec: number;
  /** Estimated seconds of the faction's OTHER unmet blockers (same coarse
   * estimate the requirement interpreter ranks with). While those remain, the
   * join is not brought forward by the full horizon. */
  otherBlockersSec: number;
}

/** BN-seconds of run a faction-gating access blocker (root or backdoor)
 * unlocks: the horizon minus the part still blocked by everything else. The
 * LAST blocker of a faction is worth the whole remaining horizon. */
export function factionGateSavedSeconds(input: FactionGateInput): number {
  return Math.max(0, input.horizonSec - Math.max(0, input.otherBlockersSec));
}

/** Ranking-only fallback for a need that carries no measured `valueSec`:
 * weight is "value units per second of unblocked run" on a 1-6 scale, so a
 * nominal 300-second unblocked window turns it into comparable seconds. Used
 * only to ORDER actions, never reported as a prediction. */
export const NOMINAL_VALUE_SEC_PER_WEIGHT = 300;

export function rankingValueSec(need: { weight: number; valueSec?: number }): number {
  return need.valueSec !== undefined ? need.valueSec : need.weight * NOMINAL_VALUE_SEC_PER_WEIGHT;
}

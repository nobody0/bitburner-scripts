/** Reputation, favor and donation math.
 *
 * Transcribed from v3.0.1 and covered by a parity suite against the vendored
 * originals (`sim/tests/factions-parity.test.ts`), which asserts bit-identity
 * with `toBe`, not `toBeCloseTo`. These live in `shared/` rather than being
 * imported from `sim/vendor/` because `shared/` ships INTO THE GAME and must
 * not drag the vendored tree into the bundle — the boundary test pins that.
 *
 * Four facts the whole strategy turns on:
 *
 *  1. **Rep targets are order-independent; money is not.** A faction's
 *     reputation requirement does NOT scale with the purchase queue, while
 *     money scales `1.9^queued`. So the augmentation ORDER only matters for
 *     price — buy most-expensive-first.
 *  2. **Favor cannot grow within a run.** `addRepToFavor` is applied at INSTALL
 *     only. A donation route locked behind favor 150 is therefore a message to
 *     `progression` ("this run should end"), never something to wait for.
 *  3. **Passive rep has a floor and skips the faction you are working.** Below
 *     a threshold skill, working is strictly WORSE than idling.
 *  4. **Unfocused work is x0.8** unless Neuroreceptor Management Implant is
 *     owned.
 *
 * Upstream implementations (pinned v3.0.1):
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Constants.ts#L25-L43
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Constants.ts#L77-L105
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/formulas/reputation.ts#L11-L55
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L143-L176
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/formulas/donation.ts#L7-L30
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/formulas/favor.ts#L7-L24 */

/** CONSTANTS.MaxSkillLevel @ v3.0.1. */
export const MAX_SKILL_LEVEL = 975;
/** CONSTANTS.DonateMoneyToRepDivisor @ v3.0.1. */
export const DONATE_MONEY_TO_REP_DIVISOR = 1e6;
/** CONSTANTS.BaseFavorToDonate @ v3.0.1. */
export const BASE_FAVOR_TO_DONATE = 150;
/** CONSTANTS.BaseFocusBonus @ v3.0.1 — the penalty for UNfocused work. */
export const BASE_FOCUS_BONUS = 0.8;
/** Nearest representable log(1.02); NOT Math.log(1.02), which lacks the
 * precision (the game says so in a comment, and the difference shows up in
 * favor at high reputation). */
export const LOG_1_POINT_02 = 0.019802627296179712;
export const MAX_FAVOR = 35331;

export type WorkType = "hacking" | "field" | "security";

export interface RepPerson {
  skills: { hacking: number; strength: number; defense: number; dexterity: number; agility: number; charisma: number; intelligence: number };
  mults: { faction_rep: number } & Partial<Record<`${SkillName}_exp`, number>>;
}

/** The skills faction work awards experience in. */
export type SkillName = "hacking" | "strength" | "defense" | "dexterity" | "agility" | "charisma";

export interface RepContext {
  /** currentNodeMults.FactionWorkRepGain. */
  factionWorkRepGain: number;
  /** currentNodeMults.FactionPassiveRepGain. */
  factionPassiveRepGain?: number;
  /** `calculateCurrentShareBonus()` — 1 when nothing is sharing. */
  shareBonus: number;
  /** SF15 level; at 3+ charisma contributes to faction work. */
  sf15Level: number;
  /** Owning Neuroreceptor Management Implant removes the unfocused penalty. */
  hasFocusAug: boolean;
  /** currentNodeMults.FactionWorkExpGain. Defaults to 1. */
  factionWorkExpGain?: number;
}

function clamp(value: number, min: number, max = Infinity): number {
  return Math.max(min, Math.min(max, value));
}

/** `calculateIntelligenceBonus(intelligence, weight)` @ v3.0.1.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/formulas/intelligence.ts#L1-L3 */
export function intelligenceBonus(intelligence: number, weight = 1): number {
  return 1 + (weight * Math.pow(intelligence, 0.8)) / 600;
}

/** The favor multiplier applied to every work type. */
export function favorMult(favor: number, ctx: RepContext): number {
  let mult = 1 + favor / 100;
  if (Number.isNaN(mult)) mult = 1;
  return mult * ctx.factionWorkRepGain;
}

function darknetCharismaBonus(person: RepPerson, ctx: RepContext, scalar: number): number {
  return ctx.sf15Level >= 3 ? person.skills.charisma * scalar : 0;
}

/** Reputation per CYCLE (200 ms), before the focus penalty. */
export function hackingWorkRepGain(person: RepPerson, favor: number, ctx: RepContext): number {
  return (
    ((person.skills.hacking + person.skills.intelligence / 3 + darknetCharismaBonus(person, ctx, 0.1)) /
      MAX_SKILL_LEVEL) *
    person.mults.faction_rep *
    intelligenceBonus(person.skills.intelligence, 1) *
    favorMult(favor, ctx) *
    ctx.shareBonus
  );
}

export function securityWorkRepGain(person: RepPerson, favor: number, ctx: RepContext): number {
  const t =
    (0.9 *
      (person.skills.strength +
        person.skills.defense +
        person.skills.dexterity +
        person.skills.agility +
        darknetCharismaBonus(person, ctx, 0.3) +
        (person.skills.hacking + person.skills.intelligence) * ctx.shareBonus)) /
    MAX_SKILL_LEVEL /
    4.5;
  return t * person.mults.faction_rep * favorMult(favor, ctx) * intelligenceBonus(person.skills.intelligence, 1);
}

export function fieldWorkRepGain(person: RepPerson, favor: number, ctx: RepContext): number {
  const t =
    (0.9 *
      (person.skills.strength +
        person.skills.defense +
        person.skills.dexterity +
        person.skills.agility +
        person.skills.charisma +
        (person.skills.hacking + person.skills.intelligence + darknetCharismaBonus(person, ctx, 0.3)) *
          ctx.shareBonus)) /
    MAX_SKILL_LEVEL /
    5.5;
  return t * person.mults.faction_rep * favorMult(favor, ctx) * intelligenceBonus(person.skills.intelligence, 1);
}

export function workRepGain(type: WorkType, person: RepPerson, favor: number, ctx: RepContext): number {
  if (type === "hacking") return hackingWorkRepGain(person, favor, ctx);
  if (type === "security") return securityWorkRepGain(person, favor, ctx);
  return fieldWorkRepGain(person, favor, ctx);
}

/** Reputation per SECOND, focus penalty included. Five cycles per second. */
export function workRepPerSec(
  type: WorkType,
  person: RepPerson,
  favor: number,
  ctx: RepContext,
  focused: boolean,
): number {
  const penalty = focused || ctx.hasFocusAug ? 1 : BASE_FOCUS_BONUS;
  return workRepGain(type, person, favor, ctx) * penalty * 5;
}

/** Experience per SECOND awarded by each faction work type, before the
 * player's own `*_exp` multipliers, the node multiplier and the focus penalty.
 *
 * THIS IS THE HALF THE PLANNER USED TO IGNORE. Field and security work pay
 * combat experience while earning reputation, so a posted combat gate can be
 * served by the same second that advances a faction — but the chooser picked on
 * reputation alone and the claim announced reputation alone, so career won the
 * slot with crime and the reputation was simply never earned. `chooseWorkType`
 * in `./decide.ts` prices all three types with these rates; `bestWorkType`
 * below stays reputation-only because its callers are asking a reputation ETA
 * question, not choosing what to run.
 *
 * `FactionWorkStats` -> `calculateFactionExp` -> `applyWorkStats` @ v3.0.1; the
 * game's per-cycle amounts divided by its five-cycles-per-second divisor.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Formulas.ts */
export const FACTION_WORK_EXP: Readonly<Record<WorkType, Readonly<Partial<Record<SkillName, number>>>>> = {
  hacking: { hacking: 2 },
  field: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1 },
  security: { hacking: 0.5, strength: 1.5, defense: 1.5, dexterity: 1.5, agility: 1.5 },
};

export function factionWorkExpPerSec(
  type: WorkType,
  person: RepPerson,
  ctx: RepContext,
  focused: boolean,
): Partial<Record<SkillName, number>> {
  const penalty = focused || ctx.hasFocusAug ? 1 : BASE_FOCUS_BONUS;
  const node = ctx.factionWorkExpGain ?? 1;
  const out: Partial<Record<SkillName, number>> = {};
  for (const [skill, base] of Object.entries(FACTION_WORK_EXP[type]) as [SkillName, number][]) {
    out[skill] = base * (person.mults[`${skill}_exp`] ?? 1) * node * penalty;
  }
  return out;
}

/** Exact local work-rate slope with respect to the share bonus. All three
 * formulas are affine in the bonus; this preserves their distinct dilution. */
export function workRepPerSecPerShareBonus(
  type: WorkType,
  person: RepPerson,
  favor: number,
  ctx: RepContext,
  focused: boolean,
): number {
  const at = (shareBonus: number) => workRepPerSec(type, person, favor, { ...ctx, shareBonus }, focused);
  return Math.max(0, at(ctx.shareBonus + 1) - at(ctx.shareBonus));
}

/** Highest-REPUTATION work type available at a faction, and its rate.
 * `undefined` when the faction offers no work at all (Shadows of Anarchy).
 *
 * For reputation ETA questions only — how long until this faction's next
 * breakpoint. Choosing what to actually RUN is `chooseWorkType` in
 * `./decide.ts`, which weighs the experience each type also pays. */
export function bestWorkType(
  offers: { hacking: boolean; field: boolean; security: boolean },
  person: RepPerson,
  favor: number,
  ctx: RepContext,
  focused: boolean,
): { type: WorkType; repPerSec: number } | undefined {
  let best: { type: WorkType; repPerSec: number } | undefined;
  for (const type of ["hacking", "field", "security"] as const) {
    if (!offers[type]) continue;
    const repPerSec = workRepPerSec(type, person, favor, ctx, focused);
    if (!best || repPerSec > best.repPerSec) best = { type, repPerSec };
  }
  return best;
}

/** Passive reputation per SECOND for one faction.
 *
 * The best actual work-reputation formula is reduced by the passive favor
 * fraction, then floored at 1/120 rep per cycle. The faction currently being
 * worked is skipped by the caller. That skip creates the work-vs-idle
 * crossover: below a threshold skill, working earns less than the passive tick
 * it suppresses. */
export function passiveRepPerSec(person: RepPerson, favor: number, ctx: RepContext): number {
  // The game takes the best ACTUAL work-reputation formula (not the largest
  // raw skill), applies the passive favor fraction, then floors the result at
  // 1/120 rep/cycle before the separate passive BitNode multiplier.
  const passiveFavor = Math.min(0.1, favor / 1000 + 0.01);
  const bestPerCycle = Math.max(
    hackingWorkRepGain(person, favor, ctx) * passiveFavor,
    securityWorkRepGain(person, favor, ctx) * passiveFavor,
    fieldWorkRepGain(person, favor, ctx) * passiveFavor,
    1 / 120,
  );
  return bestPerCycle
    * (ctx.factionPassiveRepGain ?? 1)
    * 5;
}

/** Local passive-rate slope. The tiny right derivative retains the active
 * max branch and the constant passive floor without duplicating that formula. */
export function passiveRepPerSecPerShareBonus(person: RepPerson, favor: number, ctx: RepContext): number {
  const epsilon = 1e-6;
  const base = passiveRepPerSec(person, favor, ctx);
  const next = passiveRepPerSec(person, favor, { ...ctx, shareBonus: ctx.shareBonus + epsilon });
  return Math.max(0, (next - base) / epsilon);
}

/** The skill at which working a faction first beats idling on passive rep.
 *
 * Exact, and a sharp behavioural test: below it the planner must choose to
 * IDLE, because working suppresses the passive tick for that faction and earns
 * less than it costs. Returns 0 when working always wins. */
export function workBeatsIdleSkill(
  type: WorkType,
  person: RepPerson,
  favor: number,
  ctx: RepContext,
  focused: boolean,
): number {
  const at = (skill: number): number => {
    const skills = { ...person.skills };
    if (type === "hacking") skills.hacking = skill;
    else if (type === "security") {
      skills.strength = skill;
      skills.defense = skill;
      skills.dexterity = skill;
      skills.agility = skill;
    } else {
      skills.strength = skill;
      skills.defense = skill;
      skills.dexterity = skill;
      skills.agility = skill;
      skills.charisma = skill;
    }
    const probe = { ...person, skills };
    return workRepPerSec(type, probe, favor, ctx, focused) - passiveRepPerSec(probe, favor, ctx);
  };
  if (at(0) > 0) return 0;
  let low = 0;
  let high = MAX_SKILL_LEVEL;
  if (at(high) <= 0) return Infinity;
  for (let i = 0; i < 64; i++) {
    const mid = (low + high) / 2;
    if (at(mid) > 0) high = mid;
    else low = mid;
  }
  return high;
}

// --- favor -----------------------------------------------------------------

/** `favorToRep` @ v3.0.1.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/formulas/favor.ts#L7-L15 */
export function favorToRep(favor: number): number {
  return clamp(25000 * Math.expm1(LOG_1_POINT_02 * favor), 0);
}

/** `repToFavor` @ v3.0.1.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/formulas/favor.ts#L17-L24 */
export function repToFavor(rep: number): number {
  return clamp(Math.log1p(rep / 25000) / LOG_1_POINT_02, 0, MAX_FAVOR);
}

/** Favor after an install banks this run's reputation. The ONLY way favor
 * grows — which is why a donation-gated faction is a reset decision.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/Faction.ts#L77-L85 */
export function addRepToFavor(favor: number, playerReputation: number): number {
  return repToFavor(favorToRep(favor) + playerReputation);
}

// --- donation --------------------------------------------------------------

/** Reputation still to EARN so favor crosses `targetFavor` at the next
 * install: favor banks total earned rep, so current favor and current rep
 * both count toward the threshold. */
export function repUntilFavor(currentFavor: number, currentRep: number, targetFavor: number): number {
  return Math.max(0, favorToRep(targetFavor) - favorToRep(currentFavor) - Math.max(0, currentRep));
}

export function favorNeededToDonate(favorToDonateMult: number): number {
  return Math.floor(BASE_FAVOR_TO_DONATE * favorToDonateMult);
}

export function repFromDonation(amount: number, factionRepMult: number, factionWorkRepGain: number): number {
  return (amount / DONATE_MONEY_TO_REP_DIVISOR) * factionRepMult * factionWorkRepGain;
}

export function donationForRep(rep: number, factionRepMult: number, factionWorkRepGain: number): number {
  return (rep * DONATE_MONEY_TO_REP_DIVISOR) / factionRepMult / factionWorkRepGain;
}

/** Money per second at which donating beats working.
 *
 * Donation converts money to reputation linearly, so the comparison is
 * "reputation per second from working" against "reputation per second from the
 * money we earn in that second". Above the crossover, WORK IS WASTED TIME and
 * the player slot should go to whatever earns money instead. */
export function donationCrossoverIncome(
  repPerSecFromWork: number,
  factionRepMult: number,
  factionWorkRepGain: number,
): number {
  return donationForRep(repPerSecFromWork, factionRepMult, factionWorkRepGain);
}

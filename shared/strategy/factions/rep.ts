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
 *     owned. */

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
  mults: { faction_rep: number };
}

export interface RepContext {
  /** currentNodeMults.FactionWorkRepGain. */
  factionWorkRepGain: number;
  /** `calculateCurrentShareBonus()` — 1 when nothing is sharing. */
  shareBonus: number;
  /** SF15 level; at 3+ charisma contributes to faction work. */
  sf15Level: number;
  /** Owning Neuroreceptor Management Implant removes the unfocused penalty. */
  hasFocusAug: boolean;
}

function clamp(value: number, min: number, max = Infinity): number {
  return Math.max(min, Math.min(max, value));
}

/** `calculateIntelligenceBonus(intelligence, weight)` @ v3.0.1. */
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

/** Best work type available at a faction, and its rate. `undefined` when the
 * faction offers no work at all (Shadows of Anarchy). */
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

/** Passive reputation per CYCLE for one faction.
 *
 * `max(hacking, strength, ...) * min(0.1, favor/1000 + 0.01)` in the game, and
 * the faction you are CURRENTLY WORKING is skipped. That skip is what creates
 * the work-vs-idle crossover: with a 1/120-per-cycle floor, working a faction
 * below a threshold skill earns LESS than the passive tick you gave up. */
export function passiveRepPerSec(person: RepPerson, favor: number, ctx: RepContext): number {
  const best = Math.max(
    person.skills.hacking,
    person.skills.strength,
    person.skills.defense,
    person.skills.dexterity,
    person.skills.agility,
    person.skills.charisma,
  );
  // The game runs this every 5 cycles (1s) and compensates for missed cycles.
  return best * Math.min(0.1, favor / 1000 + 0.01) * ctx.factionWorkRepGain * 0.001;
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
  const passive = passiveRepPerSec(person, favor, ctx);
  if (passive <= 0) return 0;
  // Both rates are linear in the driving skill, so one probe gives the slope.
  const probe = { ...person, skills: { ...person.skills, hacking: 1000, strength: 1000, defense: 1000, dexterity: 1000, agility: 1000 } };
  const slope = workRepPerSec(type, probe, favor, ctx, focused) / 1000;
  if (slope <= 0) return Infinity;
  return passive / slope;
}

// --- favor -----------------------------------------------------------------

/** `favorToRep` @ v3.0.1. */
export function favorToRep(favor: number): number {
  return clamp(25000 * Math.expm1(LOG_1_POINT_02 * favor), 0);
}

/** `repToFavor` @ v3.0.1. */
export function repToFavor(rep: number): number {
  return clamp(Math.log1p(rep / 25000) / LOG_1_POINT_02, 0, MAX_FAVOR);
}

/** Favor after an install banks this run's reputation. The ONLY way favor
 * grows — which is why a donation-gated faction is a reset decision. */
export function addRepToFavor(favor: number, playerReputation: number): number {
  return repToFavor(favorToRep(favor) + playerReputation);
}

// --- donation --------------------------------------------------------------

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

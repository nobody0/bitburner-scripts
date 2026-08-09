/** Crime success, reward and rate math.
 *
 * Transcribed from `src/Crime/Crime.ts` @ v3.0.1 and parity-tested against the
 * vendored table. The crime table itself is NOT hardcoded here — the driver
 * reads it from `ns.singularity.getCrimeStats`, exactly as the faction slice
 * reads requirements from the game.
 *
 * The one thing to get right: KARMA IS STORED POSITIVE and SUBTRACTED. A crime
 * with `karma: 0.1` moves the player's karma DOWN by 0.1 on success. Treating
 * it as an addition inverts every karma decision the game has. */

/** CONSTANTS.IntelligenceCrimeWeight @ v3.0.1. */
export const INTELLIGENCE_CRIME_WEIGHT = 0.025;
/** CONSTANTS.MaxSkillLevel @ v3.0.1. */
export const MAX_SKILL_LEVEL = 975;

export interface CrimeStats {
  type: string;
  timeMs: number;
  money: number;
  difficulty: number;
  /** Positive; subtracted from karma on success. */
  karma: number;
  kills: number;
  weights: Record<string, number>;
  exp: Record<string, number>;
  /** The game's own answer from `ns.singularity.getCrimeChance`, when the
   *  caller has it.
   *
   *  Preferred over recomputing, and not as a shortcut: the closed-form below
   *  is a transcription, so if it ever drifts from the game the OBSERVED value
   *  is the one that is actually true. The formula stays for the simulator and
   *  for planning hypotheticals the game cannot be asked about. */
  chance?: number;
}

export interface CrimePerson {
  skills: Record<string, number>;
  mults: {
    crime_success: number;
    crime_money: number;
    hacking_exp?: number;
    strength_exp?: number;
    defense_exp?: number;
    dexterity_exp?: number;
    agility_exp?: number;
    charisma_exp?: number;
  };
}

export interface CrimeContext {
  /** currentNodeMults.CrimeSuccessRate. */
  crimeSuccessRate: number;
  /** currentNodeMults.CrimeMoney. */
  crimeMoney: number;
  /** currentNodeMults.CrimeExpGain. */
  crimeExp?: number;
}

function intelligenceBonus(intelligence: number, weight = 1): number {
  return 1 + (weight * Math.pow(intelligence, 0.8)) / 600;
}

/** `Crime.successRate` @ v3.0.1, capped at 1 — or the game's own answer when
 * the caller supplied one. */
export function successChance(crime: CrimeStats, person: CrimePerson, ctx: CrimeContext): number {
  if (crime.chance !== undefined) return Math.min(1, Math.max(0, crime.chance));
  const skills = person.skills;
  let chance =
    (crime.weights["hacking"] ?? 0) * (skills["hacking"] ?? 0) +
    (crime.weights["strength"] ?? 0) * (skills["strength"] ?? 0) +
    (crime.weights["defense"] ?? 0) * (skills["defense"] ?? 0) +
    (crime.weights["dexterity"] ?? 0) * (skills["dexterity"] ?? 0) +
    (crime.weights["agility"] ?? 0) * (skills["agility"] ?? 0) +
    (crime.weights["charisma"] ?? 0) * (skills["charisma"] ?? 0) +
    INTELLIGENCE_CRIME_WEIGHT * (skills["intelligence"] ?? 0);
  chance /= MAX_SKILL_LEVEL;
  chance /= crime.difficulty;
  chance *= person.mults.crime_success;
  chance *= ctx.crimeSuccessRate;
  chance *= intelligenceBonus(skills["intelligence"] ?? 0, 1);
  return Math.min(chance, 1);
}

/** Expected money per second. Closed-form, because the crime action set is
 * tiny and every term is known: `chance x reward / time`. */
export function moneyPerSec(crime: CrimeStats, person: CrimePerson, ctx: CrimeContext): number {
  const chance = successChance(crime, person, ctx);
  return (chance * crime.money * person.mults.crime_money * ctx.crimeMoney) / (crime.timeMs / 1000);
}

/** Expected KARMA REDUCTION per second — a positive number meaning "karma
 * falls this fast". Player crime failures still apply one-quarter karma. */
export function karmaPerSec(crime: CrimeStats, person: CrimePerson, ctx: CrimeContext): number {
  const chance = successChance(crime, person, ctx);
  return ((0.25 + 0.75 * chance) * crime.karma) / (crime.timeMs / 1000);
}

export function killsPerSec(crime: CrimeStats, person: CrimePerson, ctx: CrimeContext): number {
  return (successChance(crime, person, ctx) * crime.kills) / (crime.timeMs / 1000);
}

/** Expected experience per second, per skill. Failure grants one quarter of
 * ordinary stat experience; intelligence remains success-only. */
export function expPerSec(crime: CrimeStats, person: CrimePerson, ctx: CrimeContext): Record<string, number> {
  const chance = successChance(crime, person, ctx);
  const expected = 0.25 + 0.75 * chance;
  const seconds = crime.timeMs / 1000;
  const out: Record<string, number> = {};
  for (const [skill, amount] of Object.entries(crime.exp)) {
    if (amount === 0) continue;
    const successFactor = skill === "intelligence" ? chance : expected;
    const expMult = skill === "intelligence"
      ? 1
      : person.mults[`${skill}_exp` as keyof CrimePerson["mults"]] ?? 1;
    out[skill] = (successFactor * amount * expMult * (ctx.crimeExp ?? 1)) / seconds;
  }
  return out;
}

/** Exact seconds to move karma from `have` to `target` (both negative, target
 * lower). Closed-form because the rate is constant while skills are — the
 * planner re-evaluates as they change. */
export function secondsToKarma(
  crime: CrimeStats,
  person: CrimePerson,
  ctx: CrimeContext,
  have: number,
  target: number,
): number {
  if (have <= target) return 0;
  const rate = karmaPerSec(crime, person, ctx);
  return rate > 0 ? (have - target) / rate : Infinity;
}

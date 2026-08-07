/** Hand-crafted hacking formulas for the GAME bundle and the planner hot path.
 *
 * These are NOT the vendored game formulas (sim/vendor stays the engine truth
 * for the simulator). They are a slimmed re-derivation optimized around a
 * precomputed HackContext: everything that depends only on the player, their
 * multipliers, and the BitNode (including the per-call Math.pow of the
 * intelligence bonus) is computed ONCE per plan refresh; the per-target calls
 * are then a handful of mult/div/compare with zero object traversal, zero
 * `??` fallbacks, zero function-call indirection.
 *
 * CONTRACT: bit-for-bit identical results to the vendored originals on the
 * numeric domain. Floating-point grouping is preserved deliberately — ctx
 * fields hold exactly the intermediate products the originals form, in the
 * same association order. The contract is enforced OUTSIDE the game by
 * sim/tests/formulas-parity.test.ts (seeded sweeps + edge cases, exact `toBe`
 * against sim/vendor); the access decision is documented in the Formula
 * access section of spec/targeting.md. Any edit here must keep that suite green.
 *
 * Divergences (documented, intentional):
 * - No NaN/undefined guards on server fields: inputs are typed numbers
 *   (compile-time enforced), so the dynamic checks the game needs for
 *   save-file corruption are dead weight here.
 * - `calculateHackingTime`'s typeof checks and the vendored DarknetServer
 *   special case do not exist (we never target darknet servers... yet).
 */

/** BitNode multiplier subset the hacking formulas read. All default 1 (BN1). */
export interface HackNodeMults {
  HackingSpeedMultiplier?: number;
  HackExpGain?: number;
  ScriptHackMoney?: number;
  ServerGrowthRate?: number;
  ServerWeakenRate?: number;
}

export interface HackPlayer {
  skill: number;
  intelligence: number;
  mults: {
    hacking_chance: number;
    hacking_money: number;
    hacking_speed: number;
    hacking_exp: number;
    hacking_grow: number;
  };
}

/** Everything player/BitNode-dependent, precomputed once per plan refresh. */
export interface HackContext {
  skill: number;
  skillPlus50: number;
  /** max(1.75 * skill, 1) — the chance formula's skillMult. */
  chanceSkillMult: number;
  /** 1 + pow(int, 0.8) / 600 — the ONLY pow in the family, now per-refresh. */
  intBonus: number;
  hackingChance: number;
  hackingMoney: number;
  scriptHackMoney: number;
  /** (hacking_speed * HackingSpeedMultiplier) * intBonus — exact grouping of
   * the vendored time denominator. */
  speedDenom: number;
  hackingExp: number;
  hackExpGain: number;
  hackingGrow: number;
  serverGrowthRate: number;
  serverWeakenRate: number;
}

export function makeHackContext(player: HackPlayer, node: HackNodeMults = {}): HackContext {
  const intBonus = 1 + (1 * Math.pow(player.intelligence, 0.8)) / 600;
  const speed = node.HackingSpeedMultiplier ?? 1;
  return {
    skill: player.skill,
    skillPlus50: player.skill + 50,
    chanceSkillMult: Math.max(1.75 * player.skill, 1),
    intBonus,
    hackingChance: player.mults.hacking_chance,
    hackingMoney: player.mults.hacking_money,
    scriptHackMoney: node.ScriptHackMoney ?? 1,
    speedDenom: player.mults.hacking_speed * speed * intBonus,
    hackingExp: player.mults.hacking_exp,
    hackExpGain: node.HackExpGain ?? 1,
    hackingGrow: player.mults.hacking_grow,
    serverGrowthRate: node.ServerGrowthRate ?? 1,
    serverWeakenRate: node.ServerWeakenRate ?? 1,
  };
}

/** = vendored calculateHackingChance (admin-rights guard as a parameter). */
export function hackChance(ctx: HackContext, hackDifficulty: number, requiredHackingSkill: number, hasAdminRights = true): number {
  if (!hasAdminRights || hackDifficulty >= 100) return 0;
  const difficultyMult = (100 - hackDifficulty) / 100;
  const skillChance = (ctx.chanceSkillMult - requiredHackingSkill) / ctx.chanceSkillMult;
  const chance = skillChance * difficultyMult * ctx.hackingChance * ctx.intBonus;
  if (isNaN(chance)) return 0;
  return Math.max(Math.min(chance, 1), 0);
}

/** = vendored calculatePercentMoneyHacked (decimal fraction per thread). */
export function hackPercent(ctx: HackContext, hackDifficulty: number, requiredHackingSkill: number): number {
  if (hackDifficulty >= 100) return 0;
  const difficultyMult = (100 - hackDifficulty) / 100;
  const skillMult = (ctx.skill - (requiredHackingSkill - 1)) / ctx.skill;
  const percent = (difficultyMult * skillMult * ctx.hackingMoney * ctx.scriptHackMoney) / 240;
  return Math.min(1, Math.max(percent, 0));
}

/** = vendored calculateHackingTime, in SECONDS. Grow/weaken derive from it. */
export function hackTimeSeconds(ctx: HackContext, hackDifficulty: number, requiredHackingSkill: number): number {
  let skillFactor = 2.5 * (requiredHackingSkill * hackDifficulty) + 500;
  skillFactor /= ctx.skillPlus50;
  return (5 * skillFactor) / ctx.speedDenom;
}

export function growTimeSeconds(ctx: HackContext, hackDifficulty: number, requiredHackingSkill: number): number {
  return 3.2 * hackTimeSeconds(ctx, hackDifficulty, requiredHackingSkill);
}

export function weakenTimeSeconds(ctx: HackContext, hackDifficulty: number, requiredHackingSkill: number): number {
  return 4 * hackTimeSeconds(ctx, hackDifficulty, requiredHackingSkill);
}

/** = vendored calculateHackingExpGain (per thread). */
export function hackExpGain(ctx: HackContext, baseDifficulty: number): number {
  if (!baseDifficulty) return 0;
  let expGain = 3;
  expGain += baseDifficulty * 0.3;
  return expGain * ctx.hackingExp * ctx.hackExpGain;
}

export function coreBonus(cores = 1): number {
  return 1 + (cores - 1) / 16;
}

/** = vendored getWeakenEffect. */
export function weakenEffect(ctx: HackContext, threads: number, cores = 1): number {
  return 0.05 * threads * coreBonus(cores) * ctx.serverWeakenRate;
}

/** = vendored calculateServerGrowthLog with threads = 1: the per-thread
 * growth log `k`. Precompute per (target, difficulty, cores); growThreads and
 * money projections reuse it. */
export function growthLogPerThread(ctx: HackContext, hackDifficulty: number, serverGrowth: number, cores = 1): number {
  if (!serverGrowth) return -Infinity;
  let adjGrowthLog = Math.log1p(0.03 / hackDifficulty);
  if (adjGrowthLog >= 0.00349388925425578) adjGrowthLog = 0.00349388925425578;
  const serverGrowthPercentage = serverGrowth / 100;
  const serverGrowthPercentageAdjusted = serverGrowthPercentage * ctx.serverGrowthRate;
  return adjGrowthLog * serverGrowthPercentageAdjusted * ctx.hackingGrow * coreBonus(cores) * 1;
}

/** = vendored numCycleForGrowthCorrected with `k` (per-thread growth log)
 * precomputed by the caller instead of re-derived per invocation. Same
 * Newton-Raphson iteration, verbatim — see the vendored original for the
 * extensive derivation comments. Returns integer threads for one grow call
 * to take startMoney to targetMoney. */
export function growThreads(k: number, targetMoney: number, startMoney: number, moneyMax: number): number {
  if (k === -Infinity) return Infinity;
  if (startMoney < 0) startMoney = 0;
  if (targetMoney > moneyMax) targetMoney = moneyMax;
  if (targetMoney <= startMoney) return 0;

  const guess = (targetMoney - startMoney) / (1 + (targetMoney * (1 / 16) + startMoney * (15 / 16)) * k);
  let x = guess;
  let diff;
  do {
    const ox = startMoney + x;
    const newx = (x - ox * Math.log(ox / targetMoney)) / (1 + ox * k);
    diff = newx - x;
    x = newx;
  } while (diff < -1 || diff > 1);
  const ccycle = Math.ceil(x);
  if (ccycle - x > 0.999999) {
    const fcycle = ccycle - 1;
    if (targetMoney <= (startMoney + fcycle) * Math.exp(k * fcycle)) {
      return fcycle;
    }
  }
  if (ccycle >= x + ((diff <= 0 ? -diff : diff) + 0.000001)) {
    return ccycle;
  }
  if (targetMoney <= (startMoney + ccycle) * Math.exp(k * ccycle)) {
    return ccycle;
  }
  return ccycle + 1;
}

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
 *
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacking.ts#L8-L94
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/formulas/grow.ts#L7-L57
 */

/** BitNode multiplier subset the hacking formulas read. All default 1 (BN1). */
export interface HackNodeMults {
  HackingSpeedMultiplier?: number;
  /** Scales the SKILL derived from hacking experience, not the experience
   *  itself. Needed wherever a future hacking level is projected: it is 0.35 in
   *  BN4 and 0.25 in BN9, so omitting it over-projects the level roughly
   *  threefold and makes every projected hack percentage wrong.
   *  Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Person.ts */
  HackingLevelMultiplier?: number;
  HackExpGain?: number;
  ScriptHackMoney?: number;
  /** The fraction of DRAINED money the player actually receives.
   *
   *  Deliberately distinct from `ScriptHackMoney`, which scales how much is
   *  drained from the server. Upstream applies them at different points:
   *  `moneyDrained = moneyAvailable * percentHacked * threads` (percentHacked
   *  carries ScriptHackMoney), the server loses that, and only then is
   *  `moneyGained = moneyDrained * ScriptHackMoneyGain`. So in BN8, where it is
   *  **0**, hacking drains the server at 30% strength and pays the player
   *  nothing at all — which is also why stock manipulation is unaffected by it
   *  (`influenceStockThroughServerHack` reads `moneyDrained`, not `moneyGained`).
   *  Omitting it made every BN8 target look profitable.
   *  Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L568-L616 */
  ScriptHackMoneyGain?: number;
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
  /** Fraction of drained money the player keeps. NOT part of any vendored
   *  formula — it is applied at the call site in NetscriptHelpers — so it lives
   *  on the context for the target solver to price income with. */
  scriptHackMoneyGain: number;
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
    scriptHackMoneyGain: node.ScriptHackMoneyGain ?? 1,
    speedDenom: player.mults.hacking_speed * speed * intBonus,
    hackingExp: player.mults.hacking_exp,
    hackExpGain: node.HackExpGain ?? 1,
    hackingGrow: player.mults.hacking_grow,
    serverGrowthRate: node.ServerGrowthRate ?? 1,
    serverWeakenRate: node.ServerWeakenRate ?? 1,
  };
}

/** = vendored calculateHackingChance (admin-rights guard as a parameter).
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacking.ts#L8-L24 */
export function hackChance(ctx: HackContext, hackDifficulty: number, requiredHackingSkill: number, hasAdminRights = true): number {
  if (!hasAdminRights || hackDifficulty >= 100) return 0;
  const difficultyMult = (100 - hackDifficulty) / 100;
  const skillChance = (ctx.chanceSkillMult - requiredHackingSkill) / ctx.chanceSkillMult;
  const chance = skillChance * difficultyMult * ctx.hackingChance * ctx.intBonus;
  if (isNaN(chance)) return 0;
  return Math.max(Math.min(chance, 1), 0);
}

/** = vendored calculatePercentMoneyHacked (decimal fraction per thread).
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacking.ts#L40-L57 */
export function hackPercent(ctx: HackContext, hackDifficulty: number, requiredHackingSkill: number): number {
  if (hackDifficulty >= 100) return 0;
  const difficultyMult = (100 - hackDifficulty) / 100;
  const skillMult = (ctx.skill - (requiredHackingSkill - 1)) / ctx.skill;
  const percent = (difficultyMult * skillMult * ctx.hackingMoney * ctx.scriptHackMoney) / 240;
  return Math.min(1, Math.max(percent, 0));
}

/** = vendored calculateHackingTime, in SECONDS. Grow/weaken derive from it.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacking.ts#L59-L94 */
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

/** = vendored calculateHackingExpGain (per thread).
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacking.ts#L26-L38 */
export function hackExpGain(ctx: HackContext, baseDifficulty: number): number {
  if (!baseDifficulty) return 0;
  let expGain = 3;
  expGain += baseDifficulty * 0.3;
  return expGain * ctx.hackingExp * ctx.hackExpGain;
}

export function coreBonus(cores = 1): number {
  return 1 + (cores - 1) / 16;
}

/** Security added per thread by a successful hack. The game charges this once
 * per hacking thread and TWICE per grow cycle actually used, so a grow thread
 * fortifies by `GROW_FORTIFY`. Both are the same game constant, and they live
 * here rather than inlined at each weaken-sizing site because every consumer
 * (targeting, jit, bounds, prediction) has to agree with the engine exactly or
 * the weakens under- or over-cover and the farm drifts off min security.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/data/Constants.ts#L10 */
export const HACK_FORTIFY = 0.002;

/** = 2 x HACK_FORTIFY. The factor is `processSingleServerGrowth` fortifying by
 * `2 * ServerFortifyAmount * usedCycles`, not a coincidence. */
export const GROW_FORTIFY = 2 * HACK_FORTIFY;

/** = vendored getWeakenEffect.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/ServerHelpers.ts#L287-L295 */
export function weakenEffect(ctx: HackContext, threads: number, cores = 1): number {
  return 0.05 * threads * coreBonus(cores) * ctx.serverWeakenRate;
}

/** = vendored calculateServerGrowthLog with threads = 1: the per-thread
 * growth log `k`. Precompute per (target, difficulty, cores); growThreads and
 * money projections reuse it.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/formulas/grow.ts#L7-L29 */
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
 * to take startMoney to targetMoney.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/ServerHelpers.ts#L80-L198 */
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

// --- skill levels -----------------------------------------------------------

/** The skill curve, transcribed from `src/PersonObjects/formulas/skill.ts`.
 *
 * Needed outside the simulator so the career panel can say how far a stat is
 * through its current level. A raw experience total cannot answer that: 855
 * defense at 1.2m exp is nearly a level away or nearly there, and the number
 * alone does not say which. Pinned against the vendored original by
 * `sim/tests/formulas-parity.test.ts`.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/formulas/skill.ts#L7-L15 */
export function skillFromExp(exp: number, mult = 1): number {
  // Mult can be 0 in BN12 at a high SF12 level, where the stat never moves.
  if (mult === 0) return 1;
  const value = Math.floor(mult * (32 * Math.log(exp + 534.6) - 200));
  // The upper clamp is the game's, via clampNumber: infinite experience yields
  // Number.MAX_VALUE, not Infinity. Unreachable in play, but the parity
  // contract is bit-for-bit and an exception here would be a real divergence.
  return Math.max(Math.min(value, Number.MAX_VALUE), 1);
}

/** Experience needed to reach a skill level — the inverse of skillFromExp.
 *
 * The closed form alone is NOT a reliable inverse: at many levels it lands one
 * or two ULPs below the threshold, so skillFromExp(expForSkill(n)) returns
 * n - 1. The game hits the same wall and corrects for it by walking upward in
 * doubling ULP-scaled steps until the round trip holds; this reproduces that
 * loop exactly, because callers here use the result to decide when a skill
 * gate is reached (evaluator's exp valuation, server-access planning, career
 * targets) and being one level short there is a real mis-plan.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/formulas/skill.ts#L17-L34 */
export function expForSkill(skill: number, mult = 1): number {
  if (mult === 0) return 0;
  let value = Math.exp((skill / mult + 200) / 32) - 534.6;
  const floorSkill = Math.floor(skill);
  if (skill === floorSkill && Number.isFinite(skill) && Number.isFinite(value)) {
    let calcSkill = skillFromExp(value, mult);
    let diff = Math.abs(value * Number.EPSILON);
    let newValue = value;
    while (calcSkill < skill) {
      newValue = value + diff;
      diff *= 2;
      calcSkill = skillFromExp(newValue, mult);
    }
    value = newValue;
  }
  return Math.max(Math.min(value, Number.MAX_VALUE), 0);
}

export interface SkillProgress {
  level: number;
  /** Experience earned since this level began. */
  into: number;
  /** Experience this level spans. */
  span: number;
  /** Fraction of the way to the next level, in [0, 1]. */
  fraction: number;
  remaining: number;
}

/** How far through the current level a stat is.
 *
 * Deliberately a fraction rather than the game's 0-100: every other progress
 * value in this repository is [0, 1], and mixing the two scales is how a bar
 * ends up 100x too long. */
export function skillProgress(exp: number, mult = 1): SkillProgress {
  const level = skillFromExp(exp, mult);
  const base = expForSkill(level, mult);
  const next = expForSkill(level + 1, mult);
  const span = next - base;
  const into = Math.max(0, exp - base);
  return {
    level,
    into,
    span,
    fraction: span > 0 ? Math.max(0, Math.min(1, into / span)) : 1,
    remaining: Math.max(0, next - exp),
  };
}

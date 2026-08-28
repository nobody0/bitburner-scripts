import { describe, expect, test } from "bun:test";
import {
  expForSkill,
  GROW_FORTIFY,
  growthLogPerThread,
  growThreads,
  HACK_FORTIFY,
  hackChance,
  hackExpGain,
  hackPercent,
  hackTimeSeconds,
  growTimeSeconds,
  weakenTimeSeconds,
  makeHackContext,
  weakenEffect,
  skillFromExp,
  skillProgress,
  type HackContext,
} from "../../shared/formulas.ts";
import { mockPerson, mockServer } from "../core/mocks.ts";
import { mulberry32 } from "../core/rng.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { currentNodeMults, replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import {
  calculateGrowTime,
  calculateHackingChance,
  calculateHackingExpGain,
  calculateHackingTime,
  calculatePercentMoneyHacked,
  calculateWeakenTime,
} from "../vendor/bitburner/src/Hacking.ts";
import { numCycleForGrowthCorrected } from "../vendor/bitburner/src/Server/GrowthCycles.ts";
import { calculateServerGrowthLog } from "../vendor/bitburner/src/Server/formulas/grow.ts";
import { getWeakenEffect } from "../core/effects.ts";
import { calculateExp, calculateSkill } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { ServerConstants } from "../vendor/bitburner/src/Server/data/Constants.ts";

/** THE CONTRACT (spec/targeting.md, Formula access): shared/formulas.ts must produce
 * bit-for-bit identical results to the vendored game formulas. Exact `toBe`,
 * no epsilon — floating-point grouping in the hand-crafted versions is
 * deliberately identical. Seeded sweeps across player/server/BitNode space
 * plus the edge cases the originals special-case. */

interface Case {
  person: ReturnType<typeof mockPerson>;
  server: ReturnType<typeof mockServer>;
  ctx: HackContext;
  cores: number;
}

function makeCase(rng: () => number): Case {
  const person = mockPerson();
  person.skills.hacking = 1 + Math.floor(rng() * 5000);
  person.skills.intelligence = Math.floor(rng() * 3000);
  person.mults.hacking_chance = 0.3 + rng() * 2.7;
  person.mults.hacking_money = 0.3 + rng() * 2.7;
  person.mults.hacking_speed = 0.3 + rng() * 2.7;
  person.mults.hacking_exp = 0.3 + rng() * 2.7;
  person.mults.hacking_grow = 0.3 + rng() * 2.7;

  const server = mockServer({
    hostname: "case",
    hasAdminRights: true,
    hackDifficulty: 1 + rng() * 98.9,
    baseDifficulty: 1 + rng() * 99,
    minDifficulty: 1,
    requiredHackingSkill: 1 + Math.floor(rng() * 2000),
    serverGrowth: 1 + Math.floor(rng() * 99),
    moneyMax: 1e3 + rng() * 1e12,
  });

  const ctx = makeHackContext(
    { skill: person.skills.hacking, intelligence: person.skills.intelligence, mults: person.mults },
    {
      HackingSpeedMultiplier: currentNodeMults.HackingSpeedMultiplier,
      HackExpGain: currentNodeMults.HackExpGain,
      ScriptHackMoney: currentNodeMults.ScriptHackMoney,
      ServerGrowthRate: currentNodeMults.ServerGrowthRate,
      ServerWeakenRate: currentNodeMults.ServerWeakenRate,
    },
  );
  return { person, server, ctx, cores: 1 + Math.floor(rng() * 8) };
}

function assertParity({ person, server, ctx, cores }: Case): void {
  const difficulty = server.hackDifficulty!;
  const required = server.requiredHackingSkill!;

  expect(hackChance(ctx, difficulty, required, server.hasAdminRights)).toBe(calculateHackingChance(server, person));
  expect(hackPercent(ctx, difficulty, required)).toBe(calculatePercentMoneyHacked(server, person));
  expect(hackTimeSeconds(ctx, difficulty, required)).toBe(calculateHackingTime(server, person));
  expect(growTimeSeconds(ctx, difficulty, required)).toBe(calculateGrowTime(server, person));
  expect(weakenTimeSeconds(ctx, difficulty, required)).toBe(calculateWeakenTime(server, person));
  expect(hackExpGain(ctx, server.baseDifficulty!)).toBe(calculateHackingExpGain(server, person));
  expect(weakenEffect(ctx, 17, cores)).toBe(getWeakenEffect(17, cores));

  const k = growthLogPerThread(ctx, difficulty, server.serverGrowth!, cores);
  expect(k).toBe(calculateServerGrowthLog(server, 1, person, cores));
}

function assertGrowThreadsParity(c: Case, rng: () => number): void {
  const k = growthLogPerThread(c.ctx, c.server.hackDifficulty!, c.server.serverGrowth!, c.cores);
  const moneyMax = c.server.moneyMax!;
  const start = rng() * moneyMax;
  const target = start + rng() * (moneyMax - start);
  expect(growThreads(k, target, start, moneyMax)).toBe(
    numCycleForGrowthCorrected(c.server, target, start, c.cores, c.person),
  );
}

const BITNODES: [number, number][] = [
  [1, 1],
  [2, 1],
  [5, 2],
  [12, 4],
];

describe("hand-crafted formulas are bit-identical to vendored game formulas", () => {
  test("sweeps 250 random cases across representative BitNodes", () => {
    for (const [bn, lvl] of BITNODES) {
      replaceCurrentNodeMults(getBitNodeMultipliers(bn, lvl));
      const rng = mulberry32(1000 + bn);
      for (let i = 0; i < 250; i++) {
        const c = makeCase(rng);
        assertParity(c);
        assertGrowThreadsParity(c, rng);
      }
    }
  });

  test("edge cases", () => {
    replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
    const rng = mulberry32(7);
    const c = makeCase(rng);

    // difficulty >= 100: chance and percent are 0
    c.server.hackDifficulty = 100;
    assertParity(c);
    c.server.hackDifficulty = 100.5;
    assertParity(c);

    // unrooted server: chance 0
    c.server.hackDifficulty = 10;
    c.server.hasAdminRights = false;
    assertParity(c);
    c.server.hasAdminRights = true;

    // requirement far above skill: negative chance clamps to 0
    c.server.requiredHackingSkill = 1e9;
    assertParity(c);
    c.server.requiredHackingSkill = 10;

    // zero base difficulty: exp gain 0; zero growth: k = -Infinity, threads Infinity
    c.server.baseDifficulty = 0;
    c.server.serverGrowth = 0;
    assertParity(c);
    expect(growThreads(-Infinity, 100, 1, 1e9)).toBe(
      numCycleForGrowthCorrected(c.server, 100, 1, c.cores, c.person),
    );

    // intelligence 0 (fresh character)
    const fresh = makeCase(mulberry32(8));
    fresh.person.skills.intelligence = 0;
    fresh.ctx = makeHackContext(
      { skill: fresh.person.skills.hacking, intelligence: 0, mults: fresh.person.mults },
      {},
    );
    assertParity(fresh);
  });
});

describe("the skill curve is bit-identical to the vendored one", () => {
  test("levels match across the whole experience range and every multiplier", () => {
    const rng = mulberry32(1337);
    for (let i = 0; i < 4_000; i++) {
      // Log-uniform: the curve is logarithmic, so a linear sweep would spend
      // every sample in the top two levels and test nothing.
      const exp = Math.exp(rng() * 30) - 1;
      const mult = [0, 0.5, 1, 1.2, 2.75][Math.floor(rng() * 5)]!;
      expect(skillFromExp(exp, mult), `exp=${exp} mult=${mult}`).toBe(calculateSkill(exp, mult));
    }
  });

  test("the boundary cases the game guards", () => {
    // BN12 at a high SF12 level drives the multiplier to 0; the stat is pinned.
    expect(skillFromExp(1e12, 0)).toBe(calculateSkill(1e12, 0));
    // Below the first level's threshold the game clamps to 1, not to 0.
    expect(skillFromExp(0)).toBe(calculateSkill(0));
    expect(skillFromExp(0)).toBe(1);
    expect(skillFromExp(Infinity)).toBe(calculateSkill(Infinity));
  });

  test("progress within a level is consistent with the curve", () => {
    for (const exp of [0, 1_000, 1e6, 1.2e6, 1e9]) {
      const progress = skillProgress(exp);
      expect(progress.level).toBe(calculateSkill(exp));
      // The fraction is [0, 1] here where the game reports 0-100.
      expect(progress.fraction).toBeGreaterThanOrEqual(0);
      expect(progress.fraction).toBeLessThanOrEqual(1);
      // Spending exactly `remaining` more experience buys exactly one level.
      expect(calculateSkill(exp + progress.remaining)).toBe(progress.level + 1);
    }
  });
});

describe("the transcribed engine constants match the vendored ones", () => {
  /** These are game facts every weaken-sizing site has to agree with exactly;
   * this pins the shared constants to the engine. */
  test("hack and grow fortify amounts", () => {
    expect(HACK_FORTIFY).toBe(ServerConstants.ServerFortifyAmount);
    // processSingleServerGrowth fortifies by 2 * ServerFortifyAmount * cycles.
    expect(GROW_FORTIFY).toBe(2 * ServerConstants.ServerFortifyAmount);
  });

  test("the weaken amount behind weakenEffect", () => {
    const ctx = makeHackContext({
      skill: 1,
      intelligence: 0,
      mults: {
        hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1,
      },
    }, {});
    // weakenEffect is 0.05/thread at one core in a neutral node; that 0.05 is
    // the same constant the engine subtracts.
    expect(weakenEffect(ctx, 1, 1)).toBe(ServerConstants.ServerWeakenAmount);
  });

  test("grow and weaken run 3.2x and 4x the hack time", () => {
    // Inlined as bare 3.2 / 4 in targeting's RAM-second coefficients and in
    // bounds' upper-bound arithmetic. The engine derives them by multiplying
    // the hack time, so the ratio is exact at every input.
    const rng = mulberry32(4242);
    replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
    for (let i = 0; i < 200; i++) {
      const { person, server, ctx } = makeCase(rng);
      const difficulty = server.hackDifficulty!;
      const required = server.requiredHackingSkill!;
      const hack = hackTimeSeconds(ctx, difficulty, required);
      expect(growTimeSeconds(ctx, difficulty, required)).toBe(hack * 3.2);
      expect(weakenTimeSeconds(ctx, difficulty, required)).toBe(hack * 4);
      // And the vendored side agrees, so the ratio is the engine's, not ours.
      expect(calculateGrowTime(server, person)).toBe(calculateHackingTime(server, person) * 3.2);
      expect(calculateWeakenTime(server, person)).toBe(calculateHackingTime(server, person) * 4);
    }
  });

  test("expForSkill is bit-identical to the vendored calculateExp", () => {
    // skillProgress round-tripped it, but the inverse itself was never pinned
    // against the engine -- and it had drifted. The closed form alone lands one
    // or two ULPs low at many levels, so skillFromExp(expForSkill(n)) returned
    // n - 1; the game corrects for that with a doubling-ULP walk that this
    // transcription had dropped. Callers decide skill gates from the result.
    for (const mult of [0.5, 1, 1.2, 2.75]) {
      for (let skill = 1; skill < 400; skill++) {
        expect(expForSkill(skill, mult), `skill=${skill} mult=${mult}`)
          .toBe(calculateExp(skill, mult));
        // The property that matters to callers: the round trip actually holds.
        // Skill 1 is exempt because a high mult puts level 2 at zero
        // experience, so there is no exp that inverts to 1 -- the game clamps
        // rather than inverting there, and so do we.
        if (skill > 1) {
          expect(skillFromExp(expForSkill(skill, mult), mult), `skill=${skill} mult=${mult}`)
            .toBe(skill);
        }
      }
    }
    // The clamps both sides guard.
    expect(expForSkill(1, 0)).toBe(0);
    expect(expForSkill(Infinity)).toBe(calculateExp(Infinity));
  });
});

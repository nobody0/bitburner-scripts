import { describe, expect, test } from "bun:test";
import {
  growthLogPerThread,
  growThreads,
  hackChance,
  hackExpGain,
  hackPercent,
  hackTimeSeconds,
  growTimeSeconds,
  weakenTimeSeconds,
  makeHackContext,
  weakenEffect,
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
  for (const [bn, lvl] of BITNODES) {
    test(`sweep of 250 random cases in BitNode ${bn} (sf level ${lvl})`, () => {
      replaceCurrentNodeMults(getBitNodeMultipliers(bn, lvl));
      const rng = mulberry32(1000 + bn);
      for (let i = 0; i < 250; i++) {
        const c = makeCase(rng);
        assertParity(c);
        assertGrowThreadsParity(c, rng);
      }
    });
  }

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

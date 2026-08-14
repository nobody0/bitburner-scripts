import { describe, expect, test } from "bun:test";
import { makeHackContext } from "../shared/formulas.ts";
import { computeTargetBands, contendersAt, staticsFromRolls } from "../shared/strategy/bounds.ts";
import { TARGET_BANDS } from "../shared/strategy/target-bands.ts";
import { solveCycle, type TargetStatics } from "../shared/strategy/targeting.ts";
import { SERVER_RANGES, type Range } from "../shared/features/servers.ts";
import { mulberry32 } from "../sim/core/rng.ts";

/** Two obligations for the generated contention table:
 *
 * 1. Staleness pin: the committed file is exactly what the generator computes
 *    from today's transcribed ranges. After a vendor bump changes
 *    shared/features/servers.ts, this failing is the signal to run
 *    `bun run tools/gen-target-bands.ts` — without it the table would keep
 *    describing a previous release's world.
 *
 * 2. Empirical soundness: the table's claim is "an excluded host is never the
 *    RAM-unbound score argmax, for ANY roll". The interval-arithmetic proof
 *    lives in bounds.ts; here whole worlds are rolled with the real ranges and
 *    the actual argmax must always be a listed contender. */

describe("target band table", () => {
  test("committed table matches a fresh computation (staleness pin)", () => {
    expect(computeTargetBands()).toEqual(TARGET_BANDS as never);
  });

  test("bands tile the skill axis in order", () => {
    for (let i = 1; i < TARGET_BANDS.length; i++) {
      expect(TARGET_BANDS[i]!.from).toBe(TARGET_BANDS[i - 1]!.to);
      expect(TARGET_BANDS[i]!.contenders.length).toBeGreaterThan(0);
    }
  });

  test("the argmax of every rolled world is a listed contender", () => {
    const rng = mulberry32(0xba2d5);
    const rollInt = (range: Range | undefined): number => {
      const [min, max] = range ?? [0, 0];
      return min + Math.floor(rng() * (max - min + 1));
    };
    const neutral = { hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1 };
    for (const skill of [5, 25, 60, 150, 400, 900, 1_500]) {
      const ctx = makeHackContext({ skill, intelligence: 0, mults: neutral }, {});
      const contenders = new Set(contendersAt(TARGET_BANDS, skill));
      expect(contenders.size).toBeGreaterThan(0);
      for (let world = 0; world < 40; world++) {
        let best: { host: string; score: number } | undefined;
        for (const [hostname, ranges] of Object.entries(SERVER_RANGES)) {
          if ((ranges.money?.[1] ?? 0) <= 0) continue;
          const statics: TargetStatics = staticsFromRolls(hostname, {
            money: rollInt(ranges.money),
            sec: rollInt(ranges.sec),
            skill: rollInt(ranges.skill),
            growth: rollInt(ranges.growth),
          });
          const solution = solveCycle(ctx, statics);
          if (!solution) continue;
          if (!best || solution.score > best.score) best = { host: hostname, score: solution.score };
        }
        expect(best).toBeDefined();
        if (!contenders.has(best!.host)) {
          console.error("excluded argmax", { skill, world, best, contenders: [...contenders] });
        }
        expect(contenders.has(best!.host)).toBe(true);
      }
    }
  });

  test("the table tells the known early-game story", () => {
    // Fixed-value servers make the low bands exact: n00dles opens the game,
    // joesguns is the classic first upgrade once its skill 10 gate passes.
    expect(contendersAt(TARGET_BANDS, 1)).toContain("n00dles");
    expect(contendersAt(TARGET_BANDS, 1)).not.toContain("joesguns");
    expect(contendersAt(TARGET_BANDS, 50)).toContain("joesguns");
    // The megacorps can only matter once their skill ranges can roll eligible.
    expect(contendersAt(TARGET_BANDS, 500)).not.toContain("ecorp");
    expect(contendersAt(TARGET_BANDS, 1_100)).toContain("ecorp");
  });
});

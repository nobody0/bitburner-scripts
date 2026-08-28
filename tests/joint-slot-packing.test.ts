import { describe, expect, test } from "bun:test";
import { makeHackContext } from "../shared/formulas.ts";
import { solveCycle, type RamCaps, type TargetStatics } from "../shared/strategy/targeting.ts";
import { WORKER_RAM } from "../shared/world.ts";

/** The pipeline-aware score packs hack and grow slots jointly over the same
 * hosts so every scored combination is simultaneously placeable.
 * The joint model admits a cadence only when its resident hack AND grow
 * blocks pack into the host topology together. */

const neutral = { hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1 };

/** True when one hack block plus one grow block can be placed simultaneously
 * (greedy over descending hosts, grow first — matches the solver's model). */
function packsOneBatch(hostBlocksGb: readonly number[], hackGb: number, growGb: number): boolean {
  let growPlaced = false;
  let hackPlaced = false;
  for (const hostGb of hostBlocksGb) {
    let residual = hostGb;
    if (!growPlaced && residual >= growGb) {
      growPlaced = true;
      residual -= growGb;
    }
    if (!hackPlaced && residual >= hackGb) hackPlaced = true;
    if (growPlaced && hackPlaced) return true;
  }
  return false;
}

describe("joint hack+grow slot packing", () => {
  test("a single-host fleet never receives a hack+grow pair it cannot hold at once", () => {
    // Grow-heavy regimes: low growth means many grow threads per stolen
    // fraction. The old independent count returned e.g. H14+G15 (50 GB) for
    // the 26.4 GB single-host topology below — a batch that can never run.
    const cases = [
      { serverGrowth: 20, skill: 300 },
      { serverGrowth: 10, skill: 300 },
      { serverGrowth: 20, skill: 600 },
      { serverGrowth: 5, skill: 600 },
    ];
    for (const { serverGrowth, skill } of cases) {
      const statics: TargetStatics = {
        hostname: "grow-heavy",
        minDifficulty: 10,
        baseDifficulty: 30,
        moneyMax: 1e9,
        requiredHackingSkill: 250,
        serverGrowth,
      };
      const ctx = makeHackContext({ skill, intelligence: 0, mults: neutral }, {});
      const caps: RamCaps = { batchGb: 400, hackBlockGb: 26.4, growBlockGb: 26.4, hostBlocksGb: [26.4], farmGb: 400 };
      const solution = solveCycle(ctx, statics, 1, caps);
      if (!solution) continue; // genuinely infeasible on one small host is a valid answer
      const hackGb = solution.hackThreads * WORKER_RAM.hack;
      const growGb = solution.growThreads * WORKER_RAM.grow;
      expect(packsOneBatch([26.4], hackGb, growGb)).toBe(true);
    }
  });

  test("an early-game fragmented fleet gets a batch whose blocks pack jointly", () => {
    const statics: TargetStatics = {
      hostname: "noodles",
      minDifficulty: 1,
      baseDifficulty: 1,
      moneyMax: 1.75e6,
      requiredHackingSkill: 1,
      serverGrowth: 3_000,
    };
    const hostBlocksGb = [26.4, 16, 4, 4, 4, 4, 4, 4];
    for (const skill of [15, 30, 60, 120]) {
      const ctx = makeHackContext({ skill, intelligence: 0, mults: neutral }, {});
      const caps: RamCaps = { batchGb: 100.5, hackBlockGb: 26.4, growBlockGb: 26.4, hostBlocksGb, farmGb: 134 };
      const solution = solveCycle(ctx, statics, 1, caps);
      expect(solution).toBeDefined();
      const hackGb = solution!.hackThreads * WORKER_RAM.hack;
      const growGb = solution!.growThreads * WORKER_RAM.grow;
      expect(packsOneBatch(hostBlocksGb, hackGb, growGb)).toBe(true);
      // The chosen hack must not be an op only the single largest host can
      // hold while the grow needs that host too — the shape that forced the
      // dispatcher to stretch the landing interval.
      expect(hackGb + growGb).toBeLessThanOrEqual(26.4 + 1e-9);
    }
  });
});

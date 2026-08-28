import { describe, expect, test } from "bun:test";
import { makeHackContext } from "../shared/formulas.ts";
import { depthCapGb } from "../shared/strategy/economics.ts";
import {
  initEvaluator,
  minimumFarmEnvelopeGb,
  SECONDARY_PREP_FARM_HEADROOM,
  stepEvaluator,
  type FleetCapacity,
} from "../shared/strategy/evaluator.ts";
import { solveCycle, type RamCaps, type TargetStatics } from "../shared/strategy/targeting.ts";
import type { ServerView, WorldView } from "../shared/world.ts";

/** Secondary-prep feasibility on a small fleet. Subtracting the farm's full
 * saturation envelope (the minimum-interval role grid) would make
 * `fleetGb - depthCap` zero
 * on every early fleet and a second target could never start prepping. The
 * fixed gate subtracts the farm's minimum sustaining envelope (one slot per
 * role) times a starvation headroom; the income actually lost to a prep
 * reservation is priced by the economics pick, not by this gate. */

const neutral = { hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1 };

const NOODLES: TargetStatics = {
  hostname: "noodles",
  minDifficulty: 1,
  baseDifficulty: 1,
  moneyMax: 1.75e6,
  requiredHackingSkill: 1,
  serverGrowth: 3_000,
};

const SMALL_FLEET_GB = 134;
const SMALL_HOST_BLOCKS = [26.4, 16, 16, 16, 16, 16, 8, 8, 8, 4];

describe("achievable farm envelope", () => {
  test("a small fleet's achievable envelope is fleet-sized, not saturation-sized", () => {
    const ctx = makeHackContext({ skill: 50, intelligence: 0, mults: neutral }, {});
    const caps: RamCaps = {
      batchGb: SMALL_FLEET_GB * 0.75,
      hackBlockGb: 26.4,
      growBlockGb: 26.4,
      hostBlocksGb: SMALL_HOST_BLOCKS,
      farmGb: SMALL_FLEET_GB * 0.75,
    };
    const solution = solveCycle(ctx, NOODLES, 1, caps);
    expect(solution).toBeDefined();
    // The regime under test: saturation dwarfs the fleet by orders of
    // magnitude (the n00dles-at-low-skill measurement was ~8e4 GB).
    const model = { ...solution!, jitSaturationGb: 80_000 };
    expect(depthCapGb(model)).toBeGreaterThan(100 * SMALL_FLEET_GB);

    const envelope = minimumFarmEnvelopeGb(solution!, NOODLES, ctx, SMALL_FLEET_GB, SMALL_HOST_BLOCKS);
    // The minimum pipeline (one slot per role) is a small fraction of even
    // this fleet — the farm survives losing everything above it.
    expect(envelope).toBeGreaterThan(0);
    expect(SECONDARY_PREP_FARM_HEADROOM * envelope).toBeLessThan(SMALL_FLEET_GB);

    // The sustaining envelope leaves RAM for secondary prep; depthCapGb alone
    // would leave exactly zero.
    const farmEnvelopeGb = Math.min(depthCapGb(model), SECONDARY_PREP_FARM_HEADROOM * envelope);
    expect(Math.max(0, SMALL_FLEET_GB - farmEnvelopeGb)).toBeGreaterThan(0);
    expect(Math.max(0, SMALL_FLEET_GB - depthCapGb(model))).toBe(0);
  });

  test("large-fleet behavior is unchanged: saturation still caps the subtrahend", () => {
    const ctx = makeHackContext({ skill: 50, intelligence: 0, mults: neutral }, {});
    const solution = solveCycle(ctx, NOODLES, 1, {
      batchGb: Infinity,
      hackBlockGb: Infinity,
    });
    expect(solution).toBeDefined();
    const model = { ...solution!, jitSaturationGb: 500 };
    // A fleet past saturation: min(saturation, headroom * minimum envelope)
    // can never exceed the saturation ceiling.
    const envelope = minimumFarmEnvelopeGb(solution!, NOODLES, ctx, 1e6, undefined);
    const farmEnvelopeGb = Math.min(depthCapGb(model), SECONDARY_PREP_FARM_HEADROOM * envelope);
    expect(farmEnvelopeGb).toBeLessThanOrEqual(depthCapGb(model));
  });
});

describe("secondary prep on a small fleet", () => {
  const mults = { hacking: 1, hacking_exp: 1, hacking_money: 1, hacking_grow: 1, hacking_speed: 1, hacking_chance: 1 };

  function server(
    hostname: string,
    statics: Pick<ServerView, "minDifficulty" | "baseDifficulty" | "moneyMax" | "requiredHackingSkill" | "serverGrowth">,
    prepped: boolean,
  ): ServerView {
    return {
      hostname,
      hasAdminRights: true,
      purchasedByPlayer: false,
      moneyAvailable: prepped ? statics.moneyMax : statics.moneyMax * 0.1,
      hackDifficulty: prepped ? statics.minDifficulty : statics.baseDifficulty,
      numOpenPortsRequired: 0,
      maxRam: 16,
      usedRam: 0,
      cpuCores: 1,
      ...statics,
    };
  }

  const capacity: FleetCapacity = {
    fleetGb: SMALL_FLEET_GB,
    largestBlockGb: 26.4,
    hostBlocksGb: SMALL_HOST_BLOCKS,
  };

  function view(time: number): WorldView {
    return {
      time,
      player: {
        money: 1e6,
        hackingSkill: 120,
        hackingExp: 1e5,
        intelligence: 0,
        mults,
      },
      servers: [
        // The live farm: tiny, fast, already prepped.
        server("farm-easy", { minDifficulty: 1, baseDifficulty: 1, moneyMax: 1.75e6, requiredHackingSkill: 1, serverGrowth: 3_000 }, true),
        // The upgrade: much richer, in skill range, unprepped.
        server("rich-next", { minDifficulty: 5, baseDifficulty: 15, moneyMax: 5e9, requiredHackingSkill: 100, serverGrowth: 80 }, false),
      ],
      prices: { upgradeHomeRam: Infinity, cloudServer: {}, cloudServerLimit: 0 },
      nodeMults: { ScriptHackMoneyGain: 1, ScriptHackMoney: 1, ServerGrowthRate: 1 },
    };
  }

  test("starts prepping the next target once the farm's first income window elapses", () => {
    let memory = initEvaluator();
    // Pass 1 records the farm as ready; pass 2 runs long after the farm's
    // weaken time, so the first-income-window guard is open.
    ({ memory } = stepEvaluator(view(0), memory, capacity, Infinity));
    expect(memory.directive.farm?.host).toBe("farm-easy");
    const { directive } = stepEvaluator(view(1_800_000), memory, capacity, Infinity);

    expect(directive.farm?.host).toBe("farm-easy");
    expect(directive.prep?.host).toBe("rich-next");
    const prepSegment = directive.segments.find((segment) => segment.kind === "prep");
    expect(prepSegment?.gb ?? 0).toBeGreaterThan(0);
    // Starvation guard: the farm keeps at least the fleet minus the prep
    // reservation, which the gate floors at the head-roomed envelope.
    const farmSegment = directive.segments.find((segment) => segment.kind === "farm");
    expect(farmSegment?.gb ?? 0).toBeGreaterThan(0);
    expect((farmSegment?.gb ?? 0) + (prepSegment?.gb ?? 0)).toBeLessThanOrEqual(SMALL_FLEET_GB + 1e-9);
  });
});

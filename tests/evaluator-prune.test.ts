import { describe, expect, test } from "bun:test";
import type { HackNodeMults } from "../shared/formulas.ts";
import { staticsFromRolls, type ServerGenMults } from "../shared/strategy/bounds.ts";
import {
  initEvaluator,
  stepEvaluator,
  type EvaluatorMemory,
  type FleetCapacity,
} from "../shared/strategy/evaluator.ts";
import { SERVER_RANGES, type Range } from "../shared/features/servers.ts";
import type { ServerView, StockInfluence, WorldView } from "../shared/world.ts";
import { mulberry32 } from "../sim/core/rng.ts";
import { lane } from "./support/lanes.ts";

/** End-to-end proof that the upper-bound prune is decision-free: two
 * evaluators walk the SAME randomized timeline — servers rolled from the real
 * metadata ranges, skill and fleet growing with generation-bumping jumps,
 * targets drifting in and out of prepped, roots appearing, stock influence and
 * a BN8-shaped node in the mix — one with pruning, one without. Every step
 * must produce identical decisions. The companion check that the prune
 * actually FIRES keeps this from passing vacuously. */

interface SimTarget {
  view: ServerView;
}

function rollInt(rng: () => number, range: Range | undefined): number {
  const [min, max] = range ?? [0, 0];
  return min + Math.floor(rng() * (max - min + 1));
}

function rolledNetwork(rng: () => number, gen: ServerGenMults): SimTarget[] {
  const targets: SimTarget[] = [];
  for (const [hostname, ranges] of Object.entries(SERVER_RANGES)) {
    if ((ranges.money?.[1] ?? 0) <= 0) continue;
    const statics = staticsFromRolls(
      hostname,
      {
        money: rollInt(rng, ranges.money),
        sec: rollInt(rng, ranges.sec),
        skill: rollInt(rng, ranges.skill),
        growth: rollInt(rng, ranges.growth),
      },
      gen,
    );
    targets.push({
      view: {
        hostname,
        hasAdminRights: false,
        purchasedByPlayer: false,
        moneyAvailable: statics.moneyMax * rng(),
        moneyMax: statics.moneyMax,
        hackDifficulty: statics.baseDifficulty,
        minDifficulty: statics.minDifficulty,
        baseDifficulty: statics.baseDifficulty,
        requiredHackingSkill: statics.requiredHackingSkill,
        serverGrowth: statics.serverGrowth,
        numOpenPortsRequired: ranges.ports,
        maxRam: 2 ** rollInt(rng, ranges.ramExp),
        usedRam: 0,
        cpuCores: 1,
      },
    });
  }
  return targets;
}

interface Scenario {
  seed: number;
  node: HackNodeMults;
  gen: ServerGenMults;
  stock: boolean;
}

const SCENARIOS: Scenario[] = [
  { seed: 0xf00d_01, node: {}, gen: {}, stock: false },
  { seed: 0xf00d_02, node: { ScriptHackMoney: 0.2, ServerGrowthRate: 0.8 }, gen: { ServerMaxMoney: 0.5, ServerStartingSecurity: 1.5 }, stock: true },
  // BN8: hacked income is exactly zero — the regime where the zero-score
  // fallbacks run and pruning must stand down entirely.
  { seed: 0xf00d_03, node: { ScriptHackMoney: 0.3, ScriptHackMoneyGain: 0, ServerGrowthRate: 0.05 }, gen: { ServerMaxMoney: 0.1, ServerStartingSecurity: 2 }, stock: true },
];

function runTimeline(scenario: Scenario, prune: boolean): {
  decisions: string[];
  memory: EvaluatorMemory;
  gateMs: number;
} {
  const rng = mulberry32(scenario.seed);
  const targets = rolledNetwork(rng, scenario.gen);
  const memory = initEvaluator();
  const decisions: string[] = [];
  let gateMs = 0;

  let time = 0;
  let skill = 5;
  let exp = 100;
  let fleetGb = 32;
  const influence: Record<string, StockInfluence> = {};

  for (let step = 0; step < 400; step++) {
    time += 1_000 + Math.floor(rng() * 4_000);
    // Skill mostly creeps, occasionally jumps a generation's worth.
    skill = Math.min(3_000, skill * (rng() < 0.1 ? 1.05 : 1.005));
    exp *= 1.05;
    // Fleet grows in bursts (server purchases), sometimes past FLEET_DELTA.
    if (rng() < 0.12) fleetGb = Math.min(2 ** 20, fleetGb * (1.05 + rng()));
    // Roots appear as skill allows (port openers assumed to keep pace).
    for (const t of targets) {
      if (!t.view.hasAdminRights && t.view.requiredHackingSkill <= skill && rng() < 0.4) t.view.hasAdminRights = true;
      // Live state drifts: hacks fortify + drain, preps land, weakens finish.
      const roll = rng();
      if (roll < 0.2) {
        t.view.hackDifficulty = t.view.minDifficulty;
        t.view.moneyAvailable = t.view.moneyMax;
      } else if (roll < 0.35) {
        t.view.hackDifficulty = Math.min(100, t.view.hackDifficulty + rng() * 5);
        t.view.moneyAvailable = t.view.moneyMax * rng();
      }
    }
    // Positions open and close; valuePerOp drifts across fingerprint buckets.
    if (scenario.stock && rng() < 0.1) {
      const t = targets[Math.floor(rng() * targets.length)]!;
      if (influence[t.view.hostname]) delete influence[t.view.hostname];
      else influence[t.view.hostname] = { sym: "SYM", side: rng() < 0.5 ? "long" : "short", valuePerOp: Math.exp(rng() * 15) };
    }

    const view: WorldView = {
      time,
      player: {
        money: 1e9,
        hackingSkill: Math.floor(skill),
        hackingExp: exp,
        hackingExpRate: 5,
        intelligence: 0,
        mults: { hacking: 1, hacking_exp: 1, hacking_money: 1, hacking_grow: 1, hacking_speed: 1, hacking_chance: 1 },
      },
      servers: targets.map((t) => ({ ...t.view })),
      prices: { upgradeHomeRam: Infinity, cloudServer: {}, cloudServerLimit: 0 },
      nodeMults: scenario.node,
      ...(scenario.stock ? { stockInfluence: { ...influence } } : {}),
    };
    const capacity: FleetCapacity = {
      fleetGb,
      largestBlockGb: fleetGb / 2,
      hostBlocksGb: [fleetGb / 2, fleetGb / 4, fleetGb / 8, fleetGb / 8],
    };

    const before = performance.now();
    const { directive, switched } = stepEvaluator(view, memory, capacity, 1e12, Infinity, { prune });
    gateMs += performance.now() - before;
    decisions.push(
      [
        directive.farm ? `farm:${directive.farm.host}@${directive.farm.solution.score.toExponential(12)}` : "farm:-",
        directive.prep ? `prep:${directive.prep.host}` : "prep:-",
        switched ? `switch:${switched.from ?? "-"}>${switched.to}` : "",
      ].join(" "),
    );
  }
  return { decisions, memory, gateMs };
}

describe("depth-capped incumbent: the prep pick is rate-based, not score-based", () => {
  // With a fleet far beyond the incumbent's pipeline depth cap, a candidate whose per-GB
  // SCORE is below the incumbent's can still win the prep pick on RATE
  // (economics.ts: rate = score·min(fleetGb, depthCap)). A prune thresholded
  // on raw score removes exactly that candidate; threshold on the incumbent's
  // effective per-GB rate. Preconditions ensure the score threshold would
  // prune the winner, so the
  // test fails loudly if tuning drifts instead of silently covering nothing).
  test("a lower-score deeper-pipeline upgrade survives the prune and wins prep", async () => {
    const { makeHackContext } = await import("../shared/formulas.ts");
    const { solveCycle } = await import("../shared/strategy/targeting.ts");
    const { scoreUpperBound } = await import("../shared/strategy/bounds.ts");
    const { depthCapGb, farmIncomeRate } = await import("../shared/strategy/economics.ts");

    const neutralMults = { hacking: 1, hacking_exp: 1, hacking_money: 1, hacking_grow: 1, hacking_speed: 1, hacking_chance: 1 };
    const skill = 1_000;
    const smallfast = { hostname: "smallfast", minDifficulty: 1, moneyMax: 5e7, requiredHackingSkill: 1, serverGrowth: 100, baseDifficulty: 3 };
    const bigslow = { hostname: "bigslow", minDifficulty: 40, moneyMax: 8e9, requiredHackingSkill: 500, serverGrowth: 40, baseDifficulty: 120 };
    // A third target the prune CAN legitimately drop — poor AND hard, so its
    // bound sits below even the rate threshold (which is ~fleet/depthCap
    // times smaller than the incumbent's raw score) — proving pruning still
    // fires under the corrected threshold.
    const chaff = { hostname: "chaff", minDifficulty: 90, moneyMax: 1e5, requiredHackingSkill: 900, serverGrowth: 5, baseDifficulty: 100 };

    const ctx = makeHackContext({ skill, intelligence: 0, mults: neutralMults }, {});
    const curSolution = solveCycle(ctx, smallfast)!;
    const candSolution = solveCycle(ctx, bigslow)!;
    // The premise is a fleet FAR beyond the incumbent's pipeline depth, so
    // derive it from that depth rather than fixing a literal: the cap scales
    // as 1/BATCH_INTERVAL_S, and a literal quietly stops being "far beyond"
    // when the landing grid tightens.
    const fleetGb = Math.max(depthCapGb(candSolution), depthCapGb(curSolution) * 2);
    // Preconditions that make the pruning distinction observable:
    expect(candSolution.score).toBeLessThan(curSolution.score); // score says keep farming smallfast...
    expect(scoreUpperBound(ctx, bigslow)).toBeLessThan(curSolution.score); // ...and a score threshold would prune bigslow...
    expect(farmIncomeRate(candSolution, fleetGb)).toBeGreaterThan(farmIncomeRate(curSolution, fleetGb) * 1.5); // ...but its RATE wins.

    const serverOf = (statics: typeof smallfast, prepped: boolean): ServerView => ({
      hostname: statics.hostname,
      hasAdminRights: true,
      purchasedByPlayer: false,
      moneyAvailable: prepped ? statics.moneyMax : statics.moneyMax * 0.3,
      moneyMax: statics.moneyMax,
      hackDifficulty: prepped ? statics.minDifficulty : statics.baseDifficulty,
      minDifficulty: statics.minDifficulty,
      baseDifficulty: statics.baseDifficulty,
      requiredHackingSkill: statics.requiredHackingSkill,
      serverGrowth: statics.serverGrowth,
      numOpenPortsRequired: 0,
      maxRam: 64,
      usedRam: 0,
      cpuCores: 1,
    });
    const viewAt = (time: number, skillNow: number): WorldView => ({
      time,
      player: { money: 1e9, hackingSkill: skillNow, hackingExp: 1e9, intelligence: 0, mults: neutralMults },
      servers: [serverOf(smallfast, true), serverOf(bigslow, false), serverOf(chaff, true)],
      prices: { upgradeHomeRam: Infinity, cloudServer: {}, cloudServerLimit: 0 },
    });
    // No hostBlocksGb: the plain E/R score keeps the score-vs-rate gap clean.
    const capacity: FleetCapacity = { fleetGb, largestBlockGb: fleetGb / 2 };

    const run = (prune: boolean): { memory: EvaluatorMemory; preps: (string | undefined)[] } => {
      const memory = initEvaluator();
      const preps: (string | undefined)[] = [];
      for (let step = 0; step < 4; step++) {
        // Goal far enough away that the goal horizon does not undercut the
        // candidate's ~48 min prep (a short horizon rejects it in BOTH runs,
        // which would cover nothing). The >2% skill jumps at steps 2 and 3
        // bump the context generation AFTER the incumbent exists — the first
        // gate has no incumbent, so pruning can only fire on a re-score. Two
        // jumps because on a bump pass the round-robin slice runs before the
        // gate and legitimately solves its one target unpruned (the incumbent
        // is still stale then); the second bump lands while the slice cursor
        // is elsewhere, so the gate is what reaches chaff.
        const skillNow = step < 2 ? skill : skill * (step === 2 ? 1.03 : 1.061);
        const { directive } = stepEvaluator(viewAt(step * 6_000, skillNow), memory, capacity, 1e15, Infinity, { prune });
        preps.push(directive.prep?.host);
      }
      return { memory, preps };
    };
    const pruned = run(true);
    const full = run(false);
    expect(pruned.preps).toEqual(full.preps);
    // The rate-winning upgrade is chosen despite its lower score...
    expect(pruned.preps[pruned.preps.length - 1]).toBe("bigslow");
    expect(pruned.memory.entries.get("bigslow")?.solution).toBeDefined();
    // ...while the prune still fires on the genuinely hopeless target.
    expect(pruned.memory.entries.get("chaff")?.solution).toBeUndefined();
    expect(pruned.memory.prunedSolves).toBeGreaterThan(0);
  });
});

/** A/B comparison over three full seeded scenarios: the same evaluator run
 * twice, pruned and unpruned, and asserted identical. Seconds per scenario,
 * and it reports wall-clock, so it belongs with the measurements rather than
 * the correctness suite. `bun run long hacking`. */
lane({ feature: "hacking" }).describe("upper-bound pruning is decision-free", () => {
  for (const scenario of SCENARIOS) {
    test(`scenario 0x${scenario.seed.toString(16)}: identical decisions with and without pruning`, () => {
      // First pass of each mode warms the JIT; the second pass is measured.
      runTimeline(scenario, true);
      runTimeline(scenario, false);
      const pruned = runTimeline(scenario, true);
      const full = runTimeline(scenario, false);
      expect(pruned.decisions).toEqual(full.decisions);
      expect(full.memory.prunedSolves).toBe(0);
      // Not vacuous: outside the BN8 zero-income scenario the prune must fire.
      if ((scenario.node.ScriptHackMoneyGain ?? 1) > 0) {
        expect(pruned.memory.prunedSolves).toBeGreaterThan(0);
      }
    });
  }
});

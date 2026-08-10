import { describe, expect, test } from "bun:test";
import type { HackNodeMults } from "../../shared/formulas.ts";
import { staticsFromRolls, type ServerGenMults } from "../../shared/strategy/bounds.ts";
import {
  initEvaluator,
  stepEvaluator,
  type EvaluatorMemory,
  type FleetCapacity,
} from "../../shared/strategy/evaluator.ts";
import { SERVER_RANGES, type Range } from "../../shared/features/servers.ts";
import type { ServerView, StockInfluence, WorldView } from "../../shared/world.ts";
import { mulberry32 } from "../core/rng.ts";

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

describe("upper-bound pruning is decision-free", () => {
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
      console.log(
        `prune A/B seed=0x${scenario.seed.toString(16)}: ${pruned.memory.prunedSolves} solves skipped, ` +
          `evaluator time ${pruned.gateMs.toFixed(1)}ms pruned vs ${full.gateMs.toFixed(1)}ms full`,
      );
    });
  }
});

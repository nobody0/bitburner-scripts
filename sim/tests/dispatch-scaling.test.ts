/** How the cost of ONE dispatcher pass scales with pipeline depth.
 *
 * A live run measured the planner at 5 ms per pass with ~1k operations in
 * flight, 30 ms at 10k, and 100 ms (with 851 ms GC spikes) at 21k, at which
 * point it owned the main thread outright: the game's engine cycle and every
 * `netscriptDelay` ride the same timer queue, so ops landed a mean 107 s late
 * and 28,600 batches were skipped on their deadline.
 *
 * `MAX_LIVE_WORKERS` is 400,000 and stays there — the pipeline is meant to
 * reach that depth — so the fix is for the pass to stop scaling with depth,
 * not for the depth to stop growing. This measures exactly that and nothing
 * else: a RATIO between two depths, never a wall-clock budget, because the
 * absolute number is a property of the machine that ran it.
 *
 * Treat the bound as a ratchet in the style of `sim/tests/baselines/jit.json`:
 * tighten it when a change earns it, never loosen it to make a lane green.
 */
import { expect } from "bun:test";
import { trackOp, type Tracked } from "../../shared/strategy/dispatch.ts";
import { initFarm, planFarm, type FarmMemory } from "../../shared/strategy/farm-planner.ts";
import { SimWorld } from "../world.ts";
import type { ServerSpec } from "../core/effects.ts";
import { lane } from "../../tests/support/lanes.ts";

/** A timing measurement, so it runs in its own Bun process rather than beside
 * 150 other files competing for the same cores: measured under a full parallel
 * suite the deep case inflates 3x and the ratio becomes a reading of the
 * machine's load, not of the code. `bun run long hacking`. */
const soak = lane({ feature: "hacking" });

const NETWORK: ServerSpec[] = [{
  hostname: "scale-target",
  hackDifficulty: 30,
  moneyAvailable: 1e9,
  requiredHackingSkill: 500,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
  currentDifficulty: 10,
  currentMoney: 25e9,
}];

/** Landing separation of the real grid, so the seeded ledger has the same
 * shape (one distinct landing per op) the scheduler actually produces. */
const GRID_MS = 5;

interface Seeded {
  world: SimWorld;
  memory: FarmMemory;
}

/** A world with a settled directive and `depth` synthetic operations in flight
 * on the farm target.
 *
 * Seeding through `trackOp` rather than by simulating to depth is deliberate:
 * it is the exported door every index is maintained behind, so the ledger this
 * produces is indistinguishable from an earned one — and reaching this depth by
 * simulation would spend the whole test budget on the engine, not the planner. */
function seed(depth: number): Seeded {
  const world = new SimWorld({ seed: 1, network: NETWORK, homeRam: 4_096, startingMoney: 1_000 });
  world.person.skills.hacking = 1_000;
  const target = world.servers.get("scale-target")!;
  target.hasAdminRights = true;
  target.hackDifficulty = target.minDifficulty;
  target.moneyAvailable = target.moneyMax;

  const memory = initFarm();
  // One pass to settle the directive, so the seeded ops land on the host the
  // planner is actually going to fold.
  planFarm(world.view(), memory, []);
  const host = memory.dispatch.evaluator.directive.farm?.host ?? "scale-target";

  const now = world.clock.now();
  // Land them inside the window the planner actually folds: everything in
  // flight lands before the anchor of the next batch it is about to plan, so
  // seeding past that anchor would produce a ledger the fold filters out
  // entirely and measure nothing.
  const span = Math.max(1_000, memory.dispatch.lastAnchor - now);
  for (let i = 0; i < depth; i++) {
    // Pooled ops (`workerId` set) own no heap block, so seeding them cannot
    // desynchronise the heap from the RAM the world actually has.
    //
    // Support only, and that is load-bearing: `planJitBatches` stops planning
    // once `jitPending.length + inFlight.hack` reaches the depth cap, so
    // seeding hacks would make the DEEP case skip the planning half of the
    // pass entirely and measure less work than the shallow one. Support is
    // also what the ledger is mostly made of — a live pipeline held 8,010
    // grows and 10,936 weakens against 2,186 hacks.
    const kind = i % 3 === 0 ? "grow" : "weaken";
    const tracked: Tracked = {
      hostname: "home",
      target: host,
      kind,
      segment: "farm",
      gb: 1.75,
      wave: false,
      landing: now + GRID_MS + (i / depth) * span,
      workerId: 1_000_000 + i,
      jitRole: kind === "grow" ? "g" : "w2",
      // `strengthThreads` is what the ledger folds; the block size it came
      // from is irrelevant to a cost measurement.
      strengthThreads: 1,
      effectThreads: 1,
    };
    trackOp(memory.dispatch, 1_000_000 + i, tracked);
    memory.dispatch.inFlight[kind]++;
  }
  return { world, memory };
}

/** Fastest of several passes. The minimum is the right statistic here: GC and
 * scheduler noise are one-sided, so the mean measures the machine and the
 * minimum measures the code. */
function passMs(depth: number): number {
  const { world, memory } = seed(depth);
  const view = world.view();
  for (let i = 0; i < 3; i++) planFarm(view, memory, []);
  let best = Infinity;
  for (let i = 0; i < 12; i++) {
    const started = performance.now();
    planFarm(view, memory, []);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

soak.describe("dispatcher pass cost", () => {
  soak.test("does not grow super-linearly with in-flight depth", () => {
    const shallow = passMs(1_000);
    const deep = passMs(20_000);
    const ratio = deep / shallow;
    console.log(
      `bench: pass 1k=${shallow.toFixed(3)}ms 20k=${deep.toFixed(3)}ms ratio=${ratio.toFixed(1)} (20x depth)`,
    );
    // The ratchet, and it is a RATIO because the absolute figure belongs to
    // whichever machine ran it. A 20x depth increase costing more than 20x is
    // superlinear by definition. Observed today: ~0.55ms and ~6.8ms, ratio
    // ~12.5 — linear-with-a-constant, dominated by the whole-ledger rebuild
    // and sort that `launchDueJit` performs twice per pass. Tighten this as
    // that work is removed; never loosen it to make a lane green.
    expect(ratio).toBeLessThan(25);
  });
});

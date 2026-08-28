import { describe, expect, test } from "bun:test";
import {
  BATCH_KINDS,
  JIT_LAUNCH_GUARD_MS,
  MAX_FARM_WORK_PER_PASS,
  SHOTGUN_PUMP_INTERVAL_MS,
  SHOTGUN_LANDING_MARGIN_MS,
  PREP_ORDER_MS,
  requestShareStops,
  SPACER_MS,
  trackOp,
  WORKER_STARTUP_GUARD_MS,
  type DispatchOptions,
} from "../../shared/strategy/dispatch.ts";
import { initFarm, planFarm, reportFailed, type FarmMemory } from "../../shared/strategy/farm-planner.ts";
import { planTake, type PoolRole } from "../../shared/strategy/worker-pool.ts";
import { expForSkill } from "../../shared/formulas.ts";
import { PREPPED_MONEY_FRACTION, PREPPED_SEC_TOLERANCE, solvePrep } from "../../shared/strategy/targeting.ts";
import type { Action, CompletionEvent, HgwAction, WorldView } from "../../shared/world.ts";
import { WORKER_RAM } from "../../shared/world.ts";
import type { ServerSpec } from "../core/effects.ts";
import { calculateExp } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { DEFAULT_NETWORK } from "../network.ts";
import { SimWorld } from "../world.ts";
import { lane } from "../../tests/support/lanes.ts";

/** Virtual-time soaks: minutes of simulated farming to prove the bands and the
 * landing grid hold over a whole run, not at one instant. Out of the default
 * suite — `bun run long hacking`. */
const soak = lane({ feature: "hacking" });

/** A settled JIT pipeline produces hundreds of thousands of samples, which
 * overflows the argument list of a spread-based Math.max/min. Fold instead. */
const maxOf = (values: readonly number[]): number => values.reduce((a, b) => (b > a ? b : a), -Infinity);
const minOf = (values: readonly number[]): number => values.reduce((a, b) => (b < a ? b : a), Infinity);
const pendingBatches = (memory: FarmMemory) => [...memory.dispatch.jitByTarget.values()].flat();
const expectPendingIndex = (memory: FarmMemory): void => {
  const batches = pendingBatches(memory).filter((batch) => batch.ops.length > 0);
  expect(memory.dispatch.pendingJitBatchCount).toBe(batches.length);
  expect(memory.dispatch.pendingJitOpCount).toBe(
    batches.reduce((sum, batch) => sum + batch.ops.length, 0),
  );
  const unstarted = new Map<string, number>();
  for (const batch of batches) {
    if (!batch.started) unstarted.set(batch.target, (unstarted.get(batch.target) ?? 0) + 1);
  }
  expect(memory.dispatch.unstartedJitBatchCountByTarget).toEqual(unstarted);
  const byTarget = new Map<string, { h: number; w1: number; g: number; w2: number }>();
  for (const batch of batches) {
    const counts = byTarget.get(batch.target) ?? { h: 0, w1: 0, g: 0, w2: 0 };
    for (const op of batch.ops) counts[op.role]++;
    byTarget.set(batch.target, counts);
  }
  expect(memory.dispatch.pendingJitRoleCountByTarget).toEqual(byTarget);
};

/** The dispatcher drives the sim exactly as it will drive the game, so these
 * are end-to-end checks of the HWGW engine against the real game effects. */

interface Harness {
  world: SimWorld;
  memory: FarmMemory;
  run(untilMs: number): void;
  /** `duration` is the op's NATIVE duration at the instant it launched.
   * Recomputing it later reads a different security and skill, so any check
   * of the landing arithmetic has to use the value that was actually used. */
  launches: { action: Action; at: number; landing?: number; duration?: number }[];
  completions: { kind: string; at: number; batched: boolean }[];
  samples: { host: string; sec: number; minSec: number; money: number; maxMoney: number }[];
}

const JIT_TEST_NETWORK: ServerSpec[] = [{
  hostname: "jit-target",
  hackDifficulty: 30,
  moneyAvailable: 1e9,
  requiredHackingSkill: 500,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
  currentDifficulty: 10,
  currentMoney: 25e9,
}];

function prepareJitTestWorld(world: SimWorld): void {
  world.person.skills.hacking = 1_000;
  const target = world.servers.get("jit-target")!;
  target.hasAdminRights = true;
  target.hackDifficulty = target.minDifficulty;
  target.moneyAvailable = target.moneyMax;
}

function harness(options: {
  seed?: number;
  homeRam?: number;
  network?: ServerSpec[];
  plan?: DispatchOptions;
  setup?: (world: SimWorld) => void;
  /** Interpose on the view the planner sees. The real driver never reads the
   * player live: it reads `state.topics.player`, a snapshot the controller
   * refreshes on a cadence, so a scenario about a snapshot going stale has to
   * be able to reproduce a stale snapshot. Default is identity, which is the
   * always-fresh case. */
  view?: (view: WorldView, world: SimWorld) => WorldView;
} = {}): Harness {
  const world = new SimWorld({
    seed: options.seed ?? 1,
    network: options.network ?? DEFAULT_NETWORK,
    homeRam: options.homeRam ?? 64,
    startingMoney: 1_000,
  });
  options.setup?.(world);
  let memory = initFarm();
  const launches: { action: Action; at: number; landing?: number; duration?: number }[] = [];
  const completions: { kind: string; at: number; batched: boolean }[] = [];
  const samples: Harness["samples"] = [];
  const batchedOps = new Set<number>();
  let pending: CompletionEvent[] = [];

  const replan = (event?: CompletionEvent): void => {
    if (event) {
      pending.push(event);
      if (event.kind !== "sleep") {
        completions.push({
          kind: event.kind as string,
          at: world.clock.now(),
          batched: event.opId !== undefined && batchedOps.has(event.opId),
        });
      }
    }
    const inbox = pending;
    pending = [];
    const live = world.view();
    const result = planFarm(options.view ? options.view(live, world) : live, memory, inbox, options.plan);
    memory = result.memory;
    const failed: number[] = [];
    let executed = 0;
    for (const action of result.actions) {
      const at = world.clock.now();
      const hgw = action.type === "hack" || action.type === "grow" || action.type === "weaken"
        ? action
        : undefined;
      const duration = hgw ? world.hgwDurationMs(hgw.type, world.servers.get(hgw.target)!) : undefined;
      const landing = hgw && duration !== undefined
        ? at + duration + (hgw.additionalMsec ?? 0)
        : undefined;
      if (world.execute(action)) {
        executed++;
        launches.push({
          action,
          at,
          ...(landing !== undefined ? { landing } : {}),
          ...(duration !== undefined ? { duration } : {}),
        });
        if (
          "additionalMsec" in action &&
          action.additionalMsec !== undefined &&
          action.phase !== "prep" &&
          action.opId !== undefined
        ) {
          batchedOps.add(action.opId);
        }
      } else if ("opId" in action && action.opId !== undefined) {
        failed.push(action.opId);
      }
    }
    if (failed.length > 0) reportFailed(memory, failed);
    const farmHost = memory.dispatch.evaluator.directive.farm?.host;
    const farmServer = farmHost ? world.servers.get(farmHost) : undefined;
    if (farmServer) {
      samples.push({
        host: farmServer.hostname,
        sec: farmServer.hackDifficulty,
        minSec: farmServer.minDifficulty,
        money: farmServer.moneyAvailable,
        maxMoney: farmServer.moneyMax,
      });
    }
    if (world.inFlight() === 0) world.execute({ type: "sleep", ms: executed > 0 ? 200 : 2_000 });
  };

  world.onSettled = replan;
  replan();
  return {
    world,
    get memory() {
      return memory;
    },
    run: (untilMs) => void world.clock.run(() => world.clock.now() > untilMs, untilMs),
    launches,
    completions,
    samples,
  } as Harness;
}

describe("HWGW dispatcher", () => {
  test("one heartbeat plans at most the shared farm work ceiling", () => {
    const world = new SimWorld({
      seed: 14,
      network: JIT_TEST_NETWORK,
      homeRam: 2 ** 20,
      startingMoney: 1e9,
    });
    prepareJitTestWorld(world);

    const memory = planFarm(world.view(), initFarm(), [], { jit: true }).memory;
    expect(memory.dispatch.pendingJitBatchCount).toBeGreaterThan(0);
    expect(memory.dispatch.pendingJitBatchCount).toBeLessThanOrEqual(MAX_FARM_WORK_PER_PASS);
  });

  function reachFirstHackWindow(
    world: SimWorld,
    initial: ReturnType<typeof planFarm>,
  ): { memory: FarmMemory; plannedThreads: number } {
    let memory = initial.memory;
    let inbox: CompletionEvent[] = [];
    world.onSettled = (event) => inbox.push(event);
    for (const action of initial.actions) expect(world.execute(action)).toBe(true);
    // Many batches in flight means each replan pass advances less virtual
    // time; this cap counts passes, not milliseconds.
    for (let pass = 0; pass < 40_000; pass++) {
      const hackBatch = pendingBatches(memory).find((batch) => batch.ops.some((op) => op.kind === "hack"));
      const hack = hackBatch?.ops.find((op) => op.kind === "hack");
      if (!hack) throw new Error("no pending hack");
      const farmCap = memory.dispatch.evaluator.directive.segments.find((segment) => segment.kind === "farm")?.gb ?? 0;
      const launchAt = hack.startAt;
      const hackFits = hack.reservation !== undefined
        || farmCap - memory.dispatch.segmentGb.farm >= hack.threads * WORKER_RAM.hack - 1e-9;
      if (
        hackBatch!.ops.length === 1
        && launchAt <= world.clock.now() + 1e-9
        && hackFits
        && pendingBatches(memory)[0] === hackBatch
      ) {
        return { memory, plannedThreads: hack.threads };
      }
      const result = planFarm(world.view(), memory, inbox, { jit: true });
      inbox = [];
      memory = result.memory;
      for (const action of result.actions) expect(world.execute(action)).toBe(true);
      const nextStart = pendingBatches(memory)
        .flatMap((batch) => batch.ops)
        .reduce((earliest, op) => {
          const due = op.reservation
            ? op.startAt
            : op.reserveAt ?? op.startAt - (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS);
          return due > world.clock.now() ? Math.min(earliest, due) : earliest;
        }, Infinity);
      world.clock.run(() => inbox.length > 0, nextStart);
    }
    throw new Error("hack window did not open at " + world.clock.now() + ": " + JSON.stringify(
      pendingBatches(memory).slice(0, 2).map((batch) => batch.ops.map((op) => ({
        kind: op.kind, startAt: op.startAt, landing: op.landing,
      }))),
    ));
  }

  test("never bypasses the shared investment arbiter with infrastructure buys", () => {
    const world = new SimWorld({ seed: 5, network: DEFAULT_NETWORK, homeRam: 64, startingMoney: 1e15 });
    const planned = planFarm(world.view(), initFarm(), []);
    expect(planned.actions.some((action) =>
      action.type === "buyServer" || action.type === "upgradeServer" ||
      action.type === "upgradeHomeRam" || action.type === "upgradeHomeCore",
    )).toBe(false);
  });

  test("JIT launches slow weaken support before reserving grow and hack RAM", () => {
    const world = new SimWorld({ seed: 2, network: DEFAULT_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    world.person.skills.hacking = 500;
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hasAdminRights = true;
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax;
    }
    // The first pass plans but launches nothing — the earliest weaken is still
    // ~1s out, and holding it outside RAM until its start window is the point
    // of JIT. The property under test is the order, not the pass it lands on.
    let result = planFarm(world.view(), initFarm(), [], { jit: true });
    const farm = result.directive.farm!.host;
    const hgwOf = (r: typeof result) => r.actions.filter(
      (action): action is Extract<Action, { type: "hack" | "grow" | "weaken" }> =>
        (action.type === "hack" || action.type === "grow" || action.type === "weaken") &&
        action.target === farm && action.phase !== "prep",
    );
    let launched = hgwOf(result);
    let inbox: CompletionEvent[] = [];
    world.onSettled = (event) => inbox.push(event);
    for (let pass = 0; pass < 40_000 && launched.length === 0; pass++) {
      for (const action of result.actions) expect(world.execute(action)).toBe(true);
      // Only clock.run advances virtual time; executing a sleep action alone
      // does not. Run to the earliest pending reservation deadline.
      const nextStart = pendingBatches(result.memory)
        .flatMap((batch) => batch.ops)
        .reduce((earliest, op) => {
          const due = op.reservation
            ? op.startAt
            : op.reserveAt ?? op.startAt - (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS);
          return due > world.clock.now() ? Math.min(earliest, due) : earliest;
        }, Infinity);
      world.clock.run(() => inbox.length > 0, nextStart);
      result = planFarm(world.view(), result.memory, inbox, { jit: true });
      inbox = [];
      launched = hgwOf(result);
    }
    expect(launched.length).toBeGreaterThan(0);
    expect(launched.every((action) => action.type === "weaken")).toBe(true);
    expect(pendingBatches(result.memory).some((batch) =>
      batch.ops.some((op) => op.kind === "hack") && batch.ops.some((op) => op.kind === "grow")
    )).toBe(true);
    // Padding is bounded by the launch guard, not the landing grid: an op
    // released at its startAt waits exactly JIT_LAUNCH_GUARD_MS before its
    // native call. Holds at any spacer.
    expect(maxOf(launched.map((action) => action.additionalMsec ?? 0)))
      .toBeLessThanOrEqual(JIT_LAUNCH_GUARD_MS + 1e-6);
  });

  test("active prep drains a smaller JIT allotment without replacing its queue with eager batches", () => {
    const prepSpec: ServerSpec = {
      hostname: "prep-target",
      hackDifficulty: 40,
      moneyAvailable: 1e9,
      requiredHackingSkill: 100,
      serverGrowth: 80,
      numOpenPortsRequired: 0,
      maxRam: 0,
      currentDifficulty: 30,
      currentMoney: 1,
    };
    const world = new SimWorld({
      seed: 12,
      network: [...JIT_TEST_NETWORK, prepSpec],
      homeRam: 4_096,
      startingMoney: 1e9,
    });
    prepareJitTestWorld(world);
    const prepServer = world.servers.get("prep-target")!;
    prepServer.hasAdminRights = true;
    prepServer.hackDifficulty = prepServer.minDifficulty + 10;
    prepServer.moneyAvailable = 1;
    let seeded = planFarm(world.view(), initFarm(), [], { jit: true });
    const ready = reachFirstHackWindow(world, seeded);
    let memory = ready.memory;
    const farmTarget = memory.dispatch.evaluator.directive.farm!.host;
    expect(farmTarget).toBe("jit-target");
    expect(pendingBatches(memory).length).toBeGreaterThan(0);
    expect(pendingBatches(memory).filter((batch) => batch.started).length).toBeGreaterThan(0);

    const prepEntry = memory.dispatch.evaluator.entries.get(prepServer.hostname)!;
    const prepPlan = solvePrep(memory.dispatch.evaluator.ctx!, prepEntry.statics, {
      hackDifficulty: prepServer.hackDifficulty,
      moneyAvailable: prepServer.moneyAvailable,
    });
    const fleetGb = memory.dispatch.evaluator.directive.segments.reduce((sum, segment) => sum + segment.gb, 0);
    const requestedFarmGb = 128;
    const requestedDirective: typeof memory.dispatch.evaluator.directive = {
      ...memory.dispatch.evaluator.directive,
      prep: { host: prepServer.hostname, statics: prepEntry.statics, plan: prepPlan },
      segments: [
        { kind: "prep", gb: fleetGb - requestedFarmGb },
        { kind: "farm", gb: requestedFarmGb },
        { kind: "share", gb: 0 },
      ],
    };
    memory.dispatch.evaluator.directive = requestedDirective;
    memory.dispatch.evaluator.forceGate = false;
    memory.dispatch.evaluator.lastGateAt = world.clock.now();
    const waveId = 9_200_001;
    trackOp(memory.dispatch, waveId, {
      hostname: "home",
      target: prepServer.hostname,
      kind: "weaken",
      segment: "prep",
      gb: 1.75,
      wave: true,
      landing: world.clock.now() + 60_000,
    } as never);
    memory.dispatch.prepInFlight.set(prepServer.hostname, 1);
    memory.dispatch.segmentGb.prep = 1.75;

    const batchIdBefore = memory.dispatch.nextBatchId;
    const pendingBefore = memory.dispatch.pendingJitBatchCount;
    const originalHackThreads = memory.dispatch.jitRuntimeByTarget.get(farmTarget)!.solution.hackThreads;
    const result = planFarm(world.view(), memory, [], { jit: true });
    memory = result.memory;

    // Pending ordered JIT work prevents the eager path from opening beside it.
    expect(memory.dispatch.nextBatchId).toBe(batchIdBefore);
    expect(memory.dispatch.pendingJitBatchCount).toBeGreaterThan(0);
    expect(memory.dispatch.pendingJitBatchCount).toBeLessThanOrEqual(pendingBefore);
    expect(pendingBatches(memory).every((batch) => batch.started)).toBe(true);
    expectPendingIndex(memory);
    expect(memory.dispatch.stats.batchesByKind.hwgw.noHack).toBe(0);

    const effectiveFarmGb = result.directive.segments.find((segment) => segment.kind === "farm")!.gb;
    const effectivePrepGb = result.directive.segments.find((segment) => segment.kind === "prep")!.gb;
    expect(effectiveFarmGb).toBeGreaterThan(requestedFarmGb);
    expect(effectivePrepGb).toBeLessThan(fleetGb - requestedFarmGb);
    expect(result.directive.segments[0]!.kind).toBe("farm");
    expect(result.directive.segments.reduce((sum, segment) => sum + segment.gb, 0)).toBeCloseTo(fleetGb, 9);

    expect(memory.dispatch.jitRuntimeByTarget.get(farmTarget)!.solution.hackThreads).toBe(originalHackThreads);
  });

  test("re-solves an oversized farm shape into the available JIT segment", () => {
    const world = new SimWorld({ seed: 13, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    prepareJitTestWorld(world);
    let memory = planFarm(world.view(), initFarm(), [], { jit: true }).memory;
    const farmTarget = memory.dispatch.evaluator.directive.farm!.host;
    const originalHackThreads = memory.dispatch.jitRuntimeByTarget.get(farmTarget)!.solution.hackThreads;

    // Model the instant after a graceful drain: no pending/resident work, but
    // the evaluator still carries the large-fleet optimum and the runtime cache
    // remembers its last executable shape.
    memory.dispatch.jitByTarget.clear();
    memory.dispatch.jitWakeByTarget.clear();
    memory.dispatch.pendingJitRoleCountByTarget.clear();
    memory.dispatch.unstartedJitBatchCountByTarget.clear();
    memory.dispatch.pendingJitBatchCount = 0;
    memory.dispatch.pendingJitOpCount = 0;
    memory.dispatch.batches.clear();
    const fleetGb = memory.dispatch.evaluator.directive.segments.reduce((sum, segment) => sum + segment.gb, 0);
    const farmGb = 128;
    memory.dispatch.evaluator.directive = {
      ...memory.dispatch.evaluator.directive,
      segments: [
        { kind: "farm", gb: farmGb },
        { kind: "prep", gb: 0 },
        { kind: "share", gb: fleetGb - farmGb },
      ],
    };
    memory.dispatch.evaluator.forceGate = false;
    memory.dispatch.evaluator.lastGateAt = world.clock.now();

    memory = planFarm(world.view(), memory, [], { jit: true }).memory;
    const downscaled = memory.dispatch.jitRuntimeByTarget.get(farmTarget)!;
    expect(downscaled.solution.hackThreads).toBeLessThan(originalHackThreads);
    expect(downscaled.schedule.totalGb).toBeLessThanOrEqual(farmGb + 1e-9);
    expect(memory.dispatch.pendingJitBatchCount).toBeGreaterThan(0);
    expectPendingIndex(memory);
  });

  soak.test("a farm-ready tolerance state can bootstrap into the steady-state JIT envelope", () => {
    const h = harness({
      homeRam: 1_024,
      network: JIT_TEST_NETWORK,
      setup: (world) => {
        prepareJitTestWorld(world);
        const target = world.servers.get("jit-target")!;
        // Both corrections are deliberately larger than the solved
        // minimum-security roles, but remain inside `isPrepped`.
        target.hackDifficulty = target.minDifficulty + 0.25;
        target.moneyAvailable = target.moneyMax * 0.95;
      },
    });
    h.run(600_000);

    expect(h.launches.some((entry) => entry.action.type === "hack" && entry.action.target === "jit-target")).toBe(true);
    expect(h.memory.dispatch.stats.hacks).toBeGreaterThan(0);
  });

  test("a money-reduced started batch launches its hack and stops new leading weakens", () => {
    const world = new SimWorld({ seed: 2, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    prepareJitTestWorld(world);
    const initial = planFarm(world.view(), initFarm(), [], { jit: true });
    const ready = reachFirstHackWindow(world, initial);
    const target = world.servers.get("jit-target")!;
    const before = ready.memory.dispatch.stats.missedWindow["arrival-money"];

    // Its support is already sunk. Reduce the steal, but launch it, then drain
    // only batches which crossed the leading-weaken boundary.
    const nextBatchId = ready.memory.dispatch.nextBatchId;
    const skipped = ready.memory.dispatch.stats.batchesSkippedBy["arrival-money"];
    target.moneyAvailable = target.moneyMax * 0.4;
    const result = planFarm(world.view(), ready.memory, [], { jit: true });
    const hacks = result.actions.filter(
      (action): action is HgwAction => action.type === "hack" && action.target === target.hostname,
    );

    expect(hacks.length).toBeGreaterThan(0);
    expect(hacks.every((action) =>
      action.strengthThreads !== undefined && action.strengthThreads > 0
    )).toBe(true);
    expect(result.memory.dispatch.drainingJitTargets.has(target.hostname)).toBe(true);
    expect(pendingBatches(result.memory).every((batch) => batch.started)).toBe(true);
    expect(result.memory.dispatch.nextBatchId).toBe(nextBatchId);
    expect(result.memory.dispatch.stats.batchesSkippedBy["arrival-money"]).toBe(skipped);
    expect(result.memory.dispatch.stats.missedWindow["arrival-money"]).toBeGreaterThanOrEqual(before + 1);
    expectPendingIndex(result.memory);
    // A reduction is measured as an arrival-money miss, not a skipped batch:
    // the already-started batch still emits its hack.
    const skippedBy = result.memory.dispatch.stats.batchesSkippedBy;
    expect(Object.values(skippedBy).reduce((a, b) => a + b, 0)).toBe(
      result.memory.dispatch.stats.batchesSkipped,
    );
    expect(skippedBy["arrival-money"]).toBe(result.memory.dispatch.stats.batchesSkipped);
    expect(skippedBy.deadline + skippedBy.placement).toBe(0);
  });

  test("a rising hacking level shrinks only the hack's STRENGTH, never the cadence", () => {
    // The whole safety argument for the landing-level projection in one test.
    // Hack percentage is read when the hack lands, so a level rising between
    // plan and landing must reduce what the hack takes — but every GB figure
    // has to stay bit-identical, because role RAM reaches chooseJitSchedule
    // through ceil(holdMs/interval) and a size that moves can move the whole
    // batch interval.
    const build = (expRate: number) => {
      const world = new SimWorld({ seed: 2, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
      prepareJitTestWorld(world);
      const view = world.view();
      // `prepareJitTestWorld` sets the skill directly, so the world's exp total
      // does not correspond to it. State the matching exp explicitly: without
      // it `projectedSkill` correctly refuses to project BELOW the live skill
      // and the whole lookahead is inert.
      const withRate = {
        ...view,
        player: {
          ...view.player,
          hackingExp: expForSkill(view.player.hackingSkill),
          hackingExpRate: expRate,
        },
      };
      return planFarm(withRate, initFarm(), [], { jit: true });
    };

    // The exp curve is exponential, so a rate has to be quoted RELATIVE to the
    // level in play: at skill 1000 the total is ~1e16 and a "large" absolute
    // rate moves nothing. This is two levels per second.
    const flat = build(0);
    const rising = build(expForSkill(1_002) - expForSkill(1_000));

    const hackOf = (result: ReturnType<typeof build>) =>
      pendingBatches(result.memory)[0]!.ops.find((op) => op.kind === "hack")!;
    const flatHack = hackOf(flat);
    const risingHack = hackOf(rising);

    // The reduction happened...
    expect(risingHack.strengthThreads).toBeDefined();
    expect(risingHack.strengthThreads!).toBeLessThan(risingHack.threads);
    expect(flatHack.strengthThreads).toBeUndefined();
    // ...and cost nothing structural: same block, same support, same cadence.
    expect(risingHack.threads).toBe(flatHack.threads);
    expect(rising.memory.dispatch.depthCapGb).toBe(flat.memory.dispatch.depthCapGb);
    const roles = (result: ReturnType<typeof build>) =>
      pendingBatches(result.memory)[0]!.ops
        .map((op) => `${op.role}:${op.threads}`)
        .sort();
    expect(roles(rising)).toEqual(roles(flat));
  });

  test("the EAGER path projects the landing level too, and shotgun stays exempt", () => {
    // The JIT path has always done this; the eager path was passing the
    // identity context factory, justified by a comment that only holds for
    // shotgun. An eager HWGW batch lands a full weaken-time after it launches,
    // which is ample room for a level to move, so it needs the same cap.
    const build = (expRate: number, plan: DispatchOptions) => {
      const world = new SimWorld({ seed: 2, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
      prepareJitTestWorld(world);
      const view = world.view();
      const withRate = {
        ...view,
        player: {
          ...view.player,
          hackingExp: expForSkill(view.player.hackingSkill),
          hackingExpRate: expRate,
        },
      };
      return planFarm(withRate, initFarm(), [], plan);
    };
    const twoLevelsPerSec = expForSkill(1_002) - expForSkill(1_000);
    const hackAction = (result: ReturnType<typeof build>) =>
      result.actions.find(
        (action): action is HgwAction => action.type === "hack",
      )!;

    const flat = hackAction(build(0, { jit: false }));
    const rising = hackAction(build(twoLevelsPerSec, { jit: false }));
    expect(flat.strengthThreads).toBeUndefined();
    expect(rising.strengthThreads).toBeDefined();
    expect(rising.strengthThreads!).toBeLessThan(rising.threads);
    // Structural figures unmoved: the cap is on strength, never on the block.
    expect(rising.threads).toBe(flat.threads);

    // Shotgun lands its whole batch in one engine tick, so there is no
    // launch-to-landing gap and no level to project across.
    const shotgun = hackAction(build(twoLevelsPerSec, { modeOverride: "shotgun" }));
    expect(shotgun.strengthThreads).toBeUndefined();
  });

  test("re-validates arrival security immediately before dispatching a pending hack", () => {
    const world = new SimWorld({ seed: 2, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    prepareJitTestWorld(world);
    const initial = planFarm(world.view(), initFarm(), [], { jit: true });
    const ready = reachFirstHackWindow(world, initial);
    const target = world.servers.get("jit-target")!;
    target.hackDifficulty = target.minDifficulty + PREPPED_SEC_TOLERANCE + 0.25;
    const before = ready.memory.dispatch.stats.missedWindow["arrival-security"];

    const guarded = planFarm(world.view(), ready.memory, [], { jit: true });
    expect(guarded.actions.some((action) => action.type === "hack" && action.target === target.hostname)).toBe(false);
    expect(guarded.memory.dispatch.stats.missedWindow["arrival-security"]).toBe(before + 1);
  });

  test("a missed successor aborts its pending suffix instead of moving it late", () => {
    // The predecessor chain has fixed deadlines. A missed successor and all
    // remaining dependants are removed; late support never pushes H/G behind
    // an already-launched W2.
    const world = new SimWorld({ seed: 2, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    prepareJitTestWorld(world);
    const initial = planFarm(world.view(), initFarm(), [], { jit: true });
    const ready = reachFirstHackWindow(world, initial);
    const target = world.servers.get("jit-target")!;
    const skipped = ready.memory.dispatch.stats.batchesSkippedBy.deadline;
    const missed = ready.memory.dispatch.stats.missedWindow.deadline;

    world.clock.run(() => false, world.clock.now() + JIT_LAUNCH_GUARD_MS + 1);
    const late = planFarm(world.view(), ready.memory, [], { jit: true });

    expect(late.actions.some((action) =>
      action.type === "hack" && action.target === target.hostname
    )).toBe(false);
    expect(late.memory.dispatch.stats.missedWindow.deadline).toBe(missed + 1);
    expect(late.memory.dispatch.stats.batchesSkippedBy.deadline).toBe(skipped + 1);
    // Fixed predecessor deadlines: the missed op's pending suffix was removed,
    // rather than retained and shifted behind the already-launched support.
    const pending = late.memory.dispatch.jitByTarget.get(target.hostname) ?? [];
    expect(pending.flatMap((batch) => batch.ops).some((op) => op.startAt < world.clock.now())).toBe(false);
  });

  test("down-strengths a pending hack when money falls after planning, without re-placing it", () => {
    const world = new SimWorld({ seed: 2, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    prepareJitTestWorld(world);
    const initial = planFarm(world.view(), initFarm(), [], { jit: true });
    const stealFraction = initial.directive.farm!.solution.stealFraction;
    const ready = reachFirstHackWindow(world, initial);
    const target = world.servers.get("jit-target")!;
    target.moneyAvailable = target.moneyMax * (1 - stealFraction / 10);
    const before = ready.memory.dispatch.stats.missedWindow["arrival-money"];
    const allocFailsBefore = ready.memory.dispatch.stats.allocFailsByPhase.jit;

    const guarded = planFarm(world.view(), ready.memory, [], { jit: true });
    const hacks = guarded.actions.filter(
      (action): action is HgwAction =>
        action.type === "hack" && action.target === target.hostname,
    );
    expect(hacks).toHaveLength(1);
    // The BLOCK is untouched: `threads` is what RAM, the role quota and the
    // JIT cadence are sized on, so an arrival-money shrink must not move it.
    // The reduction rides on `strengthThreads`, which Netscript accepts as a
    // fractional `opts.threads`, so the already-committed worker simply does
    // less instead of the reservation being released and re-taken.
    expect(hacks[0]!.threads).toBe(ready.plannedThreads);
    expect(hacks[0]!.strengthThreads).toBeGreaterThan(0);
    expect(hacks[0]!.strengthThreads).toBeLessThan(ready.plannedThreads);
    expect(guarded.memory.dispatch.stats.missedWindow["arrival-money"]).toBe(before + 1);
    expect(guarded.memory.dispatch.stats.allocFailsByPhase.jit).toBe(allocFailsBefore);
  });

  test("a weaken wake does not mistake transient interleave money for the hack's arrival money", () => {
    const world = new SimWorld({ seed: 2, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    prepareJitTestWorld(world);
    const ready = reachFirstHackWindow(world, planFarm(world.view(), initFarm(), [], { jit: true }));
    const target = world.servers.get("jit-target")!;
    target.moneyAvailable = target.moneyMax * 0.4;
    const skipped = ready.memory.dispatch.stats.batchesSkippedBy["arrival-money"];

    const hot = planFarm(world.view(), ready.memory, [], {
      jit: true,
      trigger: { kind: "target-wake", target: target.hostname, source: "completion" },
    });
    const hack = hot.actions.find((action) => action.type === "hack" && action.target === target.hostname);
    expect(hack).toBeDefined();
    expect(hot.memory.dispatch.stats.batchesSkippedBy["arrival-money"]).toBe(skipped);
  });

  test("weaken always runs at full spawned strength; only hack and grow are late-bound", () => {
    // Weaken is deliberately exempt from late binding. Its RAM is already
    // committed by the time it launches, over-weakening clamps harmlessly at
    // minDifficulty, and the surplus IS the ordering insurance the 5 ms
    // landing grid depends on. Hack and grow are the only operations where
    // "too much" costs anything: an oversized hack steals money the batch
    // cannot restore, an oversized grow fortifies past what W2 covers.
    const world = new SimWorld({ seed: 2, network: JIT_TEST_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    prepareJitTestWorld(world);
    let memory = planFarm(world.view(), initFarm(), [], { jit: true }).memory;
    let inbox: CompletionEvent[] = [];
    world.onSettled = (event) => inbox.push(event);

    const weakens: HgwAction[] = [];
    const grows: HgwAction[] = [];
    for (let pass = 0; pass < 400; pass++) {
      const result = planFarm(world.view(), memory, inbox, { jit: true });
      inbox = [];
      memory = result.memory;
      for (const action of result.actions) {
        if (action.type === "weaken") weakens.push(action);
        if (action.type === "grow") grows.push(action);
        expect(world.execute(action)).toBe(true);
      }
      const nextStart = pendingBatches(memory)
        .flatMap((batch) => batch.ops)
        .reduce((earliest, op) => {
          const due = op.reservation
            ? op.startAt
            : op.reserveAt ?? op.startAt - (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS);
          return due > world.clock.now() ? Math.min(earliest, due) : earliest;
        }, Infinity);
      world.clock.run(() => inbox.length > 0, nextStart);
    }

    expect(weakens.length).toBeGreaterThan(0);
    for (const weaken of weakens) expect(weaken.strengthThreads).toBeUndefined();
    // In a clean steady state NO grow should be reduced: the launch-time
    // re-derivation and sizeBatchAtLanding's plan-time sizing read the same
    // predicted ledger, so they agree unless something moved in between (a
    // hack shrunk on the arrival-money brake, a hack cancelled, or an
    // out-of-band money change). That agreement is the useful assertion — a reduction here
    // would mean the two sizings disagree, which is a bug, not a correction.
    // The clamp's own behaviour is pinned as a unit in prediction.test.ts.
    for (const grow of grows) {
      if (grow.strengthThreads !== undefined) {
        expect(grow.strengthThreads).toBeGreaterThan(0);
        expect(grow.strengthThreads).toBeLessThanOrEqual(grow.threads + 1e-9);
      }
    }
  });

  test("a mode-shape switch discards the old pending JIT suffix", () => {
    const world = new SimWorld({ seed: 2, network: DEFAULT_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    world.person.skills.hacking = 500;
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hasAdminRights = true;
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax;
    }

    const hwgw = planFarm(world.view(), initFarm(), [], { jit: true, modeOverride: "hwgw" });
    expect(pendingBatches(hwgw.memory).some((batch) => batch.ops.some((op) => op.role === "w1"))).toBe(true);
    for (const action of hwgw.actions) world.execute(action);

    const hgw = planFarm(world.view(), hwgw.memory, [], { jit: true, modeOverride: "hgw" });
    expect(hgw.memory.dispatch.mode).toBe("hgw");
    expect(pendingBatches(hgw.memory).length).toBeGreaterThan(0);
    expect(pendingBatches(hgw.memory).every((batch) => batch.ops.every((op) => op.role !== "w1"))).toBe(true);
  });

  soak.test("batches land in H -> W1 -> G -> W2 order, one spacer apart", () => {
    const h = harness({
      homeRam: 256,
      network: JIT_TEST_NETWORK,
      setup: prepareJitTestWorld,
    });
    h.run(900_000);

    // Landings are observed from the world, not recomputed from our own
    // arithmetic: this checks the ops really settle in batch order.
    const landings = h.completions
      .filter((c) => c.batched)
      .sort((a, b) => a.at - b.at);
    const lastLanding = landings.at(-1)?.at ?? -Infinity;
    const hacks = landings.filter((l) => l.kind === "hack" && l.at + 3 * SPACER_MS <= lastLanding);
    expect(hacks.length).toBeGreaterThan(0);

    const at = (time: number, kind: string): boolean =>
      landings.some((l) => l.kind === kind && Math.abs(l.at - time) < 1e-6);
    for (const hack of hacks) {
      expect(at(hack.at + SPACER_MS, "weaken")).toBe(true);
      expect(at(hack.at + 2 * SPACER_MS, "grow")).toBe(true);
      expect(at(hack.at + 3 * SPACER_MS, "weaken")).toBe(true);
    }
  });

  /** An IPvGO win against Illuminati multiplies `hacking_speed`
   * (Go/effects/effect.ts calculateMults), which divides every hack, grow and
   * weaken duration at once. It is a discrete step applied at game end — a
   * moment our own Go driver causes.
   *
   * That is a benefit: shorter operations hold their RAM for less time, so the
   * same fleet sustains more depth. These two cases pin the condition on which
   * it IS one. The engine freezes a duration at the instant hack/grow/weaken is
   * invoked, so an op already in flight keeps the landing it was planned for;
   * only ops planned AFTER the step can be got wrong, and only if the planner
   * is still looking at the old multiplier.
   *
   * The converse -- what a STALE multiplier costs -- is not asserted here. Its
   * arithmetic is exact and belongs to `tests/jit-speed-step.test.ts`, which
   * pins it in the default suite for the price of no simulation at all; and its
   * end-to-end consequence is `scenario-jit`'s hacking_speed-step row, which
   * runs the real controller and therefore the real player-snapshot cadence.
   * This fixture farms for about a minute of virtual time, which is shorter
   * than the weaken it would have to plan stale, so a stale window wide enough
   * to matter here outlives the pipeline it was supposed to disturb.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L537-L561 */
  const SPEED_STEP = 1.25;
  /** Inside the window where this fixture actually runs a settled pipeline —
   * its first batch lands around 251 s and it farms for about a minute after
   * that, so a step here has complete batches on both sides of it. */
  const STEP_AT_MS = 280_000;

  /** 8 GB of home is what makes the pipeline dense enough to have batches
   * either side of a step: at 256 GB this fixture completes a single HWGW
   * batch in fifteen minutes of virtual time, which can neither straddle a
   * step nor recover from one. */
  const stepHarness = (
    view?: (view: WorldView, world: SimWorld) => WorldView,
  ): Harness => harness({
    homeRam: 8_192,
    network: JIT_TEST_NETWORK,
    setup: prepareJitTestWorld,
    ...(view ? { view } : {}),
  });

  /** The complete batches a run produced, as hack landings whose three
   * covering effects can be looked for one spacer apart. Observed from the
   * world, never recomputed from the planner's own arithmetic. */
  function gridOf(h: Harness): { hacks: { at: number }[]; onGrid: (hack: { at: number }) => boolean } {
    const landings = h.completions.filter((c) => c.batched).sort((a, b) => a.at - b.at);
    const lastLanding = landings.at(-1)?.at ?? -Infinity;
    const at = (time: number, kind: string): boolean =>
      landings.some((l) => l.kind === kind && Math.abs(l.at - time) < 1e-6);
    return {
      hacks: landings.filter((l) => l.kind === "hack" && l.at + 3 * SPACER_MS <= lastLanding),
      onGrid: (hack) =>
        at(hack.at + SPACER_MS, "weaken")
        && at(hack.at + 2 * SPACER_MS, "grow")
        && at(hack.at + 3 * SPACER_MS, "weaken"),
    };
  }

  soak.test("a hacking_speed step keeps every batch on its landing grid", () => {
    let steppedAt: number | undefined;
    const h = stepHarness((view, world) => {
      if (steppedAt === undefined && world.clock.now() > STEP_AT_MS) {
        steppedAt = world.clock.now();
        world.person.mults.hacking_speed *= SPEED_STEP;
        world.recalculateSkills();
      }
      return view;
    });
    h.run(900_000);
    expect(steppedAt).toBeDefined();

    const { hacks, onGrid } = gridOf(h);
    // The step has to fall inside the farming window, or this proves nothing.
    expect(hacks.some((l) => l.at < steppedAt!)).toBe(true);
    expect(hacks.some((l) => l.at > steppedAt!)).toBe(true);
    for (const hack of hacks) expect(onGrid(hack)).toBe(true);

    // A sheared batch shows up here too: an uncovered hack or grow ratchets
    // security above the prepped tolerance.
    for (const sample of h.samples.filter((s) => s.maxMoney > 0)) {
      expect(sample.sec).toBeLessThanOrEqual(sample.minSec + PREPPED_SEC_TOLERANCE);
    }
  }, 180_000);

  soak.test("hgw mode lands H -> G -> W, one spacer apart, and stays in band", () => {
    const h = harness({ homeRam: 256, plan: { modeOverride: "hgw" } });
    h.run(900_000);
    expect(h.memory.dispatch.mode).toBe("hgw");

    const landings = h.completions.filter((c) => c.batched).sort((a, b) => a.at - b.at);
    const lastLanding = landings.at(-1)?.at ?? -Infinity;
    const hacks = landings.filter((l) => l.kind === "hack" && l.at + 2 * SPACER_MS <= lastLanding);
    expect(hacks.length).toBeGreaterThan(3);
    const at = (time: number, kind: string): boolean =>
      landings.some((l) => l.kind === kind && Math.abs(l.at - time) < 1e-6);
    for (const hack of hacks) {
      // Three landings: the grow follows the hack DIRECTLY (no weaken slot),
      // the single weaken lands last.
      expect(at(hack.at + SPACER_MS, "grow")).toBe(true);
      expect(at(hack.at + 2 * SPACER_MS, "weaken")).toBe(true);
      expect(at(hack.at + SPACER_MS, "weaken")).toBe(false);
    }

    // The overscaled grow + double-cover weaken keep the bands exactly as
    // HWGW does — that is what makes the mode swap safe.
    const farmed = h.samples.filter((s) => s.maxMoney > 0);
    for (const sample of farmed) {
      expect(sample.sec).toBeLessThanOrEqual(sample.minSec + PREPPED_SEC_TOLERANCE);
    }
    expect(maxOf(farmed.map((s) => s.money / s.maxMoney))).toBeGreaterThan(0.99);
    // Wall-clock budget, not a behavioural bound: a tight landing grid puts
    // deadlines close together, so this fixture drives far more replan passes
    // over the same 900s of virtual time. Each pass stays sub-millisecond (see
    // the dispatcher bench); only the simulator pays.
  }, 180_000);

  test("never overcommits RAM and never leaks reservations", () => {
    // Draining deliberately asks the old eager engine to stop producing new
    // work once its fixed-depth wave is full. JIT has future scheduler wakes
    // by design and is covered by the live band/order tests above.
    const h = harness({ homeRam: 128, plan: { jit: false } });
    h.run(1_200_000);

    // The sim tracks usage independently of the heap: they must agree.
    for (const server of h.world.servers.values()) {
      expect(server.ramUsed).toBeLessThanOrEqual(server.maxRam + 1e-9);
      const host = h.memory.dispatch.heap.host(server.hostname);
      if (host) expect(host.used).toBeCloseTo(server.ramUsed, 6);
    }
    expect(h.world.records.filter((r) => r.kind === "event" && r.name === "action.failed")).toHaveLength(0);

    // Drain: everything settles and every reservation comes back.
    h.world.clock.run(() => h.world.inFlight() === 0, 4_000_000);
    for (const server of h.world.servers.values()) {
      const host = h.memory.dispatch.heap.host(server.hostname);
      if (host) expect(host.used).toBeCloseTo(server.ramUsed, 6);
    }
  });

  test("never asks ns.exec for a fractional thread count", () => {
    // The fractional strength belongs on
    // `strengthThreads`, where the JIT path already puts it.
    //
    // The fixture has to produce a shortfall or the assertion is vacuous:
    // money just under moneyMax but inside PREPPED_MONEY_FRACTION, so the farm
    // runs rather than preps and the arrival money is genuinely short.
    const shortOfMax = (world: SimWorld): void => {
      prepareJitTestWorld(world);
      const target = world.servers.get("jit-target")!;
      target.moneyAvailable = 0.995 * target.moneyMax;
    };
    let sawShrunkHack = false;
    for (const plan of [{ jit: false }, { modeOverride: "shotgun" as const }]) {
      const h = harness({ homeRam: 128, network: JIT_TEST_NETWORK, setup: shortOfMax, plan });
      h.run(600_000);
      expect(h.launches.length).toBeGreaterThan(0);
      const ops = h.launches
        .map(({ action }) => action)
        .filter((action): action is HgwAction =>
          action.type === "hack" || action.type === "grow" || action.type === "weaken");
      expect(ops.length).toBeGreaterThan(0);
      for (const action of ops) {
        expect(Number.isInteger(action.threads)).toBe(true);
        expect(action.threads).toBeGreaterThanOrEqual(1);
        if (action.strengthThreads !== undefined) {
          expect(action.strengthThreads).toBeLessThanOrEqual(action.threads + 1e-9);
          expect(action.strengthThreads).toBeGreaterThan(0);
          if (action.type === "hack" && action.strengthThreads < action.threads) sawShrunkHack = true;
        }
      }
    }
    // Guards the guard: without a shrunk hack the loop above proves nothing
    // about where the fraction went.
    expect(sawShrunkHack).toBe(true);
  }, 60_000);

  soak.test("keeps the farm target inside its security and money bands", () => {
    const h = harness({ seed: 2, homeRam: 256 });
    h.run(1_800_000);
    expect(h.memory.dispatch.stats.hacks).toBeGreaterThan(0);

    // Sampled over the whole run, not at one arbitrary instant: money dips by
    // the steal fraction right after each hack lands, so the meaningful
    // invariants are (a) security never escapes the band and (b) grow keeps
    // restoring money to the cap.
    const farmed = h.samples.filter((s) => s.maxMoney > 0);
    expect(farmed.length).toBeGreaterThan(20);
    for (const sample of farmed) {
      expect(sample.sec).toBeLessThanOrEqual(sample.minSec + PREPPED_SEC_TOLERANCE);
    }
    const restored = farmed.filter((s) => s.money >= PREPPED_MONEY_FRACTION * s.maxMoney);
    expect(restored.length / farmed.length).toBeGreaterThan(0.5);
    expect(maxOf(farmed.map((s) => s.money / s.maxMoney))).toBeGreaterThan(0.99);
  }, 180_000);

  test("rejected launches roll back their reservation", () => {
    const world = new SimWorld({ seed: 5, network: DEFAULT_NETWORK, homeRam: 64 });
    let memory = initFarm();
    const first = planFarm(world.view(), memory, []);
    memory = first.memory;
    for (const action of first.actions) world.execute(action);

    const second = planFarm(world.view(), memory, []);
    memory = second.memory;
    const usedBefore = memory.dispatch.heap.usedTotal;
    const opIds = second.actions
      .filter((a): a is Extract<Action, { opId?: number }> => "opId" in a && a.opId !== undefined)
      .map((a) => a.opId!);
    expect(opIds.length).toBeGreaterThan(0);
    reportFailed(memory, opIds);
    expect(memory.dispatch.heap.usedTotal).toBeLessThan(usedBefore);
    expect(memory.dispatch.tracked.size).toBe(0);
  });

  test("a failed fragment prevents a distributed weaken from proving min security", () => {
    const world = new SimWorld({ seed: 6, network: DEFAULT_NETWORK, homeRam: 64 });
    let memory = planFarm(world.view(), initFarm(), []).memory;
    const target = memory.dispatch.evaluator.directive.farm?.host ?? "n00dles";
    const landing = 12_345;
    for (const opId of [9_000_001, 9_000_002]) {
      trackOp(memory.dispatch, opId, {
        hostname: "home",
        target,
        kind: "weaken",
        segment: "share",
        gb: 0,
        wave: false,
        landing,
      } as never);
      memory.dispatch.inFlight.weaken++;
    }

    memory = planFarm(world.view(), memory, [{ kind: "weaken", opId: 9_000_001 }]).memory;
    expect(memory.dispatch.failedWeakenGroups.size).toBe(1);
    memory = planFarm(world.view(), memory, [{
      kind: "weaken",
      opId: 9_000_002,
      result: { securityReduced: 1 },
    }]).memory;
    expect(memory.dispatch.failedWeakenGroups.size).toBe(0);
  });

  test("a target wake cannot advance another target's pipeline", () => {
    const world = new SimWorld({
      seed: 11,
      network: JIT_TEST_NETWORK,
      homeRam: 4_096,
      startingMoney: 1_000,
    });
    prepareJitTestWorld(world);
    let memory = planFarm(world.view(), initFarm(), [], { jit: true }).memory;
    const farmTarget = memory.dispatch.evaluator.directive.farm!.host;
    const pendingBefore = pendingBatches(memory).reduce((sum, batch) => sum + batch.ops.length, 0);
    const anchorBefore = memory.dispatch.lastAnchor;
    expect(pendingBefore).toBeGreaterThan(0);
    expectPendingIndex(memory);

    const otherTarget = "wake-only-target";
    const opId = 9_100_001;
    trackOp(memory.dispatch, opId, {
      hostname: "home",
      target: otherTarget,
      kind: "weaken",
      segment: "prep",
      gb: 0,
      wave: false,
      landing: world.clock.now(),
    });
    memory.dispatch.inFlight.weaken++;

    const result = planFarm(world.view(), memory, [{
      kind: "weaken",
      opId,
      target: otherTarget,
      result: { securityReduced: 1 },
    }], { jit: true, trigger: { kind: "target-wake", target: otherTarget, source: "completion" } });
    memory = result.memory;

    expect(result.actions.some((action) =>
      action.type === "hack" || action.type === "grow" || action.type === "weaken"
    )).toBe(false);
    expect(pendingBatches(memory).reduce((sum, batch) => sum + batch.ops.length, 0)).toBe(pendingBefore);
    expectPendingIndex(memory);
    expect(memory.dispatch.lastAnchor).toBe(anchorBefore);
    expect(memory.dispatch.evaluator.directive.farm?.host).toBe(farmTarget);
  });

  test("a dispatcher pass stays well inside the 10ms tick budget", () => {
    // A realistic deep fleet exercises the JIT ledger without spending the
    // test timeout executing a synthetic petabyte-scale pipeline.
    const h = harness({ homeRam: 4_096, network: JIT_TEST_NETWORK, setup: prepareJitTestWorld });
    // Stop before the first native weaken landings drain the filled role
    // envelope; the terminal horizon can otherwise sample a naturally empty
    // instant and turn a load test into a timing lottery.
    h.run(100_000);
    expect(h.memory.dispatch.tracked.size).toBeGreaterThanOrEqual(20);
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      planFarm(h.world.view(), h.memory, []);
      worst = Math.max(worst, performance.now() - start);
    }
    expect(worst).toBeLessThan(10);
  });
});

// --- prep waves and the in-flight ledger --------------------------------------

describe("prep waves", () => {
  /** Pre-rooted world with every server at min security; `moneyFraction`
   * controls whether targets start prepped. Returns a fresh plan closure. */
  function prepWorld(moneyFraction: number, jit = true) {
    const world = new SimWorld({ seed: 3, network: DEFAULT_NETWORK, homeRam: 256, startingMoney: 1e9 });
    world.person.skills.hacking = 500;
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hasAdminRights = true;
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax * moneyFraction;
    }
    let memory = initFarm();
    const plan = (completions: CompletionEvent[] = []) => {
      const result = planFarm(world.view(), memory, completions, { jit });
      memory = result.memory;
      return result;
    };
    return { world, plan, memory: () => memory };
  }

  test("the grow phase launches W2 before atomic grows reach their JIT deadlines", () => {
    // A modest deficit (85% money) keeps the whole wave inside the per-pass
    // op cap, so the LAUNCHED thread ratio reflects the plan's G:W2 ratio
    // instead of cap truncation.
    const { world, plan } = prepWorld(0.85);
    const launch = plan(); // gate + prep wave on the (unprepped) farm target, same pass
    const farmHost = launch.directive.farm?.host;
    expect(farmHost).toBeDefined();
    const actions = launch.actions.filter(
      (a): a is Extract<Action, { type: "hack" | "grow" | "weaken" }> =>
        (a.type === "grow" || a.type === "weaken" || a.type === "hack") && a.target === farmHost,
    );
    const waveOps = actions.map((action) => ({
      type: action.type,
      target: action.target,
      source: action.source,
      threads: action.threads,
      landing: world.hgwDurationMs(action.type, world.servers.get(farmHost!)!) + (action.additionalMsec ?? 0),
    }));
    const grows = waveOps.filter((a) => a.type === "grow");
    const weakens = waveOps.filter((a) => a.type === "weaken");
    const growThreads = grows.reduce((sum, a) => sum + a.threads, 0);
    const weakenThreads = weakens.reduce((sum, a) => sum + a.threads, 0);
    // At min security the wave is G + W2 TOGETHER: both kinds present, in
    // roughly the 0.004·G/weakenEffect cover ratio (well under 20%).
    expect(waveOps.some((a) => a.type === "hack")).toBe(false);
    // Covers are resident first; grow descriptors remain outside RAM until
    // their native invocation windows open.
    expect(growThreads).toBe(0);
    expect(weakenThreads).toBeGreaterThan(0);
    expect(launch.memory.dispatch.prepPending.length).toBeGreaterThan(0);

    const byLanding = new Map<number, typeof waveOps>();
    for (const action of waveOps) {
      const landing = action.landing;
      const group = byLanding.get(landing) ?? [];
      group.push(action);
      byLanding.set(landing, group);
    }
    const landings = [...byLanding.entries()].sort((a, b) => a[0] - b[0]);
    expect(landings.every(([, group]) => group.every((action) => action.type === "weaken"))).toBe(true);
  });

  test("pending prep grows actually launch with bounded padding", () => {
    const h = harness({
      seed: 3,
      homeRam: 256,
      setup: (world) => {
        world.person.skills.hacking = 500;
        for (const server of world.servers.values()) {
          if (server.hostname === "home") continue;
          server.hasAdminRights = true;
          server.hackDifficulty = server.minDifficulty;
          server.moneyAvailable = server.moneyMax * 0.85;
        }
      },
    });
    h.run(180_000);
    const prep = h.launches.filter(
      (entry): entry is { action: HgwAction; at: number; landing: number } =>
        (entry.action.type === "grow" || entry.action.type === "weaken") &&
        entry.action.phase === "prep" &&
        entry.landing !== undefined,
    );
    const grows = prep.filter((entry) => entry.action.type === "grow");
    const weakens = prep.filter((entry) => entry.action.type === "weaken");
    expect(grows.length).toBeGreaterThan(0);
    expect(weakens.length).toBeGreaterThan(0);
    expect(minOf(weakens.map((entry) => entry.at))).toBeLessThanOrEqual(minOf(grows.map((entry) => entry.at)));
    expect(maxOf(grows.map((entry) => entry.action.additionalMsec ?? 0))).toBeLessThanOrEqual(
      JIT_LAUNCH_GUARD_MS + SPACER_MS,
    );
    for (const target of new Set(grows.map((entry) => entry.action.target))) {
      const targetGrows = grows
        .filter((entry) => entry.action.target === target)
        .sort((a, b) => a.landing! - b.landing!);
      const targetWeakens = weakens.filter((entry) => entry.action.target === target);
      for (let i = 0; i < targetGrows.length; i++) {
        const grow = targetGrows[i]!;
        const cover = targetWeakens.find((weaken) => Math.abs(weaken.landing! - grow.landing! - PREP_ORDER_MS) < 1e-6);
        expect(cover).toBeDefined();
        // W2's slower native call is resident before its grow is invoked.
        expect(cover!.at).toBeLessThanOrEqual(grow.at);
        if (i > 0) {
          // Pair N cannot grow until pair N-1's W2 restored minimum security.
          expect(targetWeakens.some((weaken) =>
            Math.abs(weaken.landing! - grow.landing! + PREP_ORDER_MS) < 1e-6
          )).toBe(true);
        }
      }
    }
  });

  test("the initial weaken spreads across slabs before any grow launches", () => {
    const { world, plan } = prepWorld(1);
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hackDifficulty = server.minDifficulty + 50;
    }
    const launch = plan();
    const farmHost = launch.directive.farm?.host;
    expect(farmHost).toBeDefined();
    const prepOps = launch.actions.filter(
      (action): action is Extract<Action, { type: "hack" | "grow" | "weaken" }> =>
        (action.type === "grow" || action.type === "weaken" || action.type === "hack") &&
        action.target === farmHost &&
        action.phase === "prep",
    );
    expect(prepOps.some((action) => action.type === "grow")).toBe(false);
    const weakens = prepOps.filter((action) => action.type === "weaken");
    expect(weakens.length).toBeGreaterThan(1);
    expect(new Set(weakens.map((action) => action.source)).size).toBeGreaterThan(1);
    expect(new Set(weakens.map((action) => "additionalMsec" in action ? action.additionalMsec ?? 0 : 0))).toEqual(
      new Set([JIT_LAUNCH_GUARD_MS]),
    );
  });

  test("W1 launches first, then W2, while grow waits outside RAM", () => {
    const { world, plan } = prepWorld(0.85);
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hackDifficulty = server.minDifficulty + 0.25;
    }
    const launch = plan();
    const farmHost = launch.directive.farm!.host;
    const prepOps = launch.actions.filter(
      (action): action is Extract<Action, { type: "hack" | "grow" | "weaken" }> =>
        (action.type === "grow" || action.type === "weaken" || action.type === "hack") &&
        action.target === farmHost &&
        action.phase === "prep",
    );
    expect(prepOps.length).toBeGreaterThan(0);
    expect(prepOps.every((action) => action.type === "weaken")).toBe(true);
    expect(launch.memory.dispatch.prepPending.length).toBeGreaterThan(0);
  });

  test("transient batch landings cannot start prep before the restoring op", () => {
    // This test isolates the legacy eager batch ledger. JIT's support is
    // intentionally launched on later clock edges and has its own end-to-end
    // band tests above.
    const { world, plan, memory } = prepWorld(1, false);
    const batchPass = plan(); // prepped target -> real HWGW batches, first pass
    const farmHost = batchPass.directive.farm!.host;
    const batchOps = batchPass.actions.filter(
      (a): a is Extract<Action, { type: "hack" | "grow" | "weaken" }> =>
        (a.type === "hack" || a.type === "grow" || a.type === "weaken") &&
        a.opId !== undefined && a.phase !== "prep" && a.additionalMsec !== undefined,
    );
    expect(batchOps.length).toBeGreaterThan(0);

    const completion = (a: (typeof batchOps)[number]): CompletionEvent => ({
      kind: a.type,
      opId: a.opId!,
      target: a.target,
      threads: a.threads,
      result: a.type === "hack" ? { success: true, moneyGained: 1 } : {},
    });

    // Model the live midpoint after an ordinary hack landing. The rest of the
    // farm batch is still tracked, so this completion-driven pass must not
    // mistake the deliberately low money/high security state for a prep need.
    const server = world.servers.get(farmHost)!;
    server.moneyAvailable = server.moneyMax * 0.2;
    server.hackDifficulty = server.minDifficulty + 0.5;
    const transientPass = plan([completion(batchOps[0]!)]);
    expect(
      transientPass.actions.filter((a) =>
        (a.type === "grow" || a.type === "weaken") &&
        a.target === farmHost &&
        a.phase === "prep"
      ),
    ).toHaveLength(0);
    expect(memory().dispatch.prepInFlight.get(farmHost) ?? 0).toBe(0);

    // Once every normal batch op has settled, the same genuine desync may
    // launch exactly one prep wave.
    const wavePass = plan(batchOps.slice(1).map(completion));
    const waveOps = wavePass.actions.filter(
      (a) =>
        (a.type === "grow" || a.type === "weaken") &&
        a.target === farmHost &&
        a.phase === "prep",
    );
    expect(waveOps.length).toBeGreaterThan(0);
    const inWave = memory().dispatch.prepInFlight.get(farmHost);
    expect(inWave).toBe(waveOps.length);

    const whileWave = plan();
    expect(memory().dispatch.prepInFlight.get(farmHost)).toBe(inWave);
    expect(
      whileWave.actions.filter((a) => (a.type === "grow" || a.type === "weaken") && a.target === farmHost),
    ).toHaveLength(0);

    // Exp accrued for every landed batch op, not just successful hacks.
    expect(memory().dispatch.stats.expEarned).toBeGreaterThan(0);

    // Once the WAVE ops complete, the counter drains and the next wave fires.
    const waveCompletions: CompletionEvent[] = waveOps.map((a) => ({
      kind: a.type as "grow" | "weaken",
      opId: (a as { opId?: number }).opId!,
      target: farmHost,
      threads: (a as { threads: number }).threads,
      result: {},
    }));
    const afterWave = plan(waveCompletions);
    expect(memory().dispatch.prepInFlight.get(farmHost) ?? 0).toBe(
      afterWave.actions.filter((a) => (a.type === "grow" || a.type === "weaken") && a.target === farmHost).length,
    );
  });
});

// --- shotgun -------------------------------------------------------------------

describe("shotgun mode", () => {
  test("every op of a wave lands the same tick, in launch order H, G, W — and the bands hold", () => {
    const h = harness({
      homeRam: 512,
      plan: { modeOverride: "shotgun" },
      setup: (world) => {
        world.person.skills.hacking = 500;
        for (const server of world.servers.values()) {
          if (server.hostname === "home") continue;
          server.hasAdminRights = true;
          server.hackDifficulty = server.minDifficulty;
          server.moneyAvailable = server.moneyMax;
        }
      },
    });
    h.run(900_000);
    expect(h.memory.dispatch.mode).toBe("shotgun");

    const shotgunPadding = h.launches.flatMap(({ action }) =>
      (action.type === "hack" || action.type === "grow" || action.type === "weaken") &&
        action.phase !== "prep" && action.additionalMsec !== undefined
        ? [action.additionalMsec]
        : []
    );
    expect(shotgunPadding.length).toBeGreaterThan(0);
    expect(minOf(shotgunPadding)).toBeCloseTo(SHOTGUN_LANDING_MARGIN_MS, 6);

    const landings = h.completions.filter((c) => c.batched);
    const hacks = landings.filter((l) => l.kind === "hack");
    expect(hacks.length).toBeGreaterThan(3);

    // Group by landing instant: each wave's hack/grow/weaken share ONE tick.
    const byInstant = new Map<number, string[]>();
    for (const l of landings) {
      const group = byInstant.get(l.at) ?? [];
      group.push(l.kind);
      byInstant.set(l.at, group);
    }
    for (const [, kinds] of byInstant) {
      expect(kinds).toContain("hack");
      expect(kinds).toContain("grow");
      expect(kinds).toContain("weaken");
      // The tie-break proof: completions are recorded in EFFECT order, and a
      // same-tick wave applies each batch as hack -> grows -> weakens before
      // the NEXT batch's hack — the launch order, because equal-deadline
      // timers fire in registration order. Any other transition means the
      // per-batch interleave broke (ops split into blocks, so grows and
      // weakens may repeat within a batch; the hack is always one block).
      const allowed = new Set(["hack>grow", "grow>grow", "grow>weaken", "weaken>weaken", "weaken>hack"]);
      expect(kinds[0]).toBe("hack");
      expect(kinds[kinds.length - 1]).toBe("weaken");
      for (let i = 1; i < kinds.length; i++) {
        expect(allowed.has(`${kinds[i - 1]}>${kinds[i]}`)).toBe(true);
      }
    }

    // After each wave the target is back at (minSec, ~moneyMax): the same-tick
    // sequencing means the sampled state between waves never drifts.
    const farmed = h.samples.filter((s) => s.maxMoney > 0);
    for (const sample of farmed) {
      expect(sample.sec).toBeLessThanOrEqual(sample.minSec + PREPPED_SEC_TOLERANCE);
    }
    expect(maxOf(farmed.map((s) => s.money / s.maxMoney))).toBeGreaterThan(0.99);
    expect(h.memory.dispatch.stats.hacks).toBeGreaterThan(0);
  });

  test("one pass never emits more launch actions than the per-pass bound", () => {
    // Every launch action becomes a synchronous ns.exec in the driver, whose
    // loop has no await and no cap of its own, so an unbounded pass blocks the
    // engine's timers for the length of the whole wave. Shotgun is where that
    // bites: it deliberately fires a full wave per pass and, unlike the JIT
    // path, had no emission ceiling at all. Work not emitted this pass is not
    // lost — an explicit 5ms continuation starts the next bounded chunk.
    const world = new SimWorld({ seed: 5, network: DEFAULT_NETWORK, homeRam: 1_048_576, startingMoney: 1e15 });
    world.person.skills.hacking = 5_000;
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hasAdminRights = true;
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax;
    }
    let memory = initFarm();
    let sawContinuation = false;
    for (let pass = 0; pass < 12; pass++) {
      const result = planFarm(world.view(), memory, [], { modeOverride: "shotgun", jit: true });
      memory = result.memory;
      // Farm launches only: prep waves carry their own independent bound.
      const launches = result.actions.filter(
        (action): action is HgwAction =>
          (action.type === "hack" || action.type === "grow" || action.type === "weaken") &&
          action.phase !== "prep",
      );
      expect(launches.length).toBeLessThanOrEqual(MAX_FARM_WORK_PER_PASS);
      const continuationWake = result.actions.find((action) =>
        action.type === "sleep" && action.purpose === "shotgun"
      );
      if (continuationWake) {
        expect(continuationWake).toEqual({
          type: "sleep",
          ms: SHOTGUN_PUMP_INTERVAL_MS,
          target: result.directive.farm!.host,
          purpose: "shotgun",
        });
        expect(launches.length).toBeGreaterThan(0);
        sawContinuation = true;
        for (const action of result.actions) world.execute(action);
        world.clock.run(() => false, world.clock.now() + SHOTGUN_PUMP_INTERVAL_MS);

        const target = result.directive.farm!.host;
        const completionWake = planFarm(world.view(), memory, [], {
          modeOverride: "shotgun",
          jit: true,
          trigger: { kind: "target-wake", target, source: "completion" },
        });
        expect(completionWake.actions.some((action) =>
          action.type === "hack" || action.type === "grow" || action.type === "weaken"
        )).toBe(false);

        const continuation = planFarm(world.view(), memory, [], {
          modeOverride: "shotgun",
          jit: true,
          trigger: { kind: "shotgun-pump", target },
        });
        const continuedLaunches = continuation.actions.filter((action) =>
          action.type === "hack" || action.type === "grow" || action.type === "weaken"
        );
        expect(continuedLaunches.length).toBeGreaterThan(0);
        expect(continuedLaunches.length).toBeLessThanOrEqual(MAX_FARM_WORK_PER_PASS);
        break;
      }
      for (const action of result.actions) world.execute(action);
      world.clock.run(() => false, world.clock.now() + 25);
    }
    expect(sawContinuation).toBe(true);
  });

  test("falls back to a same-deadline four-op shotgun when no HGW solution fits", () => {
    const world = new SimWorld({ seed: 7, network: DEFAULT_NETWORK, homeRam: 512, startingMoney: 1e9 });
    world.person.skills.hacking = 500;
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hasAdminRights = true;
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax;
    }

    let memory = initFarm();
    const initial = planFarm(world.view(), memory, [], { modeOverride: "shotgun" });
    memory = initial.memory;
    reportFailed(
      memory,
      initial.actions.flatMap((a) => "opId" in a && a.opId !== undefined ? [a.opId] : []),
    );
    const host = initial.directive.farm!.host;
    // Cache the exact state hgwSolutionFor records when the larger H/G/W
    // support shape cannot fit the current generation's RAM caps.
    memory.dispatch.hgw = { host, generation: memory.dispatch.evaluator.generation };

    const fallback = planFarm(world.view(), memory, [], { modeOverride: "shotgun" });
    memory = fallback.memory;
    const tracked = fallback.actions.flatMap((a, launchOrder) => {
      if (!("opId" in a) || a.opId === undefined) return [];
      const entry = memory.dispatch.tracked.get(a.opId);
      return entry?.target === host && entry.landing !== undefined
        ? [{ kind: entry.kind, landing: entry.landing, launchOrder }]
        : [];
    });
    expect(tracked.some((op) => op.kind === "hack")).toBe(true);
    const firstHack = tracked.find((op) => op.kind === "hack")!;
    const ordered = tracked.sort((a, b) => a.launchOrder - b.launchOrder);
    const secondHack = ordered.findIndex((op, index) => index > 0 && op.kind === "hack");
    const firstBatch = ordered.slice(0, secondHack < 0 ? undefined : secondHack).map((op) => op.kind);
    const phases = firstBatch.filter((kind, index) => index === 0 || kind !== firstBatch[index - 1]);
    expect(phases).toEqual(["hack", "weaken", "grow", "weaken"]);
    expect(new Set(tracked.map((op) => op.landing))).toEqual(new Set([firstHack.landing]));
  });

  /* --- entering and leaving shotgun for real ------------------------------
   *
   * The two cases above FORCE the mode with `modeOverride`, which proves the
   * shotgun shape is executed correctly but says nothing about whether we ever
   * notice we should be in it. These drive the mode decision from world state
   * instead: a target whose native hack time has collapsed, and then a move
   * back to a target where JIT still pays.
   *
   * `quick` is deliberately both easy AND rich, because a cheap little server
   * would never win the farm on score and the mode would never be exercised.
   * `deep` starts behind closed ports, which is how a richer target actually
   * arrives mid-run. */
  const QUICK: ServerSpec = {
    hostname: "shotgun-quick",
    hackDifficulty: 3,
    moneyAvailable: 1e10,
    requiredHackingSkill: 1,
    serverGrowth: 100,
    numOpenPortsRequired: 0,
    maxRam: 0,
    currentDifficulty: 1,
    currentMoney: 2.5e11,
  };
  const DEEP: ServerSpec = {
    hostname: "shotgun-deep",
    hackDifficulty: 30,
    moneyAvailable: 1e12,
    requiredHackingSkill: 500,
    serverGrowth: 100,
    numOpenPortsRequired: 5,
    maxRam: 0,
    currentDifficulty: 10,
    currentMoney: 2.5e13,
  };

  /** The late-game regime shotgun exists for, and it takes BOTH levers to
   * reach honestly.
   *
   * Skill alone cannot get there. The experience required for a level grows
   * exponentially, so `calculateExp` overflows a double at about level 22,500
   * -- that is the hard ceiling on hacking skill, and at it `quick` still
   * hacks in 111 ms, just above the boundary. What actually crosses it is the
   * hacking-speed multiplier a late-game player has stacked from augmentations
   * (and, in this repository, from the Go Illuminati reward). A 2x speed
   * multiplier at skill 20,000 puts `quick` at ~63 ms and `deep` at ~1.6 s,
   * which is exactly the split this suite needs. */
  const LATE_GAME_SKILL = 20_000;
  const LATE_GAME_HACK_SPEED = 2;

  function shotgunHarness(): Harness {
    return harness({
      homeRam: 512,
      network: [QUICK, DEEP],
      setup: (world) => {
        world.person.skills.hacking = LATE_GAME_SKILL;
        // Skill and experience MUST agree. The world recomputes skills from
        // experience on the first landed op, so setting the level alone does
        // not survive contact with farming: it snaps to whatever the (zero)
        // experience says and takes the short hack time with it.
        world.person.exp.hacking = calculateExp(LATE_GAME_SKILL, world.person.mults.hacking);
        world.person.mults.hacking_speed = LATE_GAME_HACK_SPEED;
        const quick = world.servers.get(QUICK.hostname)!;
        quick.hasAdminRights = true;
        quick.hackDifficulty = quick.minDifficulty;
        quick.moneyAvailable = quick.moneyMax;
        // Not cracked yet: the farm cannot see it at all.
        world.servers.get(DEEP.hostname)!.hasAdminRights = false;
      },
    });
  }

  test("enters shotgun on its own once the target's hack time collapses", () => {
    const h = shotgunHarness();
    h.run(60_000);

    // The DECISION, from world state alone - no modeOverride anywhere here.
    expect(h.memory.dispatch.evaluator.directive.farm?.host).toBe(QUICK.hostname);
    expect(h.memory.dispatch.mode).toBe("shotgun");

    // And the EXECUTION: batches were actually opened as shotgun batches and
    // landed hacks, rather than the mode being a label on an idle dispatcher.
    const shotgun = h.memory.dispatch.stats.batchesByKind.shotgun;
    expect(shotgun.batches).toBeGreaterThan(0);
    expect(shotgun.hacks).toBeGreaterThan(0);
    expect(h.memory.dispatch.stats.batchesByKind.hwgw.batches).toBe(0);

    // A SETTLED batch has landed every op it launched — `noteBatchLanding`
    // only settles once `landed >= ops`, so the aggregate sums are equal for
    // every kind, in every run that can exist.
    //
    // Pinned because the viewer spent a long time plotting `ops` against
    // `landed` per kind as a "band" whose width was meant to be ops lost in
    // flight. The band is identically zero: the chart drew one curve twice, and
    // the `lostOps` counter behind it could never fire. Op loss shows up on the
    // abandoned counters (a batch that loses an op never settles at all and is
    // evicted instead) and on the global launched/landed/inFlight residual. If
    // this assertion ever fails, that reasoning needs revisiting before any
    // display built on it does.
    for (const kind of BATCH_KINDS) {
      const aggregate = h.memory.dispatch.stats.batchesByKind[kind];
      expect(aggregate.landed).toBe(aggregate.ops);
      expect(aggregate.abandonedOps).toBeGreaterThanOrEqual(aggregate.abandonedLanded);
    }

    // Every settled batch carries its RAM-time integral: each landed op billed
    // from its own launch to its own landing. That is bounded above by the
    // naive `gb × span`, which charges every op for the whole batch span —
    // the gap between the two is exactly what made the naive $/GB·s sawtooth.
    expect(h.memory.dispatch.stats.recentBatches.length).toBeGreaterThan(0);
    for (const settled of h.memory.dispatch.stats.recentBatches) {
      expect(settled.gbMs).toBeGreaterThan(0);
      expect(settled.gbMs).toBeLessThanOrEqual(settled.gb * settled.spanMs + 1e-6);
    }

    // The target stays inside its bands throughout, which is the whole reason
    // same-tick FIFO is an acceptable substitute for ordered deadlines.
    const farmed = h.samples.filter((sample) => sample.maxMoney > 0);
    expect(farmed.length).toBeGreaterThan(0);
    for (const sample of farmed) {
      expect(sample.sec).toBeLessThanOrEqual(sample.minSec + PREPPED_SEC_TOLERANCE);
    }
  });

  test("every op of a wave is padded onto the one shared tick", () => {
    const h = shotgunHarness();
    h.run(30_000);
    expect(h.memory.dispatch.mode).toBe("shotgun");

    const ops = h.launches.filter(({ action }) =>
      (action.type === "hack" || action.type === "grow" || action.type === "weaken")
      && action.phase !== "prep"
    );
    expect(ops.length).toBeGreaterThan(8);

    // THE PROPERTY. additionalMsec is a per-op DELAY the engine adds to that
    // op's own duration, so putting three ops of different lengths on ONE
    // instant means each carries a different padding: exactly the shortfall
    // between its native duration and the wave's window. Everything launched
    // in a single pass is one wave and must converge on a single landing.
    // Getting this wrong does not fail loudly -- the ops simply land spread
    // out, and the same-tick FIFO ordering the whole mode depends on is gone.
    // A wave is a BATCH, not a launch instant: two replans can share a clock
    // instant with different security between them, so grouping by time would
    // mix two waves and prove nothing.
    const waves = new Map<number, typeof ops>();
    for (const op of ops) {
      const opId = (op.action as HgwAction).opId;
      const batchId = opId === undefined ? undefined : h.memory.dispatch.tracked.get(opId)?.batchId;
      if (batchId === undefined) continue;
      waves.set(batchId, [...(waves.get(batchId) ?? []), op]);
    }
    const multiOpWaves = [...waves.values()].filter((wave) => wave.length > 1);
    expect(multiOpWaves.length).toBeGreaterThan(2);

    for (const wave of multiOpWaves) {
      // Every op of the batch converges on ONE instant, however long its own
      // work takes. This is the property the mode is built on.
      const landings = new Set(wave.map((op) => Math.round(op.landing! * 1e6)));
      expect(landings.size, `batch spread over ${landings.size} landings`).toBe(1);

      // And the padding is what put them there: an op's delay exceeds the
      // longest op's delay by exactly the work it does NOT have to do.
      const longest = maxOf(wave.map((op) => op.duration!));
      const anchorPadding = maxOf(
        wave.filter((op) => op.duration === longest)
          .map((op) => (op.action as HgwAction).additionalMsec ?? 0),
      );
      for (const op of wave) {
        const padding = (op.action as HgwAction).additionalMsec ?? 0;
        expect(padding).toBeCloseTo(anchorPadding + (longest - op.duration!), 6);
        // Never negative: the engine rejects a negative additionalMsec.
        expect(padding).toBeGreaterThanOrEqual(0);
      }
    }

    // Weaken is the longest op and anchors the wave, so it needs the LEAST
    // padding; hack is the shortest and therefore waits the longest. If that
    // ordering inverts, the anchor is not being taken from the weaken.
    const paddingOf = (kind: string): number[] =>
      ops.filter(({ action }) => action.type === kind)
        .map(({ action }) => (action as HgwAction).additionalMsec ?? 0);
    const hackPadding = paddingOf("hack");
    const weakenPadding = paddingOf("weaken");
    expect(hackPadding.length).toBeGreaterThan(0);
    expect(weakenPadding.length).toBeGreaterThan(0);
    expect(minOf(hackPadding)).toBeGreaterThan(maxOf(weakenPadding));

    // The anchoring weaken lands exactly one 5ms safety slice after its native
    // duration. Shotgun must not inherit JIT's much larger startup guard.
    expect(SHOTGUN_LANDING_MARGIN_MS).toBe(5);
    for (const padding of weakenPadding) {
      expect(padding).toBeCloseTo(SHOTGUN_LANDING_MARGIN_MS, 6);
    }
  });

  test("returns to JIT when a richer target with a long hack time is cracked", () => {
    const h = shotgunHarness();
    h.run(20_000);
    expect(h.memory.dispatch.mode).toBe("shotgun");
    const shotgunBatches = h.memory.dispatch.stats.batchesByKind.shotgun.batches;
    expect(shotgunBatches).toBeGreaterThan(0);

    // The situation changes: the port openers arrive and the deep target - a
    // hundred times richer, and 26x slower to hack - becomes farmable.
    const deep = h.world.servers.get(DEEP.hostname)!;
    deep.hasAdminRights = true;
    deep.hackDifficulty = deep.minDifficulty;
    deep.moneyAvailable = deep.moneyMax;

    // Long enough to clear the evaluator's 60 s switch dwell and the 30 s mode
    // dwell that follows it.
    h.run(140_000);

    expect(h.memory.dispatch.evaluator.directive.farm?.host).toBe(DEEP.hostname);
    expect(h.memory.dispatch.mode).toBe("hwgw");

    // Both regimes really ran: shotgun batches from the first leg, interleaved
    // HWGW batches from the second. A round trip, not a one-way trip.
    expect(h.memory.dispatch.stats.batchesByKind.shotgun.batches).toBeGreaterThanOrEqual(shotgunBatches);
    expect(h.memory.dispatch.stats.batchesByKind.hwgw.batches).toBeGreaterThan(0);
    expect(h.memory.dispatch.stats.batchesByKind.hwgw.hacks).toBeGreaterThan(0);
    // Explicit budget: this is the one case here that drives two full farming
    // regimes plus the switch between them, so it costs seconds rather than
    // milliseconds and must not ride on the runner's default.
  }, 30_000);
});

// --- pooled workers ------------------------------------------------------------

describe("worker pooling", () => {
  soak.test("proper JIT creates role-isolated workers that are eligible for reuse", () => {
    const h = harness({
      seed: 3,
      homeRam: 4_096,
      network: JIT_TEST_NETWORK,
      plan: { pooling: true, jit: true },
      setup: prepareJitTestWorld,
    });
    // The harness's initial pump is intentionally below the pressure gate;
    // turn pooling on for the live pipeline that follows.
    for (let i = 0; i < 1_100; i++) {
      trackOp(h.memory.dispatch, 900_000 + i, {
        hostname: "ghost",
        target: "",
        kind: "weaken",
        segment: "share",
        gb: 0,
        wave: false,
      } as never);
    }
    h.run(300_000);
    const pooled = h.launches.map((entry) => entry.action).filter(
      (action): action is Extract<Action, { type: "hack" | "grow" | "weaken" }> & { worker: { id: number; spawn: boolean } } =>
        (action.type === "hack" || action.type === "grow" || action.type === "weaken") &&
        "worker" in action && action.worker !== undefined,
    );
    expect(pooled.some((action) => action.worker.spawn)).toBe(true);
    expect(h.memory.dispatch.pool.workers.size).toBeGreaterThan(0);
    expect([...h.memory.dispatch.pool.workers.values()].every((worker) => worker.role !== undefined)).toBe(true);
    const idle = [...h.memory.dispatch.pool.workers.values()].find((worker) => !worker.busy && worker.role)!;
    expect(idle).toBeDefined();
    const takenBy = (role: PoolRole) =>
      planTake(
        h.memory.dispatch.pool,
        idle.kind,
        idle.threads,
        new Set(),
        role,
        { target: idle.target!, generation: idle.generation! },
      ).take
        .map((entry) => entry.worker);
    expect(takenBy(idle.role!)).toContain(idle);
    const otherRole = idle.role === "w1" ? "w2" : "w1";
    expect(takenBy(otherRole)).not.toContain(idle);
  });

  test("pooling stays enabled after it relieves the pressure that enabled it", () => {
    const world = new SimWorld({ seed: 3, network: DEFAULT_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    world.person.skills.hacking = 500;
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hasAdminRights = true;
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax;
    }
    const memory = initFarm();
    const pressureIds: number[] = [];
    for (let i = 0; i < 1_100; i++) {
      const opId = 1_100_000 + i;
      pressureIds.push(opId);
      trackOp(memory.dispatch, opId, {
        hostname: "ghost",
        target: "",
        kind: "weaken",
        segment: "share",
        gb: 0,
        wave: false,
      } as never);
    }

    const first = planFarm(world.view(), memory, [], { pooling: true, jit: true });
    const target = first.directive.farm?.host;
    expect(target).toBeDefined();
    expect(memory.dispatch.jitRuntimeByTarget.get(target!)?.pooling).toBe(true);

    const pressureDone: CompletionEvent[] = pressureIds.map((opId) => ({
      kind: "weaken",
      opId,
      target: "",
      threads: 1,
      result: {},
    }));
    planFarm(world.view(), memory, pressureDone, { pooling: true, jit: true });

    expect(memory.dispatch.tracked.size).toBeLessThan(1_000);
    expect(memory.dispatch.jitRuntimeByTarget.get(target!)?.pooling).toBe(true);
    expect(memory.dispatch.pooling).toBe(true);
  });

  test("repeat batches reuse workers; workerExit frees the reservation", () => {
    // Pure-ledger test: completions are synthesized rather than executed, so
    // it exercises exactly the pool accounting (the game path runs the real
    // serve worker in sim/tests/ns.test.ts). Big home: pooling self-gates on
    // the batch launch period, so the fleet must support full depth.
    const world = new SimWorld({ seed: 3, network: DEFAULT_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    world.person.skills.hacking = 500;
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hasAdminRights = true;
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax;
    }
    let memory = initFarm();
    // Pooling engages only under live-op pressure (it is a browser-RAM relief
    // valve, not a throughput win): seed the ledger past the threshold with
    // inert entries on a host the heap does not know.
    for (let i = 0; i < 1_100; i++) {
      trackOp(memory.dispatch, 1_000_000 + i, {
        hostname: "ghost",
        target: "",
        kind: "weaken",
        segment: "share",
        gb: 0,
        wave: false,
      } as never);
    }
    const plan = (completions: CompletionEvent[] = []) => {
      const result = planFarm(world.view(), memory, completions, { pooling: true, jit: false });
      memory = result.memory;
      return result;
    };

    const first = plan();
    const firstOps = first.actions.filter(
      (a): a is Extract<Action, { type: "hack" | "grow" | "weaken" }> & { worker: { id: number; spawn: boolean } } =>
        (a.type === "hack" || a.type === "grow" || a.type === "weaken") && "worker" in a && a.worker !== undefined,
    );
    expect(firstOps.length).toBeGreaterThan(0);
    // Cold pool: every op spawns.
    expect(firstOps.every((a) => a.worker.spawn)).toBe(true);
    const usedAfterSpawn = memory.dispatch.heap.usedTotal;
    const spawnedWorkers = new Set(firstOps.map((a) => a.worker.id));
    const execsAfterFirst = memory.dispatch.stats.execs;
    const fleetGbAfterFirst = memory.dispatch.evaluator.directive.segments
      .reduce((sum, segment) => sum + segment.gb, 0);

    // All jobs complete -> workers idle; the SECOND wave must reuse them:
    // no new heap use, no new execs, spawn:false everywhere.
    const done: CompletionEvent[] = firstOps.map((a) => ({
      kind: a.type,
      opId: a.opId!,
      target: a.target,
      threads: a.threads,
      result: a.type === "hack" ? { success: true, moneyGained: 1 } : {},
    }));
    const second = plan(done);
    const fleetGbAfterIdle = memory.dispatch.evaluator.directive.segments
      .reduce((sum, segment) => sum + segment.gb, 0);
    expect(fleetGbAfterIdle).toBeCloseTo(fleetGbAfterFirst, 9);
    const secondOps = second.actions.filter(
      (a): a is Extract<Action, { type: "hack" | "grow" | "weaken" }> & { worker: { id: number; spawn: boolean } } =>
        (a.type === "hack" || a.type === "grow" || a.type === "weaken") && "worker" in a && a.worker !== undefined,
    );
    expect(secondOps.length).toBeGreaterThan(0);
    expect(secondOps.every((a) => !a.worker.spawn)).toBe(true);
    expect(secondOps.every((a) => spawnedWorkers.has(a.worker.id))).toBe(true);
    // Every serve loop is sequential: no worker may receive two timed jobs
    // from the same atomic planning pass (notably both W1 and W2).
    expect(new Set(secondOps.map((a) => a.worker.id)).size).toBe(secondOps.length);
    expect(memory.dispatch.heap.usedTotal).toBe(usedAfterSpawn);
    expect(memory.dispatch.stats.execs).toBe(execsAfterFirst);

    // Workers exit (idle timeout): reservations come back, exactly once.
    const secondDone: CompletionEvent[] = secondOps.map((a) => ({
      kind: a.type,
      opId: a.opId!,
      target: a.target,
      threads: a.threads,
      result: a.type === "hack" ? { success: true, moneyGained: 1 } : {},
    }));
    const exits: CompletionEvent[] = [...spawnedWorkers].map((id) => ({ kind: "workerExit", opId: id }));
    plan([...secondDone, ...exits]);
    // Everything the pool held is free again (the pass may have launched a
    // fresh wave of spawns; subtract what is currently tracked).
    const stillHeld = [...memory.dispatch.pool.workers.values()].reduce((sum, w) => sum + w.gb, 0);
    expect(memory.dispatch.heap.usedTotal).toBeCloseTo(stillHeld, 6);
    // A duplicate exit must not double-free.
    const usedNow = memory.dispatch.heap.usedTotal;
    plan([...exits]);
    expect(memory.dispatch.heap.usedTotal).toBeGreaterThanOrEqual(usedNow);
  });

  test("does not keep borrowed prep RAM alive past its return deadline", () => {
    const world = new SimWorld({ seed: 4, network: DEFAULT_NETWORK, homeRam: 4_096, startingMoney: 1e9 });
    world.person.skills.hacking = 500;
    for (const server of world.servers.values()) {
      if (server.hostname === "home") continue;
      server.hasAdminRights = true;
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax;
    }
    let memory = initFarm();
    for (let i = 0; i < 1_100; i++) {
      trackOp(memory.dispatch, 2_000_000 + i, {
        hostname: "ghost",
        target: "",
        kind: "weaken",
        segment: "share",
        gb: 0,
        wave: false,
      } as never);
    }

    const first = planFarm(world.view(), memory, [], { pooling: true, jit: false });
    memory = first.memory;
    const spawned = first.actions.filter(
      (action): action is Extract<Action, { type: "hack" | "grow" | "weaken" }> & { worker: { id: number } } =>
        (action.type === "hack" || action.type === "grow" || action.type === "weaken") &&
        "worker" in action && action.worker !== undefined,
    );
    expect(spawned.length).toBeGreaterThan(0);

    // Make the spawned pool idle without releasing its heap reservations.
    // This is the exact state in which reuse would extend their lifetime.
    for (const action of spawned) {
      const worker = memory.dispatch.pool.workers.get(action.worker.id)!;
      worker.busy = false;
      worker.idleSince = world.clock.now();
      memory.dispatch.tracked.delete(action.opId!);
    }
    memory.dispatch.inFlight = { hack: 0, grow: 0, weaken: 0 };

    const farmHost = memory.dispatch.evaluator.directive.farm!.host;
    const prepServer = [...world.servers.values()].find(
      (server) => server.hostname !== farmHost && server.hostname !== "home" && server.moneyMax > 0,
    )!;
    prepServer.hackDifficulty = prepServer.minDifficulty + 10;
    prepServer.moneyAvailable = 1;
    const prepEntry = memory.dispatch.evaluator.entries.get(prepServer.hostname)!;
    const ctx = memory.dispatch.evaluator.ctx!;
    const prepPlan = solvePrep(ctx, prepEntry.statics, {
      hackDifficulty: prepServer.hackDifficulty,
      moneyAvailable: prepServer.moneyAvailable,
    });
    const fleetGb = memory.dispatch.evaluator.directive.segments.reduce((sum, segment) => sum + segment.gb, 0);
    const prepGb = Math.min(512, fleetGb);
    memory.dispatch.evaluator.directive = {
      ...memory.dispatch.evaluator.directive,
      prep: { host: prepServer.hostname, statics: prepEntry.statics, plan: prepPlan },
      segments: [
        { kind: "prep", gb: prepGb },
        { kind: "farm", gb: fleetGb - prepGb },
        { kind: "share", gb: 0 },
      ],
    };
    memory.dispatch.evaluator.forceGate = false;
    memory.dispatch.evaluator.lastGateAt = world.clock.now();
    const waveId = 9_000_000;
    trackOp(memory.dispatch, waveId, {
      hostname: "home",
      target: prepServer.hostname,
      kind: "weaken",
      segment: "prep",
      gb: 1.75,
      wave: true,
      landing: world.clock.now() + 60_000,
    } as never);
    memory.dispatch.prepInFlight.set(prepServer.hostname, 1);
    memory.dispatch.segmentGb.prep = 1.75;

    const borrowed = planFarm(world.view(), memory, [], { pooling: true, jit: false });
    const farmActions = borrowed.actions.filter(
      (action) =>
        (action.type === "hack" || action.type === "grow" || action.type === "weaken") &&
        action.target === farmHost,
    );
    expect(farmActions.length).toBeGreaterThan(0);
    expect(farmActions.every((action) => !("worker" in action) || action.worker === undefined)).toBe(true);
  });
});

// --- stock manipulation -------------------------------------------------------

/** Plan one pass with a stock influence intent on `joesguns`, and report which
 * target won and which op kinds carried `{stock: true}`.
 *
 * Two passes rather than one: the first solves and picks a target, the second
 * launches against it. Every server is pre-rooted and pre-prepped so the pass
 * emits BATCHES rather than a prep wave. */
function withInfluence(options: {
  side: "long" | "short";
  valuePerOp: number;
  bitnode?: number;
  intent?: boolean;
}): { host: string; flagged: Record<string, number>; income: number; stockIncome: number } {
  const world = new SimWorld({
    seed: 9,
    ...(options.bitnode !== undefined ? { bitnode: options.bitnode } : {}),
    network: DEFAULT_NETWORK,
    homeRam: 4_096,
    startingMoney: 1e12,
  });
  world.person.skills.hacking = 500;
  for (const server of world.servers.values()) {
    if (server.hostname === "home") continue;
    server.hasAdminRights = true;
    server.hackDifficulty = server.minDifficulty;
    server.moneyAvailable = server.moneyMax;
  }

  const view = () => ({
    ...world.view(),
    ...(options.intent === false
      ? {}
      : { stockInfluence: { joesguns: { sym: "JGN", side: options.side, valuePerOp: options.valuePerOp } } }),
  });
  let memory = initFarm();
  memory = planFarm(view(), memory, [], { jit: false }).memory;
  const result = planFarm(view(), memory, [], { jit: false });

  const flags: Record<string, number> = {};
  for (const action of result.actions) {
    if (action.type !== "hack" && action.type !== "grow" && action.type !== "weaken") continue;
    if (action.stock === true) flags[action.type] = (flags[action.type] ?? 0) + 1;
  }
  const farm = result.directive.farm;
  return {
    host: farm?.host ?? "",
    flagged: flags,
    income: farm?.solution.incomePerBatch ?? 0,
    stockIncome: farm?.solution.stockIncomePerBatch ?? 0,
  };
}

describe("stock manipulation reaches the ops", () => {
  test("in BN1 a realistic intent does NOT move the target — hacking dominates", () => {
    // The honest magnitude. A nudge moves the equilibrium forecast by 0.001, so a
    // $10b position on a 0.002 mean step over a 100-tick hold is worth a few
    // thousand dollars per influencing op — against tens of millions of hacked
    // money per batch. Outside a node that nerfs hacking, manipulation is a
    // rounding error on target CHOICE, and pretending otherwise would hand the
    // farm to a small server for no reason.
    const bn1 = withInfluence({ side: "long", valuePerOp: 5_000 });
    expect(bn1.host).not.toBe("joesguns");
    expect(bn1.income).toBeGreaterThan(1e6);
  });

  test("in BN8 the SAME intent wins the target, because hacked money is worth zero", () => {
    // ScriptHackMoneyGain 0. The farm still drains, still gains experience, still
    // moves prices — and earns nothing, so any positive stock income is the whole
    // score. This is the relative-weight shift the node is built around.
    const bn8 = withInfluence({ side: "long", valuePerOp: 5_000, bitnode: 8 });
    expect(bn8.host).toBe("joesguns");
    expect(bn8.income).toBe(0);
    expect(bn8.stockIncome).toBeGreaterThan(0);
  });

  test("a LONG flags the grow and nothing else", () => {
    // grow raises the second-order forecast. Flagging the hack as well would
    // cancel it out: in steady state the grow restores exactly what the hack took,
    // so the two influence rolls are equal and opposite.
    const long = withInfluence({ side: "long", valuePerOp: 5_000, bitnode: 8 });
    expect(long.flagged["grow"]).toBeGreaterThan(0);
    expect(long.flagged["hack"]).toBeUndefined();
    expect(long.flagged["weaken"]).toBeUndefined();
  });

  test("a SHORT flags the hack and nothing else", () => {
    const short = withInfluence({ side: "short", valuePerOp: 5_000, bitnode: 8 });
    expect(short.flagged["hack"]).toBeGreaterThan(0);
    expect(short.flagged["grow"]).toBeUndefined();
    expect(short.flagged["weaken"]).toBeUndefined();
  });

  test("with no intent, nothing is flagged and no stock income is claimed", () => {
    const none = withInfluence({ side: "long", valuePerOp: 5_000, bitnode: 8, intent: false });
    expect(none.host).not.toBe("");
    expect(none.flagged).toEqual({});
    expect(none.stockIncome).toBe(0);
  });
});

describe("share stop requests", () => {
  const shareWorker = (workerId: number, gb: number) => ({
    workerId,
    hostname: "home",
    threads: gb / 4,
    gb,
    effectiveThreads: gb / 4,
    stopping: false,
  });

  test("RAM already on its way out satisfies a repeat request instead of evicting more", () => {
    const memory = initFarm().dispatch;
    memory.shareWorkers.set(1, shareWorker(1, 16));
    memory.shareWorkers.set(2, shareWorker(2, 8));

    const first: Action[] = [];
    expect(requestShareStops(memory, first, 12)).toBe(16);
    expect(first).toEqual([{ type: "stopShare", opId: 1 }]);

    // The 16 GB pending stop already covers this request, so no second victim
    // is selected.
    const repeat: Action[] = [];
    expect(requestShareStops(memory, repeat, 12)).toBe(16);
    expect(repeat).toEqual([]);

    // A genuinely larger ask still evicts beyond the pending RAM.
    const larger: Action[] = [];
    expect(requestShareStops(memory, larger, 20)).toBe(24);
    expect(larger).toEqual([{ type: "stopShare", opId: 2 }]);
  });
});

import { describe, expect, test } from "bun:test";
import { SPACER_MS, type DispatchOptions } from "../../shared/strategy/dispatch.ts";
import { initFarm, planFarm, reportFailed, type FarmMemory } from "../../shared/strategy/farm-planner.ts";
import { PREPPED_MONEY_FRACTION, PREPPED_SEC_TOLERANCE, solvePrep } from "../../shared/strategy/targeting.ts";
import type { Action, CompletionEvent } from "../../shared/world.ts";
import { DEFAULT_NETWORK } from "../network.ts";
import { SimWorld } from "../world.ts";

/** The dispatcher drives the sim exactly as it will drive the game, so these
 * are end-to-end checks of the HWGW engine against the real game effects. */

interface Harness {
  world: SimWorld;
  memory: FarmMemory;
  run(untilMs: number): void;
  launches: { action: Action; at: number }[];
  completions: { kind: string; at: number; batched: boolean }[];
  samples: { host: string; sec: number; minSec: number; money: number; maxMoney: number }[];
}

function harness(options: { seed?: number; homeRam?: number; plan?: DispatchOptions } = {}): Harness {
  const world = new SimWorld({
    seed: options.seed ?? 1,
    network: DEFAULT_NETWORK,
    homeRam: options.homeRam ?? 64,
    startingMoney: 1_000,
  });
  let memory = initFarm();
  const launches: { action: Action; at: number }[] = [];
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
    const result = planFarm(world.view(), memory, inbox, options.plan);
    memory = result.memory;
    const failed: number[] = [];
    let executed = 0;
    for (const action of result.actions) {
      if (world.execute(action)) {
        executed++;
        launches.push({ action, at: world.clock.now() });
        if ("additionalMsec" in action && action.additionalMsec !== undefined && action.opId !== undefined) {
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
  test("never bypasses the shared investment arbiter with infrastructure buys", () => {
    const world = new SimWorld({ seed: 5, network: DEFAULT_NETWORK, homeRam: 64, startingMoney: 1e15 });
    const planned = planFarm(world.view(), initFarm(), []);
    expect(planned.actions.some((action) =>
      action.type === "buyServer" || action.type === "upgradeServer" ||
      action.type === "upgradeHomeRam" || action.type === "upgradeHomeCore",
    )).toBe(false);
  });

  test("batches land in H -> W1 -> G -> W2 order, one spacer apart", () => {
    const h = harness({ homeRam: 256 });
    h.run(900_000);

    // Landings are observed from the world, not recomputed from our own
    // arithmetic: this checks the ops really settle in batch order.
    const landings = h.completions
      .filter((c) => c.batched)
      .sort((a, b) => a.at - b.at);
    const hacks = landings.filter((l) => l.kind === "hack");
    expect(hacks.length).toBeGreaterThan(3);

    const at = (time: number, kind: string): boolean =>
      landings.some((l) => l.kind === kind && Math.abs(l.at - time) < 1e-6);
    for (const hack of hacks) {
      expect(at(hack.at + SPACER_MS, "weaken")).toBe(true);
      expect(at(hack.at + 2 * SPACER_MS, "grow")).toBe(true);
      expect(at(hack.at + 3 * SPACER_MS, "weaken")).toBe(true);
    }
  });

  test("hgw mode lands H -> G -> W, one spacer apart, and stays in band", () => {
    const h = harness({ homeRam: 256, plan: { modeOverride: "hgw" } });
    h.run(900_000);
    expect(h.memory.dispatch.mode).toBe("hgw");

    const landings = h.completions.filter((c) => c.batched).sort((a, b) => a.at - b.at);
    const hacks = landings.filter((l) => l.kind === "hack");
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
    expect(Math.max(...farmed.map((s) => s.money / s.maxMoney))).toBeGreaterThan(0.99);
  });

  test("never overcommits RAM and never leaks reservations", () => {
    const h = harness({ homeRam: 128 });
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

  test("keeps the farm target inside its security and money bands", () => {
    const h = harness({ homeRam: 256 });
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
    expect(Math.max(...farmed.map((s) => s.money / s.maxMoney))).toBeGreaterThan(0.99);
  });

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

  test("a dispatcher pass stays well inside the 10ms tick budget", () => {
    const h = harness({ homeRam: 1_048_576 });
    h.run(600_000);
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      planFarm(h.world.view(), h.memory, []);
      worst = Math.max(worst, performance.now() - start);
    }
    expect(worst).toBeLessThan(10);
    console.log(`bench: worst dispatcher pass ${worst.toFixed(3)}ms`);
  });
});

// --- prep waves and the in-flight ledger --------------------------------------

describe("prep waves", () => {
  /** Pre-rooted world with every server at min security; `moneyFraction`
   * controls whether targets start prepped. Returns a fresh plan closure. */
  function prepWorld(moneyFraction: number) {
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
      const result = planFarm(world.view(), memory, completions);
      memory = result.memory;
      return result;
    };
    return { world, plan, memory: () => memory };
  }

  test("the grow phase launches its weaken2 cover as weakens, not extra grows", () => {
    // A modest deficit (85% money) keeps the whole wave inside the per-pass
    // op cap, so the LAUNCHED thread ratio reflects the plan's G:W2 ratio
    // instead of cap truncation.
    const { plan } = prepWorld(0.85);
    const launch = plan(); // gate + prep wave on the (unprepped) farm target, same pass
    const farmHost = launch.directive.farm?.host;
    expect(farmHost).toBeDefined();
    const waveOps = launch.actions.filter(
      (a): a is Extract<Action, { type: "hack" | "grow" | "weaken" }> =>
        (a.type === "grow" || a.type === "weaken" || a.type === "hack") && a.target === farmHost,
    );
    const growThreads = waveOps.filter((a) => a.type === "grow").reduce((sum, a) => sum + a.threads, 0);
    const weakenThreads = waveOps.filter((a) => a.type === "weaken").reduce((sum, a) => sum + a.threads, 0);
    // At min security the wave is G + W2 TOGETHER: both kinds present, in
    // roughly the 0.004·G/weakenEffect cover ratio (well under 20%).
    expect(waveOps.some((a) => a.type === "hack")).toBe(false);
    expect(growThreads).toBeGreaterThan(0);
    expect(weakenThreads).toBeGreaterThan(0);
    expect(weakenThreads).toBeLessThan(growThreads * 0.2);
  });

  test("transient batch landings cannot start prep before the restoring op", () => {
    const { world, plan, memory } = prepWorld(1);
    const batchPass = plan(); // prepped target -> real HWGW batches, first pass
    const farmHost = batchPass.directive.farm!.host;
    const batchOps = batchPass.actions.filter(
      (a): a is Extract<Action, { type: "hack" | "grow" | "weaken" }> =>
        "opId" in a && a.opId !== undefined && (a as { additionalMsec?: number }).additionalMsec !== undefined,
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
        (a as { additionalMsec?: number }).additionalMsec === undefined
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
        (a as { additionalMsec?: number }).additionalMsec === undefined,
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
    const h = harness({ homeRam: 512, plan: { modeOverride: "shotgun" } });
    h.run(900_000);
    expect(h.memory.dispatch.mode).toBe("shotgun");

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
    expect(Math.max(...farmed.map((s) => s.money / s.maxMoney))).toBeGreaterThan(0.99);
    expect(h.memory.dispatch.stats.hacks).toBeGreaterThan(0);
  });

  test("falls back to the four-op shape when no HGW solution fits", () => {
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
    const tracked = fallback.actions.flatMap((a) => {
      if (!("opId" in a) || a.opId === undefined) return [];
      const entry = memory.dispatch.tracked.get(a.opId);
      return entry?.target === host && entry.landing !== undefined
        ? [{ kind: entry.kind, landing: entry.landing }]
        : [];
    });
    expect(tracked.some((op) => op.kind === "hack")).toBe(true);
    const hackLanding = Math.min(...tracked.filter((op) => op.kind === "hack").map((op) => op.landing));
    const kindsAt = (landing: number) => tracked.filter((op) => op.landing === landing).map((op) => op.kind);
    expect(kindsAt(hackLanding + SPACER_MS)).toContain("weaken");
    expect(kindsAt(hackLanding + 2 * SPACER_MS)).toContain("grow");
    expect(kindsAt(hackLanding + 3 * SPACER_MS)).toContain("weaken");
  });
});

// --- pooled workers ------------------------------------------------------------

describe("worker pooling", () => {
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
      memory.dispatch.tracked.set(1_000_000 + i, {
        hostname: "ghost",
        target: "",
        kind: "weaken",
        segment: "share",
        gb: 0,
        wave: false,
      } as never);
    }
    const plan = (completions: CompletionEvent[] = []) => {
      const result = planFarm(world.view(), memory, completions, { pooling: true });
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
    expect(memory.dispatch.pool.workers.size).toBeGreaterThanOrEqual(0);
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
      memory.dispatch.tracked.set(2_000_000 + i, {
        hostname: "ghost",
        target: "",
        kind: "weaken",
        segment: "share",
        gb: 0,
        wave: false,
      } as never);
    }

    const first = planFarm(world.view(), memory, [], { pooling: true });
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
    memory.dispatch.tracked.set(waveId, {
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

    const borrowed = planFarm(world.view(), memory, [], { pooling: true });
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
  memory = planFarm(view(), memory, []).memory;
  const result = planFarm(view(), memory, []);

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
    expect(none.flagged).toEqual({});
    expect(none.stockIncome).toBe(0);
  });
});

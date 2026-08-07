import { describe, expect, test } from "bun:test";
import { SPACER_MS } from "../../shared/strategy/dispatch.ts";
import { initFarm, planFarm, reportFailed, type FarmMemory } from "../../shared/strategy/farm-planner.ts";
import { PREPPED_MONEY_FRACTION, PREPPED_SEC_TOLERANCE } from "../../shared/strategy/targeting.ts";
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

function harness(options: { seed?: number; homeRam?: number } = {}): Harness {
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
    const result = planFarm(world.view(), memory, inbox);
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

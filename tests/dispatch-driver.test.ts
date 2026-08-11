import { describe, expect, test } from "bun:test";
import type { Server } from "@ns";
import { drainCompletions, initDriver, resyncHeap, type DriverState } from "../game/lib/dispatch-driver.ts";
import type { WorkerGlobalThis } from "../game/lib/worker-shared.ts";
import { reportFailed } from "../shared/strategy/farm-planner.ts";

function driver(): DriverState {
  return {
    ...initDriver(),
    globals: {
      worker_info: new Map(),
      worker_jobs: new Map(),
      worker_wake: new Map(),
      dispatch_done: [],
    } as unknown as WorkerGlobalThis,
  };
}

function server(ramUsed: number): Server {
  return { hostname: "foodnstuff", maxRam: 16, ramUsed } as Server;
}

describe("dispatcher heap reconciliation", () => {
  test("preserves a worker failure instead of fabricating a zero-result weaken", () => {
    const state = driver();
    state.globals.dispatch_done!.push({
      opId: 7,
      kind: "weaken",
      target: "n00dles",
      threads: 2,
      result: undefined,
    });
    expect(drainCompletions(state)).toEqual([
      { opId: 7, kind: "weaken", target: "n00dles", threads: 2 },
    ]);
  });

  test("does not subtract a worker twice while its completion is queued", () => {
    const state = driver();
    const memory = state.memory.dispatch;
    memory.heap.upsert("foodnstuff", 16, 2);
    const allocation = memory.heap.allocate({ blockSize: 1.75, threads: 1, policy: "contiguous" });
    expect(allocation.ok).toBe(true);
    memory.tracked.set(1, {
      hostname: "foodnstuff",
      target: "n00dles",
      kind: "grow",
      segment: "prep",
      gb: 1.75,
      wave: true,
    });
    memory.inFlight.grow = 1;
    memory.segmentGb.prep = 1.75;
    memory.prepInFlight.set("n00dles", 1);
    state.globals.worker_info!.set(1, { kind: "grow", target: "n00dles", threads: 1 });

    expect(resyncHeap(state, { foodnstuff: server(3.75) })).toEqual([]);

    // atExit has removed the process from real RAM and worker_info, but the
    // dispatcher has not consumed its completion yet. The heap reservation is
    // still intentional and must survive this fleet snapshot.
    state.globals.worker_info!.delete(1);
    expect(resyncHeap(state, { foodnstuff: server(2) })).toEqual([]);
    expect(memory.heap.host("foodnstuff")?.used).toBe(3.75);

    reportFailed(state.memory, [1]);
    expect(memory.heap.host("foodnstuff")?.used).toBe(2);

    // Once no managed exit is pending, ordinary foreign-RAM reconciliation
    // can lower the standing usage again.
    expect(resyncHeap(state, { foodnstuff: server(1) })).toEqual(["foodnstuff"]);
    expect(memory.heap.host("foodnstuff")?.used).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import type { Server } from "@ns";
import { drainCompletions, initDriver, resyncHeap, type DriverState } from "../game/lib/dispatch-driver.ts";
import type { WorkerGlobalThis } from "../game/lib/worker-shared.ts";
import { reportFailed } from "../shared/strategy/farm-planner.ts";
import { trackOp } from "../shared/strategy/dispatch.ts";

import { settleBrokerShareExits } from '../game/lib/dispatch-driver.ts';

import type { NS } from '@ns';
import { reclaimForDodge } from '../game/lib/dispatch-driver.ts';

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
    trackOp(memory, 1, {
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

  test("keeps a stopped share reservation until its exit is drained, then frees it once", () => {
    const state = driver();
    const memory = state.memory.dispatch;
    memory.heap.upsert("foodnstuff", 16, 2);
    const allocation = memory.heap.allocate({ blockSize: 2.4, threads: 3, policy: "contiguous" });
    expect(allocation.ok).toBe(true);
    memory.shareWorkers.set(9, {
      workerId: 9,
      hostname: "foodnstuff",
      threads: 3,
      gb: 7.2,
      effectiveThreads: 3,
      stopping: true,
    });
    memory.segmentGb.share = 7.2;
    state.globals.worker_info!.set(9, { kind: "share", target: "", threads: 3, mode: "share" });

    expect(resyncHeap(state, { foodnstuff: server(9.2) })).toEqual([]);
    // atExit removes the registry entry and queues the exit in one synchronous
    // step; a fleet snapshot in the drain interval sees exactly this state.
    state.globals.worker_info!.delete(9);
    state.globals.dispatch_done!.push({
      opId: 9, kind: 'workerExit', target: '', threads: 3,
    });
    expect(resyncHeap(state, { foodnstuff: server(2) })).toEqual([]);
    expect(memory.heap.host("foodnstuff")?.used).toBe(9.2);

    expect(settleBrokerShareExits(state)).toEqual([9]);
    expect(settleBrokerShareExits(state)).toEqual([]);
    expect(memory.heap.host("foodnstuff")?.used).toBeCloseTo(2, 12);
    expect(memory.segmentGb.share).toBe(0);
  });

  test("releases a reload-orphaned share worker that can never report an exit", () => {
    const state = driver();
    const memory = state.memory.dispatch;
    memory.heap.upsert("foodnstuff", 16, 2);
    const allocation = memory.heap.allocate({ blockSize: 2.4, threads: 3, policy: "contiguous" });
    expect(allocation.ok).toBe(true);
    memory.shareWorkers.set(9, {
      workerId: 9,
      hostname: "foodnstuff",
      threads: 3,
      gb: 7.2,
      effectiveThreads: 3,
      stopping: false,
    });
    memory.segmentGb.share = 7.2;

    // A realm reset discarded worker_info before the worker's atExit could
    // register: no entry, no queued exit, and none ever coming. The sweep must
    // free the reservation instead of preserving it forever.
    expect(resyncHeap(state, { foodnstuff: server(2) })).toEqual([]);
    expect(memory.shareWorkers.size).toBe(0);
    expect(memory.heap.host("foodnstuff")?.used).toBeCloseTo(2, 12);
    expect(memory.segmentGb.share).toBe(0);
  });
});

describe('broker farm preemption adapter', () => {
  test('leaves an active process and its invested reservation intact', () => {
    const state = driver();
    const memory = state.memory.dispatch;
    memory.heap.upsert('foodnstuff', 16, 0);
    const allocation = memory.heap.allocate({ blockSize: 1.75, threads: 4, policy: 'contiguous' });
    expect(allocation.ok).toBe(true);
    memory.pool.workers.set(9, {
      workerId: 9, hostname: 'foodnstuff', kind: 'grow', threads: 4,
      effectThreads: 4, gb: 7, busy: true, idleSince: 0,
    });
    trackOp(memory, 10, {
      hostname: 'foodnstuff', target: 'n00dles', kind: 'grow',
      segment: 'farm', gb: 7, wave: false, workerId: 9, landing: 2_000,
    });
    memory.inFlight.grow = 1;
    memory.segmentGb.farm = 7;
    state.globals.worker_info!.set(9, {
      kind: 'grow', target: 'n00dles', threads: 4, mode: 'serve', pid: 123,
    });

    const killed: number[] = [];
    const result = reclaimForDodge({ kill: (pid: number) => (killed.push(pid), true) } as NS, state, {
      by: 'progression', id: 'action:install', gb: 5, priority: 110,
      class: 'deferrable',
    }, [{
      hostname: 'foodnstuff', maxRam: 16, freeGb: 0, rooted: true, deployed: true,
    }]);

    expect(result).toMatchObject({
      preempted: false,
      plan: { action: 'wait', reason: 'no-single-victim-unblocks' },
    });
    expect(killed).toEqual([]);
    expect(memory.pool.workers.size).toBe(1);
    expect(memory.tracked.size).toBe(1);
    expect(memory.heap.freeOn('foodnstuff', true)).toBe(9);
  });
});

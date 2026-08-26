import { describe, expect, test } from "bun:test";
import {
  initDriver,
  workerLaunchRefusals,
  type DriverState,
} from "../game/lib/dispatch-driver.ts";
import type { WorkerGlobalThis } from "../game/lib/worker-shared.ts";
import {
  liveProcessCount,
  MAX_LIVE_WORKERS,
  trackOp,
} from "../shared/strategy/dispatch.ts";

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

describe("worker process ceilings", () => {
  test("counts share and charge workers in addition to farm workers", () => {
    const memory = driver().memory.dispatch;
    trackOp(memory, 1, {
      hostname: "home",
      target: "n00dles",
      kind: "hack",
      segment: "farm",
      gb: 1.7,
      wave: false,
    });
    memory.shareWorkers.set(2, {
      workerId: 2,
      hostname: "home",
      threads: 1,
      gb: 4,
      effectiveThreads: 1,
      stopping: false,
    });
    memory.chargeWorkers.set(3, {
      opId: 3,
      hostname: "home",
      threads: 1,
      gb: 2,
    });
    expect(liveProcessCount(memory)).toBe(3);
  });

  test("driver refuses a whole shotgun batch when only part would fit", () => {
    const state = driver();
    const actions = (["hack", "grow", "weaken"] as const).map((type, index) => ({
      type,
      target: "n00dles",
      source: "home",
      threads: 1,
      opId: index + 1,
    }));
    for (const action of actions) {
      trackOp(state.memory.dispatch, action.opId, {
        hostname: "home",
        target: "n00dles",
        kind: action.type,
        segment: "farm",
        gb: 1.75,
        wave: false,
        batchId: 7,
      });
    }
    state.memory.dispatch.batches.set(7, { kind: "shotgun" } as never);

    expect(
      workerLaunchRefusals(state.memory, actions, MAX_LIVE_WORKERS - 2),
    ).toEqual(new Set([1, 2, 3]));
    expect(
      workerLaunchRefusals(state.memory, actions, MAX_LIVE_WORKERS - 3).size,
    ).toBe(0);
  });
});

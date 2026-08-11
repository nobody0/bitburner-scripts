import { describe, expect, test } from "bun:test";
import type { WorkerGlobalThis } from "../game/lib/worker-shared.ts";
import { armWake, signalWake } from "../game/lib/wake.ts";

describe("dispatcher wake rendezvous", () => {
  test("a signal between arms is latched and consumed by the next arm", async () => {
    const globals = {} as WorkerGlobalThis;
    signalWake(globals);
    expect(globals.dispatch_wake_pending).toBe(true);

    await armWake(globals);
    expect(globals.dispatch_wake_pending).toBe(false);
    expect(globals.dispatch_wake).toBeUndefined();
  });

  test("an armed signal resolves directly without leaving a stale latch", async () => {
    const globals = {} as WorkerGlobalThis;
    const wake = armWake(globals);
    signalWake(globals);

    await wake;
    expect(globals.dispatch_wake_pending).toBeUndefined();
    expect(globals.dispatch_wake).toBeUndefined();
  });
});

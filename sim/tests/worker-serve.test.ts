import { afterEach, describe, expect, test } from "bun:test";
import { main as workerMain } from "../../game/worker/worker.ts";
import { workerGlobals, type WorkerDone, type WorkerGlobalThis } from "../../game/lib/worker-shared.ts";
import { Clock, drainMicrotasks } from "../clock.ts";
import { installVirtualTime, type VirtualTime } from "../realm/timers.ts";

/** The REAL serve-mode worker loop, driven end to end against a mock ns under
 * virtual time: jobs arrive through the realm mailbox, completions come back
 * through dispatch_done, idle timeout exits with a workerExit, and a kill
 * mid-job reports the job AND the exit. */

const WORKER_ID = 4_242;

function cleanupRealm(): void {
  const g = globalThis as WorkerGlobalThis;
  delete g.worker_info;
  delete g.worker_jobs;
  delete g.worker_wake;
  delete g.dispatch_done;
  delete g.dispatch_wake;
  delete g.dispatch_wake_pending;
  delete g.dispatch_jit_timer;
  delete g.dispatch_jit_at;
  delete g.dispatch_weaken_timer;
}

interface MockOp {
  opts?: { additionalMsec?: number; stock?: boolean };
  resolve(value: number): void;
}

function mockNs(pending: MockOp[]): { ns: unknown; exitCbs: (() => void)[] } {
  const exitCbs: (() => void)[] = [];
  const op = (_target: string, opts?: { additionalMsec?: number; stock?: boolean }) =>
    new Promise<number>((resolve) => {
      pending.push({ resolve, ...(opts ? { opts } : {}) });
    });
  const ns = {
    args: [WORKER_ID],
    atExit: (cb: () => void) => exitCbs.push(cb),
    hack: op,
    grow: op,
    weaken: op,
  };
  return { ns, exitCbs };
}

let vt: VirtualTime | undefined;
afterEach(() => {
  vt?.restore();
  vt = undefined;
  cleanupRealm();
});

describe("serve-mode worker", () => {
  test("serves queued jobs, idles, wakes for more, and exits on idle timeout", async () => {
    const clock = new Clock();
    vt = installVirtualTime(clock);
    cleanupRealm();
    const g = workerGlobals();
    let dispatchWakes = 0;
    g.dispatch_wake = () => dispatchWakes++;
    g.worker_info!.set(WORKER_ID, { kind: "weaken", target: "alpha", threads: 5, mode: "serve" });
    g.worker_jobs!.set(WORKER_ID, [{ opId: 1, target: "alpha" }]);
    const done: WorkerDone[] = g.dispatch_done!;
    const pending: MockOp[] = [];
    const { ns, exitCbs } = mockNs(pending);

    let returned = false;
    const run = workerMain(ns as never).then(() => {
      returned = true;
      // The host runs atExit when main returns; the mock does it here.
      for (const cb of exitCbs) cb();
    });

    await drainMicrotasks();
    expect(pending).toHaveLength(1); // first job started immediately
    pending.shift()!.resolve(0.25);
    await drainMicrotasks();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ opId: 1, kind: "weaken", target: "alpha", threads: 5, result: 0.25 });
    expect(dispatchWakes).toBe(0);
    await clock.runAsync(() => dispatchWakes === 1, 10);
    expect(dispatchWakes).toBe(1);

    // Idle now. A job posted through the mailbox + wake resumes the loop.
    g.worker_jobs!.get(WORKER_ID)!.push({ opId: 2, target: "beta", additionalMsec: 40 });
    g.worker_wake!.get(WORKER_ID)!();
    await drainMicrotasks();
    expect(pending).toHaveLength(1);
    pending.shift()!.resolve(0.5);
    await drainMicrotasks();
    expect(done).toHaveLength(2);
    expect(done[1]).toMatchObject({ opId: 2, kind: "weaken", target: "beta" });

    // No more jobs: the idle timer (virtual) fires and the loop exits,
    // reporting workerExit and clearing every registry entry.
    await clock.runAsync(() => returned, 60_000);
    expect(returned).toBe(true);
    await run;
    expect(done).toHaveLength(3);
    expect(done[2]).toMatchObject({ opId: WORKER_ID, kind: "workerExit" });
    expect(g.worker_info!.has(WORKER_ID)).toBe(false);
    expect(g.worker_jobs!.has(WORKER_ID)).toBe(false);
    expect(g.worker_wake!.has(WORKER_ID)).toBe(false);
  });

  test("a kill mid-job reports the in-flight op AND the workerExit", async () => {
    const clock = new Clock();
    vt = installVirtualTime(clock);
    cleanupRealm();
    const g = workerGlobals();
    g.worker_info!.set(WORKER_ID, { kind: "grow", target: "gamma", threads: 3, mode: "serve" });
    g.worker_jobs!.set(WORKER_ID, [{ opId: 9, target: "gamma" }]);
    const done: WorkerDone[] = g.dispatch_done!;
    const pending: MockOp[] = [];
    const { ns, exitCbs } = mockNs(pending);

    void workerMain(ns as never);
    await drainMicrotasks();
    expect(pending).toHaveLength(1); // op in flight

    // Kill: the host runs atExit while the op is still awaited.
    for (const cb of exitCbs) cb();
    expect(done).toHaveLength(2);
    expect(done[0]).toMatchObject({ opId: 9, kind: "grow", target: "gamma", threads: 3 });
    expect(done[0]!.result).toBeUndefined();
    expect(done[1]).toMatchObject({ opId: WORKER_ID, kind: "workerExit" });

    // The orphaned continuation must not touch the mailboxes again: resolve
    // the op after the kill and confirm nothing new is reported.
    pending.shift()!.resolve(1);
    await drainMicrotasks();
    expect(done).toHaveLength(2);
  });

  test("converts an absolute padding deadline at the actual Netscript call", async () => {
    const clock = new Clock();
    vt = installVirtualTime(clock);
    cleanupRealm();
    const g = workerGlobals();
    const deadline = Date.now() + 200;
    // Model planning/exec/module startup consuming 75 ms before main() runs.
    clock.in(75, () => {});
    clock.run();

    const pending: MockOp[] = [];
    const { ns } = mockNs(pending);
    g.worker_info!.set(WORKER_ID, { kind: "hack", target: "delta", threads: 1, delayUntil: deadline });
    void workerMain(ns as never);
    await drainMicrotasks();

    expect(pending).toHaveLength(1);
    expect(pending[0]!.opts?.additionalMsec).toBe(125);
  });
});

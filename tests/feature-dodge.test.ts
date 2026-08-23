import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import type { DodgeLaunch } from "../game/lib/dodge-shared.ts";
import { captureLaunch } from "../game/lib/launch-shared.ts";
import { featureDodge } from "../game/lib/features/dodge.ts";
import type { DriverContext } from "../game/lib/features/index.ts";
import { Heap } from "../shared/ram/heap.ts";
import { PRIORITY } from "../shared/strategy/arbiter.ts";

function harness(acquire = true) {
  let execs = 0;
  let acquired = 0;
  let released = 0;
  const stubNs = {} as NS;
  const ns = {
    getFunctionRamCost: () => 1,
    sleep: async () => {},
    exec: () => {
      execs++;
      queueMicrotask(async () => {
        const launch = captureLaunch<DodgeLaunch>("dodge");
        if (!launch) return;
        try {
          launch.resolve({ result: launch.func(stubNs) });
        } catch (error) {
          launch.reject(error);
        }
      });
      return 1;
    },
  } as unknown as NS;
  const ctx = {
    ns,
    state: {},
    grants: {
      ramClaims: new Map([["action:join", {
        by: "factions",
        id: "action:join",
        resource: "ram",
        amount: 1,
        priority: PRIORITY["progression:terminal-action"],
      }]]),
    },
    acquireDodge: (_gb: number, request: { by: string; id: string }) => {
      acquired++;
      expect(request).toMatchObject({
        by: "factions",
        id: "action:join",
        priority: PRIORITY["progression:terminal-action"],
      });
      return acquire
        ? { status: "placed", host: "n00dles", release: () => released++ }
        : { status: "queued" };
    },
  } as unknown as DriverContext;
  return { ctx, counts: () => ({ execs, acquired, released }) };
}

describe("feature dodge broker and heap leases", () => {
  test("queued is distinct from denial and never calls ns.exec", async () => {
    const queued = harness(false);
    expect(await featureDodge(queued.ctx, "factions", "action:join", ["singularity.joinFaction"], () => true))
      .toMatchObject({ ok: false, queued: true });
    expect(queued.counts()).toEqual({ execs: 0, acquired: 1, released: 0 });
  });

  test("one granted action acquires and releases exactly one lease", async () => {
    const h = harness();
    const outcome = await featureDodge(h.ctx, "factions", "action:join", ["singularity.joinFaction"], () => 42);
    expect(outcome).toEqual({ ok: true, value: 42 });
    expect(h.counts()).toEqual({ execs: 1, acquired: 1, released: 1 });
  });

  test("a Promise result is awaited after the stub lease has been released", async () => {
    const h = harness();
    let resolve!: (value: number) => void;
    const gameResult = new Promise<number>((done) => { resolve = done; });
    let settled = false;
    const outcome = featureDodge(
      h.ctx,
      "factions",
      "action:join",
      ["singularity.joinFaction"],
      () => gameResult,
    ).then((value) => {
      settled = true;
      return value;
    });

    await new Promise<void>((done) => setTimeout(done, 0));
    expect(h.counts()).toEqual({ execs: 1, acquired: 1, released: 1 });
    expect(settled).toBe(false);

    resolve(42);
    expect(await outcome).toEqual({ ok: true, value: 42 });
  });

  test("a pending result does not block the next synchronous dodge handoff", async () => {
    const h = harness();
    let finishFirst!: () => void;
    const firstResult = new Promise<void>((done) => { finishFirst = done; });
    const first = featureDodge(
      h.ctx, "factions", "action:join", ["singularity.joinFaction"], () => firstResult,
    );
    const second = featureDodge(
      h.ctx, "factions", "action:join", ["singularity.joinFaction"], () => 2,
    );

    await new Promise<void>((done) => setTimeout(done, 0));
    expect(h.counts()).toEqual({ execs: 2, acquired: 2, released: 2 });
    expect(await second).toEqual({ ok: true, value: 2 });
    finishFirst();
    expect(await first).toEqual({ ok: true, value: undefined });
  });

  test("lease releases on ordinary failure and ScriptDeath", async () => {
    for (const error of [new Error("boom"), Object.assign(new Error("killed"), { name: "ScriptDeath" })]) {
      const h = harness();
      await expect(featureDodge(h.ctx, "factions", "action:join", ["singularity.joinFaction"], () => { throw error; })).rejects.toBe(error);
      expect(h.counts()).toEqual({ execs: 1, acquired: 1, released: 1 });
    }
  });

  test("dispatcher allocation cannot consume RAM held by a dodge lease", () => {
    const heap = new Heap();
    heap.upsert("n00dles", 16, 0);
    const lease = heap.reserveOn("n00dles", 10)!;
    expect(heap.allocate({ blockSize: 1.7, threads: 4, policy: "contiguous" }).ok).toBe(false);
    lease.release();
    expect(heap.allocate({ blockSize: 1.7, threads: 4, policy: "contiguous" }).ok).toBe(true);
  });
});

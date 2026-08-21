import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NS } from "@ns";
import type { DodgeGlobals } from "../game/lib/dodge-shared.ts";
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
      const globals = globalThis as typeof globalThis & DodgeGlobals;
      queueMicrotask(async () => {
        try {
          globals.dodge_cb?.(await globals.dodge_func!(stubNs));
        } catch (error) {
          globals.dodge_reject?.(error);
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

  test("feature sources cannot bypass the central helper", () => {
    const root = resolve(import.meta.dir, "../game/lib/features");
    for (const file of ["career.ts", "factions.ts", "hacking.ts", "hacknet.ts", "remaining.ts", "stock.ts"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source, file).not.toMatch(/\bdodge\s*\(/);
      expect(source, file).not.toMatch(/\bdodgeHost\s*\(/);
    }
  });
});

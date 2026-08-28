import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { createNsProxy, setProxyEventSink, type ProxyPlacer } from "../game/lib/ns-proxy.ts";
import { RESIDENT_BASE_GB } from "../shared/ram/broker.ts";
import { nsMainGlobal } from "../game/lib/ns-proxy-shared.ts";
import { main as residentMain } from "../game/lib/ns-resident.ts";
import { resetLaunchState } from "../game/lib/launch-shared.ts";

interface ResidentRecord {
  host: string;
  ramGb: number;
  alive: boolean;
  calls: string[];
}

/** A realm: one `nsMain` whose `exec` boots the REAL resident entrypoint, so
 * the handshake under test is the one that ships. `members` prices each path
 * and supplies its implementation. */
function realm(options: {
  members?: Record<string, { gb: number; impl?: (...args: unknown[]) => unknown }>;
  refuseExecs?: number;
  /** Largest executable block the fleet can offer, if it is constrained. */
  grantCapGb?: number;
} = {}) {
  const members = options.members ?? {};
  const residents: ResidentRecord[] = [];
  const execs: { script: string; host: string; ramGb: number }[] = [];
  let refusals = options.refuseExecs ?? 0;
  const tprints: string[] = [];

  const exitHandlers = new Map<ResidentRecord, () => void>();
  const nsMain = {
    getFunctionRamCost: (path: string) => {
      const member = members[path];
      if (!member) throw new Error(`unknown ns member ${path}`);
      return member.gb;
    },
    tprint: (line: string) => { tprints.push(line); },
    exec: (script: string, host: string, opts: { ramOverride: number }, launchId: unknown) => {
      if (refusals > 0) { refusals--; return 0; }
      execs.push({ script, host, ramGb: opts.ramOverride });
      const record: ResidentRecord = { host, ramGb: opts.ramOverride, alive: true, calls: [] };
      residents.push(record);

      // The resident's own ns: every member the realm declares, recording the
      // calls that actually reached this process.
      const residentNs: Record<string, unknown> = {
        disableLog: () => {},
        atExit: (fn: () => void) => { exitHandlers.set(record, fn); },
        args: [launchId],
      };
      for (const [path, member] of Object.entries(members)) {
        const parts = path.split(".");
        let node = residentNs;
        for (const part of parts.slice(0, -1)) {
          node[part] ??= {};
          node = node[part] as Record<string, unknown>;
        }
        node[parts[parts.length - 1]] = (...args: unknown[]) => {
          record.calls.push(path);
          return member.impl ? member.impl(...args) : path;
        };
      }
      // The engine runs atExit once main returns and only then returns the
      // RAM; the proxy waits on exactly that signal before re-execing.
      void residentMain(residentNs as unknown as NS).then(() => {
        record.alive = false;
        exitHandlers.get(record)?.();
      });
      return residents.length;
    },
  } as unknown as NS;

  nsMainGlobal().nsMain = nsMain;

  const placements: { host: string; released: boolean; gb: number }[] = [];
  /** Grants whatever is asked for, unless the realm caps it — which is how a
   * cold boot with only home's small reserve is modelled. */
  let grantCapGb = options.grantCapGb;
  const place: ProxyPlacer = (minGb, preferredGb) => {
    const cap = grantCapGb;
    const gb = cap === undefined ? preferredGb : Math.min(preferredGb, Math.max(cap, 0));
    if (cap !== undefined && gb < minGb) return undefined;
    const placement = { host: `host-${placements.length}`, released: false, gb };
    placements.push(placement);
    return { host: placement.host, gb, release: () => { placement.released = true; } };
  };

  return {
    nsMain, residents, execs, placements, place, tprints, exitHandlers,
    setGrantCap: (gb: number) => { grantCapGb = gb; },
  };
}

/** The typed surface admits only real NS paths — that is the whole point of it
 * — so tests that invent members call through this deliberate widening. */
type LooseCall = (path: string, ...args: unknown[]) => Promise<unknown>;
const loose = (proxy: { call: unknown }): LooseCall => proxy.call as LooseCall;

afterEach(() => {
  setProxyEventSink(undefined);
  nsMainGlobal().nsMain = undefined;
  resetLaunchState();
});

describe("ns proxy", () => {
  test("a call runs on the resident and returns its value", async () => {
    const world = realm({ members: { getServer: { gb: 2, impl: (host) => ({ hostname: host }) } } });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    expect(await loose(proxy)("getServer", "n00dles")).toEqual({ hostname: "n00dles" });
    expect(world.residents).toHaveLength(1);
    expect(world.residents[0].calls).toEqual(["getServer"]);
    // Base plus budget, declared at launch — nothing is bought in source.
    expect(world.execs[0].ramGb).toBe(RESIDENT_BASE_GB + 8);
    await proxy.free();
  });

  test("a repeated member is memoised: one resident, no re-pricing", async () => {
    const world = realm({ members: { getServer: { gb: 2 }, getServerMaxRam: { gb: 0.05 } } });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    for (let i = 0; i < 20; i++) await proxy.call("getServer", "n00dles");
    await proxy.call("getServerMaxRam", "n00dles");

    // A function's cost is charged once per running script, so twenty reads of
    // the same member cost what one costs.
    expect(world.execs).toHaveLength(1);
    expect(world.residents[0].calls).toHaveLength(21);
    await proxy.free();
  });

  test("the resident recycles when the budget fills, and keeps serving", async () => {
    const world = realm({
      members: { a: { gb: 3 }, b: { gb: 3 }, c: { gb: 3 } },
    });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 7, place: world.place });

    await loose(proxy)("a");
    await loose(proxy)("b");
    expect(world.execs).toHaveLength(1);
    // 3 + 3 + 3 > 7: the third member cannot be paid for on this resident.
    await loose(proxy)("c");
    expect(world.execs).toHaveLength(2);
    // It also LEARNS: a recycle means the members in use did not fit together,
    // so the next ask covers the working set that overflowed (3 + 3 + 3 plus
    // the margin) rather than repeating the size that just failed. Without
    // this, a round-robin over members that overflow costs one process per
    // call for ever, because each respawn clears the memo.
    expect(proxy.grantedGb() - RESIDENT_BASE_GB).toBeCloseTo(9.5, 6);
    await proxy.free();
  });

  test("a call larger than the budget grows the resident instead of failing", async () => {
    const world = realm({ members: { "singularity.getOwnedAugmentations": { gb: 80 } } });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    await loose(proxy)("singularity.getOwnedAugmentations");

    expect(proxy.grantedGb() - RESIDENT_BASE_GB).toBe(80.5);
    expect(world.execs[world.execs.length - 1].ramGb).toBe(RESIDENT_BASE_GB + 80.5);
    await proxy.free();
  });

  test("exec routes through nsMain and never touches a resident", async () => {
    const world = realm({ members: { getServer: { gb: 2 } } });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    // No resident is spawned for it, and it is not priced against the budget:
    // start.js already paid exec's 1.3 GB, and home holds the TOR edge.
    const pid = await loose(proxy)("exec", "lib/ns-resident.js", "home", {}) as number;
    expect(pid).toBeGreaterThan(0);
    expect(world.residents.filter((r) => r.host !== "home")).toHaveLength(0);
    await proxy.free();
  });

  test("guaranteeFit prepays an authority sequence and keeps it on one resident", async () => {
    const world = realm({
      members: {
        a: { gb: 1.5 },
        "dnet.connectToSession": { gb: 0.05, impl: () => ({ success: true, code: 200 }) },
        exec: { gb: 1.3, impl: () => 77 },
      },
    });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 2, place: world.place });

    await loose(proxy)("a");
    const first = world.residents[0]!;
    const pid = await proxy.call.guaranteeFit(
      ["dnet.connectToSession", "exec"],
      async (resident) => {
        const connected = await (resident as LooseCall)("dnet.connectToSession", "dn-1", "pw");
        expect(connected).toMatchObject({ success: true });
        return await (resident as LooseCall)("exec", "dnet/agent.js", "dn-1", {});
      },
    );

    expect(pid).toBe(77);
    expect(world.residents).toHaveLength(2);
    expect(first.alive).toBe(false);
    expect(world.residents[1]!.calls).toEqual(["dnet.connectToSession", "exec"]);
    // Leased exec is intentionally resident-bound; the nsMain exec list still
    // contains only the resident launches themselves.
    expect(world.execs).toHaveLength(2);
    await proxy.free();
  });

  test("guaranteeFit rejects undeclared calls and free waits for the lease", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const world = realm({
      members: {
        slow: { gb: 1, impl: () => gate },
        quick: { gb: 1 },
      },
    });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    await expect(proxy.call.guaranteeFit(["slow"], (resident) =>
      (resident as LooseCall)("quick"))).rejects.toThrow("undeclared ns.quick");

    let leaseDone = false;
    const lease = proxy.call.guaranteeFit(["slow"], async (resident) => {
      await (resident as LooseCall)("slow");
      leaseDone = true;
    });
    await Promise.resolve();
    const freeing = proxy.free();
    await Promise.resolve();
    expect(world.placements[0]!.released).toBe(false);
    expect(leaseDone).toBe(false);
    release();
    await Promise.all([lease, freeing]);
    expect(world.placements[0]!.released).toBe(true);
  });

  test("a failed leased member invalidates its resident before the whole-pair retry", async () => {
    let calls = 0;
    const world = realm({
      members: {
        authority: {
          gb: 1,
          impl: () => {
            calls++;
            if (calls === 1) throw new Error("resident disappeared");
            return "fresh";
          },
        },
      },
    });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 4, place: world.place });

    await expect(proxy.call.guaranteeFit(["authority"], (resident) =>
      (resident as LooseCall)("authority"))).rejects.toThrow("resident disappeared");
    const retried = await proxy.call.guaranteeFit(["authority"], (resident) =>
      (resident as LooseCall)("authority"));

    expect(retried).toBe("fresh");
    expect(world.residents).toHaveLength(2);
    expect(world.residents[0]!.alive).toBe(false);
    await proxy.free();
  });

  test("calls on one resident are serialised, so a pending await never overlaps", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const world = realm({
      members: {
        slow: { gb: 1, impl: () => gate.then(() => { order.push("slow"); return "slow"; }) },
        quick: { gb: 1, impl: () => { order.push("quick"); return "quick"; } },
      },
    });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    const slow = loose(proxy)("slow");
    const quick = loose(proxy)("quick");
    await Promise.resolve();
    // Bitburner allows one Netscript call per script: `quick` must not reach
    // the resident while `slow` holds it, or the engine throws CONCURRENCY
    // ERROR. See game/dnet/prober.ts.
    expect(order).toEqual([]);
    release();
    await Promise.all([slow, quick]);
    expect(order).toEqual(["slow", "quick"]);
    await proxy.free();
  });

  test("an error from the ns member reaches the caller and the proxy keeps working", async () => {
    const world = realm({
      members: {
        boom: { gb: 1, impl: () => { throw new Error("gang API unavailable"); } },
        fine: { gb: 1, impl: () => "ok" },
      },
    });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    await expect(loose(proxy)("boom")).rejects.toThrow("gang API unavailable");
    expect(await loose(proxy)("fine")).toBe("ok");
    await proxy.free();
  });

  test("a refused exec retries rather than throwing, and reports the stall", async () => {
    const events: string[] = [];
    setProxyEventSink((name) => events.push(name));
    const world = realm({ members: { getServer: { gb: 2 } }, refuseExecs: 3 });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    expect(await loose(proxy)("getServer", "n00dles")).toBe("getServer");
    // Each refusal hands its placement back, so the next attempt sees the
    // host's real free RAM instead of leaking a lease per try.
    expect(world.placements.filter((p) => p.released)).toHaveLength(3);
    expect(events).toContain("proxy.spawn");
    await proxy.free();
  });

  test("an unpriceable member costs the conservative ceiling, never zero", async () => {
    const world = realm({ members: { getServer: { gb: 2 } } });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    // `getFunctionRamCost` throws on a renamed API. Pricing that as free would
    // under-allocate and let the engine kill the resident mid-call.
    await loose(proxy)("renamedAway").catch(() => {});
    expect(proxy.grantedGb() - RESIDENT_BASE_GB).toBe(80.5);
    await proxy.free();
  });

  test("sizes itself to what the fleet can offer, and grows as bigger hosts root", async () => {
    // Cold boot: home's reserve is all there is, so the resident takes what
    // fits rather than spinning for a block nothing can hold.
    const world = realm({
      members: { getServer: { gb: 2 }, "singularity.getOwnedAugmentations": { gb: 6 } },
      grantCapGb: 4.1,
    });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 14.4, place: world.place });

    await loose(proxy)("getServer", "n00dles");
    expect(world.execs[0].ramGb).toBe(4.1);
    expect(proxy.grantedGb() - RESIDENT_BASE_GB).toBeCloseTo(2.5, 6);

    // foodnstuff roots: the next respawn is simply granted more, with no
    // ladder logic of its own.
    world.setGrantCap(16);
    await loose(proxy)("singularity.getOwnedAugmentations");
    expect(world.execs[world.execs.length - 1].ramGb).toBe(16);
    expect(proxy.grantedGb() - RESIDENT_BASE_GB).toBeCloseTo(14.4, 6);
    await proxy.free();
  });

  test("a grant below what the pending call needs is refused, not accepted", async () => {
    const events: string[] = [];
    setProxyEventSink((name) => events.push(name));
    // 80 GB of singularity against a 4.1 GB fleet: accepting the small block
    // would put the resident on a host that kills it mid-call for overrunning.
    const world = realm({ members: { "singularity.getOwnedAugmentations": { gb: 80 } }, grantCapGb: 4.1 });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    let settled = false;
    void loose(proxy)("singularity.getOwnedAugmentations").then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(world.execs).toHaveLength(0);

    // The carve opens; the same call then lands without the caller retrying.
    world.setGrantCap(128);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(world.execs[0].ramGb).toBe(82.1);
    await proxy.free();
  });

  test("free releases the placement so the host returns to the farm", async () => {
    const world = realm({ members: { getServer: { gb: 2 } } });
    const proxy = createNsProxy({ label: "nsp", budgetGb: 8, place: world.place });

    await proxy.call("getServer", "n00dles");
    expect(world.placements[0].released).toBe(false);
    await proxy.free();
    expect(world.placements[0].released).toBe(true);
    expect(proxy.host()).toBeUndefined();
  });
});

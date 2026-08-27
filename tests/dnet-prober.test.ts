import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { main as proberMain } from "../game/dnet/prober.ts";
import type { DnetProbeRefresh, DnetProbeReport, DnetProberLaunch } from "../game/dnet/launch.ts";
import { handoffLaunch } from "../game/lib/launch-shared.ts";
import {
  DNET_PROTOCOL,
  PROBER_ARMOURED_GB,
  dnetRealm,
  type ControllerHandle,
  type HostEntry,
} from "../game/dnet/shared.ts";

const HOST = "hydro_org";
const NEIGHBOURS = ["darkweb", "stasis_link", "hydro_org_cache"];
const PROBER_PID = 4242;

/** A minimal live controller that does what the real one does with a lender:
 * keeps the `ns`, and probes THROUGH it rather than waiting to be told. */
function installController(): {
  controller: ControllerHandle;
  hosts: Map<string, HostEntry>;
  wakes: () => string[];
  respawns: () => { host: string; pid: number; launchId: number }[];
  refuseRespawns: () => void;
} {
  const wakes: string[] = [];
  const respawns: { host: string; pid: number; launchId: number }[] = [];
  let allowRespawn = true;
  const hosts = new Map<string, HostEntry>();
  const controller = {
    protocol: DNET_PROTOCOL,
    generation: "15:0",
    hosts,
    mutationEpoch: 0,
    wake(cause: string) { wakes.push(cause); },
    announceProberRespawn(host: string, pid: number, launchId: number) {
      respawns.push({ host, pid, launchId });
      return allowRespawn;
    },
    markProberKill() {},
    lend(host: string, borrowed: NS, pid: number, refresh?: DnetProbeRefresh, armoured?: boolean) {
      const entry = hosts.get(host)
        ?? { hostname: host, lastSeenAt: 0, seenAt: {}, dirty: {}, staged: [] };
      entry.ns = borrowed;
      const neighbours = borrowed.dnet.probe();
      entry.prober = { neighbours: [...neighbours], at: Date.now(), pid, epoch: 0, ...(armoured ? { armoured: true } : {}) };
      hosts.set(host, entry);
      refresh?.settle({ host, neighbours, at: Date.now(), pid });
    },
  } as unknown as ControllerHandle;
  dnetRealm().dnet_controller = controller;
  return {
    controller, hosts, wakes: () => wakes,
    respawns: () => respawns,
    refuseRespawns: () => { allowRespawn = false; },
  };
}

/** The prober's `ns`. `probe` is the host-bound call it exists to lend; the
 *  exit hooks are captured so a test can fire them like the engine would. */
function proberNs(pid = PROBER_PID): {
  ns: NS;
  probes: () => number;
  exit: () => void;
  spawns: () => { file: string; options: Record<string, unknown>; args: unknown[] }[];
  hookIds: () => (string | undefined)[];
} {
  let probes = 0;
  const hooks: { id?: string; fn: () => void }[] = [];
  const spawns: { file: string; options: Record<string, unknown>; args: unknown[] }[] = [];
  const ns = {
    disableLog: () => {},
    pid,
    args: [] as unknown[],
    atExit: (fn: () => void, id?: string) => { hooks.push({ id, fn }); },
    dnet: { probe: () => { probes++; return [...NEIGHBOURS]; } },
    // `spawn` throws ScriptDeath upstream, so nothing after it in the handler
    // runs. Modelled, because the handler's ordering depends on it.
    spawn: (file: string, options: Record<string, unknown>, ...args: unknown[]) => {
      spawns.push({ file, options, args });
      throw new Error("ScriptDeath");
    },
  } as unknown as NS;
  return {
    ns,
    probes: () => probes,
    spawns: () => spawns,
    hookIds: () => hooks.map((hook) => hook.id),
    // The engine wraps EACH handler in its own try/catch and runs them all, so
    // one that throws cannot stop the rest. Reproduced exactly.
    exit: () => { for (const hook of hooks) { try { hook.fn(); } catch { /* as the engine does */ } } },
  };
}

/** Wrapped in an object on purpose: the prober's `main` never resolves, and
 *  returning it bare from an async function would make `await` unwrap it and
 *  hang the test on the park it is supposed to be asserting. */
async function launch(
  ns: NS,
  refresh?: DnetProbeRefresh,
  armoured = false,
): Promise<{ running: Promise<void> }> {
  let running!: Promise<void>;
  await handoffLaunch<DnetProberLaunch>(
    {
      kind: "dnet-prober",
      host: HOST,
      ...(refresh !== undefined ? { refresh } : {}),
      ...(armoured ? { armoured: true } : {}),
    },
    (launchId) => {
      (ns.args as unknown[]).push(launchId);
      running = proberMain(ns);
      return (ns as unknown as { pid: number }).pid;
    },
  );
  return { running };
}

afterEach(() => {
  delete dnetRealm().dnet_controller;
});

describe("the prober lends its ns and then does nothing", () => {
  test("it checks in, and the controller probes through the borrowed ns", async () => {
    const live = installController();
    const { ns, probes } = proberNs();
    let settled: DnetProbeReport | undefined;
    const refresh: DnetProbeRefresh = {
      refreshed: Promise.resolve(undefined),
      settle(value) { settled = value; },
    };

    await launch(ns, refresh);

    // The prober itself never called `probe` — the CONTROLLER did, through the
    // `ns` this process is holding RAM for. That is the whole design: the
    // allocation is here, the decision is there.
    expect(probes()).toBe(1);
    expect(live.hosts.get(HOST)?.ns).toBe(ns);
    expect(live.hosts.get(HOST)?.prober).toMatchObject({ neighbours: NEIGHBOURS, pid: PROBER_PID });
    // The plant awaits this before it execs the agent, so a freshly planted
    // host is on the map before the launch chain continues.
    expect(settled).toMatchObject({ host: HOST, neighbours: NEIGHBOURS, pid: PROBER_PID });
  });

  test("it parks for ever, holding no Netscript call", async () => {
    installController();
    const { ns } = proberNs();
    let finished = false;
    void (await launch(ns)).running.then(() => { finished = true; });

    // A prober that ever resolved would free the RAM the lent `ns` is billed
    // against. A prober that AWAITED anything of its own would hold
    // `env.runningFn` and make every borrowed call throw CONCURRENCY ERROR —
    // which is why it parks on a plain Promise and not on `ns.asleep`.
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished, "the prober returned; its RAM and its lent ns are gone").toBe(false);
  });

  test("its atExit retracts the lent ns, and says so", async () => {
    const live = installController();
    const { ns, exit } = proberNs();
    await launch(ns);
    expect(live.hosts.get(HOST)?.ns).toBe(ns);

    // Death is an EVENT, not an absence inferred from a stale timestamp: the
    // engine runs `atExit` on a kill too, so this is the one place that can
    // promise a dead `ns` is never called.
    exit();
    expect(live.hosts.get(HOST)?.ns).toBeUndefined();
    expect(live.wakes()).toContain("prober-died");
  });

  test("a late exit never retracts a REPLACEMENT's ns", async () => {
    const live = installController();
    const first = proberNs();
    await launch(first.ns);

    const second = proberNs();
    await launch(second.ns);
    expect(live.hosts.get(HOST)?.ns).toBe(second.ns);

    // The old process dies after the new one checked in. Identity is what
    // stops it taking the live lender down with it.
    first.exit();
    expect(live.hosts.get(HOST)?.ns).toBe(second.ns);
  });

  test("an UNARMOURED prober never schedules a successor", async () => {
    const live = installController();
    const { ns, exit, spawns } = proberNs();
    await launch(ns);
    exit();
    // The default fleet pays 3.15 GB and has no `spawn` to call. A prober that
    // spawned without its launcher having sized it for one would be killed
    // mid-call by the engine's dynamic RAM check.
    expect(spawns()).toEqual([]);
    expect(live.respawns()).toEqual([]);
  });

  test("an armoured prober spawns its successor with a NON-ZERO delay", async () => {
    const live = installController();
    const { ns, exit, spawns } = proberNs();
    await launch(ns, undefined, true);
    expect(live.hosts.get(HOST)?.prober?.armoured).toBe(true);

    exit();

    // The whole mechanism in one assertion. `killServerScripts` runs this
    // handler inside a live iterator over the host's running-script map, so a
    // zero-delay launch is appended to that map and killed by the same sweep.
    // A non-zero delay defers to a macrotask that runs after the entire restart
    // transaction, and upstream never cancels the timer.
    expect(spawns()).toHaveLength(1);
    const [spawned] = spawns();
    expect(spawned!.file).toBe("dnet/prober.js");
    expect(spawned!.options["spawnDelay"]).toBeGreaterThan(0);
    // Sized for the surface it is about to use, including the `spawn` it will
    // need to defend itself again.
    expect(spawned!.options["ramOverride"]).toBe(PROBER_ARMOURED_GB);
    // The controller was told BEFORE the spawn, so no repair path can exec a
    // duplicate into the gap.
    expect(live.respawns()).toEqual([{ host: HOST, pid: PROBER_PID, launchId: spawned!.args[0] as number }]);
  });

  test("a DELIBERATE kill stands the armour down instead of respawning", async () => {
    const live = installController();
    const { ns, exit, spawns } = proberNs();
    await launch(ns, undefined, true);
    // What a replacement, a walk displacement or a resize does: the controller
    // refuses the respawn because it ordered this death itself.
    live.refuseRespawns();

    exit();

    // Without this the controller could never retire a prober at all — every
    // kill would be undone a millisecond later, for ever.
    expect(spawns()).toEqual([]);
  });

  test("the armour hook cannot stop the lent ns from being retracted", async () => {
    const live = installController();
    const { ns, exit, hookIds } = proberNs();
    await launch(ns, undefined, true);

    // Checkout is registered FIRST and the armour hook second, and the armour
    // hook always throws (ScriptDeath, out of `spawn`). The engine wraps each
    // handler separately and runs them all, so the retraction still happens —
    // but the ordering is what makes it true regardless.
    expect(hookIds()).toEqual(["dnet-prober-checkout", "dnet-prober-armour"]);
    exit();
    expect(live.hosts.get(HOST)?.ns).toBeUndefined();
    expect(live.wakes()).toContain("prober-died");
  });

  test("with no controller it lends nothing and exits", async () => {
    delete dnetRealm().dnet_controller;
    const { ns, probes } = proberNs();
    await (await launch(ns)).running;
    expect(probes()).toBe(0);
  });
});

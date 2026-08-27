import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { main as proberMain } from "../game/dnet/prober.ts";
import type { DnetProbeRefresh, DnetProbeReport, DnetProberLaunch } from "../game/dnet/launch.ts";
import { handoffLaunch } from "../game/lib/launch-shared.ts";
import {
  DNET_PROTOCOL,
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
} {
  const wakes: string[] = [];
  const hosts = new Map<string, HostEntry>();
  const controller = {
    protocol: DNET_PROTOCOL,
    generation: "15:0",
    hosts,
    mutationEpoch: 0,
    wake(cause: string) { wakes.push(cause); },
    lend(host: string, borrowed: NS, pid: number, refresh?: DnetProbeRefresh) {
      const entry = hosts.get(host)
        ?? { hostname: host, lastSeenAt: 0, seenAt: {}, dirty: {}, staged: [] };
      entry.ns = borrowed;
      const neighbours = borrowed.dnet.probe();
      entry.prober = { neighbours: [...neighbours], at: Date.now(), pid, epoch: 0 };
      hosts.set(host, entry);
      refresh?.settle({ host, neighbours, at: Date.now(), pid });
    },
  } as unknown as ControllerHandle;
  dnetRealm().dnet_controller = controller;
  return { controller, hosts, wakes: () => wakes };
}

/** The prober's `ns`. `probe` is the host-bound call it exists to lend; the
 *  exit hooks are captured so a test can fire them like the engine would. */
function proberNs(): { ns: NS; probes: () => number; exit: () => void } {
  let probes = 0;
  const hooks: (() => void)[] = [];
  const ns = {
    disableLog: () => {},
    pid: PROBER_PID,
    args: [] as unknown[],
    atExit: (fn: () => void) => { hooks.push(fn); },
    dnet: { probe: () => { probes++; return [...NEIGHBOURS]; } },
  } as unknown as NS;
  return { ns, probes: () => probes, exit: () => { for (const fn of hooks) fn(); } };
}

/** Wrapped in an object on purpose: the prober's `main` never resolves, and
 *  returning it bare from an async function would make `await` unwrap it and
 *  hang the test on the park it is supposed to be asserting. */
async function launch(ns: NS, refresh?: DnetProbeRefresh): Promise<{ running: Promise<void> }> {
  let running!: Promise<void>;
  await handoffLaunch<DnetProberLaunch>(
    { kind: "dnet-prober", host: HOST, ...(refresh !== undefined ? { refresh } : {}) },
    (launchId) => { (ns.args as unknown[]).push(launchId); running = proberMain(ns); return PROBER_PID; },
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

  test("with no controller it lends nothing and exits", async () => {
    delete dnetRealm().dnet_controller;
    const { ns, probes } = proberNs();
    await (await launch(ns)).running;
    expect(probes()).toBe(0);
  });
});

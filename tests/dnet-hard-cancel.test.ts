import { makeOrder } from './support/dnet-order.ts';
import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { installVirtualTime, type VirtualTime } from "../sim/realm/timers.ts";
import { SimWorld } from "../sim/world.ts";
import { ProcessTable } from "../sim/ns/process.ts";
import { makeSimNs, type SimNsHost } from "../sim/ns/api.ts";
import { darkwebServerSpec } from "../sim/network.ts";
import { main as agentMain } from "../game/dnet/agent.ts";
import { offerLaunch } from "../game/lib/launch-shared.ts";
import type { DnetAgentLaunch } from "../game/dnet/launch.ts";
import { awaitDnetOperation, RELEASED } from "../game/dnet/timing.ts";
import {
  DNET_PROTOCOL,
  dnetRealm,
  type AgentIo,
  type AgentHandle,
  type ControllerDeps,
  type ControllerHandle,
  type DnetHostEntries,
  type HostEntry,
  type Order,
  type OrderKind,
  type Report,
} from "../game/dnet/shared.ts";

/** Cancelling a running order, end to end: the REAL agent, stopped the way the
 * controller stops it.
 *
 * Two mechanisms, and the difference between them is the point. RELEASE lets a
 * body stop WAITING on an engine call whose result nobody wants any more — it
 * settles a cancelled report at once, and the controller re-plans in that
 * instant. It does NOT give the script back: Bitburner allows one Netscript
 * call per script, and the released call keeps that slot until the engine
 * finishes it. Recovering the HOST takes `ns.kill`, which is the only thing
 * that clears `env.runningFn`. So release and kill are both needed, and each
 * one alone leaves something behind.
 *
 * Orders are DATA, not closures, so the rig cannot inject a job body. It drives
 * real order kinds through `runOrder` over an `ns` whose `dnet` namespace is a
 * stub: a `bleed` whose `heartbleed` parks in a killable `ns.sleep` stands in
 * for a blocking call, and a `bleed` against an offline host for an instant
 * one. The sim's teardown ordering is pinned separately by
 * `sim/tests/process-atexit.test.ts`.
 *
 * NOT covered here, and not covered anywhere: `cancelActive` itself. It is a
 * closure inside the controller's `main`, so no test can call it — these tests
 * hand-drive the release and the kill it performs. Deleting its `killPid` call
 * leaves the whole suite green.
 *
 * What must never regress: a released body reports `cancelled` rather than
 * failed, release alone never frees the host and never crashes the body,
 * release-then-kill does free it, a body ORPHANED at a boundary stops there
 * rather than spending its call, a clean order drops its handle, a worker
 * started with no order exits at once, and a game kill settles `died` and
 * launches nothing. */

const GENERATION = "15:0";
/** A target the stub `heartbleed` parks on in a killable `ns.sleep`. */
const BLOCKED_TARGET = "dn-block";

// --- the fake controller ------------------------------------------------------

const noopDeps: ControllerDeps = {
  charisma: () => 1_000,
  timing: () => ({ charisma: 1_000, intelligence: 0, hasBoots: false, sf15Level: 0, authenticationDurationMultiplier: 1 }),
  expectedDelayMs: () => 10_000,
  ledgerFor: () => undefined,
  ringFor: () => undefined,
  recordAttempt: () => {},
  recordLogDrain: () => {},
  recordCredential: () => {},
  recordLoose: () => {},
  recordProvisional: () => {},
  recordNeighbourPassword: () => {},
  recordFileEvidence: () => {},
  labField: () => undefined,
  publishLabField: () => {},
};

interface Rig {
  host: SimNsHost;
  world: SimWorld;
  processes: ProcessTable;
  controller: ControllerHandle;
  controllerNs: NS;
  /** Every report any adopted handle settled, in settle order. */
  reports: Report[];
  /** Every adoption the fake controller saw, in order. */
  adopted: { kind: OrderKind; pid: number; startedAt: number; orderStartedAt?: number }[];
  /** Every `wake(cause)` the agent sent the controller. */
  wakes: string[];
  /** Make the stubbed `setStasisLink` park in a killable sleep. */
  pinBlocks: { value: boolean };
  /** Hold / open the dependency latch a `bleed` awaits before its call. */
  holdAfterOrders: () => void;
  releaseAfterOrders: () => void;
  /** The controller's own `ensureEntry`, so a test can create the host record
   *  the real one would have made before it dispatched. */
  ensure: (hostname: string) => HostEntry;
  entry: () => HostEntry | undefined;
}

function rig(): Rig {
  const bitnode = 15;
  const world = new SimWorld({ seed: 1, bitnode, network: [darkwebServerSpec()] });
  // The resident's poll parks on `realmSleep` — a bare global setTimeout — so
  // the rig must move the realm's timers onto the sim clock, exactly as
  // sim/game-run.ts does. Without this, the poll waits real seconds the
  // virtual clock never advances through, and the leaked real timer fires
  // into whatever test runs next.
  vt = installVirtualTime(world.clock);
  const processes = new ProcessTable(world.servers, world.clock);
  const files = new Map<string, Set<string>>([
    ["home", new Set(["agent.js"])],
    ["darkweb", new Set(["agent.js"])],
  ]);
  const network = new Map<string, string[]>([
    ["home", ["darkweb"]],
    ["darkweb", ["home"]],
  ]);

  const pinBlocks = { value: false };
  // The dependency latch a `bleed` with `followAttemptIds` parks on. Open by
  // default; a test holds it to catch the body at that boundary.
  let latch: Promise<void> = Promise.resolve();
  let openLatch: (() => void) | undefined;
  const holdAfterOrders = (): void => { latch = new Promise<void>((resolve) => { openLatch = resolve; }); };
  const releaseAfterOrders = (): void => { openLatch?.(); openLatch = undefined; };
  // The agent runs orders through `runOrder`'s switch of direct ns.dnet calls,
  // so blocking-vs-instant is steered by the stubbed namespace rather than an
  // injected body. `heartbleed` on BLOCKED_TARGET suspends in a killable
  // netscriptDelay, precisely where a real `authenticate` would be.
  const withStubDnet = (ns: NS): NS => {
    const dnet = {
      heartbleed: async (target: string) => {
        if (target === BLOCKED_TARGET) await ns.sleep(600_000);
        return { success: true, code: 200, message: "ok", logs: [] as string[] };
      },
      getServerDetails: () => ({ isOnline: false }),
      setStasisLink: async () => {
        if (pinBlocks.value) await ns.sleep(600_000);
        return { success: true, code: 200, message: "ok" };
      },
      probe: () => [] as string[],
    };
    return new Proxy(ns as object, {
      get: (target, prop, receiver) => (prop === "dnet" ? dnet : Reflect.get(target, prop, receiver) as unknown),
    }) as NS;
  };

  const host = {
    world,
    clock: world.clock,
    processes,
    files,
    contents: new Map<string, string>(),
    scripts: new Map<string, (ns: NS) => Promise<void>>([["agent.js", (ns) => agentMain(withStubDnet(ns))]]),
    network,
    ramCtx: { bitNode: bitnode },
    output: [],
    crashes: [],
  } as unknown as SimNsHost;

  const controllerProcess = processes.start({
    filename: "controller.js",
    host: "home",
    args: [],
    threads: 1,
    ramPerThreadGb: 1,
    temporary: false,
  })!;
  const controllerNs = makeSimNs(host, controllerProcess);

  const hosts: DnetHostEntries = new Map();
  const reports: Report[] = [];
  const adopted: { kind: OrderKind; pid: number; startedAt: number; orderStartedAt?: number }[] = [];
  const wakes: string[] = [];
  const ensure = (hostname: string): HostEntry => {
    const existing = hosts.get(hostname);
    if (existing) return existing;
    const created: HostEntry = { hostname, lastSeenAt: Date.now(), seenAt: {}, dirty: {}, staged: [] };
    hosts.set(hostname, created);
    return created;
  };
  const controller: ControllerHandle = {
    protocol: DNET_PROTOCOL,
    buildId: "test",
    generation: GENERATION,
    pid: controllerProcess.pid,
    startedAt: Date.now(),
    lastBeatAt: Date.now(),
    hosts,
    mutationEpoch: 0,
    noteMutation: () => 0,
    wake: (cause) => void wakes.push(cause),
    // The real controller settles this at the end of the derive its caller's
    // report triggers; the stub has no derive, so it settles at once.
    derived: () => Promise.resolve(),
    announceLaunch: () => {},
    announceProbeRefresh: () => {},
    lend: () => {},
    adopt: (hostname, handle) => {
      // What the real controller does with an adoption: the handle becomes THE
      // process on that host's entry, and its settle is observed.
      const entry = ensure(hostname);
      entry.agent = handle;
      adopted.push({ kind: handle.order.kind, pid: handle.pid, startedAt: handle.startedAt, orderStartedAt: handle.order.startedAt });
      void handle.done.then((report) => void reports.push(report));
    },
    afterOrders: () => latch,
    beginProbeRefresh: () => { throw new Error("not used"); },
    cancelProbeRefresh: () => {},
    reportProbe: () => {},
    preparePlant: () => ({ controllerManaged: false, reuseProber: false }),
    claimPlanted: () => undefined,
    abandonPlant: () => {},
    registerBootstrap: () => {},
    bootstrapDone: () => {},
    deps: noopDeps,
    snapshot: () => { throw new Error("not snapshotted here"); },
    configure: () => {},
    standDown: () => {},
  };
  dnetRealm().dnet_controller = controller;

  return {
    ensure,
    host,
    world,
    processes,
    controller,
    controllerNs,
    reports,
    adopted,
    wakes,
    pinBlocks,
    holdAfterOrders,
    releaseAfterOrders,
    entry: () => hosts.get("darkweb"),
  };
}

let vt: VirtualTime | undefined;
afterEach(() => {
  delete dnetRealm().dnet_controller;
  vt?.restore();
  vt = undefined;
});


/** Start an order the way the controller now does: stamp the handoff slot,
 * then `exec` a worker sized for exactly that order.
 *
 * There is no resident to wake and no successor chain to fall into. The
 * controller holds the launcher — it execs through the host's prober `ns` — so
 * staging and starting are one act, and the worker carries no `spawn`. */
function start(r: Rig, order: Order): number {
  const entry = r.ensure("darkweb");
  entry.pendingOrder = order;
  const { launchId } = offerLaunch<DnetAgentLaunch>({ kind: "dnet-agent", host: "darkweb" });
  return r.controllerNs.exec(
    "agent.js",
    "darkweb",
    { threads: order.threads, ramOverride: order.ramOverrideGb, temporary: true },
    launchId,
  );
}

/** Drive the clock until an order of this kind is deep inside its blocking ns
 * call — `runningFn` set means the process is suspended in a netscriptDelay. */
async function inFlight(r: Rig, kind: OrderKind): Promise<AgentHandle> {
  await r.world.clock.runAsync(() => {
    const handle = r.entry()?.agent;
    return handle?.order.kind === kind
      && handle.pid > 0
      && r.processes.get(handle.pid)?.runningFn !== undefined;
  }, 60_000);
  return r.entry()!.agent!;
}

describe("release: letting a body out of a call it is waiting on", () => {
  // A body inside a multi-second Darknet call has no boundary at which to
  // notice anything, so it publishes a release hook: pulling it lets the body
  // stop waiting for a result nobody wants any more, and the controller
  // re-plans that instant.
  //
  // What it does NOT do is give the script back. Bitburner allows one Netscript
  // call per script at a time, and the released call keeps that slot until the
  // engine finishes it — so the body can settle its report and then only wait.
  // Recovering the HOST takes a kill, the one thing that clears
  // `env.runningFn`.
  // What a release does AT THE CALL: it rejects the wait with RELEASED and hands
  // the still-running engine call to the exit path. Turning that sentinel into a
  // `cancelled` report is `runOrderToReport`'s job, and is pinned by the next
  // test — this one never builds a report at all.
  test("a released wait rejects with RELEASED and publishes the outstanding call", async () => {
    let release: (() => void) | undefined;
    let inFlightCall: Promise<unknown> | undefined;
    const io = {
      beat: () => {},
      setExpectedDoneAt: () => {},
      hold: (hook: (() => void) | undefined) => { release = hook; },
      inFlight: (settling: Promise<unknown>) => { inFlightCall = settling; },
      cancelled: () => "orphaned",
      deps: { expectedDelayMs: () => undefined } as unknown as AgentIo["deps"],
    } as AgentIo;

    // A call that never settles — the engine's own work is not cancellable,
    // and that is precisely why waiting for it has to be.
    const waiting = awaitDnetOperation(io, { operation: "authenticate", host: "h", from: "v", threads: 1 },
      () => new Promise<never>(() => {}));
    await Promise.resolve();
    expect(release, "the body never published a release hook").toBeDefined();
    release!();
    await expect(waiting).rejects.toBe(RELEASED);
    // And it handed the still-running call to the exit path. Until that settles
    // every `ns` member in this process throws CONCURRENCY ERROR.
    expect(inFlightCall, "a released body must publish the call it walked away from").toBeDefined();
  });

  test("a release alone never crashes the body, and never frees the host either", async () => {
    const r = rig();
    start(r, makeOrder("bleed", { host: BLOCKED_TARGET, from: "darkweb" }, {}));
    const handle = await inFlight(r, "bleed");
    const orderPid = handle.pid;
    expect(handle.release, "a body inside an engine call publishes its release hook").toBeDefined();

    handle.release!();
    const report = await handle.done;
    expect(report).toMatchObject({ ok: false, targetState: "cancelled" });
    for (let drain = 0; drain < 8; drain++) await Promise.resolve();

    // HALF ONE — the safety net. The engine call is still running and still
    // owns this script's only Netscript slot, so an exit path that touched `ns`
    // would throw `Concurrent calls to Netscript functions are not allowed!`.
    // The sim models that rule and records the crash.
    expect(r.host.crashes).toEqual([]);

    // HALF TWO — and why the net alone is not a fix. Waiting for an engine call
    // is all a released body CAN do, and this one has 600s left to run. The
    // host stays occupied for every second of it, so the controller cannot
    // dispatch anything else there. That is why `cancelActive` follows a
    // release with a kill.
    expect(r.processes.ps("darkweb").map((p) => p.pid)).toEqual([orderPid]);
  });

  // ORPHANED is the one thing `cancelled()` still reports, and it is how a body
  // learns the controller gave up on its host: `retireVantage` drops the handle
  // and tells nobody. The body has to notice at its own next boundary — before
  // it spends an engine call whose result nobody will read, on a host the
  // controller already believes is free.
  test("a body orphaned while it waits stops instead of spending its call", async () => {
    const r = rig();
    // Hold the dependency latch, so the body is parked at a boundary rather
    // than already inside the call.
    r.holdAfterOrders();
    start(r, makeOrder("bleed", { host: BLOCKED_TARGET, from: "darkweb" },
      { followAttemptIds: ["attempt:dn-1"] }));
    await r.world.clock.runAsync(() => r.entry()?.agent?.order.kind === "bleed", 60_000);
    const handle = r.entry()!.agent!;

    // Exactly what `retireVantage` does: the handle stops being THE process on
    // this host. Nothing is sent to the body.
    r.entry()!.agent = undefined;
    r.releaseAfterOrders();

    const report = await handle.done;
    expect(report).toMatchObject({ ok: false, targetState: "cancelled", detail: "orphaned" });
    // And it never reached `heartbleed`, which on this target parks for 600s.
    // An orphan that spent its call would hold the host for every second of it.
    await r.world.clock.runAsync(() => r.processes.ps("darkweb").length === 0, 60_000);
    expect(r.host.crashes).toEqual([]);
  });

  test("release then kill is what actually hands the host back", async () => {
    const r = rig();
    start(r, makeOrder("bleed", { host: BLOCKED_TARGET, from: "darkweb" }, {}));
    const handle = await inFlight(r, "bleed");
    const orderPid = handle.pid;

    // Exactly what `cancelActive` does when `release` is published, meaning the
    // body is inside an engine call. The kill is not a fallback: it is the only
    // thing that clears `env.runningFn`, and the engine clears it BEFORE it
    // runs atExit — so the victim's hook settles on a clean slot.
    handle.release!();
    expect(r.controllerNs.kill(orderPid)).toBe(true);

    expect(r.host.crashes).toEqual([]);
    const report = await handle.done;
    expect(report).toMatchObject({ ok: false, died: true, detail: "killed mid-order" });
    // The host is EMPTY, and that is the point. The worker used to spawn its own
    // successor from inside this kill, which is what put `spawn` — 2.0 GB on
    // every thread — into its surface. The controller launches what comes next.
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.entry()?.agent, "the handle must be dropped so the host reads free").toBeUndefined();
  });
});

describe("a worker runs one order and lets go", () => {
  test("a clean order settles, drops its handle, and leaves the host free", async () => {
    const r = rig();
    start(r, makeOrder("bleed", { host: "dn-quick", from: "darkweb" }, {}));
    await r.world.clock.runAsync(() => r.reports.some((report) => report.kind === "bleed"), 60_000);
    expect(r.reports.find((report) => report.kind === "bleed")).toMatchObject({ ok: true });

    await r.world.clock.runAsync(() => r.processes.ps("darkweb").length === 0, 60_000);
    expect(r.entry()?.agent).toBeUndefined();
    expect(r.host.crashes).toEqual([]);
  });

  test("a worker started with no order exits at once rather than waiting", async () => {
    const r = rig();
    r.ensure("darkweb");
    const { launchId } = offerLaunch<DnetAgentLaunch>({ kind: "dnet-agent", host: "darkweb" });
    r.controllerNs.exec("agent.js", "darkweb", { threads: 1, ramOverride: 4, temporary: true }, launchId);

    // Nothing to wait FOR. The controller launches a worker only once it has
    // staged the order, so a worker that finds none was launched for nothing —
    // and one that lingered would hold RAM the next dispatch needs.
    await r.world.clock.runAsync(() => r.processes.ps("darkweb").length === 0, 60_000);
    expect(r.entry()?.agent).toBeUndefined();
    expect(r.host.crashes).toEqual([]);
  });

  test("a game kill settles died, and launches nothing", async () => {
    const r = rig();
    const pid = start(r, makeOrder("bleed", { host: BLOCKED_TARGET, from: "darkweb" }, {}));
    const handle = await inFlight(r, "bleed");

    // The host restarting under us, or a killall. The hook's whole job is to
    // say so and let go. It never relaunches: a replacement exec'd from here
    // would be killed by the same live-map loop before its first line.
    expect(r.controllerNs.kill(pid)).toBe(true);
    const report = await handle.done;
    expect(report).toMatchObject({ ok: false, died: true });
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.entry()?.agent).toBeUndefined();
    expect(r.host.crashes).toEqual([]);
  });
});

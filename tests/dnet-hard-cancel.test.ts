import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { installVirtualTime, type VirtualTime } from "../sim/realm/timers.ts";
import { SimWorld } from "../sim/world.ts";
import { ProcessTable } from "../sim/ns/process.ts";
import { makeSimNs, type SimNsHost } from "../sim/ns/api.ts";
import { darkwebServerSpec } from "../sim/network.ts";
import { main as agentMain } from "../game/dnet/agent.ts";
import {
  DNET_PROTOCOL,
  dnetRealm,
  hardCancelEligible,
  HARD_CANCEL_EXEMPT_KINDS,
  signalWake,
  type AgentHandle,
  type ControllerDeps,
  type ControllerHandle,
  type DnetHostEntries,
  type HostEntry,
  type Order,
  type OrderKind,
  type Report,
} from "../game/dnet/shared.ts";

/** Hard cancellation, end to end: the REAL agent, killed the way the controller
 * kills it.
 *
 * The design under test is the pair introduced together: the agent's armed
 * atExit hook (settle the murdered order, stage and spawn the successor, all
 * inside the killer's `ns.kill` call) and the controller-side eligibility rule
 * `hardCancelEligible` (an ARMORED handle with a live pid whose kind is not
 * exempt, and nothing else). The sim's teardown ordering is separately pinned
 * by `sim/tests/process-atexit.test.ts`; this file drives
 * `game/dnet/agent.ts`'s actual main() through it.
 *
 * Orders are DATA now, not closures, so the rig cannot inject a job body. It
 * drives real order kinds through `runOrder` instead, over an `ns` whose
 * `dnet` namespace is a stub: a `bleed` whose `heartbleed` parks in a killable
 * `ns.sleep` stands in for the old blocking `authenticate` body, and a quick
 * `bleed` against an offline host stands in for the old instant body. The full
 * seed→spread→cancel→walk path against the real darknet model is covered by
 * sim/tests/dnet-session.test.ts and the sim scenario runs; the old
 * "consecutive PIDs prove atExit chained the successor" closure test survives
 * here as the two-staged-orders chain test.
 *
 * What must never regress: a pin or a walk or an unarmored handle is never
 * eligible, a deliberate mode transition never triggers the hook, a dead
 * controller never respawn-loops, a host-restart killall terminates, a
 * host-delete declines quietly, and the boot-race grace holds. */

const GENERATION = "15:0";
/** game/dnet/agent.ts CONTROLLER_STARTUP_GRACE_MS, not exported. */
const STARTUP_GRACE_MS = 15_000;
/** A target the stub `heartbleed` parks on in a killable `ns.sleep`. */
const BLOCKED_TARGET = "dn-block";

// --- the fake controller ------------------------------------------------------

const noopDeps: ControllerDeps = {
  charisma: () => 1_000,
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
  adopted: { kind: OrderKind; pid: number }[];
  /** Every `wake(cause)` the agent sent the controller. */
  wakes: string[];
  /** Make the stubbed `setStasisLink` park in a killable sleep. */
  pinBlocks: { value: boolean };
  /** Launch the real agent in resident mode on darkweb. */
  plantResident: () => number;
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
  const adopted: { kind: OrderKind; pid: number }[] = [];
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
    adopt: (hostname, handle) => {
      // What the real controller does with an adoption: the handle becomes THE
      // process on that host's entry, and its settle is observed.
      const entry = ensure(hostname);
      entry.agent = handle;
      adopted.push({ kind: handle.order.kind, pid: handle.pid });
      void handle.done.then((report) => void reports.push(report));
    },
    reportProbe: () => {},
    preparePlant: () => {},
    registerBootstrap: () => {},
    bootstrapDone: () => {},
    deps: noopDeps,
    drain: () => {
      throw new Error("not drained here");
    },
    order: () => {},
  };
  dnetRealm().dnet_controller = controller;

  const plantResident = (): number =>
    controllerNs.exec(
      "agent.js",
      "darkweb",
      { threads: 1, ramOverride: 4.45, temporary: true },
      "darkweb",
    );

  return {
    host,
    world,
    processes,
    controller,
    controllerNs,
    reports,
    adopted,
    wakes,
    pinBlocks,
    plantResident,
    entry: () => hosts.get("darkweb"),
  };
}

let vt: VirtualTime | undefined;
afterEach(() => {
  delete dnetRealm().dnet_controller;
  vt?.restore();
  vt = undefined;
});

function makeOrder(kind: OrderKind, overrides: Partial<Order> = {}): Order {
  return {
    id: `${kind}-1`,
    kind,
    host: "darkweb",
    from: "darkweb",
    ramOverrideGb: 4,
    threads: 1,
    priority: 0,
    longLived: kind === "walk",
    label: `${kind} under test`,
    ...overrides,
  };
}

/** Stage an order the way the controller does: push, then wake the resident. */
function stage(r: Rig, order: Order): void {
  const entry = r.entry()!;
  (entry.staged ??= []).push(order);
  signalWake(entry);
}

/** Drive the clock until the resident has joined (adopted an idle handle). */
async function residentJoined(r: Rig): Promise<AgentHandle> {
  await r.world.clock.runAsync(() => r.entry()?.agent?.order.kind === "idle", 60_000);
  return r.entry()!.agent!;
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

describe("hardCancelEligible: the pure licence to kill", () => {
  function handleOf(kind: OrderKind, opts: { armored?: boolean; pid?: number } = {}): AgentHandle {
    const order = makeOrder(kind);
    return {
      pid: opts.pid ?? 0,
      order,
      startedAt: 0,
      beatAt: 0,
      armored: opts.armored === true,
      done: Promise.resolve({ id: order.id, kind, host: order.host, from: order.from, ok: false }),
      settle: () => {},
    };
  }

  test("a walk keeps cooperative cancellation only, and an unarmored handle is never killed", () => {
    // A walk is PID-bound and spawn-free: even armored-and-live it is exempt.
    expect(hardCancelEligible(handleOf("walk", { armored: true, pid: 42 }))).toBe(false);
    // A pin has no spawn budget and therefore no safety net — exempt even when
    // the armor flag is forged onto it.
    expect(hardCancelEligible(handleOf("pin", { armored: true, pid: 42 }))).toBe(false);
    // A pre-armor process is never killed without its net.
    expect(hardCancelEligible(handleOf("attempt", { pid: 42 }))).toBe(false);
    // The one killable shape: armored, live pid, non-exempt kind.
    expect(hardCancelEligible(handleOf("attempt", { armored: true, pid: 42 }))).toBe(true);
    // The sweep also refuses a handle with no pid to vouch.
    expect(hardCancelEligible(handleOf("attempt", { armored: true, pid: 0 }))).toBe(false);
    // The exemption list is exactly the two spawn-less kinds.
    expect([...HARD_CANCEL_EXEMPT_KINDS].sort()).toEqual(["pin", "walk"]);
  });
});

describe("the controller's kill, and the agent's survival of it", () => {
  test("a pointless in-flight order is killed, settles cancelled, and the resident is back before kill returns", async () => {
    const r = rig();
    r.plantResident();
    await residentJoined(r);

    stage(r, makeOrder("bleed", { host: BLOCKED_TARGET }));
    const handle = await inFlight(r, "bleed");
    // Order mode stamped its armor the moment it armed the hook, which is the
    // controller's licence to hard-kill it.
    expect(handle.armored).toBe(true);
    expect(hardCancelEligible(handle)).toBe(true);
    const orderPid = handle.pid;

    // The controller's hard cancel: reason, fire, kill — the reason marks the
    // death a cancellation, and the atExit hook runs synchronously inside kill.
    handle.cancelReason = "credential already verified";
    handle.cancelFire?.();
    expect(r.controllerNs.kill(orderPid)).toBe(true);

    // Everything below was already true when kill returned: the murdered order
    // settled and its resident successor was spawned inside the killer's stack.
    const replacement = r.processes.ps("darkweb");
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.pid).not.toBe(orderPid);
    expect(replacement[0]!.args).toEqual(["darkweb"]);
    const report = await handle.done;
    expect(report).toMatchObject({ ok: false, targetState: "cancelled" });
    expect(report.died).toBeUndefined();

    // The revived resident joins and picks up the next order as though nothing
    // happened — the zombie continuation of the killed process double-books
    // nothing.
    await r.world.clock.runAsync(
      () => r.adopted.some((a) => a.kind === "idle" && a.pid === replacement[0]!.pid),
      60_000,
    );
    stage(r, makeOrder("bleed", { id: "bleed-2", host: "dn-quick" }));
    await r.world.clock.runAsync(() => r.reports.some((report2) => report2.id === "bleed-2"), 60_000);
    expect(r.reports.find((report2) => report2.id === "bleed-2")).toMatchObject({ ok: true });
    expect(r.host.crashes).toEqual([]);
  });

  test("a pin is never armored and never eligible, even flagged and forged; cooperative cancel leaves the host empty", async () => {
    const r = rig();
    r.pinBlocks.value = true;
    r.plantResident();
    await residentJoined(r);

    stage(r, makeOrder("pin"));
    const handle = await inFlight(r, "pin");

    // Order mode never armed it: no spawn in a pin's budget, no safety net.
    expect(handle.armored).toBe(false);
    expect(hardCancelEligible(handle)).toBe(false);
    // Even a forged armor flag does not make an exempt kind killable.
    handle.armored = true;
    expect(hardCancelEligible(handle)).toBe(false);
    handle.armored = false;

    // The cooperative path is all a pin gets: the race falls through, the
    // order settles cancelled, and the process exits WITHOUT a successor —
    // a pin leaves its host empty for the spread planner to re-plant.
    handle.cancelReason = "belief changed";
    handle.cancelFire?.();
    await r.world.clock.runAsync(() => r.reports.some((report) => report.kind === "pin"), 60_000);
    expect(r.reports.find((report) => report.kind === "pin")).toMatchObject({ ok: false, targetState: "cancelled" });
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.host.crashes).toEqual([]);
  });

  test("a clean order exits straight into its staged successor, consecutive pids and no intermediate resident", async () => {
    const r = rig();
    r.plantResident();
    await residentJoined(r);

    // Two orders staged together: the finishing first order's atExit spawn must
    // take the second DIRECTLY, not via a resident bounce.
    const entry = r.entry()!;
    (entry.staged ??= []).push(
      makeOrder("bleed", { id: "bleed-first", host: "dn-quick" }),
      makeOrder("bleed", { id: "bleed-second", host: "dn-quick" }),
    );
    signalWake(entry);
    await r.world.clock.runAsync(() => r.reports.some((report) => report.id === "bleed-second"), 60_000);

    expect(r.reports.map((report) => report.id)).toEqual(["bleed-first", "bleed-second"]);
    const first = r.adopted.find((a) => a.kind === "bleed")!;
    const chain = r.adopted.filter((a) => a.kind === "bleed");
    expect(chain).toHaveLength(2);
    // Consecutive PIDs prove atExit launched the successor itself. An
    // intermediate resident would consume one PID before the second order.
    expect(chain[1]!.pid).toBe(first.pid + 1);
    // And afterwards the host is back to exactly one resident.
    await r.world.clock.runAsync(
      () => r.adopted.some((a) => a.kind === "idle" && a.pid > chain[1]!.pid),
      60_000,
    );
    expect(r.processes.ps("darkweb")).toHaveLength(1);
    expect(r.host.crashes).toEqual([]);
  });

  test("a game kill with no cancelReason settles died and stages no successor order", async () => {
    const r = rig();
    r.plantResident();
    await residentJoined(r);

    stage(r, makeOrder("bleed", { host: BLOCKED_TARGET }));
    const handle = await inFlight(r, "bleed");
    const orderPid = handle.pid;

    // The game's kill, not the controller's: no cancelReason set. The hook
    // settles the death honestly and does NOT hand the host a successor order.
    expect(r.controllerNs.kill(orderPid)).toBe(true);
    const report = await handle.done;
    expect(report).toMatchObject({ ok: false, died: true });
    expect(report.targetState).toBeUndefined();
    expect(r.entry()!.pendingOrder).toBeUndefined();
    // A live host keeps a resident: the replacement is a plain resident, not a
    // re-run of the killed order.
    const replacement = r.processes.ps("darkweb");
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.pid).not.toBe(orderPid);
    await r.world.clock.runAsync(
      () => r.adopted.some((a) => a.kind === "idle" && a.pid === replacement[0]!.pid),
      60_000,
    );
    expect(r.processes.ps("darkweb")).toHaveLength(1);
    expect(r.host.crashes).toEqual([]);
  });

  test("deliberate transitions never trigger the hook, and a dead controller does not respawn-loop", async () => {
    const r = rig();
    r.plantResident();
    await residentJoined(r);

    // resident -> order -> resident, the normal round trip: afterwards exactly
    // one resident — no doubles from the atExit.
    stage(r, makeOrder("bleed", { host: "dn-quick" }));
    await r.world.clock.runAsync(() => r.reports.some((report) => report.kind === "bleed"), 60_000);
    expect(r.reports.find((report) => report.kind === "bleed")).toMatchObject({ ok: true });
    const bleedPid = r.adopted.find((a) => a.kind === "bleed")!.pid;
    await r.world.clock.runAsync(() => r.adopted.some((a) => a.kind === "idle" && a.pid > bleedPid), 60_000);
    expect(r.processes.ps("darkweb")).toHaveLength(1);

    // Retire the controller: the resident's next pass returns deliberately.
    // An armed hook here would respawn a process that exits again, for ever.
    delete dnetRealm().dnet_controller;
    await r.world.clock.runAsync(() => r.processes.ps("darkweb").length === 0, 60_000);
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.host.crashes).toEqual([]);
  });

  test("a live-map host restart terminates and is immediately replantable", async () => {
    const r = rig();
    const before = r.plantResident();
    await residentJoined(r);

    // Upstream iterates the LIVE running-script map: the armed resident's
    // atExit spawn IS visited by the same killall and dies unarmed, so the
    // teardown terminates instead of looping. External death clears the handle
    // and wakes the controller to replant.
    r.processes.killall("darkweb");
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.entry()!.agent).toBeUndefined();
    expect(r.wakes).toContain("resident-died");

    const replanted = r.plantResident();
    expect(replanted).toBeGreaterThan(before);
    await r.world.clock.runAsync(
      () => r.adopted.some((a) => a.kind === "idle" && a.pid === replanted),
      60_000,
    );
    expect(r.processes.ps("darkweb")).toHaveLength(1);
    expect(r.host.crashes).toEqual([]);
  });

  test("on a deleted host the hook declines: no spawn, no crash", async () => {
    const r = rig();
    r.plantResident();
    const joined = await residentJoined(r);
    const pid = joined.pid;

    // What a delete mutation leaves behind: no files, no server. The guard
    // inside the hook swallows the refused spawn and returns instead of
    // spawning into an error dialog.
    r.host.files.delete("darkweb");
    r.world.servers.delete("darkweb");
    r.processes.kill(pid);
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.entry()!.agent).toBeUndefined();
    expect(r.host.crashes).toEqual([]);
  });

  test("a resident that wins the launch race waits for its controller, then joins", async () => {
    // The bug this guards: home co-launches controller+resident, the resident
    // can start first and find no controller yet, and exiting on the spot left
    // the host bare until home's re-seed backoff elapsed. The resident must
    // instead wait out the boot race.
    const r = rig();
    const registered = dnetRealm().dnet_controller;
    delete dnetRealm().dnet_controller;
    const pid = r.plantResident();

    // A few seconds pass with no controller registered: the resident must
    // still be alive (grace poll) and must NOT have created its entry.
    await r.world.clock.runAsync(() => false, 3_000);
    expect(r.processes.get(pid)).toBeDefined();
    expect(r.entry()).toBeUndefined();

    // The controller finishes booting and registers; the resident joins it.
    dnetRealm().dnet_controller = registered;
    await r.world.clock.runAsync(() => r.entry()?.agent?.pid === pid, 30_000);
    expect(r.entry()?.agent?.order.kind).toBe("idle");
    expect(r.host.crashes).toEqual([]);
  });

  test("a resident whose controller never registers gives up after the grace", async () => {
    // The other side of the same latch: a genuinely dead run (no controller
    // ever) must not leave a resident polling for ever, or home could never
    // re-seed a single clean one.
    const r = rig();
    delete dnetRealm().dnet_controller;
    const pid = r.plantResident();

    // Still alive mid-grace, gone once the ~15s grace elapses, with no respawn.
    await r.world.clock.runAsync(() => false, STARTUP_GRACE_MS / 3);
    expect(r.processes.get(pid)).toBeDefined();
    await r.world.clock.runAsync(() => r.processes.get(pid) === undefined, STARTUP_GRACE_MS * 2);
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.host.crashes).toEqual([]);
  });

  test("the wake picks up staged work without waiting out the poll", async () => {
    const r = rig();
    r.plantResident();
    await residentJoined(r);

    // Stage an order the way the controller does: push, then wake.
    const at = r.world.clock.now();
    stage(r, makeOrder("bleed", { host: "dn-quick" }));

    // Picked up on the wake — virtual time barely advances, far under the 1s
    // fallback poll a pure poller would have cost.
    await r.world.clock.runAsync(() => r.reports.some((report) => report.kind === "bleed"), 60_000);
    expect(r.reports.find((report) => report.kind === "bleed")).toMatchObject({ ok: true });
    expect(r.world.clock.now() - at).toBeLessThan(1_000);
    expect(r.host.crashes).toEqual([]);
  });
});

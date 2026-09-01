import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { dnetRealm, processSizeFor, type ControllerHandle, type HostEntry, type Order } from "../game/dnet/shared.ts";
import { launchExec, resetLaunchState } from "../game/lib/launch-shared.ts";
import type { DnetAgentLaunch, DnetProberLaunch } from "../game/dnet/launch.ts";
import type { DnetRecoveryState } from "../game/dnet/wire.ts";

/** Derivation is FACT-driven: a write-through files its consequences in the
 * same engine turn, not on the controller's 2 s watchdog.
 *
 * The deadline is real. A winning `authenticate` must reach the vantage's
 * staged queue before the SAME process's exit chain reads it, or the plant
 * waits a tick — and the `.d` hint file waiting on the opened host names a
 * neighbour as of the authenticate instant, so a tick of slack loses it to
 * `exactNeighbourClueEpoch`. Fact-to-order assertions therefore advance no
 * timers; the explicit refused-exec regression later waits for its real retry
 * grace because a timer turn is the behavior it pins. */

const VANTAGE = "vantage";
const TARGET = "target";
const REMOTE = "remote";

interface SimHost {
  maxRam: number;
  blockedRam: number;
  depth: number;
  neighbours: string[];
}

const net = new Map<string, SimHost>();
/** Pids the engine reports as dead. The placing window is decided by asking
 *  whether the announced process is really there, so a test about a launch
 *  that never landed has to be able to say so. */
const deadPids = new Set<number>();

function mockNs(launchId?: number, standingOn?: string, exec?: (...args: unknown[]) => number): NS {
  const details = (host: string) => {
    const sim = net.get(host);
    if (!sim) return { isOnline: false } as never;
    return {
      isOnline: true,
      depth: sim.depth,
      blockedRam: sim.blockedRam,
      requiredCharismaSkill: 1,
      difficulty: 1,
      isStationary: false,
      modelId: "factory_default",
      passwordLength: 4,
      passwordFormat: "numeric",
      passwordHint: "",
      data: "",
      logTrafficInterval: 30,
    };
  };
  return {
    args: launchId === undefined ? [] : [launchId],
    pid: 1,
    atExit: () => {},
    disableLog: () => {},
    getScriptName: () => "dnet/controller.js",
    getFunctionRamCost: () => 0.2,
    getServerMaxRam: (host: string) => net.get(host)?.maxRam ?? 0,
    getServerUsedRam: () => 0,
    dnsLookup: (host: string) => `ip-${host}`,
    isRunning: (pid: unknown) => typeof pid !== "number" || !deadPids.has(pid),
    kill: () => true,
    ...(exec !== undefined ? { exec } : {}),
    dnet: {
      getServerDetails: details,
      // A lender's probe: the neighbours of the host it stands on. Bound at
      // construction, because `probe` is host-BOUND — that is the whole reason
      // a process stands on every host.
      probe: () => [...(net.get(standingOn ?? "")?.neighbours ?? [])],
      nextMutation: () => new Promise<void>(() => {}),
    },
  } as unknown as NS;
}

/** Stand a prober on a host and lend its `ns` to the controller.
 *
 * Every fact the controller reads now goes through a borrowed `ns`, so a test
 * with no lender anywhere describes nothing and derives nothing — which is the
 * real behaviour at cold start, and why this is the first thing every case
 * does. */
function standProber(
  handle: ControllerHandle,
  host: string,
  pid = 900,
  cold = false,
  exec?: (...args: unknown[]) => number,
  armoured = false,
): NS {
  if (!handle.hosts.has(host)) {
    const seen = net.get(host);
    handle.hosts.set(host, {
      hostname: host,
      identity: `ip-${host}`,
      lastSeenAt: Date.now(),
      seenAt: {},
      dirty: {},
      staged: [],
      ...(seen ? { maxRam: seen.maxRam, blockedRam: seen.blockedRam, depth: seen.depth, neighbours: [...seen.neighbours] } : {}),
    });
  }
  if (!cold) {
    const entry = handle.hosts.get(host);
    if (entry !== undefined) {
      entry.seenAt.files = Date.now();
      entry.caches = [];
      entry.contracts = [];
      delete entry.dirty.files;
    }
  }
  const borrowed = mockNs(undefined, host, exec);
  const launch = launchExec<DnetProberLaunch>({ kind: "dnet-prober", host }, () => pid)!;
  handle.lend(host, borrowed, launch, undefined, armoured);
  return borrowed;
}

/** The run's shared ns resident, which is where every GLOBAL call the
 * controller makes now goes.
 *
 * Separate from the probers on purpose. `probe` and `exec` are host-BOUND and
 * can only come from a process standing on that host; `getServerDetails` and
 * friends work anywhere, so one resident serves the whole automation instead
 * of every prober paying for them for ever. With no resident the controller
 * describes nothing — the real cold-start state, and why this is the other
 * thing every case does first. */
function standHands(leasedCall?: (path: string, ...args: unknown[]) => Promise<unknown>): NS {
  const borrowed = mockNs();
  const call = ((path: string, ...args: unknown[]) => {
    const fn = path.split(".").reduce<unknown>(
      (held, key) => (held as Record<string, unknown> | undefined)?.[key],
      borrowed as unknown,
    );
    if (typeof fn !== "function") throw new Error(`mock ns has no ${path}`);
    return Promise.resolve((fn as (...a: unknown[]) => unknown)(...args));
  }) as ((path: string, ...args: unknown[]) => Promise<unknown>) & {
    guaranteeFit(
      paths: readonly string[],
      use: (resident: (path: string, ...args: unknown[]) => Promise<unknown>) => unknown,
    ): Promise<unknown>;
  };
  call.guaranteeFit = (_paths, use) => {
    const lease = (leasedCall ?? call) as typeof call & { launchExec: (...args: unknown[]) => undefined };
    lease.launchExec = (_descriptor, script, host, options) => {
      void lease("exec", script, host, options);
      return undefined;
    };
    return Promise.resolve(use(lease));
  };
  (globalThis as Record<string, unknown>)["ns_proxy"] = {
    // `nsp("a.b", ...args)` resolves the dotted path against a real `ns` and
    // calls it. The stub does exactly that against the mock, so a test drives
    // the same code path the resident does.
    call,
  };
  return borrowed;
}

/** Start the real controller and stop at its first `await`. */
async function bootController(recovery?: DnetRecoveryState): Promise<ControllerHandle> {
  const { main } = await import("../game/dnet/controller.ts");
  let bootError: unknown;
  // Exactly the real handoff: the controller captures its descriptor inside
  // the launcher's own turn, which is what acknowledges the launch.
  launchExec(
    {
      kind: "dnet-controller",
      host: VANTAGE,
      buildId: "test",
      generation: "test",
      charisma: 1_000,
      ...(recovery ? { recovery } : {}),
    },
    () => 1,
  );
  void main(mockNs()).catch((error) => { bootError = error; });
  await Promise.resolve();
  const handle = dnetRealm().dnet_controller;
  expect(handle, `the controller never published its rendezvous: ${String(bootError)}`).toBeDefined();
  return handle!;
}

/** Let every queued microtask run, without advancing a single timer.
 *
 * A derive pass is a chain of awaited proxy calls now — each host described
 * costs three — so the drain has to be deep enough to reach the end of it.
 * Microtask turns are free; the count only has to exceed the longest chain. */
const settleMicrotasks = async (): Promise<void> => {
  for (let turn = 0; turn < 500; turn++) await Promise.resolve();
};

/** A live prober lending its `ns`; no agent exists until an order launches. */
function standHost(handle: ControllerHandle, host: string, pid = 900): HostEntry {
  standProber(handle, host, pid);
  return handle.hosts.get(host)!;
}

/** An agent adopting one order, which is the only way an agent ever registers:
 * the controller execs it FOR that order and it exits when the order is done.
 * Adopting is also what closes the host's placing window. */
function adoptAgent(handle: ControllerHandle, host: string, pid: number, order: Order): HostEntry {
  handle.adopt(host, {
    pid,
    order,
    startedAt: Date.now(),
    beatAt: Date.now(),
    done: new Promise(() => {}),
    settle: () => {},
  });
  return handle.hosts.get(host)!;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>)["__TELEMETRY__"] = false;
  net.clear();
  deadPids.clear();
  net.set(VANTAGE, { maxRam: 64, blockedRam: 0, depth: 0, neighbours: [TARGET] });
  net.set(TARGET, { maxRam: 32, blockedRam: 0, depth: 1, neighbours: [VANTAGE] });
});

afterEach(() => {
  const handle = dnetRealm().dnet_controller;
  if (handle) handle.standDown();
  delete dnetRealm().dnet_controller;
  delete (globalThis as Record<string, unknown>)["ns_proxy"];
  resetLaunchState();
});

describe("a fact derives in its own turn", () => {
  test("the directly seeded beachhead inventories itself before farming", async () => {
    const handle = await bootController();
    standHands();
    net.get(VANTAGE)!.neighbours = [];
    const launches: unknown[][] = [];
    standProber(handle, VANTAGE, 11, true, (...args) => {
      launches.push(args);
      return 100 + launches.length;
    });
    const beachhead = handle.hosts.get(VANTAGE)!;
    await settleMicrotasks();

    // Darkweb is not planted by another agent, so `preparePlant` never gets a
    // chance to request this listing. The lender's first check-in must do it;
    // otherwise `planFarm` refuses at `cache-unknown` and never reaches the
    // phishing fallback.
    const listing = beachhead.pendingOrder;
    expect(listing, "the seed host was left with unknown files and no farm path").toBeDefined();
    expect(listing!.kind).toBe("inventory");
    expect(listing!.from).toBe(VANTAGE);
    expect(launches[0]?.[0]).toBe("dnet/agent.js");

    // What the inventory report establishes. Once the one-call agent hands
    // its slot back, the next derive must immediately reach the unconditional
    // earn floor and exec a correctly-sized phishing agent through the prober.
    beachhead.seenAt.files = Date.now();
    beachhead.caches = [];
    beachhead.contracts = [];
    delete beachhead.dirty.files;
    handle.deps.recordCredential({ hostname: VANTAGE, password: "", at: Date.now() });
    beachhead.pendingOrder = undefined;
    beachhead.inbound = undefined;
    handle.wake("inventory-finished");
    await settleMicrotasks();

    // Re-read rather than reusing `beachhead`: it was assigned `undefined`
    // above, so the local is narrowed to `never` even though the wake refills
    // it. The entry in the map is the live one.
    const staged = handle.hosts.get(VANTAGE)?.pendingOrder;
    expect(`${staged?.kind}:${staged?.host}`).toBe("phish:vantage");
    expect(launches[1]?.[0]).toBe("dnet/agent.js");
  });

  test("snapshots are cumulative copies and restore without process runtime", async () => {
    const first = await bootController();
    standHands();
    standProber(first, VANTAGE);
    standHost(first, VANTAGE, 11);
    first.reportProbe(VANTAGE, [TARGET], Date.now(), 11);
    await settleMicrotasks();
    adoptAgent(first, VANTAGE, 12, {
      id: "induce:target",
      kind: "induce",
      host: TARGET,
      from: VANTAGE,
      ramOverrideGb: 2,
      threads: 3,
      priority: 1,
      longLived: false,
      label: "induce target",
      payload: {},
    });
    first.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();

    const captured = first.snapshot();
    expect(captured.recovery.vault.map((entry) => entry.hostname)).toContain(TARGET);
    expect(captured.residents.find((resident) => resident.host === VANTAGE)).toMatchObject({
      active: "induce",
      targets: [TARGET],
      ram: { jobGb: 6, proberGb: 3.15, controllerGb: 1.6 },
    });
    const durable = captured.recovery.knowledge.hosts.get(VANTAGE)! as HostEntry;
    expect(durable.agent).toBeUndefined();
    expect(durable.ns).toBeUndefined();

    durable.depth = 999;
    expect(first.snapshot().recovery.knowledge.hosts.get(VANTAGE)?.depth).not.toBe(999);
    expect(first.snapshot().recovery.codes).toEqual(captured.recovery.codes);

    first.standDown();
    delete dnetRealm().dnet_controller;
    const restored = await bootController(captured.recovery);
    expect(restored.snapshot().recovery.vault.map((entry) => entry.hostname)).toContain(TARGET);
    expect(restored.hosts.get(VANTAGE)?.agent).toBeUndefined();
    expect(restored.hosts.get(VANTAGE)?.ns).toBeUndefined();
  });

  test("a recovery checkpoint from another generation is ignored", async () => {
    const first = await bootController();
    first.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();
    const foreign = { ...first.snapshot().recovery, generation: "foreign" };

    first.standDown();
    delete dnetRealm().dnet_controller;
    const replacement = await bootController(foreign);

    expect(replacement.snapshot().recovery.vault).toEqual([]);
  });

  test("a verified credential stages the plant without a tick", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, VANTAGE);
    const vantage = standHost(handle, VANTAGE, 11);
    handle.reportProbe(VANTAGE, [TARGET], Date.now(), 11);
    await settleMicrotasks();

    handle.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();

    const plant = (vantage.staged ?? []).find((order) => order.kind === "plant");
    expect(plant, "the plant was not staged in the credential's own turn").toBeDefined();
    expect(plant!.payload.targets?.map((t) => t.host)).toEqual([TARGET]);
    expect(plant!.payload.targets?.[0]?.password).toBe("1234");
  });

  test("a reload's restored vault stages a remote plant before it has a map", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, VANTAGE);
    standHost(handle, VANTAGE, 11);
    // The vantage knows its own capacity and nothing else. No probe names
    // REMOTE: on a cold boot the only thing home hands back is the file it
    // saved — passwords and stasis links, never topology.
    handle.reportProbe(VANTAGE, [], Date.now(), 11);
    net.set(REMOTE, { maxRam: 32, blockedRam: 0, depth: 4, neighbours: [] });
    const at = Date.now();
    handle.configure({
      charisma: 1_000,
      stasisSnapshot: { hosts: [REMOTE], at },
    });
    await settleMicrotasks();
    handle.deps.recordCredential({ hostname: REMOTE, password: "1234", at });
    await settleMicrotasks();

    const plant = (handle.hosts.get(VANTAGE)?.staged ?? []).find((order) => order.kind === "plant");
    expect(plant, "the restored credential waited for a prober to rediscover its host").toBeDefined();
    expect(plant!.payload.targets?.map((t) => t.host)).toEqual([REMOTE]);
    // A stasis link is a backdoor, so the vantage never needed to be adjacent.
    expect(plant!.payload.targets?.[0]?.remote).toBe(true);
  });

  test("a vantage's whole frontier is ONE order, not one per host", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, VANTAGE);
    const vantage = standHost(handle, VANTAGE, 11);
    const frontier = ["a.corp", "b.corp", "c.corp", "d.corp"];
    for (const host of frontier) net.set(host, { maxRam: 32, blockedRam: 0, depth: 1, neighbours: [VANTAGE] });
    handle.reportProbe(VANTAGE, frontier, Date.now(), 11);
    await settleMicrotasks();
    for (const host of frontier) {
      handle.deps.recordCredential({ hostname: host, password: "1234", at: Date.now() });
    }
    await settleMicrotasks();

    // Four targets behind four spawns would be four prober round trips deep.
    // One order runs them together, and the queue cap never sees them.
    const plants = (vantage.staged ?? []).filter((order) => order.kind === "plant");
    expect(plants).toHaveLength(1);
    expect(plants[0]!.payload.targets.map((t) => t.host).sort()).toEqual(frontier);
  });

  test("a host being planted takes its first order before the agent exists", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, VANTAGE);
    standHost(handle, VANTAGE, 11);
    handle.reportProbe(VANTAGE, [TARGET], Date.now(), 11);
    handle.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();

    // What the plant body does: open the window, then report the new host's
    // own first probe. TARGET still has no process at all.
    await handle.preparePlant(TARGET);
    const barrier = await handle.beginProbeRefresh(TARGET);
    handle.reportProbe(TARGET, [VANTAGE], Date.now(), 12, barrier.refresh);
    // The barrier itself must imply that derivation has filed the first order.
    // Requiring a separate microtask drain here hid the real plant ordering:
    // the waiting body resumes as soon as this promise does.
    await expect(barrier.refresh.refreshed).resolves.toBeDefined();
    expect(handle.hosts.get(TARGET)?.agent).toBeUndefined();

    // The derive staged work for it anyway, and the plant hands that order to
    // the `exec` it is about to make — so the new process starts ON it rather
    // than booting, adopting and spawning first.
    const first = handle.claimPlanted(TARGET);
    expect(first, "nothing was ready for the new agent to start on").toBeDefined();
    expect(first!.kind).toBe("inventory");
    // The `exec` is sized from the order itself, by the same helper the spawn
    // chain uses — the two hand-offs have nothing left to disagree about.
    expect(processSizeFor(first, 3.6)).toEqual({ threads: first!.threads, ramOverride: first!.ramOverrideGb });
    // And the window is still OPEN: the resident this order was claimed for has
    // not been exec'd yet, let alone adopted. Closing it here left the host
    // reading agentless-and-unclaimed for the length of an exec, and the derive
    // the probe had just woken retired the claim out from under the plant.
    expect(handle.hosts.get(TARGET)?.inbound).toBeDefined();
    // `adopt` is what closes it.
    adoptAgent(handle, TARGET, 13, first!);
    expect(handle.hosts.get(TARGET)?.inbound).toBeUndefined();
  });

  test("a launch that never lands stops holding the host", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, VANTAGE);
    standHost(handle, VANTAGE, 11);
    handle.reportProbe(VANTAGE, [TARGET], Date.now(), 11);
    handle.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();

    // A child that died before its first line. The plant handed over its pid,
    // so the window is a checkable fact rather than a stopwatch: the process is
    // not running, therefore nothing is coming. No time passes in this test.
    await handle.preparePlant(TARGET);
    const launch = launchExec<DnetAgentLaunch>({ kind: "dnet-agent", host: TARGET }, () => 999_999)!;
    handle.bindAgentLaunch(TARGET, launch);
    deadPids.add(999_999);
    handle.wake("test");
    await settleMicrotasks();

    // Reaped on THIS pass, so the host rejoins the plant pool at once rather
    // than reading staffed until a window happens to lapse.
    expect(handle.hosts.get(TARGET)?.inbound).toBeUndefined();
    expect(handle.hosts.get(TARGET)?.agent).toBeUndefined();
  });

  test("an abandoned plant stops the host accepting orders", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, VANTAGE);
    standHost(handle, VANTAGE, 11);
    handle.reportProbe(VANTAGE, [TARGET], Date.now(), 11);
    handle.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();

    await handle.preparePlant(TARGET);
    expect(handle.hosts.get(TARGET)?.inbound).toBeDefined();
    // A refused prober exec, or a cancelled refresh: the window closes and the
    // host stops being a place work can be filed onto.
    handle.abandonPlant(TARGET);
    expect(handle.hosts.get(TARGET)?.inbound).toBeUndefined();
    expect(handle.claimPlanted(TARGET)).toBeUndefined();
  });

  test("an agent checkout waits for kill(pid) to prove its RAM is free", async () => {
    const handle = await bootController();
    const hands = standHands();
    const entry = standHost(handle, TARGET, 11);
    let releaseKill!: (value: boolean) => void;
    const killed: number[] = [];
    (hands as unknown as { kill(pid: number): Promise<boolean> }).kill = (pid) => {
      killed.push(pid);
      return new Promise<boolean>((resolve) => { releaseKill = resolve; });
    };
    const order: Order<"inventory"> = {
      id: "inventory:retiring", kind: "inventory", host: TARGET, from: TARGET,
      ramOverrideGb: 3.6, threads: 1, priority: 1, longLived: false,
      label: "retiring", payload: {},
    };
    const agent = {
      pid: 77, order, startedAt: Date.now(), beatAt: Date.now(),
      done: new Promise<never>(() => {}), settle: () => {},
    };
    entry.agent = agent;

    const launch = launchExec<DnetAgentLaunch>({ kind: "dnet-agent", host: TARGET, order }, () => 77)!;
    handle.bindAgentLaunch(TARGET, launch);
    launch.exited.resolve();
    let prepared = false;
    const barrier = handle.preparePlant(TARGET).then(() => { prepared = true; });
    await settleMicrotasks();
    expect(killed).toEqual([77]);
    expect(prepared).toBe(false);

    // Both true (we cleaned it) and false (already absent) resolve only after
    // Bitburner has no allocation for this pid. The return value is immaterial.
    releaseKill(false);
    await barrier;
    expect(prepared).toBe(true);
    expect(handle.hosts.get(TARGET)?.inbound).toBeDefined();
  });

  test("a resident standing on a host with dirty files stages its own `ls`", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, VANTAGE);
    standHost(handle, VANTAGE, 11);
    handle.reportProbe(VANTAGE, [TARGET], Date.now(), 11);
    handle.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();

    // `preparePlant` is what the plant order calls just before exec'ing the
    // resident; it is where the opened host joins `needsInventory`.
    await handle.preparePlant(TARGET);
    const target = standHost(handle, TARGET, 12);
    await settleMicrotasks();

    const listing = (target.staged ?? []).find((order) => order.kind === "inventory");
    expect(listing, "the new resident was left waiting for a tick to be told to `ls`").toBeDefined();
    expect(listing!.from).toBe(TARGET);
  });
});

describe("armour is resized at the order boundary", () => {
  /** A prober can only change size at the instant the previous order's
   * allocation has been freed and the next has not been launched. There is no
   * other window: an agent is never idle, it dies and is replaced for its next
   * job, and nothing may be interrupted to make one.
   *
   * These drive the REAL controller, so they pin the wiring rather than the
   * policy — `tests/dnet-armour.test.ts` owns the policy. */

  test("a deliberate prober kill is marked before the kill, so armour stands down", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, TARGET, 900);
    const entry = handle.hosts.get(TARGET)!;
    expect(entry.prober?.pid).toBe(900);

    // A replacement checking in. The controller retires the incumbent, and the
    // mark has to be set BEFORE that kill because the victim's armour hook runs
    // synchronously inside it — a mark set afterwards arrives too late.
    standProber(handle, TARGET, 901);
    expect(handle.hosts.get(TARGET)!.prober?.pid).toBe(901);
    // The retired pid is exactly the one whose respawn must be refused.
    expect(handle.announceProberRespawn(TARGET, 900, 1, () => {})).toBe(false);
  });

  test("an unmarked death is a real restart, and its respawn is admitted once", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, TARGET, 900);

    let withdrawn = 0;
    expect(handle.announceProberRespawn(TARGET, 900, 7, () => { withdrawn++; })).toBe(true);
    expect(withdrawn).toBe(0);

    // The window is open, so nothing may exec a duplicate into the gap between
    // the kill and the macrotask that lands the successor.
    expect((await handle.preparePlant(TARGET)).reuseProber).toBe(true);

    // The successor arrives and closes the window by checking in. Its
    // descriptor was captured by the process itself, so there is nothing left
    // to withdraw.
    standProber(handle, TARGET, 902);
    expect(handle.hosts.get(TARGET)!.proberRespawn).toBeUndefined();
    expect(withdrawn).toBe(0);
  });

  test("a calm net never resizes a prober, so armour cannot churn", async () => {
    // The expensive failure mode. `resizeProber` runs on EVERY dispatch, and an
    // `exec` returning a pid only proves the process was admitted — so a policy
    // that wanted armour the host could not keep, or a replacement that died
    // before lending, would re-exec a prober on every order for ever. With no
    // storm near and no backdoors held, nothing should ever be armed at all.
    const handle = await bootController();
    standHands();
    const launches: unknown[][] = [];
    standProber(handle, VANTAGE, 11, true, (...args) => {
      launches.push(args);
      return 100 + launches.length;
    });
    await settleMicrotasks();
    handle.wake("test");
    await settleMicrotasks();

    expect(launches.length, "the derive launched nothing at all").toBeGreaterThan(0);
    const probers = launches.filter((args) => args[0] === "dnet/prober.js");
    expect(probers, "a calm net re-exec'd a prober").toEqual([]);
    expect(handle.hosts.get(VANTAGE)?.prober?.armoured).toBeUndefined();
  });

  test("an order sized before armour is fitted against the prober now standing", async () => {
    const handle = await bootController();
    standHands();
    net.get(TARGET)!.maxRam = 16;
    const target: HostEntry = {
      hostname: TARGET,
      lastSeenAt: Date.now(),
      seenAt: { files: Date.now() },
      dirty: {},
      staged: [],
      caches: [],
      contracts: [],
    };
    handle.hosts.set(TARGET, target);
    const launches: unknown[][] = [];
    standProber(handle, TARGET, 900, false, (...args) => {
      launches.push(args);
      return 1_000 + launches.length;
    }, true);

    // This was sized while a 3.15 GB prober stood here: six 2 GB threads fit.
    // By its final launch boundary the replacement is the 5.15 GB armoured
    // prober, so only five threads still fit.
    const order: Order<"attempt"> = {
      id: "attempt:armour-fit",
      kind: "attempt",
      host: TARGET,
      from: TARGET,
      ramOverrideGb: 2,
      threads: 6,
      priority: 30,
      longLived: false,
      label: "fit after armour",
      payload: {},
    };
    target.staged = [order];
    handle.configure({
      charisma: 1_000,
      labExpected: false,
      backdoors: [{ hostname: TARGET, installedAt: Date.now() }],
    });
    await settleMicrotasks();

    const agent = launches.find((args) => args[0] === "dnet/agent.js");
    expect(agent?.[2]).toMatchObject({ threads: 5, ramOverride: 2 });
    expect(handle.hosts.get(TARGET)?.pendingOrder?.threads).toBe(5);
  });

  test("a stasis launch refusal is recorded after one proxy lease", async () => {
    const handle = await bootController();
    const leaseCalls: string[][] = [];
    let leaseAttempt = 0;
    standHands(async (path, ..._args) => {
      if (path === "dnet.connectToSession") {
        leaseAttempt++;
        leaseCalls.push([]);
      }
      const calls = leaseCalls[leaseAttempt - 1] ??= [];
      calls.push(path);
      if (path === "dnet.connectToSession") return { success: true, code: 200, message: "connected" };
      if (path === "exec") return 0;
      throw new Error(`unexpected leased call ${path}`);
    });

    net.set(REMOTE, { maxRam: 16, blockedRam: 0, depth: 1, neighbours: [VANTAGE] });
    net.get(VANTAGE)!.neighbours = [REMOTE];
    handle.configure({
      charisma: 1_000,
      labExpected: false,
      stasisSnapshot: { hosts: [VANTAGE], at: Date.now() },
    });
    standProber(handle, VANTAGE, 900);
    handle.reportProbe(VANTAGE, [REMOTE], Date.now(), 900);
    await settleMicrotasks();
    handle.deps.recordCredential({ hostname: VANTAGE, password: "", at: Date.now() });
    handle.deps.recordCredential({ hostname: REMOTE, password: "5678", at: Date.now() });
    await settleMicrotasks();
    expect(leaseAttempt).toBe(1);
    expect(leaseCalls).toEqual([["dnet.connectToSession", "exec"]]);
    expect(handle.hosts.get(VANTAGE)?.pendingOrder).toBeUndefined();
    expect(handle.hosts.get(VANTAGE)?.inbound).toBeUndefined();
    expect(handle.hosts.get(VANTAGE)?.staged?.[0]).toMatchObject({ kind: "plant", from: VANTAGE });
  });

  test("a pending stasis lease cannot block an ordinary host dispatch", async () => {
    const handle = await bootController();
    let stasisLeaseStarted = false;
    standHands(async (path) => {
      if (path === "dnet.connectToSession") {
        stasisLeaseStarted = true;
        return new Promise<never>(() => {});
      }
      throw new Error(`unexpected leased call ${path}`);
    });
    handle.configure({
      charisma: 1_000,
      labExpected: false,
      stasisSnapshot: { hosts: [VANTAGE], at: Date.now() },
    });
    standProber(handle, VANTAGE, 900);
    handle.deps.recordCredential({ hostname: VANTAGE, password: "", at: Date.now() });

    const ordinaryLaunches: unknown[][] = [];
    standProber(handle, TARGET, 901, false, (...args) => {
      ordinaryLaunches.push(args);
      return 800;
    });
    const makeInventory = (host: string, id: string): Order<"inventory"> => ({
      id, kind: "inventory", host, from: host, ramOverrideGb: 3.6, threads: 1,
      priority: -10_000, longLived: false, label: "isolation", payload: {},
    });
    handle.hosts.get(VANTAGE)!.staged = [makeInventory(VANTAGE, "inventory:stasis")];
    handle.hosts.get(TARGET)!.staged = [makeInventory(TARGET, "inventory:ordinary")];

    handle.wake("isolation");
    await settleMicrotasks();
    expect(stasisLeaseStarted).toBe(true);
    expect(ordinaryLaunches.some((args) => args[0] === "dnet/agent.js")).toBe(true);
    expect(handle.hosts.get(TARGET)?.inbound?.launch?.pid).toBe(800);
  });

  test("a launch window with no pid is reaped, not held for ever", async () => {
    // The wedge. A window with no pid answered `processInbound` with a bare
    // `true`, and `refreshLiveness` only asks about windows that HAVE a pid, so
    // it was never examined at all. That one value gates `reapGhostLaunches`,
    // `releaseStranded`, `reconcilePending` and dispatch itself, so a launcher
    // that died between claiming a host and exec'ing wedged it for the rest of
    // the run — a prober standing, no agent, and nothing saying why.
    //
    // A pid still answers for itself: only the pid-less case is on a clock.
    const handle = await bootController();
    standHands();
    standProber(handle, TARGET, 900, true, () => 0);
    const entry = handle.hosts.get(TARGET)!;

    entry.inbound = { at: Date.now() - 7_200_000, via: "plant-exec" };
    handle.wake("test");
    await settleMicrotasks();

    expect(handle.hosts.get(TARGET)?.inbound).toBeUndefined();
  });

  test("a missed kill-mark degrades to a leak, never to a respawn storm", async () => {
    // Defence in depth for a mechanism whose failure mode is freezing the game.
    // An unmarked kill in `retireVantage` — the path every agent death takes —
    // let an armoured prober read a deliberate retirement as a host restart and
    // spawn a successor a millisecond later, onto the host being cleared. The
    // mark is the fix; this is the floor under it.
    //
    // A legitimate respawn answers a host RESTART, and one host is restarted at
    // most once per storm and otherwise minutes apart — so a second respawn
    // moments later is never real work, whatever forgot to mark the kill.
    const handle = await bootController();
    standHands();
    standProber(handle, TARGET, 900);

    expect(handle.announceProberRespawn(TARGET, 900, 1, () => {})).toBe(true);
    expect(handle.announceProberRespawn(TARGET, 901, 2, () => {})).toBe(false);
    expect(handle.announceProberRespawn(TARGET, 902, 3, () => {})).toBe(false);
  });

  test("a mark is consumed, so it cannot suppress a later genuine restart", async () => {
    const handle = await bootController();
    standHands();
    standProber(handle, TARGET, 900);

    handle.markProberKill(TARGET, 900);
    expect(handle.announceProberRespawn(TARGET, 900, 1, () => {})).toBe(false);
    // The SAME pid asking again is a restart, not the kill we ordered. A mark
    // left standing would make the host permanently undefendable.
    expect(handle.announceProberRespawn(TARGET, 900, 2, () => {})).toBe(true);
  });
});

describe("the derive scheduler settles", () => {
  /** The freeze this guards the shape of: `signalDerive` queues each pass on a
   * bare microtask and `fileWork` awaits no timer anywhere, so a net that
   * produces one fact per pass chains passes with the event loop never
   * regaining control — no paint, no input.
   *
   * Be honest about what this file can and cannot show. The loop is an
   * emergent timing property of a live net, and it does not form in this
   * harness: after the first pass there is nothing left to describe, so no
   * further fact is generated and the chain ends on its own regardless of the
   * scheduler implementation.
   *
   * So this pins only the property that is genuinely observable here — a quiet
   * net settles and stays settled. The chain bound itself is verified on the
   * `bn15-full` simulation and by the in-game derive counter. */
  test("a quiet net settles and stays settled", async () => {
    const handle = await bootController();
    let describes = 0;
    const borrowed = mockNs();
    const call = ((path: string, ...args: unknown[]) => {
      if (path === "dnet.getServerDetails") describes++;
      const fn = path.split(".").reduce<unknown>(
        (held, key) => (held as Record<string, unknown> | undefined)?.[key],
        borrowed as unknown,
      );
      if (typeof fn !== "function") throw new Error(`mock ns has no ${path}`);
      return Promise.resolve((fn as (...a: unknown[]) => unknown)(...args));
    }) as ((path: string, ...args: unknown[]) => Promise<unknown>) & {
      guaranteeFit(p: readonly string[], use: (r: unknown) => unknown): Promise<unknown>;
    };
    call.guaranteeFit = (_paths, use) => Promise.resolve(use(call));
    (globalThis as Record<string, unknown>)["ns_proxy"] = { call };

    standProber(handle, VANTAGE, 11, true, () => 101);
    standProber(handle, TARGET, 12, true, () => 102);
    handle.wake("one-fact");
    for (let turn = 0; turn < 5_000; turn++) await Promise.resolve();
    const settled = describes;

    // No timers are advanced here, so a settled controller must do nothing
    // further no matter how long the microtask queue is drained.
    for (let turn = 0; turn < 5_000; turn++) await Promise.resolve();
    expect(describes).toBe(settled);
  });
});

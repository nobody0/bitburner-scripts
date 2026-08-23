import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { installVirtualTime, type VirtualTime } from "../sim/realm/timers.ts";
import { SimWorld } from "../sim/world.ts";
import { ProcessTable, type SimProcess } from "../sim/ns/process.ts";
import { makeSimNs, type SimNsHost } from "../sim/ns/api.ts";
import { darkwebServerSpec } from "../sim/network.ts";
import { main as agentMain } from "../game/dnet/agent.ts";
import { hardCancelSweep } from "../game/dnet/overseer.ts";
import {
  RENDEZVOUS_PROTOCOL,
  dnetRealm,
  hardCancelEligible,
  signalQueueWork,
  type DnetHostQueue,
  type DnetJob,
  type DnetJobResult,
  type DnetRendezvous,
} from "../game/dnet/realm.ts";

/** Hard cancellation, end to end: the REAL agent, killed by the REAL sweep.
 *
 * The design under test is the pair introduced together: the agent's armed
 * atExit hook (settle the murdered job, respawn the resident, all inside the
 * killer's `ns.kill` call) and the overseer's `hardCancelSweep` (kill an
 * ARMORED active job carrying a `cancelReason`, and nothing else). The sim's
 * teardown ordering is separately pinned by `sim/tests/process-atexit.test.ts`;
 * this file drives `game/dnet/agent.ts`'s actual main() through it.
 *
 * What must never regress: a pin or a walk or a pre-armor job is never shot,
 * a deliberate mode transition never triggers the hook, a dead rendezvous
 * never respawn-loops, and a host-restart killall revives its resident while
 * a host-delete declines quietly. */

const GENERATION = "15:0";

interface Rig {
  host: SimNsHost;
  world: SimWorld;
  processes: ProcessTable;
  rendezvous: DnetRendezvous;
  controllerNs: NS;
  /** Launch the real agent in resident mode on darkweb. */
  plantResident: () => number;
  queue: () => DnetHostQueue | undefined;
}

function rig(): Rig {
  const bitnode = 15;
  const world = new SimWorld({ seed: 1, bitnode, network: [darkwebServerSpec()] });
  // The resident's poll parks on `realmSleep` — a bare global setTimeout —
  // so the rig must move the realm's timers onto the sim clock, exactly as
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
  const host = {
    world,
    clock: world.clock,
    processes,
    files,
    contents: new Map<string, string>(),
    scripts: new Map<string, (ns: NS) => Promise<void>>([["agent.js", agentMain]]),
    network,
    ramCtx: { bitNode: bitnode },
    output: [],
    crashes: [],
  } as unknown as SimNsHost;

  const controller = processes.start({
    filename: "controller.js",
    host: "home",
    args: [],
    threads: 1,
    ramPerThreadGb: 1,
    temporary: false,
  })!;
  const controllerNs = makeSimNs(host, controller);

  const rendezvous = {
    protocol: RENDEZVOUS_PROTOCOL,
    generation: GENERATION,
    controllerPid: controller.pid,
    startedAt: Date.now(),
    lastBeatAt: Date.now(),
    queues: new Map<string, DnetHostQueue>(),
    drain: () => {
      throw new Error("not drained here");
    },
    order: () => {},
  } as unknown as DnetRendezvous;
  dnetRealm().dnet_overseer = rendezvous;

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
    rendezvous,
    controllerNs,
    plantResident,
    queue: () => rendezvous.queues.get("darkweb"),
  };
}

let vt: VirtualTime | undefined;
afterEach(() => {
  delete dnetRealm().dnet_overseer;
  vt?.restore();
  vt = undefined;
});

interface MadeJob {
  job: DnetJob;
  outcome: () => DnetJobResult | undefined;
  failure: () => unknown;
}

function makeJob(
  kind: DnetJob["kind"],
  body: DnetJob["body"],
  overrides: Partial<DnetJob> = {},
): MadeJob {
  let settled: DnetJobResult | undefined;
  let failed: unknown;
  const job: DnetJob = {
    id: `${kind}-1`,
    kind,
    label: `${kind} under test`,
    budgetGb: 4,
    threads: 1,
    priority: 0,
    longLived: kind === "walk",
    // from === host skips the probe preflight: adjacency is not under test.
    state: { host: "darkweb", from: "darkweb" },
    body,
    settle: (result) => {
      settled ??= result;
    },
    fail: (error) => {
      failed ??= error;
    },
    ...overrides,
  };
  return { job, outcome: () => settled, failure: () => failed };
}

/** A body that blocks in a killable netscriptDelay, like an `authenticate`. */
const blockingBody: DnetJob["body"] = async (jobNs) => {
  await jobNs.sleep(600_000);
  return { ok: true };
};

/** Drive the clock until the pending job is deep inside its blocking call. */
async function inFlight(r: Rig, made: MadeJob): Promise<SimProcess> {
  await r.world.clock.runAsync(() => {
    const pid = made.job.pid;
    return pid !== undefined && r.processes.get(pid)?.runningFn !== undefined;
  }, 60_000);
  return r.processes.get(made.job.pid!)!;
}

describe("the overseer's kill, and the agent's survival of it", () => {
  test("a pointless in-flight job is killed, settles cancelled, and the resident is back before kill returns", async () => {
    const r = rig();
    r.plantResident();
    await r.world.clock.runAsync(() => r.queue() !== undefined, 60_000);
    const queue = r.queue()!;

    const made = makeJob("attempt", blockingBody);
    queue.pending.push(made.job);
    await inFlight(r, made);
    // Job mode stamped its armor the moment it armed the hook.
    expect(made.job.armored).toBe(true);
    const jobPid = made.job.pid!;

    made.job.cancelReason = "credential already verified";
    expect(hardCancelSweep(r.controllerNs, r.rendezvous.queues)).toBe(1);

    // Everything below was already true when hardCancelSweep returned: the
    // atExit hook ran synchronously inside the kill.
    expect(made.outcome()).toMatchObject({ ok: false, targetState: "cancelled" });
    expect(made.job.pid).toBeUndefined();
    expect(queue.active).toBeUndefined();
    expect(queue.completed).toBe(1);
    const replacement = r.processes.ps("darkweb");
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.pid).not.toBe(jobPid);
    expect(replacement[0]!.args).toEqual(["darkweb"]);

    // The zombie continuation of the killed body must not double-book, and the
    // revived resident must pick up the next job as though nothing happened.
    const next = makeJob("attempt", async () => ({ ok: true }), { id: "attempt-2" });
    queue.pending.push(next.job);
    await r.world.clock.runAsync(() => next.outcome() !== undefined, 60_000);
    expect(next.outcome()).toMatchObject({ ok: true });
    expect(queue.completed).toBe(2);
    expect(queue.failed).toBe(0);
    expect(made.failure()).toBeUndefined();
    expect(r.host.crashes).toEqual([]);
  });

  test("a pin is never armored and never shot, even flagged and forged", async () => {
    const r = rig();
    r.plantResident();
    await r.world.clock.runAsync(() => r.queue() !== undefined, 60_000);
    const queue = r.queue()!;

    const made = makeJob("pin", blockingBody);
    queue.pending.push(made.job);
    const running = await inFlight(r, made);

    // Job mode never armed it: no spawn in a pin's budget, no safety net.
    expect(made.job.armored).toBeUndefined();
    made.job.cancelReason = "belief changed";
    expect(hardCancelSweep(r.controllerNs, r.rendezvous.queues)).toBe(0);
    // Even a forged armor flag does not make an exempt kind killable.
    made.job.armored = true;
    expect(hardCancelEligible(made.job)).toBe(false);
    expect(hardCancelSweep(r.controllerNs, r.rendezvous.queues)).toBe(0);
    expect(r.processes.get(running.pid)).toBeDefined();
    expect(made.outcome()).toBeUndefined();
  });

  test("a walk keeps cooperative cancellation only, and an unarmored job is never killed", () => {
    const walk = makeJob("walk", blockingBody, { armored: true, pid: 42 });
    expect(hardCancelEligible(walk.job)).toBe(false);
    const preArmor = makeJob("attempt", blockingBody, { pid: 42 });
    expect(hardCancelEligible(preArmor.job)).toBe(false);
    const armed = makeJob("attempt", blockingBody, { armored: true, pid: 42 });
    expect(hardCancelEligible(armed.job)).toBe(true);
    // The sweep also refuses a job with no pid to vouch.
    const idle = makeJob("attempt", blockingBody, { armored: true });
    expect(hardCancelEligible(idle.job)).toBe(false);
  });

  test("deliberate transitions never trigger the hook, and a dead rendezvous does not respawn-loop", async () => {
    const r = rig();
    r.plantResident();
    await r.world.clock.runAsync(() => r.queue() !== undefined, 60_000);
    const queue = r.queue()!;

    // resident -> job -> resident, the normal round trip: one process at every
    // step, and afterwards exactly one resident — no doubles from the atExit.
    const made = makeJob("attempt", async () => ({ ok: true }));
    queue.pending.push(made.job);
    await r.world.clock.runAsync(() => made.outcome() !== undefined, 60_000);
    expect(made.outcome()).toMatchObject({ ok: true });
    await r.world.clock.runAsync(() => queue.residentPid !== undefined, 60_000);
    expect(r.processes.ps("darkweb")).toHaveLength(1);

    // Retire the rendezvous: the resident's next pass returns deliberately.
    // An armed hook here would respawn a process that exits again, for ever.
    delete dnetRealm().dnet_overseer;
    await r.world.clock.runAsync(() => r.processes.ps("darkweb").length === 0, 60_000);
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.host.crashes).toEqual([]);
  });

  test("a clean job exits straight into its queued successor in the same tick", async () => {
    const r = rig();
    r.plantResident();
    await r.world.clock.runAsync(() => r.queue()?.residentPid !== undefined, 60_000);
    const queue = r.queue()!;
    const events: string[] = [];
    let firstPid = 0;
    let successorPid = 0;
    let firstAt = 0;
    let successorAt = 0;
    const first = makeJob("attempt", async (jobNs) => {
      firstPid = jobNs.pid;
      firstAt = Date.now();
      events.push("authenticate-finished");
      return { ok: true };
    }, { id: "attempt-first", priority: -10 });
    const successor = makeJob("plant", async (jobNs) => {
      successorPid = jobNs.pid;
      successorAt = Date.now();
      events.push("plant-started");
      return { ok: true };
    }, { id: "plant-successor", priority: -9 });

    queue.pending.push(first.job, successor.job);
    signalQueueWork(queue);
    await r.world.clock.runAsync(() => successor.outcome() !== undefined, 60_000);

    expect(events).toEqual(["authenticate-finished", "plant-started"]);
    expect(queue.completed).toBe(2);
    // Consecutive PIDs prove atExit launched the successor itself. An
    // intermediate resident would consume one PID before starting the plant.
    expect(successorPid).toBe(firstPid + 1);
    expect(successorAt).toBe(firstAt);
    expect(r.host.crashes).toEqual([]);
  });

  test("a live-map host restart does not respawn-loop and is immediately replantable", async () => {
    const r = rig();
    r.plantResident();
    await r.world.clock.runAsync(() => (r.queue()?.residentPid) !== undefined, 60_000);
    const queue = r.queue()!;
    const before = queue.residentPid!;

    // Upstream iterates the LIVE running-script map. An atExit spawn inserted
    // here would itself be visited and killed, recursively. External death
    // therefore clears the PID and lets the controller's mutation transaction
    // replant; normal completion and marked cancellation still self-handoff.
    r.processes.killall("darkweb");
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(queue.residentPid).toBeUndefined();
    const replanted = r.plantResident();
    await r.world.clock.runAsync(() => queue.residentPid !== undefined && queue.residentPid !== before, 60_000);
    expect(queue.residentPid).toBe(replanted);
    expect(r.processes.ps("darkweb")).toHaveLength(1);
    expect(r.host.crashes).toEqual([]);
  });

  test("on a deleted host the hook declines: no spawn, no crash", async () => {
    const r = rig();
    r.plantResident();
    await r.world.clock.runAsync(() => (r.queue()?.residentPid) !== undefined, 60_000);
    const queue = r.queue()!;
    const pid = queue.residentPid!;

    // What a delete mutation leaves behind: no files, no server. The guard
    // inside the hook throws on getServerMaxRam and returns instead of
    // spawning into an error dialog.
    r.host.files.delete("darkweb");
    r.world.servers.delete("darkweb");
    r.processes.kill(pid);
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(queue.residentPid).toBeUndefined();
    expect(r.host.crashes).toEqual([]);
  });

  test("a resident that wins the launch race waits for its overseer, then joins", async () => {
    // The bug this guards: home co-launches overseer+resident, the resident can
    // start first and find no rendezvous yet, and exiting on the spot left the
    // host with only an overseer until home's ~30s re-seed backoff elapsed. The
    // resident must instead wait out the boot race.
    const r = rig();
    const registered = dnetRealm().dnet_overseer;
    delete dnetRealm().dnet_overseer;
    const pid = r.plantResident();

    // A few seconds pass with no overseer registered: the resident must still be
    // alive (grace poll) and must NOT have registered a queue.
    await r.world.clock.runAsync(() => false, 3_000);
    expect(r.processes.get(pid)).toBeDefined();
    expect(r.queue()).toBeUndefined();

    // The overseer finishes booting and registers; the resident joins it.
    dnetRealm().dnet_overseer = registered;
    await r.world.clock.runAsync(() => r.queue()?.residentPid !== undefined, 30_000);
    expect(r.queue()?.residentPid).toBe(pid);
    expect(r.host.crashes).toEqual([]);
  });

  test("a resident whose overseer never registers gives up after the grace", async () => {
    // The other side of the same latch: a genuinely dead run (no overseer ever)
    // must not leave a resident polling for ever, or home could never re-seed a
    // single clean one.
    const r = rig();
    delete dnetRealm().dnet_overseer;
    const pid = r.plantResident();

    // Still alive mid-grace, gone once it elapses (15s), with no respawn.
    await r.world.clock.runAsync(() => false, 5_000);
    expect(r.processes.get(pid)).toBeDefined();
    await r.world.clock.runAsync(() => r.processes.get(pid) === undefined, 30_000);
    expect(r.processes.ps("darkweb")).toHaveLength(0);
    expect(r.host.crashes).toEqual([]);
  });

  test("the overseer's wake picks up filed work without waiting out the poll", async () => {
    const r = rig();
    r.plantResident();
    // Wait until the resident is registered and idle (parked in its wait).
    await r.world.clock.runAsync(() => r.queue()?.residentPid !== undefined, 60_000);
    const queue = r.queue()!;

    // File a job the way the overseer's enqueue does: push, then wake.
    const made = makeJob("inventory", async () => ({ ok: true }));
    queue.pending.push(made.job);
    const at = r.world.clock.now();
    signalQueueWork(queue);

    // Picked up on the wake — virtual time barely advances, far under the 1s
    // fallback poll a pure poller would have cost.
    await r.world.clock.runAsync(() => made.outcome() !== undefined, 60_000);
    expect(made.outcome()).toMatchObject({ ok: true });
    expect(r.world.clock.now() - at).toBeLessThan(1_000);
    expect(r.host.crashes).toEqual([]);
  });
});

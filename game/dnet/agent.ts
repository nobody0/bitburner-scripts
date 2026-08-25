import type { NS } from "@ns";
import { realmSleep } from "../lib/wake.ts";
import { captureLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch } from "./launch.ts";
import {
  NO_RESPAWN_KINDS,
  live,
  orderCalls,
  priceCalls,
  waitForWake,
  type AgentHandle,
  type AgentIo,
  type ControllerHandle,
  type HostEntry,
  type Order,
  type Report,
} from "./shared.ts";
import { runOrder } from "./orders.ts";

/** The one thing that runs on a darknet host, in two modes.
 *
 * As a RESIDENT it beats into its host entry and waits; when the controller
 * stages an order it wakes, hands the order to a fresh process, and `spawn`s
 * into ORDER mode with the allocation the controller sized. As an ORDER it runs
 * that one piece of work through a `switch` of DIRECT `ns.*` calls — no closures
 * shipped from the controller — settles its result, then atExit spawns straight
 * into the next staged order or back to resident mode. `game/dnet/shared.ts`
 * states why the spawn round trip is cheaper than `exec` and how a session
 * survives it.
 *
 * ## Cancellation is cooperative, with a hard-kill backstop
 *
 * Bodies check cancelReason at safe boundaries. A body blocked inside one
 * Darknet call cannot observe the flag, so the controller hard-kills an armored
 * agent on the next derive pass; atExit stages the successor after the game
 * clears the blocked Netscript call.
 *
 * ## The one rule that binds this file (and `orders.ts`/`attempt.ts`/`walk.ts`)
 *
 * No expensive `ns` member may be REFERENCED except through bracket notation on
 * the `ns` a body was handed. The process is always launched with an explicit
 * `ramOverride`, so static analysis never bills the agent bundle — only the
 * dynamic check matters, and `KIND_CALLS` is what it is sized against.
 * `tests/ram-budget.test.ts` pins that the per-kind surface matches. */

const RESIDENT_POLL_MS = 1_000;
const CONTROLLER_STARTUP_GRACE_MS = 15_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetAgentLaunch>("dnet-agent");
  const hostArg = typeof ns.args[0] === "string" ? ns.args[0] : undefined;
  const host = launch?.host ?? hostArg;
  if (!host) return;

  // A host too cramped for the ordinary prober + resident runs this deliberately
  // tiny mode: every byte is action threads, no probe, no details, no spawn net.
  if (launch?.bootstrapReclaim === true) {
    const finish = (): void => live()?.bootstrapDone(host);
    ns.atExit(finish, "dnet-bootstrap-reclaim");
    try {
      const g = live();
      if (!g) return;
      g.registerBootstrap(host, ns.pid);
      await ns["dnet"]["memoryReallocation"](host);
    } finally {
      finish();
    }
    return;
  }

  // A LINKED ONE-OFF: claim the first sidecar-marked staged order, run it,
  // report through the entry's sidecar slot, and exit. No resident, no spawn.
  if (launch?.oneOff === true) {
    await runAsOneOff(ns, host);
    return;
  }

  const controllerManaged = launch?.controllerManaged === true;
  const residentGb = priceCalls(ns, orderCalls("idle", controllerManaged));

  // Did the predecessor hand us a specific order? It stamps `entry.pendingOrder`
  // just before its zero-delay spawn; we read and clear it.
  const g = live();
  const pending = g?.hosts.get(host)?.pendingOrder;
  if (g !== undefined && pending !== undefined) {
    const entry = g.hosts.get(host)!;
    entry.pendingOrder = undefined;
    // Adopt only an order this process was SIZED for: a spawn-chained
    // successor (no launch descriptor) always was, and a plant exec was only
    // when the plant claimed the order (controller-managed). A bare-resident
    // exec adopting a stale order would run it at the 3.6 GB idle budget and
    // die at its first uncovered call — leaving the host prober-only again.
    // Handing it back to the queue lets THIS resident spawn into it priced.
    if (launch === undefined || controllerManaged) {
      await runAsOrder(ns, g, entry, pending, residentGb);
      return;
    }
    (entry.staged ??= []).unshift(pending);
  }

  await runAsResident(ns, host, residentGb, controllerManaged);
}

/** This host's entry, creating it if the controller has not seen this host yet.
 * Creating it IS registration: the controller discovers an agent by its entry. */
function ensureEntry(g: ControllerHandle, host: string): HostEntry {
  const existing = g.hosts.get(host);
  if (existing) {
    existing.staged ??= [];
    return existing;
  }
  const created: HostEntry = { hostname: host, lastSeenAt: Date.now(), seenAt: {}, dirty: {}, staged: [] };
  g.hosts.set(host, created);
  return created;
}

/** The successor-spawn atExit hook. Fires on EVERY exit; `deliberate` tells a
 * clean handoff (spawn the successor the exit path already staged into
 * `pendingOrder`) from a game kill (`onDeath` decides). A game kill must NOT
 * spawn: v3.0.1's `killServerScripts` iterates the live PID map and a
 * zero-delay replacement would be re-killed in a loop. `spawn` with
 * spawnDelay:0 runs its server check synchronously and THROWS if the host was
 * deleted — caught, so the whole surface stays `spawn`. */
function armRespawn(
  ns: NS,
  host: string,
  residentGb: number,
  state: { deliberate: boolean },
  onDeath: () => void,
  respawns: boolean,
): void {
  ns.atExit(() => {
    if (state.deliberate) return;
    onDeath();
    if (respawns) respawnFromEntry(ns, host, residentGb);
  }, "dnet-respawn");
}

/** Spawn the process the entry says should run next: the pending order at its
 * own budget, or a resident. Silent if the host is gone. */
function respawnFromEntry(ns: NS, host: string, residentGb: number): void {
  try {
    const entry = live()?.hosts.get(host);
    const next = entry?.pendingOrder;
    ns.spawn(
      ns.getScriptName(),
      next !== undefined
        ? temporaryRunOptions({ threads: next.threads, spawnDelay: 0, ramOverride: next.ramOverrideGb })
        : temporaryRunOptions({ threads: 1, spawnDelay: 0, ramOverride: residentGb }),
      host,
    );
  } catch {
    /* host gone, or the post-spawn ScriptDeath — nothing after this runs */
  }
}

/** Resident mode: register an idle handle, beat, wait for work. When the
 * controller stages an order, hand `staged[0]` to a fresh process and spawn. */
async function runAsResident(ns: NS, host: string, residentGb: number, controllerManaged: boolean): Promise<void> {
  const state = { deliberate: false };
  // A resident killed by a host restart drops its handle and wakes the
  // controller, but never inserts a replacement into the live killall iterator.
  const onDeath = (): void => {
    const entry = live()?.hosts.get(host);
    if (entry?.agent?.pid === ns.pid) entry.agent = undefined;
    live()?.wake("resident-died");
  };
  // Resident death does not self-handoff: it settles and lets the controller
  // replant. Suppress the respawn by not staging a pendingOrder — but the hook
  // would still spawn a resident, which is correct here (a live host keeps its
  // resident). So a plain resident kill DOES respawn a resident; only a host
  // restart/delete makes the spawn throw and stop. That matches the old design.
  armRespawn(ns, host, residentGb, state, onDeath, !controllerManaged);

  const startupAt = Date.now();
  let sawController = false;
  for (;;) {
    const g = live();
    if (!g) {
      if (sawController || Date.now() - startupAt >= CONTROLLER_STARTUP_GRACE_MS) {
        state.deliberate = true;
        return;
      }
      await realmSleep(RESIDENT_POLL_MS);
      continue;
    }
    sawController = true;
    const entry = ensureEntry(g, host);

    // Register / refresh the idle handle so the controller can see this resident
    // and stage work beside it.
    if (entry.agent?.pid !== ns.pid || entry.agent.order.kind !== "idle") {
      g.adopt(host, makeHandle(ns, idleOrder(host, residentGb)));
    } else {
      entry.agent.beatAt = Date.now();
    }

    const staged = entry.staged ??= [];

    // A one-off riding in the queue must launch BESIDE the main order, not
    // after it — the whole point is that their 6 s calls align. Residents never
    // carry `exec` (1.3 GB, and PER THREAD on a sized order), so hop through a
    // transient 1-thread `launchSidecar` process that execs the one-off and
    // then chains into the main order like any completing order.
    if (!controllerManaged && entry.sidecar === undefined && entry.sidecarOrder === undefined
      && staged.some((order) => order.oneOff === true)) {
      entry.pendingOrder = launcherOrder(ns.getScriptName(), host, priceCalls(ns, orderCalls("launchSidecar", false)));
      entry.pendingOrderAt = Date.now();
      state.deliberate = true;
      respawnFromEntry(ns, host, residentGb);
      return;
    }

    // Skip any one-off left in the queue (sidecar slot occupied, or a managed
    // host that cannot hop): only ordinary orders enter the spawn chain.
    const next = staged.find((order) => order.oneOff !== true);
    if (next) {
      if (controllerManaged) {
        // Stasis idle resident, spawn-free: it cannot run the staged order
        // itself (a heavier RAM size). Leave the order in the durable staged
        // queue and wake the controller, which re-execs the host from a free
        // neighbour (the controller itself has no `exec`).
        if (entry.agent?.pid === ns.pid) entry.agent = undefined;
        state.deliberate = true;
        g.wake("stasis-dispatch-requested");
        return;
      }
      staged.splice(staged.indexOf(next), 1);
      entry.pendingOrder = next;
      entry.pendingOrderAt = Date.now();
      state.deliberate = true;
      respawnFromEntry(ns, host, residentGb);
      return;
    }

    await waitForWake(entry, RESIDENT_POLL_MS);
  }
}

/** The `AgentIo` an order body talks to. `isCurrent` gates every write on the
 * handle still owning its slot (agent OR sidecar): a hard-killed order whose
 * zombie `await` resumes must not stamp the map for the process that replaced
 * it. Shared by the main-order and one-off runners, whose only difference is
 * which slot they check. */
function orderIo(g: ControllerHandle, order: Order, handle: AgentHandle, isCurrent: () => boolean): AgentIo {
  return {
    beat: (progress) => {
      if (!isCurrent()) return;
      handle.beatAt = Date.now();
      if (progress !== undefined) handle.progress = progress;
    },
    setExpectedDoneAt: (at) => {
      if (!isCurrent()) return;
      handle.beatAt = Date.now();
      if (at === undefined) delete order.expectedDoneAt;
      else order.expectedDoneAt = at;
    },
    cancelled: () => (isCurrent() ? handle.cancelReason : "orphaned"),
    deps: g.deps,
  };
}

/** Run one order body to a Report, tagging it with the order's identity and
 * turning a throw into a failed report rather than a rejection. */
async function runOrderToReport(ns: NS, order: Order, io: AgentIo): Promise<Report> {
  const tag = { id: order.id, kind: order.kind, host: order.host, from: order.from };
  try {
    return { ...tag, ...(await runOrder(ns, order, io)) };
  } catch (error) {
    return { ...tag, ok: false, detail: `${order.kind}: ${String(error)}`.slice(0, 200) };
  }
}

/** Order mode: run one order to completion, then atExit into the next. */
async function runAsOrder(ns: NS, g: ControllerHandle, entry: HostEntry, order: Order, residentGb: number): Promise<void> {
  const startedAt = Date.now();
  order.startedAt = startedAt;
  delete order.expectedDoneAt;
  const state = { deliberate: false };
  const controllerManaged = order.controllerManaged === true;
  const respawns = !controllerManaged && !NO_RESPAWN_KINDS.has(order.kind);

  let settled = false;
  let settleDone!: (r: Report) => void;
  const done = new Promise<Report>((resolve) => { settleDone = resolve; });
  const settle = (r: Report): void => {
    if (settled) return;
    settled = true;
    settleDone(r);
  };

  const handle: AgentHandle = {
    pid: ns.pid,
    order,
    startedAt,
    beatAt: startedAt,
    armored: false,
    done,
    settle,
  };

  // The death path: settle (cancelled if the controller marked a reason, else
  // died) and stage the successor only for a controller kill of a respawning
  // kind. A plain game kill drops the handle and spawns nothing.
  //
  // `atExitRan` is the whole reason the tail below must be guarded: a hard kill
  // runs THIS synchronously inside the killer's `ns.kill`, and the killed
  // process's blocked `await` then resumes as a ZOMBIE — its `ns` call throws
  // ScriptDeath, the `catch` swallows it, and the tail would otherwise run a
  // SECOND `stageSuccessor`, orphaning the successor this atExit already staged
  // and spawned. So once this has fired, the tail does nothing.
  let atExitRan = false;
  const onDeath = (): void => {
    atExitRan = true;
    delete order.expectedDoneAt;
    const cancelled = handle.cancelReason !== undefined;
    handle.pid = 0;
    settle(terminal(order, cancelled ? "cancelled" : undefined, handle.cancelReason ?? "killed mid-order", cancelled ? false : true));
    if (cancelled && respawns) {
      stageSuccessor(entry);
    } else {
      if (entry.agent === handle) entry.agent = undefined;
      entry.pendingOrder = undefined;
      // A stasis order that DIED reported it through `settle` above, but the
      // controller's `onReport` does not wake the derive on a death. Wake it
      // explicitly so the host is re-staffed promptly rather than waiting for
      // the mutation sweep.
      if (controllerManaged) g.wake("stasis-order-died");
    }
  };
  armRespawn(ns, host_of(order), residentGb, state, onDeath, respawns);
  handle.armored = respawns; // pin/walk never arm the respawn spawn.

  g.adopt(order.from, handle);

  if (handle.cancelReason !== undefined) {
    settle(terminal(order, "cancelled", handle.cancelReason, false));
  } else {
    const io = orderIo(g, order, handle, () => entry.agent === handle);
    const result = await runOrderToReport(ns, order, io);
    delete order.expectedDoneAt;
    settle(result);
  }

  // A hard kill already ran `onDeath` synchronously (staging and spawning the
  // successor inside the killer's `ns.kill`); anything past here is the killed
  // process's zombie continuation, which must not touch the map again.
  if (atExitRan) return;

  // Deliberate exit: stage the successor and spawn into it (respawning kinds).
  state.deliberate = true;
  handle.pid = 0;
  if (respawns) {
    // Spawn-capable: poll the successor into `pendingOrder` and spawn into it.
    stageSuccessor(entry);
    respawnFromEntry(ns, order.from, residentGb);
  } else {
    // No spawn. The successor stays in the durable staged queue and the host
    // is left empty for re-staffing from outside — a stasis order's successor
    // by the controller's re-exec, pin/walk by the spread planner. Both just
    // wake the derive.
    if (entry.agent === handle) entry.agent = undefined;
    entry.pendingOrder = undefined;
    g.wake(controllerManaged ? "stasis-order-finished" : "order-finished");
  }
}

/** Move the first ORDINARY staged order into `pendingOrder` for the next
 * spawn; absent → resident. A `oneOff` order is never a successor: only the
 * resident's `launchSidecar` hop may claim it, at its spawn-free sizing. */
function stageSuccessor(entry: HostEntry): void {
  const staged = entry.staged ??= [];
  const at = staged.findIndex((order) => order.oneOff !== true);
  const next = at < 0 ? undefined : staged.splice(at, 1)[0];
  entry.pendingOrder = next;
  if (next !== undefined) entry.pendingOrderAt = Date.now();
  entry.agent = undefined; // the successor process adopts its own handle
}

function makeHandle(ns: NS, order: Order): AgentHandle {
  let settle!: (r: Report) => void;
  const startedAt = Date.now();
  order.startedAt = startedAt;
  return {
    pid: ns.pid,
    order,
    startedAt,
    beatAt: startedAt,
    armored: false,
    done: new Promise<Report>((resolve) => { settle = resolve; }),
    settle: (r) => settle(r),
  };
}

function terminal(order: Order, targetState: "cancelled" | undefined, detail: string, died: boolean): Report {
  return {
    id: order.id, kind: order.kind, host: order.host, from: order.from, ok: false,
    ...(targetState !== undefined ? { targetState } : {}),
    ...(died ? { died: true } : {}),
    detail,
  };
}

/** One-off mode: run the order the `launchSidecar` hop staged into
 * `entry.sidecarOrder`, reporting through the entry's SIDECAR slot beside the
 * main agent. No resident, no spawn, no successor — death settles and clears
 * the slot, and the controller kills this pid whenever the vantage retires. */
async function runAsOneOff(ns: NS, host: string): Promise<void> {
  const g = live();
  const entry = g?.hosts.get(host);
  const order = entry?.sidecarOrder;
  if (g === undefined || entry === undefined || order === undefined || entry.sidecar !== undefined) return;
  entry.sidecarOrder = undefined;

  const handle = makeHandle(ns, order);
  delete order.expectedDoneAt;

  ns.atExit(() => {
    delete order.expectedDoneAt;
    handle.pid = 0;
    const cancelled = handle.cancelReason !== undefined;
    handle.settle(terminal(order, cancelled ? "cancelled" : undefined, handle.cancelReason ?? "one-off killed mid-order", !cancelled));
    if (entry.sidecar === handle) entry.sidecar = undefined;
  }, "dnet-oneoff");

  g.adopt(host, handle, true);

  const io = orderIo(g, order, handle, () => entry.sidecar === handle);
  const result = await runOrderToReport(ns, order, io);
  delete order.expectedDoneAt;
  handle.settle(result);
  // The exit right behind this return fires the atExit, which zeroes the pid
  // and clears the slot; its terminal settle is a no-op after this one.
}

/** The transient 1-thread hop that execs a linked one-off. Synthesized by the
 * resident (never by the controller), so it carries the script name along. */
function launcherOrder(scriptFile: string, host: string, ramOverrideGb: number): Order {
  return {
    id: `launchSidecar:${host}:${Date.now()}`,
    kind: "launchSidecar",
    host,
    from: host,
    filename: scriptFile,
    ramOverrideGb,
    threads: 1,
    priority: 0,
    longLived: false,
    label: "sidecar hop",
  };
}

function idleOrder(host: string, ramOverrideGb: number): Order {
  return {
    id: `idle:${host}`,
    kind: "idle",
    host,
    from: host,
    ramOverrideGb,
    threads: 1,
    priority: 1_000_000,
    longLived: false,
    label: "resident",
  };
}

function host_of(order: Order): string {
  return order.from;
}

import type { NS } from "@ns";
import { realmSleep } from "../lib/wake.ts";
import { captureLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch } from "./launch.ts";
import {
  KIND_CALLS,
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

  const controllerManaged = launch?.controllerManaged === true;
  const residentGb = priceCalls(ns, orderCalls("idle", controllerManaged));

  // Did the predecessor hand us a specific order? It stamps `entry.pendingOrder`
  // just before its zero-delay spawn; we read and clear it.
  const g = live();
  const pending = g?.hosts.get(host)?.pendingOrder;
  if (g !== undefined && pending !== undefined) {
    const entry = g.hosts.get(host)!;
    entry.pendingOrder = undefined;
    await runAsOrder(ns, g, entry, pending, residentGb);
    return;
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
    const next = staged[0];
    if (next) {
      if (controllerManaged) {
        // The remote dispatcher claims the order only when it can exec it.
        // Until then it remains in the durable controller-owned queue.
        if (entry.agent?.pid === ns.pid) entry.agent = undefined;
        // This is a handoff, not a failed spread attempt. Let the controller
        // replant immediately instead of imposing the ordinary retry cooldown.
        entry.lastPlantAt = undefined;
        state.deliberate = true;
        g.wake("stasis-dispatch-requested");
        return;
      }
      staged.shift();
      entry.pendingOrder = next;
      state.deliberate = true;
      respawnFromEntry(ns, host, residentGb);
      return;
    }

    await waitForWake(entry, RESIDENT_POLL_MS);
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
  let result: Report | undefined;
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
    }
  };
  armRespawn(ns, host_of(order), residentGb, state, onDeath, respawns);
  handle.armored = respawns; // pin/walk never arm the respawn spawn.

  g.adopt(order.from, handle);

  if (handle.cancelReason !== undefined) {
    settle(terminal(order, "cancelled", handle.cancelReason, false));
  } else {
    const io: AgentIo = {
      beat: (progress) => {
        if (entry.agent === handle) {
          handle.beatAt = Date.now();
          if (progress !== undefined) handle.progress = progress;
        }
      },
      setExpectedDoneAt: (at) => {
        if (entry.agent !== handle) return;
        handle.beatAt = Date.now();
        if (at === undefined) delete order.expectedDoneAt;
        else order.expectedDoneAt = at;
      },
      cancelled: () => (entry.agent === handle ? handle.cancelReason : "orphaned"),
      deps: g.deps,
    };
    try {
      const r = await runOrder(ns, order, io);
      result = { id: order.id, kind: order.kind, host: order.host, from: order.from, ...r };
    } catch (error) {
      result = { id: order.id, kind: order.kind, host: order.host, from: order.from, ok: false, detail: `${order.kind}: ${String(error)}`.slice(0, 200) };
    }
    delete order.expectedDoneAt;
    settle(result ?? terminal(order, "cancelled", handle.cancelReason ?? "cancelled", false));
  }

  // A hard kill already ran `onDeath` synchronously (staging and spawning the
  // successor inside the killer's `ns.kill`); anything past here is the killed
  // process's zombie continuation, which must not touch the map again.
  if (atExitRan) return;

  // Deliberate exit: stage the successor and spawn into it (respawning kinds).
  state.deliberate = true;
  handle.pid = 0;
  if (respawns) {
    stageSuccessor(entry);
    respawnFromEntry(ns, order.from, residentGb);
  } else {
    // pin/walk and stasis-managed work leave recovery to the controller. The
    // staged queue remains intact and is the successor handoff.
    if (entry.agent === handle) entry.agent = undefined;
    entry.pendingOrder = undefined;
    if (controllerManaged) entry.lastPlantAt = undefined;
    g.wake("controller-managed-order-finished");
  }
}

/** Move `staged[0]` into `pendingOrder` for the next spawn; absent → resident. */
function stageSuccessor(entry: HostEntry): void {
  const next = (entry.staged ??= []).shift();
  entry.pendingOrder = next;
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

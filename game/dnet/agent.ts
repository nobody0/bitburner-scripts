import type { NS } from "@ns";
import { captureLaunch } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch } from "./launch.ts";
import {
  live,
  type AgentHandle,
  type AgentIo,
  type ControllerHandle,
  type HostEntry,
  type Order,
  type Report,
} from "./shared.ts";
import { runOrder } from "./orders.ts";
import { RELEASED } from "./timing.ts";

/** The one thing that runs on a darknet host: ONE order, then gone.
 *
 * The controller stages an order and `exec`s this process sized for exactly
 * that order, so a worker that finds no order was launched for nothing and
 * exits. It never becomes the next order, so it carries no `spawn` — and the
 * engine's dynamic RAM check, which bills a process for the UNION of every
 * `ns` member it ever calls, only ever sees one order's surface.
 *
 * ## Cancellation is a release plus a kill
 *
 * A body blocked inside a Darknet call has no boundary at which to notice
 * anything, so it publishes a release hook
 * (`awaitDnetOperation`) — but that only ends the WAIT, never the call:
 * Bitburner allows one Netscript call per script at a time and the engine holds
 * that slot until it finishes. Recovering the host takes `ns.kill`. The release
 * still earns its keep — the controller stops waiting on a result it no longer
 * wants and re-plans in that instant — it just cannot be the whole mechanism;
 * see `timing.ts`.
 *
 * ## The one rule that binds this file (and `orders.ts`/`attempt.ts`/`walk.ts`)
 *
 * No expensive `ns` member may be REFERENCED except through bracket notation on
 * the `ns` a body was handed. The process is always launched with an explicit
 * `ramOverride`, so static analysis never bills the agent bundle — only the
 * dynamic check matters, and `KIND_CALLS` is what it is sized against.
 * `tests/ram-budget.test.ts` pins that the per-kind surface matches. */

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetAgentLaunch>("dnet-agent", ns.args[0]);
  const hostArg = typeof ns.args[0] === "string" ? ns.args[0] : undefined;
  const host = launch?.host ?? hostArg;
  if (!host) return;

  // ARM FIRST, decide later. A death before a real hook is registered leaves
  // the host empty with no trace: the controller sees a plant that exec'd a
  // real pid and a host that is agentless moments later, so it replants, and
  // the same window swallows the next one. This stands down as soon as a real
  // hook takes over, because the engine runs every registered handler.
  const guard = { armed: false };
  ns.atExit(() => {
    if (guard.armed) return;
    live()?.wake("agent-died-before-arming");
  }, "dnet-boot-guard");

  // A host too cramped for the ordinary prober + resident runs this deliberately
  // tiny mode: every byte is action threads, no probe, no details, no spawn net.
  if (launch?.bootstrapReclaim === true) {
    const finish = (): void => live()?.bootstrapDone(host);
    // Its own hook, so the boot guard stands down: a reclaimer that exits is
    // not a lost agent, it is a finished one.
    guard.armed = true;
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

  const g = live();
  const entry = g?.hosts.get(host);
  const pending = entry?.pendingOrder;
  if (g === undefined || entry === undefined || pending === undefined) return;
  entry.pendingOrder = undefined;

  await runAsOrder(ns, g, entry, pending, guard);
}

/** The `AgentIo` an order body talks to. `isCurrent` gates every write on the
 * handle still owning its slot: a hard-killed order whose zombie `await`
 * resumes must not stamp the map for the process that replaced it. */
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
    cancelled: () => (isCurrent() ? undefined : "orphaned"),
    hold: (release) => {
      if (!isCurrent()) return;
      handle.release = release;
    },
    // NOT gated on `isCurrent`. This is a fact about the PROCESS, not about
    // who owns the slot: the engine call is outstanding either way, and an
    // orphaned handle that drops it would send the exit path straight into a
    // CONCURRENCY ERROR.
    inFlight: (settling) => { handle.inFlight = settling; },
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
    // Released, not failed: the controller decided this work no longer
    // mattered while we were waiting on a call, and we stopped waiting.
    if (error === RELEASED) {
      return { ...tag, ok: false, targetState: "cancelled", detail: io.cancelled() ?? "released" };
    }
    return { ...tag, ok: false, detail: `${order.kind}: ${String(error)}`.slice(0, 200) };
  }
}

function terminal(order: Order, detail: string): Report {
  return {
    id: order.id, kind: order.kind, host: order.host, from: order.from,
    ok: false, died: true, detail,
  };
}

/** Run the staged order to completion, report, and hand the host back. */
async function runAsOrder(ns: NS, g: ControllerHandle, entry: HostEntry, order: Order, guard: { armed: boolean }): Promise<void> {
  const startedAt = Date.now();
  order.startedAt = startedAt;
  delete order.expectedDoneAt;

  let settled = false;
  let settleDone!: (r: Report) => void;
  const done = new Promise<Report>((resolve) => { settleDone = resolve; });
  const settle = (r: Report): void => {
    if (settled) return;
    settled = true;
    settleDone(r);
  };

  const handle: AgentHandle = { pid: ns.pid, order, startedAt, beatAt: startedAt, done, settle };

  // The death path: settle as died, drop the handle, and tell the controller —
  // it launches whatever comes next.
  //
  // `deliberate` separates the two exits: set by the body just before it
  // returns, it means "I finished and reported"; unset means a kill, where this
  // hook is the only word anyone gets. `atExitRan` guards the tail: a hard kill
  // runs this synchronously inside the killer's `ns.kill`, and the killed
  // process's blocked `await` then resumes as a ZOMBIE whose `ns` call throws
  // ScriptDeath into a `catch`, which must not touch the map again.
  let deliberate = false;
  let atExitRan = false;
  guard.armed = true;
  ns.atExit(() => {
    if (deliberate) return;
    atExitRan = true;
    delete order.expectedDoneAt;
    handle.pid = 0;
    settle(terminal(order, "killed mid-order"));
    if (entry.agent === handle) entry.agent = undefined;
    entry.pendingOrder = undefined;
    // CHECK OUT. The host is free the instant this returns, and the controller
    // is the only thing that can act on that.
    g.wake("order-died");
  }, "dnet-exit");

  g.adopt(order.from, handle);

  const io = orderIo(g, order, handle, () => entry.agent === handle);
  const result = await runOrderToReport(ns, order, io);
  delete order.expectedDoneAt;
  settle(result);

  // The report is published; the ENGINE may not be finished. A released body
  // walked away from a call that still holds this script's one Netscript slot,
  // and everything below is an `ns` call that would throw CONCURRENCY ERROR and
  // take the host's agent with it. Settling first costs this process the
  // remainder of a call it could not have cancelled anyway; the controller was
  // freed to re-plan at the moment of release, which is the part that mattered.
  if (handle.inFlight !== undefined) {
    try { await handle.inFlight; } catch { /* the engine's problem, not ours */ }
    handle.inFlight = undefined;
  }

  if (atExitRan) return;

  // DELIBERATE EXIT. Drop the handle and wake the controller from `atExit`,
  // never before returning: `exec` has no ordering against this process, so a
  // wake that queued the derive first could let the plant run while this
  // process still holds its RAM, and the launch is refused onto a host that
  // looks full. `atExit` runs BEFORE the engine frees the allocation, so what
  // makes this safe is on the other side — `signalDerive` defers the pass to a
  // MICROTASK, which cannot run until this whole synchronous stack (handlers,
  // stopFlag, free) has unwound. Do not "simplify" that microtask away.
  deliberate = true;
  handle.pid = 0;
  if (entry.agent === handle) entry.agent = undefined;
  entry.pendingOrder = undefined;
  ns.atExit(() => live()?.wake("order-finished"), "dnet-wake-order-finished");
}

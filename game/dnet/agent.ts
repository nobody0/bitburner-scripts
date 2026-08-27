import type { NS } from "@ns";
import { captureLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch } from "./launch.ts";
import {
  live,
  orderCalls,
  takeNextOrder,
  type AgentHandle,
  type AgentIo,
  type ControllerHandle,
  type HostEntry,
  type Order,
  type Report,
} from "./shared.ts";
import { runOrder } from "./orders.ts";
import { RELEASED } from "./timing.ts";

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
 * ## Cancellation is cooperative between calls, and a kill inside one
 *
 * Bodies check cancelReason at safe boundaries, and a body BETWEEN calls needs
 * nothing else: it reads the flag, exits on its own terms, and spawns its
 * successor. A body blocked INSIDE a Darknet call has no boundary to read it
 * at, so it publishes a release hook (`awaitDnetOperation`) — but the hook only
 * ends the WAIT, never the call. Bitburner allows one Netscript call per script
 * at a time, and the engine holds that slot until it finishes, so a released
 * body may settle its report and then do nothing but wait for the engine.
 *
 * Recovering the host takes `ns.kill`, and the engine builds the handoff for
 * it: `killWorkerScript` clears `env.runningFn` FIRST, runs the atExit
 * handlers with a clean slot, and only then frees the allocation. So the
 * victim's `armRespawn` hook spawns its own successor from inside the kill,
 * and that spawn's own kill frees this process's RAM before the launch. The
 * release still earns its keep — the controller stops waiting on a result it
 * no longer wants and re-plans in that instant — it just cannot be the whole
 * mechanism. It was, and hosts were lost to `CONCURRENCY ERROR` on the way
 * out; see `timing.ts`.
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

  // ARM FIRST, decide later.
  //
  // Every recovery hook in this file is armed by `armRespawn`, and that cannot
  // happen until the process has read its launch descriptor, found the
  // controller and priced itself. A death anywhere in that window leaves the
  // host empty with NO hook and no trace: the controller sees a plant that
  // exec'd a real pid and a host that is agentless moments later, so it
  // replants, and the same window swallows the next one. Every path out of
  // this process must pass through an `atExit`, so the first one is registered
  // before there is anything to lose.
  //
  // It stands down the moment a real hook takes over — `armed` — because the
  // engine runs every registered handler and the real one owns the exit.
  const guard = { armed: false };
  ns.atExit(() => {
    if (guard.armed) return;
    // grep `dnet:` to remove.
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

  // ONE ORDER, THEN GONE.
  //
  // There is no resident. The controller holds the launcher — it execs this
  // process through the host's prober `ns`, sized for exactly the order it
  // staged — so a worker that finds no order was launched for nothing and has
  // nothing to wait for. It exits, and the host is free the moment it does.
  //
  // That is the whole reason this process no longer carries `spawn`: it never
  // becomes the next order, so it never pays 2 GB PER THREAD for a handoff
  // that happens once.
  const g = live();
  const entry = g?.hosts.get(host);
  const pending = entry?.pendingOrder;
  if (g === undefined || entry === undefined || pending === undefined) {
    // grep `dnet:` to remove.
    return;
  }
  entry.pendingOrder = undefined;

  // grep `dnet:` to remove. The label is the WHY: for an attempt it is the
  // difference between "a cache log named this password" (one instant call)
  // and "candidate 7/12" (a step through a dictionary) — and if the same label
  // repeats for ever, that is the bug naming itself.
  await runAsOrder(ns, g, entry, pending, guard);
}

/** Wake the controller from `atExit`, never before returning.
 *
 * A spawn-free host hands its slot back and waits to be re-`exec`'d, and the
 * two processes must not overlap: `spawn` kills its caller before launching
 * the successor, but `exec` has no such ordering. A body that wakes the
 * controller and THEN returns queues the derive first, so the plant and its
 * `exec` can run while this process is still holding its RAM, and the launch
 * is refused onto a host that looks full.
 *
 * `atExit` does NOT run with the free — `killWorkerScript` runs the handlers
 * FIRST and only then sets `stopFlag` and does `updateRamUsed(ramUsed -
 * ramUsage * threads)`, both synchronously. So waking from here is still
 * inside this process's allocation. What makes it safe is on the other side:
 * `signalDerive` defers the pass to a MICROTASK, which cannot run until this
 * whole synchronous stack — handlers, stopFlag, free — has unwound. The
 * ordering is real, but it is the controller's deferral that provides it, not
 * the engine's. Do not "simplify" that microtask away. */
function wakeOnExit(ns: NS, cause: string): void {
  ns.atExit(() => live()?.wake(cause), `dnet-wake-${cause}`);
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

/** Arm the ONE hook that turns an unnatural death into a report.
 *
 * It no longer respawns anything. A worker used to be its own launcher — its
 * `atExit` spawned the successor — and that is precisely what put `spawn` on
 * every thread of every order. The controller holds the launcher now, so all
 * this has to do is say what happened and let go of the host.
 *
 * `state.deliberate` still separates the two exits: set by the body just
 * before it returns, it says "I finished and reported"; unset means a kill,
 * where this hook is the only word anyone gets. */
function armExit(
  ns: NS,
  state: { deliberate: boolean },
  onDeath: () => void,
  /** The boot guard this supersedes. Stood down here rather than in `main` so
   * it cannot be forgotten by a future third runner. */
  guard?: { armed: boolean },
): void {
  if (guard !== undefined) guard.armed = true;
  ns.atExit(() => {
    if (state.deliberate) return;
    onDeath();
  }, "dnet-exit");
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
    cancelled: () => (isCurrent() ? handle.cancelReason : "orphaned"),
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
    // mattered while we were waiting on a call, and we stopped waiting. The
    // process goes on to its exit path and its next job.
    if (error === RELEASED) {
      return { ...tag, ok: false, targetState: "cancelled", detail: io.cancelled() ?? "released" };
    }
    return { ...tag, ok: false, detail: `${order.kind}: ${String(error)}`.slice(0, 200) };
  }
}

/** Order mode: run one order to completion, then spawn into the next.
 *
 * ONE order per process, always. The successor gets a `spawn` even when its
 * allocation is smaller, and that is not an oversight to optimise away: the
 * engine's dynamic RAM check charges a process for the UNION of every `ns`
 * member it has ever called, so a second order run in the same process owes
 * for both surfaces and is killed the moment the union exceeds what the exec
 * was sized for. Chaining two orders here read as `killed mid-order` — no
 * cancel reason, no codes — and left the host holding its prober alone.
 * Resetting that charge is the whole reason `spawn` is in this path. */
async function runAsOrder(ns: NS, g: ControllerHandle, entry: HostEntry, order: Order, guard?: { armed: boolean }): Promise<void> {
  const startedAt = Date.now();
  order.startedAt = startedAt;
  delete order.expectedDoneAt;
  const state = { deliberate: false };

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
    done,
    settle,
  };

  // The death path: settle (cancelled if the controller marked a reason, else
  // died), drop the handle, and tell the controller. It launches whatever comes
  // next — this process never did, and no longer carries the `spawn` it would
  // have needed to.
  //
  // `atExitRan` still guards the tail: a hard kill runs THIS synchronously
  // inside the killer's `ns.kill`, and the killed process's blocked `await`
  // then resumes as a ZOMBIE whose `ns` call throws ScriptDeath into a `catch`.
  // Once this has fired, the tail must not touch the map again.
  let atExitRan = false;
  const onDeath = (): void => {
    atExitRan = true;
    delete order.expectedDoneAt;
    const cancelled = handle.cancelReason !== undefined;
    handle.pid = 0;
    settle(terminal(order, cancelled ? "cancelled" : undefined, handle.cancelReason ?? "killed mid-order", cancelled ? false : true));
    if (entry.agent === handle) entry.agent = undefined;
    entry.pendingOrder = undefined;
    // CHECK OUT. The host is free the instant this returns, and the controller
    // is the only thing that can act on that.
    g.wake("order-died");
  };
  armExit(ns, state, onDeath, guard);

  g.adopt(order.from, handle);

  if (handle.cancelReason !== undefined) {
    settle(terminal(order, "cancelled", handle.cancelReason, false));
  } else {
    const io = orderIo(g, order, handle, () => entry.agent === handle);
    const result = await runOrderToReport(ns, order, io);
    delete order.expectedDoneAt;
    settle(result);
  }

  // The report is published; the ENGINE may not be finished. A released body
  // walked away from a call that still holds this script's one Netscript slot,
  // and everything below — `wakeOnExit`'s `atExit`, the handle drop —
  // is an `ns` call that would throw CONCURRENCY ERROR and take the host's
  // agent with it. Settling first costs this process the remainder of a call
  // it could not have cancelled anyway; the controller was freed to re-plan at
  // the moment of release, which is the part that mattered.
  if (handle.inFlight !== undefined) {
    try { await handle.inFlight; } catch { /* the engine's problem, not ours */ }
    handle.inFlight = undefined;
  }

  // A hard kill already ran `onDeath` synchronously; anything past here is the
  // killed process's zombie continuation, which must not touch the map again.
  if (atExitRan) return;

  // DELIBERATE EXIT. Drop the handle and say so — the controller launches the
  // next order through this host's lender, so there is nothing here to choose,
  // size, or spawn into.
  //
  // The `derived()` barrier this replaced existed only because the exiting
  // worker picked its own successor and had to wait for the controller to
  // decide first. Nobody picks a successor here any more, so the race it
  // closed cannot happen, and `[dnet:spin]` — the wasted resident hop it was
  // failing to prevent — has nothing left to describe.
  state.deliberate = true;
  handle.pid = 0;
  if (entry.agent === handle) entry.agent = undefined;
  entry.pendingOrder = undefined;
  wakeOnExit(ns, "order-finished");
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


function host_of(order: Order): string {
  return order.from;
}

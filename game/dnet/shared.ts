import type { NS } from "@ns";
import type { DnetProbeRefresh } from "./launch.ts";
import type { AttemptOutcome, LogDrainOutcome, ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import type { DnetHost } from "../../shared/strategy/dnet/host.ts";
import type { TaskKind } from "../../shared/strategy/dnet/plan.ts";
import type { DnetTimingProfile } from "../../shared/strategy/dnet/rates.ts";
import type { DnetDrain, DnetOrders } from "./wire.ts";
import type { DarknetProfit } from "../../shared/telemetry/topics/dnet.ts";

/** The one object the controller and its agents meet at, and the rules that
 * keep a live reference to a dead host from becoming a bug.
 *
 * This replaces `realm.ts`. The differences from `game/lib/dodge-shared.ts` are
 * all forced by one thing: RAM out there is scarce, uneven, and can vanish.
 *
 * ## The shape
 *
 * - The **controller** is long-lived and holds every piece of state: the one
 *   `hosts` map (knowledge AND runtime), the credentials, and the staged work
 *   per host. It never spawns and never execs, because it must not die and
 *   `spawn` kills its caller.
 * - Each darknet host holds exactly one **agent** process, also long-lived. As
 *   a resident it beats and waits; when the controller stages an order it
 *   `spawn`s into it with `spawnDelay: 0`, which kills the resident and starts
 *   the ordered work on the same host. The work settles, then atExit spawns
 *   directly into the next staged order or back to resident mode.
 * - A permanent 1.8 GB **prober** sits beside the agent on every planted host,
 *   because `probe()` is host-local. It carries no self-revival; the agent's
 *   spawn chain is its safety net, and the controller re-execs it when both die.
 *
 * So a host holds at most two of our scripts — the prober and one agent — and
 * the agent's peak RAM is the largest single order rather than the sum.
 *
 * ## Why a live object rather than ports or files
 *
 * Every script the game runs shares one JS realm, so the controller's own
 * object is reachable from an agent directly. That is not a shortcut past a game
 * rule: what preserves BN15's challenge is enforced by the engine — sessions
 * are per-PID, `probe()` is host-local, and the network kills your scripts.
 *
 * The hazard is that the object holds live references that outlive the hosts
 * they describe, so four rules are enforced:
 *
 * 1. **Entries are expired, never trusted.** A prober whose stamp stops
 *    advancing is revived; an agent whose `done` never settles is timed out.
 * 2. **A foreign generation is refused** (`live` / `controllerIsLive`), because
 *    agents outlive controllers and a live script from a dead run describes a
 *    world this one does not share.
 * 3. **Home keeps its own fold.** `drain()` hands observations over ONCE.
 * 4. **A credential never reaches telemetry.** It lives in the controller's
 *    vault and in home's; the published record carries a boolean. */

/** A version on the global SHAPE. It moves because agents outlive controllers
 * and a build handoff leaves both on disk: an agent from the previous build
 * reading a global whose shape moved under it is a bug with no symptom.
 * Refusing by number makes it exit instead. */
export const DNET_PROTOCOL = 11;

/** The script base every allocation starts from. Transcribed rather than read,
 * because a launcher sizes a process it has not started yet.
 * Source: src/Netscript/RamCostGenerator.ts RamCostConstants.Base */
export const SCRIPT_BASE_GB = 1.6;

// --- orders and reports: DATA, never closures --------------------------------

export type OrderKind = TaskKind | "idle" | "bootstrapReclaim" | "launchSidecar";

/** Everything an order needs, carried as data. It lives in the realm rather
 * than in `ns.args` because it may carry a password, and `ns.args` is visible
 * in the game's script listing. */
export interface Order {
  id: string;
  kind: OrderKind;
  /** The TARGET the order acts on — not the host it runs on, which is `from`.
   *  The two are the same for most kinds; `induce` is the one call that REFUSES
   *  its own host, so there `host` is a neighbour and `from` is the vantage. */
  host: string;
  /** Where the order RUNS — the agent's own host, the vantage. */
  from: string;
  /** Allocation for the process that runs it, PER THREAD: base + its calls +
   *  (except pin/walk) the atExit successor spawn. */
  ramOverrideGb: number;
  threads: number;
  /** Lower is more urgent, carried from the derived `Task`. */
  priority: number;
  /** True for work that does not finish on its own — only the maze walk. */
  longLived: boolean;
  /** For the panel and the failure line. */
  label: string;
  /** When the running process started this order, stamped by the agent. */
  startedAt?: number;
  /** Current completion estimate, used only to choose the least-cost victim. */
  expectedDoneAt?: number;
  /** Run without spawn; the controller remotely restores this stasis host. */
  controllerManaged?: boolean;

  // --- kind-specific data ---------------------------------------------------
  targetIdentity?: string;
  password?: string;
  knownHosts?: string[];
  jobThreads?: number;
  resizeAtBlockedRam?: number;
  bootstrapReclaim?: boolean;
  bootstrapThreads?: number;
  omitProber?: boolean;
  /** The plant target is stasis-linked and must use controller handoff. */
  targetControllerManaged?: boolean;
  sessionOnly?: boolean;
  edge?: string;
  unpin?: boolean;
  payloads?: string[];
  guess?: string;
  /** Standalone bleed waits for this exact authentication order. */
  followAttemptIds?: readonly string[];
  skipInitialBleed?: boolean;
  symbol?: string;
  filename?: string;
  /** Walks only: the macro-route bias the walk body hands `routePrior` — set
   *  for a mortal scout, absent (unbiased) for the finisher. */
  route?: string;
  /** Walks only: a MORTAL scout rather than the pinned finisher. The
   *  controller cannot tell the two apart from a live handle otherwise, and
   *  the difference decides who is stamped irreplaceable, who holds the storm
   *  and whose absence re-plans a walk. */
  scout?: true;
  /** A LINKED ONE-OFF sidecar: exec'd by the resident beside the main order
   *  instead of being spawned into after it. Spawn-free (its `ramOverrideGb`
   *  is priced without the successor spawn), reports through `entry.sidecar`,
   *  exits when its body settles, and dies with its host's agents — the
   *  controller kills it whenever it retires the vantage. Born for the second
   *  induce push whose 6 s aligns with the main's: "I have X GB and six
   *  seconds — find something to do." */
  oneOff?: true;
}

/** What an order hands back. Data, never live objects: the controller folds it
 * into the map, and the map has to outlive the process that produced it. */
export interface Report {
  id: string;
  kind: OrderKind;
  host: string;
  from: string;
  ok: boolean;
  /** Set on the death path (an unintended kill) rather than a clean settle. */
  died?: boolean;
  targetState?: "edge-lost" | "gone" | "replaced" | "credential-rejected" | "launch-refused" | "cancelled";
  hosts?: ReportHost[];
  attempts?: AttemptOutcome[];
  codes?: Record<string, number>;
  charismaNeeded?: number;
  karmaLoss?: number;
  /** Since-last-report contribution; the controller and home fold it. */
  profit?: Partial<DarknetProfit>;
  /** Induce only: the target's accumulated migration charge (0..1), parsed
   *  from the engine's own "Migration prep is now at X.XX%" response — the
   *  only read-back the engine offers for `migrationInductionServers`. 0 after
   *  a completed move (the engine resets on landing). */
  induceCharge?: number;
  stormFiredAt?: number;
  grammar?: { unrecognised: number; shapes: string[] };
  detail?: string;
}

/** What a long-running order body (`attempt`, `walk`) is handed by the agent.
 *
 * Everything stateful arrives HERE rather than through `globalThis`: the body
 * never touches the realm, so a killed agent loses nothing — the ledger, ring
 * and lab-field write-throughs are the controller's, keyed by target. `beat`
 * stamps liveness (and optional progress) for a long order; `cancelled` returns
 * the controller's cooperative reason when set. */
export interface AgentIo {
  beat: (progress?: Record<string, unknown>) => void;
  /** Publish the operation currently awaited, and clear it as soon as that
   * operation settles. Updating this estimate is itself a liveness beat. */
  setExpectedDoneAt: (at: number | undefined) => void;
  cancelled: () => string | undefined;
  deps: ControllerDeps;
}

/** One agent process, as the controller and the agent both see it.
 *
 * The controller sets cancelReason; bodies observe it at safe boundaries. A
 * blocked Darknet call is stopped by hard-killing an armored agent on the next
 * derive pass. done settles when the body finishes or atExit handles that kill. */
export interface AgentHandle {
  pid: number;
  order: Order;
  startedAt: number;
  /** Long-lived orders stamp this every iteration; the liveness authority. */
  beatAt: number;
  /** Whatever the last beat carried, for a long order worth watching live. */
  progress?: Record<string, unknown>;
  /** The agent proved its atExit respawn hook. The controller's licence to
   *  hard-kill it: the kill runs that hook synchronously in the killer's stack,
   *  settling and respawning before `ns.kill` returns. Never set by a pre-armor
   *  build, so an old process is never killed without its net. */
  armored: boolean;
  /** Controller-set; the cooperative cancel flag. Bodies poll it at loop
   *  boundaries and stop there, and it is the licence hard cancel checks. */
  cancelReason?: string;
  /** Derive pass that requested cancellation; hard cancellation waits until a
   * later pass so the body gets one cooperative boundary first. */
  cancelRequestedPass?: number;
  /** Resolves the instant the order finishes or is cancelled. Idempotent. */
  done: Promise<Report>;
  settle: (report: Report) => void;
}

/** One host: everything we KNOW about it (the `DnetHost` fields) plus the
 * runtime state that hangs off it. The runtime fields are all optional, so a
 * plain `DnetHost` the fold creates is a valid entry — which is what lets
 * `foldReports` operate on this map directly. */
export interface HostEntry extends DnetHost {
  /** The permanent prober beside the agent. `pid: 0` marks a walk host whose
   *  prober was deliberately killed; `at` is the last report stamp (dead-prober
   *  detection compares it to the mutation clock). */
  prober?: { pid: number; at: number; neighbours: string[]; epoch: number };
  /** One exact prober launch is expected to publish a first report. Kept on
   * the host rather than as a launch callback so every caller observes the
   * same readiness barrier and an old prober cannot satisfy it. */
  probeRefresh?: DnetProbeRefresh;
  /** When the outstanding barrier was opened, for the stale-barrier reclaim:
   * a launcher that died between exec and settle would otherwise pin the
   * barrier forever, and every later plant on the host would await a report
   * nobody will ever file. */
  probeRefreshAt?: number;
  /** THE process on this host. `order.kind === "idle"` is resident mode. */
  agent?: AgentHandle;
  /** The one linked one-off riding beside the main agent, when the resident
   * exec'd a sidecar. Dies with the vantage; at most one at a time. */
  sidecar?: AgentHandle;
  /** The order the one-off process should run, staged by the `launchSidecar`
   * hop just before its exec — the sidecar mirror of `pendingOrder`. Claimed
   * out of `staged` by the hop, NOT by the one-off, so the ordinary successor
   * chain can never spawn into it by mistake. */
  sidecarOrder?: Order;
  /** When the hop claimed `sidecarOrder`; ages the claim out if the exec'd
   * one-off died before adopting it — the sidecar mirror of `pendingOrderAt`. */
  sidecarOrderAt?: number;
  /** A spawn-free local reclaimer — not an agent, and must not be staged to. */
  bootstrap?: { pid: number; startedAt: number };
  /** Pending orders, kept priority-sorted; the agent consumes `staged[0]`. */
  staged?: Order[];
  /** The order the NEXT-spawned process should run. A resident (or a finishing
   *  order) sets this from `staged` just before its zero-delay `spawn`; the
   *  booting process reads and clears it. Absent means the successor runs as a
   *  resident. This is the whole order handoff — no closures, just data. */
  pendingOrder?: Order;
  /** When the handoff slot was filled. A slot far older than any spawn
   * handoff means the spawn died with the order in hand; the reconcile sweep
   * hands it back to `staged` so the work is not silently lost while
   * `projectInFlight` reads the target as busy forever. */
  pendingOrderAt?: number;
  /** Resolves an idle agent's wait the instant work is staged. */
  wake?: () => void;
  wakePending?: boolean;
  completed?: number;
  failed?: number;
  lastError?: string;
  /** When this host was last planted, for the spread cooldown. */
  lastPlantAt?: number;
}

export type DnetHostEntries = Map<string, HostEntry>;

/** The controller, as everything else sees it. The whole inter-process surface
 * of the feature: agents adopt here, probers report here, home drains and
 * orders here. There is no other channel. */
export interface ControllerHandle {
  readonly protocol: number;
  readonly buildId: string;
  /** `<bitNode>:<lastAugReset>`. An agent from another world refuses to run. */
  readonly generation: string;
  readonly pid: number;
  readonly startedAt: number;
  lastBeatAt: number;
  /** The one map: hostname → everything known and running. Agents read their
   *  own entry here (their staged order, their wake latch); the controller
   *  owns every write. Keyed by hostname — the thing that has one agent and one
   *  RAM budget. */
  hosts: DnetHostEntries;
  /** Monotonic network generation, advanced once per nextMutation turn. */
  mutationEpoch: number;
  /** Coalesces every prober continuation from one mutation turn. */
  noteMutation(at: number): number;
  /** Wake the controller's derive race — a probe, an adopt, a home order. */
  wake(cause: string): void;
  /** An agent registers itself the instant it boots. A one-off sidecar
   * registers into the entry's `sidecar` slot instead of the agent slot. */
  adopt(host: string, handle: AgentHandle, sidecar?: boolean): void;
  /** Resolve after every named order has reported. Used by a prequeued bleed
   * to follow a whole parallel authentication wave without polling. */
  afterOrders(ids: readonly string[]): Promise<void>;
  /** Claim the one outstanding first-probe barrier for this host. `launch`
   * says whether the caller owns starting it; followers only await it. */
  beginProbeRefresh(host: string): { refresh: DnetProbeRefresh; launch: boolean };
  /** Cancel a refused launch and wake every follower with `false`. */
  cancelProbeRefresh(host: string, refresh: DnetProbeRefresh): void;
  /** A prober files its host's adjacency, its pid, and wakes the controller. */
  reportProbe(host: string, neighbours: readonly string[], at: number, pid: number, refresh?: DnetProbeRefresh): void;
  /** Plant calls this after the first probe and before launching the agent. */
  preparePlant(host: string): { controllerManaged: boolean; next?: Order; reuseProber: boolean };
  /** A bootstrap reclaimer registers and, on exit, reports itself done. */
  registerBootstrap(host: string, pid: number): void;
  bootstrapDone(host: string): void;
  /** The state a body needs that outlives its process, keyed by target. */
  deps: ControllerDeps;
  drain(): DnetDrain;
  order(orders: DnetOrders): void;
}

/** Controller-owned write-through state a body reaches through, so a killed
 * agent loses nothing. Everything here is keyed by hostname and lives with the
 * controller, never in the agent's process. */
export interface ControllerDeps {
  charisma(): number;
  timing(): DnetTimingProfile | undefined;
  expectedDelayMs(request: DnetDelayRequest): number | undefined;
  ledgerFor(host: string): DnetHost["attempts"];
  ringFor(host: string): DnetHost["ring"];
  recordAttempt(host: string, outcome: AttemptOutcome): void;
  recordLogDrain(host: string, outcome: LogDrainOutcome): void;
  recordCredential(entry: VaultEntry, from: string): void;
  recordLoose(password: string): void;
  recordProvisional(entry: import("../../shared/strategy/dnet/courier.ts").ProvisionalCredential): void;
  recordNeighbourPassword(source: string, password: string, at: number): void;
  recordFileEvidence(host: string, evidence: import("../../shared/strategy/dnet/evidence.ts").PasswordEvidence): void;
  labField(host: string): import("../../shared/strategy/dnet/maze.ts").LabField | undefined;
  publishLabField(host: string, field: import("../../shared/strategy/dnet/maze.ts").LabField): void;
}

export type DnetDelayedOperation =
  | "authenticate"
  | "heartbleed"
  | "memoryReallocation"
  | "phishingAttack"
  | "promoteStock"
  | "induceServerMigration"
  | "setStasisLink"
  | "labradar";

/** Data available at the delayed call boundary. The controller combines this
 * with its cached host/player state; callers never probe Netscript for timing. */
export interface DnetDelayRequest {
  operation: DnetDelayedOperation;
  host: string;
  from: string;
  threads: number;
  correctChars?: number;
  shouldLink?: boolean;
}

// --- the RAM cost table (replaces JOB_METHODS/priceAgent) ---------------------

const SPAWN = ["spawn"] as const;
const DETAILS = ["dnet.getServerDetails"] as const;

/** What each order kind's process actually calls, per kind.
 *
 * The contract between the controller — which SIZES the process — and the agent
 * switch (and `attempt.ts`/`walk.ts`), which make the calls. Getting one wrong
 * is a bug the simulator cannot catch (it does not model the dynamic-RAM check)
 * and the game expresses as the script dying on its first uncovered call.
 * `tests/ram-budget.test.ts` pins that the agent's per-arm surface matches. */
export const KIND_CALLS: Readonly<Record<OrderKind, readonly string[]>> = {
  // Resident mode: spawn, and nothing else.
  idle: [...SPAWN],
  // The TRANSIENT launcher the resident spawns through to start a linked
  // one-off sidecar: exec the sidecar, then chain onward into the main order
  // as any completing order does. It exists so `exec` is paid on a 1-thread
  // process for one hop rather than living on every resident (1.3 GB per
  // host, forever) or on a multi-thread order (1.3 GB PER THREAD).
  launchSidecar: [...SPAWN, "exec"],
  // The dedicated list job: one `ls` of the host it stands on.
  inventory: [...SPAWN, "dnsLookup", "ls", "read", "rm", ...DETAILS],
  bleed: [...SPAWN, "dnet.heartbleed", ...DETAILS],
  attempt: [...SPAWN, "dnet.authenticate", "dnet.heartbleed", ...DETAILS],
  // `asleep` (0 GB) is the replant grace: a refused exec right after an agent
  // handoff usually races the dead predecessor's not-yet-freed allocation.
  plant: [...SPAWN, "dnet.connectToSession", "dnet.authenticate", "scp", "exec", "kill", "dnsLookup", "asleep", ...DETAILS],
  reclaim: [...SPAWN, "dnet.memoryReallocation", ...DETAILS],
  // Spawn-free local recovery: base + one action per thread.
  bootstrapReclaim: ["dnet.memoryReallocation"],
  phish: [...SPAWN, "dnet.phishingAttack", ...DETAILS],
  cache: [...SPAWN, "dnet.openCache", "dnsLookup", "ls", "read", "rm", ...DETAILS],
  promote: [...SPAWN, "dnet.promoteStock", ...DETAILS],
  induce: [...SPAWN, "dnet.induceServerMigration", ...DETAILS],
  // NO spawn: 12 GB setStasisLink beside a 1.8 GB prober cannot afford it.
  pin: ["dnet.probe", "dnet.setStasisLink", ...DETAILS],
  // NO spawn: every byte goes to authenticate threads.
  walk: ["dnet.authenticate", "dnet.labradar"],
  // `listingOn` is the seed check, and it reads and deletes the data files it
  // walks past — the same `ls`/`read`/`rm` surface `inventory` and `cache` pay.
  storm: [...SPAWN, "dnet.unleashStormSeed", "ls", "read", "rm", ...DETAILS],
  relaunchProbe: [...SPAWN, "exec"],
};

/** The permanent prober's calls: probe (0.2) and nextMutation (0), full stop. */
export const PROBER_CALLS: readonly string[] = ["dnet.probe", "dnet.nextMutation"];

/** The controller's whole surface: the mutation clock is the probers', so the
 * controller only OBSERVES synchronously and retires pointless work. */
export const CONTROLLER_CALLS: readonly string[] = [
  "isRunning",
  "kill",
  "dnet.getServerDetails",
  "dnsLookup",
  "getServerMaxRam",
  "getServerUsedRam",
];

/** Price an allocation from the game's OWN table. `ns.getFunctionRamCost` is
 * 0 GB, so this is free — and the only way to keep these from drifting. */
export function costOf(ns: NS, kind: OrderKind): number {
  let total = SCRIPT_BASE_GB;
  for (const call of new Set(KIND_CALLS[kind])) total += ns.getFunctionRamCost(call);
  return total;
}

export function priceCalls(ns: NS, calls: readonly string[]): number {
  let total = SCRIPT_BASE_GB;
  for (const call of new Set(calls)) total += ns.getFunctionRamCost(call);
  return total;
}

/** The prober's exact allocation: base + its one billable call, no margin. */
export function proberReserveGb(ns: NS): number {
  return SCRIPT_BASE_GB + ns.getFunctionRamCost("dnet.probe");
}

/** Convert usable host RAM into the exact thread count the engine can admit.
 * `ramOverride` is charged once per thread, base and spawn-back included. */
export function threadsFor(roomGb: number, perThreadGb: number, scaled: boolean, requested = 1): number {
  if (!Number.isFinite(roomGb) || !Number.isFinite(perThreadGb) || roomGb <= 0 || perThreadGb <= 0) return 0;
  return scaled ? Math.floor(roomGb / perThreadGb) : requested;
}

/** Kinds whose process does NOT hand the host back to a resident: pin (no
 * spawn budget) and walk (spawn-free, PID-bound). Both end by leaving the host
 * empty for the spread planner to re-plant. */
export const NO_RESPAWN_KINDS: ReadonlySet<OrderKind> = new Set(["pin", "walk"]);

/** Kinds the controller's kill sweep must never hard-cancel: pin (never armored)
 * and walk (PID-bound, cooperatively cancelled). */
export const HARD_CANCEL_EXEMPT_KINDS: ReadonlySet<OrderKind> = new Set(["pin", "walk"]);

/** Kinds sized to FILL their host with threads. Everything else runs at what
 * the planner asked for. */
export const THREAD_SCALED_KINDS: ReadonlySet<OrderKind> = new Set([
  "attempt",
  "bleed",
  "reclaim",
  "phish",
  "promote",
  "walk",
]);

/** Whether the controller may `kill` this agent outright. Self-spawning agents
 * are armored; stasis-managed agents are recoverable by remote dispatch. */
export function hardCancelEligible(handle: AgentHandle): boolean {
  return (handle.armored === true || handle.order.controllerManaged === true)
    && handle.pid > 0
    && !HARD_CANCEL_EXEMPT_KINDS.has(handle.order.kind);
}

/** Exact dynamic surface for one recovery mode. */
export function orderCalls(kind: OrderKind, controllerManaged: boolean): readonly string[] {
  return controllerManaged ? KIND_CALLS[kind].filter((call) => call !== "spawn") : KIND_CALLS[kind];
}

/** Eligibility plus the one-pass cooperative grace. Keeping the request pass
 * on the handle makes it follow the exact process being cancelled. */
export function hardCancelReady(handle: AgentHandle, derivePass: number): boolean {
  return handle.cancelReason !== undefined
    && handle.cancelRequestedPass !== undefined
    && handle.cancelRequestedPass < derivePass
    && hardCancelEligible(handle);
}

// --- timing ------------------------------------------------------------------

/** How long an unsettled first-probe barrier stays believable. A launched
 * prober files its report within one engine turn of booting, so a barrier
 * this old means its launcher died between exec and settle — reclaim it and
 * launch fresh rather than awaiting a report nobody will file. */
export const PROBE_REFRESH_DEADLINE_MS = 30_000;

/** How long a filled `pendingOrder` handoff slot stays believable. A zero-delay
 * spawn adopts it within an engine turn; a slot this old has lost its spawn. */
export const PENDING_ORDER_GRACE_MS = 15_000;

/** Grace after the last known cooperative boundary. This is a stuck-call
 * recovery margin, not a strategic attempt or batch duration. */
export const JOB_WATCHDOG_GRACE_MS = 60_000;
export function jobWatchdogDeadline(handle: AgentHandle): number {
  return (handle.order.expectedDoneAt ?? handle.beatAt) + JOB_WATCHDOG_GRACE_MS;
}

export function jobWatchdogExpired(handle: AgentHandle, at: number): boolean {
  return at > jobWatchdogDeadline(handle);
}
export const RESIDENT_BEAT_MS = 5_000;
export const RESIDENT_BEAT_MISSES = 3;
/** The beat window a silent resident (or long order) is given before it is
 * presumed dead with its host. */
export const BEAT_WINDOW_MS = RESIDENT_BEAT_MS * RESIDENT_BEAT_MISSES;

// --- the realm accessor and the single-controller election -------------------

export interface DnetGlobals {
  dnet_controller?: ControllerHandle;
}

export type DnetGlobalThis = typeof globalThis & DnetGlobals;

export function dnetRealm(): DnetGlobalThis {
  return globalThis as DnetGlobalThis;
}

/** The controller an agent should be talking to RIGHT NOW, or nothing.
 *
 * Read fresh and never held across an `await`: an agent that bound the
 * controller at boot kept a reference to an object a replacement of the same
 * generation has already retired. Protocol and generation are checked here and
 * nothing else — the beat window belongs to the election below, which answers
 * the opposite question. */
export function live(generation?: string): ControllerHandle | undefined {
  const existing = dnetRealm().dnet_controller;
  if (!existing) return undefined;
  if (existing.protocol !== DNET_PROTOCOL) return undefined;
  if (generation !== undefined && existing.generation !== generation) return undefined;
  return existing;
}

/** Whether an existing controller should be left alone: same protocol, same
 * generation, and beating recently. A controller from another generation is not
 * "live" however recently it beat — it belongs to a world this one does not
 * share, and deferring to it would hand the net to a dead run. */
export function controllerIsLive(
  existing: ControllerHandle | undefined,
  generation: string,
  now: number,
): boolean {
  if (!existing) return false;
  if (existing.protocol !== DNET_PROTOCOL) return false;
  if (existing.generation !== generation) return false;
  return now - existing.lastBeatAt < BEAT_WINDOW_MS;
}

// --- wake latches (zero-RAM realm timers, no Netscript lock) ------------------

/** Wake an idle agent on this entry, or remember the wake if none is waiting. */
export function signalWake(entry: HostEntry): void {
  const wake = entry.wake;
  if (wake) wake();
  else entry.wakePending = true;
}

/** The idle agent's wait: resolve the instant work is signalled, else after
 * `fallbackMs` (which is also its heartbeat). Closes two races — a signal that
 * arrived before this arm (`wakePending`), and a stale timer from a killed
 * agent nulling out a newer one's handle (`entry.wake === finish`). */
export function waitForWake(entry: HostEntry, fallbackMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (entry.wakePending) {
      entry.wakePending = false;
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (entry.wake === finish) entry.wake = undefined;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, fallbackMs);
    entry.wake = finish;
  });
}

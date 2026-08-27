import type { NS } from "@ns";
import type { DnetProbeRefresh } from "./launch.ts";
import type { AttemptOutcome, LogDrainOutcome, ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import type { DnetHost } from "../../shared/strategy/dnet/host.ts";
import type { ProcessMode, TaskKind } from "../../shared/strategy/dnet/jobs.ts";
import type { DnetTimingProfile } from "../../shared/strategy/dnet/rates.ts";
import type { DnetInputs, DnetSnapshot } from "./wire.ts";
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
 * 3. **The controller owns knowledge.** Home receives immutable snapshots and
 *    may return the latest versioned recovery checkpoint to a replacement.
 * 4. **A credential never reaches telemetry.** It lives in the controller's
 *    private checkpoint; the published record carries a boolean. */

/** A version on the global SHAPE. It moves because agents outlive controllers
 * and a build handoff leaves both on disk: an agent from the previous build
 * reading a global whose shape moved under it is a bug with no symptom.
 * Refusing by number makes it exit instead. */
export const DNET_PROTOCOL = 12;

/** The script base every allocation starts from. Transcribed rather than read,
 * because a launcher sizes a process it has not started yet.
 * Source: src/Netscript/RamCostGenerator.ts RamCostConstants.Base */
export const SCRIPT_BASE_GB = 1.6;

// --- orders and reports: DATA, never closures --------------------------------

/** Every kind a PROCESS can be: the kinds of WORK, plus the two modes that
 * are not work at all. Only the price and call tables are keyed by this — an
 * `Order` is always real work, so it is keyed by `TaskKind`. */
export type OrderKind = TaskKind | ProcessMode;

/** One host on a plant's frontier, carrying everything its launch needs so the
 * body never reaches back into the controller for a per-target fact. */
export interface PlantJobTarget {
  host: string;
  password: string;
  /** The identity the credential was verified against, if we hold one. */
  identity?: string;
  /** Stasis-linked: boot the spawn-free managed resident and hand dispatch to
   *  the controller. Never inferred from `remote`. */
  controllerManaged?: boolean;
  /** Reached by REMOTE exec (a backdoor or stasis link) rather than across a
   *  believed edge. Every plant is session-only now — it holds the credential
   *  already and never authenticates — so this says only how the target was
   *  ROUTED: which decides whether losing the edge invalidates it, and whether
   *  a refused launch should discredit the backdoor we trusted. */
  remote?: boolean;
  /** Launch the minimal spawn-free self reclaimer, not prober+resident. */
  bootstrapReclaim?: boolean;
  bootstrapThreads?: number;
  /** The pinned lab candidate never shares RAM with a prober. */
  omitProber?: boolean;
}

/** What each kind of work needs, resolved by the CONTROLLER when it files the
 * order. A kind with no data of its own carries `{}`.
 *
 * These used to be sixteen optional fields on one `Order`, which meant every
 * one of them was readable on every kind: `order.filename` type-checked on a
 * `promote` and `order.symbol` on a `cache`, so the bodies opened with runtime
 * guards — "no cache filename; a job never invents one" — against states the
 * type should have made unrepresentable. Under `payload` a field exists only
 * on the kind that has it, and reaching it means narrowing on `kind` first. */
export interface OrderPayloads {
  inventory: Record<string, never>;
  bleed: {
    /** The log parser's attribution table: a leaked `host:password` line is
     *  trusted only when the name is one we have already seen. Absent, the
     *  bleeding host itself is the only name that can be attributed. */
    knownHosts?: readonly string[];
    /** A standalone bleed waits for these exact authentication orders, then
     *  drains the records they wrote. */
    followAttemptIds?: readonly string[];
  };
  attempt: {
    /** See `bleed`. */
    knownHosts?: readonly string[];
    /** An unattributed leaked password this attempt is spending. Resolved from
     *  the planner's opaque `guessId` back where credentials live. */
    guess?: string;
    /** A CONVERSATIONAL solve: the process needs `heartbleed` beside its
     *  `authenticate` and is priced for it. Absent (the common case) the order
     *  is lean and must never bleed — `attempt.ts` folds this into `canBleed`,
     *  which every drain is already gated on. */
    needsRing?: true;
    skipInitialBleed?: true;
  };
  plant: {
    /** The whole frontier this one order opens, launched concurrently.
     *  `Order.host` names `targets[0]` and nothing more — ask `hostsOf`. */
    targets: PlantJobTarget[];
    /** The artifacts to `scp` ahead of the launch: agent, then prober. */
    payloads: string[];
  };
  /** A job never invents a filename: `openCache` THROWS on a name the host does
   *  not hold, and a throw kills the agent rather than failing the job. */
  cache: { filename: string };
  reclaim: {
    /** Re-size to one more worker thread once the block has shrunk this far. */
    resizeAtBlockedRam?: number;
  };
  phish: Record<string, never>;
  promote: { symbol: string };
  induce: Record<string, never>;
  pin: {
    /** The neighbour the pin exists to keep. */
    edge?: string;
    /** Release the link instead of applying one. */
    unpin?: true;
  };
  walk: {
    /** The macro-route bias the walk body hands `routePrior` — set for a
     *  mortal scout, absent (unbiased) for the finisher. */
    route?: string;
    /** A MORTAL scout rather than the pinned finisher. The controller cannot
     *  tell the two apart from a live handle otherwise, and the difference
     *  decides who is stamped irreplaceable, who holds the storm, and whose
     *  absence re-plans a walk. */
    scout?: true;
  };
  storm: Record<string, never>;
  relaunchProbe: { proberFile: string };
}

/** What every order carries whatever its kind: identity, where it runs, how it
 * is sized, and how it sorts against everything else. */
export interface OrderBase {
  id: string;
  /** The TARGET the order acts on — not the host it runs on, which is `from`.
   *  The two are the same for most kinds; `induce` is the one call that REFUSES
   *  its own host, so there `host` is a neighbour and `from` is the vantage. */
  host: string;
  /** Where the order RUNS — the agent's own host, the vantage. */
  from: string;
  /** Allocation for the process that runs it, PER THREAD. */
  ramOverrideGb: number;
  threads: number;
  /** Lower is more urgent, carried from the derived `Task`. */
  priority: number;
  /** True for work that does not finish on its own — only the maze walk. */
  longLived: boolean;
  /** For the panel and the failure line. */
  label: string;
  /** The identity the target was believed to have when this was filed. A
   *  mismatch on arrival means the hostname was reused by another server. */
  targetIdentity?: string;
  /** When the running process started this order, stamped by the agent. */
  startedAt?: number;
  /** Current completion estimate, used only to choose the least-cost victim. */
  expectedDoneAt?: number;
  /** Run without spawn; the controller remotely restores this stasis host. */
  controllerManaged?: boolean;
}

/** One piece of work, as data. It lives in the realm rather than in `ns.args`
 * because it may carry a password, and `ns.args` is visible in the game's
 * script listing.
 *
 * Distributing over `K` is what ties `kind` and `payload` together: a plain
 * `{ kind: TaskKind; payload: ... }` would let any kind carry any payload.
 * Narrow on `kind` and the payload narrows with it. */
export type Order<K extends TaskKind = TaskKind> =
  { [P in K]: OrderBase & { kind: P; payload: OrderPayloads[P] } }[K];

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
  /** Since-last-report contribution; the controller folds it. */
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
  /** Set once this body no longer owns its host's slot — it has been
   *  ORPHANED. Bodies poll it at safe boundaries and stop there. */
  cancelled: () => string | undefined;
  /** Publish the release hook for the Darknet call this body is waiting on, so
   * the controller can let it go WITHOUT killing the process. Cleared as soon
   * as the call settles. */
  hold: (release: (() => void) | undefined) => void;
  /** Publish the engine call a RELEASED body walked away from. It is still
   *  running, and it still owns this script's single Netscript slot, so the
   *  exit path has to wait for it before it may touch `ns` again. */
  inFlight: (settling: Promise<unknown>) => void;
  deps: ControllerDeps;
}

/** One agent process, as the controller and the agent both see it.
 *
 * A body that must stop early publishes `release`: pulling that lets it fall
 * out of the Darknet call it is waiting on, finish, and run its own exit path
 * into the next job. No ns call at all, and no waiting for the engine to
 * return from work whose result we have already decided not to want. `done`
 * settles when the body finishes, is released, or atExit handles a genuine
 * kill. */
export interface AgentHandle {
  pid: number;
  order: Order;
  startedAt: number;
  /** Long-lived orders stamp this every iteration; the liveness authority. */
  beatAt: number;
  /** Whatever the last beat carried, for a long order worth watching live. */
  progress?: Record<string, unknown>;
  /** Let the body out of the Darknet call it is waiting on, right now.
   *  Published by `awaitDnetOperation` for exactly as long as one call is in
   *  flight. Calling it does not stop the engine's work — it stops US waiting
   *  for it, which is the only part that was costing anything. */
  release?: () => void;
  /** The engine call still running after a release. Bitburner allows ONE
   *  Netscript call per script at a time; until this settles, every `ns`
   *  member in this process throws CONCURRENCY ERROR — the exit path's
   *  `getScriptName`/`spawn` included, which is how a released body used to
   *  lose its host. Awaited before the exit path, never cancelled. */
  inFlight?: Promise<unknown>;
  /** Resolves the instant the order finishes or is cancelled. Idempotent. */
  done: Promise<Report>;
  settle: (report: Report) => void;
}

/** One host: everything we KNOW about it (the `DnetHost` fields) plus the
 * runtime state that hangs off it. The runtime fields are all optional, so a
 * plain `DnetHost` the fold creates is a valid entry — which is what lets
 * `foldReports` operate on this map directly. */
export interface HostEntry extends DnetHost {
  /** This host's prober `ns`, LENT to the controller.
   *
   * Every Bitburner script runs in one JS realm, so an `ns` is a live object
   * bound to its owning process: a call made through this one is billed to the
   * prober's `ramOverride`, not to the caller's. That is what lets the
   * controller reach the two calls that are host-BOUND — `dnet.probe` scans
   * from the calling host, and `exec` reaches only self and connected — without
   * a launcher process on every host paying for them per thread. The pattern is
   * not new: `lib/ns-resident.js` lends its own `ns` to the home-side
   * automation in exactly this way.
   *
   * PRESENCE IS THE CONTRACT. The prober publishes this and clears it in its
   * `atExit`, so a defined `ns` means "a live process on that host is holding
   * RAM for these calls". Never keep a copy: a call through a dead `ns` throws.
   *
   * The prober must hold no Netscript call of its own while lending, or
   * `env.runningFn` makes every borrowed call throw CONCURRENCY ERROR. It parks
   * on a plain unresolved Promise for exactly that reason — never `ns.asleep`,
   * which is itself a call. */
  ns?: NS;
  /** The permanent prober beside the agent. `pid: 0` marks a walk host whose
   *  prober was deliberately killed; `at` is the last report stamp (dead-prober
   *  detection compares it to the mutation clock). */
  prober?: { pid: number; at: number; neighbours: string[]; epoch: number };
  /** One exact prober launch is expected to publish a first report. Kept on
   * the host rather than as a launch callback so every caller observes the
   * same readiness barrier and an old prober cannot satisfy it. */
  probeRefresh?: DnetProbeRefresh;
  /** The prober process the barrier is waiting ON, once it has been exec'd.
   * Undefined means the launcher has not got there yet and still owns the
   * barrier. This replaced a deadline: "has the launcher died between exec and
   * settle" is a question about a process, and the engine answers it. */
  probeRefreshPid?: number;
  /** THE process on this host. `order.kind === "idle"` is resident mode. */
  agent?: AgentHandle;
  /** When a process was last started for this host but has not adopted yet.
   *
   * The gap is a plant between the prober's first report and the agent's
   * `exec`, and it is not an error state: a host with a process on its way
   * counts as standing.
   *
   * It used to matter far more, because a host BETWEEN orders also read as
   * agentless and fell out of `standing` — every route through it became
   * `no-route` and its queued work was retired as stranded. That is fixed at
   * the root now: `liveEntries` counts a host with a live lender, because the
   * prober's `exec` is all `dispatch` needs to put a process there.
   *
   * Cleared on adoption, on retirement, and — when the starter died — by the
   * engine saying the announced process is not there. Never by a clock. */
  inbound?: {
    /** When it was announced. DIAGNOSTIC ONLY — nothing decides on this. The
     * window used to expire after a fixed 3s, which is a guess standing in for
     * a question the engine can answer exactly. */
    at: number;
    /** WHICH launch announced it. The two paths fail for opposite reasons and
     * want opposite fixes: a `spawn` is announced by the dying agent and is
     * refused SILENTLY when the successor no longer fits, while a plant's
     * `exec` is announced by a live vantage and fails visibly unless its child
     * dies before its first line. A lost launch is only worth logging if the
     * log says which one it was. */
    via: "plant" | "plant-exec";
    /** The child, once there IS one. Undefined means the launcher has not
     * exec'd yet and still owns the window — it closes it itself, through
     * `abandonPlant` on refusal or by handing us a pid on success. Once set,
     * the window is decided by `isRunning`: a process that is there will adopt,
     * and one that is not is a ghost. No clock is involved either way. */
    pid?: number;
  };
  /** A spawn-free local reclaimer — not an agent, and must not be staged to. */
  bootstrap?: { pid: number; startedAt: number };
  /** Pending orders, kept priority-sorted; the agent consumes `staged[0]`. */
  staged?: Order[];
  /** The order the NEXT-spawned process should run. A resident (or a finishing
   *  order) sets this from `staged` just before its zero-delay `spawn`; the
   *  booting process reads and clears it. Absent means the successor runs as a
   *  resident. This is the whole order handoff — no closures, just data. */
  pendingOrder?: Order;
  completed?: number;
  failed?: number;
  lastError?: string;
}

export type DnetHostEntries = Map<string, HostEntry>;

/** The controller, as everything else sees it. The whole inter-process surface
 * of the feature: agents adopt here, probers report here, and home snapshots
 * and configures here. There is no other channel. */
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
  /** Resolve once the next derive pass has finished.
   *
   * What an exiting order awaits before choosing its successor. Publishing a
   * report and deriving its consequences are two microtask hops apart, so a
   * body that picked its successor synchronously after settling always looked
   * at the queue the controller had not filled yet: it spawned a resident, the
   * derive staged the real order a beat later, and the fresh resident spawned
   * AGAIN. Two spawns per order, and `[dnet:spin]` is that second one. */
  derived(): Promise<void>;
  /** An agent registers itself the instant it boots. */
  adopt(host: string, handle: AgentHandle): void;
  /** Name the process a launcher just started, so the placing window it opened
   * stops being an assertion and becomes a checkable fact. Called with the pid
   * `exec` returned; from here the window survives exactly as long as
   * `isRunning` says that process does. */
  announceLaunch(host: string, pid: number): void;
  /** Name the prober a plant just exec'd, so the first-probe barrier stops
   * being timed and starts being checked. */
  announceProbeRefresh(host: string, pid: number): void;
  /** A prober CHECKING IN: it hands the controller its own `ns` and then does
   * nothing for the rest of its life.
   *
   * The controller probes through it immediately — a freshly planted host must
   * appear on the map now, not at the next mutation, and the plant awaits that
   * first report before it execs the agent. `refresh` is the plant's barrier
   * token; passing it here is what settles that wait.
   *
   * The prober must hold no call of its own after this, or every borrowed call
   * throws CONCURRENCY ERROR. See `HostEntry.ns`. */
  lend(host: string, borrowed: NS, pid: number, refresh?: DnetProbeRefresh): void;
  /** Resolve after every named order has reported. Used by a prequeued bleed
   * to follow a whole parallel authentication wave without polling. */
  afterOrders(ids: readonly string[]): Promise<void>;
  /** Claim the one outstanding first-probe barrier for this host. `launch`
   * says whether the caller owns starting it; followers only await it. */
  beginProbeRefresh(host: string): Promise<{ refresh: DnetProbeRefresh; launch: boolean }>;
  /** Cancel a refused launch and wake every follower with `false`. */
  cancelProbeRefresh(host: string, refresh: DnetProbeRefresh): void;
  /** A prober files its host's adjacency, its pid, and wakes the controller. */
  reportProbe(host: string, neighbours: readonly string[], at: number, pid: number, refresh?: DnetProbeRefresh): void;
  /** Plant calls this before launching the prober: it settles how the agent
   * will be launched and opens the placing window. */
  preparePlant(host: string): { reuseProber: boolean };
  /** Plant calls this after the first probe and immediately before the agent
   * `exec`: it closes the placing window and hands back the order the derive
   * staged in it for the new process to adopt. The `exec` is sized from that
   * order by `processSizeFor`, exactly as the spawn chain sizes its own. */
  claimPlanted(host: string): Order | undefined;
  /** Close the placing window without launching anything. */
  abandonPlant(host: string): void;
  /** A bootstrap reclaimer registers and, on exit, reports itself done. */
  registerBootstrap(host: string, pid: number): void;
  bootstrapDone(host: string): void;
  /** The state a body needs that outlives its process, keyed by target. */
  deps: ControllerDeps;
  snapshot(at?: number): DnetSnapshot;
  configure(inputs: DnetInputs): void;
  standDown(): void;
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
  recordCredential(entry: VaultEntry): void;
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
  idle: [],
  // The dedicated list job: one `ls` of the host it stands on.
  inventory: ["dnsLookup", "ls", "read", "rm", ...DETAILS],
  bleed: ["dnet.heartbleed", ...DETAILS],
  // ONE CALL. `attempt` is thread-scaled and threads are the only thing that
  // shortens an `authenticate`, so anything else declared here is charged on
  // every thread to do something that happens once. `connectToSession` moved
  // to the controller (instant, needs no threads, and a success means this job
  // never runs); the host's facts come from the controller's map through the
  // realm, for nothing. `heartbleed` is here only for a CONVERSATIONAL solve —
  // see `ATTEMPT_LEAN_GB`.
  attempt: ["dnet.authenticate", "dnet.heartbleed"],
  // No `dnet.authenticate` (0.4 GB): a plant holds the credential already, so
  // `connectToSession` is its only way in — falling back to the expensive call
  // spent seconds re-doing work that had just succeeded, and cracking belongs
  // to `attempt`. No `asleep` either: its retry yields a microtask now.
  plant: ["dnet.connectToSession", "scp", "exec", "kill", "dnsLookup", ...DETAILS],
  reclaim: ["dnet.memoryReallocation", ...DETAILS],
  // Spawn-free local recovery: base + one action per thread.
  bootstrapReclaim: ["dnet.memoryReallocation"],
  phish: ["dnet.phishingAttack", ...DETAILS],
  cache: ["dnet.openCache", "dnsLookup", "ls", "read", "rm", ...DETAILS],
  promote: ["dnet.promoteStock", ...DETAILS],
  induce: ["dnet.induceServerMigration", ...DETAILS],
  // NO spawn: 12 GB setStasisLink beside a 1.8 GB prober cannot afford it.
  pin: ["dnet.probe", "dnet.setStasisLink", ...DETAILS],
  // NO spawn: every byte goes to authenticate threads.
  walk: ["dnet.authenticate", "dnet.labradar"],
  // `listingOn` is the seed check, and it reads and deletes the data files it
  // walks past — the same `ls`/`read`/`rm` surface `inventory` and `cache` pay.
  storm: ["dnet.unleashStormSeed", "ls", "read", "rm", ...DETAILS],
  relaunchProbe: ["exec"],
};

/** The permanent prober's calls, and ONLY the two that are host-BOUND.
 *
 * `dnet.probe` scans from the calling host and `exec` reaches only self and
 * connected: neither can be made from anywhere else, which is the entire reason
 * a process stands on every host. Everything else the controller needs is
 * global — `kill` by pid, `getServerDetails`, `dnsLookup`, `getServerMaxRam` —
 * so it is dodged for the length of one batch instead of being reserved here
 * forever.
 *
 * The prober LENDS this surface (`HostEntry.ns`) rather than using it: the
 * controller decides, the prober's allocation pays. */
export const PROBER_CALLS: readonly string[] = ["dnet.probe", "exec", "dnet.connectToSession"];

/** The controller's whole surface: the mutation clock, and nothing else.
 *
 * It is the one process in the darknet that BLOCKS — `dnet.nextMutation` costs
 * no RAM and parks its slot indefinitely — so it may own no other call. While
 * parked, `env.runningFn` would make any second call throw. Everything it does
 * to a host it does through a borrowed prober `ns` (host-bound work) or a dodge
 * launched with one (global work), and both are other scripts' slots. */
export const CONTROLLER_CALLS: readonly string[] = ["dnet.nextMutation"];

/** What every kind of process costs, as NUMBERS.
 *
 * None of this can change at runtime: a kind's dynamic surface is fixed in
 * `KIND_CALLS` and `getFunctionRamCost` answers from the game's own constant
 * table. So it is written down rather than rediscovered — a plant used to
 * re-price three surfaces of ~15 members every time it ran, dozens of engine
 * round trips for numbers settled at build time, on the one job the whole
 * spread waits behind.
 *
 * Written as literals rather than computed at boot for a second reason: this
 * is the RAM budget of the whole feature on one screen. Anyone — or anything —
 * reasoning about what the darknet can afford reads it here instead of
 * simulating the pricing. `tests/ram-budget.test.ts` pins every entry against
 * `getFunctionRamCost`, so a game update or a changed `KIND_CALLS` fails the
 * build rather than silently mis-sizing a launch.
 *
 * `spawning` keeps its own `spawn` chain (2.0 GB of it); `managed` is the
 * spawn-free price a controller-dispatched process pays. `pin` and `walk` are
 * identical in both because neither ever spawns. */
export const ORDER_PRICES: Readonly<Record<OrderKind, number>> = {
  attempt: 2.6,
  bleed: 2.3,
  bootstrapReclaim: 2.6,
  cache: 4.55,
  idle: 1.6,
  induce: 5.7,
  inventory: 2.55,
  phish: 3.7,
  pin: 13.9,
  plant: 4.2,
  promote: 3.7,
  reclaim: 2.7,
  relaunchProbe: 2.9,
  storm: 2.6,
  walk: 2,
};

/** The permanent prober on every host, and the host's WHOLE standing cost —
 * there is no resident beside it any more:
 *
 *     1.6 base + 1.3 exec + 0.2 dnet.probe + 0.05 dnet.connectToSession = 3.15
 *                              (was: prober 1.8 + idle resident 3.6 = 5.4)
 *
 * ONLY the host-bound calls. `dnet.probe` scans from the calling host and
 * `exec` reaches only self and connected, so neither can come from anywhere
 * else; `connectToSession` is what makes an `exec` aimed at a neighbour legal.
 * Every global call the controller makes — `getServerDetails`, `dnsLookup`,
 * `getServerMaxRam`, `kill` — goes through the run shared ns resident (`nsp`)
 * instead, because a lender is charged the union of everything ever called
 * through it and those would otherwise be paid by every host in the net, for
 * ever. */
export const PROBER_GB = 3.15;

/** A STASIS-linked host's prober, without `exec`.
 *
 * `exec` is on the prober so a host can be relaunched locally after its
 * processes die. A stasis host cannot lose them: the engine's own mutation
 * guard is `openServer || isConnectedTo || hasStasisLink`, so neither the
 * restart nor the delete path will ever touch it. It is also remotely
 * exec-able for exactly as long as the link holds, so the controller can
 * always reach it from a neighbour. Paying 1.3 GB for a recovery that cannot
 * be needed is the definition of a reserve that should not exist. */
export const PROBER_STASIS_GB = 1.85;
/** The stasis prober's surface: no `exec`, for the reason above. */
export const PROBER_STASIS_CALLS: readonly string[] = ["dnet.probe", "dnet.connectToSession"];
/** The controller's own reserve on darkweb: base + a free mutation clock. */
export const CONTROLLER_GB = 1.6;

/** `attempt` WITHOUT the ring reader: `heartbleed`'s 0.6 removed.
 *
 * One script runs one Netscript call at a time, so an attempt cannot bleed
 * while it authenticates — and `attempt` is thread-scaled, so declaring both
 * charged 0.6 GB on EVERY thread for a call most attempts never make. Threads
 * are the only thing that shortens `authenticate`, so that waste came straight
 * out of the speed of the crack.
 *
 * Only a CONVERSATIONAL solve needs the two in one process: `authenticate`
 * returns a generic failure and the model's real answer goes to the target's
 * log ring, which only `heartbleed` reads back, and splitting that across jobs
 * races the 200-line ring. A one-shot candidate or a known password has no
 * response to read — its ring is drained by an ordinary `bleed`, on a second
 * vantage or on this agent's next spawn. */
export const ATTEMPT_LEAN_GB = 2.0;

/** One kind's price. There is only one now.
 *
 * There used to be two — `spawning` and `managed` — differing by exactly the
 * 2.0 GB of `spawn`, because a worker that had to become the next order carried
 * its own launcher and a controller-dispatched one did not. Every worker is
 * dispatched now, so every kind pays the cheaper of the two and the distinction
 * has nothing left to describe.
 *
 * `needsRing` applies to `attempt` alone: false is the lean price, and it is
 * the common case. */
export function priceOf(kind: OrderKind, needsRing = true): number {
  return kind === "attempt" && !needsRing ? ATTEMPT_LEAN_GB : ORDER_PRICES[kind];
}

/** The prober's exact allocation: base + its one billable call, no margin. */
/** Convert usable host RAM into the exact thread count the engine can admit.
 * `ramOverride` is charged once per thread, base and spawn-back included. */
export function threadsFor(roomGb: number, perThreadGb: number, scaled: boolean, requested = 1): number {
  if (!Number.isFinite(roomGb) || !Number.isFinite(perThreadGb) || roomGb <= 0 || perThreadGb <= 0) return 0;
  return scaled ? Math.floor(roomGb / perThreadGb) : requested;
}

/** Every host an order acts on.
 *
 * `Order.host` is the generic identity every order carries, and for a PLANT it
 * names only `targets[0]` — the frontier is the job. Every place that asked
 * "does this order concern host X" by reading `o.host` was therefore right for
 * one target and silently wrong for the rest: the in-flight overlay left
 * siblings free to be re-derived onto a second vantage, the plant cooldown
 * protected one host out of five, and a single gone target retired a healthy
 * frontier. They were one defect wearing several hats.
 *
 * Ask through here. A reader that wants the identity alone still says
 * `order.host` and means it. */
export function hostsOf(order: Order): readonly string[] {
  if (order.kind !== "plant") return [order.host];
  return order.payload.targets.map((target) => target.host);
}

/** Take the next order off a host's queue — the one answer both hand-off paths
 * use.
 *
 * `spawn` and `exec` do the same three things: decide the job, start a process
 * sized for it, have that process adopt it. They differ in exactly one, and it
 * is a sizing detail the ORDER already carries: a spawn-chained process pays
 * 2 GB for `spawn` where a controller `exec` does not, which
 * `orderCalls(kind, controllerManaged)` priced into `ramOverrideGb` when the
 * order was filed. Everything before that is common.
 *
 * It was not common, and the two copies drifted. The `exec` side learned to
 * refuse orders the `spawn` side accepted, and a MANAGED host — the one host
 * with no spawn to fall back on — was left booting a resident that could not
 * reach its own queue, clearing itself, and being replanted into the same dead
 * end forever.
 *
 * `accepts` is the only knob and it is about REACHABILITY, never sizing: which
 * orders this particular hand-off is able to deliver. */
/** How to size the process that will run `order` — or a bare resident when
 * there is none.
 *
 * The second half of the shared hand-off, beside `takeNextOrder`. `spawn` and
 * `exec` both decide a job, start a process sized for it, and let that process
 * adopt it; the ONE thing that differs is that a spawn-chained process must
 * pay 2 GB for `spawn` and an exec'd one must not — and that is already priced
 * into the order's own `ramOverrideGb` by `orderCalls(kind, controllerManaged)`
 * when the order was filed. So there is nothing left for the two paths to
 * disagree about, and this is where they stop being able to. */
export function processSizeFor(
  order: Order | undefined,
  residentGb: number,
): { threads: number; ramOverride: number } {
  return order === undefined
    ? { threads: 1, ramOverride: residentGb }
    : { threads: order.threads, ramOverride: order.ramOverrideGb };
}

export function takeNextOrder(
  entry: HostEntry,
  accepts: (order: Order) => boolean = () => true,
): Order | undefined {
  const staged = entry.staged ??= [];
  const at = staged.findIndex((order) => accepts(order));
  return at < 0 ? undefined : staged.splice(at, 1)[0];
}

/** Exact dynamic surface for one recovery mode. */
export function orderCalls(kind: OrderKind): readonly string[] {
  return KIND_CALLS[kind];
}

// --- timing ------------------------------------------------------------------

/** Grace after the last known cooperative boundary. This is a stuck-call
 * recovery margin, not a strategic attempt or batch duration. */
export const JOB_WATCHDOG_GRACE_MS = 60_000;
export function jobWatchdogExpired(handle: AgentHandle, at: number): boolean {
  return at > (handle.order.expectedDoneAt ?? handle.beatAt) + JOB_WATCHDOG_GRACE_MS;
}
/** How long a CONTROLLER may go quiet before an election stops deferring to
 * it: three missed five-second beats. The only thing this window measures —
 * it was named for a resident's beat, back when a resident had one. */
const CONTROLLER_BEAT_WINDOW_MS = 15_000;

// --- the realm accessor and the single-controller election -------------------

export interface DnetGlobals {
  dnet_controller?: ControllerHandle;
}

export type DnetGlobalThis = typeof globalThis & DnetGlobals;

export function dnetRealm(): DnetGlobalThis {
  return globalThis as DnetGlobalThis;
}

/** What the controller already knows about a host — read straight out of the
 * realm, for nothing.
 *
 * Every script shares one JS realm, so the controller's host map IS reachable
 * by every worker: no ns call, no RAM, no report round-trip. A body that
 * re-read `dnet.getServerDetails` was paying 0.1 GB on EVERY THREAD to learn
 * what the map beside it already held, and on a thread-scaled kind that came
 * straight out of the thread count — which is the only thing that makes the
 * job faster.
 *
 * Facts, not permission: the record is folded from observations the controller
 * made and may be stale in the ways `dirty` describes. A body that needs to
 * know something is true RIGHT NOW asks the engine by making its own call and
 * reading the result code, which it was going to do anyway. */
export function knownHost(host: string): DnetHost | undefined {
  return live()?.hosts.get(host);
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
  return now - existing.lastBeatAt < CONTROLLER_BEAT_WINDOW_MS;
}


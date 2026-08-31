import type { NS } from "@ns";
import type { DnetProbeRefresh } from "./launch.ts";
import type { AttemptOutcome, LogDrainOutcome, ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import type { DnetHost } from "../../shared/strategy/dnet/host.ts";
import type { TaskKind } from "../../shared/strategy/dnet/jobs.ts";
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
 * - Each darknet host holds at most one **agent** process. The controller
 *   launches it for one exact order; it reports and exits when that order ends.
 * - A permanent **prober** sits beside the agent on every planted host because
 *   `probe()` is host-local: 3.15 GB ordinarily, 1.8 GB when stasis-linked, or
 *   5.15 GB with restart armour. The controller re-execs ordinary losses;
 *   armour alone carries its delayed self-revival.
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

/** Version the shared controller/agent data shape. A mismatched participant
 * exits instead of reading a global whose layout it does not understand. */
export const DNET_PROTOCOL = 13;

/** The script base every allocation starts from. Transcribed rather than read,
 * because a launcher sizes a process it has not started yet.
 * Source: src/Netscript/RamCostGenerator.ts RamCostConstants.Base */
export const SCRIPT_BASE_GB = 1.6;

// --- orders and reports: DATA, never closures --------------------------------

/** Every priced agent action: queued tasks plus the private bootstrap call.
 * An `Order` is always queued work and is keyed by `TaskKind`. */
export type OrderKind = TaskKind | "bootstrapReclaim";

/** One host on a plant's frontier, carrying everything its launch needs so the
 * body never reaches back into the controller for a per-target fact. */
export interface PlantJobTarget {
  host: string;
  password: string;
  /** The identity the credential was verified against, if we hold one. */
  identity?: string;
  /** Stasis-linked: launch later jobs through the controller. Never inferred
   *  from `remote`. */
  controllerManaged?: boolean;
  /** Reached by REMOTE exec (a backdoor or stasis link) rather than across a
   *  believed edge. Every plant is session-only now — it holds the credential
   *  already and never authenticates — so this says only how the target was
   *  ROUTED: which decides whether losing the edge invalidates it, and whether
   *  a refused launch should discredit the backdoor we trusted. */
  remote?: boolean;
  /** Launch the minimal self reclaimer without a prober or normal agent. */
  bootstrapReclaim?: boolean;
  bootstrapThreads?: number;
  /** The pinned lab candidate never shares RAM with a prober. */
  omitProber?: boolean;
}

/** Per-kind order data resolved by the controller. A kind with no data carries
 * `{}`; payload fields become accessible only after narrowing on `kind`. */
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
  walk: Record<string, never>;
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
  /** Launch through the controller's shared proxy on a stasis host. */
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
  grammar?: { unrecognised: number; lines: string[] };
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
  /** The engine call still running after a release. Await it before any exit
   *  Netscript call because Bitburner permits one call per script at a time. */
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
  prober?: { pid: number; at: number; neighbours: string[]; epoch: number; armoured?: boolean };
  /** The prober pid the controller has DELIBERATELY killed.
   *
   * An armoured prober respawns itself out of `atExit`, and `atExit` cannot
   * tell a host restart from a kill we ordered — the engine runs it for both.
   * Without this mark every replacement, every walk displacement and every
   * resize would respawn the process it just retired, which is a respawn loop
   * rather than a recovery.
   *
   * This is the remote-killer twin of the agent's local `deliberate` flag: the
   * agent knows why it is exiting because it is the one exiting, while a prober
   * is killed from outside and has to be TOLD. Set it before `kill`, never
   * after — the handler runs inside the killer's own stack. */
  proberKillMark?: number;
  /** An armoured prober has scheduled its own replacement and is on its way
   * out. The successor is a macrotask away, so for that gap the host has no
   * lender and no process, and every repair path would otherwise read it as an
   * empty host and launch a duplicate.
   *
   * `withdraw` releases the launch descriptor the dying prober published; it
   * MUST be called if the successor never arrives, or the descriptor sits in
   * the realm map for the rest of the run. */
  proberRespawn?: { at: number; launchId: number; withdraw: () => void };
  /** When a prober RESIZE was last exec'd here. An `exec` that returns a pid
   *  only proves the process was admitted, so without this a replacement that
   *  died before lending would be re-launched on every dispatch, for ever. */
  proberResizeAt?: number;
  /** When this host last had an armour respawn ADMITTED. Rate-limits the hook
   *  so a missed kill-mark degrades to a slow leak rather than a 1 ms respawn
   *  loop that freezes the game. */
  proberRespawnAt?: number;
  /** One exact prober launch is expected to publish a first report. Kept on
   * the host rather than as a launch callback so every caller observes the
   * same readiness barrier and an old prober cannot satisfy it. */
  probeRefresh?: DnetProbeRefresh;
  /** The prober process the barrier is waiting ON, once it has been exec'd.
   * Undefined means the launcher has not got there yet and still owns the
   * barrier. This replaced a deadline: "has the launcher died between exec and
   * settle" is a question about a process, and the engine answers it. */
  probeRefreshPid?: number;
  /** The one order process currently running on this host. */
  agent?: AgentHandle;
  /** A process has been launched for this host but has not adopted yet. It
   * counts as standing and clears on adoption, retirement, or confirmed death. */
  inbound?: {
    /** Announcement time for diagnostics only; no decision uses it. */
    at: number;
    /** WHICH launch announced it: the initial plant or a later controller
     * dispatch. A lost launch is only useful diagnostically when its source is
     * preserved. */
    via: "plant" | "plant-exec";
    /** The child, once there IS one. Undefined means the launcher has not
     * exec'd yet and still owns the window — it closes it itself, through
     * `abandonPlant` on refusal or by handing us a pid on success. Once set,
     * the window is decided by `isRunning`: a process that is there will adopt,
     * and one that is not is a ghost. No clock is involved either way. */
    pid?: number;
  };
  /** A controller-directed retirement recently released one or more process
   * allocations on this host. `preparePlant` uses this fact independently of
   * whether a prober survived: `retireVantage` clears both handles before the
   * engine necessarily makes their RAM available to the replacement exec. */
  retiredAllocationAt?: number;
  /** A spawn-free local reclaimer — not an agent, and must not be staged to. */
  bootstrap?: { pid: number; startedAt: number };
  /** Pending orders, kept priority-sorted; the next agent consumes one. */
  staged?: Order[];
  /** The order reserved for a process that has been launched but not adopted.
   *  This is the whole handoff: data rather than a cross-process closure. */
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
   *  own entry here; the controller owns every write. */
  hosts: DnetHostEntries;
  /** Monotonic network generation, advanced once per nextMutation turn. */
  mutationEpoch: number;
  /** Coalesces every prober continuation from one mutation turn. */
  noteMutation(at: number): number;
  /** Wake the controller's derive race — a probe, an adopt, a home order. */
  wake(cause: string): void;
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
  lend(host: string, borrowed: NS, pid: number, refresh?: DnetProbeRefresh, armoured?: boolean): void;
  /** An ARMOURED prober is dying and has scheduled its own replacement.
   *
   * Called from the dying prober's `atExit`, before the `spawn` that both
   * schedules the successor and kills the caller. It opens the window every
   * repair path checks, so nothing execs a duplicate into the gap between the
   * kill and the macrotask that lands the successor.
   *
   * Returns false when the controller refuses the respawn — the pid was marked
   * for a deliberate kill — in which case the caller must NOT spawn. */
  announceProberRespawn(host: string, pid: number, launchId: number, withdraw: () => void): boolean;
  /** Mark a prober pid as deliberately killed, so its armour stands down.
   *
   * MUST be called before the `kill`: the handler runs synchronously inside the
   * killer's stack, so a mark set afterwards is set too late. */
  markProberKill(host: string, pid: number): void;
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
  preparePlant(host: string): { reuseProber: boolean; retiringAllocation: boolean };
  /** Plant calls this after the first probe and immediately before the agent
   * `exec`: it closes the placing window and hands back the order the derive
   * staged in it for the new process to adopt. The `exec` is sized from that
   * order by `processSizeFor`. */
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
  // to `attempt`. A zero-RAM realm timer provides the grace between two
  // genuinely refused execs; a microtask does not give the browser a turn to
  // finish retiring the allocation the launch is replacing.
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

/** A refused darknet exec can be observing the allocation its predecessor is
 * still retiring. One browser turn is required before retrying; 300 ms spans
 * the game's ordinary 200 ms cycle without making a healthy launch wait. */
export const REFUSED_EXEC_RETRY_MS = 300;

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

/** The prober's ARMOURED surface: the host-bound calls, plus the one call that
 * can outlive a host restart.
 *
 * `restartServer` kills through `killServerScripts`, which drives ONE live
 * iterator across the host's running-script map and runs each `atExit`
 * synchronously inside that loop. Anything a handler starts on this host —
 * `exec`, `run`, or a zero-delay `spawn` — is appended to the very map being
 * walked and is killed again by the same sweep. `exec` therefore cannot defend
 * the host it stands on; it can only ever rebuild a NEIGHBOUR.
 *
 * `spawn` with a non-zero delay is the one exit. Upstream registers the
 * `setTimeout` BEFORE it kills the caller and never cancels it, so the
 * replacement lands as a macrotask — after the whole restart transaction,
 * including the guaranteed replacement edge. One millisecond is enough; the
 * number does not matter, only that it is not zero.
 *
 * This is why the surface is on the PROBER and never on the agent. An agent is
 * thread-scaled and `ramOverride` is charged per thread, so 2 GB there is 2 GB
 * times every thread an `authenticate` wanted. The prober is always one. */
export const PROBER_ARMOURED_CALLS: readonly string[] = [...PROBER_CALLS, "spawn"];

/** The controller's whole surface: the mutation clock, and nothing else.
 *
 * It is the one process in the darknet that BLOCKS — `dnet.nextMutation` costs
 * no RAM and parks its slot indefinitely — so it may own no other call. While
 * parked, `env.runningFn` would make any second call throw. Everything it does
 * to a host it does through a borrowed prober `ns` (host-bound work) or a dodge
 * launched with one (global work), and both are other scripts' slots. */
export const CONTROLLER_CALLS: readonly string[] = ["dnet.nextMutation"];

/** Fixed per-kind RAM prices. `tests/ram-budget.test.ts` checks each literal
 * against `KIND_CALLS` and the game's `getFunctionRamCost` table. */
export const ORDER_PRICES: Readonly<Record<OrderKind, number>> = {
  attempt: 2.6,
  bleed: 2.3,
  bootstrapReclaim: 2.6,
  cache: 4.55,
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

/** The armoured prober: `PROBER_GB` plus `spawn`.
 *
 *     3.15 + 2.0 spawn = 5.15
 *
 * The 2 GB buys immunity from `restartServer` for the one process the host
 * cannot rebuild from the outside. It is NOT worth paying everywhere — the
 * spread lane measured stranded capacity at 10.3% of what a blanket fleet
 * reserve would cost (`spec/dnet.md`) — so `planArmour` spends it on the hosts
 * whose hazard or value justifies it, and on the whole fleet for the seconds
 * around a storm we are about to fire ourselves. */
export const PROBER_ARMOURED_GB = 5.15;

/** A STASIS-linked host's topology-only prober.
 *
 * `exec` is on the prober so a host can be relaunched locally after its
 * processes die. A stasis host cannot lose them: the engine's own mutation
 * guard is `openServer || isConnectedTo || hasStasisLink`, so neither the
 * restart nor the delete path will ever touch it. It is also remotely
 * exec-able for exactly as long as the link holds, so the controller can
 * always reach it through the shared ns proxy. Paying for either `exec` or
 * `connectToSession` here would reserve a launch path the controller no longer
 * uses; the atomic proxy lease owns both calls instead. */
export const PROBER_STASIS_GB = 1.8;
/** The stasis prober's exact surface: observe topology and nothing else. */
export const PROBER_STASIS_CALLS: readonly string[] = ["dnet.probe"];
/** The controller's own reserve on darkweb: base + a free mutation clock. */
export const CONTROLLER_GB = 1.6;

/** `attempt` without `heartbleed`. One script cannot bleed while it
 * authenticates, and avoiding the unused surface leaves more authentication
 * threads.
 *
 * Only a CONVERSATIONAL solve needs the two in one process: `authenticate`
 * returns a generic failure and the model's real answer goes to the target's
 * log ring, which only `heartbleed` reads back, and splitting that across jobs
 * races the 200-line ring. A one-shot candidate or a known password has no
 * response to read — its ring is drained by an ordinary `bleed`, on a second
 * vantage or in a later agent. */
export const ATTEMPT_LEAN_GB = 2.0;

/** One kind's price. `needsRing` selects the full or lean attempt surface. */
export function priceOf(kind: OrderKind, needsRing = true): number {
  return kind === "attempt" && !needsRing ? ATTEMPT_LEAN_GB : ORDER_PRICES[kind];
}

/** Convert usable host RAM into the exact thread count the engine can admit. */
export function threadsFor(roomGb: number, perThreadGb: number, scaled: boolean, requested = 1): number {
  if (!Number.isFinite(roomGb) || !Number.isFinite(perThreadGb) || roomGb <= 0 || perThreadGb <= 0) return 0;
  return scaled ? Math.floor(roomGb / perThreadGb) : requested;
}

/** Every host an order acts on. A plant acts on its full target frontier;
 * other orders act only on `order.host`. */
export function hostsOf(order: Order): readonly string[] {
  if (order.kind !== "plant") return [order.host];
  return order.payload.targets.map((target) => target.host);
}

/** Size the process that will run `order`, or a bare base process when there
 * is no immediate order. */
export function processSizeFor(
  order: Order | undefined,
  fallbackGb: number,
): { threads: number; ramOverride: number } {
  return order === undefined
    ? { threads: 1, ramOverride: fallbackGb }
    : { threads: order.threads, ramOverride: order.ramOverrideGb };
}

/** Take the first order this launch path can deliver from a host's queue. */
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


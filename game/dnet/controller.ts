import type { NS } from "@ns";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import {
  conclusiveAttempt,
  LOCAL_CODE,
  type AttemptOutcome,
  type LogDrainOutcome,
  type ProvisionalCredential,
  type ReportHost,
  type VaultEntry,
} from "../../shared/strategy/dnet/courier.ts";
import { captureLaunch, offerLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch, DnetControllerLaunch } from "./launch.ts";
import type { DnetProbeRefresh, DnetProbeReport } from "./launch.ts";
import {
  coverage,
  foldLogDrain,
  foldAttempts,
  foldReports,
  fresh,
  markCredentialKnown,
  planningView,
  stormWipe,
  type DnetHost,
  type DnetHosts,
  type ExpiryOpts,
} from "../../shared/strategy/dnet/host.ts";
import {
  DEFAULT_SPREAD_LIMITS,
  candidatesFrom,
  classifyPlantRoute,
  deriveTasks,
  planSpread,
  planStorm,
  type Refusal,
  type SpreadCandidate,
  type StormContext,
  type Task,
  type TaskKind,
} from "../../shared/strategy/dnet/plan.ts";
import { choosePreemptionVantage, compareQueuedDnetWork, type PreemptionCandidate } from "../../shared/strategy/dnet/priority.ts";
import { JOBS, TASK_KINDS, canPreempt, isSameTurn, priorityOf } from "../../shared/strategy/dnet/jobs.ts";
import { planFarm, type FarmEconomics, type FarmHost, type FarmKind, type PromoteSymbol } from "../../shared/strategy/dnet/farm.ts";
import { holdHostFrom, planHold as planHoldFromView, type HoldHost, type HoldTask } from "../../shared/strategy/dnet/hold.ts";
import { modelEntry } from "../../shared/strategy/dnet/models.ts";
import { looseCandidates, type LooseTarget } from "../../shared/strategy/dnet/oracle.ts";
import type { PasswordEvidence } from "../../shared/strategy/dnet/evidence.ts";
import { exactNeighbourClueEpoch } from "../../shared/strategy/dnet/file-clues.ts";
import {
  DEFAULT_NET_DEPTH,
  STORM_BURST_MS,
  STORM_COOLDOWN_MS,
  STORM_QUIET_MS,
  INDUCE_WAIT_MS,
  authenticateWaitMs,
  heartbleedWaitMs,
  knownDnetRefusalWaitMs,
  isLabyrinth,
  labStage,
  msPerHostEvent,
  msPerHostEventAny,
  phishWaitMs,
  promoteWaitMs,
  reclaimWaitMs,
  stasisWaitMs,
  type DnetTimingProfile,
} from "../../shared/strategy/dnet/rates.ts";
import {
  emptyField,
  labPrior,
  liveExitCandidates,
  mergeLabFields,
  renderLabField,
  type LabField,
} from "../../shared/strategy/dnet/maze.ts";
import {
  CONTROLLER_CALLS,
  DNET_PROTOCOL,
  KIND_CALLS,
  controllerIsLive,
  dnetRealm,
  hostsOf,
  jobWatchdogExpired,
  orderCalls,
  priceOf,
  PROBER_GB,
  PROBER_STASIS_GB,
  CONTROLLER_GB,
  liveHands,
  takeNextOrder,
  threadsFor,
  type ControllerDeps,
  type ControllerHandle,
  type DnetDelayRequest,
  type HostEntry,
  type Order,
  type OrderPayloads,
  type Report,
} from "./shared.ts";
import {
  DNET_RECOVERY_VERSION,
  foldRefusals,
  type DnetRamSnapshot,
  type DnetRecoveryState,
  type DnetSnapshot,
  type DnetSpreadReport,
  type DnetFarmReport,
  type DnetHoldReport,
  type DnetStormReport,
  type DnetLabReport,
  type DnetLabWalker,
} from "./wire.ts";
import { initTelemetry } from "../lib/telemetry.ts";
import { realmSleep } from "../lib/wake.ts";
import { preemptionCandidateFromHandle } from "./priority.ts";
import { emptyDnetProfit, mergeDnetProfit } from "./profit.ts";

/** The darknet controller: one long-lived script that decides, and never acts.
 * Its shape follows the spec: one `hosts` map holding
 * both what we KNOW about each host and the process RUNNING on it. It stages
 * ORDERS as data; the agent runs them through a `switch` of direct calls. It
 * learns of completion the instant each agent's `done` promise settles, and it
 * requests cooperative cancellation and hard-kills a body that remains inside
 * a blocking call. It OBSERVES only through synchronous reads and never
 * BLOCKS. */

const BEAT_INTERVAL_MS = 15_000;
const STAND_DOWN_POLL_MS = 250;
/** What one queued order is worth in time when nothing better is known. Only
 * ever used to COMPARE loaded vantages, so its absolute value matters far less
 * than its being the same for all of them. */
const TYPICAL_ORDER_MS = 6_000;
/** How long a host counts as staffed while a process is on its way to it.
 *
 * Every real handoff is far shorter than this. A `spawn` lands one MACROTASK
 * later (v3.0.1 defers the successor through `setTimeout(spawnDelay)`), and an
 * `exec` handoff is bounded by `LAUNCH_CAPTURE_TIMEOUT_MS` — one second — plus
 * the child's boot. So the window only has to outlast a plant's slowest exec,
 * not a plant.
 *
 * It was ten seconds, and that was not a margin, it was the failure. A spawn
 * refused for RAM is SILENT: `ns.spawn` kills the caller synchronously and the
 * launch that never happens does so inside a timeout nobody can observe. The
 * window is the only place that shows up, and at ten seconds it hid a dead
 * vantage — with every host reachable only through it — for ten seconds a
 * time. Observed: `darkweb` holding a plant and a bleed with no process at
 * all, its two children unplanted for the whole of it. */
const MAX_GRAMMAR_SHAPES = 20;
const MAX_LOOSE_PASSWORDS = 40;
const MAX_PROVISIONAL_CREDENTIALS = 80;


function looseId(password: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < password.length; i++) {
    h ^= password.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}



/** No prober is standing anywhere the controller can reach, so a call it wanted
 * to borrow could not be made at all.
 *
 * A distinct type because it must not be confused with a call that FAILED: a
 * failed call is evidence about the host, and this is the absence of evidence
 * about anything. It is an ordinary state at cold start and after a net-wide
 * wipe, and home's beachhead seed is what resolves it. */
class NoLender extends Error {
  constructor() { super("no prober ns available to borrow"); this.name = "NoLender"; }
}

const RUNTIME_HOST_FIELDS = [
  "agentAlive", "jobFreeGb", "busy", "ns", "prober", "probeRefresh",
  "probeRefreshPid", "agent", "inbound",
  "bootstrap", "staged", "pendingOrder", "wake",
  "completed", "failed", "lastError",
] as const;

/** Clone only controller-durable host facts. JSON is intentional: the durable
 * shape is plain data, while any accidental function/promise is rejected by
 * omission rather than retained as a live reference to the dying controller. */
function recoveryKnowledge(generation: string, source: ReadonlyMap<string, HostEntry>, mutationsSeen: number): import("../../shared/strategy/dnet/host.ts").DnetKnowledge {
  const hosts = new Map<string, DnetHost>();
  for (const [hostname, entry] of source) {
    const durable = { ...entry } as Record<string, unknown>;
    for (const field of RUNTIME_HOST_FIELDS) delete durable[field];
    hosts.set(hostname, JSON.parse(JSON.stringify(durable)) as DnetHost);
  }
  return { generation, mutationsSeen, hosts };
}

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetControllerLaunch>("dnet-controller", ns.args[0]);
  if (!launch) return;
  const mission = launch;

  const realm = dnetRealm();
  const bootAt = Date.now();
  if (realm.dnet_controller?.buildId === launch.buildId && controllerIsLive(realm.dnet_controller, mission.generation, bootAt)) return;

  const identity: ArtifactIdentity | undefined = mission.identity;
  let tel: ReturnType<typeof initTelemetry> | undefined;
  TELEMETRY: if (__TELEMETRY__) {
    if (identity) tel = initTelemetry(ns, ns.getScriptName(), identity);
  }

  const selfHost = launch.host;
  const agentFile = "dnet/agent.js";
  const proberFile = "dnet/prober.js";
  const payloads = [agentFile, proberFile];
  let charisma = mission.charisma;
  let timingProfile: DnetTimingProfile | undefined;
  let netDepth: number | undefined;
  let bitNode: number | undefined;

  const restored = launch.recovery?.version === DNET_RECOVERY_VERSION
    && launch.recovery.generation === mission.generation
    ? launch.recovery
    : undefined;
  const hosts = new Map<string, HostEntry>(
    [...(restored?.knowledge.hosts ?? [])].map(([hostname, host]) => [
      hostname,
      cloneData(host) as HostEntry,
    ]),
  );
  /** The fold helpers operate on `DnetHost` values; a `HostEntry` IS one (its
   *  runtime fields are optional), so the same map serves both. */
  const knowledge = hosts as unknown as DnetHosts;
  let mutationsSeen = restored?.knowledge.mutationsSeen ?? 0;
  const vault = new Map<string, VaultEntry>((restored?.vault ?? []).map((entry) => [entry.hostname, cloneData(entry)]));
  const codes: Record<string, number> = { ...(restored?.codes ?? {}) };
  let spread: DnetSpreadReport | undefined = restored?.spread ? cloneData(restored.spread) : undefined;
  let farm: DnetFarmReport | undefined = restored?.farm ? cloneData(restored.farm) : undefined;
  let hold: DnetHoldReport | undefined = restored?.hold ? cloneData(restored.hold) : undefined;
  let storm: DnetStormReport | undefined = restored?.storm ? cloneData(restored.storm) : undefined;
  const loosePool: string[] = [];
  const provisionalPool: ProvisionalCredential[] = [];
  const authenticationEpoch = new Map<string, number>();
  const spentGuesses = new Set<string>();
  const guessFor = new Map<string, string>();
  const stasisLinked = new Set<string>(restored?.stasisSnapshot?.hosts ?? []);
  let stasisObservedAt = restored?.stasisSnapshot?.at ?? 0;
  let charismaNeeded: number | undefined = restored?.charismaNeeded;
  let promoteSymbols: PromoteSymbol[] = [];
  let crimeSuccessMult = 1;
  let farmEconomics: FarmEconomics | undefined;
  let stasisLimit = 1;
  let labExpected = true;
  const backdoors = new Map<string, number>();
  let karmaLoss = restored?.karmaLoss ?? 0;
  let profit = restored?.profit ? cloneData(restored.profit) : emptyDnetProfit();
  let lastPhishCacheAt: number | undefined = restored?.lastPhishCacheAt;
  let lastStormFiredAt: number | undefined = restored?.lastStormAt;
  let stormStampPrior: number | undefined;
  let stormWipeAt: number | undefined = lastStormFiredAt !== undefined
    && bootAt - lastStormFiredAt < STORM_QUIET_MS
    ? lastStormFiredAt + STORM_QUIET_MS
    : undefined;
  const grammarShapes: Record<string, number> = { ...(restored?.grammar?.shapes ?? {}) };
  let grammarUnrecognised = restored?.grammar?.unrecognised ?? 0;
  const unknownModels: Record<string, number> = { ...(restored?.unknownModels ?? {}) };
  const agentHostsSeen = new Set<string>(restored?.agentHostsSeen ?? []);
  let lastLab: DnetLabReport | undefined = restored?.lab ? cloneData(restored.lab) : undefined;
  let openLabCache = false;
  const pendingBackdoorInvalidations = new Map<string, { hostname: string; at: number }>(
    (restored?.backdoorInvalidations ?? []).map((entry) => [entry.hostname, cloneData(entry)]),
  );
  const bootstrapDoneSet = new Set<string>();
  const needsInventory = new Set<string>();
  const labFields = new Map<string, LabField>();
  /** Per-target migration-charge estimate, from induce reports' readback of
   * the engine's own response. Cleared with the target's identity. */
  const migrationCharge = new Map<string, number>();
  const orderById = new Map<string, Order>();
  interface OrderCompletion {
    promise: Promise<void>;
    resolve: () => void;
    settled: boolean;
  }
  const orderDone = new Map<string, OrderCompletion>();
  const newCompletion = (id: string): OrderCompletion => {
    let finish!: () => void;
    const completion: OrderCompletion = {
      promise: new Promise<void>((resolve) => { finish = resolve; }),
      resolve: () => {
        if (completion.settled) return;
        completion.settled = true;
        finish();
      },
      settled: false,
    };
    orderDone.set(id, completion);
    return completion;
  };
  const completionFor = (id: string): OrderCompletion => {
    const existing = orderDone.get(id);
    if (existing !== undefined) return existing;
    return newCompletion(id);
  };
  const settleCompletion = (id: string): void => {
    const completion = orderDone.get(id);
    if (completion === undefined) return;
    completion.resolve();
  };
  let derivePass = 0;
  let residentsSeenEver = 0;
  let residentsLost = restored?.residentsLost ?? 0;
  let standDown = false;
  let lastMutationAt: number | undefined;
  let mutationTurnAt = -1;
  let prevMutationAt = 0;
  let mutationSweepDue = false;
  /** A mutation means stuff changed, so everything is rechecked: every host
   * re-described and every prober re-run. Two bits because they are two
   * different refreshes with two different costs — `getServerDetails` is a
   * local read, a probe is a process on the host — and nothing else may
   * conflate them. Set by the mutation, cleared by the refresh. Neither is a
   * question anyone has to ask: a mutation is the answer. */
  let detailsRefreshDue = false;
  let probeRefreshDue = false;
  let labCandidateHost: string | undefined;

  // --- derive wake ----------------------------------------------------------
  /** Derivation is FACT-driven, not tick-driven.
   *
   * Every write-through — a verified credential, a probe report, an adopted
   * agent, a settled order, a mutation — files its consequences on a microtask,
   * in the same engine turn as the fact. That is what lets a winning
   * `authenticate` reach the vantage's staged queue BEFORE the same process's
   * exit chain reads it (`agent.ts` `stageSuccessor`), so the plant runs on the
   * spawn the attempt itself performs rather than a tick later. The migration
   * has to be that prompt: a `.d` hint file names a neighbour as of the
   * authenticate INSTANT, and `exactNeighbourClueEpoch` discards it the moment
   * a mutation lands between the crack and the new host's first `ls`.
   *
   * A microtask rather than an inline call: the dozens of write-throughs one
   * order performs collapse into ONE pass, and the derive can never re-enter
   * the stack that asked for it.
   *
   * The loop's `TICK_MS` pass remains, as the watchdog it always was: it owns
   * the strictly TIME-driven work (dead-process and beat sweeps, watchdog
   * cancellation, the telemetry beat) and re-derives on a
   * bounded interval if a fact were ever missed. */
  /** DIAGNOSTICS — grep `dnet:` to remove.
   *
   * Deliberately quiet: every line is either a CHANGE or an exception, so a
   * healthy net prints almost nothing and anything printed is worth reading.
   * Sized by what actually cost time to find, not by what was easy to emit. */
  /** Last-printed signature per diagnostic, so a steady state prints once
   *  rather than every pass. */
  const seen = { empty: "", dropped: "", front: "", churn: new Map<string, number>() };
  const lastRefusals = new Map<string, string>();
  const dbg = (_line: string): void => {};

  /** Resolver for the loop's wait, held while it is parked on the mutation. */
  let deriveQueued = false;
  /** Resolvers waiting for the pass this signal will run. Settled whether or
   * not the pass actually derived, so a stood-down controller can never leave
   * an exiting order parked on a promise. */
  let deriveWaiters: (() => void)[] = [];
  const signalDerive = (): void => {
    if (deriveQueued) return;
    deriveQueued = true;
    void Promise.resolve().then(() => {
      deriveQueued = false;
      if (!standDown) fileWork(Date.now());
      const waiting = deriveWaiters;
      deriveWaiters = [];
      for (const resolve of waiting) resolve();
    });
  };

  // --- helpers --------------------------------------------------------------
  const ensureEntry = (host: string): HostEntry => {
    const existing = hosts.get(host);
    if (existing) { existing.staged ??= []; return existing; }
    const created: HostEntry = { hostname: host, lastSeenAt: Date.now(), seenAt: {}, dirty: {}, staged: [] };
    hosts.set(host, created);
    return created;
  };
  // A host whose successor is mid-spawn still HAS a process — the engine just
  // has not run its `main` yet. Excluding it dropped it out of `standing`, and
  // every route through it read `no-route` for the length of a spawn.
  /** Every host we can act FROM.
   *
   * A vantage is a place we can put a process, not a place that happens to
   * have one running. The prober is what makes a host that: it stands there
   * for the whole life of the host and carries `exec` (plus the
   * `connectToSession` that makes an exec aimed at a neighbour legal), so
   * `dispatch` launches an agent through its lent `ns` whenever there is work.
   *
   * Requiring a live AGENT here was the resident era's rule, and it survived
   * the move to one-order-per-process as a defect: an order clears
   * `entry.agent` when it finishes, so between orders a perfectly healthy host
   * dropped out of this set, every route through it became `no-route`, and its
   * queued work was retired as stranded. `inbound` was added to patch the
   * TRANSIENT version of that window (see `HostEntry.inbound`); with no
   * resident to fall back to, the window never closes on its own. */
  const liveEntries = (): HostEntry[] =>
    [...hosts.values()].filter((e) => e.agent !== undefined || e.ns !== undefined || processInbound(e));
  const expiryOpts = (): ExpiryOpts => ({
    ...(netDepth !== undefined ? { netDepth } : {}),
    ...(bitNode !== undefined ? { bitNode } : {}),
    backdoored: backdoors.size,
    ...(stasisLinked.size > 0 ? { stasisLinked } : {}),
  });
  const note = (code: number, n = 1): void => { codes[String(code)] = (codes[String(code)] ?? 0) + n; };
  const recordStasis = (hostname: string, linked: boolean): void => {
    if (linked) stasisLinked.add(hostname); else stasisLinked.delete(hostname);
    stasisObservedAt = Math.max(Date.now(), stasisObservedAt + 1);
  };
  const removePendingFor = <T extends { hostname: string }>(entries: T[], hostname: string): void => {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.hostname === hostname) entries.splice(i, 1);
  };
  const invalidateBackdoor = (hostname: string): void => {
    if (!backdoors.delete(hostname)) return;
    pendingBackdoorInvalidations.set(hostname, { hostname, at: Date.now() });
  };
  const forgetGuesses = (hostname: string): void => {
    for (const key of [...spentGuesses]) if (key.startsWith(`${hostname} `)) spentGuesses.delete(key);
  };

  const cancelActive = (entry: HostEntry, reason: string): void => {
    const agent = entry.agent;
    if (agent === undefined) return;
    if (agent.cancelReason !== undefined) return;
    // grep `dnet:` to remove. A cancelled order settles at once and exits
    // without doing its work, so two tasks that keep displacing each other on
    // one vantage burn a spawn per swap and make no progress at all. Every
    // pass looks like a correct decision; only the sequence shows the loop. The
    // AGE is the tell — a victim cancelled milliseconds after it adopted never
    // got to make its call.
    dbg(`preempt] ${entry.hostname} cancelling ${agent.order.kind} -> ${agent.order.host}`
      + ` after ${Date.now() - agent.startedAt}ms`
      + ` (${agent.order.label ?? "-"}) — ${reason}`);
    // A pin is atomic and a walk is PID-bound: neither may be interrupted at
    // all, and both still stop at their own next boundary on the flag.
    if (JOBS[agent.order.kind].releaseExempt) return;

    // The flag alone is only read at a call boundary, and a body inside a
    // multi-second Darknet call has none — so a plant preempting a phish would
    // wait out most of the phish. How we get it out depends on WHERE it is,
    // and `release` is the exact tell: `awaitDnetOperation` publishes the hook
    // for precisely as long as one engine call is outstanding.
    if (agent.release === undefined) {
      // Between calls. The flag is enough; the body reads it at its next
      // boundary and exits on its own terms, spawning its successor.
      return;
    }

    // Inside an engine call, and this is the case that cost the net its hosts.
    // Bitburner allows ONE Netscript call per script at a time. Releasing the
    // WAIT does not release the CALL — `env.runningFn` stays set until the
    // engine finishes — so the freed body walked straight into its exit path
    // and threw:
    //
    //     CONCURRENCY ERROR — Currently running: induceServerMigration,
    //                         Tried to run: getScriptName
    //
    // No successor, host left holding its prober alone. Observed on six hosts
    // in one run, against `induceServerMigration`, `heartbleed` and
    // `promoteStock` alike.
    //
    // A kill is not a fallback here, it is the only mechanism the engine
    // offers, and it is built for exactly this: `killWorkerScript` clears
    // `env.runningFn` BEFORE it runs the atExit handlers and only frees the
    // allocation after them. So the victim's `armRespawn` hook runs with a
    // clear Netscript slot, spawns its successor at its own price, and that
    // spawn's own kill frees this process's RAM before the launch. The
    // respawn happens inside the kill, which is why it works where the
    // voluntary path cannot.
    agent.release();
    killPid(entry.hostname, agent.pid);
  };

  /** Settle a STAGED order that never ran (retired before pickup), by running
   * its report side effects directly — there is no agent promise to await. */
  const retireStaged = (order: Order, targetState: Report["targetState"], detail: string): void => {
    onReport({ id: order.id, kind: order.kind, host: order.host, from: order.from, ok: false, ...(targetState ? { targetState } : {}), detail });
  };

  /** Every order an entry is holding, in one list: running, pending and
   * staged. The frontier prunes below walk all of them. */
  const ordersHeldBy = (entry: HostEntry): Order[] =>
    [entry.agent?.order, entry.pendingOrder, ...(entry.staged ?? [])]
      .filter((o): o is Order => o !== undefined);

  const retireOrders = (hostname: string, reason: string, applies: (o: Order) => boolean): void => {
    // A plant carries a whole frontier, so a dead host costs it one STOP.
    // Matching on `o.host` alone both missed a doomed target sitting behind
    // the first and, when the doomed one WAS first, retired every healthy
    // target beside it.
    for (const entry of hosts.values()) {
      for (const o of ordersHeldBy(entry)) {
        if (o.kind !== "plant" || !applies(o)) continue;
        o.payload.targets = o.payload.targets.filter((t) => t.host !== hostname);
      }
    }
    const targets = (o: Order): boolean => applies(o)
      && (o.kind === "plant" ? o.payload.targets.length === 0 : o.host === hostname);
    for (const entry of hosts.values()) {
      const staged = entry.staged ?? [];
      const retired = staged.filter(targets);
      if (retired.length > 0) {
        entry.staged = staged.filter((o) => !targets(o));
        for (const o of retired) retireStaged(o, "cancelled", reason);
      }
      if (entry.agent !== undefined && targets(entry.agent.order)) {
        cancelActive(entry, reason);
      }
    }
  };
  const retireCracking = (hostname: string, reason: string): void => {
    forgetGuesses(hostname);
    retireOrders(hostname, reason, (o) => o.kind === "attempt");
  };
  /** The `ns` to make a GLOBAL call through: the controller's hands.
   *
   * The controller owns no billable call of its own — its whole surface is the
   * mutation clock, which it must be parked in — so every read and every kill
   * is billed to another process's allocation. These calls work on any host
   * from anywhere, so exactly one process in the net needs to be able to make
   * them, and `game/dnet/hands.ts` is it.
   *
   * Undefined before the beachhead seeds it and after it dies. That is an
   * ordinary state, not an error: every caller handles it by learning nothing
   * rather than by concluding something. */
  const hands = (): NS | undefined => liveHands();

  /** The `ns` to make a HOST-BOUND call through: that host's own prober.
   *
   * `dnet.probe` scans from the calling host and `exec` reaches only self and
   * connected, so these cannot be borrowed from anywhere else — which is the
   * entire reason a process stands on every host. */
  const lender = (host: string): NS | undefined => hosts.get(host)?.ns;

  /** True when the process was ours to kill and is now certainly gone. Never
   * the controller's own pid, and a throw (host deleted) counts as gone.
   *
   * No `isRunning` guard: `kill` on a pid that is already gone returns false
   * and costs nothing, so asking first bought only a second borrowed call. */
  const killPid = (hostname: string, pid: number | undefined): void => {
    if (pid === undefined || pid <= 0 || pid === ns.pid) return;
    const borrowed = hands();
    if (borrowed === undefined) return;
    try { borrowed["kill"](pid); } catch { /* host gone */ }
  };
  const retireVantage = (hostname: string, reason: string): void => {
    const placing = hosts.get(hostname);
    // grep `dnet:` to remove. THE silent event: this is the one place a
    // standing agent is dropped, and it never said so. A host that is planted,
    // adopts, and is retired milliseconds later reads from outside as a plant
    // that simply did not stick — and the spread replants it forever. Name the
    // reason and what was standing there.
    if (placing?.agent !== undefined || placing?.inbound !== undefined) {
      dbg(`retire] ${hostname} agent=${placing.agent === undefined
        ? "-" : `${placing.agent.order.kind}:${placing.agent.pid}`}`
        + ` after ${placing.agent === undefined ? "?" : Date.now() - placing.agent.startedAt}ms`
        + ` inbound=${placing.inbound === undefined ? "-" : placing.inbound.via}`
        + ` q=${(placing.staged ?? []).map((o) => o.kind).join("/") || "-"}`
        + ` — ${reason}`);
    }
    if (placing !== undefined) placing.inbound = undefined;
    const entry = hosts.get(hostname);
    if (entry !== undefined) {
      if (entry.agent !== undefined) {
        entry.agent.settle({ id: entry.agent.order.id, kind: entry.agent.order.kind, host: entry.agent.order.host, from: entry.agent.order.from, ok: false, died: true, detail: reason });
      }
      for (const o of entry.staged ?? []) {
        orderById.delete(o.id);
        settleCompletion(o.id);
      }
      if (entry.pendingOrder !== undefined && entry.pendingOrder.id !== entry.agent?.order.id) {
        settleCompletion(entry.pendingOrder.id);
      }
      entry.agent = undefined;
      entry.staged = [];
      entry.pendingOrder = undefined;
      entry.probeRefresh?.settle(undefined);
      entry.probeRefresh = undefined;
      // A prober outlives the agent beside it (a finished `pin` leaves one
      // standing alone), and forgetting its pid without killing it strands
      // 1.8 GB the replant then has to exec a SECOND prober around. Kill it
      // here so the re-plant starts from an empty host.
      killPid(hostname, entry.prober?.pid);
      entry.prober = undefined;
      entry.bootstrap = undefined;
    }
    bootstrapDoneSet.delete(hostname);
    needsInventory.delete(hostname);
  };
  const retireLifetime = (hostname: string, reason: string): void => {
    // grep `dnet:` to remove. This is the ONLY permanent kill in the system —
    // it tombstones the host AND drops its password — and until now it did
    // both without saying so. A host we hold a loaded credential for must
    // never leave this way quietly: "no-credential" appearing on a host whose
    // password came from the file is this line having fired.
    dbg(`gone] ${hostname} retired`);
    retireOrders(hostname, reason, () => true);
    retireVantage(hostname, reason);
    vault.delete(hostname);
    migrationCharge.delete(hostname);
    invalidateBackdoor(hostname);
    if (stasisLinked.has(hostname)) recordStasis(hostname, false);
    labFields.delete(hostname);
    authenticationEpoch.delete(hostname);
    forgetGuesses(hostname);
    removePendingFor(provisionalPool, hostname);
  };
  const retireRejectedCredential = (hostname: string): void => {
    retireOrders(hostname, "credential rejected", (o) => o.kind === "plant");
    vault.delete(hostname);
    const host = hosts.get(hostname);
    if (host !== undefined) delete host.credentialKnown;
    authenticationEpoch.delete(hostname);
    removePendingFor(provisionalPool, hostname);
  };

  // --- write-through deps ---------------------------------------------------
  const recordCredential = (entry: VaultEntry): void => {
    if (entry.hostname.length === 0) return;
    const host = hosts.get(entry.hostname);
    if (host?.goneAt !== undefined) return;
    const identity = entry.identity ?? host?.identity;
    if (entry.identity !== undefined && host?.identity !== undefined && entry.identity !== host.identity) return;
    const verified = { ...entry, ...(identity !== undefined ? { identity } : {}) };
    vault.set(entry.hostname, verified);
    markCredentialKnown(host);
    removePendingFor(provisionalPool, entry.hostname);
    retireCracking(entry.hostname, "credential verified; cracking retired");
    authenticationEpoch.set(entry.hostname, rendezvous.mutationEpoch);
    // No plant is filed here. The credential IS the fact; the derive this wakes
    // reaches the same conclusion through the ordinary spread planner, which
    // unlike a hand-filed shortcut knows about remote-exec routes, can reroute
    // onto a roomier vantage, and may preempt a lesser order to get there.
    signalDerive();
  };
  const recordLoose = (password: string): void => {
    if (loosePool.includes(password)) return;
    loosePool.push(password);
    signalDerive();
    if (loosePool.length > MAX_LOOSE_PASSWORDS) loosePool.shift();
  };
  const recordProvisional = (entry: ProvisionalCredential): void => {
    if (entry.hostname.length === 0) return;
    const host = hosts.get(entry.hostname);
    if (host?.goneAt !== undefined || vault.has(entry.hostname)) return;
    const identity = entry.identity ?? host?.identity;
    const candidate = { ...entry, ...(identity !== undefined ? { identity } : {}) };
    const existing = provisionalPool.findIndex((h) => h.hostname === candidate.hostname && h.password === candidate.password && h.identity === candidate.identity);
    if (existing >= 0) provisionalPool.splice(existing, 1);
    provisionalPool.push(candidate);
    signalDerive();
    if (provisionalPool.length > MAX_PROVISIONAL_CREDENTIALS) provisionalPool.shift();
  };
  const projectLooseTarget = (hostname: string, at: number, expiry: ExpiryOpts): LooseTarget => {
    const host = hosts.get(hostname);
    const view = host ? planningView(host, at, expiry) : undefined;
    return {
      hostname,
      ...(view?.passwordLength !== undefined ? { passwordLength: view.passwordLength } : {}),
      ...(view?.passwordFormat !== undefined ? { passwordFormat: view.passwordFormat } : {}),
      hasCredential: vault.has(hostname),
      ...(view?.isStationary === true ? { isStationary: true } : {}),
      ...(host?.goneAt !== undefined ? { gone: true } : {}),
    };
  };
  const recordNeighbourPassword = (source: string, password: string, at: number): void => {
    const probe = hosts.get(source)?.prober;
    const authenticated = authenticationEpoch.get(source);
    if (!probe || !exactNeighbourClueEpoch(authenticated, probe.epoch, rendezvous.mutationEpoch)) { recordLoose(password); return; }
    const targets = probe.neighbours.map((h) => projectLooseTarget(h, at, expiryOpts()));
    for (const candidate of looseCandidates([password], targets)) {
      recordProvisional({ hostname: candidate.hostname, password, via: "neighbour-file", at });
    }
  };
  const recordFileEvidence = (hostname: string, evidence: PasswordEvidence): void => {
    if (hosts.get(hostname) === undefined) {
      const named: ReportHost = { hostname, at: evidence.at, present: true };
      foldReports(knowledge, [named], evidence.at, expiryOpts());
    }
    const pendingAuthRecords = hosts.get(hostname)?.ring?.pendingAuthRecords ?? 0;
    const outcome: LogDrainOutcome = { pendingAuthRecords, evidence: [evidence] };
    foldLogDrain(hosts.get(hostname), outcome);
  };
  const recordAttempt = (hostname: string, outcome: AttemptOutcome): void => {
    foldAttempts(hosts.get(hostname), [outcome]);
    if (outcome.status === "unknown-model") {
      const id = outcome.modelId ?? "(no model id)";
      unknownModels[id] = (unknownModels[id] ?? 0) + 1;
    }
  };
  const recordLogDrain = (hostname: string, outcome: LogDrainOutcome): void => {
    foldLogDrain(hosts.get(hostname), outcome);
  };
  const expectedDelayMs = (request: DnetDelayRequest): number | undefined => {
    const target = hosts.get(request.host);
    const direct = request.operation === "authenticate"
      || request.operation === "heartbleed"
      || request.operation === "memoryReallocation"
      || request.operation === "induceServerMigration";
    const neighbours = direct
      ? fresh<string[]>(hosts.get(request.from), "neighbours", Date.now(), expiryOpts())
      : undefined;
    const knownRefusal = knownDnetRefusalWaitMs(request.operation, {
      targetGone: target?.goneAt !== undefined,
      ...(direct && neighbours !== undefined && request.host !== request.from ? { direct: neighbours.includes(request.host) } : {}),
      selfTarget: request.host === request.from,
      stationary: target?.isStationary,
      blockedRam: target?.blockedRam,
      heartbleedUnderleveled: request.operation === "heartbleed" && timingProfile !== undefined && target?.requiredCharisma !== undefined
        ? timingProfile.charisma < target.requiredCharisma
        : undefined,
      stasisLimitReached: request.operation === "setStasisLink" && request.shouldLink === true
        ? stasisLinked.size >= stasisLimit
        : undefined,
    });
    if (knownRefusal !== undefined) return knownRefusal;

    const profile = timingProfile;
    if (request.operation === "induceServerMigration") return INDUCE_WAIT_MS;
    if (profile === undefined) return undefined;
    if (request.operation === "memoryReallocation") return reclaimWaitMs(profile.charisma);
    if (request.operation === "phishingAttack") return phishWaitMs(profile.charisma);
    if (request.operation === "promoteStock") return promoteWaitMs(profile.charisma);
    if (request.operation === "setStasisLink") return stasisWaitMs(profile.charisma);

    if (target?.difficulty === undefined || target.depth === undefined || target.requiredCharisma === undefined) return undefined;
    const timingTarget = {
      ...(target.modelId !== undefined ? { modelId: target.modelId } : {}),
      difficulty: target.difficulty,
      depth: target.depth,
      requiredCharismaSkill: target.requiredCharisma,
    };
    if (request.operation === "heartbleed") return heartbleedWaitMs(timingTarget, profile, request.threads);
    return authenticateWaitMs(timingTarget, profile, request.threads, request.correctChars ?? 0);
  };
  const deps: ControllerDeps = {
    charisma: () => charisma,
    timing: () => timingProfile,
    expectedDelayMs,
    ledgerFor: (host) => hosts.get(host)?.attempts,
    ringFor: (host) => hosts.get(host)?.ring,
    recordAttempt, recordLogDrain, recordCredential, recordLoose, recordProvisional,
    recordNeighbourPassword, recordFileEvidence,
    labField: (host) => labFields.get(host),
    publishLabField: (host, field) => {
      const held = labFields.get(host);
      labFields.set(host, held === undefined ? field : mergeLabFields(held, field));
    },
  };

  // --- pricing --------------------------------------------------------------
  const budgets: Record<TaskKind, number> = Object.fromEntries(
    (Object.keys(KIND_CALLS) as (keyof typeof KIND_CALLS)[])
      .filter((k): k is TaskKind => k !== "idle" && k !== "bootstrapReclaim")
      .map((kind) => [kind, priceOf(kind)]),
  ) as Record<TaskKind, number>;
  // Written down, not measured: see `ORDER_PRICES`.
  /** What this host reserves for its prober, which is not one number.
   *
   * - The LAB WALKER keeps none. Its prober is displaced outright
   *   (`displaceProber`) because the walk needs every byte and ends by leaving
   *   the host empty for `planSpread` anyway.
   * - A STASIS host keeps a prober WITHOUT `exec`. The engine's mutation guard
   *   exempts it (`openServer || isConnectedTo || hasStasisLink`), so it cannot
   *   lose its processes and never needs to relaunch them locally; the
   *   controller reaches it remotely for as long as the link holds.
   * - Everything else keeps the full one, because `exec` is the only way a host
   *   that lost its processes gets any back.
   *
   * The worker sees the difference immediately: this feeds `usableGb`, so the
   * bytes a smaller prober does not hold become threads. */
  const proberReserveGb = (host: string): number =>
    host === labCandidateHost ? 0
      : stasisLinked.has(host) ? PROBER_STASIS_GB
        : PROBER_GB;
  const proberGb = PROBER_GB;
  const controllerGb = CONTROLLER_GB;
  const residentGb = priceOf("idle");
  const bootstrapGb = priceOf("bootstrapReclaim");
  const heaviestJobGb = Math.max(
    ...TASK_KINDS.filter((kind) => JOBS[kind].routine).map((kind) => budgets[kind] ?? 0));
  const farmGbPerThread: Record<FarmKind, number> = {
    cache: budgets["cache"] ?? budgets["inventory"]!,
    reclaim: budgets["reclaim"] ?? budgets["inventory"]!,
    phish: budgets["phish"] ?? budgets["inventory"]!,
    promote: budgets["promote"] ?? budgets["inventory"]!,
  };
  /** What OUR OWN processes are holding on a host, straight from the handles
   * that placed them. No call, so it cannot fail with the host — which makes
   * it the answer whenever the engine's own occupancy sample is unavailable.
   * The engine sample stays authoritative when we can get it: it also counts
   * anything we did not place. */
  const heldGb = (entry: HostEntry): number => {
    const orderGb = (order: Order | undefined): number =>
      order === undefined ? 0 : order.ramOverrideGb * order.threads;
    return orderGb(entry.agent?.order)
      + (entry.prober !== undefined && entry.prober.pid > 0 ? proberReserveGb(entry.hostname) : 0)
      + (entry.hostname === selfHost ? controllerGb : 0);
  };

  const usableGb = (hostname: string, at: number, expiry: ExpiryOpts, reserveProber = true): number => {
    const host = hosts.get(hostname);
    if (host === undefined) return 0;
    const view = planningView(host, at, expiry);
    if (view.maxRam === undefined) return 0;
    const blocked = view.blockedRam ?? 0;
    // Darkweb keeps BOTH pieces of infrastructure beside its spawn-chain
    // agent. Ordinary hosts keep only the prober; the lab walker keeps neither.
    const fixedReserve = reserveProber ? proberReserveGb(hostname) + (hostname === selfHost ? controllerGb : 0) : 0;
    return Math.max(0, view.maxRam - blocked - fixedReserve);
  };
  /** The room a launch on this host actually has: durable capacity less the
   * owner's block and the prober beside it. CAPACITY, never
   * `getServerUsedRam` — a handoff replants in the same instant its
   * predecessor exits and the engine frees that allocation a tick later, so a
   * live snapshot reads a ghost occupancy. Undefined when the host is gone. */
  const durableRoomGb = (host: string): number | undefined => {
    const borrowed = hands();
    if (borrowed === undefined) return undefined;
    try {
      const details = borrowed["dnet"]["getServerDetails"](host);
      if (!details.isOnline) return undefined;
      return Math.max(0, borrowed["getServerMaxRam"](host) - details.blockedRam - proberReserveGb(host));
    } catch {
      return undefined;
    }
  };
  const displaceProber = (host: string): void => {
    // The controller host is never a labyrinth walk vantage. Keep that
    // topology invariant explicit so this helper can never kill infrastructure
    // while making room for a walker.
    if (host === selfHost) return;
    const entry = hosts.get(host);
    const probe = entry?.prober;
    if (probe === undefined || probe.pid <= 0) return;
    killPid(host, probe.pid);
    entry!.prober = { ...probe, pid: 0 };
  };

  // --- report handling (the promise-driven core) ----------------------------
  const absorb = (result: Report): void => {
    const at = Date.now();
    if (result.hosts && result.hosts.length > 0) {
      const folded = foldReports(knowledge, result.hosts, at, expiryOpts());
      for (const hostname of folded.hostsReplaced) retireLifetime(hostname, "server identity replaced");
      for (const hostname of folded.hostsForgotten) retireLifetime(hostname, "expired server tombstone forgotten");
      for (const h of result.hosts) {
        if (!h.present) retireLifetime(h.hostname, "server is gone");
        else if (h.neighbours !== undefined) {
          const entry = hosts.get(h.hostname);
          if (entry) { retireLostEdgeOrders(entry, h.hostname, h.neighbours); retireLostPin(entry, h.hostname, h.neighbours); }
        }
      }
      if (result.hosts.some((h) => h.neighbours !== undefined)) signalDerive();
    }
    for (const [code, count] of Object.entries(result.codes ?? {})) note(Number(code), count);
    if (result.grammar) {
      grammarUnrecognised += result.grammar.unrecognised;
      for (const shape of result.grammar.shapes) {
        if (grammarShapes[shape] !== undefined) grammarShapes[shape] += 1;
        else if (Object.keys(grammarShapes).length < MAX_GRAMMAR_SHAPES) grammarShapes[shape] = 1;
      }
    }
    if (result.karmaLoss !== undefined) karmaLoss += result.karmaLoss;
    mergeDnetProfit(profit, result.profit);
    if (result.charismaNeeded !== undefined) charismaNeeded = Math.max(charismaNeeded ?? 0, result.charismaNeeded);
    if ((result.codes ?? {})[LOCAL_CODE.PhishingCacheWon] !== undefined) lastPhishCacheAt = at;
  };

  /** Forget an edge the engine just disproved, in BOTH directions.
   *
   * `candidatesFrom` reads adjacency symmetrically, so leaving either end's
   * list intact leaves the route derivable. Surgical rather than dirtying the
   * whole group: we learned one thing — that this edge is gone — and marking
   * the vantage's entire topology unknown would blind it to every OTHER
   * neighbour it still has. */
  const disproveEdge = (vantage: string, target: string): void => {
    let dropped = false;
    for (const [from, to] of [[vantage, target], [target, vantage]] as const) {
      const entry = hosts.get(from);
      const known = entry?.neighbours;
      if (entry === undefined || known === undefined || !known.includes(to)) continue;
      entry.neighbours = known.filter((name) => name !== to);
      dropped = true;
    }
    // grep `dnet:` to remove.
    if (dropped) dbg(`edge] ${vantage} -/- ${target} — the engine refused a launch across it`);
  };

  const retireLostEdgeOrders = (entry: HostEntry, vantage: string, neighbours: readonly string[]): number => {
    // A REMOTE target does not lose its route when an edge does: it never had
    // one, it has a backdoor.
    const lost = (host: string, remote: boolean): boolean =>
      host !== vantage && !remote && !neighbours.includes(host);
    // A plant carries a whole frontier, and one severed edge costs it one
    // target rather than the order: prune in place, and only an order left
    // with nothing to reach is retired.
    for (const o of ordersHeldBy(entry)) {
      if (o.kind !== "plant" || o.from !== vantage) continue;
      o.payload.targets = o.payload.targets.filter((t) => !lost(t.host, t.remote === true));
    }
    const applies = (o: Order): boolean => o.from === vantage
      && (o.kind === "plant"
        ? o.payload.targets.length === 0
        : lost(o.host, false));
    const staged = entry.staged ?? [];
    const retired = staged.filter(applies);
    if (retired.length > 0) {
      entry.staged = staged.filter((o) => !applies(o));
      for (const o of retired) retireStaged(o, "edge-lost", `${o.host} is no longer adjacent to ${vantage}`);
    }
    let active = 0;
    if (entry.agent !== undefined && applies(entry.agent.order)) {
      cancelActive(entry, `${entry.agent.order.host} is no longer adjacent to ${vantage}`);
      active = 1;
    }
    return retired.length + active;
  };
  const retireLostPin = (entry: HostEntry, host: string, neighbours: readonly string[]): number => {
    const doomed = (o: Order): boolean => o.kind === "pin"
      && o.payload.unpin !== true && o.payload.edge !== undefined && !neighbours.includes(o.payload.edge);
    const staged = entry.staged ?? [];
    const retired = staged.filter(doomed);
    if (retired.length > 0) {
      entry.staged = staged.filter((o) => !doomed(o));
      for (const o of retired) {
        retireStaged(o, "edge-lost",
          `${host}'s edge to ${o.kind === "pin" ? o.payload.edge : "?"} is gone; pin abandoned before spending`);
      }
    }
    return retired.length;
  };

  const onReport = (report: Report): void => {
    const order = orderById.get(report.id);
    // grep `dnet:` to remove. An order that completes without recording
    // progress is re-derived identically, runs again, and the host spins as
    // fast as the engine will schedule it — a freeze, not a slowdown. Nothing
    // else notices, because every individual pass looks correct. So count
    // completions per order id and say so, with the report that explains why
    // it keeps finishing for nothing.
    {
      const key = `${report.kind}:${report.id}:${report.from}`;
      // Only work that achieves NOTHING is churn. Several task ids are stable
      // by design and reused every pass — `plant:<from>` covers whatever that
      // vantage's frontier is today, `attempt:<host>` steps through a
      // dictionary — so counting completions alone reported healthy progress
      // as a spin. Success resets the count; what is left is repetition that
      // changed nothing.
      if (report.ok === true) { seen.churn.delete(key); }
      const n = report.ok === true ? 0 : (seen.churn.get(key) ?? 0) + 1;
      if (n > 0) seen.churn.set(key, n);
      if (n === 5 || n === 25 || n === 100 || n === 500) {
        dbg(`churn] ${report.from} finished ${report.kind} "${report.id}" ${n} times`
          + ` — ok=${report.ok} state=${report.targetState ?? "-"}`
          + ` codes=${JSON.stringify(report.codes ?? {})}`
          + ` label=${order?.label ?? "-"}`
          + ` :: ${report.detail ?? "(no detail)"}`);
      }
    }
    // grep `dnet:` to remove. What an attempt actually DID. `codes` empty and
    // `ok=false` means the call never happened — the order was cancelled or
    // refused before it reached the wire, which is the difference between a
    // slow crack and a spin.
    if (report.kind === "attempt") {
      dbg(`attempt] ${report.from} -> ${report.host} ok=${report.ok}`
        + ` state=${report.targetState ?? "-"} codes=${JSON.stringify(report.codes ?? {})}`
        + ` :: ${report.detail ?? "(no detail)"}`);
    }
    absorb(report);
    // The migration-charge estimate, from the engine's own response readback.
    // A completed move reports 0 (the engine resets on landing); a target's
    // identity death clears it in `retireLifetime`.
    if (report.induceCharge !== undefined) migrationCharge.set(report.host, report.induceCharge);
    const filesInvalidated = report.hosts?.some((host) => host.invalidates?.includes("files")) === true;
    if (filesInvalidated && report.kind !== "inventory") {
      for (const host of report.hosts ?? []) if (host.invalidates?.includes("files")) needsInventory.add(host.hostname);
      signalDerive();
    }
    if (report.targetState === "edge-lost" || report.targetState === "replaced") lastMutationAt = Date.now();
    const reportedGone = report.hosts?.some((h) => h.hostname === report.host && !h.present) === true;
    if (report.targetState === "gone" && !reportedGone) {
      const gone: ReportHost = { hostname: report.host, at: Date.now(), present: false };
      foldReports(knowledge, [gone], gone.at, expiryOpts());
      retireLifetime(report.host, "server reported gone");
    } else if (report.targetState === "replaced"
      && report.hosts?.some((h) => h.hostname === report.host && h.present && h.identity !== undefined && h.identity !== order?.targetIdentity) !== true) {
      retireLifetime(report.host, "server identity changed");
    } else if (report.targetState === "credential-rejected") {
      retireRejectedCredential(report.host);
    } else if (report.targetState === "launch-refused"
      && (order?.kind === "plant" ? order.payload.targets : []).some((t) => t.host === report.host && t.remote === true)
      && !stasisLinked.has(report.host)) {
      invalidateBackdoor(report.host);
    } else if (report.kind === "plant" && report.targetState === "launch-refused") {
      // A REFUSED EXEC IS AN OBSERVATION.
      //
      // `connectToSession` and `scp` both succeeded and the engine still would
      // not start a process on the target, so the route we believed in does not
      // exist: the edge has been severed and only a stale neighbour list still
      // names it. Adjacency here is symmetric — either end's list can propose
      // the route — so both ends have to forget it, or the next derive proposes
      // the identical plant, it is refused identically, and the vantage churns
      // a spawn per pass for ever.
      //
      // This is the fact that used to be replaced by a guess. A cooldown made
      // the retry slower without making it any more likely to work; the edge
      // was gone either way, and the only thing waiting bought was a quieter
      // symptom. A probe re-establishes the edge if it ever comes back.
      disproveEdge(report.from, report.host);
    }
    // A plant that could not launch says so and is re-derived at once. There
    // is no hold: a host with root, a credential and no agent needs a plant,
    // and nothing may sit on that.
    if (report.kind === "plant" && report.ok !== true) {
      dbg(`plant-fail] ${report.from} -> ${(order?.kind === "plant" ? order.payload.targets : []).map((t) => t.host).join(",")}`
        + ` state=${report.targetState ?? "-"} codes=${JSON.stringify(report.codes ?? {})} :: ${report.detail ?? ""}`);
    }
    if (report.kind === "pin" && report.ok) {
      const pin = order?.kind === "pin" ? order.payload : undefined;
      const linked = pin?.unpin !== true;
      recordStasis(report.host, linked);
      if (linked && pin?.edge !== undefined) displaceProber(report.host);
      // The pin process intentionally ends without spawn. Its staged queue is
      // the controller's handoff contract, so do not retire/clear the vantage.
      signalDerive();
    }
    if (report.kind === "storm") {
      if (report.stormFiredAt !== undefined) {
        lastStormFiredAt = Math.max(lastStormFiredAt ?? 0, report.stormFiredAt);
        stormWipeAt = lastStormFiredAt + STORM_QUIET_MS;
      } else {
        lastStormFiredAt = stormStampPrior;
        stormWipeAt = undefined;
      }
    }
    const lastAttempt = report.attempts?.[report.attempts.length - 1];
    const spentGuess = order?.kind === "attempt" ? order.payload.guess : undefined;
    if (spentGuess !== undefined && lastAttempt !== undefined && conclusiveAttempt(lastAttempt)) {
      spentGuesses.add(`${report.host} ${spentGuess}`);
    }
    // A game kill of a live process: count the loss and let the next derive replant.
    if (report.died === true) {
      if (report.kind !== "idle") {
        residentsLost++;
        note(LOCAL_CODE.JobDied);
      }
      const e = hosts.get(report.from);
      if (e && e.agent?.order.id === report.id) e.agent = undefined;
      invalidateBackdoor(report.from);
      signalDerive();
    } else if (report.ok === false && report.targetState === undefined) {
      note(LOCAL_CODE.JobDied);
    }
    // Per-host work accounting, for the panel and the beat. `idle` is not
    // work, and a retired STAGED order never ran on anyone.
    if (report.kind !== "idle") {
      const runner = hosts.get(report.from);
      if (runner !== undefined) {
        if (report.ok) runner.completed = (runner.completed ?? 0) + 1;
        else {
          runner.failed = (runner.failed ?? 0) + 1;
          if (report.detail !== undefined) runner.lastError = report.detail.slice(0, 200);
        }
      }
    }
    orderById.delete(report.id);
    settleCompletion(report.id);
    // A finished order does NOT need the net re-planned. The agent takes its
    // next job itself — `stageSuccessor` hands it whatever is queued here, and
    // that is the whole of "what do I do next". Deriving on every completion
    // meant a full-net replan several times a second, once per settled order
    // across every vantage, to answer a question nobody had asked.
    //
    // The planner is needed for one thing: filling a queue that has run dry.
    // So derive when THIS vantage has nothing left, and let the facts that
    // genuinely open new work elsewhere — a verified credential, a probe
    // naming new neighbours, an adopted agent, a mutation — wake it
    // themselves, as they already do.
    if (report.died !== true && (hosts.get(report.from)?.staged ?? []).length === 0) {
      signalDerive();
    }
  };

  /** START the next staged order on this host, through its lender.
   *
   * This is what replaced the spawn chain. A worker used to be its own
   * launcher: it carried `spawn` (2.0 GB) so that on finishing it could become
   * the next order. But `spawn` is charged PER THREAD, and a handoff happens
   * once per process — so every thread of every order paid 2 GB for something
   * one of them did once. On a 16 GB host that was three `authenticate`
   * threads where the call itself allows eight, and threads are the only thing
   * that makes an `authenticate` faster.
   *
   * So the launcher moved to the one process that is already standing, already
   * one thread, and already permanent: the host's prober. It costs `exec` once
   * per host instead of `spawn` once per thread, and the worker is left as
   * nothing but its own action.
   *
   * Synchronous throughout — `offerLaunch` publishes the descriptor without
   * waiting to be captured, because the worker's own `adopt` is the
   * acknowledgement and a launch that never adopts is reaped by pid. */
  const dispatch = (entry: HostEntry): void => {
    if (entry.agent !== undefined || processInbound(entry)) return;
    if (standDown) return;
    const borrowed = entry.ns;
    if (borrowed === undefined) return;
    const next = takeNextOrder(entry);
    if (next === undefined) return;
    entry.pendingOrder = next;
    entry.inbound = { at: Date.now(), via: "plant-exec" };
    const offer = offerLaunch<DnetAgentLaunch>({ kind: "dnet-agent", host: entry.hostname });
    let pid = 0;
    try {
      pid = borrowed["exec"](
        agentFile,
        entry.hostname,
        temporaryRunOptions({ threads: next.threads, ramOverride: next.ramOverrideGb }),
        offer.launchId,
      );
    } catch { pid = 0; }
    if (pid === 0) {
      // Nothing started. Put the order back where the next pass will find it
      // rather than leaving it in a handoff slot nobody is coming for.
      offer.withdraw();
      entry.pendingOrder = undefined;
      entry.inbound = undefined;
      const staged = entry.staged ??= [];
      staged.unshift(next);
      dbg(`launch] ${entry.hostname} refused ${next.kind}`
        + ` (${(next.ramOverrideGb * next.threads).toFixed(1)}GB as ${next.threads}`
        + `x${next.ramOverrideGb.toFixed(2)}) — room ${durableRoomGb(entry.hostname)?.toFixed(1) ?? "?"}GB`);
      return;
    }
    entry.inbound = { ...entry.inbound, pid };
  };

  const stage = (entry: HostEntry, order: Order): boolean => {
    const staged = entry.staged ??= [];
    if (staged.some((o) => o.id === order.id) || entry.agent?.order.id === order.id) return false;
    // There is no queue-depth cap, and there was never anything for one to
    // protect against. Derivation is structurally deduped — `deriveTasks`
    // skips whatever `busy()` already covers, and the in-flight overlay counts
    // running, claimed AND staged work — so a queue can only ever
    // hold one order per distinct piece of work that exists. What a cap
    // actually did was REFUSE to schedule: a vantage at three orders stopped
    // accepting, and since `candidatesFrom` picks the same vantage every pass,
    // whole regions of cracked hosts sat empty behind one agent's queue.
    // Spreading load is `choosePreemptionVantage`'s job and it is answered by
    // WHEN a worker frees up (`readyInMs`), not by a count.
    if (order.kind === "storm") {
      stormStampPrior = lastStormFiredAt;
      lastStormFiredAt = Date.now();
      stormWipeAt = lastStormFiredAt + STORM_QUIET_MS;
    }
    orderById.set(order.id, order);
    // Only dependency targets have latches. A stable task id may be derived
    // again, and that generation must not inherit an earlier settled promise.
    const completion = orderDone.get(order.id);
    if (completion?.settled) newCompletion(order.id);
    // A host holds the ONE thing it should do next, never a backlog.
    //
    // Nothing here needs a queue. `compareQueuedDnetWork` already puts the
    // instant lane (probe, ls) ahead of anything that blocks, `canPreempt`
    // already says what displaces what, and the order between the rest falls
    // out of those two — so a list only ever recorded a decision the next
    // derive was about to make again anyway. Derivation is structurally
    // deduped: it emits exactly the work the current facts do not already
    // cover, so anything dropped here comes back the moment it is still
    // wanted. What remembering it bought was a stale ordering outliving the
    // facts that produced it, and hosts working through backlogs decided
    // several mutations ago.
    const standing = staged[0];
    if (standing !== undefined) {
      if (compareQueuedDnetWork(order, standing) >= 0) return false;
      staged.splice(staged.indexOf(standing), 1);
      retireStaged(standing, "cancelled", `superseded by ${order.kind}; a host runs its best order, not a queue`);
    }
    staged.push(order);
    // Staging and starting are one act now. Nothing waits to be woken: the
    // controller holds the launcher, so the only reason not to start is that
    // the host is already busy — which `dispatch` checks for itself.
    dispatch(entry);
    return true;
  };

  /** The backstop, never the first move: kill an agent that was asked to stop
   * on an EARLIER pass and is still running, which means its body is parked in
   * one blocking call and cannot see the flag itself. */
  // --- projections (HoldHost / FarmHost from the flat entries) --------------
  /** Every host with a walk running or staged, in map order, mapped to whether
   * EVERY walk it carries is a mortal scout. `false` therefore means "carries
   * the finisher", which is the flag the whole feature branches on: only the
   * finisher is irreplaceable, and only the finisher holds the storm. Written
   * once: three sweeps used to carry private copies of this loop. */
  const walkVantageRoles = (): Map<string, boolean> => {
    const roles = new Map<string, boolean>();
    const note = (host: string, scout: boolean): void => {
      roles.set(host, (roles.get(host) ?? true) && scout);
    };
    for (const entry of hosts.values()) {
      const active = entry.agent?.order;
      if (active?.kind === "walk") note(entry.hostname, active.payload.scout === true);
      for (const o of entry.staged ?? []) if (o.kind === "walk") note(entry.hostname, o.payload.scout === true);
    }
    return roles;
  };
  /** Every host with a walk running or staged, in map order. */

  const projectHoldHosts = (at: number, expiry: ExpiryOpts): HoldHost[] => {
    const walking = walkVantageRoles();
    return [...hosts.values()].map((entry) => {
      const view = planningView(entry, at, expiry);
      return {
        // The shared core projection home also uses — one definition, so the
        // two sides can never derive the same record differently.
        ...holdHostFrom(entry, {
          at,
          expiry,
          agentAlive: entry.agent !== undefined,
          hasCredential: vault.has(entry.hostname),
          stasisLinked: stasisLinked.has(entry.hostname),
        }),
        // `planWalk` REFUSES a lab candidate whose blocked RAM is not fresh,
        // and refuses again while any of it remains. Leaving it off the
        // projection parks the whole labyrinth walk on `ram-unknown` for ever.
        ...(view.blockedRam !== undefined ? { blockedRam: view.blockedRam } : {}),
        ...(view.difficulty !== undefined ? { difficulty: view.difficulty } : {}),
        ...(view.maxRam !== undefined ? { maxRam: view.maxRam } : {}),
        freeGb: usableGb(entry.hostname, at, expiry),
        // Only the FINISHER is irreplaceable. A mortal scout stamped here
        // would claim the reserved walker stasis slot in `admitPins` and
        // evict a held link for a walker whose death is already priced in.
        ...(walking.get(entry.hostname) === false ? { irreplaceable: true } : {}),
      };
    });
  };

  const projectInFlight = (): Map<string, { from: string; kind: TaskKind }[]> => {
    const projected = new Map<string, { from: string; kind: TaskKind }[]>();
    for (const entry of hosts.values()) {
      const orders: Order[] = [];
      if (entry.agent !== undefined) orders.push(entry.agent.order);
      // The CLAIMED order counts too. `preparePlant` moves it here for the whole
      // length of a plant, and a target that is invisible to `busy()` for those
      // seconds gets the same work derived again onto a second vantage.
      if (entry.pendingOrder !== undefined && entry.pendingOrder.id !== entry.agent?.order.id) {
        orders.push(entry.pendingOrder);
      }
      orders.push(...(entry.staged ?? []));
      for (const o of orders) {
        // A plant claims its WHOLE frontier. Projecting only the first left
        // every other target invisible to `busy()`, so the next derive filed
        // the same plant again from another vantage — and the loser's `exec`
        // was refused onto a host that had just been filled, stamping the 60 s
        // cooldown against the agent it had itself just placed.
        for (const host of hostsOf(o)) {
          const held = projected.get(host) ?? [];
          held.push({ from: entry.hostname, kind: o.kind as TaskKind });
          projected.set(host, held);
        }
      }
    }
    return projected;
  };

  const projectFarmHosts = (at: number, expiry: ExpiryOpts): FarmHost[] => {
    const farmHosts: FarmHost[] = [];
    const inFlight = projectInFlight();
    for (const entry of liveEntries()) {
      const view = planningView(entry, at, expiry);
      const busy = new Set<FarmKind>();
      for (const job of inFlight.get(entry.hostname) ?? []) {
        if (job.kind === "cache" || job.kind === "reclaim" || job.kind === "phish" || job.kind === "promote") busy.add(job.kind);
      }
      farmHosts.push({
        host: entry.hostname,
        ...(view.depth !== undefined ? { depth: view.depth } : {}),
        ...(view.difficulty !== undefined ? { difficulty: view.difficulty } : {}),
        ...(view.blockedRam !== undefined ? { blockedRam: view.blockedRam } : {}),
        ...(view.neighbours !== undefined ? { neighbours: view.neighbours } : {}),
        hasCredential: vault.has(entry.hostname),
        freeGb: usableGb(entry.hostname, at, expiry),
        caches: view.caches ?? [],
        isLab: isLabyrinth(entry.hostname, view.modelId),
        ...(entry.goneAt !== undefined ? { goneAt: entry.goneAt } : {}),
        busy,
      });
    }
    for (const entry of hosts.values()) {
      if (entry.agent !== undefined || entry.bootstrap !== undefined || !vault.has(entry.hostname)) continue;
      const view = planningView(entry, at, expiry);
      if (view.blockedRam === undefined || view.blockedRam <= 0) continue;
      if (view.isStationary === true || entry.goneAt !== undefined) continue;
      const busy = new Set<FarmKind>();
      for (const job of projectInFlight().get(entry.hostname) ?? []) if (job.kind === "reclaim") busy.add("reclaim");
      farmHosts.push({
        host: entry.hostname,
        ...(view.depth !== undefined ? { depth: view.depth } : {}),
        ...(view.difficulty !== undefined ? { difficulty: view.difficulty } : {}),
        blockedRam: view.blockedRam,
        hasCredential: true,
        freeGb: 0,
        caches: [],
        busy,
      });
    }
    return farmHosts;
  };

  const projectLooseTargets = (at: number, expiry: ExpiryOpts): LooseTarget[] =>
    [...hosts.keys()].map((hostname) => projectLooseTarget(hostname, at, expiry));

  // --- the walk / pins / hold plan ------------------------------------------
  // The decisions live in `hold.ts` (`planHold`/`planWalk`/`admitPins`) as
  // pure functions of the projected view; this wrapper only projects, hands
  // over the scalars the controller alone knows, and folds the report.
  /** Hosts whose in-flight authenticate is their LAST dictionary candidate,
   * mapped to the milliseconds left on that call — the pre-charge pipeline's
   * admission ticket. Dictionary models only: a solver's budget is a worst
   * case, not a "one left" the timing rule could trust. */
  const aboutToCrackNow = (at: number): ReadonlyMap<string, number> => {
    const out = new Map<string, number>();
    for (const entry of hosts.values()) {
      const order = entry.agent?.order;
      if (order === undefined || order.kind !== "attempt" || vault.has(order.host)) continue;
      const target = hosts.get(order.host);
      if (target === undefined || target.goneAt !== undefined) continue;
      const list = modelEntry(target.modelId)?.candidates?.({
        passwordLength: target.passwordLength,
        passwordFormat: target.passwordFormat,
        passwordHint: target.passwordHint,
        data: target.data,
        difficulty: target.difficulty,
      });
      if (list === undefined) continue;
      if (list.length - (target.attempts?.tried ?? 0) === 1) {
        // `expectedDoneAt` is only stamped while a call is actually in flight
        // AND its delay is believable (`timing.ts` clears it in a `finally`),
        // so it is routinely absent mid-order. Absent must read as "a whole
        // call still to run", never as zero: zero releases the wave-closing
        // landing, whose edge re-roll kills the very authenticate this
        // pipeline exists to protect.
        out.set(order.host, order.expectedDoneAt === undefined
          ? INDUCE_WAIT_MS
          : Math.max(0, order.expectedDoneAt - at));
      }
    }
    return out;
  };

  const planHold = (at: number): { tasks: HoldTask[]; report: DnetHoldReport; labWalked: boolean; labCandidate?: string } => {
    const expiry = expiryOpts();
    const plan = planHoldFromView({
      hosts: projectHoldHosts(at, expiry),
      netDepth: netDepth ?? DEFAULT_NET_DEPTH,
      stasisLimit,
      stasisLinkedCount: stasisLinked.size,
      labExpected,
      charisma,
      // The finisher and the scouts are told apart by the ORDER's own flag,
      // not by a proxy: a scout mistaken for the finisher would suppress the
      // finisher's re-plan and hold the storm. The last-in-map-order pick
      // among finishers is exactly the pre-scout single-walk shape.
      ...(() => {
        const roles = [...walkVantageRoles()];
        const finisherAt = roles.filter(([, scout]) => !scout).map(([host]) => host).pop();
        const scoutsAt = new Set(roles.filter(([, scout]) => scout).map(([host]) => host));
        return {
          ...(finisherAt !== undefined ? { walkerAt: finisherAt } : {}),
          ...(scoutsAt.size > 0 ? { scoutsAt } : {}),
        };
      })(),
      scoutWalker: true,
      // The party benchmark's pair: one scout 0.905x solo wall-clock, two
      // 0.854x — southern then eastern, the sweep's winning shape.
      maxScouts: 2,
      walkGb: budgets["walk"],
      pinGb: budgets["pin"]!,
      induceGbPerThread: budgets["induce"],
      // The wave budget replaces the old blunt caps: `assign` sizes each
      // target's pushers to close the believed remaining charge to 100% in
      // one 6 s wave and no further, and the frontier's progress criterion
      // admits only bands that reach strictly past our deepest agent.
      migrationCharge,
      aboutToCrack: aboutToCrackNow(at),
      reclaimGb: budgets["reclaim"],
      // Promoted from the reach-the-lab benchmark: with the gang grind, the
      // least grind+walk TOTAL beats raw RAM (0.76x paired, CI excluding 0).
      vantageScoring: "totalTime",
    });
    labCandidateHost = plan.labCandidate;
    if (plan.charismaNeeded !== undefined) charismaNeeded = Math.max(charismaNeeded ?? 0, plan.charismaNeeded);
    const admitted: Record<string, number> = {};
    for (const task of plan.tasks) admitted[task.kind] = (admitted[task.kind] ?? 0) + 1;
    const refused = plan.refused.map((r) => ({ host: r.hostname, why: r.why, detail: r.detail }));
    return {
      tasks: plan.tasks,
      report: { admitted, ...foldRefusals(refused) },
      labWalked: plan.labWalked,
      ...(plan.labCandidate !== undefined ? { labCandidate: plan.labCandidate } : {}),
    };
  };

  // --- filing tasks as orders -----------------------------------------------
  /** A process is on its way to this host — exec'd or spawned, not yet
   * adopted. Bounded so a starter that died in the gap cannot leave the entry
   * looking staffed for ever. */
  /** Is a process genuinely on its way to this host?
   *
   * Two states, both decidable. No pid: the launcher has not exec'd yet and
   * owns the window — it closes it itself, and its order reporting closes it
   * either way. A pid: ask the engine. A process that exists will adopt; one
   * that does not is a ghost and is reaped below.
   *
   * This was a 3s stopwatch, which answered neither question: it held a host
   * out of the plant pool for three seconds after a launch that never started,
   * and dropped a slow-but-real one on the floor. */
  /** Does this pid name a process that is still there? A dead pid and an
   * unanswerable question are the same answer: nothing is running. */
  const running = (pid: number, hostname: string): boolean => {
    if (pid <= 0) return false;
    const borrowed = hands();
    if (borrowed === undefined) return false;
    try { return borrowed["isRunning"](pid, hostname); } catch { return false; }
  };

  const processInbound = (entry: HostEntry): boolean => {
    const inbound = entry.inbound;
    if (inbound === undefined) return false;
    if (inbound.pid !== undefined) return running(inbound.pid, entry.hostname);
    // No pid yet. A plant still owns its window — it exec's, hands us the pid,
    // or calls `abandonPlant` — so nothing here may close it.
    if (inbound.via !== "spawn") return true;
    // A `spawn` yields no pid and kills its announcer, so there is neither a
    // process handle nor a launcher left to close this. But `spawnDelay: 0`
    // runs `runScriptFromScript` SYNCHRONOUSLY, before the caller's
    // `ScriptDeath` and after its RAM is freed — so by the time anything else
    // looks, the successor is already holding its allocation or was refused
    // and never will. The engine's occupancy is the answer; there is nothing
    // to wait for and no window to time out.
    const expect = inbound.expectGb;
    if (expect === undefined) return false;
    const borrowed = lender(entry.hostname);
    if (borrowed === undefined) return false;
    let used: number;
    try { used = borrowed["getServerUsedRam"](entry.hostname); } catch { return false; }
    const prober = entry.prober !== undefined && entry.prober.pid > 0 ? proberReserveGb(entry.hostname) : 0;
    // A hair under, because a thread-scaled override and our price table agree
    // to the byte in principle and to a rounding error in practice.
    return used >= prober + expect - 0.05;
  };

  const fileTask = (task: Task): boolean => {
    // Only a host that can RUN the order may be given it, and there are three
    // ways to be that host:
    //
    //  - a live agent, which will take this off the queue when it finishes;
    //  - a placing window, where a plant has its prober's first report and is
    //    about to `exec` — it hands whatever is staged here straight to that
    //    exec, which is what lets a freshly opened host begin with its own
    //    `ls` and its own frontier instead of booting and adopting first;
    //  - a LENDER, which is all `dispatch` needs to exec a worker itself.
    //
    // The third was missing, and it is the ordinary case. An order clears
    // `entry.agent` when it finishes, so a host that completed its work with
    // an empty queue had no agent, no placing window, and was refused every
    // task from that moment on — reachable only by being re-planted from a
    // neighbour, credential, scp, prober wait and all. That is the prober-only
    // orphan: a perfectly good host sitting beside its lender, unable to be
    // given the very work `dispatch` was standing by to launch.
    const runner = hosts.get(task.from);
    if (!runner) return false;
    if (runner.agent === undefined && !processInbound(runner) && runner.ns === undefined) return false;
    // A mortal scout keeps its prober and its ordinary recovery: only the
    // finisher's host is consumed whole. `scout` is the second discriminant
    // hiding inside `walk`, and it is the ONE thing the kind table cannot say
    // for itself.
    const isScout = task.kind === "walk" && task.scout === true;
    const takesWholeHost = JOBS[task.kind].consumesHost === true && !isScout;
    // A stasis edge is a remote recovery guarantee. Spend that host's RAM on
    // work, not spawn; unpin is the exception because success removes it.
    const controllerManaged = (task.kind === "walk" && !isScout)
      || (stasisLinked.has(task.from) && !(task.kind === "pin" && task.unpin === true));
    const budget = priceOf(task.kind, task.needsRing === true);
    const room = usableGb(task.from, Date.now(), expiryOpts(), !takesWholeHost);
    const threads = threadsFor(room, budget, JOBS[task.kind].threadScaled === true, task.threads ?? 1);
    if (threads < 1 || budget * threads > room) return false;
    // Everything KIND-SPECIFIC about the order, resolved once, here. Only the
    // controller can do this: the vault, the guess table and the host map live
    // with it, and none of them may reach a body any other way.
    //
    // `undefined` means the task cannot be turned into a runnable order —
    // today only a plant whose whole frontier has lost its credentials. The
    // bodies used to carry the equivalent checks ("no cache filename; a job
    // never invents one") and fail at run time, one wasted order later.
    const buildPayload = (): OrderPayloads[TaskKind] | undefined => {
      switch (task.kind) {
        case "bleed":
          return {
            knownHosts: [...hosts.keys()],
            ...(task.followAttemptIds !== undefined ? { followAttemptIds: [...task.followAttemptIds] } : {}),
          };
        case "attempt":
          return {
            knownHosts: [...hosts.keys()],
            ...(task.needsRing === true ? { needsRing: true as const } : {}),
            ...(task.skipInitialBleed === true ? { skipInitialBleed: true as const } : {}),
            ...(task.guessId !== undefined && guessFor.has(task.guessId)
              ? { guess: guessFor.get(task.guessId)! }
              : {}),
          };
        case "plant": {
          // Every per-target fact is resolved HERE, once, so the body never
          // reaches back into the controller for one. A target whose
          // credential has since gone is simply not on the frontier.
          const targets = (task.targets ?? []).flatMap((target) => {
            const credential = vault.get(target.host);
            if (credential === undefined) return [];
            const known = hosts.get(target.host);
            return [{
              host: target.host,
              password: credential.password,
              ...(known?.identity !== undefined ? { identity: known.identity } : {}),
              ...(stasisLinked.has(target.host) ? { controllerManaged: true } : {}),
              ...(target.remote ? { remote: true } : {}),
              ...(target.bootstrapReclaim ? { bootstrapReclaim: true } : {}),
              ...(target.bootstrapThreads !== undefined ? { bootstrapThreads: target.bootstrapThreads } : {}),
              ...(target.omitProber ? { omitProber: true } : {}),
            }];
          });
          return targets.length === 0 ? undefined : { targets, payloads };
        }
        case "reclaim": {
          // Only a SELF reclaim can re-size: the threshold is this host's own
          // capacity, and a remote helper is not sized against it.
          if (task.host !== task.from) return {};
          const maxRam = fresh<number>(hosts.get(task.from), "maxRam", Date.now(), expiryOpts());
          if (maxRam === undefined) return {};
          const threshold = maxRam - proberReserveGb(task.from) - budget * (threads + 1);
          return threshold >= 0 ? { resizeAtBlockedRam: threshold } : {};
        }
        case "cache":
          return task.filename === undefined ? undefined : { filename: task.filename };
        case "promote":
          return task.symbol === undefined ? undefined : { symbol: task.symbol };
        case "relaunchProbe":
          return task.filename === undefined ? undefined : { proberFile: task.filename };
        case "pin":
          return {
            ...(task.edge !== undefined ? { edge: task.edge } : {}),
            ...(task.unpin === true ? { unpin: true as const } : {}),
          };
        case "walk":
          return {
            ...(task.route !== undefined ? { route: task.route } : {}),
            ...(isScout ? { scout: true as const } : {}),
          };
        default:
          return {};
      }
    };
    const payload = buildPayload();
    if (payload === undefined) {
      dbg(`unfileable] ${task.kind} on ${task.host} from ${task.from}: ${task.reason}`);
      return false;
    }
    // Only once the order is certain to be staged: a refused walk that had
    // already killed the prober would leave the lab candidate — the one host
    // `reviveProbers` deliberately skips — blind for good. With the queue cap
    // gone, `stage` refuses one thing only, so this mirrors that one thing.
    const alreadyHere = (runner.staged ?? []).some((o) => o.id === task.id)
      || runner.agent?.order.id === task.id;
    if (takesWholeHost && !alreadyHere) displaceProber(task.from);
    const identity = hosts.get(task.host)?.identity;
    // The ONE cast in the feature. `kind` and `payload` are correlated —
    // narrowing one narrows the other — but TypeScript cannot see that a value
    // built from a union-typed `task.kind` and its matching payload lines up
    // (microsoft/TypeScript#30581). Every READ of the pair is checked; only
    // this construction has to be asserted.
    const order = {
      id: task.id,
      kind: task.kind,
      host: task.host,
      from: task.from,
      ramOverrideGb: budget,
      threads,
      priority: task.priority,
      longLived: JOBS[task.kind].longLived === true,
      label: task.reason,
      payload,
      ...(controllerManaged ? { controllerManaged: true } : {}),
      ...(identity !== undefined ? { targetIdentity: identity } : {}),
    } as Order;
    return stage(runner, order);
  };

  // --- observation ----------------------------------------------------------
  const describeHostLocal = (borrowed: NS, host: string, neighbours?: readonly string[], seenAt = Date.now()): ReportHost => {
    const details = borrowed["dnet"]["getServerDetails"](host);
    if (!details.isOnline) return { hostname: host, at: seenAt, present: false };
    const identity = borrowed["dnsLookup"](host);
    const maxRam = borrowed["getServerMaxRam"](host);
    return {
      hostname: host,
      ...(identity.length > 0 ? { identity } : {}),
      at: seenAt,
      present: true,
      depth: details.depth,
      blockedRam: details.blockedRam,
      requiredCharisma: details.requiredCharismaSkill,
      difficulty: details.difficulty,
      isStationary: details.isStationary,
      modelId: details.modelId,
      passwordLength: details.passwordLength,
      passwordFormat: details.passwordFormat,
      passwordHint: details.passwordHint,
      data: details.data,
      logTrafficInterval: details.logTrafficInterval,
      maxRam,
      ...(neighbours !== undefined ? { neighbours: [...neighbours] } : {}),
    };
  };
  /** Describe a host, or report NOTHING when the call itself failed.
   *
   * `present: false` is a FACT — the engine answered, and the answer was that
   * the host is offline. `absorb` acts on it accordingly: `retireLifetime`
   * tombstones the host permanently AND deletes its credential, because a
   * darknet host that goes is gone for good.
   *
   * A call that THREW is not that fact. It is the absence of one. Fabricating
   * a death out of a failed observation is how a net we hold every key to
   * erases itself: the plant survey describes every vault host in turn, and
   * one throw per host retires all of them — credentials included — before the
   * spread has run once. What is left is the single host a probe happens to be
   * looking at, which is exactly a chain instead of a wave.
   *
   * So: no evidence, no report. The host keeps its entry, keeps its password,
   * and is described again on the next pass. */
  /** Probe ONE host, through the `ns` its prober lent us.
   *
   * `dnet.probe` scans from the CALLING host, so this is the one observation
   * that cannot be batched or made from anywhere else — it is the whole reason
   * a process stands on every host. It used to be the prober's own loop, which
   * is exactly what made its `ns` unlendable: a script blocked in
   * `dnet.nextMutation` holds `env.runningFn` and can lend nothing.
   *
   * A throw means the lender died between the check and the call. Drop the
   * `ns` rather than keep calling a dead one; its `atExit` will say the same
   * thing, and this is simply whichever notices first. */
  const probeThrough = (
    entry: HostEntry,
    pid: number,
    at: number,
    refresh?: DnetProbeRefresh,
  ): void => {
    const borrowed = entry.ns;
    if (borrowed === undefined) return;
    let neighbours: string[];
    try { neighbours = borrowed["dnet"]["probe"](); } catch {
      if (entry.ns === borrowed) entry.ns = undefined;
      return;
    }
    rendezvous.reportProbe(entry.hostname, neighbours, at, pid, refresh);
  };

  /** Every lender, once per mutation. The net changed, so every adjacency we
   * hold is suspect and the whole map is re-probed at once — the same rule the
   * detail sweep follows, and the reason a prober is permanent. */
  const probeEveryLender = (at: number): void => {
    for (const entry of [...hosts.values()]) {
      if (entry.ns === undefined || entry.goneAt !== undefined) continue;
      probeThrough(entry, entry.prober?.pid ?? 0, at);
    }
  };

  /** Describe a host through the hands, or report NOTHING.
   *
   * The controller owns no billable call, so every read is borrowed. This one
   * goes through the HANDS — a single warm lender for the whole net — rather
   * than through the host's own prober: a lender is charged the union of
   * everything ever called through it, so putting the read surface on every
   * prober meant every host in the net paying, for ever, for a call the
   * controller makes centrally. */
  const describeThrough = (host: string, neighbours?: readonly string[], seenAt = Date.now()): ReportHost | undefined => {
    const borrowed = hands();
    // No hands is not a death. Nothing is standing to ask through, so we
    // learned nothing — the same answer a thrown call gets, for the same
    // reason.
    if (borrowed === undefined) return undefined;
    return tryDescribe(borrowed, host, neighbours, seenAt);
  };

  const tryDescribe = (borrowed: NS, host: string, neighbours?: readonly string[], seenAt = Date.now()): ReportHost | undefined => {
    try { return describeHostLocal(borrowed, host, neighbours, seenAt); } catch (error) {
      const message = String((error as { message?: string } | undefined)?.message ?? error);
      // `Invalid host` is the engine's own verdict that this name resolves to
      // NOTHING — absent from the server map and not even remembered in
      // `offlineServers`. That is a death, and the only throw that is one. It
      // is how a torn-down labyrinth host reads, because the shutdown path
      // skips the offline registration for lab names.
      if (message.includes("Invalid host")) return { hostname: host, at: seenAt, present: false };
      // Every other throw is a failure of OURS, not a fact about the host: no
      // darkscape access (which throws for every host in the net, and would
      // otherwise retire all of them in a single pass), or a name that resolves
      // to a live non-darknet server. No evidence, so no report — the host
      // keeps its entry, keeps its password, and is described again next pass.
      // grep `dnet:` to remove.
      dbg(`blind] ${host} could not be described`);
      return undefined;
    }
  };

  /** Probe records already folded. Identity, never a wall-clock watermark: a
   * derive now runs on the turn a fact lands, so two of them share a
   * millisecond routinely, and a `<= lastDrainAt` watermark silently swallowed
   * a probe reported inside the same one — permanently, since the stamp only
   * moves forward. Each `reportProbe` writes a fresh record, so the record IS
   * the identity, and a weak set means a retired host's entry still collects. */
  const foldedProbes = new WeakSet<NonNullable<HostEntry["prober"]>>();
  const drainProbes = (at: number): void => {
    const observed: ReportHost[] = [];
    const newlySeen = new Set<string>();
    const covered = new Set<string>();
    const cover = (h: ReportHost | undefined): void => {
      if (h === undefined) return;
      const known = hosts.get(h.hostname);
      if (h.present && (known === undefined || (h.identity !== undefined && known.identity !== undefined && h.identity !== known.identity))) newlySeen.add(h.hostname);
      observed.push(h);
      covered.add(h.hostname);
    };
    for (const entry of hosts.values()) {
      const probe = entry.prober;
      if (probe === undefined || foldedProbes.has(probe)) continue;
      foldedProbes.add(probe);
      cover(describeThrough(entry.hostname, probe.neighbours, probe.at));
      // grep `dnet:` to remove. The propagation chain is
      // probe -> new connections -> describe them -> plant -> repeat, and this
      // is the link that was invisible: what a probe actually found, and what
      // we already knew about each find. `pw` says the credential is loaded,
      // `off` says `getServerDetails` called it offline — which is what turns
      // into a permanent `[dnet:gone]` one line later.
      for (const neighbour of probe.neighbours) {
        if (hosts.get(neighbour) !== undefined) continue;
        const described = describeThrough(neighbour, undefined, at);
        cover(described);
      }
      dbg(`seen] ${entry.hostname} probed ${probe.neighbours.length} neighbours`);
    }
    if (detailsRefreshDue) {
      detailsRefreshDue = false;
      for (const entry of [...hosts.values()]) {
        if (entry.goneAt !== undefined || entry.hostname === selfHost || covered.has(entry.hostname)) continue;
        cover(describeThrough(entry.hostname, undefined, at));
      }
    }
    if (observed.length > 0) absorb({ id: "probe-drain", kind: "inventory", host: selfHost, from: selfHost, ok: true, hosts: observed });
    for (const h of newlySeen) needsInventory.add(h);
  };

  const drainBootstrapDone = (at: number): void => {
    for (const entry of [...hosts.values()]) {
      const held = entry.bootstrap;
      if (held === undefined) continue;
      if (running(held.pid, entry.hostname)) continue;
      entry.bootstrap = undefined;
      bootstrapDoneSet.add(entry.hostname);
    }
    if (bootstrapDoneSet.size === 0) return;
    const observed = [...bootstrapDoneSet]
      .map((h) => describeThrough(h, undefined, at))
      .filter((h): h is ReportHost => h !== undefined);
    for (const h of bootstrapDoneSet) needsInventory.add(h);
    bootstrapDoneSet.clear();
    if (observed.length > 0) absorb({ id: "bootstrap-done", kind: "inventory", host: selfHost, from: selfHost, ok: true, hosts: observed });
  };

  /** Every prober, on every mutation.
   *
   * A mutation means the net changed, so the whole net is re-probed — that is
   * what a permanent prober on every host is FOR. There is no per-host
   * staleness test: this used to skip any prober whose stamp already post-dated
   * the previous mutation, a fiddly question whose only honest answer just
   * after a mutation is "re-run it", and which silently spared a prober that
   * had reported and then died. */
  const reviveProbers = (): void => {
    if (!probeRefreshDue) return;
    probeRefreshDue = false;
    for (const entry of hosts.values()) {
      const host = entry.hostname;
      if (host === labCandidateHost || entry.agent?.order.kind === "walk") continue;
      if (entry.agent === undefined) continue; // only a host with a resident can re-exec
      if (entry.agent?.order.kind === "relaunchProbe" || (entry.staged ?? []).some((o) => o.kind === "relaunchProbe")) continue;
      fileTask({
        id: `relaunchProbe:${host}`,
        kind: "relaunchProbe",
        host,
        from: host,
        filename: proberFile,
        priority: priorityOf("relaunchProbe"),
        reason: "a mutation reshaped the net; re-establishing this host's adjacency",
      });
    }
  };

  const fileListJobs = (): void => {
    if (needsInventory.size === 0) return;
    for (const host of [...needsInventory]) {
      const entry = hosts.get(host);
      // A host being planted counts: its `ls` is the FIRST thing the arriving
      // agent should do, because the `.d` hint file waiting on it names a
      // neighbour as of the authenticate instant. Filing it inside the placing
      // window is what puts it in the agent's own `exec` instead of a boot,
      // an adopt and a spawn later.
      if (!entry || (entry.agent === undefined && !processInbound(entry))) continue;
      if (entry.agent?.order.kind === "inventory" || (entry.staged ?? []).some((o) => o.kind === "inventory")) { needsInventory.delete(host); continue; }
      const filed = fileTask({ id: `inventory:${host}`, kind: "inventory", host, from: host, priority: priorityOf("inventory"), reason: "files may have changed; listing them" });
      if (filed) needsInventory.delete(host);
    }
  };

  const bootstrapHosts = (): string[] => [...hosts.values()].filter((e) => e.bootstrap !== undefined).map((e) => e.hostname);
  const spreadLimits = () => ({
    ...DEFAULT_SPREAD_LIMITS,
    agentRamGb: residentGb + proberGb,
    residentRamGb: residentGb,
    managedResidentRamGb: priceOf("idle"),
    proberRamGb: proberGb,
    bootstrapRamGb: bootstrapGb,
  });

  /** Targets whose backdoor or stasis fact is fresh enough that remote exec
   * is still believable — the "who may launch" axis. Stasis facts never
   * expire while linked; an ordinary backdoor is trusted only inside its
   * derived restart/delete lifetime (spec/dnet.md:633-637). Shared by the
   * derive pass and urgent rerouting so both admit the same remote plants. */
  const remoteExecSet = (at: number): Set<string> => {
    const set = new Set(stasisLinked);
    const backdoorLife = msPerHostEventAny(["restarted", "deleted"], netDepth ?? DEFAULT_NET_DEPTH, bitNode ?? 15, backdoors.size);
    for (const [hostname, installedAt] of backdoors) {
      const host = hosts.get(hostname);
      if (host !== undefined && host.goneAt === undefined && at - installedAt <= backdoorLife) set.add(hostname);
    }
    return set;
  };


  /** Move an admitted plant off a vantage that cannot take this pass's order.
   *
   * `candidatesFrom` is a pure planner: it picks the vantage that can REACH a
   * target (and, for a remote target, the roomiest by RAM) and knows nothing
   * about what that vantage is already holding. A frontier is grouped by
   * vantage afterwards and its id is `plant:<from>`, so a vantage still
   * carrying an earlier plant cannot accept a second — and since the choice is
   * deterministic, the next derive makes the same one again. A stasis host is
   * the likeliest casualty: remote exec admits ANY resident, so it always
   * lands on the same one.
   *
   * The reassignment is per TARGET and re-derives the route with the vantage,
   * which is why it happens HERE, before grouping, rather than moving a
   * grouped order whose other targets were classified against the vantage it
   * would leave. */
  /** Describe the credentialled hosts no probe will ever name.
   *
   * Discovery is the probe chain's job — probe, describe what is new, plant,
   * repeat — and this is NOT a second copy of it. It covers the one case that
   * chain structurally cannot reach: a host we can exec on WITHOUT being
   * adjacent to it, because it carries a stasis link or a backdoor. Nothing is
   * obliged to be its neighbour, so on a reload its restored credential would
   * sit forever behind `unknown-ram` waiting for an adjacency that never comes.
   *
   * It used to describe every host in the vault on every pass, which is where
   * the reload wave supposedly came from — but `candidatesFrom` still needs a
   * vantage that names the target, so describing a host nothing can reach buys
   * nothing at all. */
  const surveyRemoteTargets = (at: number): void => {
    const expiry = expiryOpts();
    const surveyed: ReportHost[] = [];
    for (const hostname of vault.keys()) {
      if (!stasisLinked.has(hostname) && !backdoors.has(hostname)) continue;
      const entry = hosts.get(hostname);
      if (entry?.goneAt !== undefined || entry?.agent !== undefined) continue;
      if (entry !== undefined && fresh<number>(entry, "maxRam", at, expiry) !== undefined) continue;
      const described = describeThrough(hostname, undefined, at);
      if (described !== undefined) surveyed.push(described);
    }
    if (surveyed.length === 0) return;
    absorb({ id: "remote-survey", kind: "inventory", host: selfHost, from: selfHost, ok: true, hosts: surveyed });
  };

  /** Give every admitted plant the BEST vantage that can reach it.
   *
   * Planting is the only work that grows the set of places we can act FROM, so
   * the chain the whole feature is — plant, probe, discover, plant — stalls
   * entirely wherever one link waits. `candidatesFrom` is a pure planner: it
   * answers "who can REACH this" and takes the first standing host that can,
   * in map-insertion order, knowing nothing about who is free. That routinely
   * put a plant behind a six-second phish while an idle neighbour that could
   * reach the same target sat doing nothing.
   *
   * So: prefer an idle vantage; failing that, take a busy one and let
   * `routeUrgentTasks` displace whatever it is running when the plant is
   * derived, because a plant outranks everything but a walk. Only when nothing
   * can reach the target at all does it keep the planner's choice and refuse.
   *
   * A vantage is NOT spent by taking a target. A plant reaches everything near
   * it: `deriveTasks` groups a vantage's whole frontier into one `plant:<from>`
   * order and `plantOne` runs the targets concurrently, so the second target
   * costs the same call as the first. Marking a vantage spent scattered a
   * frontier one host per vantage — the exact opposite of what the order is
   * for. (`authenticate` and `heartbleed` are the calls that can only face one
   * target at a time, and those are not plants.)
   *
   * Reassignment still re-derives the ROUTE with the vantage: a target
   * reachable adjacently from one vantage and only remotely from another must
   * not carry the first one's classification to the second. */
  const assignPlantVantages = (
    plant: SpreadCandidate[],
    remoteExec: ReadonlySet<string>,
    at: number,
  ): void => {
    const expiry = expiryOpts();
    const plantGb = priceOf("plant");
    const canTake = (host: string): boolean => {
      const entry = hosts.get(host);
      if (entry?.agent === undefined) return false;
      if (ordersHeldBy(entry).some((o) => o.kind === "plant")) return false;
      return usableGb(host, at, expiry) >= plantGb;
    };
    // FREE now means exactly that: with no resident, a host holds a process
    // only while it is running an order.
    const idle = (host: string): boolean => {
      const entry = hosts.get(host);
      return entry !== undefined && entry.ns !== undefined && entry.agent === undefined;
    };

    for (const candidate of plant) {
      const targetNeighbours = fresh<string[]>(hosts.get(candidate.host), "neighbours", at, expiry);
      const routes = new Map<string, "adjacent" | "remote">();
      for (const entry of liveEntries()) {
        if (entry.hostname === candidate.host || !canTake(entry.hostname)) continue;
        const route = classifyPlantRoute({
          target: candidate.host,
          vantage: entry.hostname,
          vantageNeighbours: fresh<string[]>(entry, "neighbours", at, expiry),
          targetNeighbours,
          remoteExecCapable: remoteExec.has(candidate.host),
        });
        if (route !== "ineligible") routes.set(entry.hostname, route);
      }
      if (routes.size === 0) continue;
      // Idle first, then the planner's own pick if it is still available, then
      // anything that can reach it — a busy one is not a wait, it is a
      // preemption waiting to happen.
      const chosen = [...routes.keys()].find(idle)
        ?? (routes.has(candidate.from) ? candidate.from : [...routes.keys()][0]!);
      candidate.from = chosen;
      if (routes.get(chosen) === "remote") candidate.remote = true; else delete candidate.remote;
    }
  };

  /** Close a placing window nothing ever arrived through.
   *
   * The one observable trace of a launch that did not land. `ns.spawn` refused
   * for RAM, an `exec`'d child that died before its first line, a plant killed
   * between `preparePlant` and its resident exec — all three end the same way:
   * an entry that says a process is coming, and no process.
   *
   * `processInbound` already knows: it asks the engine whether the announced
   * process is there, so the host rejoins the plant pool on the very next pass
   * rather than after a window lapses. What this adds is the SAYING — once,
   * out loud, with the size of the order the lost launch was carrying, which
   * is the number that decides whether this was a RAM refusal or something
   * else entirely. Every one of these cost hours to find from the outside. */
  const reapGhostLaunches = (at: number): void => {
    for (const entry of hosts.values()) {
      const inbound = entry.inbound;
      if (inbound === undefined || entry.agent !== undefined) continue;
      // Still the launcher's to close, or a process that really is there.
      if (processInbound(entry)) continue;
      const announced = inbound.at;
      const via = inbound.via;
      entry.inbound = undefined;
      // Whatever this launch was holding dies with it. A barrier left standing
      // would make every later plant on this host await a report nobody is
      // coming to file.
      const barrier = entry.probeRefresh;
      if (barrier !== undefined && entry.probeRefreshPid === undefined) {
        entry.probeRefresh = undefined;
        barrier.settle(undefined);
      }
      const pending = entry.pendingOrder;
      const asked = pending === undefined ? 0 : pending.ramOverrideGb * pending.threads;
      // The ENGINE's own occupancy, not our capacity model — and the fork in
      // the road. `runScriptFromScript` gates on `maxRam - ramUsed`, and a
      // host carrying its prober ALONE says the launch never started, while
      // one carrying prober + an agent-sized block says a process is there and
      // simply never adopted. Those are opposite bugs and nothing else
      // distinguishes them from out here.
      dbg(`ghost] ${entry.hostname} ${via} announced a process ${at - announced}ms ago and nothing adopted`
        + ` — carrying ${pending === undefined ? "nothing" : `${pending.kind} ${asked.toFixed(1)}GB`}`
        + `, room ${durableRoomGb(entry.hostname)?.toFixed(1) ?? "?"}GB`
        + `, prober=${entry.prober?.pid ?? "-"}`
        + `, q=${(entry.staged ?? []).map((o) => o.kind).join("/") || "-"}`);
    }
  };

  /** Release work stranded on a host that has no process to run it.
   *
   * An order only means anything while something can pick it up. When a
   * vantage loses its agent, whatever it was holding stops being IN FLIGHT and
   * becomes a claim nobody will honour — and `projectInFlight` still reports
   * it as `busy`, so `deriveTasks` skips re-deriving that work onto a vantage
   * that could actually run it. A plant stranded this way blocked its target
   * completely: observed empty for twelve seconds with a plant "in flight"
   * from a host holding nothing but its prober.
   *
   * A STASIS host is the exception, and the reason the check is not simply
   * "no agent": it has no spawn, so leaving its order staged IS the hand-off
   * contract — its resident exits on purpose and the controller re-execs it
   * with that order. Same for a host inside its placing window, where the
   * process is already on its way.
   *
   * And the same for a host that still has its LENDER, which is the ordinary
   * case: the prober carries `exec` (and the `connectToSession` that makes it
   * legal), so `dispatch` launches the agent through it. Work queued there is
   * waiting for a launcher that exists — it is not stranded. */
  const releaseStranded = (): void => {
    for (const entry of hosts.values()) {
      if (entry.agent !== undefined || processInbound(entry)) continue;
      if (stasisLinked.has(entry.hostname) || entry.ns !== undefined) continue;
      const stranded = [...(entry.staged ?? []), entry.pendingOrder]
        .filter((order): order is Order => order !== undefined);
      if (stranded.length === 0) continue;
      entry.staged = [];
      entry.pendingOrder = undefined;
      dbg(`strand] ${entry.hostname} agent=- inbound=${entry.inbound === undefined ? "-" : `${Date.now() - entry.inbound.at}ms`}`
        + ` dropping ${stranded.map((o) => `${o.kind}->${o.host}`).join(",")}`);
      for (const order of stranded) {
        retireStaged(order, "cancelled", `stranded on ${entry.hostname}, which has no process to run it`);
      }
    }
  };

  // --- the whole derive pass ------------------------------------------------
  const fileWork = (at: number): Task[] => {
    reapGhostLaunches(at);
    releaseStranded();
    drainBootstrapDone(at);
    drainProbes(at);
    reviveProbers();
    fileListJobs();
    surveyRemoteTargets(at);
    {
      const inFlightNow = projectInFlight();
      const verdicts: string[] = [];
      for (const entry of hosts.values()) {
        if (entry.hostname === selfHost || entry.goneAt !== undefined) continue;
        if (entry.agent !== undefined || !vault.has(entry.hostname)) continue;
        const claim = (inFlightNow.get(entry.hostname) ?? []).find((job) => job.kind === "plant");
        const refusal = lastRefusals.get(entry.hostname);
        const view = planningView(entry, at, expiryOpts());
        verdicts.push(`${entry.hostname}[${claim !== undefined ? `planting<-${claim.from}` : refusal ?? "silent"}`
          + `${entry.inbound !== undefined ? ` in=${at - entry.inbound.at}ms` : ""}`
          + ` p=${entry.prober !== undefined && entry.prober.pid > 0 ? entry.prober.pid : "-"}`
          + ` ram=${view.maxRam ?? "?"}/${view.blockedRam ?? "?"}`
          + ` from=${liveEntries()
            .filter((v) => (fresh<string[]>(v, "neighbours", at, expiryOpts()) ?? []).includes(entry.hostname))
            .map((v) => v.hostname).join(",") || "-"}`
          + ` q=${(entry.staged ?? []).map((o) => o.kind).join("/") || "-"}]`);
      }
      const signature = verdicts.join(" ");
      if (signature !== seen.empty) {
        seen.empty = signature;
        dbg(verdicts.length > 0
          ? `empty n=${verdicts.length}] ${verdicts.join(" ")}`
          : "empty n=0] every cracked host has an agent");
      }
    }
    const remoteExec = remoteExecSet(at);
    // Named, because the refusals below have to tell "nothing can reach this
    // host" apart from "something is already on its way to it". They are the
    // same `continue` inside `candidatesFrom` and opposite problems.
    const standing = new Set([selfHost, ...liveEntries().map((e) => e.hostname), ...bootstrapHosts()]);
    const spreadCandidates = candidatesFrom(knowledge, at, {
      standing,
      vault: new Set(vault.keys()),
      remoteExec,
      remoteVantages: liveEntries().map((e) => ({ host: e.hostname, freeGb: usableGb(e.hostname, at, expiryOpts()) })),
      stasisLinked,
      expiry: expiryOpts(),
    });

    const stormExpiry = expiryOpts();
    const stormHosts = [...hosts.values()].map((entry) => {
      const view = planningView(entry, at, stormExpiry);
      // `view` FIRST and `entry` never: `planningView` expresses staleness by
      // DELETING keys, so spreading it over the raw entry resurrects every one
      // of them — `planStorm` would read a twelve-minute-old `stormSeed`,
      // `caches` or `blockedRam` as a fresh observation and fire into a net it
      // has not actually harvested.
      return {
        ...view,
        agentAlive: entry.agent !== undefined,
        busy: new Set([...(entry.agent !== undefined ? [entry.agent.order.kind] : []), ...(entry.staged ?? []).map((o) => o.kind)]) as ReadonlySet<string>,
      } as DnetHost;
    });

    const seedHolder = stormHosts.find((h) => h.goneAt === undefined && h.stormSeed === true);
    const labWalkedNow = [...hosts.values()].some((entry) => isLabyrinth(entry.hostname, fresh<string>(entry, "modelId", at, stormExpiry)) && vault.has(entry.hostname));
    const seedHunt = seedHolder === undefined && (labWalkedNow || stasisLinked.size >= stasisLimit) && (lastStormFiredAt === undefined || at - lastStormFiredAt > STORM_COOLDOWN_MS);
    // Hold BEFORE farm: the farm's gang grind is aimed at the hold plan's lab
    // candidate, whose block is the last gate before the walker starts.
    const holdPlan = planHold(at);
    hold = holdPlan.report;
    const farmPlan = planFarm(projectFarmHosts(at, expiryOpts()), {
      now: at, charisma, gbPerThread: farmGbPerThread, wantedGb: heaviestJobGb,
      ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
      ...(promoteSymbols.length > 0 ? { promoteSymbols } : {}),
      crimeSuccessMult, openLabCache,
      ...(farmEconomics !== undefined ? { economics: farmEconomics } : {}),
      ...(seedHunt ? { seedHunt: true } : {}),
      ...(holdPlan.labCandidate !== undefined && !labWalkedNow
        ? { gangReclaim: holdPlan.labCandidate }
        : {}),
    });
    const farmAdmitted: Record<string, number> = {};
    for (const task of farmPlan.tasks) farmAdmitted[task.kind] = (farmAdmitted[task.kind] ?? 0) + 1;
    farm = {
      admitted: farmAdmitted,
      ...foldRefusals(farmPlan.refused),
      expectedMoneyPerSec: farmPlan.expectedMoneyPerSec,
      expectedCharismaExpPerSec: farmPlan.expectedCharismaExpPerSec,
      ...(farmPlan.cacheHunter !== undefined ? { cacheHunter: farmPlan.cacheHunter } : {}),
    };

    for (const candidate of spreadCandidates) {
      if (candidate.host === holdPlan.labCandidate && stasisLinked.has(candidate.host)) { candidate.omitProber = true; candidate.reclaimOnly = true; }
    }
    const plan = planSpread(spreadCandidates, spreadLimits(), at);
    assignPlantVantages(plan.plant, remoteExec, at);
    // A host `candidatesFrom` could not route to never reaches `planSpread`,
    // so it would otherwise be absent from the panel entirely — cracked, empty
    // and unexplained. Name it here, where both the routes and the map are in
    // hand, so "why is that green host still empty" is always answerable.
    const routed = new Set(spreadCandidates.map((candidate) => candidate.host));
    const routeless: Refusal[] = [...hosts.values()]
      .filter((entry) => entry.hostname !== selfHost && entry.goneAt === undefined
        && entry.agent === undefined && vault.has(entry.hostname) && !routed.has(entry.hostname))
      .map((entry): Refusal => {
        // A host inside its placing window is skipped for the RIGHT reason —
        // it is being planted — and reporting that as `no-route` is a lie that
        // reads as a routing bug. It sat on the panel beside a `from=` list
        // naming the very vantage that was mid-plant on it.
        if (standing.has(entry.hostname)) {
          return {
            host: entry.hostname,
            why: "launching",
            detail: entry.bootstrap !== undefined
              ? "a local reclaimer holds this host; no resident is planted until it exits"
              : `a process was announced ${at - (entry.inbound?.at ?? at)}ms ago and has not adopted yet`,
          };
        }
        return {
          host: entry.hostname,
          why: "no-route",
          detail: remoteExec.has(entry.hostname)
            ? "remote exec is believable but no resident is standing anywhere to launch from"
            : "no vantage's adjacency still names it, and no fresh backdoor or stasis fact to reach it without one",
        };
      });
    const refusals = [...plan.refused, ...routeless];
    const why: Record<string, string> = {};
    for (const refusal of refusals) why[refusal.host] = refusal.detail;
    lastRefusals.clear();
    for (const refusal of refusals) lastRefusals.set(refusal.host, refusal.why);
    spread = {
      planted: plan.plant.length,
      ...foldRefusals(refusals),
      ...(Object.keys(why).length > 0 ? { why } : {}),
    };

    const pinsPending = holdPlan.tasks.some((t) => t.kind === "pin" && t.unpin !== true) || [...projectInFlight().values()].some((held) => held.some((job) => job.kind === "pin"));
    // The storm's walker gate protects the FINISHER only. The mortal scout is
    // explicitly sacrificial, so neither a running nor a planned scout may
    // hold the fire.
    const walking = new Set(
      [...walkVantageRoles()].filter(([, scout]) => !scout).map(([host]) => host));
    for (const task of holdPlan.tasks) if (task.kind === "walk" && task.scout !== true) walking.add(task.from);
    const walkFrom = [...walking].pop();
    const stormCtx: StormContext = {
      now: at,
      vault: new Set(vault.keys()),
      stasisLinked,
      stasisLimit,
      stasisLinkedCount: stasisLinked.size,
      pinsPending,
      walkInFlight: walkFrom !== undefined,
      walkerPinned: walkFrom !== undefined && stasisLinked.has(walkFrom),
      labWalked: holdPlan.labWalked,
      ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
      ...(lastStormFiredAt !== undefined ? { lastStormFiredAt } : {}),
      // The blocks the farm just refused ON BUDGET do not hold the fire —
      // built from the same plan's refusals so the two rules cannot disagree.
      budgetRefusedBlocks: new Set(
        farmPlan.refused.filter((r) => r.why === "reclaim-not-needed").map((r) => r.host),
      ),
    };
    const stormPlan = planStorm(stormHosts, stormCtx);
    const seedSeenAt = seedHolder !== undefined ? hosts.get(seedHolder.hostname)?.seenAt.files : undefined;
    storm = {
      admitted: stormPlan.fire !== undefined ? 1 : 0,
      ...foldRefusals(stormPlan.refused.map((e) => ({ host: e.hostname, why: e.why, detail: e.detail }))),
      ...(seedHolder !== undefined ? { seedHost: seedHolder.hostname } : {}),
      ...(seedSeenAt !== undefined ? { seedSeenAt } : {}),
      ...(lastStormFiredAt !== undefined ? { firedAt: lastStormFiredAt } : {}),
      ...(seedHunt ? { seedHunt: true } : {}),
    };

    const looseTargets = projectLooseTargets(at, expiryOpts());
    guessFor.clear();
    const guesses: { host: string; id: string; reason: string }[] = [];
    for (const candidate of looseCandidates(loosePool, looseTargets)) {
      if (spentGuesses.has(`${candidate.hostname} ${candidate.password}`)) continue;
      const id = looseId(candidate.password);
      guessFor.set(id, candidate.password);
      guesses.push({ host: candidate.hostname, id, reason: candidate.reason });
    }
    const provisionalLife = msPerHostEvent("deleted", netDepth ?? DEFAULT_NET_DEPTH, bitNode ?? 15, backdoors.size);
    for (let index = provisionalPool.length - 1; index >= 0; index--) {
      const candidate = provisionalPool[index]!;
      const host = hosts.get(candidate.hostname);
      const stale = at - candidate.at > provisionalLife;
      const replaced = candidate.identity !== undefined && host?.identity !== undefined && candidate.identity !== host.identity;
      if (stale || replaced || host?.goneAt !== undefined || vault.has(candidate.hostname)) { provisionalPool.splice(index, 1); continue; }
      if (spentGuesses.has(`${candidate.hostname} ${candidate.password}`)) continue;
      const id = looseId(candidate.password);
      guessFor.set(id, candidate.password);
      guesses.unshift({ host: candidate.hostname, id, reason: `a ${candidate.via} log named this host and password` });
    }

    const tasks = deriveTasks(knowledge, at, {
      ...expiryOpts(),
      charisma,
      inFlight: projectInFlight(),
      agents: new Set([selfHost, ...liveEntries().map((e) => e.hostname)]),
      agentFreeGb: new Map(liveEntries().map((e) => [e.hostname, usableGb(e.hostname, at, expiryOpts())])),
      ...(budgets["attempt"] !== undefined ? { attemptGbPerThread: budgets["attempt"] } : {}),
      ...(budgets["bleed"] !== undefined ? { bleedGbPerThread: budgets["bleed"] } : {}),
      vault: new Set(vault.keys()),
      plantable: plan.plant.map((entry) => ({ host: entry.host, from: entry.from, ...(entry.remote ? { remote: true } : {}), ...(entry.bootstrapReclaim ? { bootstrapReclaim: true } : {}), ...(entry.bootstrapThreads !== undefined ? { bootstrapThreads: entry.bootstrapThreads } : {}), ...(entry.omitProber ? { omitProber: true } : {}) })),
      farm: farmPlan.tasks.map((task) => ({ ...task, ...(task.gang === true ? { perVantage: true } : {}) })),
      hold: [...holdPlan.tasks, ...(stormPlan.fire !== undefined ? [{ kind: "storm" as const, host: stormPlan.fire.host, from: stormPlan.fire.from, reason: stormPlan.fire.reason }] : [])],
      ...(guesses.length > 0 ? { guesses } : {}),
    });
    routeUrgentTasks(tasks, at);
    // Register dependencies before filing anything. Filing wakes live agents,
    // so a very fast authentication must still leave a settled latch behind
    // for the follower that starts later.
    for (const task of tasks) {
      for (const id of task.followAttemptIds ?? []) completionFor(id);
    }
    // Facts first (above), then everything that GROWS the net, then earning on
    // whatever is still idle.
    //
    // The order is the point. `planFarm` is a separate planner and cannot see
    // a pending plant, so filing everything in one pass handed vantages
    // six-second phishes that spreading then had to preempt — the call paid
    // for twice, and the plant delayed by however far into it the engine got.
    // Filing what grows the net first means the farm is offered only hosts
    // that are still free afterwards, which is what "leftovers" was always
    // supposed to mean. Hosts that cannot help spread still farm, and that is
    // where the charisma and money for spreading come from.
    const filed = new Set<string>();
    // grep `dnet:` to remove. Derivation emits every piece of work the facts
    // want; `stage` keeps ONE standing order per vantage and silently drops
    // the rest. That drop is invisible by construction, and it is the whole
    // width of a turn: a vantage with eight uncracked neighbours files one
    // attempt and forgets seven. Count them so "why is the spread a chain
    // rather than a wave" is a number instead of an impression.
    const dropped = new Map<string, string[]>();
    const file = (task: Task): void => {
      let filedTask = task;
      if (task.followAttemptIds !== undefined) {
        const followed = task.followAttemptIds.filter((id) => filed.has(id));
        for (const id of task.followAttemptIds) if (!filed.has(id)) orderDone.delete(id);
        if (followed.length === 0) return;
        filedTask = { ...task, followAttemptIds: followed };
      }
      if (fileTask(filedTask)) { filed.add(task.id); return; }
      const held = dropped.get(task.from) ?? [];
      held.push(`${task.kind}:${task.host}`);
      dropped.set(task.from, held);
    };
    for (const task of tasks) if (!JOBS[task.kind].farm) file(task);
    /** Nothing running and nothing queued: the host is genuinely spare. */
    const spare = (host: string): boolean => {
      const entry = hosts.get(host);
      return entry !== undefined && entry.agent === undefined
        && (entry.staged ?? []).length === 0;
    };
    for (const task of tasks) if (JOBS[task.kind].farm && spare(task.from)) file(task);
    {
      // grep `dnet:` to remove. The shape of a turn in one line, because
      // "the spread is slow" has two opposite causes and they want opposite
      // fixes. NARROW: few uncracked hosts are even reachable, so the net is
      // being discovered a hop at a time and no amount of scheduling helps.
      // THROTTLED: plenty reachable, few running — the vantages are the
      // constraint. `want` counts hosts derivation asked to attempt, `run`
      // counts the attempts actually in flight.
      const live = liveEntries();
      const want = new Set(tasks.filter((t) => t.kind === "attempt").map((t) => t.host));
      let run = 0;
      for (const entry of hosts.values()) {
        if (entry.agent?.order.kind === "attempt") run++;
        run += (entry.staged ?? []).filter((o) => o.kind === "attempt").length;
      }
      const uncracked = [...hosts.values()]
        .filter((e) => e.goneAt === undefined && e.hostname !== selfHost && !vault.has(e.hostname));
      const line = `agents=${live.length} cracked=${vault.size} seen-uncracked=${uncracked.length}`
        + ` want=${want.size} run=${run}`
        + ` idle=${live.filter((e) => e.agent === undefined && (e.staged ?? []).length === 0).length}`;
      if (line !== seen.front) { seen.front = line; dbg(`front] ${line}`); }
    }
    {
      // grep `dnet:` to remove.
      const lines = [...dropped.entries()]
        .filter(([from]) => hosts.get(from)?.agent !== undefined || processInbound(hosts.get(from)!))
        .map(([from, what]) => `${from}<${(hosts.get(from)?.agent?.order.kind) ?? "-"}`
          + `+${(hosts.get(from)?.staged ?? []).map((o) => o.kind).join("/") || "-"}`
          + ` free=${usableGb(from, at, expiryOpts()).toFixed(1)}GB`
          + ` lost ${what.length}: ${what.join(",")}>`);
      const signature = lines.join(" ");
      if (lines.length > 0 && signature !== seen.dropped) {
        seen.dropped = signature;
        dbg(`wide n=${lines.length}] ${lines.join(" ")}`);
      }
    }
    // Every host that is free and holding work. `stage` starts what it files,
    // so this only catches hosts that became free since — a worker exited, a
    // refused launch was put back, a lender arrived on a host that was already
    // holding orders.
    for (const entry of [...hosts.values()]) dispatch(entry);
    return tasks;
  };

  /** When this vantage could START new work: what is left of its active order
   * plus everything already queued ahead of the newcomer.
   *
   * This is what replaced the queue-depth cap. A count says only "busy"; this
   * says how busy, which is the number you need to choose BETWEEN busy
   * vantages instead of refusing them all. An order with no completion
   * estimate is charged a typical duration rather than nothing, so an
   * unmeasurable job cannot make a loaded worker look free. */
  const readyInMs = (entry: HostEntry, at: number): number => {
    const active = entry.agent;
    const activeLeft = active === undefined
      ? 0
      : active.order.expectedDoneAt !== undefined
        ? Math.max(0, active.order.expectedDoneAt - at)
        : TYPICAL_ORDER_MS;
    // Plus the standing order, if there is one. There is at most one — a host
    // keeps its best order, not a backlog — so this is a question about
    // whether, never about how deep.
    const standing = (entry.staged ?? []).length > 0;
    return activeLeft + (standing ? TYPICAL_ORDER_MS : 0);
  };

  const routeUrgentTasks = (tasks: Task[], at: number): void => {
    const expiry = expiryOpts();
    const cancelled = new Set<string>();
    const assigned = new Map<string, number>();
    // Plants are NOT rerouted here. `candidatesFrom` already chose each
    // target's vantage and its route with it, and `deriveTasks` groups a
    // vantage's whole frontier into one order — moving that order elsewhere
    // would move targets whose route was classified against the old vantage.
    // A plant still passes through for the one thing this pass owns:
    // preempting a lesser order to get its slot.
    for (const task of tasks) {
      if (!JOBS[task.kind].reroutable) continue;
      const candidates: PreemptionCandidate[] = [];
      for (const host of task.eligibleFrom ?? [task.from]) {
        const entry = hosts.get(host);
        if (entry === undefined || entry.agent === undefined) continue;
        const active = entry.agent;
        candidates.push(preemptionCandidateFromHandle(host, active, {
          usableGb: usableGb(host, at, expiry),
          readyInMs: readyInMs(entry, at) + (assigned.get(host) ?? 0) * TYPICAL_ORDER_MS,
          ...(assigned.has(host) ? { assigned: assigned.get(host)! } : {}),
          ...(cancelled.has(host) ? { cancelling: true } : {}),
        }));
      }
      const choice = choosePreemptionVantage(task.kind, candidates, at);
      if (choice === undefined) continue;
      if (choice.vantage !== task.from) task.from = choice.vantage;
      assigned.set(choice.vantage, (assigned.get(choice.vantage) ?? 0) + 1);
      if (choice.preempt && !cancelled.has(choice.vantage)) {
        const entry = hosts.get(choice.vantage);
        const active = entry?.agent;
        if (active !== undefined && active.cancelReason === undefined) {
          cancelActive(entry!, `preempted: ${task.kind} on ${task.host} outranks ${active.order.kind}`);
          cancelled.add(choice.vantage);
        }
      }
    }
  };

  const reconcilePending = (at: number): void => {
    const expiry = expiryOpts();
    const staleReason = (order: Order): string | undefined => {
      // A plant is judged per TARGET and never by `order.host`, which names
      // only the first of them: one gone, replaced or already-resident target
      // costs the frontier that stop, and the order dies only when every stop
      // is gone. Judging it by the first retired a whole healthy frontier
      // whenever the host that happened to sort deepest went away.
      if (order.kind === "plant") {
        order.payload.targets = order.payload.targets.filter((target) => {
          const host = hosts.get(target.host);
          if (host === undefined || host.goneAt !== undefined) return false;
          if (target.identity !== undefined && host.identity !== undefined && target.identity !== host.identity) return false;
          return host.agent === undefined;
        });
        return order.payload.targets.length === 0 ? "nothing left on the frontier to reach" : undefined;
      }
      const host = hosts.get(order.host);
      if (!host || host.goneAt !== undefined) return "target is gone";
      if (order.targetIdentity !== undefined && host.identity !== undefined && order.targetIdentity !== host.identity) return "target identity changed";
      if (order.kind === "attempt" && vault.has(order.host)) return "credential already verified";
      if (order.kind === "cache" && !(fresh<string[]>(host, "caches", at, expiry) ?? []).includes(order.payload.filename)) {
        return "cache listing changed";
      }
      return undefined;
    };
    for (const entry of hosts.values()) {
      const keep: Order[] = [];
      for (const order of entry.staged ?? []) {
        const reason = staleReason(order);
        if (reason === undefined) keep.push(order);
        else retireStaged(order, "cancelled", reason);
      }
      entry.staged = keep;
      // The handoff slot goes stale by the same rules. A `pendingOrder` whose
      // spawn died (or whose plant claim keeps failing) is otherwise never
      // inspected again, and `projectInFlight` reads it as busy FOREVER — a
      // plant target silently barred from the plant pool.
      const pending = entry.pendingOrder;
      if (pending !== undefined) {
        const reason = staleReason(pending);
        if (reason !== undefined) {
          entry.pendingOrder = undefined;
          retireStaged(pending, "cancelled", reason);
        } else if (entry.agent === undefined && entry.bootstrap === undefined
          && !processInbound(entry)) {
          // Still a valid order, but nothing is coming to adopt it: its spawn
          // died with it in hand, or the exec was refused. That is the SAME
          // question the placing window answers — is a process on its way —
          // and it is answered by asking the engine, not by waiting out a
          // grace period. Hand the order back; the next resident (or a
          // re-plant) picks it up and runs it at its own price.
          entry.pendingOrder = undefined;
          (entry.staged ??= []).unshift(pending);
        }
      }
    }
  };

  // --- the lab report -------------------------------------------------------
  const labReport = (at: number): DnetLabReport | undefined => {
    const walkers = new Map<string, DnetLabWalker[]>();
    for (const entry of hosts.values()) {
      const agent = entry.agent;
      if (agent === undefined || agent.order.kind !== "walk") continue;
      const held = agent.progress ?? {};
      const list = walkers.get(agent.order.host) ?? [];
      const moves = typeof held["moves"] === "number" ? held["moves"] : 0;
      const walls = typeof held["walls"] === "number" ? held["walls"] : 0;
      const radars = typeof held["radars"] === "number" ? held["radars"] : 0;
      list.push({
        from: entry.hostname,
        ...(typeof held["at"] === "string" ? { at: held["at"] } : {}),
        moves, walls, radars,
        attempts: moves + walls + radars,
        ...(typeof held["believedLeft"] === "number" ? { believedLeft: held["believedLeft"] } : {}),
        startedAt: agent.startedAt ?? at,
        beatAt: agent.beatAt ?? at,
        pinned: stasisLinked.has(entry.hostname),
      });
      walkers.set(agent.order.host, list);
    }
    const host = [...walkers.keys()][0] ?? [...labFields.keys()][0];
    if (host === undefined) return undefined;
    const stage = labStage(host);
    if (stage === undefined) return undefined;
    const prior = labPrior(stage);
    const field = labFields.get(host) ?? emptyField();
    return {
      host,
      width: prior.width,
      height: prior.height,
      grid: renderLabField(field, prior),
      candidates: liveExitCandidates(field, prior),
      exitKnown: field.exit !== undefined,
      walkers: (walkers.get(host) ?? []).sort((a, b) => a.from.localeCompare(b.from)),
    };
  };

  // --- the controller handle ------------------------------------------------
  const rendezvous: ControllerHandle = {
    protocol: DNET_PROTOCOL,
    buildId: launch.buildId,
    generation: mission.generation,
    pid: ns.pid,
    startedAt: bootAt,
    lastBeatAt: bootAt,
    hosts,
    mutationEpoch: 0,
    noteMutation(at) {
      if (at <= mutationTurnAt) return rendezvous.mutationEpoch;
      mutationTurnAt = at;
      rendezvous.mutationEpoch++;
      prevMutationAt = lastMutationAt ?? 0;
      lastMutationAt = at;
      mutationsSeen++;
      mutationSweepDue = true;
      detailsRefreshDue = true;
      probeRefreshDue = true;
      signalDerive();
      // No loop to wake: the controller IS the mutation clock now, so it is
      // already awake in the pass that called this.
      return rendezvous.mutationEpoch;
    },
    wake() { signalDerive(); },
    derived() {
      return new Promise<void>((resolve) => {
        deriveWaiters.push(resolve);
        // The caller has just settled its report, so `onReport` is already
        // queued ahead of this signal's pass and the pass will see it.
        signalDerive();
      });
    },
    adopt(host, handle) {
      const entry = ensureEntry(host);
      agentHostsSeen.add(host);
      entry.inbound = undefined;
      entry.agent = handle;
      {
        orderById.set(handle.order.id, handle.order);
        const completion = orderDone.get(handle.order.id);
        if (completion?.settled) newCompletion(handle.order.id);
      }
      handle.done.then(onReport).catch(() => {});
      signalDerive();
    },
    afterOrders(ids) {
      const completions = ids.map((id) => completionFor(id));
      return Promise.all(completions.map((entry) => entry.promise)).then(() => {
        for (let index = 0; index < ids.length; index++) {
          if (orderDone.get(ids[index]!) === completions[index]) orderDone.delete(ids[index]!);
        }
      });
    },
    beginProbeRefresh(host) {
      const entry = ensureEntry(host);
      if (entry.probeRefresh !== undefined) {
        // A barrier is worth joining while the prober behind it is alive. No
        // pid means the plant that opened it has not exec'd yet and still owns
        // it — it settles the barrier itself if the launch is refused, and
        // `reapGhostLaunches` settles it if the plant dies holding it.
        const pid = entry.probeRefreshPid;
        if (pid === undefined || running(pid, host)) {
          return { refresh: entry.probeRefresh, launch: false };
        }
        // The prober died between exec and settle. Left standing, every later
        // plant on this host would await a report nobody will file — the
        // prober-only orphan loop. This used to be a deadline, which is a
        // guess at the same question the pid answers outright.
        const stale = entry.probeRefresh;
        entry.probeRefresh = undefined;
        entry.probeRefreshPid = undefined;
        stale.settle(undefined);
      }
      let settled = false;
      let resolve!: (report: DnetProbeReport | undefined) => void;
      const refresh: DnetProbeRefresh = {
        refreshed: new Promise<DnetProbeReport | undefined>((done) => { resolve = done; }),
        settle(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        },
      };
      entry.probeRefresh = refresh;
      entry.probeRefreshPid = undefined;
      return { refresh, launch: true };
    },
    cancelProbeRefresh(host, refresh) {
      const entry = hosts.get(host);
      if (entry?.probeRefresh !== refresh) return;
      entry.probeRefresh = undefined;
      refresh.settle(undefined);
    },
    reportProbe(host, neighbours, at, pid, refresh) {
      const entry = ensureEntry(host);
      // A repair launch can race an old process which was merely late, and an
      // older build could already have accumulated duplicates. Whichever
      // prober reports most recently owns the slot; retire the prior PID before
      // publishing the replacement so the invariant converges to one process.
      if (entry.prober?.pid !== pid) killPid(host, entry.prober?.pid);
      entry.prober = { neighbours: [...neighbours], at, pid, epoch: rendezvous.mutationEpoch };
      if (refresh !== undefined && entry.probeRefresh === refresh) {
        entry.probeRefresh = undefined;
        refresh.settle({ host, neighbours: [...neighbours], at, pid });
      }
      signalDerive();
    },
    announceLaunch(host, pid) {
      const entry = hosts.get(host);
      if (entry?.inbound === undefined || pid <= 0) return;
      entry.inbound = { ...entry.inbound, pid };
    },
    announceProbeRefresh(host, pid) {
      const entry = hosts.get(host);
      if (entry?.probeRefresh === undefined || pid <= 0) return;
      entry.probeRefreshPid = pid;
    },
    lend(host, borrowed, pid, refresh) {
      const entry = ensureEntry(host);
      // Whichever prober checked in most recently owns the host. Retire the
      // prior one BEFORE publishing, so the invariant converges to one lender
      // and a late arrival cannot retract a newer one's `ns` on its way out
      // (its `atExit` compares identity).
      if (entry.prober !== undefined && entry.prober.pid > 0 && entry.prober.pid !== pid) {
        killPid(host, entry.prober.pid);
      }
      entry.ns = borrowed;
      probeThrough(entry, pid, Date.now(), refresh);
    },
    preparePlant(host) {
      const entry = ensureEntry(host);
      // FIRST detection only, never a replant.
      //
      // Listing files is owed when the files may have changed: the first time
      // we reach a host, a successful authenticate, a phishing win, a block
      // fully freed. Being planted again is none of those — and on a
      // controller-MANAGED host it is a livelock. That resident has no spawn,
      // so by design it runs whatever is queued and exits for the controller to
      // re-exec; re-arming an inventory on every plant meant there was always
      // something queued, so it exited every time, so the spread replanted it,
      // for ever, at engine speed. `drainProbes` already asks for the `ls` of
      // anything newly seen, so a genuine first plant is still covered.
      if (entry.seenAt.files === undefined) needsInventory.add(host);
      // The placing window opens HERE and closes in `claimPlanted`. Inside it
      // the derive may stage work for a host that has no process yet, because
      // one is on its way and will adopt whatever is waiting.
      entry.inbound = { at: Date.now(), via: "plant" };
      // A live, tracked prober is reusable on ANY host, not only a
      // stasis-managed one. Launching a second prober beside a survivor both
      // wastes its 1.8 GB and — in the band where usableRam admits one prober
      // but not two — makes the resident exec fail with `launch-refused` every
      // 60 s forever, which is exactly the prober-only orphan state observed
      // in play.
      const proberPid = entry.prober?.pid;
      // A live LENDER is the proof a prober is standing, and it is a fact the
      // prober itself published rather than one we polled for.
      return { reuseProber: entry.ns !== undefined && proberPid !== undefined && proberPid > 0 };
    },
    abandonPlant(host) {
      const entry = hosts.get(host);
      if (entry === undefined) return;
      entry.inbound = undefined;
      // The single undo for a placing window, whether or not the claim
      // happened: an order handed to an `exec` that never started has no
      // process coming for it, and left in `pendingOrder` it would be invisible
      // to `reconcilePending` and to the next derive alike.
      const claimed = entry.pendingOrder;
      if (claimed !== undefined) {
        entry.pendingOrder = undefined;
        const staged = entry.staged ??= [];
        const at = staged.findIndex((o) => compareQueuedDnetWork(claimed, o) < 0);
        if (at === -1) staged.push(claimed); else staged.splice(at, 0, claimed);
      }
    },
    claimPlanted(host) {
      const entry = ensureEntry(host);
      // REFRESH the placing window, never close it. Closing it here was an
      // ordering bug: the plant has not exec'd the resident yet, so between
      // this call and that process's `adopt` the host reads agentless AND
      // unclaimed — and the probe that just landed has already woken a derive.
      // That derive saw a `pendingOrder` on a host with no process and did
      // exactly what it is meant to do with one: `releaseStranded` retired the
      // order the plant was three lines from launching. `adopt` closes the
      // window; `abandonPlant` closes it on failure. Nothing else may.
      entry.inbound = { at: Date.now(), via: "plant-exec" };
      // WHAT this window may hand over depends entirely on whether the host
      // can reach its own queue afterwards.
      //
      // A MANAGED (stasis) host cannot: it has no spawn, so a resident that
      // boots and finds work queued clears its own slot and exits, waiting for
      // the controller to re-exec it WITH that order. Refusing to claim it
      // here is therefore not a conservative choice, it is a dead end — the
      // plant boots a bare resident, the resident exits, the host reads empty,
      // and the next derive plants into the same dead end forever. Observed
      // spinning at ~40 derives per round, the host holding its prober alone.
      // So a managed claim takes whatever is queued.
      //
      // An ORDINARY host has its spawn chain and needs no help reaching a
      // heavy order, so it takes only the same-turn housekeeping this window
      // exists for: the `ls` that must run inside the mutation epoch the host
      // was planted in, while its `.d` hint file still names an attributable
      // neighbour. Handing an ordinary plant something heavier only inflates
      // the `exec`'s ask — observed asking 5.7GB for an `induce` and being
      // refused outright, losing the agent entirely to save it one spawn.
      const managed = stasisLinked.has(host);
      const claimable = (order: Order): boolean => managed || isSameTurn(order.kind);
      // A pending order we may not claim is not ours to overwrite either —
      // claiming past it would drop it on the floor.
      if (entry.pendingOrder !== undefined && !claimable(entry.pendingOrder)) return undefined;
      let next = entry.pendingOrder ?? takeNextOrder(entry, claimable);
      if (next !== undefined) {
        // The claim must FIT the host's durable CAPACITY: an order sized when
        // the host was empty can exceed what remains beside a grown block
        // (and the prober), and a claim that cannot exec loops the plant on
        // `launch-refused` forever — the observed prober-only stasis host. A
        // thread-scaled order shrinks to the room; anything else is RETIRED
        // (never re-queued at the head, where it would block a queue only
        // remote plants can drain) so the plant boots the bare managed
        // resident and the next derive files a replacement sized to today's
        // room. CAPACITY, not `getServerUsedRam`: a managed handoff replants
        // in the same instant its predecessor exits, and the engine frees the
        // dead process's RAM one tick later — the live snapshot retired
        // perfectly good claims against that ghost allocation, and the
        // stamped cooldowns left a roomy stasis host prober-only for a minute
        // at a time. Transient overlap is the plant exec's grace to bridge.
        const free = durableRoomGb(host);
        if (free !== undefined && next.ramOverrideGb > 0) {
          if (JOBS[next.kind].threadScaled) {
            const fit = Math.floor(free / next.ramOverrideGb);
            if (fit >= 1 && fit < next.threads) next.threads = fit;
          }
          if (next.ramOverrideGb * next.threads > free) {
            retireStaged(next, "cancelled", `no longer fits ${host} beside its block and prober`);
            entry.pendingOrder = undefined;
            next = undefined;
          }
        }
      }
      if (next === undefined) return undefined;
      if (stasisLinked.has(host)) next.controllerManaged = true;
      entry.pendingOrder = next;
      return next;
    },
    registerBootstrap(host, pid) { ensureEntry(host).bootstrap = { pid, startedAt: Date.now() }; },
    bootstrapDone(host) { const e = hosts.get(host); if (e) e.bootstrap = undefined; bootstrapDoneSet.add(host); signalDerive(); },
    deps,
    snapshot(requestedAt = Date.now()): DnetSnapshot {
      const lab = labReport(requestedAt);
      if (lab !== undefined) lastLab = lab;
      const ramAt = requestedAt;
      // HOME calls `snapshot()` in its OWN process, so every ns call below runs
      // against THIS script's ns from a foreign stack. A controller that has
      // died (darkweb rebooted, an unhandled throw) leaves its rendezvous
      // installed, and the next call then raises OUR ScriptDeath inside home's
      // feature loop — which rethrows ScriptDeath by design and would take home
      // down with us. The sample is a convenience; skipping it is not.
      let ram: DnetRamSnapshot[] = [];
      try {
        ram = [...hosts.values()].flatMap((entry) => {
          const host = entry.hostname;
          const borrowed = hands();
          if (borrowed === undefined) return [];
          const details = borrowed["dnet"]["getServerDetails"](host);
          if (!details.isOnline) return [];
          const total = Math.max(0, borrowed["getServerMaxRam"](host));
          const blocked = Math.max(0, Math.min(details.blockedRam, total));
          // The engine's sample first, our own handles as the answer when it
          // refuses. Occupancy is never simply UNKNOWN: we placed every
          // process on this host and know what each of them costs.
          const occupied = Math.min(total, blocked + heldGb(entry));
          return [{
            host,
            at: ramAt,
            total,
            blocked,
            used: Math.max(0, occupied - blocked),
          }];
        });
      } catch {
        // Only a dead controller reaches here: `getServerDetails` threw OUR
        // ScriptDeath into home's stack. The sample is a convenience.
        ram = [];
      }
      const recovery: DnetRecoveryState = {
        version: DNET_RECOVERY_VERSION,
        generation: mission.generation,
        capturedAt: requestedAt,
        knowledge: recoveryKnowledge(mission.generation, hosts, mutationsSeen),
        vault: [...vault.values()].map(cloneData),
        codes: { ...codes },
        ...(spread ? { spread: cloneData(spread) } : {}),
        ...(farm ? { farm: cloneData(farm) } : {}),
        ...(hold ? { hold: cloneData(hold) } : {}),
        ...(storm ? { storm: cloneData(storm) } : {}),
        ...(lastLab ? { lab: cloneData(lastLab) } : {}),
        stasisSnapshot: { hosts: [...stasisLinked].sort(), at: stasisObservedAt },
        ...(pendingBackdoorInvalidations.size > 0
          ? { backdoorInvalidations: [...pendingBackdoorInvalidations.values()].map(cloneData) }
          : {}),
        ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
        karmaLoss,
        profit: cloneData(profit),
        ...(grammarUnrecognised > 0
          ? { grammar: { unrecognised: grammarUnrecognised, shapes: { ...grammarShapes } } }
          : {}),
        ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
        ...(lastStormFiredAt !== undefined ? { lastStormAt: lastStormFiredAt } : {}),
        unknownModels: { ...unknownModels },
        agentHostsSeen: [...agentHostsSeen].sort(),
        residentsLost,
      };
      return {
        recovery,
        residents: liveEntries().map((entry) => ({
          host: entry.hostname,
          lastBeatAt: entry.agent?.beatAt ?? requestedAt,
          pending: (entry.staged ?? []).length,
          ...(entry.agent !== undefined ? { active: entry.agent.order.kind } : {}),
          freeGb: usableGb(entry.hostname, requestedAt, expiryOpts()),
          completed: entry.completed ?? 0,
          failed: entry.failed ?? 0,
          ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
        })),
        ram,
        controllerBeatAt: rendezvous.lastBeatAt,
      };
    },
    configure(inputs) {
      charisma = inputs.charisma;
      timingProfile = inputs.timing;
      if (inputs.netDepth !== undefined) netDepth = inputs.netDepth;
      if (inputs.bitNode !== undefined) bitNode = inputs.bitNode;
      if (inputs.openLabCache !== undefined) openLabCache = inputs.openLabCache;
      if (inputs.promoteSymbols !== undefined) promoteSymbols = [...inputs.promoteSymbols];
      if (inputs.crimeSuccessMult !== undefined) crimeSuccessMult = inputs.crimeSuccessMult;
      if (inputs.farmEconomics !== undefined) farmEconomics = inputs.farmEconomics;
      if (inputs.fileInvalidations !== undefined) {
        for (const invalidation of inputs.fileInvalidations) {
          const entry = hosts.get(invalidation.host);
          if (entry === undefined || entry.goneAt !== undefined) continue;
          entry.dirty.files = true;
          needsInventory.add(invalidation.host);
        }
        fileListJobs();
        signalDerive();
      }
      if (inputs.backdoors !== undefined) { backdoors.clear(); for (const e of inputs.backdoors) backdoors.set(e.hostname, e.installedAt); }
      if (inputs.stasisLimit !== undefined) stasisLimit = inputs.stasisLimit;
      if (inputs.labExpected !== undefined) labExpected = inputs.labExpected;
      if (inputs.stasisSnapshot !== undefined && inputs.stasisSnapshot.at > stasisObservedAt) {
        stasisObservedAt = inputs.stasisSnapshot.at;
        stasisLinked.clear();
        for (const hostname of inputs.stasisSnapshot.hosts) stasisLinked.add(hostname);
        // A restored link is a durable asset the spread wave must not have to
        // re-DISCOVER, and it needs no seeding of its own: a stasis host worth
        // replanting is one we hold a password for, so the derive's survey
        // describes it along with every other restored credential.
        signalDerive();
      }
      signalDerive();
    },
    standDown() { standDown = true; signalDerive(); },
  };

  // BOOTSTRAP: give the fold darkweb's identity, pre-create its entry.
  foldReports(knowledge, [{ hostname: selfHost, at: bootAt, present: true }], bootAt, expiryOpts());
  ensureEntry(selfHost);
  // HAND OVER: the rendezvous IS the handover. Nothing has to be told.
  //
  // Agents read `live()` fresh on every pass and never hold a controller
  // across an await, so a replacement is picked up on the next thing any of
  // them does. This used to wake every host in the outgoing map as well,
  // because a resident parked on a wake latch held a resolver belonging to the
  // OLD host map and would otherwise have slept against a controller that no
  // longer existed. No agent parks any more — one boots for one order and
  // exits — so there is nobody to wake.
  realm.dnet_controller = rendezvous;
  // ...and CHECK OUT on the way down, however we go down. `atExit` runs on a
  // kill as well as on a clean exit, so this is the one place that can promise
  // it.
  ns.atExit(() => {
    if (realm.dnet_controller === rendezvous) delete realm.dnet_controller;
  }, "dnet-controller-checkout");

  let lastBeat = bootAt;
  while (true) {
    ns.getServerMaxRam(selfHost);
    const at = Date.now();
    derivePass++;
    rendezvous.lastBeatAt = at;

    if (standDown) {
      for (const entry of hosts.values()) {
        for (const o of entry.staged ?? []) retireStaged(o, "cancelled", "controller build retired");
        entry.staged = [];
      }
      if (liveEntries().every((e) => e.agent === undefined)) break;
      await realmSleep(STAND_DOWN_POLL_MS);
      continue;
    }

    if (stormWipeAt !== undefined && at >= stormWipeAt) {
      stormWipeAt = undefined;
      const wiped = stormWipe(knowledge, expiryOpts());
      hosts.clear();
      for (const [k, v] of wiped) hosts.set(k, v);
      lastMutationAt = Math.max(lastMutationAt ?? 0, (lastStormFiredAt ?? at) + STORM_BURST_MS);
    }

    // ONE dead-process pass, two predicates in their original order: the
    // mutation sweep (any tracked pid no longer running) first, then the
    // beat-timeout sweep for idle residents. The predicates never interact
    // across entries, so folding the two back-to-back map walks into one
    // changes the iteration count and nothing else. The watchdog sweep below
    // stays separate: its place AFTER `reconcilePending` is load-bearing.
    const sweepMutations = mutationSweepDue;
    mutationSweepDue = false;
    for (const entry of [...hosts.values()]) {
      if (sweepMutations) {
        const alive = (pid: number | undefined): boolean => {
          // A zeroed pid is not a process. It is a handle that has already run
          // its own exit path, which is the strongest possible evidence that
          // nothing is standing there.
          if (pid === undefined || pid <= 0) return false;
          return running(pid, entry.hostname);
        };
        // The AGENT is what makes a host a vantage, so it is what the sweep
        // asks about. Reading one pid as `agent?.pid ?? prober?.pid` let a
        // zeroed agent handle skip the check entirely — and the map went on
        // drawing a resident standing where no process had stood since.
        // A prober alone still speaks for the entry, but only while its own
        // pid is real: `killWalkHostProber` zeroes that slot deliberately to
        // mark a prober it sacrificed for the walker, and clearing the entry
        // on that would throw away the neighbours the walk is planned from.
        // The PROBER is checked on its own account, whether or not an agent is
        // standing here. `reviveProbers` notices only a stale STAMP, and a
        // stamp goes stale only after a mutation — so a prober that died right
        // after reporting looked fresh for a whole mutation cycle while its
        // host ran blind, holding one script and no adjacency. A pid of 0 is
        // `killWalkHostProber`'s deliberate marker and is left alone.
        if (entry.agent !== undefined && entry.prober !== undefined
          && entry.prober.pid > 0 && !alive(entry.prober.pid)) {
          // Drop the record but keep the neighbours it reported: they are the
          // last thing we knew and `reviveProbers` files the replacement now.
          dbg(`lost] ${entry.hostname} prober pid=${entry.prober.pid} stamp=${at - entry.prober.at}ms`);
          entry.prober = { ...entry.prober, pid: 0, at: 0 };
        }
        const dead = entry.agent !== undefined
          ? !alive(entry.agent.pid)
          : entry.prober !== undefined && entry.prober.pid > 0 && !alive(entry.prober.pid);
        if (dead) {
          dbg(`lost] ${entry.hostname} died`
            + ` agent=${entry.agent === undefined ? "-" : `${entry.agent.order.kind}:${entry.agent.pid}`}`
            + ` prober=${entry.prober?.pid ?? "-"}`);
          // `retireVantage` settles an ACTIVE order with `died`, and `onReport`
          // counts that loss itself — only a bare resident goes uncounted.
          if (entry.agent === undefined) residentsLost++;
          retireVantage(entry.hostname, `${entry.hostname} process died during a mutation`);
          invalidateBackdoor(entry.hostname);
          continue;
        }
      }
      // No resident to sweep for. A host holds a process only while it is
      // running an order, and both ends of that are events: the worker's
      // `atExit` drops its handle, and the prober's drops the lent `ns`. There
      // is nothing left here to infer from a stale stamp.
    }
    reconcilePending(at);
    // Ask expired work to stop. Eligible bodies are killed by the later sweep;
    // pin/walk remain tracked until their atomic/PID-bound work returns.
    for (const entry of hosts.values()) {
      const active = entry.agent;
      if (active === undefined) continue;
      const expired = jobWatchdogExpired(active, at);
      if (expired) {
        // Settling alone only drops OUR handle: the process itself may be
        // perfectly alive, merely slow, and would then hold the host's whole
        // RAM budget for ever while the map reads the host as unstaffed and
        // re-plants it. Ask it to stop, then take the pid.
        cancelActive(entry, `${active.order.label} stopped at a call boundary on ${entry.hostname}`);
      }
    }
    residentsSeenEver = Math.max(residentsSeenEver, liveEntries().length);

    // The watchdog pass: the bounded re-derive over whatever the sweeps above
    // just changed.
    const tasks = fileWork(at);

    if (at - lastBeat >= BEAT_INTERVAL_MS) {
      lastBeat = at;
      TELEMETRY: if (__TELEMETRY__ && tel) {
        tel.mirror(`dnet.controller:${selfHost}`, {
          at, host: selfHost, charisma,
          residents: liveEntries().length,
          residentsSeenEver, residentsLost,
          coverage: coverage(knowledge, at, expiryOpts()),
          tasks: tasks.length,
          queued: liveEntries().map((entry) => ({
            host: entry.hostname,
            pending: (entry.staged ?? []).length,
            active: entry.agent?.order.kind,
            freeGb: usableGb(entry.hostname, at, expiryOpts()),
            completed: entry.completed ?? 0,
            failed: entry.failed ?? 0,
            ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
          })),
        });
      }
    }

    // Wait for the next MUTATION, with a bounded fallback so a quiet net is
    // still swept. Derivation does not wait for either: it already ran, on the
    // turn its fact landed.
    // THE mutation clock, and the only long-lived call in the darknet.
    //
    // It moved here from the prober because a script parked in a Netscript call
    // holds `env.runningFn` and can lend its `ns` to nobody — which is the one
    // thing every prober now exists to do. The controller is the right owner
    // precisely because it has no other call of its own: everything it does to
    // a host it does through a borrowed `ns`, on another script's slot, so
    // being parked here costs it nothing.
    //
    // NOT raced against a watchdog. A race leaves the losing `nextMutation`
    // outstanding, and the next pass's call would throw CONCURRENCY ERROR into
    // the one process that cannot afford to die. The mutation IS the clock;
    // everything fact-driven already runs on `signalDerive`'s microtask without
    // waiting for this at all.
    //
    // ONE `await` is enough, and that is not an accident. `mutateDarknet`
    // resolves this promise FIRST (`triggerNextUpdate()`) and only then applies
    // the moves, deletes and restarts — so a continuation that ran
    // synchronously would observe the world before the mutation. Resolving a
    // promise queues its continuations as microtasks, and `mutateDarknet` has
    // no `await` of its own, so the whole mutation completes and the engine
    // tick unwinds before this line resumes. If an `await` ever appears between
    // that trigger and the mutations, this silently starts reading a stale map.
    // (`webstorm.ts` triggers AFTER its batches instead; both are safe for the
    // same reason.)
    //
    // And a resolve is NOT proof anything changed: past depth 16 the very next
    // line of `mutateDarknet` can return without mutating, and every branch
    // after it is probabilistic. Roughly one tick in sixteen moves nothing. The
    // sweeps below are written to be idempotent for exactly that reason.
    try {
      await ns["dnet"]["nextMutation"]();
    } catch {
      // ScriptDeath on shutdown, or the darkscape gate. Either way there is
      // nothing left to drive.
      break;
    }
    const mutatedAt = Date.now();
    rendezvous.noteMutation(mutatedAt);
    // Every adjacency we hold is now suspect, and `dnet.probe` is host-bound —
    // so the whole map is re-probed through the lenders at once.
    probeEveryLender(mutatedAt);
  }

  if (realm.dnet_controller === rendezvous) delete realm.dnet_controller;
  for (const entry of hosts.values()) {
    entry.probeRefresh?.settle(undefined);
    entry.probeRefresh = undefined;
    const probe = entry.prober;
    if (probe !== undefined && probe.pid > 0 && probe.pid !== ns.pid) killPid(entry.hostname, probe.pid);
  }
  TELEMETRY: if (__TELEMETRY__ && tel) tel.flush();
}

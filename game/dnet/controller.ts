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
import type {
  DnetAgentLaunch,
  DnetControllerLaunch,
  DnetProbeRefresh,
  DnetProbeReport,
  DnetProberLaunch,
} from "./launch.ts";
import {
  coverage,
  discoverReports,
  foldLogDrain,
  foldAttempts,
  foldReports,
  fresh,
  markCredentialKnown,
  planningView,
  stormWipe,
  type DnetHost,
  type DnetHosts,
  type DnetKnowledge,
  type ExpiryOpts,
} from "../../shared/strategy/dnet/host.ts";
import { planArmour, type ArmourCandidate } from "../../shared/strategy/dnet/armour.ts";
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
import { JOBS, TASK_KINDS, fitOrderThreads, isSameTurn, priorityOf } from "../../shared/strategy/dnet/jobs.ts";
import { planFarm, type FarmEconomics, type FarmHost, type FarmKind, type PromoteSymbol } from "../../shared/strategy/dnet/farm.ts";
import { holdHostFrom, planHold as planHoldFromView, type HoldHost, type HoldTask } from "../../shared/strategy/dnet/hold.ts";
import { modelEntry } from "../../shared/strategy/dnet/models.ts";
import { looseCandidates, type LooseTarget } from "../../shared/strategy/dnet/oracle.ts";
import type { PasswordEvidence } from "../../shared/strategy/dnet/evidence.ts";
import { exactNeighbourClueEpoch } from "../../shared/strategy/dnet/file-clues.ts";
import {
  DEFAULT_NET_DEPTH,
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
  renderLabField,
  type LabField,
} from "../../shared/strategy/dnet/maze.ts";
import {
  DNET_PROTOCOL,
  controllerIsLive,
  dnetRealm,
  hostsOf,
  jobWatchdogExpired,
  priceOf,
  PROBER_GB,
  PROBER_ARMOURED_GB,
  PROBER_STASIS_GB,
  SCRIPT_BASE_GB,
  CONTROLLER_GB,
  processSizeFor,
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
import { nsp } from "../lib/ns-proxy-shared.ts";
import { preemptionCandidateFromHandle } from "./priority.ts";
import { emptyDnetProfit, mergeDnetProfit } from "./profit.ts";

/** The darknet controller: one long-lived script that decides and never acts.
 *
 * One `hosts` map holds both what we KNOW about each host and the process
 * RUNNING on it. Orders are staged as data; the agent runs them. Completion is
 * learned the instant an agent's `done` promise settles. The controller
 * observes only through synchronous reads and never blocks. */

const BEAT_INTERVAL_MS = 15_000;
const STAND_DOWN_POLL_MS = 250;
/** Fallback duration used only to compare loaded vantages. */
const TYPICAL_ORDER_MS = 6_000;
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

const RUNTIME_HOST_FIELDS = [
  "agentAlive", "jobFreeGb", "busy", "ns", "prober", "probeRefresh",
  "probeRefreshPid", "agent", "inbound",
  "bootstrap", "staged", "pendingOrder", "wake",
  "completed", "failed", "lastError",
] as const;

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Clone only controller-durable host facts. JSON is intentional: the durable
 * shape is plain data, and any stray function or promise is dropped by
 * omission rather than kept as a live reference to the dying controller. */
function recoveryKnowledge(generation: string, source: ReadonlyMap<string, HostEntry>, mutationsSeen: number): DnetKnowledge {
  const hosts = new Map<string, DnetHost>();
  for (const [hostname, entry] of source) {
    const durable = { ...entry } as Record<string, unknown>;
    for (const field of RUNTIME_HOST_FIELDS) delete durable[field];
    hosts.set(hostname, cloneData(durable as unknown as DnetHost));
  }
  return { generation, mutationsSeen, hosts };
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetControllerLaunch>("dnet-controller", ns.args[0]);
  if (!launch) return;

  const realm = dnetRealm();
  const bootAt = Date.now();
  if (realm.dnet_controller?.buildId === launch.buildId && controllerIsLive(realm.dnet_controller, launch.generation, bootAt)) return;

  const identity: ArtifactIdentity | undefined = launch.identity;
  let tel: ReturnType<typeof initTelemetry> | undefined;
  TELEMETRY: if (__TELEMETRY__) {
    if (identity) tel = initTelemetry(ns, ns.getScriptName(), identity);
  }

  const selfHost = launch.host;
  const agentFile = "dnet/agent.js";
  const proberFile = "dnet/prober.js";
  const payloads = [agentFile, proberFile];
  let charisma = launch.charisma;
  let timingProfile: DnetTimingProfile | undefined;
  let netDepth: number | undefined;
  let bitNode: number | undefined;

  const restored = launch.recovery?.version === DNET_RECOVERY_VERSION
    && launch.recovery.generation === launch.generation
    ? launch.recovery
    : undefined;
  const hosts = new Map<string, HostEntry>(
    [...(restored?.knowledge.hosts ?? [])].map(([hostname, host]) => [
      hostname,
      cloneData(host) as HostEntry,
    ]),
  );
  /** The fold helpers take `DnetHost` values, and a `HostEntry` IS one (its
   * runtime fields are optional), so the same map serves both. */
  const knowledge = hosts as unknown as DnetHosts;
  let mutationsSeen = restored?.knowledge.mutationsSeen ?? 0;
  const vault = new Map<string, VaultEntry>();
  /** Credentials restored from a checkpoint or disk are quarantined until an
   * authoritative details+DNS observation proves the same server lifetime. */
  const pendingVault = new Map<string, VaultEntry>((restored?.vault ?? []).map((entry) => [entry.hostname, cloneData(entry)]));
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
  /** Per-target migration-charge estimate, read back from induce reports.
   * Cleared with the target's identity. */
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
  let residentsSeenEver = 0;
  let residentsLost = restored?.residentsLost ?? 0;
  let standDown = false;
  let mutationTurnAt = -1;
  let mutationSweepDue = false;
  /** A mutation rechecks everything: every host re-described and every prober
   * re-run. Two bits because the two refreshes cost differently —
   * `getServerDetails` is a local read, a probe is a process on the host — and
   * nothing may conflate them. Set by the mutation, cleared by the refresh. */
  let detailsRefreshDue = hosts.size > 0;
  let probeRefreshDue = false;
  let labCandidateHost: string | undefined;
  /** Hosts `planArmour` wants carrying the `spawn` chain. An INTENT, acted on
   *  only at an order boundary — see `resizeProber`. */
  const armourWanted = new Set<string>();

  // --- derive wake ----------------------------------------------------------
  /** Derivation is FACT-driven, not tick-driven.
   *
   * Every write-through — a verified credential, a probe report, an adopted
   * agent, a settled order, a mutation — files its consequences on a microtask,
   * in the same engine turn as the fact. That is what lets a winning
   * `authenticate` reach the vantage's staged queue in the same engine turn as
   * the completed attempt. It has to be that prompt: a `.d` hint
   * file names a neighbour as of the authenticate INSTANT, and
   * `exactNeighbourClueEpoch` discards it the moment a mutation lands between
   * the crack and the new host's first `ls`.
   *
   * A microtask rather than an inline call, so the dozens of write-throughs one
   * order performs collapse into ONE pass and a derive can never re-enter the
   * stack that asked for it.
   *
   * The loop pass below is the watchdog: strictly TIME-driven work (dead-process
   * and beat sweeps, watchdog cancellation, telemetry) plus a bounded re-derive
   * in case a fact was ever missed. */
  let deriveQueued = false;
  const signalDerive = (): void => {
    if (deriveQueued) return;
    deriveQueued = true;
    void Promise.resolve().then(async () => {
      deriveQueued = false;
      try { if (!standDown) await fileWork(Date.now()); } catch {}
    });
  };

  // --- helpers --------------------------------------------------------------
  /** Every host we can act FROM: one with a process, a lent `ns`, or a launch
   * on its way.
   *
   * A vantage is a place we can PUT a process, not a place that happens to have
   * one. The prober makes a host that: it stands for the host's whole life and
   * carries `exec` (plus the `connectToSession` that makes an exec aimed at a
   * neighbour legal), so `dispatch` launches an agent through its lent `ns`
   * whenever there is work. */
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

  const cancelActive = (entry: HostEntry): void => {
    const agent = entry.agent;
    if (agent === undefined) return;
    // A pin is atomic and a walk is PID-bound: neither may be interrupted.
    if (JOBS[agent.order.kind].releaseExempt) return;
    // `release` is the exact tell for WHERE the body is: `awaitDnetOperation`
    // publishes the hook for precisely as long as one engine call is
    // outstanding. Between calls there is nothing to interrupt.
    if (agent.release === undefined) return;
    // Inside an engine call. Releasing the WAIT does not release the CALL —
    // `env.runningFn` stays set until the engine finishes — so a freed body
    // walks into its exit path and throws CONCURRENCY ERROR, leaving no
    // successor. The kill is the engine's own mechanism for this:
    // `killWorkerScript` clears `env.runningFn` BEFORE the atExit handlers and
    // frees the allocation only after, so the victim's `armRespawn` spawns its
    // successor on a clear Netscript slot.
    agent.release();
    killPid(agent.pid);
  };

  /** Settle a STAGED order that never ran (retired before pickup), by running
   * its report side effects directly — there is no agent promise to await. */
  const retireStaged = (order: Order, targetState: Report["targetState"], detail: string): void => {
    onReport({ id: order.id, kind: order.kind, host: order.host, from: order.from, ok: false, ...(targetState ? { targetState } : {}), detail });
  };

  /** Every order an entry is holding: running, pending and staged. The
   * frontier prunes below walk all of them. */
  const ordersHeldBy = (entry: HostEntry): Order[] =>
    [entry.agent?.order, entry.pendingOrder, ...(entry.staged ?? [])]
      .filter((o): o is Order => o !== undefined);

  const retireOrders = (hostname: string, reason: string, applies: (o: Order) => boolean): void => {
    // Per TARGET, not per order: a plant carries a whole frontier, so a dead
    // host costs it one stop and the order dies only when none are left.
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
        cancelActive(entry);
      }
    }
  };
  const retireCracking = (hostname: string, reason: string): void => {
    forgetGuesses(hostname);
    retireOrders(hostname, reason, (o) => o.kind === "attempt");
  };
  /** Kill a process that was ours. Never the controller's own pid, and a throw
   * (host deleted) counts as gone. Fire and forget: nobody reads the result, so
   * the rejection is swallowed rather than left to take the controller down.
   * `kill` on a pid that is already gone is free, so there is no guard. */
  const killPid = (pid: number | undefined): void => {
    if (pid === undefined || pid <= 0 || pid === ns.pid) return;
    void nsp("kill", pid).catch(() => { /* host gone */ });
  };
  const retireVantage = (hostname: string, reason: string, detached?: HostEntry): void => {
    const entry = hosts.get(hostname) ?? detached;
    if (entry !== undefined) {
      entry.inbound = undefined;
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
      // standing alone). Kill it rather than forgetting its pid, so the
      // re-plant starts from an empty host instead of around a stranded 1.8 GB.
      //
      // MARK FIRST. This is a deliberate kill on one of the most-travelled
      // paths there is — every agent death reaches it — and an armoured prober
      // whose death is unmarked reads it as a host restart and spawns a
      // successor a millisecond later, onto the very host we are clearing. That
      // is a 1 ms respawn loop, and it froze the game.
      if (entry.prober !== undefined && entry.prober.pid > 0) entry.proberKillMark = entry.prober.pid;
      killPid(entry.prober?.pid);
      entry.prober = undefined;
      entry.bootstrap = undefined;
    }
    bootstrapDoneSet.delete(hostname);
    needsInventory.delete(hostname);
  };
  const retireLifetime = (hostname: string, reason: string, detached?: HostEntry): void => {
    retireOrders(hostname, reason, () => true);
    retireVantage(hostname, reason, detached);
    vault.delete(hostname);
    pendingVault.delete(hostname);
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
    if (!host) {
      pendingVault.set(entry.hostname, { ...entry });
      signalDerive();
      return;
    }
    const identity = entry.identity ?? host?.identity;
    if (entry.identity !== undefined && host?.identity !== undefined && entry.identity !== host.identity) return;
    const verified = { ...entry, ...(identity !== undefined ? { identity } : {}) };
    vault.set(entry.hostname, verified);
    pendingVault.delete(entry.hostname);
    markCredentialKnown(host);
    removePendingFor(provisionalPool, entry.hostname);
    retireCracking(entry.hostname, "credential verified; cracking retired");
    authenticationEpoch.set(entry.hostname, rendezvous.mutationEpoch);
    // No plant is filed here. The credential IS the fact, and the derive this
    // wakes reaches the same conclusion through the ordinary spread planner —
    // which knows about remote-exec routes, can reroute onto a roomier vantage,
    // and may preempt a lesser order to get there.
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
    if (!host || vault.has(entry.hostname)) return;
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
    if (hosts.get(hostname) === undefined) return;
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
      targetGone: target === undefined,
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
    publishLabField: (host, field) => labFields.set(host, field),
  };

  // --- pricing --------------------------------------------------------------
  const budgets = Object.fromEntries(
    TASK_KINDS.map((kind) => [kind, priceOf(kind)]),
  ) as Record<TaskKind, number>;
  /** What one host's armour costs: the `spawn` chain and nothing else. */
  const ARMOUR_GB = PROBER_ARMOURED_GB - PROBER_GB;

  /** What this host reserves for its prober, which is not one number.
   *
   * - The LAB WALKER keeps none: its prober is displaced outright because the
   *   walk needs every byte and leaves the host empty for `planSpread` anyway.
   * - A STASIS host keeps a topology-only prober. The engine's mutation guard
   *   exempts it (`openServer || isConnectedTo || hasStasisLink`), so it cannot
   *   lose its processes and managed agents are relaunched through `nsp`.
   * - Everything else keeps the full one, because `exec` is the only way a host
   *   that lost its processes gets any back — and, when `planArmour` has armed
   *   it, plus `spawn`, the only call that can outlive a restart of the host it
   *   stands on.
   *
   * This feeds `usableGb`, so bytes a smaller prober does not hold are
   * immediately available to the worker as threads. */
  const proberReserveGb = (host: string): number => {
    if (host === labCandidateHost) return 0;
    if (stasisLinked.has(host)) return PROBER_STASIS_GB;
    // Armour is part of the standing reserve while it is worn: the bytes are
    // held by the prober's `ramOverride` exactly like `exec`'s are, and a
    // planner that did not subtract them would hand a worker threads the host
    // cannot give it.
    return hosts.get(host)?.prober?.armoured === true ? PROBER_ARMOURED_GB : PROBER_GB;
  };
  const heaviestJobGb = Math.max(
    ...TASK_KINDS.filter((kind) => JOBS[kind].routine).map((kind) => budgets[kind] ?? 0));
  const farmGbPerThread: Record<FarmKind, number> = {
    cache: budgets["cache"] ?? budgets["inventory"]!,
    reclaim: budgets["reclaim"] ?? budgets["inventory"]!,
    phish: budgets["phish"] ?? budgets["inventory"]!,
    promote: budgets["promote"] ?? budgets["inventory"]!,
  };
  /** What OUR OWN processes are holding on a host, straight from the handles
   * that placed them. No call, so it cannot fail with the host — which makes it
   * the answer whenever the engine's own occupancy sample is unavailable. */
  const heldGb = (entry: HostEntry): number => {
    const order = entry.agent?.order;
    return (order === undefined ? 0 : order.ramOverrideGb * order.threads)
      + (entry.prober !== undefined && entry.prober.pid > 0 ? proberReserveGb(entry.hostname) : 0)
      + (entry.hostname === selfHost ? CONTROLLER_GB : 0);
  };

  const usableGb = (hostname: string, at: number, expiry: ExpiryOpts, reserveProber = true): number => {
    const host = hosts.get(hostname);
    if (host === undefined) return 0;
    const view = planningView(host, at, expiry);
    if (view.maxRam === undefined) return 0;
    const blocked = view.blockedRam ?? 0;
    // Darkweb keeps the controller beside its prober and current agent.
    // Ordinary hosts keep only the prober; the lab walker keeps neither.
    const fixedReserve = reserveProber ? proberReserveGb(hostname) + (hostname === selfHost ? CONTROLLER_GB : 0) : 0;
    return Math.max(0, view.maxRam - blocked - fixedReserve);
  };
  /** The room a launch on this host actually has: durable capacity less the
   * owner's block and the prober beside it. CAPACITY, never `getServerUsedRam`
   * — a handoff replants in the same instant its predecessor exits and the
   * engine frees that allocation a tick later, so a live snapshot reads a ghost
   * occupancy. Undefined when the host is gone. */
  const durableRoomGb = (host: string): number | undefined => {
    const entry = hosts.get(host);
    if (entry === undefined) return undefined;
    const at = Date.now();
    const expiry = expiryOpts();
    const maxRam = fresh<number>(entry, "maxRam", at, expiry);
    if (maxRam === undefined) return undefined;
    const blocked = fresh<number>(entry, "blockedRam", at, expiry) ?? 0;
    return Math.max(0, maxRam - blocked - proberReserveGb(host));
  };
  const displaceProber = (host: string): void => {
    // The controller host is never a labyrinth walk vantage, so this can never
    // kill infrastructure while making room for a walker.
    if (host === selfHost) return;
    const entry = hosts.get(host);
    const probe = entry?.prober;
    if (probe === undefined || probe.pid <= 0) return;
    // Deliberate: this host is giving its prober slot to a walker or a pin.
    // Mark before the kill, or an armoured prober respawns into the very RAM
    // the displacement just freed.
    entry!.proberKillMark = probe.pid;
    killPid(probe.pid);
    entry!.prober = { ...probe, pid: 0 };
  };

  /** How long a scheduled armour respawn may stay unclaimed.
   *
   * The successor is one macrotask away, so this is not a race budget — it is
   * the answer to "did the spawn fail". It can: the host may have been DELETED
   * in the same storm phase that restarted it, in which case upstream's
   * `spawnCb` finds no server and throws into a timer nobody catches. Generous,
   * because closing the window early costs a duplicate prober while closing it
   * late costs one repair cycle. */
  const PROBER_RESPAWN_GRACE_MS = 2_000;

  /** The shortest interval between two armour respawns on ONE host. See the
   *  backstop in `announceProberRespawn`. */
  const PROBER_RESPAWN_FLOOR_MS = 5_000;

  /** Is an armoured successor still legitimately on its way?
   *
   * Reaps the window when it is not, and RELEASES the launch descriptor with
   * it: a spawn that never landed leaves a live descriptor in the realm map,
   * and nothing else will ever claim it. */
  const proberRespawnPending = (entry: HostEntry, at: number): boolean => {
    const respawn = entry.proberRespawn;
    if (respawn === undefined) return false;
    if (at - respawn.at <= PROBER_RESPAWN_GRACE_MS) return true;
    respawn.withdraw();
    entry.proberRespawn = undefined;
    return false;
  };

  // --- report handling (the promise-driven core) ----------------------------
  const applyHostReports = (reports: readonly ReportHost[], at: number, discovery = false): void => {
    const prior = new Map(reports.map((report) => [report.hostname, hosts.get(report.hostname)]));
    const folded = discovery
      ? discoverReports(knowledge, reports, at, expiryOpts())
      : foldReports(knowledge, reports, at, expiryOpts());
    for (const hostname of folded.hostsReplaced) {
      retireLifetime(hostname, "server identity replaced", prior.get(hostname));
    }
    for (const hostname of folded.hostsRemoved) {
      retireLifetime(hostname, "server is offline", prior.get(hostname));
    }
    for (const report of reports) {
      if (!report.present || report.neighbours === undefined) continue;
      const entry = hosts.get(report.hostname);
      if (entry) {
        retireLostEdgeOrders(entry, report.hostname, report.neighbours);
        retireLostPin(entry, report.hostname, report.neighbours);
      }
    }
  };

  const absorb = (result: Report): void => {
    const at = Date.now();
    if (result.hosts && result.hosts.length > 0) {
      applyHostReports(result.hosts, at);
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

  /** Forget an edge the engine just disproved, in BOTH directions —
   * `candidatesFrom` reads adjacency symmetrically, so leaving either end's
   * list intact leaves the route derivable. Surgical rather than dirtying the
   * whole group: marking the vantage's entire topology unknown would blind it
   * to every OTHER neighbour it still has. */
  const disproveEdge = (vantage: string, target: string): void => {
    for (const [from, to] of [[vantage, target], [target, vantage]] as const) {
      const entry = hosts.get(from);
      const known = entry?.neighbours;
      if (entry === undefined || known === undefined || !known.includes(to)) continue;
      entry.neighbours = known.filter((name) => name !== to);
    }
  };

  const retireLostEdgeOrders = (entry: HostEntry, vantage: string, neighbours: readonly string[]): void => {
    // A REMOTE target does not lose its route when an edge does: it never had
    // one, it has a backdoor.
    const lost = (host: string, remote: boolean): boolean =>
      host !== vantage && !remote && !neighbours.includes(host);
    // A plant carries a whole frontier, and one severed edge costs it one
    // target rather than the order: prune in place, and only an order left with
    // nothing to reach is retired.
    for (const o of ordersHeldBy(entry)) {
      if (o.kind !== "plant" || o.from !== vantage) continue;
      o.payload.targets = o.payload.targets.filter((t) => !lost(t.host, t.remote === true));
    }
    const applies = (o: Order): boolean => o.from === vantage
      && (o.kind === "plant" ? o.payload.targets.length === 0 : lost(o.host, false));
    const staged = entry.staged ?? [];
    const retired = staged.filter(applies);
    if (retired.length > 0) {
      entry.staged = staged.filter((o) => !applies(o));
      for (const o of retired) retireStaged(o, "edge-lost", `${o.host} is no longer adjacent to ${vantage}`);
    }
    if (entry.agent !== undefined && applies(entry.agent.order)) cancelActive(entry);
  };
  const retireLostPin = (entry: HostEntry, host: string, neighbours: readonly string[]): void => {
    const doomed = (o: Order): o is Order & { kind: "pin" } => o.kind === "pin"
      && o.payload.unpin !== true && o.payload.edge !== undefined && !neighbours.includes(o.payload.edge);
    const staged = entry.staged ?? [];
    const retired = staged.filter(doomed);
    if (retired.length === 0) return;
    entry.staged = staged.filter((o) => !doomed(o));
    for (const o of retired) {
      retireStaged(o, "edge-lost",
        `${host}'s edge to ${o.payload.edge} is gone; pin abandoned before spending`);
    }
  };

  const onReport = (report: Report): void => {
    const order = orderById.get(report.id);
    const attributed = order?.targetIdentity === undefined || report.hosts === undefined
      ? report
      : {
        ...report,
        hosts: report.hosts.map((host) => host.hostname === report.host && host.identity === undefined
          ? { ...host, identity: order.targetIdentity }
          : host),
      };
    absorb(attributed);
    // The migration-charge estimate, from the engine's own response readback.
    // A completed move reports 0 (the engine resets on landing); a target's
    // identity death clears it in `retireLifetime`.
    if (report.induceCharge !== undefined) migrationCharge.set(report.host, report.induceCharge);
    const filesInvalidated = report.hosts?.some((host) => host.invalidates?.includes("files")) === true;
    if (filesInvalidated && report.kind !== "inventory") {
      for (const host of report.hosts ?? []) if (host.invalidates?.includes("files")) needsInventory.add(host.hostname);
      signalDerive();
    }
    // An `ls` that did not run leaves the files group dirty for ever, and a
    // host whose cache listing is unknown is refused EVERY farm rung
    // (`cache-unknown` stops the ladder before reclaim). `fileListJobs` clears
    // the request the moment it stages the order, so a staged inventory
    // superseded by a better order — or an active one preempted by a plant —
    // has to re-arm itself here or the host never farms again.
    if (report.kind === "inventory" && report.ok !== true) {
      needsInventory.add(report.host);
      signalDerive();
    }
    const reportedGone = report.hosts?.some((h) => h.hostname === report.host && !h.present) === true;
    if (report.targetState === "gone" && !reportedGone) {
      const gone: ReportHost = {
        hostname: report.host,
        ...(order?.targetIdentity !== undefined ? { identity: order.targetIdentity } : {}),
        at: Date.now(),
        present: false,
      };
      applyHostReports([gone], gone.at);
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
      // A REFUSED EXEC IS AN OBSERVATION. `connectToSession` and `scp` both
      // succeeded and the engine still would not start a process on the target,
      // so the route does not exist: the edge is severed and only a stale
      // neighbour list still names it. Both ends must forget it — adjacency is
      // symmetric, so either end's list can propose the route again. A probe
      // re-establishes the edge if it ever comes back.
      disproveEdge(report.from, report.host);
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
      residentsLost++;
      note(LOCAL_CODE.JobDied);
      const e = hosts.get(report.from);
      if (e && e.agent?.order.id === report.id) e.agent = undefined;
      invalidateBackdoor(report.from);
      signalDerive();
    } else if (report.ok === false && report.targetState === undefined) {
      note(LOCAL_CODE.JobDied);
    }
    // Per-host work accounting, for the panel and the beat. A retired staged
    // order never reports and therefore never reaches this path.
    const runner = hosts.get(report.from);
    if (runner !== undefined) {
      if (report.ok) runner.completed = (runner.completed ?? 0) + 1;
      else {
        runner.failed = (runner.failed ?? 0) + 1;
        if (report.detail !== undefined) runner.lastError = report.detail.slice(0, 200);
      }
    }
    orderById.delete(report.id);
    settleCompletion(report.id);
    // A queued successor needs no new planning: atExit wakes dispatch after
    // this process frees its RAM. Replan only when this vantage ran dry; facts
    // that open work elsewhere wake the controller themselves.
    if (report.died !== true && (hosts.get(report.from)?.staged ?? []).length === 0) {
      signalDerive();
    }
  };

  /** Bring this host's prober to the size `planArmour` wants, if now is the
   * moment and the host can afford the changeover. Returns true when a
   * replacement was launched, which costs the caller this turn.
   *
   * There is no kill-then-relaunch here, and that is the point: the OLD prober
   * execs the new one, and `lend` retires the old pid when the new one checks
   * in. So the host is never without a lender, and the only cost is holding
   * both allocations for the width of a boot.
   *
   * Refusing on RAM is not a failure. Hosts arm as their orders turn over, and
   * a fleet that is only half armoured when a storm lands still re-cascades
   * from every survivor — each one's `exec` reaches its own neighbours. */
  const resizeProber = (entry: HostEntry, borrowed: NS): boolean => {
    const host = entry.hostname;
    const prober = entry.prober;
    if (prober === undefined || prober.pid <= 0) return false;
    // A stasis host is exempt from restart and the lab candidate holds no
    // prober; neither has an armour question to answer.
    if (host === labCandidateHost || stasisLinked.has(host)) return false;
    const now = Date.now();
    if (proberRespawnPending(entry, now)) return false;
    const wanted = armourWanted.has(host);
    if (wanted === (prober.armoured === true)) return false;
    // One resize in flight at a time. `exec` returning a pid only proves the
    // process was admitted; if it dies before it lends, the size never changes
    // and every subsequent dispatch would exec another one. Bounded retry
    // rather than a latch, so a genuinely lost launch still heals.
    if (entry.proberResizeAt !== undefined && now - entry.proberResizeAt <= PROBER_RESPAWN_GRACE_MS) {
      return false;
    }
    const targetGb = wanted ? PROBER_ARMOURED_GB : PROBER_GB;
    // Room for the SECOND prober, on top of everything already standing. The
    // incumbent is still holding its own reserve, which `heldGb` counts.
    const expiry = expiryOpts();
    const maxRam = fresh<number>(entry, "maxRam", now, expiry);
    if (maxRam === undefined) return false;
    const free = maxRam - (fresh<number>(entry, "blockedRam", now, expiry) ?? 0) - heldGb(entry);
    if (free < targetGb) return false;
    const offer = offerLaunch<DnetProberLaunch>({ kind: "dnet-prober", host, armoured: wanted });
    let pid = 0;
    try {
      pid = borrowed["exec"](
        proberFile, host, temporaryRunOptions({ threads: 1, ramOverride: targetGb }), offer.launchId,
      );
    } catch { pid = 0; }
    if (pid === 0) {
      offer.withdraw();
      return false;
    }
    entry.proberResizeAt = now;
    return true;
  };

  /** Re-fit a queued order against the host at the last responsible moment.
   * Armour and owner-block RAM may have changed since derivation sized it. */
  const fitQueuedOrder = (entry: HostEntry, order: Order): boolean => {
    const room = durableRoomGb(entry.hostname);
    if (room === undefined) return false;
    const fitted = fitOrderThreads(order.kind, order.threads, order.ramOverrideGb, room);
    if (fitted < 1) {
      retireStaged(order, "cancelled", `no longer fits ${entry.hostname} beside its current block and prober`);
      return false;
    }
    order.threads = fitted;
    return true;
  };

  const restoreRefusedLaunch = (entry: HostEntry, order: Order, offer: { withdraw(): void }): void => {
    offer.withdraw();
    if (entry.pendingOrder === order) entry.pendingOrder = undefined;
    entry.inbound = undefined;
    const staged = entry.staged ??= [];
    if (!staged.some((held) => held.id === order.id)) staged.unshift(order);
  };

  /** START the next staged order on an ordinary host, through its lender.
   *
   * The launcher is the prober, not the worker: `exec` once per host instead of
   * `spawn` once per THREAD, which would charge 2 GB on every thread for a
   * handoff one of them performs once.
   *
   * `offerLaunch` publishes the descriptor without waiting to be captured: the
   * worker's own `adopt` is the acknowledgement, and a launch that never adopts
   * is reaped by pid.
   *
   * Synchronous throughout, which is what makes it safe to call from `stage` —
   * two dispatches for the same host cannot interleave. */
  const dispatchLocal = (entry: HostEntry): void => {
    if (entry.agent !== undefined || processInbound(entry)) return;
    if (standDown) return;
    if (stasisLinked.has(entry.hostname)) return;
    const borrowed = entry.ns;
    if (borrowed === undefined) return;
    // THE ORDER BOUNDARY, and the only place a prober can change size.
    //
    // Each agent runs one order and exits. This boundary, after the previous
    // allocation is gone and before the next launch, is the safe time to resize
    // the prober without interrupting work.
    //
    // It costs this host one dispatch turn. `reportProbe` signals a derive when
    // the replacement checks in, so the order that was waiting goes out on the
    // very next pass rather than on a timer.
    if (resizeProber(entry, borrowed)) return;
    const next = takeNextOrder(entry);
    if (next === undefined) return;
    if (!fitQueuedOrder(entry, next)) return;
    entry.pendingOrder = next;
    entry.inbound = { at: Date.now(), via: "plant-exec" };
    const offer = offerLaunch<DnetAgentLaunch>({ kind: "dnet-agent", host: entry.hostname });
    let pid = 0;
    try {
      pid = borrowed["exec"](
        agentFile,
        entry.hostname,
        temporaryRunOptions(processSizeFor(next, next.ramOverrideGb)),
        offer.launchId,
      );
    } catch { pid = 0; }
    if (pid === 0) {
      // Nothing started. Put the order back where the next pass will find it
      // rather than leaving it in a handoff slot nobody is coming for.
      restoreRefusedLaunch(entry, next, offer);
      return;
    }
    entry.inbound = { ...entry.inbound, pid };
  };

  /** A stasis prober deliberately carries no `exec`. Start its next body from
   * the shared ns resident instead: connectToSession and exec must run on ONE
   * PID, because the session belongs to the caller. `guaranteeFit` prepays and
   * locks that pair; retries cover an externally killed resident and the
   * engine's transient zero while a prior allocation is being reaped. */
  const MANAGED_DISPATCH_ATTEMPTS = 3;
  const dispatchManaged = async (entry: HostEntry): Promise<void> => {
    if (!stasisLinked.has(entry.hostname)) return;
    if (entry.agent !== undefined || processInbound(entry) || standDown) return;
    // Keep the permanent topology observer beside the managed body. A missing
    // prober is repaired by spreading; launching work alone would leave the
    // host unable to reveal or validate its neighbour edges.
    if (entry.ns === undefined || entry.prober === undefined || entry.prober.pid <= 0) return;
    const credential = vault.get(entry.hostname);
    if (credential === undefined) return;
    const next = takeNextOrder(entry);
    if (next === undefined) return;
    if (!fitQueuedOrder(entry, next)) return;

    entry.pendingOrder = next;
    entry.inbound = { at: Date.now(), via: "plant-exec" };
    const offer = offerLaunch<DnetAgentLaunch>({ kind: "dnet-agent", host: entry.hostname });
    let pid = 0;
    let failureCode = 0;
    for (let attempt = 0; attempt < MANAGED_DISPATCH_ATTEMPTS && pid === 0; attempt++) {
      try {
        const outcome = await nsp.guaranteeFit(
          ["dnet.connectToSession", "exec"],
          async (resident) => {
            const connected = await resident("dnet.connectToSession", entry.hostname, credential.password);
            if (!connected.success) return { pid: 0, code: connected.code };
            const launched = await resident(
              "exec",
              agentFile,
              entry.hostname,
              temporaryRunOptions(processSizeFor(next, next.ramOverrideGb)),
              offer.launchId,
            );
            return { pid: launched, code: launched === 0 ? 0 : 200 };
          },
        );
        pid = outcome.pid;
        failureCode = outcome.code;
        if (failureCode === 401 || failureCode === 503) break;
      } catch {
        // The whole authority pair is the retry unit. A resident killed from
        // outside the proxy loses its PID-bound session with it.
      }
    }

    if (pid > 0) {
      if (entry.agent === undefined) entry.inbound = { ...(entry.inbound ?? { at: Date.now(), via: "plant-exec" }), pid };
      return;
    }

    restoreRefusedLaunch(entry, next, offer);
    if (failureCode === 503) {
      retireLifetime(entry.hostname, "stasis target was unavailable during managed dispatch");
    } else if (failureCode === 401) {
      // This order cannot be launched remotely without the rejected password;
      // retire it rather than preserve a queue that can never drain.
      const staged = entry.staged ?? [];
      entry.staged = staged.filter((held) => held.id !== next.id);
      retireStaged(next, "cancelled", "credential rejected during managed dispatch");
      retireRejectedCredential(entry.hostname);
    }
  };

  const stage = (entry: HostEntry, order: Order): boolean => {
    const staged = entry.staged ??= [];
    if (staged.some((o) => o.id === order.id) || entry.agent?.order.id === order.id) return false;
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
    // `compareQueuedDnetWork` already decides what displaces what, and
    // derivation is structurally deduped, so anything dropped here comes back
    // the moment it is still wanted.
    const standing = staged[0];
    if (standing !== undefined) {
      if (compareQueuedDnetWork(order, standing) >= 0) return false;
      staged.splice(staged.indexOf(standing), 1);
      retireStaged(standing, "cancelled", `superseded by ${order.kind}; a host runs its best order, not a queue`);
    }
    staged.push(order);
    // Staging and starting are one act. The controller holds the launcher, so
    // the only reason not to start is that the host is already busy — which
    // each dispatch path checks for itself.
    if (!stasisLinked.has(entry.hostname)) dispatchLocal(entry);
    return true;
  };

  // --- projections (HoldHost / FarmHost from the flat entries) --------------
  /** The host with the single walk running or staged. */
  const walkVantage = (): string | undefined => {
    for (const entry of hosts.values()) {
      const active = entry.agent?.order;
      if (active?.kind === "walk" || entry.staged?.some((order) => order.kind === "walk")) {
        return entry.hostname;
      }
    }
    return undefined;
  };

  const projectHoldHosts = (at: number, expiry: ExpiryOpts): HoldHost[] => {
    const walkerAt = walkVantage();
    return [...hosts.values()].map((entry) => {
      const view = planningView(entry, at, expiry);
      return {
        // The shared core projection home also uses, so the two sides can never
        // derive the same record differently.
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
        ...(walkerAt === entry.hostname ? { irreplaceable: true } : {}),
      };
    });
  };

  const projectInFlight = (): Map<string, { from: string; kind: TaskKind }[]> => {
    const projected = new Map<string, { from: string; kind: TaskKind }[]>();
    for (const entry of hosts.values()) {
      const orders: Order[] = [];
      if (entry.agent !== undefined) orders.push(entry.agent.order);
      // The CLAIMED order counts too. `preparePlant` holds it here for the whole
      // length of a plant, and a target invisible to `busy()` for those seconds
      // gets the same work derived again onto a second vantage.
      if (entry.pendingOrder !== undefined && entry.pendingOrder.id !== entry.agent?.order.id) {
        orders.push(entry.pendingOrder);
      }
      orders.push(...(entry.staged ?? []));
      for (const o of orders) {
        // A plant claims its WHOLE frontier, not just `order.host`.
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
        ...(view.caches !== undefined ? { caches: view.caches } : {}),
        isLab: isLabyrinth(entry.hostname, view.modelId),
        busy,
      });
    }
    for (const entry of hosts.values()) {
      if (entry.agent !== undefined || entry.bootstrap !== undefined || !vault.has(entry.hostname)) continue;
      const view = planningView(entry, at, expiry);
      if (view.blockedRam === undefined || view.blockedRam <= 0) continue;
      if (view.isStationary === true) continue;
      const busy = new Set<FarmKind>();
      for (const job of inFlight.get(entry.hostname) ?? []) if (job.kind === "reclaim") busy.add("reclaim");
      farmHosts.push({
        host: entry.hostname,
        ...(view.depth !== undefined ? { depth: view.depth } : {}),
        ...(view.difficulty !== undefined ? { difficulty: view.difficulty } : {}),
        blockedRam: view.blockedRam,
        hasCredential: true,
        freeGb: 0,
        reclaimOnly: true,
        busy,
      });
    }
    return farmHosts;
  };

  // --- the walk / pins / hold plan ------------------------------------------
  // The decisions live in `hold.ts` (`planHold`/`planWalk`/`admitPins`) as pure
  // functions of the projected view; this wrapper only projects, hands over the
  // scalars the controller alone knows, and folds the report.
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
      if (target === undefined) continue;
      const list = modelEntry(target.modelId)?.candidates?.({
        passwordLength: target.passwordLength,
        passwordFormat: target.passwordFormat,
        passwordHint: target.passwordHint,
        data: target.data,
        difficulty: target.difficulty,
      });
      if (list === undefined) continue;
      if (list.length - (target.attempts?.tried ?? 0) === 1) {
        // `expectedDoneAt` is stamped only while a call is in flight AND its
        // delay is believable, so it is routinely absent mid-order. Absent must
        // read as "a whole call still to run", never as zero — zero releases
        // the wave-closing landing, whose edge re-roll kills the very
        // authenticate this pipeline protects.
        out.set(order.host, order.expectedDoneAt === undefined
          ? INDUCE_WAIT_MS
          : Math.max(0, order.expectedDoneAt - at));
      }
    }
    return out;
  };

  const planHold = (at: number, expiry: ExpiryOpts): { tasks: HoldTask[]; report: DnetHoldReport; labWalked: boolean; labCandidate?: string } => {
    const walkerAt = walkVantage();
    const plan = planHoldFromView({
      hosts: projectHoldHosts(at, expiry),
      netDepth: netDepth ?? DEFAULT_NET_DEPTH,
      stasisLimit,
      stasisLinkedCount: stasisLinked.size,
      labExpected,
      charisma,
      ...(walkerAt !== undefined ? { walkerAt } : {}),
      walkGb: budgets["walk"],
      pinGb: budgets["pin"]!,
      induceGbPerThread: budgets["induce"],
      // `assign` sizes each target's pushers to close the believed remaining
      // charge to 100% in one 6 s wave and no further, and the frontier's
      // progress criterion admits only bands reaching past our deepest agent.
      migrationCharge,
      aboutToCrack: aboutToCrackNow(at),
      reclaimGb: budgets["reclaim"],
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
  /** Does this pid name a process that is still there? A dead pid and an
   * unanswerable question are the same answer: nothing is running. */
  const running = async (pid: number, hostname: string): Promise<boolean> => {
    if (pid <= 0) return false;
    try { return await nsp("isRunning", pid, hostname); } catch { return false; }
  };

  /** Pids the engine said were alive at the top of THIS derive pass.
   *
   * `processInbound` is asked from synchronous scheduling code throughout —
   * `liveEntries`, `fileTask`, `dispatch`, `releaseStranded`, several `.filter`
   * callbacks. It may NOT become async: a promise is truthy, so every one of
   * those filters would silently admit every host. So the read is batched: one
   * pass asks about every announced pid at once and the answers serve the whole
   * pass, which is what a derive should be anyway — one consistent view. */
  let livePids = new Map<string, boolean>();
  const livenessKey = (pid: number, host: string): string => `${pid}@${host}`;

  const refreshLiveness = async (): Promise<void> => {
    const asked: { pid: number; host: string }[] = [];
    for (const entry of hosts.values()) {
      const pid = entry.inbound?.pid;
      if (pid !== undefined) asked.push({ pid, host: entry.hostname });
    }
    const answers = await Promise.all(
      asked.map(async ({ pid, host }) => [livenessKey(pid, host), await running(pid, host)] as const),
    );
    livePids = new Map(answers);
  };

  const processInbound = (entry: HostEntry): boolean => {
    const inbound = entry.inbound;
    if (inbound === undefined) return false;
    // An announced pid we have not asked about yet is still ON ITS WAY. That is
    // the conservative answer: it keeps a second launch off a host that already
    // has one coming, which is the only thing this guard exists to prevent.
    if (inbound.pid !== undefined) return livePids.get(livenessKey(inbound.pid, entry.hostname)) ?? true;
    return true;
  };

  const fileTask = (task: Task): boolean => {
    // Only a host that can RUN the order may be given it: one with a live
    // agent, one inside a placing window, or — the ordinary case — one with a
    // LENDER, which is all `dispatch` needs to exec a worker itself.
    const runner = hosts.get(task.from);
    if (!runner) return false;
    if (runner.agent === undefined && !processInbound(runner) && runner.ns === undefined) return false;
    const takesWholeHost = JOBS[task.kind].consumesHost === true;
    // A stasis edge is a remote recovery guarantee. Spend that host's RAM on
    // work, not spawn; unpin is the exception because success removes it.
    const controllerManaged = task.kind === "walk"
      || (stasisLinked.has(task.from) && !(task.kind === "pin" && task.unpin === true));
    const budget = priceOf(task.kind, task.needsRing === true);
    const room = usableGb(task.from, Date.now(), expiryOpts(), !takesWholeHost);
    const threads = threadsFor(room, budget, JOBS[task.kind].threadScaled === true, task.threads ?? 1);
    if (threads < 1 || budget * threads > room) return false;
    // Everything KIND-SPECIFIC about the order, resolved once, here. Only the
    // controller can: the vault, the guess table and the host map live with it,
    // and none of them may reach a body any other way. `undefined` means the
    // task cannot become a runnable order — today only a plant whose whole
    // frontier has lost its credentials.
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
          return {};
        default:
          return {};
      }
    };
    const payload = buildPayload();
    if (payload === undefined) return false;
    // Only once the order is certain to be staged: a refused walk that had
    // already killed the prober would leave the lab candidate — the one host
    // `reviveProbers` deliberately skips — blind for good.
    const alreadyHere = (runner.staged ?? []).some((o) => o.id === task.id)
      || runner.agent?.order.id === task.id;
    if (takesWholeHost && !alreadyHere) displaceProber(task.from);
    const identity = hosts.get(task.host)?.identity;
    // `kind` and `payload` are correlated — narrowing one narrows the other —
    // but TypeScript cannot see that a value built from a union-typed
    // `task.kind` and its matching payload lines up (TypeScript#30581). Every
    // READ of the pair is checked; only this construction is asserted.
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
  /** Probe ONE host, through the `ns` its prober lent us.
   *
   * `dnet.probe` scans from the CALLING host, so this is the one observation
   * that cannot be batched or made from anywhere else — it is the whole reason
   * a process stands on every host. It cannot be the prober's own loop either:
   * a script blocked in `dnet.nextMutation` holds `env.runningFn` and can lend
   * nothing.
   *
   * A throw means the lender died between the check and the call. Drop the `ns`
   * rather than keep calling a dead one. */
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

  /** Every lender, once per mutation: the net changed, so every adjacency we
   * hold is suspect and the whole map is re-probed at once. This is why a
   * prober is permanent. */
  const probeEveryLender = (at: number): void => {
    for (const entry of [...hosts.values()]) {
      if (entry.ns === undefined) continue;
      probeThrough(entry, entry.prober?.pid ?? 0, at);
    }
  };

  /** Describe a host, or report NOTHING.
   *
   * `dnet.getServerDetails`, `dnsLookup` and `getServerMaxRam` are all GLOBAL —
   * they work on any host from anywhere — so they go to the shared ns resident
   * rather than to this host's prober. A lender is charged the union of
   * everything ever called through it, so putting this read surface on every
   * prober would make every host in the net pay for a call made centrally. */
  const describeThrough = async (host: string, neighbours?: readonly string[], seenAt = Date.now()): Promise<ReportHost | undefined> => {
    try {
      const details = await nsp("dnet.getServerDetails", host);
      if (!details.isOnline) return { hostname: host, at: seenAt, present: false };
      const identity = await nsp("dnsLookup", host);
      const maxRam = await nsp("getServerMaxRam", host);
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
    } catch (error) {
      const message = String((error as { message?: string } | undefined)?.message ?? error);
      // `Invalid host` is the engine's verdict that this name resolves to
      // NOTHING — absent from the server map and not even in `offlineServers`.
      // That is a death, and the only throw that is one. It is how a torn-down
      // labyrinth host reads: the shutdown path skips offline registration for
      // lab names.
      if (message.includes("Invalid host")) return { hostname: host, at: seenAt, present: false };
      // Every other throw is a failure of OURS, not a fact about the host: no
      // darkscape access (which throws for every host at once, and would
      // otherwise retire all of them in a single pass), or a name that resolves
      // to a live non-darknet server. No evidence, so no report — the host
      // keeps its entry and its password, and is described again next pass.
      return undefined;
    }
  };

  /** Probe records already folded — by IDENTITY, never a wall-clock watermark.
   * A derive runs on the turn a fact lands, so two routinely share a
   * millisecond and a `<= lastDrainAt` stamp swallowed a probe reported inside
   * the same one, permanently. Weak, so a retired host's entry still collects. */
  const foldedProbes = new WeakSet<NonNullable<HostEntry["prober"]>>();
  const drainProbes = async (at: number): Promise<void> => {
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
      cover(await describeThrough(entry.hostname, probe.neighbours, probe.at));
      for (const neighbour of probe.neighbours) {
        if (hosts.get(neighbour) !== undefined) continue;
        cover(await describeThrough(neighbour, undefined, at));
      }
    }
    if (detailsRefreshDue) {
      detailsRefreshDue = false;
      for (const entry of [...hosts.values()]) {
        if (entry.hostname === selfHost || covered.has(entry.hostname)) continue;
        cover(await describeThrough(entry.hostname, undefined, at));
      }
    }
    if (observed.length > 0) applyHostReports(observed, at, true);
    for (const h of newlySeen) needsInventory.add(h);
  };

  const drainBootstrapDone = async (at: number): Promise<void> => {
    for (const entry of [...hosts.values()]) {
      const held = entry.bootstrap;
      if (held === undefined) continue;
      if (await running(held.pid, entry.hostname)) continue;
      entry.bootstrap = undefined;
      bootstrapDoneSet.add(entry.hostname);
    }
    if (bootstrapDoneSet.size === 0) return;
    const described = await Promise.all([...bootstrapDoneSet].map((h) => describeThrough(h, undefined, at)));
    const observed = described.filter((h): h is ReportHost => h !== undefined);
    for (const h of bootstrapDoneSet) needsInventory.add(h);
    bootstrapDoneSet.clear();
    if (observed.length > 0) applyHostReports(observed, at, true);
  };

  /** Every prober, on every mutation. The net changed, so the whole net is
   * re-probed — that is what a permanent prober on every host is FOR. No
   * per-host staleness test: just after a mutation the only honest answer for
   * any prober is "re-run it". */
  const reviveProbers = (): void => {
    if (!probeRefreshDue) return;
    probeRefreshDue = false;
    for (const entry of hosts.values()) {
      const host = entry.hostname;
      if (host === labCandidateHost || entry.agent?.order.kind === "walk") continue;
      if (entry.agent === undefined) continue; // only an active local process can re-exec
      if (entry.agent?.order.kind === "relaunchProbe" || (entry.staged ?? []).some((o) => o.kind === "relaunchProbe")) continue;
      // An armoured prober already scheduled its own successor. Filing a
      // relaunch into that gap lands a SECOND prober a millisecond later, and
      // `lend` would then kill one of the two — paying for a repair that was
      // already paid for.
      if (proberRespawnPending(entry, Date.now())) continue;
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
      // window puts it in the agent's own `exec` rather than a boot later.
      // A planted host reaches this point inside its placing window. Darkweb
      // does not: home seeds its permanent prober directly, and that lender is
      // precisely the launcher `dispatch` needs for the first inventory agent.
      if (!entry || (entry.agent === undefined && !processInbound(entry) && entry.ns === undefined)) continue;
      if (entry.agent?.order.kind === "inventory" || (entry.staged ?? []).some((o) => o.kind === "inventory")) { needsInventory.delete(host); continue; }
      const filed = fileTask({ id: `inventory:${host}`, kind: "inventory", host, from: host, priority: priorityOf("inventory"), reason: "files may have changed; listing them" });
      if (filed) needsInventory.delete(host);
    }
  };

  const SPREAD_LIMITS = {
    ...DEFAULT_SPREAD_LIMITS,
    agentRamGb: SCRIPT_BASE_GB + PROBER_GB,
    residentRamGb: SCRIPT_BASE_GB,
    managedResidentRamGb: SCRIPT_BASE_GB,
    proberRamGb: PROBER_GB,
    managedProberRamGb: PROBER_STASIS_GB,
    bootstrapRamGb: priceOf("bootstrapReclaim"),
  };

  /** Targets whose backdoor or stasis fact is fresh enough that remote exec is
   * still believable — the "who may launch" axis. Stasis facts never expire
   * while linked; an ordinary backdoor is trusted only inside its derived
   * restart/delete lifetime (spec/dnet.md:633-637). */
  const remoteExecSet = (at: number): Set<string> => {
    const set = new Set(stasisLinked);
    const backdoorLife = msPerHostEventAny(["restarted", "deleted"], netDepth ?? DEFAULT_NET_DEPTH, bitNode ?? 15, backdoors.size);
    for (const [hostname, installedAt] of backdoors) {
      const host = hosts.get(hostname);
      if (host !== undefined && at - installedAt <= backdoorLife) set.add(hostname);
    }
    return set;
  };

  /** Describe the credentialled hosts no probe will ever name: the one case the
   * probe chain structurally cannot reach — a host we can exec on WITHOUT being
   * adjacent to it, via a stasis link or a backdoor. Nothing is obliged to be
   * its neighbour, so on a reload its restored credential would sit forever
   * behind `unknown-ram` waiting for an adjacency that never comes. */
  const surveyRemoteTargets = async (at: number, expiry: ExpiryOpts): Promise<void> => {
    const surveyed: ReportHost[] = [];
    for (const [hostname, saved] of [...pendingVault]) {
      const described = await describeThrough(hostname, undefined, at);
      if (described === undefined) continue;
      if (!described.present || (saved.identity !== undefined && described.identity !== saved.identity)) {
        pendingVault.delete(hostname);
        if (!described.present) applyHostReports([described], at, true);
        continue;
      }
      applyHostReports([described], at, true);
      if (described.identity !== undefined && hosts.get(hostname)?.identity === described.identity) {
        recordCredential({ ...saved, identity: described.identity });
      }
    }
    for (const hostname of vault.keys()) {
      if (!stasisLinked.has(hostname) && !backdoors.has(hostname)) continue;
      const entry = hosts.get(hostname);
      if (entry?.agent !== undefined) continue;
      if (entry !== undefined && fresh<number>(entry, "maxRam", at, expiry) !== undefined) continue;
      const described = await describeThrough(hostname, undefined, at);
      if (described !== undefined) surveyed.push(described);
    }
    if (surveyed.length === 0) return;
    applyHostReports(surveyed, at, true);
  };

  /** Give every admitted plant the BEST vantage that can reach it.
   *
   * `candidatesFrom` answers only "who can REACH this", taking the first
   * standing host in map order — which parks a plant behind a six-second phish
   * while an idle neighbour that could reach the same target sits doing
   * nothing. So: prefer an idle vantage, else a busy one and let
   * `routeUrgentTasks` preempt it, else keep the planner's choice.
   *
   * A vantage is NOT spent by taking a target: `deriveTasks` groups a whole
   * frontier into one `plant:<from>` and `plantOne` runs the targets
   * concurrently, so the second costs the same call as the first.
   *
   * Reassignment re-derives the ROUTE with the vantage — a target reachable
   * adjacently from one and only remotely from another must not carry the
   * first one's classification to the second. */
  const assignPlantVantages = (
    plant: SpreadCandidate[],
    remoteExec: ReadonlySet<string>,
    at: number,
    expiry: ExpiryOpts,
  ): void => {
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
      // Idle first, then the planner's own pick if still available, then
      // anything that can reach it — a busy vantage is not a wait, it is a
      // preemption waiting to happen.
      const chosen = [...routes.keys()].find(idle)
        ?? (routes.has(candidate.from) ? candidate.from : [...routes.keys()][0]!);
      candidate.from = chosen;
      if (routes.get(chosen) === "remote") candidate.remote = true; else delete candidate.remote;
    }
  };

  /** Close a placing window nothing ever arrived through: an `exec` refusal,
   * a child that died before its first line, or a plant killed between
   * `preparePlant` and its agent exec all leave an entry
   * saying a process is coming, and no process. `processInbound` asks the
   * engine, so the host rejoins the plant pool on the very next pass rather
   * than after a window lapses. */
  const reapGhostLaunches = (): void => {
    for (const entry of hosts.values()) {
      const inbound = entry.inbound;
      if (inbound === undefined || entry.agent !== undefined) continue;
      // Still the launcher's to close, or a process that really is there.
      if (processInbound(entry)) continue;
      entry.inbound = undefined;
      // Whatever this launch was holding dies with it. A barrier left standing
      // would make every later plant on this host await a report nobody is
      // coming to file.
      const barrier = entry.probeRefresh;
      if (barrier !== undefined && entry.probeRefreshPid === undefined) {
        entry.probeRefresh = undefined;
        barrier.settle(undefined);
      }
    }
  };

  /** Release work stranded on a host that has no process to run it. A claim
   * nobody will honour still reads as `busy` to `projectInFlight`, so
   * `deriveTasks` skips re-deriving that work onto a vantage that could run it.
   *
   * Three hosts are exempt, because on each the work is genuinely waiting for a
   * launcher that exists: a stasis host with its proxy path, a host inside its
   * placing window, and a host that still has its lender. */
  const releaseStranded = (): void => {
    for (const entry of hosts.values()) {
      if (entry.agent !== undefined || processInbound(entry)) continue;
      if (stasisLinked.has(entry.hostname) || entry.ns !== undefined) continue;
      const stranded = [...(entry.staged ?? []), entry.pendingOrder]
        .filter((order): order is Order => order !== undefined);
      if (stranded.length === 0) continue;
      entry.staged = [];
      entry.pendingOrder = undefined;
      for (const order of stranded) {
        retireStaged(order, "cancelled", `stranded on ${entry.hostname}, which has no process to run it`);
      }
    }
  };

  // --- the whole derive pass ------------------------------------------------
  const fileWork = async (at: number): Promise<Task[]> => {
    // FIRST: one consistent answer about what is running, for the whole pass.
    await refreshLiveness();
    reapGhostLaunches();
    releaseStranded();
    await drainBootstrapDone(at);
    await drainProbes(at);
    reviveProbers();
    fileListJobs();
    // Observation is done, so the expiry inputs (`backdoors`, `stasisLinked`,
    // `netDepth`, `bitNode`) are settled for the rest of this pass. Take them
    // ONCE: everything below plans against one consistent view.
    const expiry = expiryOpts();
    await surveyRemoteTargets(at, expiry);
    const remoteExec = remoteExecSet(at);
    // Named, because the refusals below have to tell "nothing can reach this
    // host" apart from "something is already on its way to it". They are the
    // same `continue` inside `candidatesFrom` and opposite problems.
    const standing = new Set([
      selfHost,
      ...liveEntries().map((e) => e.hostname),
      ...[...hosts.values()].filter((e) => e.bootstrap !== undefined).map((e) => e.hostname),
    ]);
    const spreadCandidates = candidatesFrom(knowledge, at, {
      standing,
      vault: new Set(vault.keys()),
      remoteExec,
      remoteVantages: liveEntries().map((e) => ({ host: e.hostname, freeGb: usableGb(e.hostname, at, expiry) })),
      stasisLinked,
      expiry,
    });

    const stormHosts = [...hosts.values()].map((entry) => {
      const view = planningView(entry, at, expiry);
      // `view` FIRST and `entry` never: `planningView` expresses staleness by
      // DELETING keys, so spreading it over the raw entry resurrects all of
      // them and `planStorm` would read a twelve-minute-old `stormSeed`,
      // `caches` or `blockedRam` as a fresh observation.
      return {
        ...view,
        agentAlive: entry.agent !== undefined,
        busy: new Set([...(entry.agent !== undefined ? [entry.agent.order.kind] : []), ...(entry.staged ?? []).map((o) => o.kind)]) as ReadonlySet<string>,
      } as DnetHost;
    });

    const seedHolder = stormHosts.find((h) => h.stormSeed === true);
    const labWalkedNow = [...hosts.values()].some((entry) => isLabyrinth(entry.hostname, fresh<string>(entry, "modelId", at, expiry)) && vault.has(entry.hostname));
    const seedHunt = seedHolder === undefined && (labWalkedNow || stasisLinked.size >= stasisLimit) && (lastStormFiredAt === undefined || at - lastStormFiredAt > STORM_COOLDOWN_MS);
    // Hold BEFORE farm: the farm's gang grind is aimed at the hold plan's lab
    // candidate, whose block is the last gate before the walker starts.
    const holdPlan = planHold(at, expiry);
    hold = holdPlan.report;
    const farmPlan = planFarm(projectFarmHosts(at, expiry), {
      now: at, charisma, gbPerThread: farmGbPerThread, wantedGb: heaviestJobGb,
      ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
      ...(promoteSymbols.length > 0 ? { promoteSymbols } : {}),
      crimeSuccessMult, openLabCache,
      ...(farmEconomics !== undefined ? { economics: farmEconomics } : {}),
      ...(seedHunt ? { seedHunt: true } : {}),
      ...(holdPlan.labCandidate !== undefined && !labWalkedNow
        ? { walkerCandidate: holdPlan.labCandidate }
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
    const plan = planSpread(spreadCandidates, SPREAD_LIMITS);
    assignPlantVantages(plan.plant, remoteExec, at, expiry);
    // A host `candidatesFrom` could not route to never reaches `planSpread`, so
    // it would otherwise be absent from the panel entirely — cracked, empty and
    // unexplained. Name it here, where both the routes and the map are in hand.
    const routed = new Set(spreadCandidates.map((candidate) => candidate.host));
    const routeless: Refusal[] = [...hosts.values()]
      .filter((entry) => entry.hostname !== selfHost
        && entry.agent === undefined && vault.has(entry.hostname) && !routed.has(entry.hostname))
      .map((entry): Refusal => {
        // A host inside its placing window is skipped for the RIGHT reason — it
        // is being planted — and reporting that as `no-route` reads as a
        // routing bug.
        if (standing.has(entry.hostname)) {
          return {
            host: entry.hostname,
            why: "launching",
            detail: entry.bootstrap !== undefined
              ? "a local reclaimer holds this host; no agent launches until it exits"
              : `a process was announced ${at - (entry.inbound?.at ?? at)}ms ago and has not adopted yet`,
          };
        }
        return {
          host: entry.hostname,
          why: "no-route",
          detail: remoteExec.has(entry.hostname)
            ? "remote exec is believable but no launch vantage is standing"
            : "no vantage's adjacency still names it, and no fresh backdoor or stasis fact to reach it without one",
        };
      });
    const refusals = [...plan.refused, ...routeless];
    const why: Record<string, string> = {};
    for (const refusal of refusals) why[refusal.host] = refusal.detail;
    spread = {
      planted: plan.plant.length,
      ...foldRefusals(refusals),
      ...(Object.keys(why).length > 0 ? { why } : {}),
    };

    const pinsPending = holdPlan.tasks.some((t) => t.kind === "pin" && t.unpin !== true) || [...projectInFlight().values()].some((held) => held.some((job) => job.kind === "pin"));
    const walkFrom = holdPlan.tasks.find((task) => task.kind === "walk")?.from ?? walkVantage();
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

    // WHO WEARS ARMOUR. Recomputed every derive because every input moves: the
    // storm walks toward its last gate, backdoors are installed and cleared by
    // the same restarts they invite, and capacity changes with every block
    // ground down. `resizeProber` acts on this at the next order boundary — the
    // only instant a prober can change size — so this set is a standing intent
    // rather than a command.
    armourWanted.clear();
    const armourCandidates: ArmourCandidate[] = [];
    for (const entry of hosts.values()) {
      if (entry.hostname === selfHost) continue;
      // Free capacity beyond everything standing.
      //
      // Read FIELD BY FIELD rather than through `planningView`: this runs for
      // every host on every derive, and a projection clone per host is exactly
      // the cost a CPU profile already named in this pass. Two freshness checks
      // are all the question needs.
      //
      // NOT `durableRoomGb`: that already nets off the prober reserve, which
      // `heldGb` counts too, so the pair would subtract it twice.
      const maxRam = fresh<number>(entry, "maxRam", at, expiry);
      const free = maxRam === undefined
        ? undefined
        // Add back the armour this host is already wearing, so an armoured host
        // does not read as unable to afford the armour it already has.
        : maxRam - (fresh<number>(entry, "blockedRam", at, expiry) ?? 0) - heldGb(entry)
          + (entry.prober?.armoured === true ? ARMOUR_GB : 0);
      armourCandidates.push({
        hostname: entry.hostname,
        ...(free !== undefined ? { usableGb: free } : {}),
        proberStanding: entry.prober !== undefined && entry.prober.pid > 0,
        stasisLinked: stasisLinked.has(entry.hostname),
        backdoored: backdoors.has(entry.hostname),
        omitProber: entry.hostname === labCandidateHost,
      });
    }
    for (const host of planArmour(armourCandidates, {
      stormImminent: stormPlan.imminent,
      armourGb: ARMOUR_GB,
    })) armourWanted.add(host);

    const looseTargets = [...hosts.keys()].map((hostname) => projectLooseTarget(hostname, at, expiry));
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
      if (stale || replaced || host === undefined || vault.has(candidate.hostname)) { provisionalPool.splice(index, 1); continue; }
      if (spentGuesses.has(`${candidate.hostname} ${candidate.password}`)) continue;
      const id = looseId(candidate.password);
      guessFor.set(id, candidate.password);
      guesses.unshift({ host: candidate.hostname, id, reason: `a ${candidate.via} log named this host and password` });
    }

    const tasks = deriveTasks(knowledge, at, {
      ...expiry,
      charisma,
      inFlight: projectInFlight(),
      agents: new Set([selfHost, ...liveEntries().map((e) => e.hostname)]),
      agentFreeGb: new Map(liveEntries().map((e) => [e.hostname, usableGb(e.hostname, at, expiry)])),
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
    // whatever is still idle. The order is the point: `planFarm` is a separate
    // planner and cannot see a pending plant, so filing everything in one pass
    // hands vantages six-second phishes that spreading then has to preempt.
    // Filing what grows the net first offers the farm only the hosts still free
    // afterwards — which is where the charisma and money for spreading come
    // from anyway.
    const filed = new Set<string>();
    const file = (task: Task): void => {
      let filedTask = task;
      if (task.followAttemptIds !== undefined) {
        const followed = task.followAttemptIds.filter((id) => filed.has(id));
        for (const id of task.followAttemptIds) if (!filed.has(id)) orderDone.delete(id);
        if (followed.length === 0) return;
        filedTask = { ...task, followAttemptIds: followed };
      }
      if (fileTask(filedTask)) filed.add(task.id);
    };
    for (const task of tasks) if (!JOBS[task.kind].farm) file(task);
    /** Nothing running and nothing queued: the host is genuinely spare. */
    const spare = (host: string): boolean => {
      const entry = hosts.get(host);
      return entry !== undefined && entry.agent === undefined
        && (entry.staged ?? []).length === 0;
    };
    for (const task of tasks) if (JOBS[task.kind].farm && spare(task.from)) file(task);
    // Every host that is free and holding work. `stage` starts what it files,
    // so this only catches hosts that became free since — a worker exited, a
    // refused launch was put back, a lender arrived on a host that was already
    // holding orders.
    for (const entry of [...hosts.values()]) {
      if (stasisLinked.has(entry.hostname)) await dispatchManaged(entry);
      else dispatchLocal(entry);
    }
    return tasks;
  };

  /** When this vantage could START new work: what is left of its active order
   * plus everything already queued ahead of the newcomer. How busy, not
   * whether — the number you need to choose BETWEEN busy vantages rather than
   * refusing them all. An order with no completion estimate is charged a
   * typical duration, so an unmeasurable job cannot make a loaded worker look
   * free. */
  const readyInMs = (entry: HostEntry, at: number): number => {
    const active = entry.agent;
    const activeLeft = active === undefined
      ? 0
      : active.order.expectedDoneAt !== undefined
        ? Math.max(0, active.order.expectedDoneAt - at)
        : TYPICAL_ORDER_MS;
    // Plus the standing order. There is at most one — a host keeps its best
    // order, not a backlog — so this asks whether, never how deep.
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
        if (active !== undefined) {
          cancelActive(entry!);
          cancelled.add(choice.vantage);
        }
      }
    }
  };

  const reconcilePending = (at: number): void => {
    const expiry = expiryOpts();
    const staleReason = (order: Order): string | undefined => {
      // A plant is judged per TARGET, never by `order.host` — which names only
      // the first of them. One gone, replaced or already-running target costs
      // the frontier that stop; the order dies only when every stop is gone.
      if (order.kind === "plant") {
        order.payload.targets = order.payload.targets.filter((target) => {
          const host = hosts.get(target.host);
          if (host === undefined) return false;
          if (target.identity !== undefined && host.identity !== undefined && target.identity !== host.identity) return false;
          return host.agent === undefined;
        });
        return order.payload.targets.length === 0 ? "nothing left on the frontier to reach" : undefined;
      }
      const host = hosts.get(order.host);
      if (!host) return "target is gone";
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
      // launch died is otherwise never inspected again, and `projectInFlight`
      // reads it as busy FOREVER — a plant target silently barred from the pool.
      const pending = entry.pendingOrder;
      if (pending !== undefined) {
        const reason = staleReason(pending);
        if (reason !== undefined) {
          entry.pendingOrder = undefined;
          retireStaged(pending, "cancelled", reason);
        } else if (entry.agent === undefined && entry.bootstrap === undefined
          && !processInbound(entry)) {
          // Still a valid order, but nothing is coming to adopt it: the child
          // died or exec was refused. Return it for the next dispatch or plant.
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
    generation: launch.generation,
    pid: ns.pid,
    startedAt: bootAt,
    lastBeatAt: bootAt,
    hosts,
    mutationEpoch: 0,
    noteMutation(at) {
      if (at <= mutationTurnAt) return rendezvous.mutationEpoch;
      mutationTurnAt = at;
      rendezvous.mutationEpoch++;
      mutationsSeen++;
      mutationSweepDue = true;
      detailsRefreshDue = true;
      probeRefreshDue = true;
      signalDerive();
      // No loop to wake: the controller IS the mutation clock, so it is already
      // awake in the pass that called this.
      return rendezvous.mutationEpoch;
    },
    wake() { signalDerive(); },
    adopt(host, handle) {
      const entry = hosts.get(host);
      if (entry === undefined) {
        handle.settle({ id: handle.order.id, kind: handle.order.kind, host: handle.order.host, from: handle.order.from, ok: false, died: true, detail: "host is no longer tracked" });
        return;
      }
      entry.staged ??= [];
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
    async beginProbeRefresh(host) {
      const entry = hosts.get(host);
      if (entry === undefined) {
        const refresh: DnetProbeRefresh = { refreshed: Promise.resolve(undefined), settle() {} };
        return { refresh, launch: false };
      }
      if (entry.probeRefresh !== undefined) {
        // A barrier is worth joining while the prober behind it is alive. No
        // pid means the plant that opened it has not exec'd yet and still owns
        // it — it settles the barrier itself if the launch is refused, and
        // `reapGhostLaunches` settles it if the plant dies holding it.
        const pid = entry.probeRefreshPid;
        if (pid === undefined || await running(pid, host)) {
          return { refresh: entry.probeRefresh, launch: false };
        }
        // The prober died between exec and settle. Left standing, every later
        // plant on this host would await a report nobody will file.
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
      const entry = hosts.get(host);
      if (entry === undefined) { refresh?.settle(undefined); return; }
      // Whichever prober reports most recently owns the slot. Retire the prior
      // pid BEFORE publishing the replacement, so a repair launch racing a
      // merely-late process still converges to one prober.
      if (entry.prober?.pid !== pid) {
        // Deliberate replacement: mark before the kill so the outgoing prober's
        // armour does not schedule a successor to the process replacing it.
        if (entry.prober !== undefined && entry.prober.pid > 0) entry.proberKillMark = entry.prober.pid;
        killPid(entry.prober?.pid);
      }
      // Armour is a property of the LAUNCH, and a re-probe is not a launch, so
      // the same pid keeps whatever it was sized with. A new pid gets its flag
      // from `lend`, which is the only caller that knows.
      const stillArmoured = entry.prober?.pid === pid && entry.prober.armoured === true;
      entry.prober = {
        neighbours: [...neighbours], at, pid, epoch: rendezvous.mutationEpoch,
        ...(stillArmoured ? { armoured: true } : {}),
      };
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
    announceProberRespawn(host, pid, launchId, withdraw) {
      const entry = hosts.get(host);
      if (entry === undefined) return false;
      // BACKSTOP. Marking every deliberate kill is the actual contract, but the
      // cost of missing one is not a stray process — it is a 1 ms respawn loop
      // that starves the event loop and freezes the game, which is exactly what
      // an unmarked `retireVantage` did. A legitimate respawn answers a host
      // RESTART, and one host is restarted at most once per storm and otherwise
      // minutes apart, so refusing a second respawn inside this window cannot
      // block a real recovery and caps any future miss at a slow leak.
      const at = Date.now();
      if (entry.proberRespawnAt !== undefined && at - entry.proberRespawnAt < PROBER_RESPAWN_FLOOR_MS) {
        return false;
      }
      // A kill WE ordered. The mark is consumed here rather than left standing,
      // so it can never suppress a later, genuine restart recovery.
      if (entry.proberKillMark === pid) {
        entry.proberKillMark = undefined;
        return false;
      }
      // Standing down for the run: a respawn now would outlive the controller
      // that is trying to retire the net.
      if (standDown) return false;
      entry.proberRespawnAt = at;
      entry.proberRespawn = { at, launchId, withdraw };
      return true;
    },
    markProberKill(host, pid) {
      const entry = hosts.get(host);
      if (entry === undefined || pid <= 0) return;
      entry.proberKillMark = pid;
    },
    lend(host, borrowed, pid, refresh, armoured) {
      const entry = hosts.get(host);
      if (entry === undefined) { refresh?.settle(undefined); killPid(pid); return; }
      // The successor has ARRIVED, so the window it was holding open is closed.
      // Its descriptor was captured by this very process, so there is nothing
      // left to withdraw.
      entry.proberRespawn = undefined;
      // `darkweb` is seeded directly by home, so unlike every host reached by
      // a plant it never passes through `preparePlant`. Request its first file
      // listing here as part of establishing the lender. Without this, its
      // caches stay unknown and `planFarm` stops at `cache-unknown`, leaving
      // the beachhead with no fallback phish order whenever blocking work is
      // exhausted. The same fact gate safely repairs any restored host whose
      // file knowledge was invalidated while it had no live lender.
      if (entry.seenAt.files === undefined || entry.dirty.files === true) needsInventory.add(host);
      // Whichever prober checked in most recently owns the host. Retire the
      // prior one BEFORE publishing, so the invariant converges to one lender
      // and a late arrival cannot retract a newer one's `ns` on its way out
      // (its `atExit` compares identity).
      if (entry.prober !== undefined && entry.prober.pid > 0 && entry.prober.pid !== pid) {
        // MARK BEFORE KILL. The victim's armour hook runs synchronously inside
        // `killPid`, and a mark set afterwards would arrive after it had
        // already scheduled a successor we do not want.
        entry.proberKillMark = entry.prober.pid;
        killPid(entry.prober.pid);
      }
      entry.ns = borrowed;
      probeThrough(entry, pid, Date.now(), refresh);
      // AFTER the probe: `reportProbe` rebuilds the record, and only this
      // caller knows what the arriving process was sized for.
      if (entry.prober?.pid === pid && armoured === true) {
        entry.prober = { ...entry.prober, armoured: true };
      }
    },
    preparePlant(host) {
      const entry = hosts.get(host);
      if (entry === undefined) return { reuseProber: true };
      // Only while the files group is actually UNKNOWN — never seen, or
      // dirtied by an action whose `ls` has not landed. Re-arming on every
      // plant regardless is a livelock: spread keeps planting a host whose
      // inventory is already known. Gating on the fact itself terminates because
      // the inventory that runs clears the dirty flag and the next plant asks
      // for nothing. The dirty case has to be here as well as in `onReport`:
      // `retireVantage` drops the pending request with the agent, and without
      // it a replanted host would carry an unknown listing — and therefore a
      // `cache-unknown` refusal of every farm rung — for the rest of its life.
      if (entry.seenAt.files === undefined || entry.dirty.files === true) needsInventory.add(host);
      // The placing window opens HERE and closes in `claimPlanted`. Inside it
      // the derive may stage work for a host that has no process yet, because
      // one is on its way and will adopt whatever is waiting.
      entry.inbound = { at: Date.now(), via: "plant" };
      // A live, tracked prober is reusable on ANY host. Launching a second
      // beside a survivor wastes 1.8 GB, and in the band where usableRam admits
      // one prober but not two it makes the agent exec fail with
      // `launch-refused` forever. A live LENDER is the proof one is standing —
      // a fact the prober published, not one we polled for.
      const proberPid = entry.prober?.pid;
      // An armoured successor in the air counts as a standing prober. It is a
      // millisecond away and it will `lend` on arrival; launching beside it
      // spends the same 3.15 GB twice and leaves `lend` to kill one of them.
      if (proberRespawnPending(entry, Date.now())) return { reuseProber: true };
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
      const entry = hosts.get(host);
      if (entry === undefined) return undefined;
      // REFRESH the placing window, never close it. The plant has not exec'd
      // the agent yet, and a host reading agentless AND unclaimed lets the
      // derive `releaseStranded` the very order it was three lines from
      // launching. `adopt` closes the window; `abandonPlant` closes it on
      // failure. Nothing else may.
      entry.inbound = { at: Date.now(), via: "plant-exec" };
      // A stasis target may claim any queued order because the plant already
      // holds the remote authority needed to launch it. An ordinary target
      // claims only same-turn housekeeping: its first `ls` must land inside
      // the mutation epoch in which the host was planted, while the `.d` hint
      // still names an attributable neighbour. Later work can use the local
      // prober's ordinary dispatch path.
      const managed = stasisLinked.has(host);
      const claimable = (order: Order): boolean => managed || isSameTurn(order.kind);
      // A pending order we may not claim is not ours to overwrite either —
      // claiming past it would drop it on the floor.
      if (entry.pendingOrder !== undefined && !claimable(entry.pendingOrder)) return undefined;
      let next = entry.pendingOrder ?? takeNextOrder(entry, claimable);
      if (next !== undefined) {
        // The claim must FIT the host's durable CAPACITY: an order sized when
        // the host was empty can exceed what remains beside a grown block, and
        // a claim that cannot exec loops the plant on `launch-refused` forever.
        // A thread-scaled order shrinks to the room; anything else is RETIRED —
        // never re-queued at the head, where it would block a queue only remote
        // plants can drain.
        if (!fitQueuedOrder(entry, next)) {
          entry.pendingOrder = undefined;
          next = undefined;
        }
      }
      if (next === undefined) return undefined;
      if (stasisLinked.has(host)) next.controllerManaged = true;
      entry.pendingOrder = next;
      return next;
    },
    registerBootstrap(host, pid) { const entry = hosts.get(host); if (entry) entry.bootstrap = { pid, startedAt: Date.now() }; },
    bootstrapDone(host) { const e = hosts.get(host); if (e) e.bootstrap = undefined; bootstrapDoneSet.add(host); signalDerive(); },
    deps,
    snapshot(requestedAt = Date.now()): DnetSnapshot {
      const lab = labReport(requestedAt);
      if (lab !== undefined) lastLab = lab;
      // Read entirely from the MAP: `maxRam` and `blockedRam` are folded from
      // every observation already, and we placed every process on this host so
      // we know what each costs. Sampling the engine here would also be a
      // hazard — HOME calls `snapshot()` in its own process, so a dead
      // controller would raise OUR ScriptDeath inside home's feature loop.
      const expiry = expiryOpts();
      const ram: DnetRamSnapshot[] = [...hosts.values()].flatMap((entry) => {
        const total = fresh<number>(entry, "maxRam", requestedAt, expiry);
        if (total === undefined) return [];
        const blocked = Math.max(0, Math.min(fresh<number>(entry, "blockedRam", requestedAt, expiry) ?? 0, total));
        const occupied = Math.min(total, blocked + heldGb(entry));
        return [{
          host: entry.hostname,
          at: requestedAt,
          total,
          blocked,
          used: Math.max(0, occupied - blocked),
        }];
      });
      const recovery: DnetRecoveryState = {
        version: DNET_RECOVERY_VERSION,
        generation: launch.generation,
        capturedAt: requestedAt,
        knowledge: recoveryKnowledge(launch.generation, hosts, mutationsSeen),
        vault: [...new Map([...pendingVault, ...vault]).values()].map(cloneData),
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
        residents: liveEntries().map((entry) => {
          // An exec'd child may be holding its full allocation for the short
          // window before it adopts. The controller already owns its order and
          // pid, so reporting it is observation, not a new probe.
          const active = entry.agent?.order
            ?? (entry.inbound?.pid !== undefined ? entry.pendingOrder : undefined);
          const jobGb = active === undefined ? 0 : active.ramOverrideGb * active.threads;
          const proberGb = entry.prober !== undefined && entry.prober.pid > 0
            ? proberReserveGb(entry.hostname)
            : 0;
          const controllerGb = entry.hostname === selfHost ? CONTROLLER_GB : 0;
          return {
            host: entry.hostname,
            lastBeatAt: entry.agent?.beatAt ?? requestedAt,
            pending: (entry.staged ?? []).length,
            ...(active !== undefined ? { active: active.kind } : {}),
            targets: active === undefined ? [] : [...new Set(hostsOf(active))],
            ram: {
              jobGb,
              proberGb,
              controllerGb,
            },
            freeGb: usableGb(entry.hostname, requestedAt, expiry),
            completed: entry.completed ?? 0,
            failed: entry.failed ?? 0,
            ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
          };
        }),
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
      promoteSymbols = [...(inputs.promoteSymbols ?? [])];
      if (inputs.crimeSuccessMult !== undefined) crimeSuccessMult = inputs.crimeSuccessMult;
      if (inputs.farmEconomics !== undefined) farmEconomics = inputs.farmEconomics;
      if (inputs.fileInvalidations !== undefined) {
        for (const invalidation of inputs.fileInvalidations) {
          const entry = hosts.get(invalidation.host);
          if (entry === undefined) continue;
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
        // A restored link needs no seeding of its own: a stasis host worth
        // replanting is one we hold a password for, so the derive's survey
        // describes it along with every other restored credential.
        signalDerive();
      }
      signalDerive();
    },
    standDown() { standDown = true; signalDerive(); },
  };

  // BOOTSTRAP: darkweb is the one seed whose existence is supplied by launch.
  if (!hosts.has(selfHost)) {
    hosts.set(selfHost, { hostname: selfHost, lastSeenAt: bootAt, seenAt: {}, dirty: {}, staged: [] });
  } else {
    hosts.get(selfHost)!.staged ??= [];
  }
  // HAND OVER: the rendezvous IS the handover, and nothing has to be told.
  // Agents read `live()` fresh on every pass and never hold a controller across
  // an await, so a replacement is picked up on the next thing any of them does.
  realm.dnet_controller = rendezvous;
  // ...and CHECK OUT on the way down, however we go down. `atExit` runs on a
  // kill as well as on a clean exit, so this is the one place that can promise
  // it.
  ns.atExit(() => {
    if (realm.dnet_controller === rendezvous) delete realm.dnet_controller;
  }, "dnet-controller-checkout");

  let lastBeat = bootAt;
  while (true) {
    const at = Date.now();
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
    }

    // The dead-process sweep: any tracked pid no longer running. The watchdog
    // sweep below stays separate — its place AFTER `reconcilePending` is
    // load-bearing.
    const sweepMutations = mutationSweepDue;
    mutationSweepDue = false;
    if (sweepMutations) {
      // A zeroed pid is not a process but a handle that already ran its own
      // exit path, so `running` reads it as gone. `killWalkHostProber` zeroes
      // the prober slot deliberately to mark one it sacrificed for the walker,
      // which is why a pid of 0 is left alone below rather than swept.
      for (const entry of [...hosts.values()]) {
        // The PROBER is checked on its own account, whether or not an agent is
        // standing here: `reviveProbers` notices only a stale STAMP, and a
        // stamp goes stale only after a mutation — so a prober that died right
        // after reporting would look fresh for a whole cycle while its host ran
        // blind. Drop the record but keep the neighbours it reported: they are
        // the last thing we knew, and `reviveProbers` files the replacement.
        if (entry.agent !== undefined && entry.prober !== undefined
          && entry.prober.pid > 0 && !(await running(entry.prober.pid, entry.hostname))
          && !proberRespawnPending(entry, at)) {
          entry.prober = { ...entry.prober, pid: 0, at: 0 };
        }
        // The AGENT is what makes a host a vantage, so it is what the sweep
        // asks about; a prober alone still speaks for the entry, but only while
        // its own pid is real.
        const dead = entry.agent !== undefined
          ? !(await running(entry.agent.pid, entry.hostname))
          : entry.prober !== undefined && entry.prober.pid > 0
            && !(await running(entry.prober.pid, entry.hostname));
        if (!dead) continue;
        // `retireVantage` settles an ACTIVE order with `died`, and `onReport`
        // counts that loss itself; a prober-only vantage is counted here.
        if (entry.agent === undefined) residentsLost++;
        retireVantage(entry.hostname, `${entry.hostname} process died during a mutation`);
        invalidateBackdoor(entry.hostname);
      }
    }
    reconcilePending(at);
    // Ask expired work to stop. Eligible bodies are killed by the later sweep;
    // pin/walk remain tracked until their atomic/PID-bound work returns.
    for (const entry of hosts.values()) {
      const active = entry.agent;
      if (active === undefined) continue;
      // Settling alone would only drop OUR handle: the process may be alive and
      // merely slow, and would then hold the host's whole RAM budget for ever
      // while the map reads it as unstaffed and re-plants it. Ask it to stop,
      // then take the pid.
      if (jobWatchdogExpired(active, at)) cancelActive(entry);
    }
    residentsSeenEver = Math.max(residentsSeenEver, liveEntries().length);

    // The watchdog pass: the bounded re-derive over whatever the sweeps above
    // just changed.
    const tasks = await fileWork(at);

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

    // THE mutation clock, and the only long-lived call in the darknet.
    //
    // It lives here because a script parked in a Netscript call holds
    // `env.runningFn` and can lend its `ns` to nobody — the one thing every
    // prober exists to do. The controller has no call of its own, so being
    // parked costs it nothing. Derivation does not wait for this: it already
    // ran, on the turn its fact landed.
    //
    // NOT raced against a watchdog. A race leaves the losing `nextMutation`
    // outstanding, and the next pass's call would throw CONCURRENCY ERROR into
    // the one process that cannot afford to die.
    //
    // ONE `await` is enough, deliberately: `mutateDarknet` resolves this promise
    // FIRST (`triggerNextUpdate()`) and only then applies the moves, and since
    // it has no `await` of its own the whole mutation completes before this
    // line resumes. If an `await` ever appears between that trigger and the
    // mutations, this silently starts reading a stale map.
    //
    // A resolve is NOT proof anything changed — roughly one tick in sixteen
    // moves nothing — which is why the sweeps below are idempotent.
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
    // Marked for the same reason, and not left to the fact that the rendezvous
    // was deleted above: an armour hook that outlived this loop must have one
    // reason to stand down that does not depend on statement order.
    if (probe !== undefined && probe.pid > 0 && probe.pid !== ns.pid) {
      entry.proberKillMark = probe.pid;
      killPid(probe.pid);
    }
  }
  TELEMETRY: if (__TELEMETRY__ && tel) tel.flush();
}

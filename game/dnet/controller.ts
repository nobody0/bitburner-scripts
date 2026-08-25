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
import { captureLaunch } from "../lib/launch-shared.ts";
import type { DnetControllerLaunch } from "./launch.ts";
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
  type StormContext,
  type Task,
  type TaskKind,
} from "../../shared/strategy/dnet/plan.ts";
import { DNET_PRIORITY, strategicQueueDepth, choosePreemptionVantage, compareQueuedDnetWork, isSameTurn, type PreemptionCandidate } from "../../shared/strategy/dnet/priority.ts";
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
  BEAT_WINDOW_MS,
  CONTROLLER_CALLS,
  DNET_PROTOCOL,
  KIND_CALLS,
  THREAD_SCALED_KINDS,
  controllerIsLive,
  costOf,
  dnetRealm,
  hardCancelReady,
  jobWatchdogExpired,
  orderCalls,
  PENDING_ORDER_GRACE_MS,
  PROBE_REFRESH_DEADLINE_MS,
  priceCalls,
  proberReserveGb,
  signalWake,
  threadsFor,
  type ControllerDeps,
  type ControllerHandle,
  type DnetDelayRequest,
  type HostEntry,
  type Order,
  type Report,
} from "./shared.ts";
import {
  foldRefusals,
  type DnetDrain,
  type DnetOrders,
  type DnetSpreadReport,
  type DnetFarmReport,
  type DnetHoldReport,
  type DnetStormReport,
  type DnetLabReport,
  type DnetLabWalker,
  type DnetStasisSnapshot,
} from "./wire.ts";
import { initTelemetry } from "../lib/telemetry.ts";
import { realmSleep } from "../lib/wake.ts";
import { preemptionCandidateFromHandle } from "./priority.ts";
import { emptyDnetProfit, hasDnetProfit, mergeDnetProfit } from "./profit.ts";

/** The darknet controller: one long-lived script that decides, and never acts.
 * Its shape follows the spec: one `hosts` map holding
 * both what we KNOW about each host and the process RUNNING on it. It stages
 * ORDERS as data; the agent runs them through a `switch` of direct calls. It
 * learns of completion the instant each agent's `done` promise settles, and it
 * requests cooperative cancellation and hard-kills a body that remains inside
 * a blocking call. It OBSERVES only through synchronous reads and never
 * BLOCKS. */

const BEAT_INTERVAL_MS = 15_000;
const TICK_MS = 2_000;
const STAND_DOWN_POLL_MS = 250;
const MAX_STAGED_PER_HOST = 3;
const MAX_GRAMMAR_SHAPES = 20;
const MAX_LOOSE_PASSWORDS = 40;
const MAX_PROVISIONAL_CREDENTIALS = 80;

const ROUTINE_KINDS: readonly TaskKind[] = ["inventory", "bleed", "attempt", "plant", "cache", "reclaim", "phish"];

function looseId(password: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < password.length; i++) {
    h ^= password.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}


export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetControllerLaunch>("dnet-controller");
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
  const proberFile = "dnet/prober.js";
  const payloads = ["dnet/agent.js", proberFile];
  let charisma = mission.charisma;
  let timingProfile: DnetTimingProfile | undefined;
  let netDepth: number | undefined;
  let bitNode: number | undefined;

  const hosts = new Map<string, HostEntry>();
  /** The fold helpers operate on `DnetHost` values; a `HostEntry` IS one (its
   *  runtime fields are optional), so the same map serves both. */
  const knowledge = hosts as unknown as DnetHosts;
  const vault = new Map<string, VaultEntry>();
  const codes: Record<string, number> = {};
  let spread: DnetSpreadReport | undefined;
  let farm: DnetFarmReport | undefined;
  let hold: DnetHoldReport | undefined;
  let storm: DnetStormReport | undefined;
  const loosePool: string[] = [];
  const provisionalPool: ProvisionalCredential[] = [];
  const authenticationEpoch = new Map<string, number>();
  const spentGuesses = new Set<string>();
  const guessFor = new Map<string, string>();
  const stasisLinked = new Set<string>();
  let stasisObservedAt = 0;
  let pendingStasisSnapshot: DnetStasisSnapshot | undefined;
  let charismaNeeded: number | undefined;
  let promoteSymbols: PromoteSymbol[] = [];
  let crimeSuccessMult = 1;
  let farmEconomics: FarmEconomics | undefined;
  let stasisLimit = 1;
  let labExpected = true;
  const backdoors = new Map<string, number>();
  let karmaLoss = 0;
  let profit = emptyDnetProfit();
  let lastPhishCacheAt: number | undefined;
  let lastStormFiredAt: number | undefined;
  let stormStampPrior: number | undefined;
  let stormWipeAt: number | undefined;
  const grammarShapes: Record<string, number> = {};
  let grammarUnrecognised = 0;
  let openLabCache = false;
  const pendingHosts: ReportHost[] = [];
  const pendingCredentials: VaultEntry[] = [];
  const pendingCredentialRejections = new Map<string, { hostname: string; identity?: string; at: number }>();
  const pendingBackdoorInvalidations = new Map<string, { hostname: string; at: number }>();
  const pendingAttempts: { hostname: string; outcome: AttemptOutcome }[] = [];
  const pendingLogDrains: { hostname: string; outcome: LogDrainOutcome }[] = [];
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
  let residentsLost = 0;
  let standDown = false;
  let lastMutationAt: number | undefined;
  let mutationTurnAt = -1;
  let prevMutationAt = 0;
  let pendingMutations = 0;
  let mutationSweepDue = false;
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
   * cancellation, `hardCancelSweep`, the telemetry beat) and re-derives on a
   * bounded interval if a fact were ever missed. */
  let deriveQueued = false;
  const signalDerive = (): void => {
    if (deriveQueued) return;
    deriveQueued = true;
    void Promise.resolve().then(() => {
      deriveQueued = false;
      if (!standDown) fileWork(Date.now());
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
  const liveEntries = (): HostEntry[] => [...hosts.values()].filter((e) => e.agent !== undefined);
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
    pendingStasisSnapshot = { hosts: [...stasisLinked].sort(), at: stasisObservedAt };
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
    if (agent === undefined || agent.order.kind === "idle") return;
    if (agent.cancelReason === undefined) {
      agent.cancelReason = reason;
      // Give cooperative bodies one derive pass to return resumable state.
      // A body blocked in one Darknet call is then stopped by the hard sweep.
      agent.cancelRequestedPass = derivePass;
    }
  };

  /** Settle a STAGED order that never ran (retired before pickup), by running
   * its report side effects directly — there is no agent promise to await. */
  const retireStaged = (order: Order, targetState: Report["targetState"], detail: string): void => {
    onReport({ id: order.id, kind: order.kind, host: order.host, from: order.from, ok: false, ...(targetState ? { targetState } : {}), detail });
  };

  const retireOrders = (hostname: string, reason: string, applies: (o: Order) => boolean): void => {
    const targets = (o: Order): boolean => o.host === hostname && applies(o);
    for (const entry of hosts.values()) {
      const staged = entry.staged ?? [];
      const retired = staged.filter(targets);
      if (retired.length > 0) {
        entry.staged = staged.filter((o) => !targets(o));
        for (const o of retired) retireStaged(o, "cancelled", reason);
      }
      if (entry.agent !== undefined && entry.agent.order.kind !== "idle" && targets(entry.agent.order)) {
        cancelActive(entry, reason);
      }
      // A linked one-off has no cooperative recovery path: kill it outright
      // (its atExit settles) and drop any hop-claimed order the same way.
      if (entry.sidecar !== undefined && targets(entry.sidecar.order)) {
        killPid(entry.hostname, entry.sidecar.pid);
        entry.sidecar = undefined;
      }
      if (entry.sidecarOrder !== undefined && targets(entry.sidecarOrder)) {
        const side = entry.sidecarOrder;
        entry.sidecarOrder = undefined;
        retireStaged(side, "cancelled", reason);
      }
    }
  };
  const retireCracking = (hostname: string, reason: string): void => {
    forgetGuesses(hostname);
    retireOrders(hostname, reason, (o) => o.kind === "attempt");
  };
  /** True when the process was ours to kill and is now certainly gone. Never
   * the controller's own pid, and a throw (host deleted) counts as gone. */
  const killPid = (hostname: string, pid: number | undefined): void => {
    if (pid === undefined || pid <= 0 || pid === ns.pid) return;
    try { if (ns["isRunning"](pid, hostname)) ns["kill"](pid); } catch { /* host gone */ }
  };
  const retireVantage = (hostname: string, reason: string): void => {
    const entry = hosts.get(hostname);
    if (entry !== undefined) {
      if (entry.agent !== undefined && entry.agent.order.kind !== "idle") {
        entry.agent.settle({ id: entry.agent.order.id, kind: entry.agent.order.kind, host: entry.agent.order.host, from: entry.agent.order.from, ok: false, died: true, detail: reason });
      }
      // "The main induce agent should also kill the linked agent when it
      // dies": the one-off is bound to this vantage, so retiring the vantage
      // kills it. The kill runs its atExit synchronously, which settles.
      if (entry.sidecar !== undefined) {
        killPid(hostname, entry.sidecar.pid);
        entry.sidecar = undefined;
      }
      if (entry.sidecarOrder !== undefined) {
        orderById.delete(entry.sidecarOrder.id);
        settleCompletion(entry.sidecarOrder.id);
        entry.sidecarOrder = undefined;
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
      entry.lastPlantAt = undefined;
    }
    bootstrapDoneSet.delete(hostname);
    needsInventory.delete(hostname);
  };
  const retireLifetime = (hostname: string, reason: string): void => {
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
    removePendingFor(pendingHosts, hostname);
    removePendingFor(pendingCredentials, hostname);
    pendingCredentialRejections.delete(hostname);
    removePendingFor(pendingAttempts, hostname);
    removePendingFor(pendingLogDrains, hostname);
  };
  const retireRejectedCredential = (hostname: string): void => {
    retireOrders(hostname, "credential rejected", (o) => o.kind === "plant");
    vault.delete(hostname);
    const host = hosts.get(hostname);
    if (host !== undefined) delete host.credentialKnown;
    authenticationEpoch.delete(hostname);
    removePendingFor(provisionalPool, hostname);
    removePendingFor(pendingCredentials, hostname);
    pendingCredentialRejections.set(hostname, { hostname, ...(host?.identity !== undefined ? { identity: host.identity } : {}), at: Date.now() });
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
    pendingCredentials.push(verified);
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
      pendingHosts.push(named);
    }
    const pendingAuthRecords = hosts.get(hostname)?.ring?.pendingAuthRecords ?? 0;
    const outcome: LogDrainOutcome = { pendingAuthRecords, evidence: [evidence] };
    foldLogDrain(hosts.get(hostname), outcome);
    pendingLogDrains.push({ hostname, outcome });
  };
  const recordAttempt = (hostname: string, outcome: AttemptOutcome): void => {
    foldAttempts(hosts.get(hostname), [outcome]);
    if (!pendingAttempts.some((e) => e.hostname === hostname && e.outcome === outcome)) pendingAttempts.push({ hostname, outcome });
  };
  const recordLogDrain = (hostname: string, outcome: LogDrainOutcome): void => {
    foldLogDrain(hosts.get(hostname), outcome);
    pendingLogDrains.push({ hostname, outcome });
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
      .map((kind) => [kind, costOf(ns, kind)]),
  ) as Record<TaskKind, number>;
  const proberGb = proberReserveGb(ns);
  const controllerGb = priceCalls(ns, CONTROLLER_CALLS);
  const residentGb = priceCalls(ns, KIND_CALLS.idle);
  const bootstrapGb = priceCalls(ns, KIND_CALLS.bootstrapReclaim);
  const heaviestJobGb = Math.max(...ROUTINE_KINDS.map((kind) => budgets[kind] ?? 0));
  const farmGbPerThread: Record<FarmKind, number> = {
    cache: budgets["cache"] ?? budgets["inventory"]!,
    reclaim: budgets["reclaim"] ?? budgets["inventory"]!,
    phish: budgets["phish"] ?? budgets["inventory"]!,
    promote: budgets["promote"] ?? budgets["inventory"]!,
  };
  const usableGb = (hostname: string, at: number, expiry: ExpiryOpts, reserveProber = true): number => {
    const host = hosts.get(hostname);
    if (host === undefined) return 0;
    const view = planningView(host, at, expiry);
    if (view.maxRam === undefined) return 0;
    const blocked = view.blockedRam ?? 0;
    // Darkweb keeps BOTH pieces of infrastructure beside its spawn-chain
    // agent. Ordinary hosts keep only the prober; the lab walker keeps neither.
    const fixedReserve = reserveProber ? proberGb + (hostname === selfHost ? controllerGb : 0) : 0;
    return Math.max(0, view.maxRam - blocked - fixedReserve);
  };
  const killWalkHostProber = (host: string): void => {
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
      pendingHosts.push(...result.hosts);
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

  const retireLostEdgeOrders = (entry: HostEntry, vantage: string, neighbours: readonly string[]): number => {
    const lost = (host: string, sessionOnly: boolean): boolean =>
      host !== vantage && !sessionOnly && !neighbours.includes(host);
    // A plant carries a whole frontier, and one severed edge costs it one
    // target rather than the order: prune in place, and only an order left
    // with nothing to reach is retired.
    for (const o of [...(entry.staged ?? []), entry.agent?.order].filter((o): o is Order => o?.kind === "plant")) {
      if (o.from !== vantage) continue;
      o.targets = (o.targets ?? []).filter((t) => !lost(t.host, t.sessionOnly === true));
    }
    const applies = (o: Order): boolean => o.from === vantage
      && (o.kind === "plant"
        ? (o.targets ?? []).length === 0
        : lost(o.host, false));
    const staged = entry.staged ?? [];
    const retired = staged.filter(applies);
    if (retired.length > 0) {
      entry.staged = staged.filter((o) => !applies(o));
      for (const o of retired) retireStaged(o, "edge-lost", `${o.host} is no longer adjacent to ${vantage}`);
    }
    let active = 0;
    if (entry.agent !== undefined && entry.agent.order.kind !== "idle" && applies(entry.agent.order)) {
      cancelActive(entry, `${entry.agent.order.host} is no longer adjacent to ${vantage}`);
      active = 1;
    }
    return retired.length + active;
  };
  const retireLostPin = (entry: HostEntry, host: string, neighbours: readonly string[]): number => {
    const doomed = (o: Order): boolean => o.kind === "pin" && o.unpin !== true && o.edge !== undefined && !neighbours.includes(o.edge);
    const staged = entry.staged ?? [];
    const retired = staged.filter(doomed);
    if (retired.length > 0) {
      entry.staged = staged.filter((o) => !doomed(o));
      for (const o of retired) retireStaged(o, "edge-lost", `${host}'s edge to ${o.edge} is gone; pin abandoned before spending`);
    }
    return retired.length;
  };

  const onReport = (report: Report): void => {
    const order = orderById.get(report.id);
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
      pendingHosts.push(gone);
    } else if (report.targetState === "replaced"
      && report.hosts?.some((h) => h.hostname === report.host && h.present && h.identity !== undefined && h.identity !== order?.targetIdentity) !== true) {
      retireLifetime(report.host, "server identity changed");
    } else if (report.targetState === "credential-rejected") {
      retireRejectedCredential(report.host);
    } else if (report.targetState === "launch-refused"
      && (order?.targets ?? []).some((t) => t.host === report.host && t.sessionOnly === true)
      && !stasisLinked.has(report.host)) {
      invalidateBackdoor(report.host);
    }
    if (report.kind === "plant" && order?.bootstrapReclaim !== true && (report.ok || report.targetState === "launch-refused")) {
      ensureEntry(report.host).lastPlantAt = Date.now();
    }
    if (report.kind === "pin" && report.ok) {
      const linked = order?.unpin !== true;
      recordStasis(report.host, linked);
      if (linked && order?.edge !== undefined) killWalkHostProber(report.host);
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
    if (report.kind === "attempt" && order?.guess !== undefined && lastAttempt !== undefined && conclusiveAttempt(lastAttempt)) {
      spentGuesses.add(`${report.host} ${order.guess}`);
    }
    // A game kill of a live process: count the loss and let the next derive replant.
    if (report.died === true) {
      if (report.kind !== "idle") {
        residentsLost++;
        if (order?.bootstrapReclaim !== true && report.kind === "plant") ensureEntry(report.host).lastPlantAt = Date.now();
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
    // Completion may make new work possible; re-derive promptly.
    if (report.died !== true) signalDerive();
  };

  const stage = (entry: HostEntry, order: Order): boolean => {
    const staged = entry.staged ??= [];
    if (staged.some((o) => o.id === order.id) || entry.agent?.order.id === order.id) return false;
    // The cap protects an agent from accumulating strategic work. Admission
    // housekeeping neither blocks the lane nor counts against that cap; it may
    // join a full blocking queue and sorts to its front below.
    const strategicDepth = strategicQueueDepth(staged);
    if (!isSameTurn(order.kind) && strategicDepth >= MAX_STAGED_PER_HOST) return false;
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
    const at = staged.findIndex((o) => compareQueuedDnetWork(order, o) < 0);
    if (at === -1) staged.push(order); else staged.splice(at, 0, order);
    signalWake(entry);
    return true;
  };

  /** The backstop, never the first move: kill an agent that was asked to stop
   * on an EARLIER pass and is still running, which means its body is parked in
   * one blocking call and cannot see the flag itself. */
  const hardCancelSweep = (): number => {
    let killed = 0;
    for (const entry of hosts.values()) {
      const agent = entry.agent;
      if (agent === undefined || agent.order.kind === "idle" || !hardCancelReady(agent, derivePass)) continue;
      let alive = false;
      try { alive = ns["isRunning"](agent.pid, entry.hostname); } catch { alive = false; }
      if (!alive) continue;
      ns["kill"](agent.pid);
      killed++;
    }
    return killed;
  };

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
      if (entry.agent?.order.kind === "walk") note(entry.hostname, entry.agent.order.scout === true);
      for (const o of entry.staged ?? []) if (o.kind === "walk") note(entry.hostname, o.scout === true);
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
      if (entry.agent !== undefined && entry.agent.order.kind !== "idle") orders.push(entry.agent.order);
      // The CLAIMED order counts too. `preparePlant` moves it here for the whole
      // length of a plant, and a target that is invisible to `busy()` for those
      // seconds gets the same work derived again onto a second vantage.
      if (entry.pendingOrder !== undefined && entry.pendingOrder.id !== entry.agent?.order.id) {
        orders.push(entry.pendingOrder);
      }
      // Sidecar work is real in-flight work: the running one-off and the order
      // the launch hop has claimed but not yet exec'd.
      if (entry.sidecar !== undefined) orders.push(entry.sidecar.order);
      if (entry.sidecarOrder !== undefined && entry.sidecarOrder.id !== entry.sidecar?.order.id) {
        orders.push(entry.sidecarOrder);
      }
      orders.push(...(entry.staged ?? []));
      for (const o of orders) {
        if (o.kind === "idle" || o.kind === "bootstrapReclaim" || o.kind === "launchSidecar") continue;
        const held = projected.get(o.host) ?? [];
        held.push({ from: entry.hostname, kind: o.kind as TaskKind });
        projected.set(o.host, held);
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
  const fileTask = (task: Task): boolean => {
    // Only a host with a live agent can run an order. A plant TARGET may not
    // have one yet; the plant runs on `from`, which does.
    const runner = hosts.get(task.from);
    if (!runner || runner.agent === undefined) return false;
    const isWalk = task.kind === "walk";
    // A mortal scout keeps its prober and its ordinary recovery: only the
    // finisher's host is consumed whole.
    const isScout = isWalk && task.scout === true;
    // A stasis edge is a remote recovery guarantee. Spend that host's RAM on
    // work, not spawn; unpin is the exception because success removes it.
    const controllerManaged = (isWalk && !isScout)
      || (stasisLinked.has(task.from) && !(task.kind === "pin" && task.unpin === true));
    // A SECOND induce beside one already held by this vantage becomes a LINKED
    // ONE-OFF: spawn-free, exec'd by the resident's transient `launchSidecar`
    // hop, so both 6 s calls run CONCURRENTLY instead of queueing — "I have
    // X GB and six seconds, find something to do." Not on managed vantages
    // (their resident hands staged work to the remote dispatcher, so the hop
    // never runs), and at most one one-off per host at a time.
    if (task.kind === "induce" && !controllerManaged) {
      const main = [runner.agent.order, runner.pendingOrder, ...(runner.staged ?? [])]
        .find((o) => o !== undefined && o.kind === "induce" && o.oneOff !== true);
      const occupied = runner.sidecar !== undefined || runner.sidecarOrder !== undefined
        || (runner.staged ?? []).some((o) => o.oneOff === true);
      if (main !== undefined && !occupied) {
        const sideBudget = priceCalls(ns, orderCalls("induce", true)); // spawn-free
        const hopGb = priceCalls(ns, orderCalls("launchSidecar", false));
        const sideRoom = usableGb(task.from, Date.now(), expiryOpts())
          - Math.max(main.ramOverrideGb * main.threads, hopGb);
        const sideThreads = Math.min(task.threads ?? 1, Math.floor(sideRoom / sideBudget));
        if (sideThreads >= 1) {
          return stage(runner, {
            id: task.id,
            kind: task.kind,
            host: task.host,
            from: task.from,
            ramOverrideGb: sideBudget,
            threads: sideThreads,
            priority: task.priority,
            longLived: false,
            label: task.reason,
            jobThreads: sideThreads,
            oneOff: true,
            ...(hosts.get(task.host)?.identity !== undefined ? { targetIdentity: hosts.get(task.host)!.identity } : {}),
          });
        }
        // Does not fit beside the main: fall through and file it serially.
      }
    }
    const budget = priceCalls(ns, orderCalls(task.kind, controllerManaged));
    // RAM a live (or hop-claimed) one-off holds is not free: the successor
    // chain sized against it would spawn into a full host and die.
    const sideHeld = runner.sidecar?.order ?? runner.sidecarOrder;
    const room = usableGb(task.from, Date.now(), expiryOpts(), !isWalk || isScout)
      - (sideHeld !== undefined ? sideHeld.ramOverrideGb * sideHeld.threads : 0);
    const threads = threadsFor(room, budget, THREAD_SCALED_KINDS.has(task.kind), task.threads ?? 1);
    if (threads < 1 || budget * threads > room) return false;
    // Only once the order is certain to be staged: a refused walk that had
    // already killed the prober would leave the lab candidate — the one host
    // `reviveProbers` deliberately skips — blind for good.
    if (isWalk && !isScout && strategicQueueDepth(runner.staged ?? []) < MAX_STAGED_PER_HOST) killWalkHostProber(task.from);
    const order: Order = {
      id: task.id,
      kind: task.kind,
      host: task.host,
      from: task.from,
      ramOverrideGb: budget,
      threads,
      priority: task.priority,
      longLived: task.kind === "walk",
      label: task.reason,
      jobThreads: threads,
      ...(controllerManaged ? { controllerManaged: true } : {}),
      ...(task.kind === "reclaim" && task.host === task.from ? (() => {
        const maxRam = fresh<number>(hosts.get(task.from), "maxRam", Date.now(), expiryOpts());
        const threshold = maxRam === undefined ? undefined : maxRam - proberGb - budget * (threads + 1);
        return threshold !== undefined && threshold >= 0 ? { resizeAtBlockedRam: threshold } : {};
      })() : {}),
      ...(vault.has(task.host) ? { password: vault.get(task.host)!.password } : {}),
      ...(hosts.get(task.host)?.identity !== undefined ? { targetIdentity: hosts.get(task.host)!.identity } : {}),
      ...(task.filename !== undefined ? { filename: task.filename } : {}),
      ...(task.symbol !== undefined ? { symbol: task.symbol } : {}),
      ...(task.edge !== undefined ? { edge: task.edge } : {}),
      ...(task.unpin === true ? { unpin: true } : {}),
      ...(task.route !== undefined ? { route: task.route } : {}),
      ...(isScout ? { scout: true } : {}),
      ...(task.guessId !== undefined && guessFor.has(task.guessId) ? { guess: guessFor.get(task.guessId)! } : {}),
      ...(task.followAttemptIds !== undefined ? { followAttemptIds: [...task.followAttemptIds] } : {}),
      ...(task.skipInitialBleed === true ? { skipInitialBleed: true } : {}),
      ...(task.kind === "bleed" || task.kind === "attempt" ? { knownHosts: [...hosts.keys()] } : {}),
      ...(task.kind === "plant" ? {
        // Every per-target fact is resolved HERE, once, so the body never
        // reaches back into the controller for one. A target whose credential
        // has since gone is simply not on the frontier.
        targets: (task.targets ?? []).flatMap((target) => {
          const credential = vault.get(target.host);
          if (credential === undefined) return [];
          return [{
            host: target.host,
            password: credential.password,
            ...(hosts.get(target.host)?.identity !== undefined ? { identity: hosts.get(target.host)!.identity } : {}),
            ...(stasisLinked.has(target.host) ? { controllerManaged: true } : {}),
            ...(target.remote ? { sessionOnly: true } : {}),
            ...(target.bootstrapReclaim ? { bootstrapReclaim: true } : {}),
            ...(target.bootstrapThreads !== undefined ? { bootstrapThreads: target.bootstrapThreads } : {}),
            ...(target.omitProber ? { omitProber: true } : {}),
          }];
        }),
        payloads,
      } : {}),
    };
    return stage(runner, order);
  };

  // --- observation ----------------------------------------------------------
  const describeHostLocal = (host: string, neighbours?: readonly string[], seenAt = Date.now()): ReportHost => {
    const details = ns["dnet"]["getServerDetails"](host);
    if (!details.isOnline) return { hostname: host, at: seenAt, present: false };
    const identity = ns["dnsLookup"](host);
    const maxRam = ns["getServerMaxRam"](host);
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
  const tryDescribe = (host: string, neighbours?: readonly string[], seenAt = Date.now()): ReportHost => {
    try { return describeHostLocal(host, neighbours, seenAt); } catch { return { hostname: host, at: seenAt, present: false }; }
  };

  /** Probe records already folded. Identity, never a wall-clock watermark: a
   * derive now runs on the turn a fact lands, so two of them share a
   * millisecond routinely, and a `<= lastDrainAt` watermark silently swallowed
   * a probe reported inside the same one — permanently, since the stamp only
   * moves forward. Each `reportProbe` writes a fresh record, so the record IS
   * the identity, and a weak set means a retired host's entry still collects. */
  const foldedProbes = new WeakSet<NonNullable<HostEntry["prober"]>>();
  /** The mutation generation whose full detail sweep has already run. The
   * EPOCH, for the same reason `foldedProbes` is a set: "once per mutation" is
   * a statement about generations, and a wall-clock watermark loses a sweep
   * whenever a derive and the mutation that should have triggered it share a
   * millisecond. */
  let sweptEpoch: number | undefined;
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
      cover(tryDescribe(entry.hostname, probe.neighbours, probe.at));
      for (const neighbour of probe.neighbours) if (hosts.get(neighbour) === undefined) cover(tryDescribe(neighbour, undefined, at));
    }
    if (sweptEpoch !== rendezvous.mutationEpoch) {
      sweptEpoch = rendezvous.mutationEpoch;
      for (const entry of [...hosts.values()]) {
        if (entry.goneAt !== undefined || entry.hostname === selfHost || covered.has(entry.hostname)) continue;
        cover(tryDescribe(entry.hostname, undefined, at));
      }
    }
    if (observed.length > 0) absorb({ id: "probe-drain", kind: "inventory", host: selfHost, from: selfHost, ok: true, hosts: observed });
    for (const h of newlySeen) needsInventory.add(h);
  };

  const drainBootstrapDone = (at: number): void => {
    for (const entry of [...hosts.values()]) {
      const running = entry.bootstrap;
      if (running === undefined) continue;
      let alive = false;
      try { alive = ns["isRunning"](running.pid, entry.hostname); } catch { alive = false; }
      if (!alive) { entry.bootstrap = undefined; bootstrapDoneSet.add(entry.hostname); }
    }
    if (bootstrapDoneSet.size === 0) return;
    const observed = [...bootstrapDoneSet].map((h) => tryDescribe(h, undefined, at)).filter((h): h is ReportHost => h !== undefined);
    for (const h of bootstrapDoneSet) { const e = hosts.get(h); if (e) e.lastPlantAt = undefined; needsInventory.add(h); }
    bootstrapDoneSet.clear();
    if (observed.length > 0) absorb({ id: "bootstrap-done", kind: "inventory", host: selfHost, from: selfHost, ok: true, hosts: observed });
  };

  const reviveProbers = (): void => {
    if (prevMutationAt === 0) return;
    for (const entry of hosts.values()) {
      const host = entry.hostname;
      if (host === labCandidateHost || entry.agent?.order.kind === "walk") continue;
      if (entry.agent === undefined) continue; // only a host with a resident can re-exec
      const probe = entry.prober;
      if (probe !== undefined && probe.at >= prevMutationAt) continue;
      if (entry.agent?.order.kind === "relaunchProbe" || (entry.staged ?? []).some((o) => o.kind === "relaunchProbe")) continue;
      fileTask({
        id: `relaunchProbe:${host}`,
        kind: "relaunchProbe",
        host,
        from: host,
        filename: proberFile,
        priority: DNET_PRIORITY["relaunchProbe"],
        reason: "prober stamp went stale; re-establishing this host's adjacency",
      });
    }
  };

  const fileListJobs = (): void => {
    if (needsInventory.size === 0) return;
    for (const host of [...needsInventory]) {
      const entry = hosts.get(host);
      if (!entry || entry.agent === undefined) continue;
      if (entry.agent?.order.kind === "inventory" || (entry.staged ?? []).some((o) => o.kind === "inventory")) { needsInventory.delete(host); continue; }
      const filed = fileTask({ id: `inventory:${host}`, kind: "inventory", host, from: host, priority: DNET_PRIORITY["inventory"], reason: "files may have changed; listing them" });
      if (filed) needsInventory.delete(host);
    }
  };

  const bootstrapHosts = (): string[] => [...hosts.values()].filter((e) => e.bootstrap !== undefined).map((e) => e.hostname);
  const lastPlantMap = (): Map<string, number> => {
    const map = new Map<string, number>();
    for (const entry of hosts.values()) if (entry.lastPlantAt !== undefined) map.set(entry.hostname, entry.lastPlantAt);
    return map;
  };
  const spreadLimits = () => ({
    ...DEFAULT_SPREAD_LIMITS,
    agentRamGb: residentGb + proberGb,
    residentRamGb: residentGb,
    managedResidentRamGb: priceCalls(ns, orderCalls("idle", true)),
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

  /** `planSpread` refuses `unknown-ram` with "survey it before planting". This
   * is that survey, and it belongs to the derive rather than to whatever wrote
   * the credential.
   *
   * A host we hold a password for and are not standing on is one `exec` away
   * from being a vantage, so it is worth one local `getServerDetails` the
   * moment its RAM facts stop being believable — or the moment it has no map
   * entry at all, which is every restored credential after a reload. The
   * controller can describe any NAMED darknet host directly, so the vault a
   * cold boot reads back seeds its own candidates here rather than waiting for
   * a prober to happen past each one. */
  const surveyPlantTargets = (at: number): void => {
    const expiry = expiryOpts();
    const surveyed: ReportHost[] = [];
    for (const hostname of vault.keys()) {
      const entry = hosts.get(hostname);
      if (entry?.goneAt !== undefined || entry?.agent !== undefined) continue;
      if (entry !== undefined && fresh<number>(entry, "maxRam", at, expiry) !== undefined) continue;
      surveyed.push(tryDescribe(hostname, undefined, at));
    }
    if (surveyed.length === 0) return;
    absorb({ id: "plant-survey", kind: "inventory", host: selfHost, from: selfHost, ok: true, hosts: surveyed });
  };

  // --- the whole derive pass ------------------------------------------------
  const fileWork = (at: number): Task[] => {
    drainBootstrapDone(at);
    drainProbes(at);
    reviveProbers();
    fileListJobs();
    if (lastStormFiredAt !== undefined && at - lastStormFiredAt < STORM_QUIET_MS) {
      const quietLeft = Math.round((STORM_QUIET_MS - (at - lastStormFiredAt)) / 1000);
      storm = { admitted: 0, refused: { "storm-in-flight": 1 }, examples: [{ host: "(net)", why: "storm-in-flight", detail: `the storm we fired is rerolling the net; deriving nothing for ${quietLeft}s more` }], firedAt: lastStormFiredAt };
      return [];
    }
    surveyPlantTargets(at);
    const remoteExec = remoteExecSet(at);
    const spreadCandidates = candidatesFrom(knowledge, at, {
      standing: new Set([selfHost, ...liveEntries().map((e) => e.hostname), ...bootstrapHosts()]),
      vault: new Set(vault.keys()),
      lastPlantAt: lastPlantMap(),
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
        busy: new Set([...(entry.agent !== undefined && entry.agent.order.kind !== "idle" ? [entry.agent.order.kind] : []), ...(entry.staged ?? []).map((o) => o.kind)]) as ReadonlySet<string>,
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
    spread = { planted: plan.plant.length, ...foldRefusals(plan.refused) };

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
    const filed = new Set<string>();
    for (const task of tasks) {
      let filedTask = task;
      if (task.followAttemptIds !== undefined) {
        const followed = task.followAttemptIds.filter((id) => filed.has(id));
        for (const id of task.followAttemptIds) if (!filed.has(id)) orderDone.delete(id);
        if (followed.length === 0) continue;
        filedTask = { ...task, followAttemptIds: followed };
      }
      if (fileTask(filedTask)) filed.add(task.id);
    }
    return tasks;
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
      if (task.kind !== "walk" && task.kind !== "plant" && task.kind !== "cache" && task.kind !== "pin" && task.kind !== "attempt" && task.kind !== "bleed") continue;
      const candidates: PreemptionCandidate[] = [];
      for (const host of task.eligibleFrom ?? [task.from]) {
        const entry = hosts.get(host);
        if (entry === undefined || entry.agent === undefined) continue;
        const strategicDepth = strategicQueueDepth(entry.staged ?? []);
        if (strategicDepth + (assigned.get(host) ?? 0) >= MAX_STAGED_PER_HOST) continue;
        const active = entry.agent?.order.kind !== "idle" ? entry.agent : undefined;
        candidates.push(preemptionCandidateFromHandle(host, active, {
          usableGb: usableGb(host, at, expiry),
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
        if (active !== undefined && active.order.kind !== "idle" && active.cancelReason === undefined) {
          cancelActive(entry!, `preempted: ${task.kind} on ${task.host} outranks ${active.order.kind}`);
          cancelled.add(choice.vantage);
        }
      }
    }
  };

  const reconcilePending = (at: number): void => {
    const expiry = expiryOpts();
    const staleReason = (order: Order): string | undefined => {
      const host = hosts.get(order.host);
      if (!host || host.goneAt !== undefined) return "target is gone";
      if (order.targetIdentity !== undefined && host.identity !== undefined && order.targetIdentity !== host.identity) return "target identity changed";
      if (order.kind === "attempt" && vault.has(order.host)) return "credential already verified";
      if (order.kind === "plant" && hosts.get(order.host)?.agent !== undefined) return "resident already present";
      if (order.kind === "cache" && order.filename !== undefined && !(fresh<string[]>(host, "caches", at, expiry) ?? []).includes(order.filename)) return "cache listing changed";
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
          && at - (entry.pendingOrderAt ?? 0) > PENDING_ORDER_GRACE_MS) {
          // Still a valid order, but its spawn died with it in hand: nobody is
          // coming to adopt it. Hand it back to the queue — the next resident
          // (or a re-plant) picks it up and runs it at its own price.
          entry.pendingOrder = undefined;
          (entry.staged ??= []).unshift(pending);
        }
      }
      // The sidecar mirror of the pending slot: the hop claimed an order but
      // the one-off never adopted it (the exec'd process died before its first
      // read). Nobody else inspects this slot; time the claim out the same way.
      const side = entry.sidecarOrder;
      if (side !== undefined) {
        const reason = staleReason(side);
        if (reason !== undefined) {
          entry.sidecarOrder = undefined;
          retireStaged(side, "cancelled", reason);
        } else if (entry.sidecar === undefined && at - (entry.sidecarOrderAt ?? 0) > PENDING_ORDER_GRACE_MS) {
          entry.sidecarOrder = undefined;
          retireStaged(side, "cancelled", "the one-off died before adopting its order");
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
      pendingMutations++;
      mutationSweepDue = true;
      signalDerive();
      return rendezvous.mutationEpoch;
    },
    wake() { signalDerive(); },
    adopt(host, handle, sidecar) {
      const entry = ensureEntry(host);
      if (sidecar === true) {
        // At most one linked one-off per host. A stale prior occupant is a
        // dead process whose atExit lost the race with this boot: retire it.
        if (entry.sidecar !== undefined && entry.sidecar !== handle) {
          killPid(host, entry.sidecar.pid);
        }
        entry.sidecar = handle;
      } else {
        entry.agent = handle;
      }
      if (handle.order.kind !== "idle") {
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
        if (Date.now() - (entry.probeRefreshAt ?? 0) <= PROBE_REFRESH_DEADLINE_MS) {
          return { refresh: entry.probeRefresh, launch: false };
        }
        // The barrier outlived any live prober's first report: its launcher
        // died between exec and settle. Left standing, every later plant on
        // this host would await it forever — the prober-only orphan loop.
        const stale = entry.probeRefresh;
        entry.probeRefresh = undefined;
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
      entry.probeRefreshAt = Date.now();
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
    preparePlant(host) {
      const entry = ensureEntry(host);
      needsInventory.add(host);
      const controllerManaged = stasisLinked.has(host);
      // A live, tracked prober is reusable on ANY host, not only a
      // stasis-managed one. Launching a second prober beside a survivor both
      // wastes its 1.8 GB and — in the band where usableRam admits one prober
      // but not two — makes the resident exec fail with `launch-refused` every
      // 60 s forever, which is exactly the prober-only orphan state observed
      // in play.
      const proberPid = entry.prober?.pid;
      const reuseProber = proberPid !== undefined
        && proberPid > 0 && ns["isRunning"](proberPid, host);
      let next = controllerManaged
        ? entry.pendingOrder ?? (entry.staged ??= []).shift()
        : undefined;
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
        let free: number | undefined;
        try {
          const details = ns["dnet"]["getServerDetails"](host);
          free = details.isOnline
            ? Math.max(0, ns["getServerMaxRam"](host) - details.blockedRam - proberGb)
            : undefined;
        } catch {
          free = undefined;
        }
        if (free !== undefined && next.ramOverrideGb > 0) {
          if (THREAD_SCALED_KINDS.has(next.kind)) {
            const fit = Math.floor(free / next.ramOverrideGb);
            if (fit >= 1 && fit < next.threads) {
              next.threads = fit;
              next.jobThreads = fit;
            }
          }
          if (next.ramOverrideGb * next.threads > free) {
            retireStaged(next, "cancelled", `no longer fits ${host} beside its block and prober`);
            entry.pendingOrder = undefined;
            next = undefined;
          }
        }
      }
      if (next !== undefined) {
        next.controllerManaged = true;
        entry.pendingOrder = next;
        entry.pendingOrderAt = Date.now();
      }
      return { controllerManaged, ...(next !== undefined ? { next } : {}), reuseProber };
    },
    registerBootstrap(host, pid) { ensureEntry(host).bootstrap = { pid, startedAt: Date.now() }; },
    bootstrapDone(host) { const e = hosts.get(host); if (e) e.bootstrap = undefined; bootstrapDoneSet.add(host); signalDerive(); },
    deps,
    drain(): DnetDrain {
      const lab = labReport(Date.now());
      const ramAt = Date.now();
      // HOME calls `drain()` in its OWN process, so every ns call below runs
      // against THIS script's ns from a foreign stack. A controller that has
      // died (darkweb rebooted, an unhandled throw) leaves its rendezvous
      // installed, and the next call then raises OUR ScriptDeath inside home's
      // feature loop — which rethrows ScriptDeath by design and would take home
      // down with us. The sample is a convenience; skipping it is not.
      let ram: DnetDrain["ram"] = [];
      try {
        ram = [...hosts.keys()].flatMap((host) => {
          const details = ns["dnet"]["getServerDetails"](host);
          if (!details.isOnline) return [];
          const total = Math.max(0, ns["getServerMaxRam"](host));
          const occupied = Math.max(0, Math.min(ns["getServerUsedRam"](host), total));
          const blocked = Math.max(0, Math.min(details.blockedRam, total));
          return [{
            host,
            at: ramAt,
            total,
            blocked,
            used: Math.max(0, occupied - blocked),
          }];
        });
      } catch {
        ram = [];
      }
      const drained: DnetDrain = {
        hosts: pendingHosts.splice(0, pendingHosts.length),
        credentials: pendingCredentials.splice(0, pendingCredentials.length),
        attempts: pendingAttempts.splice(0, pendingAttempts.length),
        logDrains: pendingLogDrains.splice(0, pendingLogDrains.length),
        codes: { ...codes },
        ...(spread ? { spread } : {}),
        ...(farm ? { farm } : {}),
        ...(hold ? { hold } : {}),
        ...(storm ? { storm } : {}),
        ...(pendingStasisSnapshot !== undefined ? { stasisSnapshot: pendingStasisSnapshot } : {}),
        credentialRejections: [...pendingCredentialRejections.values()],
        backdoorInvalidations: [...pendingBackdoorInvalidations.values()],
        ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
        ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
        ...(lastStormFiredAt !== undefined ? { stormFiredAt: lastStormFiredAt } : {}),
        ...(grammarUnrecognised > 0 ? { grammar: { unrecognised: grammarUnrecognised, shapes: { ...grammarShapes } } } : {}),
        karmaLoss,
        ...(hasDnetProfit(profit) ? { profit } : {}),
        residents: liveEntries().map((entry) => ({
          host: entry.hostname,
          lastBeatAt: entry.agent?.beatAt ?? Date.now(),
          pending: (entry.staged ?? []).length,
          ...(entry.agent !== undefined && entry.agent.order.kind !== "idle" ? { active: entry.agent.order.kind } : {}),
          ...(entry.sidecar !== undefined ? { sidecar: entry.sidecar.order.kind } : {}),
          freeGb: usableGb(entry.hostname, Date.now(), expiryOpts()),
          completed: entry.completed ?? 0,
          failed: entry.failed ?? 0,
          ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
        })),
        ram,
        residentsLost,
        mutations: pendingMutations,
        ...(lab !== undefined ? { lab } : {}),
      };
      for (const key of Object.keys(codes)) delete codes[key];
      karmaLoss = 0;
      profit = emptyDnetProfit();
      residentsLost = 0;
      pendingMutations = 0;
      pendingStasisSnapshot = undefined;
      pendingCredentialRejections.clear();
      pendingBackdoorInvalidations.clear();
      return drained;
    },
    order(rawOrders) {
      const orders = rawOrders as DnetOrders;
      charisma = orders.charisma;
      timingProfile = orders.timing;
      if (orders.netDepth !== undefined) netDepth = orders.netDepth;
      if (orders.bitNode !== undefined) bitNode = orders.bitNode;
      if (orders.vaultSnapshot !== undefined) {
        const { entries, at: snapshotAt } = orders.vaultSnapshot;
        const supplied = new Set(entries.map((e) => e.hostname));
        for (const [hostname, entry] of vault) if (!supplied.has(hostname) && entry.at <= snapshotAt) vault.delete(hostname);
        for (const entry of entries) {
          const host = hosts.get(entry.hostname);
          if (host?.goneAt !== undefined) continue;
          if (entry.identity !== undefined && host?.identity !== undefined && entry.identity !== host.identity) continue;
          vault.set(entry.hostname, entry);
          markCredentialKnown(host);
        }
        // A cold boot restores the passwords before it knows a single host.
        // The derive's own survey turns each into a describable candidate, so
        // the reload's spread wave starts on this turn rather than waiting for
        // probers to rediscover a net we already hold the keys to.
        signalDerive();
      }
      if (orders.openLabCache !== undefined) openLabCache = orders.openLabCache;
      if (orders.promoteSymbols !== undefined) promoteSymbols = [...orders.promoteSymbols];
      if (orders.crimeSuccessMult !== undefined) crimeSuccessMult = orders.crimeSuccessMult;
      if (orders.farmEconomics !== undefined) farmEconomics = orders.farmEconomics;
      if (orders.fileInvalidations !== undefined) {
        for (const invalidation of orders.fileInvalidations) {
          const entry = hosts.get(invalidation.host);
          if (entry === undefined || entry.goneAt !== undefined) continue;
          entry.dirty.files = true;
          needsInventory.add(invalidation.host);
        }
        fileListJobs();
        signalDerive();
      }
      if (orders.backdoors !== undefined) { backdoors.clear(); for (const e of orders.backdoors) backdoors.set(e.hostname, e.installedAt); }
      if (orders.stasisLimit !== undefined) stasisLimit = orders.stasisLimit;
      if (orders.labExpected !== undefined) labExpected = orders.labExpected;
      if (orders.stasisSnapshot !== undefined && orders.stasisSnapshot.at > stasisObservedAt) {
        stasisObservedAt = orders.stasisSnapshot.at;
        stasisLinked.clear();
        for (const hostname of orders.stasisSnapshot.hosts) stasisLinked.add(hostname);
        // A restored link is a durable asset the spread wave must not have to
        // re-DISCOVER, and it needs no seeding of its own: a stasis host worth
        // replanting is one we hold a password for, so the derive's survey
        // describes it along with every other restored credential.
        signalDerive();
      }
      if (orders.lastPhishCacheAt !== undefined) lastPhishCacheAt = Math.max(lastPhishCacheAt ?? 0, orders.lastPhishCacheAt);
      if (orders.lastStormAt !== undefined && orders.lastStormAt > (lastStormFiredAt ?? 0)) {
        lastStormFiredAt = orders.lastStormAt;
        if (Date.now() - lastStormFiredAt < STORM_QUIET_MS) stormWipeAt = lastStormFiredAt + STORM_QUIET_MS;
      }
      if (orders.standDown === true) standDown = true;
    },
  };

  // BOOTSTRAP: give the fold darkweb's identity, pre-create its entry.
  foldReports(knowledge, [{ hostname: selfHost, at: bootAt, present: true }], bootAt, expiryOpts());
  ensureEntry(selfHost);
  realm.dnet_controller = rendezvous;

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
      if (liveEntries().every((e) => e.agent?.order.kind === "idle" || e.agent === undefined)) break;
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
        const pid = entry.agent?.pid ?? entry.prober?.pid;
        if (pid !== undefined && pid > 0 && (entry.agent !== undefined || entry.prober !== undefined)) {
          let alive = false;
          try { alive = ns["isRunning"](pid, entry.hostname); } catch { alive = false; }
          if (!alive) {
            // `retireVantage` settles an ACTIVE order with `died`, and `onReport`
            // counts that loss itself — only a bare resident goes uncounted.
            if (entry.agent === undefined || entry.agent.order.kind === "idle") residentsLost++;
            retireVantage(entry.hostname, `${entry.hostname} process died during a mutation`);
            invalidateBackdoor(entry.hostname);
            continue;
          }
        }
      }
      // A resident that stopped beating. A live process is still
      // authoritative: request cancellation, but never detach it while it can
      // perform another side effect.
      if (entry.agent === undefined || entry.agent.order.kind !== "idle") continue;
      if (at - entry.agent.beatAt <= BEAT_WINDOW_MS) continue;
      let alive = false;
      try { alive = ns["isRunning"](entry.agent.pid, entry.hostname); } catch { alive = false; }
      if (alive) {
        killPid(entry.hostname, entry.agent.pid);
        continue;
      }
      residentsLost++;
      retireVantage(entry.hostname, `${entry.hostname} lost its resident`);
    }
    reconcilePending(at);
    // Ask expired work to stop. Eligible bodies are killed by the later sweep;
    // pin/walk remain tracked until their atomic/PID-bound work returns.
    for (const entry of hosts.values()) {
      const active = entry.agent;
      if (active === undefined || active.order.kind === "idle") continue;
      const expired = jobWatchdogExpired(active, at);
      if (expired) {
        // Settling alone only drops OUR handle: the process itself may be
        // perfectly alive, merely slow, and would then hold the host's whole
        // RAM budget for ever while the map reads the host as unstaffed and
        // re-plants it. Ask it to stop, then take the pid.
        cancelActive(entry, `${active.order.label} stopped at a call boundary on ${entry.hostname}`);
      }
      // A hung one-off has no cooperative path and nothing depends on its
      // process: take the pid; its atExit settles and clears the slot.
      const side = entry.sidecar;
      if (side !== undefined && jobWatchdogExpired(side, at)) {
        killPid(entry.hostname, side.pid);
      }
    }
    residentsSeenEver = Math.max(residentsSeenEver, liveEntries().length);

    // The watchdog pass: the bounded re-derive over whatever the sweeps above
    // just changed, and the only place `hardCancelSweep` may fire — it is
    // gated on `derivePass`, and killing from a write-through's stack could
    // take the caller.
    const tasks = fileWork(at);
    hardCancelSweep();

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

    await realmSleep(TICK_MS);
  }

  if (realm.dnet_controller === rendezvous) delete realm.dnet_controller;
  for (const entry of hosts.values()) {
    entry.probeRefresh?.settle(undefined);
    entry.probeRefresh = undefined;
    const probe = entry.prober;
    if (probe !== undefined && probe.pid > 0 && probe.pid !== ns.pid) ns["kill"](probe.pid);
  }
  TELEMETRY: if (__TELEMETRY__ && tel) tel.flush();
}

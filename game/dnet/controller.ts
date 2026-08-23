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
  deriveTasks,
  planSpread,
  planStorm,
  PLANT_PRIORITY,
  type DeriveOptions,
  type StormContext,
  type Task,
  type TaskKind,
} from "../../shared/strategy/dnet/plan.ts";
import { DNET_PRIORITY, choosePreemptionVantage, type PreemptionCandidate } from "../../shared/strategy/dnet/priority.ts";
import { planFarm, type FarmHost, type FarmKind, type PromoteSymbol } from "../../shared/strategy/dnet/farm.ts";
import { chooseLabVantage, holdHostFrom, planInduce, planStasis, stasisTargetDepths, unconqueredBands, type HoldHost, type HoldView } from "../../shared/strategy/dnet/hold.ts";
import { looseCandidates, type LooseTarget } from "../../shared/strategy/dnet/oracle.ts";
import type { PasswordEvidence } from "../../shared/strategy/dnet/evidence.ts";
import { exactNeighbourClueEpoch } from "../../shared/strategy/dnet/file-clues.ts";
import {
  DEFAULT_NET_DEPTH,
  STORM_BURST_MS,
  STORM_COOLDOWN_MS,
  STORM_QUIET_MS,
  isLabyrinth,
  labStage,
  msPerHostEvent,
  msPerHostEventAny,
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
  JOB_TIMEOUT_MS,
  KIND_CALLS,
  LONG_JOB_BEAT_MS,
  NO_RESPAWN_KINDS,
  THREAD_SCALED_KINDS,
  controllerIsLive,
  costOf,
  dnetRealm,
  hardCancelEligible,
  priceCalls,
  proberReserveGb,
  signalWake,
  threadsFor,
  type AgentHandle,
  type ControllerDeps,
  type ControllerHandle,
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

/** The darknet controller: one long-lived script that decides, and never acts.
 * It replaces `overseer.ts`. The shape is the spec's: one `hosts` map holding
 * both what we KNOW about each host and the process RUNNING on it. It stages
 * ORDERS as data; the agent runs them through a `switch` of direct calls. It
 * learns of completion the instant each agent's `done` promise settles, and it
 * cancels by resolving that agent's cancel promise from outside. It OBSERVES
 * only through synchronous reads and never BLOCKS. */

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

type HoldTask = NonNullable<DeriveOptions["hold"]>[number];

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
  let stasisLimit = 1;
  let labExpected = true;
  const backdoors = new Map<string, number>();
  let karmaLoss = 0;
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
  const orderById = new Map<string, Order>();
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
  let derivePending = false;
  let deriveWake: (() => void) | undefined;
  const signalDerive = (): void => {
    const wake = deriveWake;
    if (wake) wake();
    else derivePending = true;
  };
  const waitForDerive = (): Promise<void> => new Promise((resolve) => {
    if (derivePending) { derivePending = false; resolve(); return; }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (deriveWake === finish) deriveWake = undefined;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, TICK_MS);
    deriveWake = finish;
  });

  // --- helpers --------------------------------------------------------------
  const ensureEntry = (host: string): HostEntry => {
    const existing = hosts.get(host);
    if (existing) { existing.staged ??= []; return existing; }
    const created: HostEntry = { hostname: host, lastSeenAt: Date.now(), seenAt: {}, dirty: {}, staged: [] };
    hosts.set(host, created);
    return created;
  };
  const liveEntries = (): HostEntry[] => [...hosts.values()].filter((e) => e.agent !== undefined);
  const agentLastLife = (entry: HostEntry): number => {
    const agent = entry.agent;
    if (agent === undefined) return 0;
    if (agent.order.longLived) return Math.max(agent.beatAt, agent.beatAt + LONG_JOB_BEAT_MS);
    if (agent.order.kind !== "idle" && agent.startedAt !== undefined) return Math.max(agent.beatAt, agent.startedAt + JOB_TIMEOUT_MS);
    return agent.beatAt;
  };

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
      agent.cancelFire?.();
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
    }
  };
  const retireCracking = (hostname: string, reason: string): void => {
    forgetGuesses(hostname);
    retireOrders(hostname, reason, (o) => o.kind === "attempt");
  };
  const retireVantage = (hostname: string, reason: string): void => {
    const entry = hosts.get(hostname);
    if (entry !== undefined) {
      if (entry.agent !== undefined && entry.agent.order.kind !== "idle") {
        entry.agent.settle({ id: entry.agent.order.id, kind: entry.agent.order.kind, host: entry.agent.order.host, from: entry.agent.order.from, ok: false, died: true, detail: reason });
      }
      for (const o of entry.staged ?? []) orderById.delete(o.id);
      entry.agent = undefined;
      entry.staged = [];
      entry.pendingOrder = undefined;
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
  let queueAuthenticatedPlant!: (hostname: string, from: string) => void;
  let queueNeighbourGuess!: (hostname: string, password: string, from: string, at: number) => void;
  const recordCredential = (entry: VaultEntry, from: string): void => {
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
    queueAuthenticatedPlant(entry.hostname, from);
  };
  const recordLoose = (password: string): void => {
    if (loosePool.includes(password)) return;
    loosePool.push(password);
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
      queueNeighbourGuess(candidate.hostname, password, source, at);
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
  const deps: ControllerDeps = {
    charisma: () => charisma,
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
    const fixedReserve = reserveProber ? (hostname === selfHost ? controllerGb : proberGb) : 0;
    return Math.max(0, view.maxRam - blocked - fixedReserve);
  };
  const killWalkHostProber = (host: string): void => {
    const entry = hosts.get(host);
    const probe = entry?.prober;
    if (probe === undefined || probe.pid <= 0) return;
    ns["kill"](probe.pid);
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
    if (result.charismaNeeded !== undefined) charismaNeeded = Math.max(charismaNeeded ?? 0, result.charismaNeeded);
    if ((result.codes ?? {})[LOCAL_CODE.PhishingCacheWon] !== undefined) lastPhishCacheAt = at;
  };

  const retireLostEdgeOrders = (entry: HostEntry, vantage: string, neighbours: readonly string[]): number => {
    const applies = (o: Order): boolean => o.from === vantage && o.host !== vantage && o.sessionOnly !== true && !neighbours.includes(o.host);
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
    if (report.dirtied && report.kind !== "inventory") {
      needsInventory.add(report.host);
      fileListJobs();
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
    } else if (report.targetState === "launch-refused" && order?.sessionOnly === true && !stasisLinked.has(report.host)) {
      invalidateBackdoor(report.host);
    }
    if (report.kind === "plant" && order?.bootstrapReclaim !== true && (report.ok || report.targetState === "launch-refused")) {
      ensureEntry(report.host).lastPlantAt = Date.now();
    }
    if (report.kind === "pin" && report.ok) {
      const linked = order?.unpin !== true;
      recordStasis(report.host, linked);
      if (linked && order?.edge !== undefined) killWalkHostProber(report.host);
      retireVantage(report.host, "pin process ending");
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
    orderById.delete(report.id);
    // Completion may make new work possible; re-derive promptly.
    if (report.died !== true) signalDerive();
  };

  const stage = (entry: HostEntry, order: Order): boolean => {
    const staged = entry.staged ??= [];
    if (staged.length >= MAX_STAGED_PER_HOST) return false;
    if (staged.some((o) => o.id === order.id) || entry.agent?.order.id === order.id) return false;
    if (order.kind === "storm") {
      stormStampPrior = lastStormFiredAt;
      lastStormFiredAt = Date.now();
      stormWipeAt = lastStormFiredAt + STORM_QUIET_MS;
    }
    orderById.set(order.id, order);
    const at = staged.findIndex((o) => o.priority > order.priority);
    if (at === -1) staged.push(order); else staged.splice(at, 0, order);
    signalWake(entry);
    return true;
  };

  const hardCancelSweep = (): number => {
    let killed = 0;
    for (const entry of hosts.values()) {
      const agent = entry.agent;
      if (agent === undefined || agent.order.kind === "idle" || agent.pid <= 0 || agent.cancelReason === undefined || !hardCancelEligible(agent)) continue;
      let alive = false;
      try { alive = ns["isRunning"](agent.pid, entry.hostname); } catch { alive = false; }
      if (!alive) continue;
      ns["kill"](agent.pid);
      killed++;
    }
    return killed;
  };

  // --- projections (HoldHost / FarmHost from the flat entries) --------------
  const projectHoldHosts = (at: number, expiry: ExpiryOpts): HoldHost[] => {
    const walking = new Set<string>();
    for (const entry of hosts.values()) {
      if (entry.agent?.order.kind === "walk") walking.add(entry.hostname);
      for (const o of entry.staged ?? []) if (o.kind === "walk") walking.add(entry.hostname);
    }
    return [...hosts.values()].map((entry) => {
      const view = planningView(entry, at, expiry);
      return {
        ...holdHostFromView(view, entry, at),
        ...(view.difficulty !== undefined ? { difficulty: view.difficulty } : {}),
        ...(view.maxRam !== undefined ? { maxRam: view.maxRam } : {}),
        freeGb: usableGb(entry.hostname, at, expiry),
        ...(walking.has(entry.hostname) ? { irreplaceable: true } : {}),
      };
    });
  };
  const holdHostFromView = (view: DnetHost, entry: HostEntry, at: number): HoldHost => {
    void at;
    return {
      hostname: entry.hostname,
      ...(view.depth !== undefined ? { depth: view.depth } : {}),
      agentAlive: entry.agent !== undefined,
      hasCredential: vault.has(entry.hostname),
      ...(view.neighbours !== undefined ? { neighbours: view.neighbours } : {}),
      ...(view.isStationary === true ? { isStationary: true } : {}),
      ...(stasisLinked.has(entry.hostname) ? { stasisLinked: true } : {}),
      ...(entry.goneAt !== undefined ? { gone: true } : {}),
    };
  };

  const projectInFlight = (): Map<string, { from: string; kind: TaskKind }[]> => {
    const projected = new Map<string, { from: string; kind: TaskKind }[]>();
    for (const entry of hosts.values()) {
      const orders: Order[] = [];
      if (entry.agent !== undefined && entry.agent.order.kind !== "idle") orders.push(entry.agent.order);
      orders.push(...(entry.staged ?? []));
      for (const o of orders) {
        if (o.kind === "idle" || o.kind === "bootstrapReclaim") continue;
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

  // --- the walk / pins / hold plan (ported from overseer) -------------------
  const planWalk = (
    at: number, expiry: ExpiryOpts, holdHosts: readonly HoldHost[],
    refuse: (host: string, why: string, detail: string) => void,
  ): { lab?: HoldHost; candidate?: string; tasks: HoldTask[]; walking: boolean } => {
    const lab = holdHosts.find((h) => isLabyrinth(h.hostname, fresh<string>(hosts.get(h.hostname), "modelId", at, expiry)) && !h.gone);
    if (lab === undefined) return { tasks: [], walking: false };
    if (vault.has(lab.hostname)) { refuse(lab.hostname, "lab-walked", "we already hold this lab's password, so its maze has been finished"); return { lab, tasks: [], walking: false }; }
    const needed = labStage(lab.hostname)?.cha;
    if (needed !== undefined && charisma < needed) {
      charismaNeeded = Math.max(charismaNeeded ?? 0, needed);
      refuse(lab.hostname, "charisma", `the maze needs charisma ${needed}, and every move below it answers 451`);
      return { lab, tasks: [], walking: false };
    }
    let walkerAt: string | undefined;
    for (const entry of hosts.values()) {
      if (entry.agent?.order.kind === "walk") walkerAt = entry.hostname;
      for (const o of entry.staged ?? []) if (o.kind === "walk") walkerAt = entry.hostname;
    }
    const vantageHost = chooseLabVantage(holdHosts.filter((h) => (h.agentAlive || h.stasisLinked === true) && h.neighbours?.includes(lab.hostname) === true && vault.has(h.hostname)));
    const tasks: HoldTask[] = [];
    if (walkerAt === undefined) {
      const vantage = vantageHost?.hostname;
      if (vantage === undefined) { refuse(lab.hostname, "no-vantage", "nothing of ours is standing next to the labyrinth with room for a walker"); return { lab, tasks, walking: false }; }
      const standing = holdHosts.find((h) => h.hostname === vantage);
      if (standing?.stasisLinked !== true) { refuse(vantage, "walker-unpinned", "the lab candidate must be in position and stasis-linked before preparation finishes"); return { lab, candidate: vantage, tasks, walking: false }; }
      if (standing.blockedRam === undefined) { refuse(vantage, "ram-unknown", "the lab candidate's blocked RAM is not fresh"); return { lab, candidate: vantage, tasks, walking: false }; }
      if (standing.blockedRam > 0) { refuse(vantage, "ram-blocked", `${standing.blockedRam.toFixed(2)}GB remains before the lab walker can start`); return { lab, candidate: vantage, tasks, walking: false }; }
      if (hosts.get(vantage)?.agent === undefined) { refuse(vantage, "walker-unstaffed", "the pinned lab candidate is being reclaimed or awaiting its resident"); return { lab, candidate: vantage, tasks, walking: false }; }
      const maxRam = fresh<number>(hosts.get(vantage), "maxRam", at, expiry) ?? 0;
      if (budgets["walk"] === undefined || maxRam < budgets["walk"]) { refuse(vantage, "no-room", "the lab candidate cannot fit one legal walker thread"); return { lab, candidate: vantage, tasks, walking: false }; }
      tasks.push({ kind: "walk", host: lab.hostname, from: vantage, threads: Math.floor(maxRam / budgets["walk"]), reason: `walk the maze from ${vantage}` });
      walkerAt = vantage;
    }
    return { lab, candidate: walkerAt, tasks, walking: walkerAt !== undefined };
  };

  const admitPins = (
    at: number, expiry: ExpiryOpts, pin: readonly string[],
    refuse: (host: string, why: string, detail: string) => void, labHost?: string, remoteAfter = true,
  ): HoldTask[] => {
    const tasks: HoldTask[] = [];
    for (const hostname of pin) {
      const entry = hosts.get(hostname);
      const free = usableGb(hostname, at, expiry);
      if (entry?.agent !== undefined && budgets["pin"]! > free) { refuse(hostname, "no-room", `a 12 GB setStasisLink needs ${budgets["pin"]!.toFixed(2)}GB and ${free.toFixed(2)}GB is free`); continue; }
      const replanter = [...hosts.values()].some((other) => {
        if (other.hostname === hostname || other.agent === undefined) return false;
        return (fresh<string[]>(other, "neighbours", at, expiry) ?? []).includes(hostname);
      });
      if ((!remoteAfter && !replanter) || !vault.has(hostname)) {
        refuse(hostname, "no-replanter", remoteAfter ? "the host has no credential for its post-pin remote plant" : "releasing the link would leave no neighbour able to re-plant this host");
        continue;
      }
      tasks.push({ kind: "pin", host: hostname, from: hostname, reason: "pin the host nothing can replace", ...(labHost !== undefined ? { edge: labHost } : {}) });
    }
    return tasks;
  };

  const planHold = (at: number): { tasks: HoldTask[]; report: DnetHoldReport; labWalked: boolean; labCandidate?: string } => {
    const expiry = expiryOpts();
    const refused: DnetHoldReport["examples"] = [];
    const refuse = (host: string, why: string, detail: string): void => { refused.push({ host, why, detail }); };
    const tasks: HoldTask[] = [];
    const holdHosts = projectHoldHosts(at, expiry);
    const view: HoldView = {
      hosts: holdHosts,
      netDepth: netDepth ?? DEFAULT_NET_DEPTH,
      stasisLimit,
      spareTargets: stasisTargetDepths(netDepth ?? DEFAULT_NET_DEPTH, labExpected ? stasisLimit - 1 : stasisLimit, labExpected),
      charisma,
      authDurationMultiplier: 1,
    };
    const walk = planWalk(at, expiry, holdHosts, refuse);
    labCandidateHost = walk.candidate;
    const labCandidate = holdHosts.find((h) => h.hostname === walk.candidate);
    if (labCandidate) labCandidate.irreplaceable = true;
    for (const task of walk.tasks) {
      tasks.push(task);
      const standing = holdHosts.find((h) => h.hostname === task.from);
      if (standing) standing.irreplaceable = true;
    }
    const labWalked = walk.lab !== undefined && vault.has(walk.lab.hostname);
    const stasis = planStasis({ ...view, reserveForWalker: !labWalked && labExpected });
    for (const refusal of stasis.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
    for (const task of admitPins(at, expiry, stasis.release, refuse, undefined, false)) tasks.push({ ...task, unpin: true, reason: "release a link its host no longer earns" });
    const walkerPin = (name: string): boolean => holdHosts.find((e) => e.hostname === name)?.irreplaceable === true;
    tasks.push(...admitPins(at, expiry, stasis.pin.filter(walkerPin), refuse, walk.lab?.hostname));
    tasks.push(...admitPins(at, expiry, stasis.pin.filter((name) => !walkerPin(name)), refuse));
    const lab = walk.lab;
    const spareLinks = Math.max(0, stasisLimit - stasisLinked.size);
    const labNeed = lab !== undefined && !vault.has(lab.hostname) && walk.candidate === undefined;
    const ferryWanted = unconqueredBands(view).length > 0;
    if (!labNeed && spareLinks === 0 && !ferryWanted) {
      if (lab !== undefined) refuse(lab.hostname, "push-not-needed", "the labyrinth is reachable, every stasis link is spent, and every band holds a resident");
    } else {
      const induce = planInduce({ ...view, induceGbPerThread: budgets["induce"], needLabVantage: labNeed });
      for (const refusal of induce.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
      for (const push of induce.pushes) tasks.push({ kind: "induce", host: push.host, from: push.from, threads: push.threads, reason: push.reason });
    }
    const admitted: Record<string, number> = {};
    for (const task of tasks) admitted[task.kind] = (admitted[task.kind] ?? 0) + 1;
    return { tasks, report: { admitted, ...foldRefusals(refused) }, labWalked, ...(walk.candidate !== undefined ? { labCandidate: walk.candidate } : {}) };
  };

  // --- filing tasks as orders -----------------------------------------------
  const fileTask = (task: Task): boolean => {
    const entry = hosts.get(task.from);
    if (!entry || entry.agent === undefined) {
      // Only a host with a live agent can run an order. A plant target may not
      // have one yet; the plant runs on `from`, which does.
      if (!entry || entry.agent === undefined) {
        if (task.from !== task.host && hosts.get(task.from)?.agent === undefined) return false;
        if (hosts.get(task.from)?.agent === undefined) return false;
      }
    }
    const runner = hosts.get(task.from);
    if (!runner || runner.agent === undefined) return false;
    const budget = budgets[task.kind] ?? budgets["inventory"]!;
    const isWalk = task.kind === "walk";
    if (isWalk) killWalkHostProber(task.from);
    const room = usableGb(task.from, Date.now(), expiryOpts(), !isWalk);
    const threads = threadsFor(room, budget, THREAD_SCALED_KINDS.has(task.kind), task.threads ?? 1);
    if (threads < 1 || budget * threads > room) return false;
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
      ...(task.guessId !== undefined && guessFor.has(task.guessId) ? { guess: guessFor.get(task.guessId)! } : {}),
      ...(task.kind === "bleed" || task.kind === "attempt" ? { knownHosts: [...hosts.keys()] } : {}),
      ...(task.kind === "plant" ? {
        ...(task.remote ? { sessionOnly: true } : {}),
        ...(task.bootstrapReclaim ? { bootstrapReclaim: true } : {}),
        ...(task.bootstrapThreads !== undefined ? { bootstrapThreads: task.bootstrapThreads } : {}),
        ...(task.omitProber ? { omitProber: true } : {}),
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

  let lastDarkwebProbeAt = 0;
  const probeDarkweb = (): void => {
    if (lastDarkwebProbeAt !== 0 && (lastMutationAt ?? 0) <= lastDarkwebProbeAt) return;
    lastDarkwebProbeAt = Date.now();
    const entry = ensureEntry(selfHost);
    entry.prober = { neighbours: [...ns["dnet"]["probe"]()], at: lastDarkwebProbeAt, pid: ns.pid, epoch: rendezvous.mutationEpoch };
  };

  let lastProbeDrainAt = 0;
  let lastDetailSweepAt = 0;
  const drainProbes = (at: number): void => {
    probeDarkweb();
    const foldFrom = lastProbeDrainAt;
    lastProbeDrainAt = Date.now();
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
      if (probe === undefined || probe.at <= foldFrom) continue;
      cover(tryDescribe(entry.hostname, probe.neighbours, probe.at));
      for (const neighbour of probe.neighbours) if (hosts.get(neighbour) === undefined) cover(tryDescribe(neighbour, undefined, at));
    }
    if (lastDetailSweepAt < (lastMutationAt ?? 0) || lastDetailSweepAt === 0) {
      lastDetailSweepAt = Date.now();
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
    if (observed.length > 0) absorb({ id: "bootstrap-done", kind: "inventory", host: selfHost, from: selfHost, ok: true, hosts: observed, dirtied: true });
  };

  const reviveProbers = (): void => {
    if (prevMutationAt === 0) return;
    for (const entry of hosts.values()) {
      const host = entry.hostname;
      if (host === selfHost || host === labCandidateHost || entry.agent?.order.kind === "walk") continue;
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

  queueAuthenticatedPlant = (hostname: string, from: string): void => {
    const at = Date.now();
    const report = tryDescribe(hostname, undefined, at);
    foldReports(knowledge, [report], at, expiryOpts());
    pendingHosts.push(report);
    if (!report.present) return;
    const candidate = candidatesFrom(knowledge, at, {
      standing: new Set([selfHost, ...liveEntries().map((e) => e.hostname), ...bootstrapHosts()]),
      vault: new Set(vault.keys()),
      lastPlantAt: lastPlantMap(),
      expiry: expiryOpts(),
    }).find((c) => c.host === hostname);
    if (!candidate) return;
    const planned = planSpread([{ ...candidate, from }], spreadLimits(), at).plant[0];
    if (!planned) { signalDerive(); return; }
    fileTask({
      id: `plant:${planned.host}`,
      kind: "plant",
      host: planned.host,
      from,
      priority: PLANT_PRIORITY,
      reason: "authentication completed; migrate immediately",
      ...(planned.bootstrapReclaim ? { bootstrapReclaim: true } : {}),
      ...(planned.bootstrapThreads !== undefined ? { bootstrapThreads: planned.bootstrapThreads } : {}),
      ...(planned.omitProber ? { omitProber: true } : {}),
    });
  };
  queueNeighbourGuess = (hostname: string, password: string, from: string, at: number): void => {
    if (hosts.get(from)?.agent === undefined || vault.has(hostname) || hosts.get(hostname)?.goneAt !== undefined) return;
    const id = looseId(password);
    guessFor.set(id, password);
    const depth = fresh<number>(hosts.get(hostname), "depth", at, expiryOpts());
    fileTask({ id: `guess:${hostname}:${id}`, kind: "attempt", host: hostname, from, priority: DNET_PRIORITY["attempt"] + (depth === undefined ? 1 : -depth) - 5, reason: `same-epoch first-auth file from ${from}`, guessId: id });
  };

  const bootstrapHosts = (): string[] => [...hosts.values()].filter((e) => e.bootstrap !== undefined).map((e) => e.hostname);
  const lastPlantMap = (): Map<string, number> => {
    const map = new Map<string, number>();
    for (const entry of hosts.values()) if (entry.lastPlantAt !== undefined) map.set(entry.hostname, entry.lastPlantAt);
    return map;
  };
  const spreadLimits = () => ({ ...DEFAULT_SPREAD_LIMITS, agentRamGb: residentGb + proberGb, residentRamGb: residentGb, bootstrapRamGb: bootstrapGb });

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
    const remoteExec = new Set(stasisLinked);
    const backdoorLife = msPerHostEventAny(["restarted", "deleted"], netDepth ?? DEFAULT_NET_DEPTH, bitNode ?? 15, backdoors.size);
    for (const [hostname, installedAt] of backdoors) {
      const host = hosts.get(hostname);
      if (host !== undefined && host.goneAt === undefined && at - installedAt <= backdoorLife) remoteExec.add(hostname);
    }
    const spreadCandidates = candidatesFrom(knowledge, at, {
      standing: new Set([selfHost, ...liveEntries().map((e) => e.hostname), ...bootstrapHosts()]),
      vault: new Set(vault.keys()),
      lastPlantAt: lastPlantMap(),
      remoteExec,
      remoteVantages: liveEntries().map((e) => ({ host: e.hostname, freeGb: usableGb(e.hostname, at, expiryOpts()) })),
      expiry: expiryOpts(),
    });

    const stormExpiry = expiryOpts();
    const stormHosts = [...hosts.values()].map((entry) => {
      const view = planningView(entry, at, stormExpiry);
      return {
        ...entry,
        ...view,
        agentAlive: entry.agent !== undefined,
        busy: new Set([...(entry.agent !== undefined && entry.agent.order.kind !== "idle" ? [entry.agent.order.kind] : []), ...(entry.staged ?? []).map((o) => o.kind)]) as ReadonlySet<string>,
      } as DnetHost;
    });

    const seedHolder = stormHosts.find((h) => h.goneAt === undefined && h.stormSeed === true);
    const labWalkedNow = [...hosts.values()].some((entry) => isLabyrinth(entry.hostname, fresh<string>(entry, "modelId", at, stormExpiry)) && vault.has(entry.hostname));
    const seedHunt = seedHolder === undefined && (labWalkedNow || stasisLinked.size >= stasisLimit) && (lastStormFiredAt === undefined || at - lastStormFiredAt > STORM_COOLDOWN_MS);
    const farmPlan = planFarm(projectFarmHosts(at, expiryOpts()), {
      now: at, charisma, gbPerThread: farmGbPerThread, wantedGb: heaviestJobGb,
      ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
      ...(promoteSymbols.length > 0 ? { promoteSymbols } : {}),
      crimeSuccessMult, openLabCache,
      ...(seedHunt ? { seedHunt: true } : {}),
    });
    const farmAdmitted: Record<string, number> = {};
    for (const task of farmPlan.tasks) farmAdmitted[task.kind] = (farmAdmitted[task.kind] ?? 0) + 1;
    farm = { admitted: farmAdmitted, ...foldRefusals(farmPlan.refused), ...(farmPlan.cacheHunter !== undefined ? { cacheHunter: farmPlan.cacheHunter } : {}) };

    const holdPlan = planHold(at);
    hold = holdPlan.report;

    for (const candidate of spreadCandidates) {
      if (candidate.host === holdPlan.labCandidate && stasisLinked.has(candidate.host)) { candidate.omitProber = true; candidate.reclaimOnly = true; }
    }
    const plan = planSpread(spreadCandidates, spreadLimits(), at);
    spread = { planted: plan.plant.length, ...foldRefusals(plan.refused) };

    const pinsPending = holdPlan.tasks.some((t) => t.kind === "pin" && t.unpin !== true) || [...projectInFlight().values()].some((held) => held.some((job) => job.kind === "pin"));
    let walkFrom: string | undefined;
    for (const entry of hosts.values()) {
      if (entry.agent?.order.kind === "walk") walkFrom = entry.hostname;
      for (const o of entry.staged ?? []) if (o.kind === "walk") walkFrom = entry.hostname;
    }
    for (const task of holdPlan.tasks) if (task.kind === "walk") walkFrom = task.from;
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
      farm: farmPlan.tasks,
      hold: [...holdPlan.tasks, ...(stormPlan.fire !== undefined ? [{ kind: "storm" as const, host: stormPlan.fire.host, from: stormPlan.fire.from, reason: stormPlan.fire.reason }] : [])],
      ...(guesses.length > 0 ? { guesses } : {}),
    });
    routeUrgentTasks(tasks, at);
    for (const task of tasks) fileTask(task);
    return tasks;
  };

  const routeUrgentTasks = (tasks: Task[], at: number): void => {
    const expiry = expiryOpts();
    const cancelled = new Set<string>();
    const assigned = new Map<string, number>();
    for (const task of tasks) {
      if (task.kind !== "walk" && task.kind !== "plant" && task.kind !== "cache" && task.kind !== "pin" && task.kind !== "attempt" && task.kind !== "bleed") continue;
      const targetNeighbours = fresh<string[]>(hosts.get(task.host), "neighbours", at, expiry) ?? [];
      const candidates: PreemptionCandidate[] = [];
      const possible = task.kind === "plant" ? new Set<string>([task.from, ...liveEntries().map((e) => e.hostname)]) : new Set<string>(task.eligibleFrom ?? [task.from]);
      for (const host of possible) {
        if (task.kind === "plant" && host === task.host) continue;
        const entry = hosts.get(host);
        if (entry === undefined || entry.agent === undefined) continue;
        if ((entry.staged?.length ?? 0) + (assigned.get(host) ?? 0) >= MAX_STAGED_PER_HOST) continue;
        const adjacent = task.kind !== "plant" || host === task.from || (fresh<string[]>(hosts.get(host), "neighbours", at, expiry) ?? []).includes(task.host) || targetNeighbours.includes(host);
        if (!adjacent) continue;
        const active = entry.agent?.order.kind !== "idle" ? entry.agent : undefined;
        candidates.push({
          host,
          usableGb: usableGb(host, at, expiry),
          ...(assigned.has(host) ? { assigned: assigned.get(host)! } : {}),
          ...(cancelled.has(host) ? { cancelling: true } : {}),
          ...(active !== undefined ? {
            activeKind: active.order.kind,
            activePriority: active.order.priority,
            ...(active.order.startedAt !== undefined ? { activeStartedAt: active.order.startedAt } : {}),
            ...(active.order.expectedDoneAt !== undefined ? { activeExpectedDoneAt: active.order.expectedDoneAt } : {}),
          } : {}),
        });
      }
      const choice = choosePreemptionVantage(task.kind, candidates, at);
      if (choice === undefined) continue;
      if (choice.vantage !== task.from) { task.from = choice.vantage; if (task.kind === "plant") delete task.remote; }
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
    for (const entry of hosts.values()) {
      const keep: Order[] = [];
      for (const order of entry.staged ?? []) {
        const host = hosts.get(order.host);
        let reason: string | undefined;
        if (!host || host.goneAt !== undefined) reason = "target is gone";
        else if (order.targetIdentity !== undefined && host.identity !== undefined && order.targetIdentity !== host.identity) reason = "target identity changed";
        else if (order.kind === "attempt" && vault.has(order.host)) reason = "credential already verified";
        else if (order.kind === "plant" && hosts.get(order.host)?.agent !== undefined) reason = "resident already present";
        else if (order.kind === "cache" && order.filename !== undefined && !(fresh<string[]>(host, "caches", at, expiry) ?? []).includes(order.filename)) reason = "cache listing changed";
        if (reason === undefined) keep.push(order);
        else retireStaged(order, "cancelled", reason);
      }
      entry.staged = keep;
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
    adopt(host, handle) {
      const entry = ensureEntry(host);
      entry.agent = handle;
      if (handle.order.kind !== "idle") orderById.set(handle.order.id, handle.order);
      handle.done.then(onReport).catch(() => {});
      signalDerive();
    },
    reportProbe(host, neighbours, at, pid) {
      const entry = ensureEntry(host);
      entry.prober = { neighbours: [...neighbours], at, pid, epoch: rendezvous.mutationEpoch };
      signalDerive();
    },
    preparePlant(host) {
      const entry = ensureEntry(host);
      needsInventory.add(host);
      // The plant execs the resident right after this; file its inventory so the
      // new agent's first look finds real work. But it has no agent yet, so
      // fileListJobs will file it once the resident registers.
      void entry;
    },
    registerBootstrap(host, pid) { ensureEntry(host).bootstrap = { pid, startedAt: Date.now() }; },
    bootstrapDone(host) { const e = hosts.get(host); if (e) e.bootstrap = undefined; bootstrapDoneSet.add(host); signalDerive(); },
    deps,
    drain(): DnetDrain {
      const lab = labReport(Date.now());
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
        residents: liveEntries().map((entry) => ({
          host: entry.hostname,
          lastBeatAt: entry.agent?.beatAt ?? Date.now(),
          pending: (entry.staged ?? []).length,
          ...(entry.agent !== undefined && entry.agent.order.kind !== "idle" ? { active: entry.agent.order.kind } : {}),
          freeGb: usableGb(entry.hostname, Date.now(), expiryOpts()),
          completed: entry.completed ?? 0,
          failed: entry.failed ?? 0,
          ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
        })),
        residentsLost,
        mutations: pendingMutations,
        ...(lab !== undefined ? { lab } : {}),
      };
      for (const key of Object.keys(codes)) delete codes[key];
      karmaLoss = 0;
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
      }
      if (orders.openLabCache !== undefined) openLabCache = orders.openLabCache;
      if (orders.promoteSymbols !== undefined) promoteSymbols = [...orders.promoteSymbols];
      if (orders.crimeSuccessMult !== undefined) crimeSuccessMult = orders.crimeSuccessMult;
      if (orders.backdoors !== undefined) { backdoors.clear(); for (const e of orders.backdoors) backdoors.set(e.hostname, e.installedAt); }
      if (orders.stasisLimit !== undefined) stasisLimit = orders.stasisLimit;
      if (orders.labExpected !== undefined) labExpected = orders.labExpected;
      if (orders.stasisSnapshot !== undefined && orders.stasisSnapshot.at > stasisObservedAt) {
        stasisObservedAt = orders.stasisSnapshot.at;
        stasisLinked.clear();
        for (const hostname of orders.stasisSnapshot.hosts) stasisLinked.add(hostname);
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

    if (mutationSweepDue) {
      mutationSweepDue = false;
      for (const entry of [...hosts.values()]) {
        const pid = entry.agent?.pid ?? entry.prober?.pid;
        if (pid === undefined || pid <= 0) continue;
        if (entry.agent === undefined && entry.prober === undefined) continue;
        let alive = false;
        try { alive = ns["isRunning"](pid, entry.hostname); } catch { alive = false; }
        if (alive) continue;
        residentsLost++;
        retireVantage(entry.hostname, `${entry.hostname} process died during a mutation`);
        invalidateBackdoor(entry.hostname);
      }
    }

    // Sweep entries whose resident stopped beating.
    for (const entry of [...hosts.values()]) {
      if (entry.agent === undefined) continue;
      if (at - agentLastLife(entry) <= BEAT_WINDOW_MS) continue;
      residentsLost++;
      retireVantage(entry.hostname, `${entry.hostname} lost its resident`);
    }
    reconcilePending(at);
    // Time out an active order whose process was killed.
    for (const entry of hosts.values()) {
      const active = entry.agent;
      if (active === undefined || active.order.kind === "idle" || active.startedAt === undefined) continue;
      const expired = active.order.longLived ? at - active.beatAt > LONG_JOB_BEAT_MS : at - active.startedAt > JOB_TIMEOUT_MS;
      if (expired) {
        entry.failed = (entry.failed ?? 0) + 1;
        active.settle({ id: active.order.id, kind: active.order.kind, host: active.order.host, from: active.order.from, ok: false, died: true, detail: active.order.longLived ? `${active.order.label} stopped beating on ${entry.hostname}` : `${active.order.label} timed out on ${entry.hostname}` });
        entry.agent = undefined;
      }
    }
    residentsSeenEver = Math.max(residentsSeenEver, liveEntries().length);

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

    await waitForDerive();
  }

  if (realm.dnet_controller === rendezvous) delete realm.dnet_controller;
  for (const entry of hosts.values()) {
    const probe = entry.prober;
    if (probe !== undefined && probe.pid > 0 && probe.pid !== ns.pid) ns["kill"](probe.pid);
  }
  TELEMETRY: if (__TELEMETRY__ && tel) tel.flush();
}

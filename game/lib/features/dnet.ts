import type { NS } from "@ns";
import { stepDarknet } from "../../../shared/strategy/dnet/decide.ts";
import { CONTRACT_QUEUE_LIMIT } from "../../../shared/strategy/side/contracts.ts";
import {
  holdHostFrom,
  planBackdoors,
  type HoldHost,
} from "../../../shared/strategy/dnet/hold.ts";
import type { AttemptOutcome, LogDrainOutcome, ReportHost, VaultEntry } from "../../../shared/strategy/dnet/courier.ts";
import { publishKnowledge } from "../../../shared/strategy/dnet/publish.ts";
import {
  DEFAULT_NET_DEPTH,
  isLabyrinth,
  msPerHostEventAny,
  mutationIntervalMs,
  netDepthFromLabs,
} from "../../../shared/strategy/dnet/rates.ts";
import {
  coverage,
  emptyKnowledge,
  expiryMs,
  foldLogDrain,
  foldAttempts,
  foldReports,
  forgetMs,
  fresh,
  isImmune,
  markCredentialKnown,
  stormWipe,
  type DarknetKnowledge,
  type ExpiryOpts,
} from "../../../shared/strategy/dnet/knowledge.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { labCacheDeferral } from "../../../shared/strategy/progression/decide.ts";
import type { DarknetAgentDigest } from "../../../shared/telemetry/topics/dnet.ts";
import {
  CONTROLLER_CALLS,
  KIND_CALLS,
  BEAT_WINDOW_MS,
  JOB_TIMEOUT_MS,
  LONG_JOB_BEAT_MS,
  priceCalls,
  type ControllerHandle,
  type HostEntry,
} from "../../dnet/shared.ts";
import {
  foldRefusals,
  type DnetSpreadReport,
  type DnetFarmReport,
  type DnetCredentialRejection,
  type DnetLabReport,
  type DnetHoldReport,
  type DnetStormReport,
} from "../../dnet/wire.ts";
import { gameBuildId } from "../build-id.ts";
import { handoffLaunch, temporaryRunOptions } from "../launch-shared.ts";
import type { DnetAgentLaunch, DnetControllerLaunch } from "../../dnet/launch.ts";
import { gameGlobal } from "../globals.ts";
import { isScriptDeath } from "../errors.ts";
import { merge, set, type GameState } from "../state.ts";
import {
  darknetContractsFromListings,
  mergeContractQueue,
  pendingDarknetContracts,
  type DarknetContractListing,
} from "../contracts.ts";
import { actionRamClaim, featureDodgeOn } from "./dodge.ts";
import type { DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** The HOME DRIVER: the third process of the darknet's three, and the only one
 * that runs on `home`.
 *
 * The spec's vocabulary (spec/dnet.md): the home driver seeds and re-seeds the
 * OVERSEER onto `darkweb`, drains what the overseer has learned into the durable
 * fold it owns, installs backdoors from the terminal (the one darknet action
 * only home can perform), and tells the overseer what only home can see. The
 * overseer itself lives in `game/dnet/overseer.ts`; the RESIDENTS it schedules
 * live in `game/dnet/agent.ts`.
 *
 * Everything durable about the feature is here, in `DnetHomeState`: the map
 * survives an overseer death because home folds each drained observation into
 * knowledge it owns, and the vault survives for the same reason. */

/** How long a silent overseer is given before home re-seeds. Four missed beats
 * at the overseer's 15 s cadence: `darkweb` does reboot — there is a literature
 * file about it — and when it does, the coordinator dies with it. */
const OVERSEER_STALE_MS = 60_000;
/** First retry after a failed seed, doubling to the cap. A world where the seed
 * can never work must not re-exec every tick for ever. */
const DNET_SEED_BACKOFF_MS = 30_000;
const DNET_SEED_MAX_BACKOFF_MS = 5 * 60_000;

/** Fold the newest resource listings into the private side-work queue.
 *
 * The queue entry names the fact's identity and observation; the authoritative
 * private listing owns its mutation-derived validity boundary. */
export function syncDarknetContracts(
  state: GameState,
  knowledge: DarknetKnowledge,
  now: number,
  expiry: ExpiryOpts,
): void {
  const listings = state.darknetContractListings ??= {};
  const handled = state.darknetContractHandledAt ??= {};
  const deleteHostKeys = <T>(record: Record<string, T> | undefined, hostname: string): void => {
    const prefix = `${hostname}\0`;
    for (const key of Object.keys(record ?? {})) {
      if (key.startsWith(prefix)) delete record![key];
    }
  };

  const forgetHost = (hostname: string): void => {
    delete listings[hostname];
    deleteHostKeys(handled, hostname);
    deleteHostKeys(state.contractQuarantine, hostname);
  };

  for (const hostname of Object.keys(listings)) {
    if (!knowledge.hosts[hostname] || knowledge.hosts[hostname].goneAt !== undefined) forgetHost(hostname);
  }

  for (const host of Object.values(knowledge.hosts).sort((a, b) => a.hostname.localeCompare(b.hostname))) {
    if (host.goneAt !== undefined) {
      forgetHost(host.hostname);
      continue;
    }
    const fact = host.facts["contracts"] as { value: string[]; at: number } | undefined;
    if (!fact) continue;
    if (listings[host.hostname]?.identity !== host.identity) forgetHost(host.hostname);
    const files = [...fact.value].sort();
    const validUntil = fact.at + expiryMs("resource", { ...expiry, immune: isImmune(host, expiry) });
    if (host.identity === undefined) continue;
    const listing: DarknetContractListing = {
      identity: host.identity,
      observedAt: fact.at,
      validUntil,
      files,
    };
    listings[host.hostname] = listing;
    if (files.length === 0) {
      deleteHostKeys(handled, host.hostname);
      deleteHostKeys(state.contractQuarantine, host.hostname);
    }
  }

  const observed = darknetContractsFromListings(listings, now);
  const darknet = pendingDarknetContracts(observed, handled, state.contractQuarantine);
  const ordinary = (state.contractQueue ?? []).filter((contract) => contract.dnet === undefined);
  state.contractQueue = mergeContractQueue(darknet, ordinary, CONTRACT_QUEUE_LIMIT);
}

/** What the seed stub calls. The seed is the one darknet action home performs
 * itself, and it is a real 1.9 GB of dynamic RAM inside the stub — pricing it is
 * what makes the claim honest, because an unpriced action would place a stub the
 * broker never reserved for. */
const DNET_SEED_METHODS: readonly string[] = ["scp", "exec"];

/** ns members the darknet backdoor dodge calls. NO `scan`: `ns.scan` omits
 * darknet servers outright, so the BFS the hacking backdoor uses cannot find a
 * route out here at all — the route comes from the overseer's folded
 * adjacency instead, which is the only place it exists. */
const DNET_BACKDOOR_CALLS = ["singularity.connect", "singularity.installBackdoor"] as const;
/** How long a failed darknet backdoor waits before it is tried again. Longer
 * than the hacking one's 30 s floor because the failure mode out here is a net
 * that moved, and it will have moved again in thirty seconds. */
const DNET_BACKDOOR_BACKOFF_MS = 120_000;

/** Everything the home driver remembers between ticks, in one owned structure.
 *
 * Module-scope rather than on the store because it is the driver's working
 * memory: the store carries the published digest, this carries the full fact
 * set with each fact's observation time. `dnetModule.reset` replaces the whole
 * thing with `freshDnetHomeState()`, so a new field can never be missed by a
 * reset — its boot value IS its reset value. */
interface DnetHomeState {
  /** What agents have told us, as opposed to what home can see for itself. */
  knowledge: DarknetKnowledge | undefined;
  /** Cumulative response codes reported by agents. Kept next to the knowledge so
   * one reset clears both. */
  codes: Record<string, number>;
  /** The overseer's last spread verdict: how many plants it admitted and why it
   * refused the rest. A SNAPSHOT, replaced whole on each drain rather than
   * accumulated, because a standing refusal is one problem however many ticks
   * noticed it. Undefined until the first derivation lands. */
  spread: DnetSpreadReport | undefined;
  /** The overseer's last farm verdict, on the same snapshot discipline. */
  farm: DnetFarmReport | undefined;
  /** The last hold derivation: the pin, the push and the walk. */
  hold: DnetHoldReport | undefined;
  /** The last storm derivation: the seed, the gates, the fire. */
  storm: DnetStormReport | undefined;
  /** Karma spent opening caches this generation. Negative, and it SURVIVES an
   * install — which is the whole reason it is worth publishing rather than
   * logging: `gang` wants -54000 and a cache is free progress toward it. */
  karmaLoss: number;
  /** Log-grammar drift, as the overseer last tallied it. Shapes, never lines —
   *  see `DarknetState.grammar`. */
  grammar: { unrecognised: number; shapes: Record<string, number> } | undefined;
  /** When a `.d.cache` was last seen to land, held here so it survives an
   * overseer death and is replayed to the replacement. The phishing cache
   * cooldown is NET-WIDE engine state exposed through no ns member at all. */
  lastPhishCacheAt: number | undefined;
  /** When the last storm was fired, on our own clocks — the overseer's
   * pessimistic claim-time stamp or its drained authoritative one, whichever is
   * newest. Held here so it survives an overseer death and is replayed to the
   * replacement: the engine's `lastStormTime` is module state no ns member
   * exposes, and it gates both the quiet period and when a new seed can be
   * minted (`STORM_COOLDOWN_MS`). */
  lastStormAt: number | undefined;
  /** When the lab-cache install deferral was first raised, so it can EXPIRE.
   *
   * The asymmetry is the point and it is stated here because this is the field
   * that enforces it: missing the deferral costs one augmentation's price
   * scaling, once. Blocking an install costs the whole cycle. */
  labCacheSince: number | undefined;
  /** The maze as the overseer last drew it — the discovered map and whoever is
   * walking it.
   *
   * Held on home rather than only published because it is the walk's ONLY
   * durable state: a walker dies with its PID and its map does not, so this is
   * what lets the panel show a walk that is half done instead of only one that
   * finished. Undefined for every run that never reaches a lab, which is most
   * of them. */
  lab: DnetLabReport | undefined;
  /** Credentials agents recovered, keyed by host.
   *
   * MODULE STATE AND NOTHING ELSE. It is never merged into a topic or sent to
   * telemetry; its only replay is the in-realm order to the overseer. What the
   * panel gets is the boolean `credentialKnown` per host.
   *
   * Held here rather than only out in the darknet because an overseer dies with
   * its host, and re-cracking a net we already opened would be the most
   * expensive possible way to recover from a reboot. */
  vault: Map<string, VaultEntry>;
  /** Darknet hosts HOME has backdoored, keyed to when each was installed.
   *
   *  Home's own record rather than an observed fact: `singularity.installBackdoor`
   *  acts on the terminal's current server, so home is the only thing that can
   *  install one — and `ns.getServer().backdoorInstalled` is 2 GB home does not
   *  spend on a host it already knows about. A restart clears the backdoor
   *  (~9%/tick on a backdoored host), so the set is trimmed whenever the host is
   *  seen to have gone and re-earned otherwise. */
  backdoored: Map<string, number>;
  /** Last exact JSON written to dnet-vault.txt. Used only to avoid rewriting an
   * unchanged zero-RAM state file on every five-second feature tick. */
  persistedState: string | undefined;
  /** The backoff that keeps a structurally impossible backdoor from relaunching
   *  a stub every pass. */
  backdoorNextAt: number;
  backdoorInFlight: boolean;
  /** What the two-slot recycler last decided. Its harvest and quality refusals
   *  are the useful explanation for why a sacrificial target was not chosen. */
  backdoorReport:
    | { install: string[]; refused: Record<string, number>; examples: { host: string; why: string; detail: string }[] }
    | undefined;
  /** Newest complete stasis set, whether read directly or changed by a job. */
  stasisLinked: Set<string>;
  /** Observation/change time of that complete set. */
  stasisObservedAt: number;
  /** The highest charisma a JOB said it needed. Today only the maze walker
   *  reports one, and it is folded into the career need `stepDarknet` already
   *  posts rather than into a second channel. */
  charismaNeeded: number | undefined;
  /** Model ids the game produced that `shared/strategy/dnet/models.ts` does not
   * know. Counted rather than ignored: a non-empty tally is a game update or a
   * hole in our transcription, and both are things to hear about. */
  unknownModels: Record<string, number>;
  /** Agent hosts seen this generation, as a SET rather than a counter: the
   * live `agents` map below is pruned when a host goes stale or gone, so a
   * counter bumped on "not currently in the map" would re-count every host
   * that dies and is later replanted. The set's size is what publishes as
   * `agentsSeenEver`; the gap to the live count is agent mortality — see
   * spec/dnet.md's Observability note. */
  agentHostsSeen: Set<string>;
  /** Residents the overseer last reported, keyed by HOST.
   *
   * A host keeps exactly one resident — that is the spawn-chain design — and the
   * overseer is tracked separately (`overseerBeatAt`), so nothing shares a
   * key. Keying by host is also what the map needs: the badge sits on a box. */
  agents: Map<string, DarknetAgentDigest & { host: string }>;
  /** Residents the overseer has lost since boot. Agent mortality, which out
   * there is the loss that actually matters: the channel does not drop data,
   * hosts drop agents. */
  residentsLost: number;
  /** When the overseer last said it was alive. Home cannot see into the darknet,
   * so this beat is the ONLY evidence the beachhead is still standing. */
  overseerBeatAt: number;
  seedAttempts: number;
  seedNextAt: number;
  seedBackoffMs: number;
  /** The last recorded action outcome, for the panel's `plan.lastResult`. */
  lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
}

function freshDnetHomeState(): DnetHomeState {
  return {
    knowledge: undefined,
    codes: {},
    spread: undefined,
    farm: undefined,
    hold: undefined,
    storm: undefined,
    karmaLoss: 0,
    grammar: undefined,
    lastPhishCacheAt: undefined,
    lastStormAt: undefined,
    labCacheSince: undefined,
    lab: undefined,
    vault: new Map(),
    backdoored: new Map(),
    persistedState: undefined,
    backdoorNextAt: 0,
    backdoorInFlight: false,
    backdoorReport: undefined,
    stasisLinked: new Set(),
    stasisObservedAt: 0,
    charismaNeeded: undefined,
    unknownModels: {},
    agentHostsSeen: new Set(),
    agents: new Map(),
    residentsLost: 0,
    overseerBeatAt: 0,
    seedAttempts: 0,
    seedNextAt: 0,
    seedBackoffMs: DNET_SEED_BACKOFF_MS,
    lastResult: undefined,
  };
}

let home = freshDnetHomeState();

function record(action: string, ok: boolean, detail: string): void {
  home.lastResult = { action, ok, detail, at: Date.now() };
}

/** Whether a delayed rejection still refers to the credential home holds.
 * A newer verification or a different server lifetime always wins. */
export function credentialRejectionApplies(
  held: VaultEntry,
  rejection: DnetCredentialRejection,
): boolean {
  return held.at <= rejection.at
    && (held.identity === undefined || rejection.identity === undefined || held.identity === rejection.identity);
}

/** Where home persists private darknet progress across a save RELOAD.
 *
 * The vault and ordinary-backdoor set are page-realm memory: a reload restarts
 * every script from nothing while the game keeps both underlying facts. Losing
 * them would force a full re-crack and would make the planner install extras.
 * whose password provably has not changed (stasis-linked ones above all). Home's
 * OWN files survive a reload, and `ns.read`/`ns.write` are 0 GB, so home simply
 * remembers what it legitimately cracked and reads it back on boot — no scp, no
 * darkweb, no dodge. This is save-state recovery of our own work, NOT reading a
 * password out of game memory (which would skip the cracking challenge and is
 * deliberately not done anywhere).
 *
 * The file carries the GENERATION. A prestige mints a whole new net with new
 * passwords, so its stored generation no longer matches and the file is ignored
 * — the vault is rebuilt from scratch, as it must be. A reload keeps the
 * generation, so the passwords are still valid; each is re-verified by
 * `authenticate` on use anyway, and an identity mismatch drops it. */
const DNET_VAULT_FILE = "dnet-vault.txt";

export interface PersistedBackdoorEntry {
  hostname: string;
  installedAt: number;
}

export function serializePersistedDnetState(
  generation: string,
  entries: readonly VaultEntry[],
  backdoors: readonly PersistedBackdoorEntry[] = [],
): string {
  return JSON.stringify({ generation, vault: entries, backdoors });
}

/** Parse the one generation-bound private state file. Invalid sections become
 * empty; a corrupt file or generation mismatch restores nothing. */
export function parsePersistedDnetState(
  raw: string,
  generation: string,
): { vault: VaultEntry[]; backdoors: PersistedBackdoorEntry[] } {
  try {
    if (raw.length === 0) return { vault: [], backdoors: [] };
    const parsed = JSON.parse(raw) as {
      generation?: string;
      vault?: VaultEntry[];
      backdoors?: PersistedBackdoorEntry[];
    };
    if (parsed.generation !== generation) return { vault: [], backdoors: [] };
    const vault = Array.isArray(parsed.vault)
      ? parsed.vault.filter((entry): entry is VaultEntry =>
        !!entry && typeof entry.hostname === "string" && entry.hostname.length > 0
        && typeof entry.password === "string" && typeof entry.at === "number" && Number.isFinite(entry.at))
      : [];
    const validBackdoors = Array.isArray(parsed.backdoors)
      ? parsed.backdoors.filter((entry): entry is PersistedBackdoorEntry =>
        !!entry && typeof entry.hostname === "string" && entry.hostname.length > 0
        && typeof entry.installedAt === "number" && Number.isFinite(entry.installedAt))
      : [];
    const backdoors = [...new Map(validBackdoors.map((entry) => [entry.hostname, entry])).values()];
    return { vault, backdoors };
  } catch {
    return { vault: [], backdoors: [] };
  }
}

/** Persisted backdoors disproved by authoritative fold evidence.
 *
 * Absence from knowledge is not evidence after reload: the crawler may simply
 * not have rediscovered the host yet. A gone observation, an identity
 * replacement, or the fold finally forgetting a previously-gone host is
 * conclusive and releases the slot. */
export function invalidatedPersistedBackdoors(
  entries: ReadonlyMap<string, number>,
  knowledge: DarknetKnowledge,
  replacedOrForgotten: readonly string[],
): string[] {
  const invalidated = new Set(replacedOrForgotten);
  for (const hostname of entries.keys()) {
    if (knowledge.hosts[hostname]?.goneAt !== undefined) invalidated.add(hostname);
  }
  return [...invalidated].filter((hostname) => entries.has(hostname)).sort();
}

function persistDnetState(ns: NS, generation: string): void {
  const serialized = serializePersistedDnetState(
    generation,
    [...home.vault.values()],
    [...home.backdoored].map(([hostname, installedAt]) => ({ hostname, installedAt })),
  );
  if (serialized === home.persistedState) return;
  try {
    ns.write(DNET_VAULT_FILE, serialized, "w");
    home.persistedState = serialized;
  } catch {
    /* a bad write costs one reload's worth of re-cracking, never the run */
  }
}

/** Repopulate the vault from home's persisted file when — and only when — it
 * belongs to THIS generation. Also seeds each host into knowledge so the fresh
 * fold does not immediately sweep the credential as belonging to a host it has
 * never heard of, and so the host shows as a known, credentialled re-plant
 * target the moment a neighbour re-surveys it. Returns how many were loaded. */
function loadPersistedDnetState(
  ns: NS,
  generation: string,
): { credentials: number; backdoors: number } {
  let raw: string;
  try {
    raw = ns.read(DNET_VAULT_FILE);
  } catch {
    return { credentials: 0, backdoors: 0 };
  }
  if (typeof raw !== "string") return { credentials: 0, backdoors: 0 };
  home.persistedState = raw;
  const persisted = parsePersistedDnetState(raw, generation);
  let loaded = 0;
  for (const entry of persisted.vault) {
    home.vault.set(entry.hostname, entry);
    if (home.knowledge && !home.knowledge.hosts[entry.hostname]) {
      home.knowledge.hosts[entry.hostname] = {
        hostname: entry.hostname,
        ...(entry.identity !== undefined ? { identity: entry.identity } : {}),
        lastSeenAt: entry.at ?? Date.now(),
        facts: {},
        credentialKnown: true,
      };
    }
    loaded++;
  }
  for (const entry of persisted.backdoors) home.backdoored.set(entry.hostname, entry.installedAt);
  return { credentials: loaded, backdoors: persisted.backdoors.length };
}

/** Take what the darknet has learned, and hand it what only home can see.
 *
 * Every script the game runs shares one JS realm, so the overseer's own object
 * IS reachable from here. That is not a shortcut past a game rule: what
 * preserves BN15's challenge is enforced by the engine — sessions are per-PID,
 * `probe()` is host-local, and the network kills your scripts.
 *
 * Four rules keep the handover honest:
 *
 * - `drain()` hands each observation over ONCE, so home cannot double-count.
 * - Home folds into knowledge IT owns, so an overseer dying loses scheduling
 *   rather than the map.
 * - The generation is checked here, because agents outlive overseers and a
 *   live script from a dead run describes a world this one no longer shares.
 * - Credentials land in the vault, which is module state that is never merged
 *   into a topic and never sent. */
function drainDarknet(generation: string): {
  hosts: ReportHost[];
  attempts: { hostname: string; outcome: AttemptOutcome }[];
  logDrains: { hostname: string; outcome: LogDrainOutcome }[];
  residents: string[];
  drained: number;
  rejected: number;
  credentials: number;
  mutations: number;
} {
  const rendezvous = dnetRendezvous();
  if (!rendezvous) return { hosts: [], attempts: [], logDrains: [], residents: [], drained: 0, rejected: 0, credentials: 0, mutations: 0 };
  if (rendezvous.generation !== generation) {
    // An overseer from a world this run no longer shares. Its facts describe a
    // darknet that was destroyed by the prestige that ended it.
    return { hosts: [], attempts: [], logDrains: [], residents: [], drained: 0, rejected: 1, credentials: 0, mutations: 0 };
  }
  const taken = rendezvous.drain();
  for (const entry of taken.credentials) {
    if (entry.hostname.length > 0) home.vault.set(entry.hostname, entry);
  }
  for (const [code, count] of Object.entries(taken.codes)) {
    home.codes[code] = (home.codes[code] ?? 0) + Number(count);
  }
  if (taken.spread) home.spread = taken.spread;
  if (taken.farm) home.farm = taken.farm;
  if (taken.hold) home.hold = taken.hold;
  if (taken.stasisSnapshot !== undefined && taken.stasisSnapshot.at > home.stasisObservedAt) {
    home.stasisObservedAt = taken.stasisSnapshot.at;
    home.stasisLinked = new Set(taken.stasisSnapshot.hosts);
  }
  for (const rejection of taken.credentialRejections) {
    const held = home.vault.get(rejection.hostname);
    if (held === undefined || !credentialRejectionApplies(held, rejection)) continue;
    home.vault.delete(rejection.hostname);
    const host = home.knowledge?.hosts[rejection.hostname];
    if (host !== undefined) delete host.credentialKnown;
  }
  for (const invalidation of taken.backdoorInvalidations) {
    const installedAt = home.backdoored.get(invalidation.hostname);
    if (installedAt !== undefined && installedAt <= invalidation.at) {
      home.backdoored.delete(invalidation.hostname);
    }
  }
  if (taken.charismaNeeded !== undefined) {
    home.charismaNeeded = Math.max(home.charismaNeeded ?? 0, taken.charismaNeeded);
  }
  // ACCUMULATED, not assigned: `drain()` hands over the karma spent since the
  // last drain and clears it, exactly as it does with `codes`. An overseer
  // dies with its host out here, and assigning a re-seeded overseer's
  // since-boot total would reset home's tally to zero for the rest of the run.
  if (taken.karmaLoss !== undefined) home.karmaLoss += taken.karmaLoss;
  if (taken.grammar) home.grammar = taken.grammar;
  // ASSIGNED, and only when the overseer had something to say. The maze is a
  // standing picture rather than a since-last-drain delta, so the newest one
  // wins outright — but an overseer that has not reached a lab sends nothing,
  // and blanking home's copy on those drains would make the panel flicker
  // between a map and an empty card every tick.
  if (taken.lab) home.lab = taken.lab;
  if (taken.lastPhishCacheAt !== undefined) {
    home.lastPhishCacheAt = Math.max(home.lastPhishCacheAt ?? 0, taken.lastPhishCacheAt);
  }
  if (taken.storm) home.storm = taken.storm;
  // A NEW storm stamp wipes home's own fold with the SAME shared function the
  // overseer runs, because the two must not disagree about what a storm
  // destroys. Immediately rather than after the quiet period: home only
  // publishes, so the movable hosts' facts are garbage from the first second
  // of the burst and there is no derivation to hold still for.
  if (taken.stormFiredAt !== undefined && taken.stormFiredAt > (home.lastStormAt ?? 0)) {
    home.lastStormAt = taken.stormFiredAt;
    if (home.knowledge !== undefined) {
      home.knowledge = stormWipe(home.knowledge, { stasisLinked: home.stasisLinked });
    }
  }
  for (const resident of taken.residents) {
    // Every field of the drained resident IS a digest field — the digest is a
    // superset — so the record travels whole rather than being re-listed and
    // silently missing whatever counter is added next. `alive` is recomputed
    // from the beat window at publish time.
    home.agentHostsSeen.add(resident.host);
    home.agents.set(resident.host, { ...resident, role: "resident", alive: true });
  }
  home.overseerBeatAt = Math.max(home.overseerBeatAt, rendezvous.lastBeatAt);
  home.residentsLost += taken.residentsLost;
  return {
    // Straight through: a `ReportHost` already carries the timestamp of the job
    // that saw it, which is the only thing the fold needs.
    hosts: taken.hosts,
    attempts: taken.attempts,
    logDrains: taken.logDrains,
    residents: taken.residents.map((resident) => resident.host),
    drained: taken.hosts.length,
    rejected: 0,
    credentials: taken.credentials.length,
    mutations: taken.mutations,
  };
}

/** The darknet overseer, if one is running. Typed access to the realm slot the
 * agents install, so home never reaches into `globalThis` by hand. */
function dnetRendezvous(): ControllerHandle | undefined {
  return (globalThis as typeof globalThis & { dnet_controller?: ControllerHandle }).dnet_controller;
}

/** The last instant a host's agent gave evidence of life. While an order runs
 * the beat freezes (spawn killed the resident), so an active order vouches for
 * its host until its own timeout; a long order vouches on its own beat. */
function residentLastLife(entry: HostEntry | undefined): number {
  const agent = entry?.agent;
  if (agent === undefined) return 0;
  if (agent.order.longLived) return Math.max(agent.beatAt, agent.beatAt + LONG_JOB_BEAT_MS);
  if (agent.order.kind !== "idle" && agent.startedAt !== undefined) return Math.max(agent.beatAt, agent.startedAt + JOB_TIMEOUT_MS);
  return agent.beatAt;
}

const dnet: FeatureDriver = {
  id: "dnet",
  // 5s — the feature-cadence floor, and as fast as this may go without joining
  // the hot path. This tick DRAINS the overseer and PUBLISHES the map, pure
  // in-process work (read the realm rendezvous, fold, publish; the seed and
  // backdoors carry their own backoffs and no-op until due). But feature
  // drivers are awaited SERIALLY, and this one folds + publishes over up to 220
  // hosts and plans backdoors every pass, so a sub-5s period would crowd the
  // 200ms dispatcher the way `features.test.ts` guards against. The period is
  // pure first-paint latency: the resident surveys darkweb in ~3s and drains
  // to the overseer instantly, but the MAP cannot appear until home's next tick
  // publishes it. 10s left a blank screen long after the beachhead was alive;
  // 5s follows it closely. Going lower is a job for an event-driven wake (the
  // overseer signalling home on drain), not a hotter poll.
  everyMs: 5_000,
  requires: "dnet",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.dnet;
    if (!topic) return;

    // The far net is learned ONLY from delivered reports. home's own probe can
    // see darkweb and nothing else, so without this the map stops at the first
    // hop. See spec/dnet.md.
    const now = Date.now();
    // The generation is the install epoch: agents survive an overseer cold
    // boot and a build handoff, so a report has to be tied to the world it was
    // gathered in, not to this process.
    const progression = ctx.state.topics.progression;
    const generation = `${progression?.bitNode ?? 0}:${progression?.lastAugReset ?? 0}`;
    if (!home.knowledge || home.knowledge.generation !== generation) {
      home = freshDnetHomeState();
      home.knowledge = emptyKnowledge(generation);
      delete ctx.state.darknetContractListings;
      delete ctx.state.darknetContractHandledAt;
      ctx.state.contractQueue = ctx.state.contractQueue?.filter((contract) => contract.dnet === undefined);
      // A reload restarts every script and empties the vault; this reads back the
      // passwords home cracked before it, so a reloaded run skips re-cracking
      // (immune/stasis hosts especially, whose password never changes). The file
      // is generation-guarded, so a prestige's mismatch loads nothing. Done here,
      // once per generation, right after knowledge is reset so the seeded hosts
      // land in the fresh fold.
      const loaded = loadPersistedDnetState(ctx.ns, generation);
      if (loaded.credentials > 0 || loaded.backdoors > 0) {
        record(
          "dnet-restore",
          true,
          `restored ${loaded.credentials} credential(s) and ${loaded.backdoors} backdoor(s) from the last reload`,
        );
      }
    }
    const topicIsCurrent = topic.knowledge === undefined || topic.knowledge.generation === generation;
    if (topicIsCurrent && topic.stasisLinked !== undefined && topic.stasisObservedAt !== undefined
      && topic.stasisObservedAt > home.stasisObservedAt) {
      home.stasisObservedAt = topic.stasisObservedAt;
      home.stasisLinked = new Set(topic.stasisLinked);
    }
    const knowledge = home.knowledge;
    const {
      hosts: reported,
      attempts: reportedAttempts,
      logDrains: reportedLogDrains,
      drained,
      rejected,
      credentials: vaultDrained,
      mutations,
    } = drainDarknet(generation);
    const rendezvous = dnetRendezvous();
    const bitNode = progression?.bitNode ?? 1;
    // A stasis-linked host is outside the mutation clock entirely, and WE are the
    // only thing that links or releases one — so the set comes from here rather
    // than from an observed fact that could itself go stale.
    // `getNetDepth()` IS the current labyrinth's depth, and all eight lab servers
    // are constructed with the net itself — so one sighting of any of them pins
    // the net's depth exactly, long before it is reachable. That matters twice
    // over: the mutation clock is `30_000 / netDepth`, so without a sighting
    // every staleness expiry below runs on the `DEFAULT_NET_DEPTH` fallback
    // instead of the real depth, and the map cannot draw the rows we have not
    // reached without knowing how many there are. Carried over from the topic
    // between sightings, since it only changes when a lab is completed.
    const netDepth = netDepthFromLabs(Object.keys(knowledge.hosts)) ?? (topicIsCurrent ? topic.netDepth : undefined);
    const expiry: ExpiryOpts = {
      bitNode,
      backdoored: home.backdoored.size,
      ...(netDepth !== undefined ? { netDepth } : {}),
      // The authoritative snapshot plus any newer controller pin/release
      // events, reconciled by observation time above.
      stasisLinked: new Set(home.stasisLinked),
    };
    // Only the residents' drained reports now. Home no longer reads darkweb
    // itself — the resident standing on it probes it on the mutation clock and
    // drains the result here, so there is exactly one prober and no redundant
    // home-side copy to fold in.
    const folded = foldReports(knowledge, reported, now, expiry);
    home.knowledge = folded.knowledge;
    const invalidatedHosts = new Set([...folded.hostsReplaced, ...folded.hostsForgotten]);
    for (const hostname of invalidatedPersistedBackdoors(
      home.backdoored,
      home.knowledge,
      [...folded.hostsReplaced, ...folded.hostsForgotten],
    )) {
      home.backdoored.delete(hostname);
    }
    syncDarknetContracts(ctx.state, home.knowledge, now, expiry);
    // Attempt outcomes fold into home's OWN ledger — the same helper the
    // overseer uses — so the panel's cracking progress survives an overseer
    // death the way the map does. An unknown-model outcome is also the only
    // channel that ever populates `unknownModels`: the overseer detects the
    // case, but only home accumulates it across overseer lifetimes.
    for (const { hostname, outcome } of reportedAttempts) {
      foldAttempts(home.knowledge.hosts[hostname], [outcome]);
      if (outcome.status === "unknown-model") {
        const id = outcome.modelId ?? "(no model id)";
        home.unknownModels[id] = (home.unknownModels[id] ?? 0) + 1;
      }
    }
    for (const { hostname, outcome } of reportedLogDrains) {
      foldLogDrain(home.knowledge.hosts[hostname], outcome);
    }
    // A host we hold a credential for is flagged on the knowledge record so the
    // fold can drop the flag when the host disappears — the credential itself
    // stays in the vault and out of everything that is published.
    //
    // A vault entry for a host that has GONE — or that the fold has forgotten
    // entirely, or that a new identity now answers — is dead weight: the host
    // returns cleaned, with a new password, so keeping it would hand a stale
    // credential to the next attempt and burn a call proving it wrong. It also
    // rides every `order()` back out to the overseer, so a forgotten one never
    // stops being replayed.
    for (const [hostname, entry] of [...home.vault]) {
      const host = home.knowledge.hosts[hostname];
      if (!host
        || (folded.hostsReplaced.includes(hostname)
          && (entry.identity === undefined || entry.identity !== host.identity))
        || host.goneAt !== undefined
        || (entry.identity !== undefined && host.identity !== undefined && entry.identity !== host.identity)) {
        home.vault.delete(hostname);
      } else {
        markCredentialKnown(host);
      }
    }
    // Persist the private reload state after reconciliation. The writer compares
    // exact JSON first, so unchanged five-second ticks perform no file write;
    // credential growth/shrink and backdoor installs/removals do.
    persistDnetState(ctx.ns, generation);
    home.knowledge.mutationsSeen += mutations;
    // The hosts that actually reported, so `seenEver - live` is agent mortality
    // rather than a count of the one label a drain used to carry.
    const agentRetentionMs = forgetMs(expiry);
    for (const [hostname, agent] of [...home.agents]) {
      const host = home.knowledge.hosts[hostname];
      if (invalidatedHosts.has(hostname) || host === undefined || host.goneAt !== undefined
        || now - agent.lastBeatAt > agentRetentionMs) home.agents.delete(hostname);
    }
    const cover = coverage(home.knowledge, now, expiry);
    // From the FOLD, for the same reason `topologyComplete` is. Home's probe
    // computes this over its own one hop, and `probe()` is HOST-LOCAL — so from
    // home it sees `darkweb` and nothing else, and darkweb's depth is -1. The
    // number could therefore never be anything but -1, however far the crawler
    // had actually spread, which is exactly what the panel kept reporting.
    const deepest = Object.values(home.knowledge.hosts).reduce((found, host) => {
      if (host.goneAt !== undefined) return found;
      const depth = fresh<number>(host, "depth", now, {
        ...expiry,
        immune: isImmune(host, { stasisLinked: expiry.stasisLinked }),
      });
      return depth !== undefined && depth > found ? depth : found;
    }, -1);
    // Topology completeness is a property of the FOLD, not of home's own probe —
    // which hardcodes false because it can only ever see one hop. Deriving it
    // here is what makes it reachable at all: it becomes true the first time
    // every host we know about has a neighbour list we still believe, which is
    // exactly the condition `reachableFrom` needs to be an exact answer rather
    // than a partial graph presented as one.
    const topologyComplete = cover.known > 0 && cover.adjacencyKnown === cover.known;
    // --- the labyrinth cache, and the one rule that governs it --------------
    //
    // `getLabReward` calls `Player.queueAugmentation` directly, and the generic
    // augmentation price multiplier is `1.9 ^ (queued non-SoA)` charged against
    // every purchase made after it. The labyrinth six are not SoA-exempt, so
    // opening a lab cache mid-shopping-trip multiplies the rest of the cycle's
    // bill by 1.9x — and it silently invalidates the drainOrder and drainCeiling
    // `shared/strategy/factions/` froze, because the price context moved under
    // them. So it is held until the last purchase of an install cycle.
    //
    // `openable` is a conjunction of things we have OBSERVED, and every term is
    // there because `progression` raises an INSTALL BLOCKER off this value:
    //
    //   the cache file is known to exist, AND the host is online, AND a live
    //   resident is standing on it.
    //
    // Anything else — no file, no resident, the lab offline, the maze never
    // walked — publishes nothing at all and the install proceeds unchanged. The
    // asymmetry is deliberate: missing the deferral costs one augmentation's
    // price scaling once; blocking an install costs the whole cycle.
    let labCache: { host: string; filename: string; openable: boolean } | undefined;
    for (const host of Object.values(home.knowledge.hosts)) {
      if (!isLabyrinth(host.hostname, fresh<string>(host, "modelId", now, expiry))) continue;
      const files = fresh<string[]>(host, "caches", now, expiry) ?? [];
      const filename = [...files].sort()[0];
      if (filename === undefined) continue;
      const resident = home.agents.get(host.hostname);
      labCache = {
        host: host.hostname,
        filename,
        openable: host.goneAt === undefined
          && resident !== undefined
          && now - resident.lastBeatAt < OVERSEER_STALE_MS,
      };
      break;
    }
    // Work in flight, summed from each resident's last report. Live residents
    // only: a dead one's queue died with it, so counting its pending jobs would
    // report work that no longer exists.
    const liveResidents = [...home.agents.values()].filter((agent) => now - agent.lastBeatAt < OVERSEER_STALE_MS);
    const activeByKind: Record<string, number> = {};
    for (const agent of liveResidents) {
      if (agent.active !== undefined) activeByKind[agent.active] = (activeByKind[agent.active] ?? 0) + 1;
    }
    set(ctx.state, "dnet", {
      ...(topicIsCurrent && topic.stasisLinkLimit !== undefined
        ? { stasisLinkLimit: topic.stasisLinkLimit }
        : {}),
      ...(topicIsCurrent && topic.instability !== undefined ? { instability: topic.instability } : {}),
      channel: {
        drained,
        rejected,
        forgotten: folded.hostsForgotten.length,
        vaultDrained,
      },
      coverage: cover,
      codes: { ...home.codes },
      // Beside the response codes, and for the same reason: our own planner's
      // refusals are as attributable as the game's. Without this, removing the
      // three invented spread caps would have been unobservable.
      ...(home.spread ? { spread: home.spread } : {}),
      // The farm's own refusals, beside the spread's. Both answer "what did the
      // planner decline, and by what name".
      // The phishing window rides the farm block, because that is where its
      // reader is. The stamp is the only part that travels: the three-minute
      // interval is a constant, and the countdown is arithmetic.
      ...(home.farm
        ? {
          farm: {
            ...home.farm,
            ...(home.lastPhishCacheAt !== undefined ? { lastPhishCacheAt: home.lastPhishCacheAt } : {}),
          },
        }
        : {}),
      // The deliberate three, beside the farm and the spread and for the same
      // reason: each has a real price, so "why not" is the common answer.
      ...(home.hold || home.backdoorReport
        ? {
          hold: {
            ...(home.hold ?? { admitted: {}, refused: {}, examples: [] }),
            ...(home.backdoorReport ? { backdoors: home.backdoorReport } : {}),
          },
        }
        : {}),
      // The storm, beside the other deliberate decisions. The refusal names are
      // the status display: which gate is holding fire IS the answer to "why
      // has the storm not fired". Home's own fire stamp wins over the drained
      // snapshot's, because home is the copy that survives an overseer death.
      ...(home.storm
        ? {
          storm: {
            ...home.storm,
            ...(home.lastStormAt !== undefined ? { firedAt: home.lastStormAt } : {}),
          },
        }
        : {}),
      ...(home.karmaLoss !== 0 ? { karmaLoss: home.karmaLoss } : {}),
      ...(home.grammar ? { grammar: home.grammar } : {}),
      ...(labCache ? { labCache } : {}),
      // THE MAZE. The one part of the lab the panel cannot derive from the
      // hostname, so the one part that travels. Absent until a walk has learned
      // something, which is most runs.
      ...(home.lab ? { lab: home.lab } : {}),
      // THE MAP, and the only host representation the topic carries.
      knowledge: publishKnowledge(home.knowledge, now, {
        bitNode,
        // Without this the digest's own staleness ran on the default depth while
        // the tick above ran on the real one, so the panel and the driver could
        // disagree about what was still believable.
        ...(netDepth !== undefined ? { netDepth } : {}),
        stasisLinked: expiry.stasisLinked,
        vault: new Set(home.vault.keys()),
        unknownModels: home.unknownModels,
        // Published by HOST, because that is what the map draws a badge on. The
        // freshest agent on a host wins, so a host with a live worker never
        // reads as abandoned because a dead one shares it.
        agents: Object.fromEntries(
          [...home.agents.values()]
            .sort((a, b) => a.lastBeatAt - b.lastBeatAt)
            .map(({ host, ...digest }) => [
              host,
              // Only "alive" while the beat is recent. A roster that never
              // expired would report a full crew on a net that has lost every
              // one of them, which is exactly the number worth watching.
              { ...digest, alive: now - digest.lastBeatAt < OVERSEER_STALE_MS },
            ]),
        ),
        agentsLost: home.residentsLost,
        agentsSeenEver: Math.max(home.agentHostsSeen.size, home.agents.size),
        overseer: {
          host: "darkweb",
          lastBeatAt: home.overseerBeatAt,
          alive: now - home.overseerBeatAt < OVERSEER_STALE_MS,
          seedAttempts: home.seedAttempts,
        },
        queue: {
          pending: liveResidents.reduce((sum, agent) => sum + (agent.pending ?? 0), 0),
          active: Object.values(activeByKind).reduce((sum, count) => sum + count, 0),
          byKind: activeByKind,
        },
      }),
      ...(netDepth !== undefined ? { netDepth } : {}),
      maxDepth: deepest,
      mutationIntervalMs: mutationIntervalMs(netDepth, bitNode),
      charisma: ctx.state.topics.player?.skills.charisma ?? 1,
      topologyComplete,
      stasisLinked: [...home.stasisLinked].sort(),
      stasisObservedAt: home.stasisObservedAt,
    });
    const decision = stepDarknet({
      topologyComplete,
      // From the FOLD, not from home's one hop: the traversal is a
      // max-reachable-under-a-budget problem, and it was being handed `darkweb`
      // and its neighbours as though that were the graph.
      servers: Object.values(home.knowledge.hosts).map((host) => {
        const neighbours = fresh<string[]>(host, "neighbours", now, expiry);
        return {
          hostname: host.hostname,
          // -1 is darkweb's real depth AND our "no believable position", which is
          // safe here because the traversal only ever tests `depth === 0` to seed
          // its walk: a host we cannot place must not seed one either.
          depth: fresh<number>(host, "depth", now, expiry) ?? -1,
          // A missing value means "not known", and the strategy only ever
          // compares it as a capacity, so treat it as none.
          blockedRam: fresh<number>(host, "blockedRam", now, expiry) ?? 0,
          isOnline: host.goneAt === undefined,
          requiredCharisma: fresh<number>(host, "requiredCharisma", now, expiry) ?? 0,
          stasisLinked: expiry.stasisLinked?.has(host.hostname) === true,
          ...(neighbours ? { neighbours } : {}),
        };
      }),
      stasisLinked: [...home.stasisLinked],
      charisma: ctx.state.topics.player?.skills.charisma ?? 1,
    });

    merge(ctx.state, "dnet", {
      plan: {
        ranked: decision.ranked.slice(0, 8).map((entry) => ({
          hostname: entry.hostname,
          depth: entry.depth,
          unlocks: entry.unlocks,
        })),
        // Two sources, one channel. `stepDarknet` reads the map and says what
        // the next host would cost; the maze walker reports what the ENGINE
        // refused it. The higher of the two is the one that unblocks anything.
        ...(Math.max(decision.charismaNeeded ?? 0, home.charismaNeeded ?? 0) > 0
          ? { charismaNeeded: Math.max(decision.charismaNeeded ?? 0, home.charismaNeeded ?? 0) }
          : {}),
        ...(home.lastResult ? { lastResult: home.lastResult } : {}),
      },
    });

    // --- the beachhead ------------------------------------------------------
    //
    // Everything above this point observes. This is the only part that ACTS, and
    // it does exactly one thing: put an overseer on `darkweb` and let it run the
    // net from there. home cannot play this feature itself — `probe()` is
    // host-local, so from here the darknet is one host wide — and it cannot hold
    // a session either, because a session belongs to the PID that won it and
    // home's controller (`start.js`) is pinned at 3.6 GB static.
    //
    // Pinned to `home` for a reason that is easy to get wrong: `ns.exec`
    // evaluates its direct-connection requirement BEFORE the darkweb early-out,
    // and only home holds the TOR edge. A stub anywhere else scps happily and
    // then gets a silent 0.
    const buildId = gameBuildId();
    const retiringBuild = rendezvous !== undefined && rendezvous.buildId !== buildId;
    if (retiringBuild) {
      rendezvous.order({
        charisma: ctx.state.topics.player?.skills.charisma ?? 1,
        standDown: true,
      });
    }
    const overseerAlive = !retiringBuild && now - home.overseerBeatAt < OVERSEER_STALE_MS;
    // A host keeps exactly ONE resident, and it is the only thing that can start
    // work there. Home plants the first two — the overseer and darkweb's own
    // resident — and after that the net plants itself: a resident that opens a
    // neighbour scp's the agent across and execs a resident on it.
    //
    // Home keeps topping darkweb's resident up because a resident dies with its
    // host, and `darkweb` does reboot. Nothing else can put one back: planting
    // needs a session AND adjacency, and home is adjacent to nothing else.
    // Job-aware, not raw-beat: `lastBeatAt` freezes for the whole job — spawn
    // killed the resident, by design — and `JOB_TIMEOUT_MS` equals the stale
    // window, so a merely slow authenticate read as a dead resident and home
    // execed a SECOND agent onto darkweb while the first was still working.
    const darkwebResident = rendezvous?.hosts.get("darkweb");
    const residentAlive = darkwebResident?.agent !== undefined
      && now - residentLastLife(darkwebResident) < OVERSEER_STALE_MS;
    // NOT gated on the dodged probe. `darkweb` is a guaranteed constant the
    // moment dnet access is granted — and this driver only runs at all once it
    // is (`requires: "dnet"`), so waiting for `topic.probed` to name darkweb
    // just added a probe period (up to 30s) of blank screen before the
    // beachhead could even be attempted. The probe never confirmed the thing
    // that gates `exec` anyway — home's TOR edge — only that darkweb exists.
    // The seed's own `scp`+`exec` is the real reachability test, and it fails
    // into `seedNextAt`'s exponential backoff on a world where home cannot yet
    // reach darkweb (no TOR). So the seed is attempted on the FIRST tick this
    // driver runs, and the probe is left to enrich the map, not gate the boot.
    if (!retiringBuild && (!overseerAlive || !residentAlive) && now >= home.seedNextAt) {
      const controllerFile = "dnet/controller.js";
      const agentFile = "dnet/agent.js";
      // The prober rides to darkweb too, though darkweb's own worker never execs
      // it (the overseer probes darkweb directly): it has to be PRESENT on darkweb
      // so the worker there can `scp` it onward to each neighbour it plants.
      const proberFile = "dnet/prober.js";
      const charisma = ctx.state.topics.player?.skills.charisma ?? 1;
      const wantController = !overseerAlive;

      // The same list the claim is priced from, so the reservation and the stub
      // can never be sized off different sets.
      const seeded = await featureDodgeOn(ctx, "dnet", "action:seed", DNET_SEED_METHODS, "home", async (stubNs: NS) => {
        // Both payloads in ONE scp. `exec` of a file that is not there returns 0,
        // which is indistinguishable from "the host is full" — the same trap
        // game/lib/net.ts documents for the dodge stub — so the agent must never
        // arrive without the overseer beside it, or the other way round.
        if (!stubNs["scp"]([controllerFile, agentFile, proberFile], "darkweb", "home")) {
          return { controller: 0, resident: 0, reason: "scp refused" };
        }
        // The overseer is the durable half and holds the accumulated map, so a
        // live one is left strictly alone: restarting it to fix a missing
        // resident would throw the map away to solve a smaller problem.
        const controller = wantController
          ? await handoffLaunch<DnetControllerLaunch>(
            {
              kind: "dnet-controller",
              host: "darkweb",
              buildId,
              generation,
              identity: gameGlobal.artifactIdentity,
              charisma,
            },
            () => stubNs["exec"](
              controllerFile,
              "darkweb",
              temporaryRunOptions({ threads: 1, ramOverride: priceCalls(stubNs, CONTROLLER_CALLS) }),
            ),
          )
          : -1;
        if (controller === 0) {
          return { controller, resident: 0, reason: "exec refused (darkweb full, or not synced)" };
        }
        const resident = await handoffLaunch<DnetAgentLaunch>(
          { kind: "dnet-agent", host: "darkweb" },
          () => stubNs["exec"](
            agentFile,
            "darkweb",
            temporaryRunOptions({ threads: 1, ramOverride: priceCalls(stubNs, KIND_CALLS.idle) }),
          ),
        );
        return {
          controller,
          resident,
          reason: resident === 0 ? "no room on darkweb for a resident" : "",
        };
      });
      home.seedAttempts++;
      if (seeded.ok && seeded.value.controller !== 0 && seeded.value.resident !== 0) {
        record(
          "seed",
          true,
          seeded.value.controller === -1
            ? `replaced darkweb's resident (pid ${seeded.value.resident})`
            : `controller pid ${seeded.value.controller}, resident pid ${seeded.value.resident}`,
        );
        home.seedBackoffMs = DNET_SEED_BACKOFF_MS;
      } else {
        record("seed", false, seeded.ok ? seeded.value.reason : seeded.reason);
        // Exponential backoff. Without it, a world where the seed can never work
        // — not synced, no room, a node without access — re-execs on every tick
        // for ever, and the failure is loud in exactly the way that trains people
        // to ignore it.
        home.seedBackoffMs = Math.min(home.seedBackoffMs * 2, DNET_SEED_MAX_BACKOFF_MS);
      }
      home.seedNextAt = now + home.seedBackoffMs;
    }

    // Tell the overseer what only home can see. It cannot afford `getPlayer`
    // (0.5 GB out of 1.65), and it needs charisma to know which hosts a job may
    // heartbleed at all. The vault is replayed with it so a restarted overseer
    // does not re-crack a net we already opened.
    // The one darknet action home performs itself, and it performs it because
    // it is the only thing that can: a backdoor is installed on the TERMINAL's
    // current server. It keeps two sacrificial backdoors on the worst fully
    // harvested RAM hosts, so most passes it decides to do nothing and says why.
    await serveDarknetBackdoors(
      ctx,
      home.knowledge,
      now,
      expiry,
      netDepth,
      bitNode,
      ctx.state.topics.player?.skills.charisma ?? 1,
      (topicIsCurrent ? topic.instability?.authenticationDurationMultiplier : undefined) ?? 1,
    );

    // Symbols worth spreading propaganda about, and the bar is deliberately
    // high: `promoteStock` raises VOLATILITY and never forecast, so it
    // amplifies whatever edge a symbol already has in BOTH directions and is
    // worth nothing on a symbol we have no view on. The stock planner's own
    // ranking is that view — an entry it would take, priced net of commission —
    // and two symbols is as far as it is worth spreading a charge curve that
    // saturates. Usually empty, and the farm ladder says so by name.
    const promoteSymbols = (ctx.state.topics.stock?.plan?.ranked ?? [])
      .filter((entry) => entry.expectedProfit > 0)
      .slice(0, 2)
      // The expected profit rides along: it is the promote side of the farm's
      // phish-vs-promote comparison, and only home can price it.
      .map((entry) => ({ symbol: entry.sym, expectedProfit: entry.expectedProfit }));

    if (overseerAlive && rendezvous) {
      rendezvous.order({
        charisma: ctx.state.topics.player?.skills.charisma ?? 1,
        // The clock the overseer's expiries run on. Home pins the real depth
        // from a lab sighting and knows which node this is; without the order
        // the overseer sits on the shared defaults for ever and re-observes
        // more than it needs to. Both conditional: the overseer's own default
        // (BN15, depth 5) errs toward re-observing, and ordering the `?? 1`
        // guess would DOUBLE its expiries in a BN15 run whose progression topic
        // has not landed — the unsafe direction.
        ...(netDepth !== undefined ? { netDepth } : {}),
        ...(progression?.bitNode !== undefined ? { bitNode } : {}),
        // The one permission home grants the farm ladder, and it is granted only
        // while `progression` is actually holding an install open for it. The
        // overseer refuses a labyrinth cache by name otherwise.
        openLabCache: progression?.plan?.installBlockers?.includes("dnet-lab-cache") === true,
        // Three things only home can see, and every one of them is a term in a
        // decision the overseer makes rather than a status line.
        //
        // Backdoors carry their observation times: the overseer can count only
        // the still-believable ones and may reuse a session remotely only until
        // the restart/delete clock expires. The stasis LIMIT is
        // `1 + TheBrokenWings + TheHammer + TheStaff`, read by the dodged
        // probe. And the symbols are the market, which the darknet cannot see.
        backdoors: [...home.backdoored].map(([hostname, installedAt]) => ({ hostname, installedAt })),
        ...(promoteSymbols.length > 0 ? { promoteSymbols } : {}),
        // A term in both phishing chances, and only home can see the player.
        ...(ctx.state.topics.player?.mults.crime_success !== undefined
          ? { crimeSuccessMult: ctx.state.topics.player.mults.crime_success }
          : {}),
        // The net facts only the dodged probe can read. The overseer PLANS
        // stasis — it is the only thing that knows which hosts have live
        // residents and which are irreplaceable — and it ACTS, because
        // `setStasisLink` pins the calling host. But it cannot see how many
        // links exist or which hosts already hold one, so those come from here.
        ...(topicIsCurrent && topic.stasisLinkLimit !== undefined ? { stasisLimit: topic.stasisLinkLimit } : {}),
        stasisSnapshot: {
          hosts: [...home.stasisLinked].sort(),
          at: home.stasisObservedAt,
        },
        // Whether a labyrinth can exist at all: `getCurrentLabName` is gated on
        // FULL access (BN15 or SF15), so a program-only run gets the 5-deep net
        // and no lab is ever generated. Only home can see the bitNode and the
        // source files. Sent only once progression has landed — the overseer's
        // default is true, the conservative side.
        ...(progression !== undefined
          ? { labExpected: progression.bitNode === 15 || (progression.sourceFiles["15"] ?? 0) > 0 }
          : {}),

        ...(home.lastPhishCacheAt !== undefined ? { lastPhishCacheAt: home.lastPhishCacheAt } : {}),
        // Replayed for the same reason as the phishing window, plus one: a
        // re-seeded overseer standing in a net mid-storm must not mistake the
        // burst for ordinary churn, and the 30-minute seed-eligibility window
        // is what gates its seed hunt.
        ...(home.lastStormAt !== undefined ? { lastStormAt: home.lastStormAt } : {}),
        vaultSnapshot: { entries: [...home.vault.values()], at: now },
      });
    }

    // Nothing follows. `stepDarknet` no longer proposes an action for home to
    // refuse: authentication happens in a job standing next door to its target,
    // and `setStasisLink` pins the CALLING host, so neither was ever something
    // this driver could carry out. The block that recorded those refusals went
    // with them — a standing refusal for work nobody was going to attempt is
    // noise in the one panel that exists to say why the net is stuck.
  },
};

/** The terminal route from home to a darknet host, or nothing.
 *
 * `singularity.connect` walks `serversOnNetwork` one hop at a time, and darknet
 * edges ARE on it — so the walk is possible. What is not possible is finding it
 * the way the hacking backdoor does: `ns.scan` omits darknet servers, so its BFS
 * sees `darkweb` and stops. The graph has to come from the fold.
 *
 * Every hop is walked over a neighbour list we still BELIEVE, which is what the
 * `fresh` call does: a stale hop is not a slower route, it is a route that ends
 * with the terminal stranded somewhere deep while the net rearranges around it.
 * Adjacency is the shortest-lived fact we hold, so this refuses far more often
 * than it succeeds, and that is the correct ratio. */
export function darknetRoute(
  knowledge: DarknetKnowledge,
  target: string,
  now: number,
  expiry: ExpiryOpts,
): string[] | undefined {
  // `darkweb` is the one darknet host home is adjacent to — it holds the TOR
  // edge — so every route starts there and nowhere else.
  if (target === "darkweb") return ["darkweb"];
  const parents = new Map<string, string | undefined>([["darkweb", undefined]]);
  const queue = ["darkweb"];
  for (let index = 0; index < queue.length && !parents.has(target); index++) {
    const current = queue[index]!;
    const host = knowledge.hosts[current];
    if (!host || host.goneAt !== undefined) continue;
    const neighbours = fresh<string[]>(host, "neighbours", now, expiry);
    // A hop whose adjacency has expired is not a hop. Skipping it rather than
    // trusting it is the whole safety property here.
    if (neighbours === undefined) continue;
    for (const neighbour of neighbours) {
      if (parents.has(neighbour)) continue;
      parents.set(neighbour, current);
      queue.push(neighbour);
    }
  }
  if (!parents.has(target)) return undefined;
  const route: string[] = [];
  for (let at: string | undefined = target; at !== undefined; at = parents.get(at)) route.push(at);
  return route.reverse();
}

/** Install one backdoor on one darknet host, from home's terminal.
 *
 * Home-side and not a dnet job, because there is no other choice:
 * `singularity.installBackdoor` acts on `Player.getCurrentServer()` — the
 * TERMINAL's server — and only home has a terminal. A darknet backdoor is a
 * flat four seconds (`calculateHackingTime` returns 16 for a DarknetServer, and
 * the install is a quarter of it) and skips the hacking-skill gate entirely,
 * which is what makes it worth having at all.
 *
 * The policy uses the destructive side deliberately: two backdoors avoid every
 * global authentication penalty while making fully harvested, subnormal-RAM
 * hosts eligible for the restart/delete branches. Only deletion plus a later
 * population addition creates a fresh first-auth roll and RAM-clear cache. */
async function serveDarknetBackdoors(
  ctx: DriverContext,
  knowledge: DarknetKnowledge,
  now: number,
  expiry: ExpiryOpts,
  netDepth: number | undefined,
  bitNode: number,
  charisma: number,
  instability: number,
): Promise<void> {
  const protectedHosts = new Set(
    (home.lab?.walkers ?? []).map((walker) => walker.from),
  );
  const hosts: HoldHost[] = Object.values(knowledge.hosts).map((host) => {
    const difficulty = fresh<number>(host, "difficulty", now, expiry);
    const maxRam = fresh<number>(host, "maxRam", now, expiry);
    const blockedRam = fresh<number>(host, "blockedRam", now, expiry);
    const caches = fresh<string[]>(host, "caches", now, expiry);
    const contracts = fresh<string[]>(host, "contracts", now, expiry);
    const stormSeed = fresh<boolean>(host, "stormSeed", now, expiry);
    return {
      ...holdHostFrom(host, {
        at: now,
        expiry,
        agentAlive: (home.agents.get(host.hostname)?.lastBeatAt ?? 0) > now - OVERSEER_STALE_MS,
        hasCredential: home.vault.has(host.hostname),
        stasisLinked: home.stasisLinked.has(host.hostname),
      }),
      ...(difficulty !== undefined ? { difficulty } : {}),
      ...(maxRam !== undefined ? { maxRam } : {}),
      ...(blockedRam !== undefined ? { blockedRam } : {}),
      ...(caches !== undefined ? { caches } : {}),
      ...(contracts !== undefined ? { contracts } : {}),
      ...(stormSeed !== undefined ? { stormSeed } : {}),
      ...(protectedHosts.has(host.hostname) ? { protected: true } : {}),
      // A stasis link sets backdoorInstalled, so a pinned host is already
      // remotely reachable and is outside the recycler's destructive pool.
      ...(home.backdoored.has(host.hostname) || home.stasisLinked.has(host.hostname) ? { backdoored: true } : {}),
    };
  });
  const plan = planBackdoors({
    hosts,
    netDepth: netDepth ?? DEFAULT_NET_DEPTH,
    stasisLimit: ctx.state.topics.dnet?.stasisLinkLimit ?? 1,
    charisma,
    authDurationMultiplier: instability,
  });
  // `planBackdoors` keys its refusals by `hostname`; the roll-up says `host`.
  home.backdoorReport = {
    install: plan.install,
    ...foldRefusals(plan.refused.map((refusal) => ({
      host: refusal.hostname,
      why: refusal.why,
      detail: refusal.detail,
    }))),
  };

  if (home.backdoorInFlight || now < home.backdoorNextAt) return;
  // THE BELIEF EXPIRES, exactly as every other darknet fact does. A backdoored
  // host carries a ~9%/tick restart and a restart CLEARS the backdoor
  // (restartServer drops backdoorInstalled). The stamped belief is persisted
  // beside the credential vault, so a reload restores the same occupied slots.
  // Expiry removes a belief when restart/deletion should have invalidated it,
  // and that removal is persisted before another slot can be filled.
  const backdoorLife = msPerHostEventAny(
    ["restarted", "deleted"],
    netDepth ?? DEFAULT_NET_DEPTH,
    bitNode,
    home.backdoored.size,
  );
  let backdoorsChanged = false;
  for (const [hostname, installedAt] of [...home.backdoored]) {
    const host = knowledge.hosts[hostname];
    if (!host || host.goneAt !== undefined || now - installedAt > backdoorLife) {
      home.backdoored.delete(hostname);
      backdoorsChanged = true;
    }
  }
  if (backdoorsChanged) persistDnetState(ctx.ns, knowledge.generation);
  const target = plan.install[0];
  if (target === undefined) return;
  const route = darknetRoute(knowledge, target, now, expiry);
  if (route === undefined) {
    // Not a failure to record against the host: the map is stale, which the
    // next survey fixes on its own.
    home.backdoorNextAt = now + DNET_BACKDOOR_BACKOFF_MS;
    home.backdoorReport.refused["stale-route"] = (home.backdoorReport.refused["stale-route"] ?? 0) + 1;
    home.backdoorReport.examples.push({
      host: target,
      why: "stale-route",
      detail: "no hop-by-hop route from darkweb whose every adjacency we still believe",
    });
    return;
  }
  home.backdoorInFlight = true;
  try {
    const outcome = await featureDodgeOn(ctx, "dnet", "action:backdoor", DNET_BACKDOOR_CALLS, "home", async (stubNs: NS) => {
      // Home first, always: the terminal is global state and some other dodge
      // may have left it anywhere. Without this the first hop is measured from
      // a server we are not on and the walk fails at step one.
      if (!stubNs["singularity"]["connect"]("home" as never)) {
        throw new Error("could not return the terminal to home");
      }
      for (const hop of route) {
        if (!stubNs["singularity"]["connect"](hop as never)) {
          throw new Error(`route to ${target} failed at ${hop}`);
        }
      }
      await stubNs["singularity"]["installBackdoor"]();
      // Back to home rather than left deep in the net. While the terminal is
      // ON a darknet server that server is `isImmutable` and cannot be moved —
      // which sounds useful and is not: it is one host pinned by accident, and
      // every other backdoor and every terminal-using dodge would start from
      // wherever this one stopped.
      stubNs["singularity"]["connect"]("home" as never);
      return route.length;
    });
    if (outcome.ok) {
      home.backdoored.set(target, Date.now());
      persistDnetState(ctx.ns, knowledge.generation);
      record("backdoor", true, `${target} backdoored, ${outcome.value} hops out`);
    } else if (!outcome.queued) {
      home.backdoorNextAt = now + DNET_BACKDOOR_BACKOFF_MS;
      record("backdoor", false, outcome.reason);
    }
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    home.backdoorNextAt = now + DNET_BACKDOOR_BACKOFF_MS;
    record("backdoor", false, String(error).slice(0, 200));
  } finally {
    home.backdoorInFlight = false;
  }
}

/** Whether home should be holding RAM for a seed this pass.
 *
 * Read from the same two facts the tick uses, so the claim and the action cannot
 * disagree: a claim without an action wastes a reservation, and an action
 * without a claim spends RAM the broker never accounted for. */
function dnetSeedWanted(state: GameState): boolean {
  // Deliberately NOT gated on `topic.probed`: the tick's seed action is not
  // either (see the beachhead block). `darkweb` is guaranteed the moment dnet
  // access is granted, so the claim reserves seed RAM on the first tick and
  // the action spends it the same tick, rather than both waiting a probe
  // period for a fact that was never in doubt.
  const now = Date.now();
  // Either the overseer is gone, or darkweb has no resident to run anything.
  if (now - home.overseerBeatAt >= OVERSEER_STALE_MS) return true;
  const resident = dnetRendezvous()?.hosts.get("darkweb");
  return resident?.agent === undefined || now - residentLastLife(resident) >= OVERSEER_STALE_MS;
}

/** Darknet needs charisma, which career owns. */
function dnetNeeds(ctx: NeedContext): Need[] {
  const needed = ctx.state.topics.dnet?.plan?.charismaNeeded;
  if (needed === undefined) return [];
  return [
    {
      by: "dnet",
      kind: "charisma",
      target: needed,
      have: ctx.state.topics.player?.skills.charisma ?? 1,
      weight: 3,
      urgency: "blocking",
    },
  ];
}

/** The lab-cache deferral, evaluated against dnet's own memory of when it was
 * first raised. `progression` calls this each refresh — the deferral gates ITS
 * install — but the SINCE stamp is darknet state: `dnetModule.reset` clears it
 * with everything else the feature derived from the world it is leaving. */
export function dnetLabCacheDeferral(labCacheOpen: boolean, now: number): boolean {
  const deferral = labCacheDeferral({ since: home.labCacheSince }, labCacheOpen, now);
  home.labCacheSince = deferral.since;
  return deferral.defer;
}

export const dnetModule: FeatureModule = {
  driver: dnet,
  reset: (state) => {
    // Module state as well as the topic: an agent's knowledge describes the
    // world we just left, and a BitNode reset destroys the darknet outright.
    // A stale fold surviving a prestige would hand the new node the old net's
    // map, which is the same class of bug as a stale topic. (Backdoors and
    // stasis links are per-WORLD too: a prestige rebuilds the net and
    // `prestigeDarknetState` drops every link with it. And the vault goes with
    // the knowledge, for a stronger reason: every password we hold is for a
    // host that no longer exists — carrying them across would be the credential
    // equivalent of a map of a dead world.)
    home = freshDnetHomeState();
    // `prestigeDarknetState` restamps `lastPhishingCacheTime`, so an install
    // starts with the window SHUT. Leaving this undefined would tell the
    // next overseer the opposite; stamping it now is what upstream does.
    home.lastPhishCacheAt = Date.now();
    // The storm clock too: `lastStormTime` is module scope and restamped when
    // the engine reloads, so no seed can be minted in the first thirty
    // minutes — and a seed hunt started before then would grind for rolls
    // that cannot pay.
    home.lastStormAt = Date.now();
    delete state.darknetContractListings;
    delete state.darknetContractHandledAt;
    state.contractQueue = state.contractQueue?.filter((contract) => contract.dnet === undefined);
    delete state.topics.dnet;
  },
  claims: (ctx) => {
    // The seed is the ONLY darknet action home performs, so it is the only thing
    // there is to reserve RAM for. `stepDarknet` used to propose traversal
    // actions here too; none of them were executable from home, so the claim
    // beside them reserved RAM for work that always refused.
    if (dnetSeedWanted(ctx.state)) {
      return [actionRamClaim(ctx, "dnet", "action:seed", DNET_SEED_METHODS)];
    }
    return [];
  },
  needs: dnetNeeds,
};

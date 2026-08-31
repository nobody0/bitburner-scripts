import type { NS } from "@ns";
import { stepDarknet } from "../../../shared/strategy/dnet/decide.ts";
import { FARM_NOMINAL_CHANNEL_WORTH_SEC } from "../../../shared/strategy/dnet/farm.ts";
import { MONEY_CHANNEL } from "../../../shared/strategy/income.ts";
import { CONTRACT_QUEUE_LIMIT } from "../../../shared/strategy/side/contracts.ts";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import {
  holdHostFrom,
  planBackdoors,
  type HoldHost,
} from "../../../shared/strategy/dnet/hold.ts";
import type { VaultEntry } from "../../../shared/strategy/dnet/courier.ts";
import { publishKnowledge } from "../../../shared/strategy/dnet/publish.ts";
import {
  DEFAULT_NET_DEPTH,
  isLabyrinth,
  msPerHostEventAny,
  mutationIntervalMs,
  netDepthFromLabs,
} from "../../../shared/strategy/dnet/rates.ts";
import {
  knowledgeCoverage,
  emptyKnowledge,
  expiryMs,
  fresh,
  isImmune,
  type DnetKnowledge,
  type ExpiryOpts,
} from "../../../shared/strategy/dnet/host.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { advanceLabCacheDeferral, labCacheWindowOpen } from "../../../shared/strategy/progression/decide.ts";
import type { DarknetAgentDigest, DarknetKnownHost } from "../../../shared/telemetry/topics/dnet.ts";
import {
  PROBER_GB,
  CONTROLLER_GB,
  type ControllerHandle,
} from "../../dnet/shared.ts";
import {
  DNET_RECOVERY_VERSION,
  foldRefusals,
  type DnetRecoveryState,
  type DnetSnapshot,
} from "../../dnet/wire.ts";
import { gameBuildId } from "../build-id.ts";
import { handoffLaunch, temporaryRunOptions } from "../launch-shared.ts";
import type { DnetControllerLaunch, DnetProberLaunch } from "../../dnet/launch.ts";
import { emptyDnetProfit, hasDnetProfit } from "../../dnet/profit.ts";
import { gameGlobal } from "../globals.ts";
import { isScriptDeath } from "../errors.ts";
import { merge, set, type GameState } from "../state.ts";
import {
  darknetContractsFromListings,
  mergeContractQueue,
  pendingDarknetContracts,
  type DarknetContractListing,
} from "../contracts.ts";
import type { DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";
import { slotRates } from "../income.ts";

/** The HOME DRIVER: the one darknet process that runs on `home`.
 *
 * The spec's vocabulary (spec/dnet.md): the home driver seeds and re-seeds the
 * CONTROLLER onto `darkweb`, caches its latest immutable checkpoint, installs
 * backdoors from the terminal (the one darknet action only home can perform),
 * and tells the controller what only home can see. The controller itself lives
 * in `game/dnet/controller.ts`; the RESIDENTS it schedules live in
 * `game/dnet/agent.ts`.
 *
 * The controller is the sole authority for darknet knowledge. `DnetHomeState`
 * holds a read projection plus the checkpoint used to recover from controller
 * failure. Only the vault and installed-backdoor ledger cross
 * a page reload through disk. */

/** How long a silent controller is given before home re-seeds. Four missed beats
 * at the controller's 15 s cadence: `darkweb` does reboot — there is a literature
 * file about it — and when it does, the coordinator dies with it. */
const DNET_PROCESS_STALE_MS = 60_000;
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
  knowledge: DnetKnowledge,
  now: number,
  expiry: ExpiryOpts,
  retiredHosts: readonly string[] = [],
): void {
  const listings = state.darknetContractListings ??= {};
  const handled = state.darknetContractHandledAt ??= {};
  const deleteHostKeys = <T>(record: Record<string, T> | undefined, hostname: string): void => {
    const prefix = `${hostname}\0`;
    for (const key of Object.keys(record ?? {})) {
      if (key.startsWith(prefix)) delete record![key];
    }
  };

  const retireHost = (hostname: string): void => {
    delete listings[hostname];
    deleteHostKeys(handled, hostname);
    deleteHostKeys(state.contractQuarantine, hostname);
  };

  // A dirty file fact only says the listing must be refreshed. Replacement
  // and disappearance are stronger facts supplied by the knowledge fold: only
  // those may discard terminal outcomes belonging to the old host identity.
  for (const hostname of retiredHosts) retireHost(hostname);

  for (const hostname of Object.keys(listings)) {
    const host = knowledge.hosts.get(hostname);
    if (!host || host.dirty.files === true) delete listings[hostname];
  }

  for (const host of [...knowledge.hosts.values()].sort((a, b) => a.hostname.localeCompare(b.hostname))) {
    const observedAt = host.seenAt.files;
    if (observedAt === undefined || host.contracts === undefined || host.dirty.files === true) continue;
    if (listings[host.hostname]?.identity !== undefined
      && listings[host.hostname]!.identity !== host.identity) retireHost(host.hostname);
    const files = [...host.contracts].sort();
    const validUntil = observedAt + expiryMs("files", { ...expiry, immune: isImmune(host, expiry) });
    if (host.identity === undefined) continue;
    const listing: DarknetContractListing = {
      identity: host.identity,
      observedAt,
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

/** What one seed pass managed. A pid, or `-1` for a half that was already
 * healthy and deliberately left alone, or `0` for one that could not be
 * placed; `pending` marks the half that was merely waiting on a controller
 * this same pass started, which is neither an attempt nor a failure. */
interface SeedOutcome {
  controller: number;
  prober: number;
  reason: string;
  pending?: boolean;
}
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
  /** Latest immutable controller checkpoint. Replaced whole, never folded. */
  recovery: DnetRecoveryState | undefined;
  /** When a `.d.cache` was last seen to land, held here so it survives an
   * controller death and is replayed to the replacement. The phishing cache
   * cooldown is NET-WIDE engine state exposed through no ns member at all. */
  lastPhishCacheAt: number | undefined;
  /** When the last storm fired, on our own clocks — whichever of the
   * controller's claim-time stamp and its checkpointed one is newer. Survives a
   * controller death and is replayed to the replacement: `lastStormTime` is
   * engine module state no ns member exposes, and it gates both the quiet
   * period and when a new seed can be minted (`STORM_COOLDOWN_MS`). */
  lastStormAt: number | undefined;
  /** When the lab-cache install deferral was first raised, so it can EXPIRE.
   *
   * The asymmetry is the point and it is stated here because this is the field
   * that enforces it: missing the deferral costs one augmentation's price
   * scaling, once. Blocking an install costs the whole cycle. */
  labCacheSince: number | undefined;
  /** Darknet hosts HOME has backdoored, keyed to when each was installed.
   *
   *  Home's own record rather than an observed fact: `installBackdoor` acts on
   *  the terminal's current server, so home is the only thing that can install
   *  one — and reading `backdoorInstalled` back costs 2 GB for a fact we
   *  already hold. A restart clears the backdoor (~9%/tick), so the set is
   *  trimmed whenever authoritative discovery removes the host. */
  backdoored: Map<string, number>;
  /** Last exact JSON written to dnet-vault.txt. Used only to avoid rewriting an
   * unchanged zero-RAM state file on every five-second feature tick. */
  persistedState: string | undefined;
  /** The backoff that keeps a structurally impossible backdoor from being
   *  retried every pass. */
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
  /** Residents the controller last reported, keyed by HOST — a host keeps
   * exactly one, and the controller is tracked separately
   * (`controllerBeatAt`). Keyed by host because the map's badge sits on a box. */
  agents: Map<string, DarknetAgentDigest & { host: string }>;
  /** Latest volatile RAM sample per host; never folded into durable knowledge. */
  ram: Map<string, NonNullable<DarknetKnownHost["ram"]>>;
  /** When the controller last said it was alive. Home cannot see into the darknet,
   * so this beat is the ONLY evidence the beachhead is still standing. */
  controllerBeatAt: number;
  seedAttempts: number;
  seedNextAt: number;
  seedBackoffMs: number;
  /** The last recorded action outcome, for the panel's `plan.lastResult`. */
  lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
}

function freshDnetHomeState(): DnetHomeState {
  return {
    recovery: undefined,
    lastPhishCacheAt: undefined,
    lastStormAt: undefined,
    labCacheSince: undefined,
    backdoored: new Map(),
    persistedState: undefined,
    backdoorNextAt: 0,
    backdoorInFlight: false,
    backdoorReport: undefined,
    stasisLinked: new Set(),
    stasisObservedAt: 0,
    agents: new Map(),
    ram: new Map(),
    controllerBeatAt: 0,
    seedAttempts: 0,
    seedNextAt: 0,
    seedBackoffMs: DNET_SEED_BACKOFF_MS,
    lastResult: undefined,
  };
}

let home = freshDnetHomeState();

/** The three facts home owns rather than the controller: the stasis set it
 * observed, and the two NET-WIDE engine clocks (`lastPhishingCacheTime`,
 * `lastStormTime`) that no ns member exposes. Both recovery builders stamp
 * them, so a replacement controller inherits home's newer view. */
function homeOverlay(): Partial<DnetRecoveryState> {
  return {
    stasisSnapshot: { hosts: [...home.stasisLinked].sort(), at: home.stasisObservedAt },
    ...(home.lastPhishCacheAt !== undefined ? { lastPhishCacheAt: home.lastPhishCacheAt } : {}),
    ...(home.lastStormAt !== undefined ? { lastStormAt: home.lastStormAt } : {}),
  };
}

function bootstrapRecovery(
  generation: string,
  capturedAt: number,
  vault: readonly VaultEntry[] = [],
): DnetRecoveryState {
  const knowledge = emptyKnowledge(generation);
  return {
    version: DNET_RECOVERY_VERSION,
    generation,
    capturedAt,
    knowledge,
    vault: [...vault],
    codes: {},
    karmaLoss: 0,
    profit: emptyDnetProfit(),
    ...homeOverlay(),
    unknownModels: {},
    agentHostsSeen: [],
    residentsLost: 0,
  };
}

function recoveryFromHome(generation: string, at: number): DnetRecoveryState {
  const recovery = home.recovery?.generation === generation
    && home.recovery.version === DNET_RECOVERY_VERSION
    ? home.recovery
    : bootstrapRecovery(generation, at,
      home.recovery?.generation === generation ? home.recovery.vault : []);
  return { ...recovery, ...homeOverlay() };
}

function record(action: string, ok: boolean, detail: string): void {
  home.lastResult = { action, ok, detail, at: Date.now() };
}

/** Where home persists private darknet progress across a save RELOAD.
 *
 * The vault and backdoor set are page-realm memory: a reload restarts every
 * script from nothing while the game keeps both underlying facts, so home
 * remembers what it legitimately cracked and reads it back on boot. `read` and
 * `write` are 0 GB. This is save-state recovery of our own work, NOT reading a
 * password out of game memory — that would skip the cracking challenge and is
 * deliberately not done anywhere.
 *
 * The file carries the GENERATION: a prestige mints a new net with new
 * passwords, so a mismatched file is ignored and the vault rebuilt. A reload
 * keeps the generation, and each credential is re-verified by `authenticate`
 * on use anyway. */
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

function persistDnetState(ns: NS, generation: string): void {
  const vault = home.recovery?.vault ?? [];
  // An empty vault must never overwrite a stored one. A generation mismatch
  // makes us IGNORE the stored file, not destroy it — and on a reload the
  // generation is unresolved until the progression topic lands, so writing
  // here would erase real credentials. The READ-side guard governs trust.
  if (vault.length === 0 && home.backdoored.size === 0) {
    return;
  }
  const serialized = serializePersistedDnetState(
    generation,
    vault,
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
 * belongs to THIS generation. `recoveryFromHome` seeds those names into the
 * replacement controller's bootstrap checkpoint. */
function loadPersistedDnetState(
  ns: NS,
  generation: string,
): { vault: VaultEntry[]; backdoors: PersistedBackdoorEntry[] } {
  let raw: string;
  try {
    raw = ns.read(DNET_VAULT_FILE);
  } catch {
    return { vault: [], backdoors: [] };
  }
  if (typeof raw !== "string" || raw.length === 0) return { vault: [], backdoors: [] };
  home.persistedState = raw;
  return parsePersistedDnetState(raw, generation);
}

/** Take what the darknet has learned, and hand it what only home can see.
 *
 * Every script the game runs shares one JS realm, so the controller's own object
 * IS reachable from here. That is not a shortcut past a game rule: what
 * preserves BN15's challenge is enforced by the engine — sessions are per-PID,
 * `probe()` is host-local, and the network kills your scripts.
 *
 * Four rules keep the handover honest:
 *
 * - `snapshot()` is non-destructive, so repeated reads cannot double-count.
 * - The controller owns knowledge; home caches only the newest checkpoint and
 *   returns it when launching a replacement.
 * - The generation is checked here, because agents outlive controllers and a
 *   live script from a dead run describes a world this one no longer shares.
 * - Credentials stay inside the private checkpoint, never merged into a topic
 *   or sent. */
function snapshotDarknet(generation: string): boolean {
  const rendezvous = dnetRendezvous();
  if (!rendezvous) return false;
  if (rendezvous.generation !== generation) {
    // A controller from a world this run no longer shares. Its facts describe a
    // darknet that was destroyed by the prestige that ended it.
    return false;
  }
  let taken: DnetSnapshot;
  try {
    taken = rendezvous.snapshot(Date.now());
  } catch {
    return false;
  }
  const recovery = taken.recovery;
  home.recovery = recovery;
  if (recovery.stasisSnapshot !== undefined && recovery.stasisSnapshot.at > home.stasisObservedAt) {
    home.stasisObservedAt = recovery.stasisSnapshot.at;
    home.stasisLinked = new Set(recovery.stasisSnapshot.hosts);
  }
  for (const invalidation of recovery.backdoorInvalidations ?? []) {
    const installedAt = home.backdoored.get(invalidation.hostname);
    if (installedAt !== undefined && installedAt <= invalidation.at) {
      home.backdoored.delete(invalidation.hostname);
    }
  }
  if (recovery.lastPhishCacheAt !== undefined) {
    home.lastPhishCacheAt = Math.max(home.lastPhishCacheAt ?? 0, recovery.lastPhishCacheAt);
  }
  if (recovery.lastStormAt !== undefined) {
    home.lastStormAt = Math.max(home.lastStormAt ?? 0, recovery.lastStormAt);
  }
  home.agents.clear();
  for (const resident of taken.residents) {
    // The digest is a superset of the resident snapshot, so the record travels
    // whole rather than being re-listed and silently missing whatever counter
    // is added next. `alive` is recomputed from the beat window at publish.
    home.agents.set(resident.host, { ...resident, role: "resident", alive: true });
  }
  home.ram.clear();
  for (const { host, ...ram } of taken.ram) home.ram.set(host, ram);
  home.controllerBeatAt = taken.controllerBeatAt;
  return true;
}

/** The darknet controller, if one is running. Typed access to the realm slot the
 * agents install, so home never reaches into `globalThis` by hand. */
function dnetRendezvous(): ControllerHandle | undefined {
  return (globalThis as typeof globalThis & { dnet_controller?: ControllerHandle }).dnet_controller;
}

const dnet: FeatureDriver = {
  id: "dnet",
  // 5s — the feature-cadence floor. Feature drivers are awaited SERIALLY and
  // this one publishes up to 220 hosts and plans backdoors every pass, so a
  // sub-5s period would crowd the 200ms dispatcher (`features.test.ts` guards
  // against it). The period is pure first-paint latency: the map cannot appear
  // until home's next tick publishes it. Going lower is a job for an
  // event-driven wake, not a hotter poll.
  everyMs: 5_000,
  requires: "dnet",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.dnet;
    if (!topic) return;

    // The far net is learned ONLY from delivered reports. home's own probe can
    // see darkweb and nothing else, so without this the map stops at the first
    // hop. See spec/dnet.md.
    const now = Date.now();
    // The generation is the install epoch, so a delayed report is tied to the
    // world it was gathered in rather than merely to this process.
    const progression = ctx.state.topics.progression;
    const generation = `${progression?.bitNode ?? 0}:${progression?.lastAugReset ?? 0}`;
    if (home.recovery?.generation !== generation) {
      home = freshDnetHomeState();
      delete ctx.state.darknetContractListings;
      delete ctx.state.darknetContractHandledAt;
      ctx.state.contractQueue = ctx.state.contractQueue?.filter((contract) => contract.dnet === undefined);
      // A reload empties the vault; this reads back the passwords home cracked
      // before it, so a reloaded run skips re-cracking (immune/stasis hosts
      // especially, whose password never changes). Generation-guarded, so a
      // prestige loads nothing. Once per generation, before the controller's
      // bootstrap checkpoint is built.
      const loaded = loadPersistedDnetState(ctx.ns, generation);
      home.recovery = bootstrapRecovery(generation, now, loaded.vault);
      for (const entry of loaded.backdoors) home.backdoored.set(entry.hostname, entry.installedAt);
      if (loaded.vault.length > 0 || loaded.backdoors.length > 0) {
        record(
          "dnet-restore",
          true,
          `restored ${loaded.vault.length} credential(s) and ${loaded.backdoors.length} backdoor(s) from the last reload`,
        );
      }
    }
    const topicIsCurrent = topic.knowledge === undefined || topic.knowledge.generation === generation;
    snapshotDarknet(generation);
    // The direct probe is an external observation. A snapshot may be older by
    // one feature turn, so re-apply the stamped fact after replacing the cache;
    // `configure` below then hands the newer observation to the sole mutator.
    if (topicIsCurrent && topic.stasisLinked !== undefined && topic.stasisObservedAt !== undefined
      && topic.stasisObservedAt > home.stasisObservedAt) {
      home.stasisObservedAt = topic.stasisObservedAt;
      home.stasisLinked = new Set(topic.stasisLinked);
    }
    const recovery = home.recovery!;
    const knowledge = recovery.knowledge;
    const rendezvous = dnetRendezvous();
    const bitNode = progression?.bitNode ?? 1;
    // All eight lab servers are constructed with the net itself, so ONE
    // sighting pins the net's depth exactly, long before it is reachable. That
    // matters twice: the mutation clock is `30_000 / netDepth`, so without a
    // sighting every staleness expiry below runs on `DEFAULT_NET_DEPTH`, and
    // the map cannot draw rows we have not reached without knowing how many
    // there are. Carried over from the topic between sightings — it changes
    // only when a lab is completed.
    const netDepth = netDepthFromLabs([...knowledge.hosts.keys()]) ?? (topicIsCurrent ? topic.netDepth : undefined);
    const expiry: ExpiryOpts = {
      bitNode,
      backdoored: home.backdoored.size,
      ...(netDepth !== undefined ? { netDepth } : {}),
      // The authoritative snapshot plus any newer controller pin/release
      // events, reconciled by observation time above.
      stasisLinked: new Set(home.stasisLinked),
    };
    syncDarknetContracts(ctx.state, knowledge, now, expiry);
    // The writer compares exact JSON first, so unchanged five-second ticks
    // perform no file write; credential and backdoor changes do.
    persistDnetState(ctx.ns, generation);
    for (const [hostname, agent] of [...home.agents]) {
      const host = knowledge.hosts.get(hostname);
      if (host === undefined || now - agent.lastBeatAt > DNET_PROCESS_STALE_MS) home.agents.delete(hostname);
    }
    // Same rule for the volatile RAM samples: a churning net would otherwise
    // accumulate one per hostname that ever existed, for the whole install.
    for (const hostname of [...home.ram.keys()]) {
      const host = knowledge.hosts.get(hostname);
      if (host === undefined) home.ram.delete(hostname);
    }
    const cover = knowledgeCoverage(knowledge, now, expiry);
    // From the FOLD, for the same reason `topologyComplete` is: `probe()` is
    // HOST-LOCAL, so home's own probe sees `darkweb` and nothing else and this
    // could never be anything but darkweb's own depth of -1.
    const deepest = [...knowledge.hosts.values()].reduce((found, host) => {
      const depth = fresh<number>(host, "depth", now, {
        ...expiry,
        immune: isImmune(host, { stasisLinked: expiry.stasisLinked }),
      });
      return depth !== undefined && depth > found ? depth : found;
    }, -1);
    // Also a property of the FOLD: true once every host we know about has a
    // neighbour list we still believe, which is the condition `reachableFrom`
    // needs to be an exact answer rather than a partial graph presented as one.
    const topologyComplete = cover.known > 0 && cover.adjacencyKnown === cover.known;
    // --- the labyrinth cache, and the one rule that governs it --------------
    //
    // `getLabReward` calls `Player.queueAugmentation` directly, and the generic
    // augmentation price multiplier is `1.9 ^ (queued non-SoA)` charged against
    // every purchase after it. The labyrinth six are not SoA-exempt, so opening
    // a cache mid-shopping-trip multiplies the rest of the cycle's bill by 1.9x
    // and silently invalidates the drainOrder/drainCeiling
    // `shared/strategy/factions/` froze. So it is held until the cycle's last
    // purchase.
    //
    // `progression` raises an INSTALL BLOCKER off `openable`, so every term is
    // something we have OBSERVED: the cache file exists, AND the host is
    // online, AND a live resident stands on it. Anything else publishes nothing
    // and the install proceeds unchanged.
    let labCache: { host: string; filename: string; openable: boolean } | undefined;
    for (const host of knowledge.hosts.values()) {
      if (!isLabyrinth(host.hostname, fresh<string>(host, "modelId", now, expiry))) continue;
      const files = fresh<string[]>(host, "caches", now, expiry) ?? [];
      const filename = [...files].sort()[0];
      if (filename === undefined) continue;
      const resident = home.agents.get(host.hostname);
      labCache = {
        host: host.hostname,
        filename,
        openable: resident !== undefined
          && now - resident.lastBeatAt < DNET_PROCESS_STALE_MS,
      };
      break;
    }
    // Work in flight, summed from each LIVE resident's last report: a dead
    // one's queue died with it, so its pending jobs no longer exist.
    const liveResidents = [...home.agents.values()].filter((agent) => now - agent.lastBeatAt < DNET_PROCESS_STALE_MS);
    const activeByKind: Record<string, number> = {};
    for (const agent of liveResidents) {
      if (agent.active !== undefined) activeByKind[agent.active] = (activeByKind[agent.active] ?? 0) + 1;
    }
    set(ctx.state, "dnet", {
      ...(topicIsCurrent && topic.stasisLinkLimit !== undefined
        ? { stasisLinkLimit: topic.stasisLinkLimit }
        : {}),
      ...(topicIsCurrent && topic.instability !== undefined ? { instability: topic.instability } : {}),
      coverage: cover,
      codes: { ...recovery.codes },
      // Every planner's refusals travel beside the response codes, and for the
      // same reason: "what did the planner decline, and by what name" is the
      // one question the panel exists to answer. The phishing window rides the
      // farm block because that is where its reader is, and only the stamp
      // travels — the interval is a constant and the countdown is arithmetic.
      ...(recovery.spread ? { spread: recovery.spread } : {}),
      ...(recovery.farm
        ? {
          farm: {
            ...recovery.farm,
            ...(home.lastPhishCacheAt !== undefined ? { lastPhishCacheAt: home.lastPhishCacheAt } : {}),
          },
        }
        : {}),
      ...(recovery.hold || home.backdoorReport
        ? {
          hold: {
            ...(recovery.hold ?? { admitted: {}, refused: {}, examples: [] }),
            ...(home.backdoorReport ? { backdoors: home.backdoorReport } : {}),
          },
        }
        : {}),
      // Which gate is holding fire IS the answer to "why has the storm not
      // fired". Home's stamp and the controller checkpoint reconcile by time.
      ...(recovery.storm
        ? {
          storm: {
            ...recovery.storm,
            ...(home.lastStormAt !== undefined ? { firedAt: home.lastStormAt } : {}),
          },
        }
        : {}),
      ...(recovery.karmaLoss !== 0 ? { karmaLoss: recovery.karmaLoss } : {}),
      ...(hasDnetProfit(recovery.profit) ? { profit: recovery.profit } : {}),
      ...(recovery.grammar ? { grammar: recovery.grammar } : {}),
      ...(labCache ? { labCache } : {}),
      // THE MAZE: the one part of the lab the panel cannot derive from the
      // hostname. Absent until a walk has learned something.
      ...(recovery.lab ? { lab: recovery.lab } : {}),
      // THE MAP, and the only host representation the topic carries.
      knowledge: publishKnowledge(knowledge, now, {
        bitNode,
        // The digest's staleness must run on the same depth as the tick above,
        // or panel and driver disagree about what is still believable.
        ...(netDepth !== undefined ? { netDepth } : {}),
        stasisLinked: expiry.stasisLinked,
        vault: new Set(recovery.vault.map((entry) => entry.hostname)),
        unknownModels: recovery.unknownModels,
        // Published by HOST, because that is what the map draws a badge on. The
        // freshest agent on a host wins, so a host with a live worker never
        // reads as abandoned because a dead one shares it. Only "alive" while
        // the beat is recent: an unexpiring roster would report a full crew on
        // a net that has lost every one of them.
        agents: Object.fromEntries(
          [...home.agents.values()]
            .sort((a, b) => a.lastBeatAt - b.lastBeatAt)
            .map(({ host, ...digest }) => [
              host,
              { ...digest, alive: now - digest.lastBeatAt < DNET_PROCESS_STALE_MS },
            ]),
        ),
        ram: home.ram,
        agentsLost: recovery.residentsLost,
        agentsSeenEver: Math.max(recovery.agentHostsSeen.length, home.agents.size),
        controller: {
          host: "darkweb",
          lastBeatAt: home.controllerBeatAt,
          alive: now - home.controllerBeatAt < DNET_PROCESS_STALE_MS,
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
      // max-reachable-under-a-budget problem and needs the whole graph.
      servers: [...knowledge.hosts.values()].map((host) => {
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
          requiredCharisma: fresh<number>(host, "requiredCharisma", now, expiry) ?? 0,
          stasisLinked: expiry.stasisLinked?.has(host.hostname) === true,
          // Every host still in the fold is one the last report saw present: an
          // absent host is DELETED from knowledge rather than marked down.
          isOnline: true,
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
        // Two sources, one channel: `stepDarknet` prices the next host from the
        // map, the maze walker reports what the ENGINE refused it. The higher
        // of the two is the one that unblocks anything.
        ...(Math.max(decision.charismaNeeded ?? 0, recovery.charismaNeeded ?? 0) > 0
          ? { charismaNeeded: Math.max(decision.charismaNeeded ?? 0, recovery.charismaNeeded ?? 0) }
          : {}),
        ...(home.lastResult ? { lastResult: home.lastResult } : {}),
      },
    });

    // --- the beachhead ------------------------------------------------------
    //
    // Everything above observes; this is the only part that ACTS, and it does
    // one thing: put a controller on `darkweb` and let it run the net from
    // there. home cannot play this feature itself — `probe()` is host-local, so
    // from here the darknet is one host wide — and it cannot hold a session
    // either, because a session belongs to the PID that won it and home's
    // `main.js` is launched with a 3.2 GB allocation.
    //
    // `exec` evaluates its direct-connection requirement BEFORE the darkweb
    // early-out, so only the host holding the TOR edge can place a process on
    // `darkweb`; a launcher anywhere else scps happily and then gets a silent
    // 0. The seed runs in the driver, which IS home's `main.js`, so the exec
    // is issued from the one `ns` that can issue it. (`scp` is distance-free
    // and never needed the pin.)
    const buildId = gameBuildId();
    const retiringBuild = rendezvous !== undefined && rendezvous.buildId !== buildId;
    if (retiringBuild) {
      rendezvous.standDown();
    }
    const controllerAlive = !retiringBuild && now - home.controllerBeatAt < DNET_PROCESS_STALE_MS;
    // Home plants darkweb's prober beside its controller; after that the net
    // plants itself: an agent that opens a neighbour scp's the payloads across
    // and execs the pair there. The prober is the only half home tops up — the
    // controller dispatches darkweb's own agents itself, per order.
    const darkwebEntry = rendezvous?.hosts.get("darkweb");
    const proberAlive = (darkwebEntry?.prober?.pid ?? 0) > 0;
    // NOT gated on the darknet probe. `darkweb` is a guaranteed constant once
    // dnet access is granted, which `requires: "dnet"` already establishes —
    // and the probe never confirmed the thing that gates `exec` anyway, home's
    // TOR edge. The seed's own `scp`+`exec` IS the reachability test, failing
    // into `seedNextAt`'s backoff where home has no TOR yet. So the seed is
    // attempted on the FIRST tick, and the probe enriches the map rather than
    // gating the boot.
    if (!retiringBuild && (!controllerAlive || !proberAlive) && now >= home.seedNextAt) {
      const controllerFile = "dnet/controller.js";
      const agentFile = "dnet/agent.js";
      const proberFile = "dnet/prober.js";
      const charisma = ctx.state.topics.player?.skills.charisma ?? 1;
      const wantController = !controllerAlive;
      const wantProber = !proberAlive;

      // `handoffLaunch` must have the pid in the same turn it publishes the
      // descriptor, and a proxied call is a promise — so `exec` runs on home's
      // own `ns` (already the bundle's, already paid, already the TOR edge) and
      // only `scp`, which the bundle does not own, goes through the proxy.
      const seedBeachhead = async (): Promise<SeedOutcome> => {
        // Every payload in ONE scp. `exec` of a file that is not there returns
        // 0, indistinguishable from "the host is full" — the same trap
        // game/lib/net.ts documents for the payload sweep — so no payload may
        // ever arrive without the others beside it.
        if (!await ctx.nspLong("scp", [controllerFile, agentFile, proberFile], "darkweb", "home")) {
          return { controller: 0, prober: 0, reason: "scp refused" };
        }
        // The controller holds the accumulated map, so a live one is left
        // strictly alone: restarting it to fix a smaller problem would throw
        // that map away.
        const controller = wantController
          ? await handoffLaunch<DnetControllerLaunch>(
            {
              kind: "dnet-controller",
              host: "darkweb",
              buildId,
              generation,
              identity: gameGlobal.artifactIdentity,
              charisma,
              recovery: recoveryFromHome(generation, now),
            },
            (launchId) => ctx.ns.exec(
              controllerFile,
              "darkweb",
              temporaryRunOptions({ threads: 1, ramOverride: CONTROLLER_GB }),
              launchId,
            ),
          )
          : -1;
        if (controller === 0) {
          return { controller, prober: 0, reason: "exec refused (darkweb full, or not synced)" };
        }
        const activeController = dnetRendezvous();
        // The controller registers its rendezvous when its own `main` first
        // runs, a later engine tick than the `exec` above. Without a rendezvous
        // there is no probe barrier to claim, so the prober belongs to the NEXT
        // pass — not to a failed seed whose backoff would hold darkweb empty
        // for the whole 30 s window.
        if (wantProber && activeController === undefined) {
          return { controller, prober: 0, pending: true, reason: "controller has not registered yet" };
        }
        const claim = wantProber ? await activeController?.beginProbeRefresh("darkweb") : undefined;
        const prober = !wantProber
          ? -1
          : activeController === undefined || claim === undefined
            ? 0
            : claim.launch
              ? await handoffLaunch<DnetProberLaunch>(
                { kind: "dnet-prober", host: "darkweb", refresh: claim.refresh },
                (launchId) => ctx.ns.exec(
                  proberFile,
                  "darkweb",
                  temporaryRunOptions({ threads: 1, ramOverride: PROBER_GB }),
                  launchId,
                ),
              )
              : -1;
        if (prober === 0 && claim !== undefined) activeController?.cancelProbeRefresh("darkweb", claim.refresh);
        const refreshed = claim === undefined ? !wantProber : prober !== 0 && await claim.refresh.refreshed !== undefined;
        if (!refreshed) {
          return { controller, prober, reason: "no room on darkweb for its prober" };
        }
        return { controller, prober, reason: "" };
      };
      // Nothing wraps the errand, so the seed owns its own failure reporting —
      // a ScriptDeath is still the controller dying and must propagate.
      let seeded: SeedOutcome;
      try {
        seeded = await seedBeachhead();
      } catch (error) {
        if (isScriptDeath(error)) throw error;
        seeded = { controller: 0, prober: 0, reason: String(error).slice(0, 200) };
      }
      // Not an attempt and not a failure: the half that could not run this pass
      // was waiting on a controller THIS pass started. Retry on the next driver
      // tick with the backoff untouched.
      const seedPending = seeded.pending === true;
      if (seedPending) {
        home.seedNextAt = now;
      } else {
        home.seedAttempts++;
        if (seeded.controller !== 0 && seeded.prober !== 0) {
          record(
            "seed",
            true,
            `controller ${seeded.controller === -1 ? "kept" : `pid ${seeded.controller}`}, prober ${seeded.prober === -1 ? "kept" : `pid ${seeded.prober}`}`,
          );
          home.seedBackoffMs = DNET_SEED_BACKOFF_MS;
        } else {
          record("seed", false, seeded.reason);
          // Exponential backoff. Without it, a world where the seed can never work
          // — not synced, no room, a node without access — re-execs on every tick
          // for ever, and the failure is loud in exactly the way that trains people
          // to ignore it.
          home.seedBackoffMs = Math.min(home.seedBackoffMs * 2, DNET_SEED_MAX_BACKOFF_MS);
        }
        home.seedNextAt = now + home.seedBackoffMs;
      }
    }

    // Tell the controller what only home can see. It cannot afford `getPlayer`
    // (0.5 GB out of 1.65), and it needs charisma to know which hosts a job may
    // heartbleed at all. The vault is replayed with it so a restarted controller
    // does not re-crack a net we already opened.
    // The one darknet action home performs itself, and it performs it because
    // it is the only thing that can: a backdoor is installed on the TERMINAL's
    // current server. It keeps two sacrificial backdoors on the worst fully
    // harvested RAM hosts, so most passes it decides to do nothing and says why.
    await serveDarknetBackdoors(ctx, knowledge, {
      now,
      expiry,
      netDepth,
      bitNode,
      charisma: ctx.state.topics.player?.skills.charisma ?? 1,
      instability: (topicIsCurrent ? topic.instability?.authenticationDurationMultiplier : undefined) ?? 1,
    });

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

    const player = ctx.state.topics.player;
    const authMultiplier = topicIsCurrent ? topic.instability?.authenticationDurationMultiplier : undefined;
    const timing = player !== undefined
      && progression !== undefined
      && authMultiplier !== undefined
      && Number.isFinite(player.skills.charisma)
      && Number.isFinite(player.skills.intelligence)
      ? {
          charisma: player.skills.charisma,
          intelligence: player.skills.intelligence,
          hasBoots: (progression.ownedAugs["The B00ts of Perseus"] ?? 0) > 0,
          sf15Level: progression.sourceFiles["15"] ?? 0,
          authenticationDurationMultiplier: authMultiplier,
        }
      : undefined;

    if (controllerAlive && rendezvous) {
      const fileInvalidations = Object.entries(ctx.state.darknetContractRefreshHosts ?? {})
        .map(([host, at]) => ({ host, at }));
      const rateMarket = slotRates(ctx.state, ctx.board);
      const measuredRate = (channel: string): number | undefined => {
        const value = rateMarket.best.get(channel);
        return value?.state === "measured" ? value.value : undefined;
      };
      const playerMults = ctx.state.topics.player?.mults;
      const farmEconomics = {
        ...(measuredRate(MONEY_CHANNEL) !== undefined ? { bestMoneyPerSec: measuredRate(MONEY_CHANNEL) } : {}),
        ...(measuredRate("charisma") !== undefined ? { bestCharismaExpPerSec: measuredRate("charisma") } : {}),
        moneyWorthSec: rateMarket.worth.get(MONEY_CHANNEL) ?? FARM_NOMINAL_CHANNEL_WORTH_SEC,
        charismaWorthSec: Math.max(
          FARM_NOMINAL_CHANNEL_WORTH_SEC,
          rateMarket.worth.get("charisma") ?? 0,
        ),
        charismaExpMult: playerMults?.charisma_exp ?? 1,
        crimeMoneyMult: playerMults?.crime_money ?? 1,
        dnetMoneyMult: playerMults?.dnet_money ?? 1,
        // The static table, not the observed topic. `progression.multipliers`
        // comes only from `ns.getBitNodeMultipliers`, which needs BN5/SF5, so
        // reading it raw silently prices darknet money at 1.0 in every node
        // without SF5 -- 2.5x too high in BN4 and BN3, 20x in BN9. Same call
        // career.ts uses; an observed getter result still wins field-by-field.
        nodeMoneyMult: effectiveBitNodeMultipliers(
          progression?.bitNode,
          progression?.sourceFiles["12"] ?? 0,
          progression?.multipliers,
        )?.["DarknetMoneyMultiplier"] ?? 1,
      };
      rendezvous.configure({
        charisma: ctx.state.topics.player?.skills.charisma ?? 1,
        ...(timing !== undefined ? { timing } : {}),
        // The clock the controller's expiries run on. Home pins the real depth
        // from a lab sighting and knows which node this is; without the order
        // the controller sits on the shared defaults for ever and re-observes
        // more than it needs to. Both conditional: the controller's own default
        // (BN15, depth 5) errs toward re-observing, and ordering the `?? 1`
        // guess would DOUBLE its expiries in a BN15 run whose progression topic
        // has not landed — the unsafe direction.
        ...(netDepth !== undefined ? { netDepth } : {}),
        ...(progression?.bitNode !== undefined ? { bitNode } : {}),
        // The one permission home grants the farm ladder, and it is granted only
        // while `progression` is actually holding an install open for it. The
        // controller refuses a labyrinth cache by name otherwise.
        openLabCache: progression?.plan?.installBlockers?.includes("dnet-lab-cache") === true,
        // Backdoors carry their observation times, so the controller can count
        // only the still-believable ones and may reuse a session remotely just
        // until the restart/delete clock expires.
        backdoors: [...home.backdoored].map(([hostname, installedAt]) => ({ hostname, installedAt })),
        // Complete snapshot: an empty list retires stale promotion work.
        promoteSymbols,
        // A term in both phishing chances, and only home can see the player.
        ...(ctx.state.topics.player?.mults.crime_success !== undefined
          ? { crimeSuccessMult: ctx.state.topics.player.mults.crime_success }
          : {}),
        farmEconomics,
        ...(fileInvalidations.length > 0 ? { fileInvalidations } : {}),
        // The controller PLANS stasis — only it knows which hosts hold live
        // residents — and it ACTS, because `setStasisLink` pins the calling
        // host. But it cannot see how many links exist or which hosts already
        // hold one, so the limit and the set come from here. The limit is
        // `1 + TheBrokenWings + TheHammer + TheStaff`, read by the priced probe.
        ...(topicIsCurrent && topic.stasisLinkLimit !== undefined ? { stasisLimit: topic.stasisLinkLimit } : {}),
        stasisSnapshot: {
          hosts: [...home.stasisLinked].sort(),
          at: home.stasisObservedAt,
        },
        // Whether a labyrinth can exist at all: `getCurrentLabName` is gated on
        // FULL access (BN15 or SF15), so a program-only run gets the 5-deep net
        // and no lab is ever generated. Only home can see the bitNode and the
        // source files. Sent only once progression has landed — the controller's
        // default is true, the conservative side.
        ...(progression !== undefined
          ? { labExpected: progression.bitNode === 15 || (progression.sourceFiles["15"] ?? 0) > 0 }
          : {}),
      });
      if (fileInvalidations.length > 0) {
        for (const { host, at } of fileInvalidations) {
          if (ctx.state.darknetContractRefreshHosts?.[host] === at) {
            delete ctx.state.darknetContractRefreshHosts[host];
          }
        }
      }
    }
  },
};

/** The terminal route from home to a darknet host, or nothing.
 *
 * `connect` walks `serversOnNetwork` one hop at a time and darknet edges ARE on
 * it, so the walk is possible. What is not possible is finding it the way the
 * hacking backdoor does: `scan` omits darknet servers, so its BFS sees
 * `darkweb` and stops. The graph has to come from the fold.
 *
 * Every hop is walked over a neighbour list we still BELIEVE (the `fresh`
 * call): a stale hop is not a slower route, it is a route that strands the
 * terminal deep in the net while it rearranges. Adjacency is the shortest-lived
 * fact we hold, so this refuses far more often than it succeeds. */
export function darknetRoute(
  knowledge: DnetKnowledge,
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
    const host = knowledge.hosts.get(current);
    if (!host) continue;
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
  knowledge: DnetKnowledge,
  { now, expiry, netDepth, bitNode, charisma, instability }: {
    now: number;
    expiry: ExpiryOpts;
    netDepth: number | undefined;
    bitNode: number;
    charisma: number;
    instability: number;
  },
): Promise<void> {
  const vault = new Set((home.recovery?.vault ?? []).map((entry) => entry.hostname));
  const protectedHosts = new Set(
    (home.recovery?.lab?.walkers ?? []).map((walker) => walker.from),
  );
  const hosts: HoldHost[] = [...knowledge.hosts.values()].map((host) => {
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
        agentAlive: (home.agents.get(host.hostname)?.lastBeatAt ?? 0) > now - DNET_PROCESS_STALE_MS,
        hasCredential: vault.has(host.hostname),
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
  // THE BELIEF EXPIRES, exactly as every other darknet fact does: a backdoored
  // host carries a ~9%/tick restart, and a restart CLEARS the backdoor. Expiry
  // drops the belief when restart/deletion should have invalidated it, and the
  // removal is persisted before another slot can be filled.
  const backdoorLife = msPerHostEventAny(
    ["restarted", "deleted"],
    netDepth ?? DEFAULT_NET_DEPTH,
    bitNode,
    home.backdoored.size,
  );
  let backdoorsChanged = false;
  for (const [hostname, installedAt] of [...home.backdoored]) {
    const host = knowledge.hosts.get(hostname);
    if (!host || now - installedAt > backdoorLife) {
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
    // The whole walk runs on the LONG resident: a hop-by-hop route plus an
    // `installBackdoor` that can take minutes, and Bitburner allows one
    // Netscript call per script at a time — on `nsp` it would hold every other
    // read in the automation behind it. Unpinned, because the terminal is
    // global state and `connect` acts on it from wherever it is called.
    //
    // Home first, always: some other errand may have left the terminal
    // anywhere, and the first hop is measured from wherever we are.
    if (!await ctx.nspLong("singularity.connect", "home")) {
      throw new Error("could not return the terminal to home");
    }
    for (const hop of route) {
      if (!await ctx.nspLong("singularity.connect", hop)) {
        throw new Error(`route to ${target} failed at ${hop}`);
      }
    }
    await ctx.nspLong("singularity.installBackdoor");
    // Back to home rather than left deep in the net: a terminal parked on a
    // darknet server pins that host `isImmutable` by accident, and every other
    // terminal-using errand would start from wherever this one stopped.
    await ctx.nspLong("singularity.connect", "home");
    home.backdoored.set(target, Date.now());
    persistDnetState(ctx.ns, knowledge.generation);
    record("backdoor", true, `${target} backdoored, ${route.length} hops out`);
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    home.backdoorNextAt = now + DNET_BACKDOOR_BACKOFF_MS;
    record("backdoor", false, String(error).slice(0, 200));
  } finally {
    home.backdoorInFlight = false;
  }
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

/** Whether the lab-cache deferral may hold the install this pass.
 *
 * Two halves, because the clock starts when the BLOCKER is raised rather than
 * when the cache appears: this one answers before `stepProgression` runs, and
 * `dnetLabCacheClock` stamps after it, having seen whether the blocker was
 * actually raised. `progression` calls both each refresh — the deferral gates
 * ITS install — but the SINCE stamp is darknet state: `dnetModule.reset`
 * clears it with everything else the feature derived from the world it is
 * leaving. */
export function dnetLabCacheDeferral(labCacheOpen: boolean, now: number): boolean {
  return labCacheOpen && labCacheWindowOpen(home.labCacheSince, now);
}

/** Advance the deferral clock with the decision's own answer. */
export function dnetLabCacheClock(labCacheOpen: boolean, raised: boolean, now: number): void {
  home.labCacheSince = advanceLabCacheDeferral(
    home.labCacheSince,
    { openable: labCacheOpen, raised },
    now,
  );
}

export const dnetModule: FeatureModule = {
  driver: dnet,
  reset: (state) => {
    // Module state as well as the topic: a BitNode reset destroys the darknet
    // outright, so the fold, the backdoors, the stasis links and the vault all
    // describe a world that no longer exists.
    home = freshDnetHomeState();
    // `prestigeDarknetState` restamps both engine clocks, so an install starts
    // with the phishing window SHUT and no storm seed mintable for thirty
    // minutes. Leaving these undefined would tell the next controller the
    // opposite, and it would grind for rolls that cannot pay.
    home.lastPhishCacheAt = Date.now();
    home.lastStormAt = Date.now();
    delete state.darknetContractListings;
    delete state.darknetContractHandledAt;
    delete state.darknetContractRefreshHosts;
    state.contractQueue = state.contractQueue?.filter((contract) => contract.dnet === undefined);
    delete state.topics.dnet;
  },
  needs: dnetNeeds,
};

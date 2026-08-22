import type { NS } from "@ns";
import { stepDarknet } from "../../../shared/strategy/dnet/decide.ts";
import { holdHostFrom, planBackdoors, type HoldHost } from "../../../shared/strategy/dnet/hold.ts";
import type { AttemptOutcome, ReportHost } from "../../../shared/strategy/dnet/courier.ts";
import { overseerArgs, residentArgs } from "../../../shared/strategy/dnet/mission.ts";
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
  foldAttempts,
  foldReports,
  fresh,
  isImmune,
  type DarknetKnowledge,
  type ExpiryOpts,
} from "../../../shared/strategy/dnet/knowledge.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { labCacheDeferral } from "../../../shared/strategy/progression/decide.ts";
import type { DarknetAgentDigest } from "../../../shared/telemetry/topics/dnet.ts";
import { versionedScript } from "../../../shared/deployment.ts";
import {
  CONTROLLER_METHODS,
  RESIDENT_METHODS,
  foldRefusals,
  priceAgent,
  residentLastLife,
  type DnetRendezvous,
  type DnetSpreadReport,
  type DnetFarmReport,
  type DnetListenReport,
  type DnetHoldReport,
} from "../../dnet/realm.ts";
import { gameBuildId } from "../build-id.ts";
import { gameGlobal } from "../globals.ts";
import { isScriptDeath } from "../errors.ts";
import { merge, type GameState } from "../state.ts";
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
  /** The last bleed-gate verdict, on the same snapshot discipline as the two
   *  above. */
  listen: DnetListenReport | undefined;
  /** The last hold derivation: the pin, the push and the walk. */
  hold: DnetHoldReport | undefined;
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
  /** When the lab-cache install deferral was first raised, so it can EXPIRE.
   *
   * The asymmetry is the point and it is stated here because this is the field
   * that enforces it: missing the deferral costs one augmentation's price
   * scaling, once. Blocking an install costs the whole cycle. */
  labCacheSince: number | undefined;
  /** Credentials agents recovered, keyed by host.
   *
   * MODULE STATE AND NOTHING ELSE. It is never merged into a topic and never
   * sent: the telemetry rule permits holding state we do not send, and forbids
   * the reverse. What the panel gets is the boolean `credentialKnown` per host.
   *
   * Held here rather than only out in the darknet because an overseer dies with
   * its host, and re-cracking a net we already opened would be the most
   * expensive possible way to recover from a reboot. */
  vault: Map<string, string>;
  /** Darknet hosts HOME has backdoored, keyed to when each was installed.
   *
   *  Home's own record rather than an observed fact, for the same reason the
   *  stasis set is the overseer's: `singularity.installBackdoor` acts on the
   *  terminal's current server, so home is the only thing in the run that can
   *  install one — and `ns.getServer().backdoorInstalled` is 2 GB home does not
   *  spend on a host it already knows about. A restart clears the backdoor
   *  (~9%/tick on a backdoored host), so the set is trimmed whenever the host is
   *  seen to have gone and re-earned otherwise. */
  backdoored: Map<string, number>;
  /** The backoff that keeps a structurally impossible backdoor from relaunching
   *  a stub every pass. */
  backdoorNextAt: number;
  backdoorInFlight: boolean;
  /** What the backdoor policy last decided, published beside the other planners'
   *  refusals: `planBackdoors` spends only the FREE allowance, so "why not" is
   *  its usual answer and the only interesting one. */
  backdoorReport:
    | { install: string[]; refused: Record<string, number>; examples: { host: string; why: string; detail: string }[] }
    | undefined;
  /** The overseer's own stasis set, as drained. Unioned with the dodged probe's
   *  reading, because the two see it at different cadences and a pinned host that
   *  reads as perishable costs a survey a minute for ever. */
  stasisLinked: Set<string>;
  /** The highest charisma a JOB said it needed. Today only the maze walker
   *  reports one, and it is folded into the career need `stepDarknet` already
   *  posts rather than into a second channel. */
  charismaNeeded: number | undefined;
  /** Model ids the game produced that `shared/strategy/dnet/models.ts` does not
   * know. Counted rather than ignored: a non-empty tally is a game update or a
   * hole in our transcription, and both are things to hear about. */
  unknownModels: Record<string, number>;
  /** Agent hosts seen this generation, and how many stopped reporting. The gap
   * between them is agent mortality — see spec/dnet.md's Observability note. */
  agentsSeen: Set<string>;
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
    listen: undefined,
    hold: undefined,
    karmaLoss: 0,
    grammar: undefined,
    lastPhishCacheAt: undefined,
    labCacheSince: undefined,
    vault: new Map(),
    backdoored: new Map(),
    backdoorNextAt: 0,
    backdoorInFlight: false,
    backdoorReport: undefined,
    stasisLinked: new Set(),
    charismaNeeded: undefined,
    unknownModels: {},
    agentsSeen: new Set(),
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
  residents: string[];
  drained: number;
  rejected: number;
  credentials: number;
} {
  const rendezvous = dnetRendezvous();
  if (!rendezvous) return { hosts: [], attempts: [], residents: [], drained: 0, rejected: 0, credentials: 0 };
  if (rendezvous.generation !== generation) {
    // An overseer from a world this run no longer shares. Its facts describe a
    // darknet that was destroyed by the prestige that ended it.
    return { hosts: [], attempts: [], residents: [], drained: 0, rejected: 1, credentials: 0 };
  }
  const taken = rendezvous.drain();
  for (const entry of taken.credentials) {
    if (entry.hostname.length > 0) home.vault.set(entry.hostname, entry.password);
  }
  for (const [code, count] of Object.entries(taken.codes)) {
    home.codes[code] = (home.codes[code] ?? 0) + Number(count);
  }
  if (taken.spread) home.spread = taken.spread;
  if (taken.farm) home.farm = taken.farm;
  if (taken.listen) home.listen = taken.listen;
  if (taken.hold) home.hold = taken.hold;
  for (const hostname of taken.stasisLinked ?? []) home.stasisLinked.add(hostname);
  if (taken.charismaNeeded !== undefined) {
    home.charismaNeeded = Math.max(home.charismaNeeded ?? 0, taken.charismaNeeded);
  }
  // ACCUMULATED, not assigned: `drain()` hands over the karma spent since the
  // last drain and clears it, exactly as it does with `codes`. An overseer
  // dies with its host out here, and assigning a re-seeded overseer's
  // since-boot total would reset home's tally to zero for the rest of the run.
  if (taken.karmaLoss !== undefined) home.karmaLoss += taken.karmaLoss;
  if (taken.grammar) home.grammar = taken.grammar;
  if (taken.lastPhishCacheAt !== undefined) {
    home.lastPhishCacheAt = Math.max(home.lastPhishCacheAt ?? 0, taken.lastPhishCacheAt);
  }
  for (const resident of taken.residents) {
    // Every field of the drained resident IS a digest field — the digest is a
    // superset — so the record travels whole rather than being re-listed and
    // silently missing whatever counter is added next. `alive` is recomputed
    // from the beat window at publish time.
    home.agents.set(resident.host, { ...resident, role: "resident", alive: true });
  }
  home.overseerBeatAt = Math.max(home.overseerBeatAt, rendezvous.lastBeatAt);
  home.residentsLost += taken.residentsLost;
  return {
    // Straight through: a `ReportHost` already carries the timestamp of the job
    // that saw it, which is the only thing the fold needs.
    hosts: taken.hosts,
    attempts: taken.attempts,
    residents: taken.residents.map((resident) => resident.host),
    drained: taken.hosts.length,
    rejected: 0,
    credentials: taken.credentials.length,
  };
}

/** The darknet overseer, if one is running. Typed access to the realm slot the
 * agents install, so home never reaches into `globalThis` by hand. */
function dnetRendezvous(): DnetRendezvous | undefined {
  return (globalThis as typeof globalThis & { dnet_overseer?: DnetRendezvous }).dnet_overseer;
}

const dnet: FeatureDriver = {
  id: "dnet",
  everyMs: 30_000,
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
      home.knowledge = emptyKnowledge(generation);
      home.codes = {};
    }
    const knowledge = home.knowledge;
    const {
      hosts: reported,
      attempts: reportedAttempts,
      residents,
      drained,
      rejected,
      credentials: vaultDrained,
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
    const netDepth = netDepthFromLabs(Object.keys(knowledge.hosts)) ?? topic.netDepth;
    const expiry: ExpiryOpts = {
      bitNode,
      ...(netDepth !== undefined ? { netDepth } : {}),
      // Both sources, because they see the set at different cadences: the
      // dodged probe reads `getStasisLinkedServers` when it happens to run, and
      // the overseer knows every link it spent the moment it spent one.
      stasisLinked: new Set([...(topic.stasisLinked ?? []), ...home.stasisLinked]),
    };
    // Home's own probe is folded as one more vantage rather than kept beside the
    // map in a second shape. It is the only source for `darkweb` until a resident
    // is standing out there, and it costs nothing to merge.
    const folded = foldReports(knowledge, [...(topic.probed ?? []), ...reported], now, expiry);
    home.knowledge = folded.knowledge;
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
    // A host we hold a credential for is flagged on the knowledge record so the
    // fold can drop the flag when the host disappears — the credential itself
    // stays in the vault and out of everything that is published.
    for (const hostname of home.vault.keys()) {
      const host = home.knowledge.hosts[hostname];
      if (host && host.goneAt === undefined) host.credentialKnown = true;
    }
    // A vault entry for a host that has gone is dead weight: the host returns
    // cleaned, with a new password, so keeping it would hand a stale credential
    // to the next attempt and burn a call proving it wrong.
    for (const hostname of [...home.vault.keys()]) {
      const host = home.knowledge.hosts[hostname];
      if (!host || host.goneAt !== undefined) home.vault.delete(hostname);
    }
    // The hosts that actually reported, so `seenEver - live` is agent mortality
    // rather than a count of the one label a drain used to carry.
    for (const host of residents) home.agentsSeen.add(host);
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
    merge(ctx.state, "dnet", {
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
      ...(home.listen ? { listen: home.listen } : {}),
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
      ...(home.karmaLoss !== 0 ? { karmaLoss: home.karmaLoss } : {}),
      ...(home.grammar ? { grammar: home.grammar } : {}),
      ...(labCache ? { labCache } : {}),
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
        agentsLost: [...home.agents.values()].filter((agent) => now - agent.lastBeatAt >= OVERSEER_STALE_MS).length,
        agentsSeenEver: Math.max(home.agentsSeen.size, home.agents.size),
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
      stasisLinked: topic.stasisLinked ?? [],
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
    const overseerAlive = now - home.overseerBeatAt < OVERSEER_STALE_MS;
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
    const darkwebResident = rendezvous?.queues.get("darkweb");
    const residentAlive = darkwebResident !== undefined
      && now - residentLastLife(darkwebResident) < OVERSEER_STALE_MS;
    if ((!overseerAlive || !residentAlive) && now >= home.seedNextAt
      && (topic.probed ?? []).some((server) => server.hostname === "darkweb")) {
      const buildId = gameBuildId();
      const controllerFile = versionedScript("dnet/overseer.js", buildId);
      const agentFile = versionedScript("dnet/agent.js", buildId);
      // The agent carries its identity in ns.args rather than reading the realm,
      // so a resident planted by an overseer that has since died still knows
      // which run artifact its telemetry belongs to.
      const identity = JSON.stringify(gameGlobal.artifactIdentity ?? {});
      const charisma = ctx.state.topics.player?.skills.charisma ?? 1;
      const missionId = `dnet-${generation}-${Math.floor(now / 1000)}`;
      const controllerArgs = overseerArgs({ missionId, generation, identity, charisma, agentFile });
      const residentLaunchArgs = residentArgs({
        missionId,
        generation,
        identity,
        agentId: "resident-darkweb",
      });
      const wantController = !overseerAlive;

      // The same list the claim is priced from, so the reservation and the stub
      // can never be sized off different sets.
      const seeded = await featureDodgeOn(ctx, "dnet", "action:seed", DNET_SEED_METHODS, "home", (stubNs: NS) => {
        // Both payloads in ONE scp. `exec` of a file that is not there returns 0,
        // which is indistinguishable from "the host is full" — the same trap
        // game/lib/net.ts documents for the dodge stub — so the agent must never
        // arrive without the overseer beside it, or the other way round.
        if (!stubNs["scp"]([controllerFile, agentFile], "darkweb", "home")) {
          return { controller: 0, resident: 0, reason: "scp refused" };
        }
        // The overseer is the durable half and holds the accumulated map, so a
        // live one is left strictly alone: restarting it to fix a missing
        // resident would throw the map away to solve a smaller problem.
        const controller = wantController
          ? stubNs["exec"](
            controllerFile,
            "darkweb",
            { threads: 1, ramOverride: priceAgent(stubNs, CONTROLLER_METHODS) },
            ...controllerArgs,
          )
          : -1;
        if (controller === 0) {
          return { controller, resident: 0, reason: "exec refused (darkweb full, or not synced)" };
        }
        const resident = stubNs["exec"](
          agentFile,
          "darkweb",
          { threads: 1, ramOverride: priceAgent(stubNs, RESIDENT_METHODS) },
          ...residentLaunchArgs,
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
    // current server. Spends only the free allowance, so most passes it decides
    // to do nothing and says why.
    await serveDarknetBackdoors(
      ctx,
      home.knowledge,
      now,
      expiry,
      netDepth,
      bitNode,
      ctx.state.topics.player?.skills.charisma ?? 1,
      topic.instability?.authenticationDurationMultiplier ?? 1,
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
      .map((entry) => entry.sym);

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
        // The backdoor COUNT is a mutation rate: a backdoored host carries a
        // ~9%/tick restart and a ~4%/tick delete on top of the ordinary
        // branches, so every knowledge expiry out there is shorter once we hold
        // any. The stasis LIMIT is `1 + TheBrokenWings + TheHammer + TheStaff`,
        // read by the dodged probe. And the symbols are the market, which the
        // darknet cannot see at all.
        backdoored: home.backdoored.size,
        ...(promoteSymbols.length > 0 ? { promoteSymbols } : {}),
        // The net facts only the dodged probe can read. The overseer PLANS
        // stasis — it is the only thing that knows which hosts have live
        // residents and which are irreplaceable — and it ACTS, because
        // `setStasisLink` pins the calling host. But it cannot see how many
        // links exist or which hosts already hold one, so those come from here.
        ...(topic.stasisLinkLimit !== undefined ? { stasisLimit: topic.stasisLinkLimit } : {}),
        ...(topic.stasisLinked !== undefined ? { stasisLinked: topic.stasisLinked } : {}),

        ...(home.lastPhishCacheAt !== undefined ? { lastPhishCacheAt: home.lastPhishCacheAt } : {}),
        ...(home.vault.size > 0
          ? {
            vault: [...home.vault].map(([hostname, password]) => ({
              hostname,
              password,
              via: "cracked" as const,
              at: now,
            })),
          }
          : {}),
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
 * What it buys is remote `exec`: the reachability gate tests
 * `backdoorBypasses && backdoorInstalled` and nothing else, so a backdoored host
 * can be reached from anywhere rather than only from a neighbour. What it costs
 * is `1.07 ^ surplus` on EVERY authentication in the net past a free allowance
 * of `max(rootedMovable / 24, 2)` — which is why `planBackdoors` spends only the
 * allowance and why two are always free. */
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
  const hosts: HoldHost[] = Object.values(knowledge.hosts).map((host) => ({
    ...holdHostFrom(host, {
      at: now,
      expiry,
      agentAlive: (home.agents.get(host.hostname)?.lastBeatAt ?? 0) > now - OVERSEER_STALE_MS,
      hasCredential: home.vault.has(host.hostname),
      stasisLinked: home.stasisLinked.has(host.hostname),
    }),
    // A stasis link SETS `backdoorInstalled` (`effects.ts:234`), so a pinned
    // host already has one and is also outside the counted pool. Recording it
    // as backdoored is what stops us spending a four-second install on a host
    // that has been reachable all along.
    ...(home.backdoored.has(host.hostname) || home.stasisLinked.has(host.hostname) ? { backdoored: true } : {}),
  }));
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
  // (`restartServer` drops `backdoorInstalled`), and nothing home can afford
  // observes it: `ns.getServer` is 2 GB and no darknet server detail reports
  // one. So the install is a stamped fact checked against the mutation clock —
  // and holding it past its life is the expensive direction twice over, because
  // it both suppresses the re-install and inflates the instability count the
  // overseer runs its expiries on.
  const backdoorLife = msPerHostEventAny(
    ["restarted", "deleted"],
    netDepth ?? DEFAULT_NET_DEPTH,
    bitNode,
    home.backdoored.size,
  );
  for (const [hostname, installedAt] of [...home.backdoored]) {
    const host = knowledge.hosts[hostname];
    if (!host || host.goneAt !== undefined || now - installedAt > backdoorLife) {
      home.backdoored.delete(hostname);
    }
  }
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
  if (!(state.topics.dnet?.probed ?? []).some((server) => server.hostname === "darkweb")) return false;
  const now = Date.now();
  // Either the overseer is gone, or darkweb has no resident to run anything.
  if (now - home.overseerBeatAt >= OVERSEER_STALE_MS) return true;
  const resident = dnetRendezvous()?.queues.get("darkweb");
  return resident === undefined || now - resident.lastBeatAt >= OVERSEER_STALE_MS;
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

/** Darknet feature — BN15's theme (new in game v3.0.0). Problem: traverse the
 * darknet graph by depth, spending stasis links and charisma to keep servers
 * authenticated while instability rises. A routing/budget problem with a
 * decaying resource. */

import type { ReportHost } from "../../strategy/dnet/courier.ts";

/** An agent we believe is alive out there. */
export interface DarknetAgentDigest {
  /** "overseer" is the controller; "resident" is the one agent a host keeps. */
  role: "overseer" | "resident";
  lastBeatAt: number;
  alive: boolean;
}

/** One host as the map and the detail panel need it: the current best value of
 * every fact, when each was seen, and what we have tried against it.
 *
 * Deliberately NOT here: anything the panel can work out for itself. Age, expiry
 * class and staleness follow from the timestamps below plus the mutation clock;
 * a model's name, oracle and reason-untouched follow from `modelId`. `ui/`
 * derives both from the same shared modules the controller uses. */
export interface DarknetKnownHost {
  hostname: string;
  /** Assigned at construction and shown by the in-game map. Costs a 2 GB
   *  `ns.getServer`, so only an agent with room to spare reports it. */
  ip?: string;
  lastSeenAt: number;
  /** Set when an observation found it gone. Its identity facts are dropped with
   *  it, because a host that returns is a new host with a new password. */
  goneAt?: number;
  /** OMITTED when unknown. `-1` is darkweb's real depth, so it cannot double as
   *  "no idea" without putting the root of the net in the unplaced row. */
  depth?: number;
  isDarkweb?: boolean;
  neighbours?: string[];
  maxRam?: number;
  blockedRam?: number;
  usedRam?: number;
  /** What an agent could actually claim here. Not `max - blocked - used`:
   *  blocked RAM presents AS used upstream, so a naive subtraction
   *  double-counts. Computed once, centrally, in `knowledge.freeRam`. */
  freeRam?: number;
  requiredCharisma?: number;
  difficulty?: number;
  isStationary?: boolean;
  stasisLinked?: boolean;
  modelId?: string;
  passwordLength?: number;
  passwordFormat?: string;
  passwordHint?: string;
  data?: string;
  logTrafficInterval?: number;
  /** When each fact was OBSERVED, keyed by fact name — and nothing else.
   *
   *  Age, expiry class and staleness are all derivable from this plus the
   *  mutation clock, and the model's name, oracle and reason-untouched are a
   *  pure function of `modelId`, so `ui/` derives both rather than being sent
   *  ~120 fields per host per tick. What cannot be derived travels: this, and
   *  `freeRam` below. */
  facts: Record<string, number>;
  agent?: DarknetAgentDigest;
  attempt?: {
    modelId?: string;
    status: "unattempted" | "failed" | "solved" | "unknown-model";
    /** Ordered candidates ruled out so far. */
    tried: number;
    /** Deliberate failures spent to make an unsolved model's oracle appear. */
    probes: number;
    lastCode?: number;
    lastOracle?: string;
    lastAt?: number;
  };
  /** THAT we hold a credential, never the credential. This record is written to
   *  disk as JSONL; the password lives only in the driver's vault. */
  credentialKnown?: boolean;
  /** Decided once, controller-side, so the map and the table can never disagree
   *  about a host's status. */
  authState?: "session" | "authenticated" | "auth-required" | "no-connection" | "offline";
}

export interface DarknetKnowledgeDigest {
  at: number;
  generation: string;
  hosts: DarknetKnownHost[];
  truncated?: boolean;
  totalHosts?: number;
  gone: number;
  mutationsSeen?: number;
  /** Model ids the game produced and our transcription does not know. A
   *  non-empty value here is a game update or a hole in `models.ts`, and both
   *  are things to hear about rather than skip. */
  unknownModels?: Record<string, number>;
  /** `seenEver - live` is agent mortality, which spec/dnet.md names as the loss
   *  that actually matters out there: the transport does not drop data, hosts
   *  drop agents. */
  agents: { live: number; seenEver: number; lostSinceBoot: number };
  overseer?: { host: string; pid?: number; lastBeatAt: number; alive: boolean; seedAttempts: number };
  queue?: { pending: number; claimed: number; byKind: Record<string, number> };
}

export interface DarknetState {
  /** Script host from which the latest local probe was made. */
  observedFrom?: string;
  /** False until probes have collected neighbor lists from every graph node. */
  topologyComplete?: boolean;
  /** Currently the number of direct neighbors of observedFrom, not a graph-wide count. */
  reachable: number;
  /** -1 until a host of known depth has been seen. */
  maxDepth: number;
  stasisLinkLimit: number;
  stasisLinked: string[];
  instability: { authenticationDurationMultiplier: number; authenticationTimeoutChance: number };
  /** Home's own one-hop reading, in the SAME shape an agent reports.
   *
   *  Driver input, not a view: the tick folds it into knowledge as one more
   *  vantage and the panel reads `knowledge` only. It stays on the topic because
   *  the probe is a dodge stub running on some leased host, and the topic is the
   *  only way back. `probe()` is host-local, so from home this is `darkweb` and
   *  its neighbours — which is also exactly what the seed decision needs. */
  probed?: ReportHost[];
  /** Health of the agent report channel, per tick. `rejected` is a whole
   *  rendezvous refused for belonging to a run this world no longer shares —
   *  refused at the channel, because agents outlive controllers. */
  channel?: {
    drained: number;
    rejected: number;
    forgotten: number;
    /** Credentials the drain moved into home's vault. The COUNT travels; the
     *  credentials stay in module state and are never published. */
    vaultDrained?: number;
  };
  /** DarknetResponseCode counts, cumulative for the run, keyed by numeric code.
   *  A Record rather than a Map, because the wire is JSON. This is what makes a
   *  refusal attributable instead of a blank. */
  codes?: Record<string, number>;
  /** What we know versus what we still believe. `freshFraction` falling is the
   *  signal that the net is moving faster than we are learning it. */
  coverage?: {
    known: number;
    adjacencyKnown: number;
    freshFraction: number;
    gone: number;
    /** Hosts we hold a credential for. */
    cracked?: number;
    /** ...of which have believable room for an agent. The gap between the two
     *  is owner-blocked RAM, which is a different problem with a different fix. */
    plantable?: number;
  };
  /** The folded map, and the only host representation there is: home's own
   *  one-hop probe folds in here as another vantage rather than sitting beside
   *  it in a second shape. Absent only before the first probe has landed. */
  knowledge?: DarknetKnowledgeDigest;
  /** How deep the net goes, when we can tell.
   *
   *  `getNetDepth()` IS the current labyrinth's depth, so ONE sighting of any
   *  lab host pins it exactly — and every lab server is constructed at the same
   *  time as the net, so it is knowable long before it is reachable. Two things
   *  need it: the mutation clock (and therefore every staleness expiry) is
   *  `30_000 / netDepth`, and the map cannot draw the rows we have not reached
   *  without knowing how many there are.
   *
   *  Absent until a lab is seen, which is honest — the alternative is a default
   *  of 10 that reads as knowledge. */
  netDepth?: number;
  /** The net's own clock, so the panel can say how fast the map is rotting. */
  mutationIntervalMs?: number;
  /** Charisma, which gates heartbleed per host and slows authentication. */
  charisma?: number;
  plan?: DarknetPlan;
}

export interface DarknetPlan {
  action: { type: string; hostname?: string };
  ranked: { hostname: string; depth: number; unlocks: number }[];
  /** Charisma the traversal is blocked on, posted to the needs board. */
  charismaNeeded?: number;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}

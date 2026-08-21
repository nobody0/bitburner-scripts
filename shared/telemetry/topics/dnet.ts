/** Darknet feature — BN15's theme (new in game v3.0.0). Problem: traverse the
 * darknet graph by depth, spending stasis links and charisma to keep servers
 * authenticated while instability rises. A routing/budget problem with a
 * decaying resource. */

export interface DarknetServerDigest {
  hostname: string;
  /** -1 when the host has gone offline: getDepth's own sentinel. */
  depth: number;
  /** Absent for an offline host, whose details object is a dummy — a fabricated
   *  0 would read as "nothing blocked" rather than "not known". */
  blockedRam?: number;
  isOnline?: boolean;
  requiredCharisma?: number;
  stasisLinked?: boolean;
  /** Usable RAM is maxRam - blockedRam, and that is what decides whether an
   *  agent can run here at all. Absent when the host vanished mid-probe. */
  maxRam?: number;
  usedRam?: number;
  /** The discovery surface, straight from getServerDetails. `modelId` selects
   *  the host's password minigame; the 24 models are transcribed in
   *  spec/strategy/bitnodes/bn15.md. */
  modelId?: string;
  passwordLength?: number;
  passwordFormat?: string;
  passwordHint?: string;
  data?: string;
  logTrafficInterval?: number;
  difficulty?: number;
  isStationary?: boolean;
  /** Whether THIS process holds a session — per-PID, so it is only ever true
   *  for the observer that reports it. */
  hasSession?: boolean;
  directlyConnected?: boolean;
}

/** Where one fact came from and how long it stays believable.
 *
 * This is spec/dnet.md's provenance rule made visible. A bare value would be a
 * claim about a world that mutates every three seconds; the panel needs to show
 * the value AND how much to trust it, which means the age travels with it. */
export interface DarknetFactMeta {
  /** When it was OBSERVED, not when it arrived. */
  at: number;
  from: "self" | "agent";
  /** The host that observed it, when an agent did. */
  via?: string;
  ageMs: number;
  /** `null` for the identity class, which never expires by age. JSON cannot
   *  carry the Infinity that `expiryMs` returns, and `null` reads correctly as
   *  "not by age" where a 0 or a missing field would read as "expired". */
  expiresInMs: number | null;
  stale: boolean;
  class: "identity" | "position" | "topology" | "resource";
}

/** An agent we believe is alive out there. */
export interface DarknetAgentDigest {
  /** "overseer" is the controller; "resident" is the one agent a host keeps. */
  role: "overseer" | "resident";
  lastBeatAt: number;
  alive: boolean;
}

/** One host as the map and the detail panel need it: the current best value of
 * every fact, the provenance of each, and what we have tried against it. */
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
  /** The registry's account of this host's password model: what its oracle is,
   *  and — when we have not attacked it — exactly why not. Carried here so the
   *  panel states a reason instead of leaving a blank where one belongs. */
  modelName?: string;
  modelFamily?: string;
  modelFeedback?: string;
  modelOracle?: string;
  modelVia?: string;
  modelBlocked?: string;
  /** Per-fact provenance and staleness, keyed by fact name. */
  facts: Record<string, DarknetFactMeta>;
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
  servers: DarknetServerDigest[];
  /** Health of the agent report channel. `drained` and `rejected` are per tick;
   *  `fromDeadRuns` counts reports discarded because they were gathered in a
   *  world this run no longer shares. */
  channel?: {
    drained: number;
    rejected: number;
    fromDeadRuns: number;
    forgotten: number;
    /** Credential messages drained off the vault port. The count travels; the
     *  credentials never do. */
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
  /** The whole folded map, with provenance. Absent until an agent has reported;
   *  the flat `servers` above remains home's own one-hop view. */
  knowledge?: DarknetKnowledgeDigest;
  /** The net's own clock, so the panel can say how fast the map is rotting. */
  netDepth?: number;
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

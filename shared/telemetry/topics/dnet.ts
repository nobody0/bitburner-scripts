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
  };
  plan?: DarknetPlan;
}

export interface DarknetPlan {
  action: { type: string; hostname?: string };
  ranked: { hostname: string; depth: number; unlocks: number }[];
  /** Charisma the traversal is blocked on, posted to the needs board. */
  charismaNeeded?: number;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}

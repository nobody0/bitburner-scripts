import type { TaskKind } from "../../strategy/dnet/jobs.ts";

export interface DarknetResidentRam {
  jobGb: number;
  proberGb: number;
  controllerGb: number;
}

export function dnetRamGb(ram: DarknetResidentRam): number {
  return ram.jobGb + ram.proberGb + ram.controllerGb;
}

/** Darknet feature — BN15's theme (new in game v3.0.0). Problem: traverse the
 * darknet graph by depth, spending stasis links and charisma to keep servers
 * authenticated while instability rises. A routing/budget problem with a
 * decaying resource. */

/** An agent we believe is alive out there. */
export interface DarknetAgentDigest {
  role: "resident";
  lastBeatAt: number;
  alive: boolean;
  /** Jobs waiting in this host's queue. */
  pending?: number;
  /** The job the agent has spawned into, by kind, if any. */
  active?: TaskKind;
  /** Targets of the active job. Empty when no job is running. */
  targets: string[];
  /** Exact dnet-owned process allocation on this host. */
  ram: DarknetResidentRam;
  /** Capacity available to the next job after fixed controller/prober reserves. */
  freeGb?: number;
  /** Jobs finished and failed here since the controller booted. */
  completed?: number;
  failed?: number;
  /** Why the last one failed — out there failures are the normal case. */
  lastError?: string;
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
  lastSeenAt: number;
  /** OMITTED when unknown. `-1` is darkweb's real depth, so it cannot double as
   *  "no idea" without putting the root of the net in the unplaced row. */
  depth?: number;
  isDarkweb?: boolean;
  neighbours?: string[];
  maxRam?: number;
  blockedRam?: number;
  /** Total script capacity after the owner's durable RAM block. Runtime
   * occupancy belongs to the controller's live handles, not host knowledge. */
  usableRam?: number;
  /** A volatile, same-instant RAM sample. The engine's `ramUsed` includes the
   * owner's block, so `used` is player-script RAM after subtracting `blocked`.
   * The UI derives genuinely idle RAM as `total - blocked - used`. */
  ram?: {
    at: number;
    total: number;
    blocked: number;
    used: number;
  };
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
  /** Unopened `.cache` files sitting on this host, from `ns.ls`. A cache dies
   *  with its host, so this is the one published fact that is a standing offer
   *  with an expiry date attached to it. */
  caches?: string[];
  /** When each fact was OBSERVED, keyed by fact name — and nothing else.
   *
   *  Age, expiry class and staleness are all derivable from this plus the
   *  mutation clock, and the model's name, oracle and reason-untouched are a
   *  pure function of `modelId`, so `ui/` derives both rather than being sent
   *  ~120 fields per host per tick. What cannot be derived travels: this, and
   *  `usableRam` below. */
  facts: Record<string, number>;
  /** Groups invalidated after their last observation. */
  dirty?: Partial<Record<"position" | "topology" | "ram" | "files", true>>;
  agent?: DarknetAgentDigest;
  attempt?: {
    modelId?: string;
    status: "unattempted" | "failed" | "solved" | "unknown-model";
    /** Ordered candidates ruled out so far. */
    tried: number;
    /** Deliberate failures spent to make an unsolved model's oracle appear. */
    probes: number;
    lastCode?: number;
    lastAt?: number;
    /** A feedback solver is part-way through a conversation with this host.
     *  Its STATE is a credential and never travels; that it exists is not. */
    solving?: boolean;
    /** How far that conversation has got.
     *
     *  Two scalars, lifted out of the solver state by an explicit allow-list in
     *  `publish.ts` — never a spread of it. The state itself is redacted
     *  wholesale by `stripCredentials`, and that is not relaxed to carry these:
     *  they are published under a different name precisely so the redaction can
     *  stay absolute.
     *
     *  `budget` is absent because it is derivable: `Solver.budget(facts)` is a
     *  pure function of the password facts above. */
    solve?: { phase: string; spent: number };
  };
  /** THAT we hold a credential, never the credential. This record is written to
   *  disk as JSONL; the password lives only in the driver's vault. */
  credentialKnown?: boolean;
  /** Decided once, controller-side, so the map and the table can never disagree
   *  about a host's status. */
  authState?: "session" | "authenticated" | "auth-required" | "no-connection";
}

export interface DarknetKnowledgeDigest {
  at: number;
  generation: string;
  hosts: DarknetKnownHost[];
  truncated?: boolean;
  totalHosts?: number;
  mutationsSeen?: number;
  /** Model ids the game produced and our transcription does not know. A
   *  non-empty value here is a game update or a hole in `models.ts`, and both
   *  are things to hear about rather than skip. */
  unknownModels?: Record<string, number>;
  /** `seenEver - live` is agent mortality, which spec/dnet.md names as the loss
   *  that actually matters out there: the transport does not drop data, hosts
   *  drop agents. */
  agents: { live: number; seenEver: number; lostSinceBoot: number };
  /** Controller process health at the time this digest was published. */
  controller?: { host: string; pid?: number; lastBeatAt: number; alive: boolean; seedAttempts: number };
  /** Work in flight across every resident, summed from their last reports:
   *  jobs queued, jobs being run right now, and the running ones by kind. */
  queue?: { pending: number; active: number; byKind: Record<string, number> };
}

/** The one PID-bound walker in the maze.
 *
 * Its host receives the reserved stasis link because losing the PID loses the
 * position. */
export interface DarknetLabWalker {
  /** The vantage the walk RUNS on — never the lab, which is the target. */
  from: string;
  /** `"x,y"`, parsed from the engine's own message. Absent before the first
   *  response, because the position is unknowable until then. */
  at?: string;
  moves: number;
  /** Refused moves. The planner should never bump a wall after its blind first
   *  probe, so a climbing number here is our model disagreeing with the engine. */
  walls: number;
  radars: number;
  /** Authentications spent: moves, walls and radars all pay one. This is what
   *  the walk's PACE is measured in, and dividing it by the elapsed time gives
   *  the only honest ETA there is. */
  attempts: number;
  /** The planner's own A* estimate of the authentications still to come. */
  believedLeft?: number;
  startedAt: number;
  beatAt: number;
  /** Whether a mutation can take this walker's host out from under it. */
  pinned: boolean;
}

export interface DarknetLabDigest {
  host: string;
  /** The PRODUCED maze size. Never the size `labData` asks for: `generateMaze`
   *  stitches four sub-mazes and rounds each up to odd, so a 60x40 request is a
   *  61x41 maze. */
  width: number;
  height: number;
  /** The discovered maze, one character per grid cell in row-major order:
   *  `?` unknown, `#` wall, `.` open. `width * height` characters — 2501 for the
   *  largest rung, which is why it can travel every tick where the `slots`
   *  record it is built from could not. */
  grid: string;
  /** Exit candidates not yet disproved. The exit is `[w-2-ox, h-2-oy]` with each
   *  offset 0, 2 or 4 on the deep rungs, so this starts at nine there and one on
   *  the shallow rungs, and shrinks as radars and arrivals rule them out. */
  candidates: string[];
  /** True once a radar showed the exit or eliminated everything else. */
  exitKnown: boolean;
  walkers: DarknetLabWalker[];
}

/** Since-install observed returns. Promotion is activity, not attributable P&L. */
export interface DarknetProfit {
  phishAttempts: number;
  phishSuccesses: number;
  /** Cash parsed at the display precision returned in the API message. */
  phishCash: number;
  phishCachesCreated: number;
  /** A won cache can disappear with its host before opening. */
  phishCachesOpened: number;
  cachesOpened: number;
  /** Cash parsed at the display precision returned in the API message. */
  cacheCash: number;
  cacheShares: number;
  /** Exact post-open file observations. */
  cacheContractsCreated: number;
  cacheDataFilesRead: number;
  cacheDataFilesParsed: number;
  /** Compact labels keep log text off the wire. */
  cacheRewards: Record<string, number>;
  promotionAttempts: number;
  promotionBatches: number;
  promotionThreads: number;
  /** Successful batches by symbol. */
  promotionSymbols: Record<string, number>;
}

export interface DarknetState {
  /** Script host from which the latest local probe was made. */
  observedFrom?: string;
  /** False until probes have collected neighbor lists from every graph node. */
  topologyComplete?: boolean;
  /** -1 until a host of known depth has been seen, so the panel renders NONE
   *  rather than a row that sorts above the root. */
  maxDepth: number;
  /** The three below are the only darknet facts HOME reads directly, and the
   *  only ones it must: each is a 0 GB call the controller cannot afford, so the
   *  DIRECT probe `dnet.facts` reads them inline (no dodge) and ships them over
   *  the controller-input path. The driver tick publishes `knowledge` without them, so
   *  a panel that guarded on `knowledge` and then read these threw on the first
   *  tick before the direct probe landed; they stay optional for that reason,
   *  and the driver has always read its own copy that way (`remaining.ts`,
   *  `stasisLinked ?? []`). Everything darkweb-specific home used to read here
   *  is gone: darkweb's prober observes it on the mutation clock and
   *  includes the result in its snapshot, so the darknet has exactly one prober. */
  stasisLinkLimit?: number;
  stasisLinked?: string[];
  /** Observation time of the authoritative direct stasis snapshot. */
  stasisObservedAt?: number;
  instability?: { authenticationDurationMultiplier: number; authenticationTimeoutChance: number };
  /** DarknetResponseCode counts, cumulative for the run, keyed by numeric code.
   *  A Record rather than a Map, because the wire is JSON. This is what makes a
   *  refusal attributable instead of a blank. */
  codes?: Record<string, number>;
  /** Why the net is not growing, from the controller's last spread derivation.
   *
   *  Beside `codes` on purpose: both answer "what refused, and by what name",
   *  one for the game's responses and one for our own planner. `planSpread`
   *  produced these from the day it was written and nothing rendered them, so a
   *  net that had stopped spreading looked identical to one with nowhere left
   *  to go. */
  spread?: {
    planted: number;
    refused: Record<string, number>;
    examples: { host: string; why: string; detail: string }[];
    /** Why each still-empty host was not planted, by hostname. The counts
     *  above answer "what is holding the net back"; this answers "why is THAT
     *  box empty", which is the question the map itself raises. */
    why?: Record<string, string>;
  };
  /** Current derivation, including refusals needed to explain ladder fallthrough. */
  farm?: {
    admitted: Record<string, number>;
    refused: Record<string, number>;
    examples: { host: string; why: string; detail: string }[];
    /** When a `.d.cache` was last seen to land, so a reader can count the
     *  net-wide phishing window down.
     *
     *  NOT derivable: the cooldown is engine state
     *  (`DarknetState.lastPhishingCacheTime`) that no ns member exposes, so our
     *  own sightings are the only evidence there is. The interval itself
     *  (`PHISH_CACHE_COOLDOWN_MS`) is a constant in `rates.ts`, so only the
     *  stamp travels. */
    lastPhishCacheAt?: number;
    /** Resident pinned to the net-wide cache roll. */
    cacheHunter?: string;
    expectedMoneyPerSec: number;
    expectedCharismaExpPerSec: number;
  };
  /** How far our log parser has drifted from the game's grammar.
   *
   *  SHAPES, never lines, and the distinction is a credential one rather than a
   *  tidiness one: an unrecognised line is by definition one `oracle.ts` failed
   *  to read, and three of the noise generator's branches write a plaintext
   *  password into a log line — so publishing examples would publish exactly the
   *  passwords we missed. `logShape` collapses every digit and letter run,
   *  leaving the punctuation and the structure.
   *
   *  A rising count is the same class of event as `unknownModels`: a game update,
   *  or a hole in our transcription, and both are things to hear about. */
  grammar?: { unrecognised: number; shapes: Record<string, number> };
  /** The three DELIBERATE decisions, and the fourth one home makes itself.
   *
   *  `spread` and `farm` above are things a host does as a matter
   *  of course. These four are not: a stasis link is one of at most four in a
   *  whole run, an ordinary backdoor makes its host a restart/delete victim
   *  (and a third taxes global authentication), an induced migration can cost
   *  the host outright, and a maze
   *  walk occupies a resident for hours. So every one of them is expected to
   *  refuse most of the time, and the refusal is the interesting half.
   *
   *  `backdoors` is nested rather than merged because it is decided somewhere
   *  else entirely: `singularity.installBackdoor` acts on the terminal's
   *  current server, so the route is walked from home and the controller never
   *  sees it. */
  hold?: {
    admitted: Record<string, number>;
    refused: Record<string, number>;
    examples: { host: string; why: string; detail: string }[];
    backdoors?: {
      install: string[];
      refused: Record<string, number>;
      examples: { host: string; why: string; detail: string }[];
    };
  };
  /** The storm trigger: where the seed stands and which gate is holding fire.
   *
   *  The refusal names ARE the status display — "phish-window-open" with every
   *  other gate green means the storm fires behind the next `.d.cache`. The
   *  timing constants (`STORM_QUIET_MS`, `STORM_COOLDOWN_MS`) live in
   *  `rates.ts`; only the stamps travel, exactly as with the phishing window. */
  storm?: {
    /** Fires the last derivation admitted: 0 or 1. */
    admitted: number;
    refused: Record<string, number>;
    examples: { host: string; why: string; detail: string }[];
    /** The freshest believed `STORM_SEED.exe` holder, when there is one. */
    seedHost?: string;
    seedSeenAt?: number;
    /** Our own stamp of the last fire — the engine's `lastStormTime` is module
     *  state no ns member exposes, so this is the only clock there is for both
     *  the quiet period and the 30-minute seed-eligibility window. */
    firedAt?: number;
    /** Whether the farm is grinding blocks for seed rolls right now. */
    seedHunt?: boolean;
  };
  /** Karma spent opening caches this run, summed and NEGATIVE.
   *
   *  Karma only ever moves down and it survives an install, so a cache is free
   *  progress toward the gang's -54000 rather than a cost. Published for `gang`
   *  to read rather than left in a log line. */
  karmaLoss?: number;
  /** Direct cash plus non-cash rewards and promotion activity this install. */
  profit?: DarknetProfit;
  /** The labyrinth cache, and whether it can be opened RIGHT NOW.
   *
   *  It is the one cache that is deferred: `getLabReward` queues an
   *  augmentation directly, and the generic price multiplier is
   *  `1.9 ^ (queued non-SoA)`, charged against everything bought after it. So it
   *  waits for the last purchase of an install cycle. `openable` is deliberately
   *  a conjunction of things we have OBSERVED — the file exists, the host is up,
   *  a live resident is standing on it — because `progression` raises an install
   *  blocker off it, and a blocker raised for a cache we cannot reach would
   *  stall the whole cycle. Absent means "no deferral, install normally". */
  labCache?: { host: string; filename: string; openable: boolean };
  /** THE MAZE, as far as the walkers have got. Absent for every run that has
   *  not reached a labyrinth, which is most of them — the panel's ladder card
   *  stands on its own without it.
   *
   *  This is the one part of the darknet whose state the panel genuinely cannot
   *  derive. Everything else about a lab follows from the hostname:
   *  `labStage()` gives the rung, the charisma gate and the requested maze size,
   *  and `labPrior()` turns that into the produced dimensions, the seam
   *  positions, the door candidates and the nine exit candidates. What no
   *  formula can supply is what the walkers have actually SEEN, so that — and
   *  only that — travels. */
  lab?: DarknetLabDigest;
  /** What we know versus what we still believe. `freshFraction` falling is the
   *  signal that the net is moving faster than we are learning it. */
  coverage?: {
    known: number;
    adjacencyKnown: number;
    freshFraction: number;
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
   *  Absent until a lab is seen, which is honest — the alternative is a
   *  fallback (`DEFAULT_NET_DEPTH`, 5) that reads as knowledge. */
  netDepth?: number;
  /** The net's own clock, so the panel can say how fast the map is rotting. */
  mutationIntervalMs?: number;
  /** Charisma, which gates heartbleed per host and slows authentication. */
  charisma?: number;
  plan?: DarknetPlan;
}

export interface DarknetPlan {
  /** Hosts ranked by how much of the graph a stasis link on them keeps alive.
   *
   *  There is no `action` here any more. The two it used to carry —
   *  `authenticate` and `stasis` — were unexecutable from home by construction,
   *  so the panel rendered a selected action beside a refusal explaining why it
   *  would not happen. See `shared/strategy/dnet/decide.ts`. */
  ranked: { hostname: string; depth: number; unlocks: number }[];
  /** Charisma the traversal is blocked on, posted to the needs board. */
  charismaNeeded?: number;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}

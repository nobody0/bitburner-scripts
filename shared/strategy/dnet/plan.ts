import {
  compareDepthDesc,
  planningView,
  type DnetHost,
  type DnetHosts,
  type ExpiryOpts,
} from "./host.ts";
import { modelEntry, planAttempt } from "./models.ts";
import { conclusiveAttempt } from "./courier.ts";
import { DNET_PRIORITY, choosePreemptionVantage } from "./priority.ts";
import { STORM_PHISH_OVERLAP_MS, STORM_QUIET_MS } from "./rates.ts";

/** What there is to do out there, and who is doing it.
 *
 * The controller does not keep a task list. It DERIVES one, and that is the
 * whole of the dedup.
 *
 * **The queue is DERIVED from the hosts map, never appended to.** There is no
 * "add task" call anywhere. `deriveTasks` looks at what we believe and emits
 * only the work that belief does not already cover: an attempt for a host whose
 * model has something left to try, plus work admitted by the spread, farm, hold
 * and storm planners. Adjacency and details are refreshed outside this planner
 * by permanent probers and the controller's mutation sweep.
 *
 * That is what makes dedup structural rather than bookkeeping. Nothing can
 * duplicate completed work because once its result lands the supporting state
 * changes and the task stops existing — no completion ledger to reconcile.
 *
 * ## The one thing derivation cannot see
 *
 * Structural dedup works because finishing the work makes the task stop
 * existing. That fails for work with no fact stamp — `attempt:<host>` is the
 * case — where the task re-derives every tick for the whole duration of a
 * multi-second `authenticate`. So the in-flight overlay is admitted here, and it
 * is deliberately as small as it can be: `host.busy` (kinds) plus
 * `inFlight (target -> {from, kind})`, DATA ONLY. The queued job's credential
 * stays in the game realm, because a pure function that held one would
 * eventually be asked to explain itself in a log line.
 *
 * ## Who applies freshness
 *
 * `deriveTasks` reads the RAW map and applies `planningView` itself — it is the
 * entry point that owns `now` and the expiry opts. The sub-planners below
 * (`planSpread`, `planStorm`, and `hold.ts`/`farm.ts`'s) take records that have
 * ALREADY been viewed: a field that is absent is unknown, exactly the contract
 * the old projections had. */

/** The four jobs that LEARN or SPREAD, the four that FARM, and the four
 * DELIBERATE ones.
 *
 * `cache`, `reclaim`, `phish` and `promote` are decided by
 * `shared/strategy/dnet/farm.ts`; `pin`, `induce` and `walk` by
 * `shared/strategy/dnet/hold.ts`; `storm` by `planStorm` below. All are merged
 * exactly as `plant` is merged from `planSpread`: the queue does not
 * second-guess a planner that has already named its refusals. */
export type TaskKind =
  | "inventory"
  | "bleed"
  | "attempt"
  | "plant"
  | "cache"
  | "reclaim"
  | "phish"
  | "promote"
  | "pin"
  | "induce"
  | "walk"
  | "storm"
  // Re-establish a host's dead prober with one local `exec`. Not derived from
  // the map like the others — the controller files it directly from prober
  // deaths, at max urgency, because the prober carries no self-revival.
  | "relaunchProbe";

export interface Task {
  id: string;
  kind: TaskKind;
  /** The target. */
  host: string;
  /** Where a process must be STANDING to do it. probe, authenticate and
   *  heartbleed all require a direct connection, so the vantage is part of the
   *  task rather than a detail of whoever runs it. */
  from: string;
  /** Every currently valid worker for late, cancellation-aware assignment. */
  eligibleFrom?: readonly string[];
  /** A plant may reuse a global rooted session without current adjacency. */
  remote?: boolean;
  /** Lower is more urgent. */
  priority: number;
  /** Why this task exists, in one line, for the panel and the failure line. */
  reason: string;
  /** Threads to run it at. Omitted means one. `ramOverride` is charged PER
   *  THREAD, so this multiplies the allocation rather than sharing it. */
  threads?: number;
  /** Plants only: launch the minimal spawn-free self reclaimer, not the normal
   * prober+resident pair. */
  bootstrapReclaim?: boolean;
  bootstrapThreads?: number;
  /** Plants only: the pinned lab candidate never shares RAM with a prober. */
  omitProber?: boolean;
  /** The `.cache` file a `cache` task opens. Nothing else carries one, and a
   *  job never invents a filename: `openCache` THROWS on a name the host does
   *  not hold, and a throw kills the agent rather than failing the job. */
  filename?: string;
  /** The symbol a `promote` task spreads propaganda about. */
  symbol?: string;
  /** Pins only: the neighbour the pin exists to keep. */
  edge?: string;
  /** Pins only: release the link instead of applying one. */
  unpin?: boolean;
  /** Which unattributed password an `attempt` task is spending, BY REFERENCE.
   *
   *  The password itself never enters this module. The controller matches a
   *  leaked line against the length and format facts it already holds and hands
   *  the result over as an opaque id; the id is what the job's `guess` is
   *  resolved from, back where credentials live. */
  guessId?: string;
}

export interface DeriveOptions {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  /** Hosts with a live agent, so work gets a valid vantage and spreading does
   *  not plant where someone is already standing. */
  agents?: ReadonlySet<string>;
  /** What a JOB would get on each agent host — the exact figure the
   *  controller's own fit check uses, so a vantage chosen here is one the job
   *  actually fits on. Omitted, every vantage reads as 0 GB and the ordering
   *  falls back to the name tie-break. */
  agentFreeGb?: ReadonlyMap<string, number>;
  /** What ONE THREAD of an attempt job costs. `authenticate`'s duration scales
   *  `1/(1 + 0.2*(threads-1))` with the calling script's threads, so when this
   *  is provided an attempt is sized to the RAM its vantage can spare. */
  attemptGbPerThread?: number;
  /** The same for a bleed job. */
  bleedGbPerThread?: number;
  /** Hosts we hold a credential for. */
  vault?: ReadonlySet<string>;
  /** Hosts admitted by `planSpread`, already filtered and ordered. */
  plantable?: readonly {
    host: string;
    from: string;
    remote?: boolean;
    bootstrapReclaim?: boolean;
    bootstrapThreads?: number;
    omitProber?: boolean;
  }[];
  /** Farm work admitted by `planFarm`, already laddered and thread-sized. */
  farm?: readonly {
    kind: "cache" | "reclaim" | "phish" | "promote";
    host: string;
    /** The vantage, when it is not the target: a remote reclaim's helper. */
    from?: string;
    threads: number;
    filename?: string;
    symbol?: string;
    reason: string;
  }[];
  /** The deliberate work `hold.ts`/`planStorm` admitted. Unlike the farm these
   *  are not self-host — an `induceServerMigration` REFUSES its own host — so
   *  each carries its own vantage. */
  hold?: readonly {
    kind: "pin" | "induce" | "walk" | "storm";
    host: string;
    from: string;
    threads?: number;
    reason: string;
    /** Pins only: the neighbour this pin exists to keep — the lab. */
    edge?: string;
    /** Pins only: release the link instead. */
    unpin?: boolean;
  }[];
  /** Unattributed passwords matched to hosts they could open, by reference. */
  guesses?: readonly { host: string; id: string; reason: string }[];
  /** How many deliberate probes an unsolved model may cost, per host. */
  probeLimit?: number;
  /** Our charisma, for the heartbleed gate: `heartbleed` refuses (451) below
   *  the host's `requiredCharisma`, and it is the only charisma-gated call.
   *  Omitted, nothing is gated: one refused call per host is how the
   *  requirement gets learned. */
  charisma?: number;
  /** Work a live process is already doing, keyed by TARGET. A `(kind, target)`
   *  pair in here emits no task. Data only, never a password. */
  inFlight?: ReadonlyMap<string, readonly { from: string; kind: TaskKind }[]>;
}

const FARM_PRIORITY: Readonly<Record<"cache" | "reclaim" | "phish" | "promote", number>> = {
  cache: DNET_PRIORITY["cache"],
  reclaim: DNET_PRIORITY["reclaim"],
  phish: DNET_PRIORITY["phish"],
  promote: DNET_PRIORITY["promote"],
};

/** Where the deliberate kinds sit. The walk goes first, above everything —
 * completing the labyrinth is the whole point of the darknet. The pin precedes
 * ordinary work; the storm sits below the pin STRUCTURALLY (a pending pin is a
 * reason not to fire yet); induce is a project of hundreds of calls whose value
 * arrives at the end, so it waits behind everything that opens the net. */
const HOLD_PRIORITY: Readonly<Record<"pin" | "induce" | "walk" | "storm", number>> = {
  walk: DNET_PRIORITY["walk"],
  pin: DNET_PRIORITY["pin"],
  storm: DNET_PRIORITY["storm"],
  induce: DNET_PRIORITY["induce"],
};

/** Placing a process is the scarcest thing we do — it is the only action that
 *  grows the set of places we can act FROM — so it outranks everything, the
 *  deliberate three included. */
export const PLANT_PRIORITY = DNET_PRIORITY["plant"];

/** The per-host offsets, all applied to `rank` (the negated depth). These are
 * BANDS rather than fine gradations: no host's bleed can reach into another
 * kind's band, because the ordering across kinds is a policy and the ordering
 * within one is a detail. */
const GUESS_BONUS = -5;
const ORACLE_SOLVE_SURCHARGE = 10;
const PROBE_SURCHARGE = 50;
const BLEED_BAND = 10;
/** A failed read is operational, not evidence that the ring is empty. Retry
 * eventually, without tying the backoff to passive traffic the API never
 * materialises. */
const BLEED_RETRY_MS = 10_000;

/** Every place a process could stand to reach `host`, best first.
 *
 * Ordered by the RAM a job would get there (`agentFreeGb`), most first, because
 * `authenticate`'s duration shrinks with the calling script's threads and
 * threads are bought with the vantage's free RAM — so the roomiest vantage is
 * the fastest crack. Self is a candidate like any other. Ties break BY NAME
 * rather than in `agents` iteration order, because that order is insertion
 * order and would make the derived queue depend on the sequence in which hosts
 * happened to be planted. An empty list is itself the answer: the host is a
 * rumour until someone stands next to it. */
function vantagesFor(
  host: DnetHost,
  views: ReadonlyMap<string, DnetHost>,
  opts: DeriveOptions,
): string[] {
  const agents = opts.agents ?? new Set<string>();
  const vantages: string[] = [];
  if (agents.has(host.hostname)) vantages.push(host.hostname);
  for (const agentHost of agents) {
    if (agentHost === host.hostname) continue;
    const standing = views.get(agentHost);
    if (standing?.neighbours?.includes(host.hostname)) vantages.push(agentHost);
  }
  const roomOn = (name: string): number => opts.agentFreeGb?.get(name) ?? 0;
  // Self wins RAM ties: it is already a session holder, and keeping it ahead of
  // an equal-RAM neighbour preserves the old ordering wherever RAM is unknown.
  const selfBias = (name: string): number => (name === host.hostname ? 1 : 0);
  vantages.sort((a, b) =>
    roomOn(b) - roomOn(a)
    || selfBias(b) - selfBias(a)
    || (a < b ? -1 : a > b ? 1 : 0));
  return vantages;
}

/** Everything worth doing, given what we believe right now.
 *
 * Deterministic and ordered, so two derivations of the same map produce the
 * same queue. */
export function deriveTasks(
  hosts: DnetHosts,
  now: number,
  opts: DeriveOptions = {},
): Task[] {
  const expiry: ExpiryOpts = { netDepth: opts.netDepth, bitNode: opts.bitNode, backdoored: opts.backdoored };
  const agents = opts.agents ?? new Set<string>();
  const vault = opts.vault ?? new Set<string>();
  const tasks: Task[] = [];
  /** Whether a live process is already doing this exact thing to this host. */
  const busy = (kind: TaskKind, host: string): boolean =>
    (opts.inFlight?.get(host) ?? []).some((claim) => claim.kind === kind);
  /** Freshness applied once per host; sub-reads are plain field reads. */
  const views = new Map<string, DnetHost>();
  for (const host of hosts.values()) views.set(host.hostname, planningView(host, now, expiry));
  const netHasUncrackedMovable = [...views.values()].some((candidate) =>
    candidate.goneAt === undefined
    && candidate.isStationary !== true
    && !vault.has(candidate.hostname));

  for (const host of views.values()) {
    if (host.goneAt !== undefined) continue;
    const vantages = vantagesFor(host, views, opts);
    if (vantages.length === 0) continue;
    const from = vantages[0]!;
    // Prefer a vantage not already occupied by another job on this target.
    const taken = new Set((opts.inFlight?.get(host.hostname) ?? []).map((entry) => entry.from));
    const free = vantages.filter((vantage) => !taken.has(vantage));

    // DEEPEST FIRST, matching `planSpread`: lower priority is more urgent, so
    // the ordering key is the NEGATED depth. A deep host is the scarce vantage —
    // the only place a still-deeper host can be reached from — and its facts
    // expire fastest, so it is the one worth spending the tick on first.
    //
    // A host whose depth we cannot place sorts after every host we can, which is
    // why the fallback is +1: with the sign flipped, a big constant would have
    // made the host we know least about the most urgent thing in the net.
    // `darkweb` at -1 lands there too, and belongs there — it is a shop, not a
    // vantage worth racing to.
    const rank = host.depth === undefined ? 1 : -host.depth;
    // The heartbleed gate. An UNKNOWN requirement passes: the refused call's own
    // describeHost report is what teaches us the number, so the first try is
    // the action's own report.
    const bleedable = opts.charisma === undefined
      || host.requiredCharisma === undefined
      || host.requiredCharisma <= opts.charisma;

    const ringBusy = busy("bleed", host.hostname) || busy("attempt", host.hostname);
    const ledger = host.attempts;
    const ring = host.ring;
    const retryDue = ring?.lastBleedAttemptAt === undefined
      || now - ring.lastBleedAttemptAt >= BLEED_RETRY_MS;
    const pendingBleed = (ring?.pendingAuthRecords ?? 0) > 0
      && bleedable && !ringBusy && retryDue;
    // A target with undrained authentication records is serialized: drain it
    // first, then let the next derivation resume its attempt from shared state.
    const workFrom = free[0] ?? from;
    // Threads for the two calls that scale with them — authenticate and
    // heartbleed — sized to what the chosen vantage can spare. Sized here
    // rather than in the controller because the vantage choice and the thread
    // count are the same decision: the roomiest vantage was picked FOR its
    // room. With no pricing observation, conservatively request one thread;
    // the controller's authoritative fit check still decides whether it can run.
    const attemptRoom = opts.agentFreeGb?.get(workFrom);
    const sized = (gbPerThread: number | undefined): number =>
      gbPerThread !== undefined && gbPerThread > 0 && attemptRoom !== undefined
        ? Math.max(1, Math.floor(attemptRoom / gbPerThread))
        : 1;
    const attemptThreads = sized(opts.attemptGbPerThread);
    const bleedThreads = sized(opts.bleedGbPerThread);
    // GUESS: an unattributed password whose length and format match this host.
    //
    // It goes FIRST and it suppresses the model attempt below, because the two
    // are the same call against the same host and this one is a single
    // `authenticate` with no penalty for being wrong. A solve that runs while a
    // free candidate is waiting has paid for information the candidate might
    // have made unnecessary.
    const candidates = (opts.guesses ?? []).filter((guess) => guess.host === host.hostname);
    const guessing = !pendingBleed && !ringBusy
      && candidates.length > 0
      && !vault.has(host.hostname)
      && !busy("attempt", host.hostname);
    if (guessing) {
      const guess = candidates[0]!;
      tasks.push({
        id: `guess:${host.hostname}:${guess.id}`,
        kind: "attempt",
        host: host.hostname,
        from: workFrom,
        eligibleFrom: free.length > 0 ? free : vantages,
        // Below every model attempt on the same host:
        // one call, no oracle, no charisma gate.
        priority: DNET_PRIORITY["attempt"] + rank + GUESS_BONUS,
        reason: guess.reason,
        ...(attemptThreads !== 1 ? { threads: attemptThreads } : {}),
        guessId: guess.id,
      });
    }

    let scheduledAttempt = guessing;
    // ATTEMPT: only for a host we cannot already open, and only while its model
    // has something left to try.
    if (!pendingBleed && !guessing && !ringBusy && !vault.has(host.hostname) && host.hostname !== "darkweb") {
      const entry = modelEntry(host.modelId);
      const attempt = planAttempt(
        entry,
        {
          ...(host.passwordLength !== undefined ? { passwordLength: host.passwordLength } : {}),
          ...(host.passwordFormat !== undefined ? { passwordFormat: host.passwordFormat } : {}),
          ...(host.passwordHint !== undefined ? { passwordHint: host.passwordHint } : {}),
          ...(host.data !== undefined ? { data: host.data } : {}),
          ...(host.difficulty !== undefined ? { difficulty: host.difficulty } : {}),
          ...(ledger?.evidence !== undefined ? { evidence: ledger.evidence } : {}),
        },
        ledger?.tried ?? 0,
        ledger?.probes ?? 0,
        opts.probeLimit ?? 1,
        ledger?.history?.filter(conclusiveAttempt)
          .map((outcome) => outcome.attempted)
          .filter((value): value is string => value !== undefined) ?? [],
      );
      // Anything whose whole payoff is the ORACLE is withheld below the host's
      // charisma requirement, because `heartbleed` is the only charisma-gated
      // call and without it the answer cannot be read. That covers a probe, and
      // it covers a solver that needs feedback — but NOT a dictionary candidate
      // or a closed-form solve, both of which report success through
      // `authenticate`'s own return value and so work at any charisma.
      const needsRing = attempt.kind === "probe" || (attempt.kind === "solve" && attempt.needsOracle);
      const withheld = needsRing && !bleedable;
      if (attempt.kind !== "none" && host.modelId !== undefined && !withheld) {
        // What the task is worth, cheapest-certain first. A dictionary hit or a
        // closed-form decode is one call away from a new vantage; a solve that
        // has to converse costs more but still opens the net; a probe only ever
        // buys information.
        const surcharge = attempt.kind === "candidate"
          ? 0
          : attempt.kind === "solve"
            ? (attempt.needsOracle ? ORACLE_SOLVE_SURCHARGE : 0)
            : PROBE_SURCHARGE;
        scheduledAttempt = true;
        tasks.push({
          id: `attempt:${host.hostname}`,
          kind: "attempt",
          host: host.hostname,
          from: workFrom,
          eligibleFrom: free.length > 0 ? free : vantages,
          priority: DNET_PRIORITY["attempt"] + rank + surcharge,
          reason: attempt.kind === "candidate"
            ? `${entry?.name ?? host.modelId} candidate ${attempt.index + 1}/${attempt.total}`
            : attempt.kind === "solve"
              ? `${entry?.name ?? host.modelId}: ${attempt.note} (up to ${attempt.budget} attempts)`
              : attempt.reason,
          ...(attemptThreads !== 1 ? { threads: attemptThreads } : {}),
        });
      }
    }

    // INITIAL BLEED: attempts consume their own records, so listening is only
    // admitted when no authentication job owns this target's shared ring.
    const initialRingUseful = !vault.has(host.hostname)
      || host.neighbours === undefined
      || host.neighbours.some((name) => !vault.has(name))
      || ledger?.solver !== undefined
      || netHasUncrackedMovable;
    // v3.0.1 heartbleed only drains the existing ring. It does NOT call
    // populateServerLogsWithNoise, and authenticate snapshots the old ring then
    // discards the noise its own population call generated. Therefore elapsed
    // logTrafficInterval time cannot create anything for Netscript to read.
    // Drain once per identity (retrying a refused call until one succeeds), and
    // thereafter only when an authentication record is known to be pending.
    const initialBleed = !pendingBleed && !scheduledAttempt && !ringBusy
      && bleedable && ring?.lastBleedAt === undefined && retryDue && initialRingUseful;
    const wantsBleed = pendingBleed || initialBleed;
    if (wantsBleed) {
      tasks.push({
        id: `bleed:${host.hostname}`,
        kind: "bleed",
        host: host.hostname,
        from: workFrom,
        eligibleFrom: free.length > 0 ? free : vantages,
        priority: DNET_PRIORITY["bleed"] + rank + BLEED_BAND,
        reason: pendingBleed
          ? `drain ${ring!.pendingAuthRecords} authentication log record(s)`
          : "drain this identity's initial log ring",
        ...(bleedThreads !== 1 ? { threads: bleedThreads } : {}),
      });
    }
  }

  // PLANT: whatever the spread planner already admitted. It has its own bounds
  // and its own refusals; the queue does not second-guess them.
  for (const entry of opts.plantable ?? []) {
    if (agents.has(entry.host) || busy("plant", entry.host)) continue;
    tasks.push({
      id: `plant:${entry.host}`,
      kind: "plant",
      host: entry.host,
      from: entry.from,
      ...(entry.remote ? { remote: true } : {}),
      ...(entry.bootstrapReclaim ? { bootstrapReclaim: true } : {}),
      ...(entry.bootstrapThreads !== undefined ? { bootstrapThreads: entry.bootstrapThreads } : {}),
      ...(entry.omitProber ? { omitProber: true } : {}),
      priority: PLANT_PRIORITY,
      reason: "a credential and room for an agent",
    });
  }

  // FARM: the leftovers, and they sort behind everything that learns, spreads
  // or opens the net. A host being farmed is a host with nothing better to do,
  // and the priorities say so — but the queue files in priority order, so a
  // plant derived while a phish is queued still goes in front of it.
  for (const entry of opts.farm ?? []) {
    if (busy(entry.kind, entry.host)) continue;
    tasks.push({
      id: `${entry.kind}:${entry.host}`,
      kind: entry.kind,
      host: entry.host,
      from: entry.from ?? entry.host,
      priority: FARM_PRIORITY[entry.kind],
      reason: entry.reason,
      ...(entry.threads !== 1 ? { threads: entry.threads } : {}),
      ...(entry.filename !== undefined ? { filename: entry.filename } : {}),
      ...(entry.symbol !== undefined ? { symbol: entry.symbol } : {}),
    });
  }

  // HOLD: the pin, the push, the walk and the storm. Same contract as the farm —
  // the planner named its refusals and this merely files what it admitted — but
  // each carries its own vantage, because `induceServerMigration` is the one
  // call in the feature that refuses the host it is running on.
  for (const entry of opts.hold ?? []) {
    // Pushes dedup on (kind, target, VANTAGE), while the single walk dedups by
    // target. An induce target may be charged by SEVERAL vantages — the migration
    // charge accumulates on the TARGET, so N pushers move it ~N× faster.
    // Every other hold kind keeps the plain per-target check.
    const perVantage = entry.kind === "induce";
    const alreadyPlanned = !perVantage && tasks.some((task) => task.kind === entry.kind && task.host === entry.host);
    const inFlight = perVantage
      ? (opts.inFlight?.get(entry.host) ?? []).some((claim) => claim.kind === entry.kind && claim.from === entry.from)
      : busy(entry.kind, entry.host) || alreadyPlanned;
    if (inFlight) continue;
    tasks.push({
      id: perVantage ? `${entry.kind}:${entry.host}:${entry.from}` : `${entry.kind}:${entry.host}`,
      kind: entry.kind,
      host: entry.host,
      from: entry.from,
      priority: HOLD_PRIORITY[entry.kind],
      reason: entry.reason,
      ...(entry.threads !== undefined && entry.threads !== 1 ? { threads: entry.threads } : {}),
      ...(entry.edge !== undefined ? { edge: entry.edge } : {}),
      ...(entry.unpin === true ? { unpin: true } : {}),
    });
  }

  tasks.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tasks;
}

// --- spread ------------------------------------------------------------------

/** Where to put the next agent, and why not everywhere else.
 *
 * Spreading is the whole point of the feature — BN15's own text asks for scripts
 * that are "self-sufficient and durable, and spread themselves to stay alive" —
 * so the policy is: **every neighbour we can reach gets an agent, at any depth,
 * unconditionally.** Nothing here is a budget any more.
 *
 * It used to carry three: a hop budget, a per-source fan-out and a global agent
 * cap. All three were guesses, and each one produced a refusal that could fire
 * on a host there was nothing wrong with. They are gone, and their refusal names
 * are gone with them rather than left as dead strings — a name that can never
 * fire teaches the panel reader that a limit exists.
 *
 * What survives is six GROUNDED refusals, each naming something about the host
 * itself, and `not-enough-ram` now does the real work. A planner that silently
 * skipped a host would make all six invisible at once, so every rule here
 * produces a NAMED REFUSAL rather than a skip, and the refusals are what the
 * panel shows when the net stops growing.
 *
 * Depth is not a bound. It is the ORDERING KEY: see `planSpread`.
 *
 * The mechanical ladder a plant executes, all in ONE process:
 *
 *     probe()                           -> my neighbours
 *     connectToSession(Y, password)     -> needs prior root; no connection
 *     authenticate(Y, password)         -> first opening needs a connection
 *     scp([payloads], Y, X)             -> needs the session, no connection
 *     exec(payload, Y, ...)             -> needs the session and either a
 *                                          connection or a backdoor
 *
 * An ordinary plant is still planned per adjacent (from, to) pair. A recovery
 * plant may instead use any live resident when a stamped backdoor or stasis fact
 * says remote exec remains believable. */

export interface SpreadCandidate {
  host: string;
  /** Where a worker would have to be STANDING to do this. */
  from: string;
  /** The target is not adjacent; this vantage reuses a global rooted session
   * through a still-believable backdoor or stasis link. */
  remote?: boolean;
  depth?: number;
  freeRam?: number;
  /** Fresh owner block. A cramped host with some runnable RAM gets a minimal
   * local reclaimer instead of waiting until a full resident+prober fits. */
  blockedRam?: number;
  /** Lab candidate: reclaim locally without a prober, then plant only a
   * resident. The walker subsequently takes the entire pinned host. */
  reclaimOnly?: boolean;
  omitProber?: boolean;
  bootstrapReclaim?: boolean;
  bootstrapThreads?: number;
  hasCredential: boolean;
  /** A live agent is already here. */
  agentAlive: boolean;
  lastPlantAt?: number;
  goneAt?: number;
}

export interface SpreadLimits {
  /** RAM the payload needs. The surveyor is the small one; a breaker needs more,
   *  and the caller picks which it is asking about. */
  agentRamGb: number;
  /** Resident alone, for the pinned lab candidate. */
  residentRamGb: number;
  /** One thread of the spawn-free local reclaim bootstrap. */
  bootstrapRamGb: number;
  /** How long after a plant a host is left alone. The one surviving limit that
   *  is not a fact about RAM, and it is not a budget either: a host that keeps
   *  coming back empty is RESTARTING, and re-planting it every derivation would
   *  spend the whole net's spare RAM on one flapping machine.
   *
   *  A minute is a little over ten mutation ticks at the default depth, so a
   *  host that survives one cooldown has survived long enough to be worth the
   *  2.6 GB. */
  plantCooldownMs: number;
}

export const DEFAULT_SPREAD_LIMITS: SpreadLimits = {
  agentRamGb: 5.4,
  residentRamGb: 3.6,
  bootstrapRamGb: 2.6,
  plantCooldownMs: 60_000,
};

/** Six reasons, and every one of them is a fact about the host in front of us.
 *
 * `too-deep`, `fan-out` and `agent-cap` were deleted rather than retired: they
 * were the three invented budgets, and a refusal name that can never fire is a
 * worse lie than no name at all — it tells the panel reader a limit is in force
 * when the code has stopped enforcing one. */
export type RefusalReason =
  | "gone"
  | "agent-alive"
  | "no-credential"
  | "not-enough-ram"
  | "unknown-ram"
  | "cooldown";

export interface Refusal {
  host: string;
  why: RefusalReason;
  detail: string;
}

export interface SpreadPlan {
  plant: SpreadCandidate[];
  refused: Refusal[];
}

/** Decide where agents go next: everywhere we can, deepest first.
 *
 * Order matters twice over, and neither is arbitrary.
 *
 * **The refusal order.** The cheapest and most certain refusals come first, so a
 * host that is simply gone is never reported as "not enough RAM" — a refusal
 * that sends someone looking at the wrong problem is worse than no refusal at
 * all.
 *
 * **The candidate order: DEEPEST first.** A deep host is the SCARCE vantage —
 * it is the only place a still-deeper host can be reached from, its adjacency
 * expires faster, and it is the one most likely to be gone by the next
 * derivation. A shallow host is reachable again in a moment from anywhere.
 *
 * Ties go to the host with the most room — it will hold the heaviest job — then
 * by name, so the plan is deterministic. A host whose depth we cannot place
 * sorts LAST: it is a host we have not surveyed, and preferring it would spend
 * the scarce plant on the candidate we know least about. */
export function planSpread(
  candidates: readonly SpreadCandidate[],
  limits: SpreadLimits,
  now: number,
): SpreadPlan {
  const plant: SpreadCandidate[] = [];
  const refused: Refusal[] = [];

  const ordered = [...candidates].sort((a, b) => {
    const byDepth = compareDepthDesc(a.depth, b.depth);
    if (byDepth !== 0) return byDepth;
    const ra = a.freeRam ?? -1;
    const rb = b.freeRam ?? -1;
    if (ra !== rb) return rb - ra;
    return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
  });

  for (const candidate of ordered) {
    const refuse = (why: RefusalReason, detail: string): void => {
      refused.push({ host: candidate.host, why, detail });
    };

    if (candidate.goneAt !== undefined) {
      refuse("gone", "the host is offline; darknet hosts go permanently");
      continue;
    }
    if (candidate.agentAlive) {
      refuse("agent-alive", "an agent is already standing here");
      continue;
    }
    if (!candidate.hasCredential) {
      // Not a failure of spreading — a failure of cracking, and the two want
      // different fixes. Saying so is what routes attention correctly.
      refuse("no-credential", "no password known; this is an attempt, not a plant");
      continue;
    }
    if (candidate.freeRam === undefined) {
      // Unknown capacity must never read as "room for an agent": exec would
      // return a silent 0, indistinguishable from a host that is simply full.
      refuse("unknown-ram", "no believable RAM facts; survey it before planting");
      continue;
    }
    const needed = candidate.omitProber ? limits.residentRamGb : limits.agentRamGb;
    if (candidate.blockedRam !== undefined && candidate.blockedRam > 0
      && (candidate.reclaimOnly === true || candidate.freeRam < needed)
      && candidate.freeRam >= limits.bootstrapRamGb) {
      plant.push({
        ...candidate,
        bootstrapReclaim: true,
        bootstrapThreads: Math.floor(candidate.freeRam / limits.bootstrapRamGb),
      });
      continue;
    }
    if (candidate.freeRam < needed) {
      refuse(
        "not-enough-ram",
        `${candidate.freeRam.toFixed(2)}GB free, needs ${needed.toFixed(2)}GB`
        + " — usually the owner's block, which memoryReallocation would have to grind down",
      );
      continue;
    }
    if (candidate.lastPlantAt !== undefined && now - candidate.lastPlantAt < limits.plantCooldownMs) {
      // A host that keeps restarting must not absorb every worker we have.
      refuse("cooldown", "planted recently; if it is empty again it is restarting");
      continue;
    }
    // No per-source cap and no global cap. The one real thing `fanOut`
    // prevented was filing more plants than a source host's queue can hold, and
    // that is a queue-depth fact rather than a spread policy: the controller's
    // staging depth is where it belongs and where it is enforced.
    plant.push(candidate);
  }

  return { plant, refused };
}

/** Every host a plant could be aimed at, read out of the live map.
 *
 * Deciding what counts as a candidate is strategy, and a driver only moves
 * data. The one rule here is testable — a candidate needs a VANTAGE, meaning a
 * host we are standing on whose adjacency we still believe lists the target. A
 * neighbour list we no longer believe is not a route. */
export function candidatesFrom(
  hosts: DnetHosts,
  at: number,
  opts: {
    /** Hosts we have a process on — the controller's own, plus every resident. */
    standing: ReadonlySet<string>;
    /** Hosts we hold a credential for. */
    vault: ReadonlySet<string>;
    /** When each host was last planted, for the cooldown. */
    lastPlantAt?: ReadonlyMap<string, number>;
    /** Targets whose backdoor/stasis fact is fresh enough for remote exec. */
    remoteExec?: ReadonlySet<string>;
    /** Live resident queues able to run a session-only remote plant. */
    remoteVantages?: readonly { host: string; freeGb?: number }[];
    expiry?: ExpiryOpts;
  },
): SpreadCandidate[] {
  const expiry = opts.expiry ?? {};
  const views = new Map<string, DnetHost>();
  for (const host of hosts.values()) views.set(host.hostname, planningView(host, at, expiry));
  const out: SpreadCandidate[] = [];
  for (const host of views.values()) {
    if (opts.standing.has(host.hostname)) continue;
    let from: string | undefined;
    let remote = false;
    // Adjacency is SYMMETRIC, so a vantage for this host is any standing host on
    // either side of a believed edge: one whose own fresh neighbour list names
    // the target, OR one the TARGET's own fresh neighbour list names. The second
    // direction is what recovers a host we can no longer see from the outside —
    // an immune (stasis) host above all, whose neighbour list never expires, so
    // it is frequently the ONLY vantage we will ever have on it. The plant job
    // re-probes the live edge in its preflight, so a since-severed edge refuses
    // cleanly rather than being planted blind.
    for (const where of opts.standing) {
      if (views.get(where)?.neighbours?.includes(host.hostname)) {
        from = where;
        break;
      }
    }
    if (from === undefined) {
      for (const neighbour of host.neighbours ?? []) {
        if (opts.standing.has(neighbour)) {
          from = neighbour;
          break;
        }
      }
    }
    if (from === undefined && opts.remoteExec?.has(host.hostname)) {
      const vantage = [...(opts.remoteVantages ?? [])]
        .filter((candidate) => opts.standing.has(candidate.host))
        .sort((a, b) => (b.freeGb ?? -1) - (a.freeGb ?? -1)
          || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))[0];
      if (vantage !== undefined) {
        from = vantage.host;
        remote = true;
      }
    }
    if (from === undefined) continue;
    // The cooldown applies to EVERY host, immune ones included. An immune host
    // cannot flap from a restart — but it CAN from a persistently-FAILING plant,
    // and it must be held off exactly then: symmetric adjacency can propose a
    // vantage across an edge that an immune host's never-expiring neighbour list
    // still names but the net has since severed, and without the cooldown that
    // plant re-derives, fails its preflight and re-derives again every pass — a
    // spawn-churn loop that starves the game. The one case the cooldown would
    // wrongly block — a freshly-PINNED host whose own pin job emptied it — is
    // handled at the source instead: a successful pin clears the host's plant
    // stamp (see the controller), so its re-plant is not seen as a flap.
    const plantedAt = opts.lastPlantAt?.get(host.hostname);
    const raw = hosts.get(host.hostname);
    out.push({
      host: host.hostname,
      from,
      ...(remote ? { remote: true } : {}),
      ...(host.depth !== undefined ? { depth: host.depth } : {}),
      freeRam: viewedFreeRam(host),
      ...(host.blockedRam !== undefined ? { blockedRam: host.blockedRam } : {}),
      hasCredential: opts.vault.has(host.hostname),
      agentAlive: false,
      ...(plantedAt !== undefined ? { lastPlantAt: plantedAt } : {}),
      ...(raw?.goneAt !== undefined ? { goneAt: raw.goneAt } : {}),
    });
  }
  return out;
}

/** `freeRam` over an already-viewed record: the freshness question was answered
 * by `planningView`, so what is left is the double-count arithmetic. Returns 0
 * when the capacity or the ram group read as unknown. */
function viewedFreeRam(view: DnetHost): number {
  if (view.maxRam === undefined) return 0;
  if (view.blockedRam === undefined && view.usedRam === undefined) return 0;
  const blocked = view.blockedRam ?? 0;
  const used = view.usedRam ?? 0;
  const occupied = used >= blocked ? used : used + blocked;
  return Math.max(0, view.maxRam - occupied);
}

export interface VantageState {
  /** A host we could exec the plant from — adjacent to the target, or a
   *  stamped remote-exec vantage. */
  host: string;
  /** The kind of job its resident is running, or undefined if it is idle. */
  activeKind?: string;
  /** When that job started, so the least-loss choice can prefer the one that
   *  has run the shortest. */
  activeStartedAt?: number;
  /** Canonical queue priority of the active job. */
  activePriority?: number;
  /** Best current completion estimate for remaining-time tie-breaking. */
  activeExpectedDoneAt?: number;
  /** Usable job RAM on this worker. */
  usableGb?: number;
  /** Already selected for cancellation or work in this scheduling pass. */
  cancelling?: boolean;
  assigned?: number;
}

/** Which vantage should run a plant, and whether doing so preempts a job.
 *
 * Spreading is critical, so this looks past "is a vantage free" to "which
 * vantage costs the least to free". The order is:
 *
 *   1. A FREE vantage — nothing is lost, so it wins outright.
 *   2. Otherwise the PREEMPTIBLE job we lose the least time on: the one that has
 *      run the shortest, because cancelling it throws away the least work.
 *   3. Otherwise nothing — every vantage is busy with the lab, a pin, another
 *      plant or a storm, none of which a plant may interrupt. The plant waits in
 *      its filed queue rather than sacrificing something more important.
 *
 * Deterministic: ties break by host name so a derivation is reproducible. */
export function pickPlantVantage(
  vantages: readonly VantageState[],
  now: number,
): { vantage: string; preempt: boolean } | undefined {
  return choosePreemptionVantage("plant", vantages, now);
}

// --- storm -------------------------------------------------------------------

/** When to fire the storm — the endgame cache farm, and the one decision in the
 * feature that destroys most of what we know on purpose.
 *
 * `unleashStormSeed` fires `STORM_SEED.exe` from the host holding it and
 * discharges the whole mutation clock in one ~30-second burst: ~60% of movable
 * servers deleted, the survivors moved and restarted, forty fresh ones added.
 * Every fresh server is a new first-authentication cache roll AND a new blocked
 * block whose clearing mints a guaranteed `.cache` — which is why a reroll beats
 * phishing's one `.d.cache` per three net-wide minutes. Only stationary hosts
 * (darkweb, the labyrinth) and stasis-linked hosts survive, keeping their
 * files, sessions, residents and running scripts.
 *
 * The seed itself is not ours to schedule: it is a `memoryReallocation` reward
 * (a 15% roll per block cleared to zero, only while no seed exists among the
 * movable servers, only 30+ minutes after the last storm), it lands in the
 * cleared server's program list, and `scp` cannot move it — the fire job must
 * run on the holding host. What IS ours to schedule is WHEN, and that is this
 * planner: pure, deterministic, refusing by name like `farm.ts` and `hold.ts`.
 *
 * ## The gates, and what each one protects
 *
 * A storm is only worth firing into a net we are DONE with and ready to
 * reconquer fast. The gates encode that in order of certainty:
 *
 * 1. `storm-in-flight` — our own quiet window. The engine consumes the seed and
 *    stamps its clock BEFORE checking the mutation lock, so a second fire
 *    during a burst burns the seed for nothing.
 * 2. `no-seed` — a fresh sighting of `STORM_SEED.exe` on a live host.
 * 3. `seed-unreachable` — the holder needs a live resident; the call takes no
 *    target and the file cannot be moved. `planSpread` plants one in time.
 * 4. `harvest-incomplete` — every non-stationary host fully opened and drained.
 * 5. `links-unspent` — every stasis slot deployed and no pin still pending.
 *    The links are the half of the net that survives: the new net is conquered
 *    from the top (darkweb) and from the pinned giants at the bottom at once.
 * 6. `walker-unpinned` — a finisher walk in flight on an unpinned host is hours
 *    of PID-keyed progress one restart away from zero. Once its host is linked
 *    the storm cannot touch it — a storm mid-walk is safe.
 * 7. `phish-window-open` — fire only just after a `.d.cache` landed, so the
 *    storm's downtime sits inside the three dead minutes of the net-wide
 *    phishing cooldown and displaces no cache we could have rolled for.
 *
 * There is deliberately NO lab gate. A lab-less world (program-only access
 * never generates a labyrinth) has no walk to protect, so the walker gate never
 * binds there and links-spent is the whole preparation.
 *
 * All gates green admits exactly one task: fire from the holder, on the holder. */

export interface StormContext {
  now: number;
  /** Hosts we hold a credential for — first authentication completed. */
  vault: ReadonlySet<string>;
  /** Hosts we hold a stasis link on — the controller's own fact, never an
   *  observation. */
  stasisLinked: ReadonlySet<string>;
  /** `getStasisLinkLimit()` — 1 to 4, raised only by labyrinth augmentations. */
  stasisLimit: number;
  /** Links actually applied, from the newest complete stasis snapshot. The
   *  authoritative count, which may exceed what the map can see. */
  stasisLinkedCount: number;
  /** A pin task filed or in flight this pass: a slot is being spent RIGHT NOW,
   *  and firing under it would waste the 12 GB + wait already committed. */
  pinsPending: boolean;
  /** The lab walker is active. */
  walkInFlight: boolean;
  /** The finisher's host is in the linked set. Meaningless unless
   *  `walkInFlight`. */
  walkerPinned: boolean;
  /** The vault holds the labyrinth's password — the walk is over and the
   *  walker-protection gate retires itself. */
  labWalked: boolean;
  /** When a `.d.cache` was last seen to land, same evidence `farm.ts` uses. */
  lastPhishCacheAt?: number;
  /** Our own stamp of the last fire, taken pessimistically at claim time. */
  lastStormFiredAt?: number;
}

export type StormRefusalReason =
  | "storm-in-flight"
  | "no-seed"
  | "seed-unreachable"
  | "harvest-incomplete"
  | "links-unspent"
  | "walker-unpinned"
  | "phish-window-open";

export interface StormRefusal {
  hostname: string;
  why: StormRefusalReason;
  detail: string;
}

export interface StormPlan {
  /** The one admitted fire, when every gate is green. `from` is always the
   *  holder itself — the call takes no target. */
  fire?: { host: string; from: string; reason: string };
  refused: StormRefusal[];
}

/** The net-wide gates refuse against this pseudo-host, so the panel has one row
 * to hang them on even when no seed has ever been sighted. */
const NET = "(net)";

/** The harvest kinds whose in-flight presence holds the seed: the work whose
 * results a storm would throw away mid-collection. */
const HARVEST_KINDS: ReadonlySet<string> = new Set(["attempt", "reclaim", "cache"]);

/** `hosts` are ALREADY-VIEWED records (see the module header): an absent field
 * is unknown or stale, and unknown does not admit. */
export function planStorm(hosts: readonly DnetHost[], ctx: StormContext): StormPlan {
  const refused: StormRefusal[] = [];
  const refuse = (hostname: string, why: StormRefusalReason, detail: string): void => {
    refused.push({ hostname, why, detail });
  };

  // 1. Never fire into our own storm. The engine consumes the seed and stamps
  // `lastStormTime` before it checks the lock, so this would burn it outright.
  if (ctx.lastStormFiredAt !== undefined && ctx.now - ctx.lastStormFiredAt < STORM_QUIET_MS) {
    const left = STORM_QUIET_MS - (ctx.now - ctx.lastStormFiredAt);
    refuse(NET, "storm-in-flight", `our own storm fired ${Math.round((ctx.now - ctx.lastStormFiredAt) / 1000)}s ago; quiet for ${Math.round(left / 1000)}s more`);
    return { refused };
  }

  // 2. A seed, freshly seen, on a live host. Upstream mints at most one among
  // the movables, but a pinned host can hold a second — be total: prefer the
  // stasis-linked holder (storm-proof, so the movable one should burn first is
  // the WRONG instinct — the pinned seed is the one we can always still fire),
  // then name order, so the choice never moves under the panel.
  const holders = hosts
    .filter((host) => host.goneAt === undefined && host.stormSeed === true)
    .sort((a, b) => {
      const aPinned = ctx.stasisLinked.has(a.hostname) ? 0 : 1;
      const bPinned = ctx.stasisLinked.has(b.hostname) ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      return a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0;
    });
  if (holders.length === 0) {
    refuse(NET, "no-seed", "no fresh STORM_SEED.exe sighting on any live host");
    return { refused };
  }
  const holder = holders[0]!;

  // 3. The fire job runs ON the holder; the file cannot be scp'd off it.
  if (holder.agentAlive !== true) {
    refuse(holder.hostname, "seed-unreachable", "the seed's host has no resident, and the seed cannot be moved; waiting for a plant");
    return { refused };
  }

  const incomplete = hosts.find((host) => host.goneAt === undefined && host.isStationary !== true && (
    !ctx.vault.has(host.hostname)
    || host.blockedRam === undefined
    || host.blockedRam > 0
    || host.caches === undefined
    || host.caches.length > 0
    || [...(host.busy ?? [])].some((kind) => HARVEST_KINDS.has(kind))
  ));
  if (incomplete !== undefined) {
    const detail = !ctx.vault.has(incomplete.hostname)
      ? "first authentication has not been completed"
      : incomplete.blockedRam === undefined
        ? "blocked RAM has not been freshly observed"
        : incomplete.blockedRam > 0
          ? `${incomplete.blockedRam.toFixed(2)}GB blocked RAM remains`
          : incomplete.caches === undefined
            ? "the cache listing has not been freshly observed"
            : incomplete.caches.length > 0
              ? `${incomplete.caches.length} cache file(s) remain unopened`
              : "authentication, reclaim, or cache work is still active";
    refuse(incomplete.hostname, "harvest-incomplete", detail);
    return { refused };
  }

  // 5. Every slot spent, none mid-spend. The links ARE the preparation: what
  // survives is what we reconquer from.
  if (ctx.stasisLinkedCount < ctx.stasisLimit || ctx.pinsPending) {
    refuse(
      holder.hostname,
      "links-unspent",
      ctx.pinsPending
        ? `a stasis pin is in flight (${ctx.stasisLinkedCount}/${ctx.stasisLimit} linked); the storm waits for it to land`
        : `${ctx.stasisLinkedCount}/${ctx.stasisLimit} stasis links deployed; the survivors are the reconquest`,
    );
    return { refused };
  }

  // 6. A finisher mid-walk must be pinned before anything reroll-shaped runs.
  // Retired once the lab is walked: there is no finisher left to protect.
  if (!ctx.labWalked && ctx.walkInFlight && !ctx.walkerPinned) {
    refuse(holder.hostname, "walker-unpinned", "a finisher is mid-walk on an unpinned host; a restart costs the whole walk");
    return { refused };
  }

  // 7. Fire into the dead phish window, not across an open one. Never having
  // seen a `.d.cache` reads as open — the conservative side, and it corrects
  // itself within one cache.
  if (ctx.lastPhishCacheAt === undefined || ctx.now - ctx.lastPhishCacheAt > STORM_PHISH_OVERLAP_MS) {
    refuse(
      holder.hostname,
      "phish-window-open",
      ctx.lastPhishCacheAt === undefined
        ? "no .d.cache ever sighted; waiting to fire just after one lands"
        : `last .d.cache landed ${Math.round((ctx.now - ctx.lastPhishCacheAt) / 1000)}s ago; firing only within ${Math.round(STORM_PHISH_OVERLAP_MS / 1000)}s of one`,
    );
    return { refused };
  }

  return {
    fire: {
      host: holder.hostname,
      from: holder.hostname,
      reason: "unleash STORM_SEED.exe: reroll the net inside the dead phish window",
    },
    refused,
  };
}

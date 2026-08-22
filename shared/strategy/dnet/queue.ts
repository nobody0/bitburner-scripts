import { expiryMs, fresh, type DarknetKnowledge, type DarknetHostKnowledge } from "./knowledge.ts";
import { modelEntry, planAttempt } from "./models.ts";
import { conclusiveAttempt } from './courier.ts';

/** What there is to do out there, and who is doing it.
 *
 * The overseer does not keep a task list. It DERIVES one, and that is the
 * whole of the dedup.
 *
 * **The queue is DERIVED from knowledge, never appended to.** There is no
 * "add task" call anywhere. `deriveTasks` looks at what we believe and emits
 * only the work that belief does not already cover: a survey for a host whose
 * neighbour list has expired, an attempt for a host whose model has something
 * left to try, a plant for a host the spread planner admits. A fact that is
 * still believable produces no task at all.
 *
 * That is what makes dedup structural rather than bookkeeping. Nothing can
 * duplicate a survey, because once the first one lands the fact is fresh and the
 * task stops existing — no completion message, no acknowledgement, nothing to
 * get out of sync. It also self-heals: a job that dies mid-task leaves the fact
 * stale, so the task simply reappears on the next derivation.
 *
 * ## The one thing derivation cannot see
 *
 * Structural dedup works because finishing the work makes the task stop
 * existing. That fails for work with no fact stamp — `attempt:<host>` is the
 * case — where the task re-derives every tick for the whole duration of a
 * multi-second `authenticate`. Today that is hidden by the overseer's
 * per-queue duplicate check, and the moment a target has two adjacent vantages
 * the check stops covering it and the same authenticate fires twice.
 *
 * So `inFlight` is admitted here, and it is deliberately as small as it can be:
 * `(target -> {from, kind})`, DATA ONLY. The overseer's own claims carry a
 * password; those never reach this module, because a pure function that held a
 * credential would eventually be asked to explain itself in a log line. */

/** The four jobs that LEARN or SPREAD, the four that FARM, and the four
 * DELIBERATE ones.
 *
 * `cache`, `reclaim`, `phish` and `promote` are decided by
 * `shared/strategy/dnet/farm.ts`; `pin`, `induce` and `walk` by
 * `shared/strategy/dnet/hold.ts`; `storm` by `shared/strategy/dnet/storm.ts`.
 * All are merged here exactly as `plant` is merged from `spread.ts`: the queue
 * does not second-guess a planner that has already named its refusals. */
export type TaskKind =
  | "survey"
  | "bleed"
  | "attempt"
  | "plant"
  | "cache"
  | "reclaim"
  | "phish"
  | "promote"
  // --- the deliberate four, from `hold.ts` and `storm.ts` ---------------------
  //
  // Merged exactly as `plant` and the farm rungs are: `planStasis`, `planInduce`,
  // the walker's own gate and `planStorm` have already named their refusals, and
  // the queue does not second-guess a planner that has.
  | "pin"
  | "induce"
  | "walk"
  | "storm";

export interface Task {
  id: string;
  kind: TaskKind;
  /** The target. */
  host: string;
  /** Where a process must be STANDING to do it. probe, authenticate and
   *  heartbleed all require a direct connection, so the vantage is part of the
   *  task rather than a detail of whoever runs it — and it is what decides which
   *  host's queue the job is filed against. */
  from: string;
  /** A plant may reuse a global rooted session without current adjacency. */
  remote?: boolean;
  /** Lower is more urgent. */
  priority: number;
  /** Why this task exists, in one line, for the panel and the failure line. */
  reason: string;
  /** Threads to run it at. Omitted means one. `ramOverride` is charged PER
   *  THREAD, so this multiplies the allocation rather than sharing it — which
   *  is why both fit checks compare `budgetGb * threads`. */
  threads?: number;
  /** The `.cache` file a `cache` task opens. Nothing else carries one, and a
   *  job never invents a filename: `openCache` THROWS on a name the host does
   *  not hold, and a throw kills the agent rather than failing the job. */
  filename?: string;
  /** The symbol a `promote` task spreads propaganda about. */
  symbol?: string;
  /** Walks only: a SECOND, disposable walker in the same maze. The maze is
   *  global while positions are per PID, so a scout on another adjacent host
   *  maps the macro-route the finisher is not on and feeds the shared field —
   *  and unlike the finisher it is expendable: it is never marked
   *  irreplaceable, never attracts a stasis link, and a mutation eating its
   *  host costs only its own position. */
  role?: "scout";
  /** Pins only: the neighbour the pin exists to keep. See the hold entry's
   *  field of the same name — this merely carries it to the job state. */
  edge?: string;
  /** Pins only: release the link instead of applying one. */
  unpin?: boolean;
  /** Which unattributed password an `attempt` task is spending, BY REFERENCE.
   *
   *  The password itself never enters this module. A log's `--<password>--`
   *  line names no owner, so the overseer matches it against the length and
   *  format facts it already holds and hands the result over as an opaque id;
   *  the id is what the job state's `guess` is resolved from, back in the
   *  overseer, where credentials live. Same rule `inFlight` keeps, and for
   *  the same reason: a pure function that held a credential would eventually
   *  be asked to explain itself in a log line. */
  guessId?: string;
}

export interface DeriveOptions {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  // No `stasisLinked` here, deliberately. Stasis is a HOME decision — the
  // overseer never sees the set — so a stasis-linked host looks perishable to
  // the queue and gets re-surveyed a little sooner than it needs to be. That
  // errs toward re-observing, which is the safe direction, and plumbing a
  // fourth channel to save a few jobs on at most four hosts is not worth it.
  // `isStationary` needs no plumbing: it is an identity fact, so `fresh` works
  // immunity out per host on its own.
  /** Hosts with a live agent, so we do not survey what is already being watched
   *  and do not plant where someone is standing. */
  agents?: ReadonlySet<string>;
  /** What a JOB would get on each agent host: the resident's measured free RAM
   *  plus the allocation the resident hands back when it spawns — the exact
   *  figure the overseer's own fit check uses, so a vantage chosen here is one
   *  the job actually fits on. Omitted, every vantage reads as 0 GB and the
   *  ordering falls back to the name tie-break: today's behaviour. */
  agentFreeGb?: ReadonlyMap<string, number>;
  /** What ONE THREAD of an attempt job costs. `authenticate`'s duration scales
   *  `1/(1 + 0.2*(threads-1))` with the calling script's threads, so when this
   *  is provided an attempt is sized to the RAM its vantage can spare. Omitted,
   *  attempts run at one thread: today's behaviour. */
  attemptGbPerThread?: number;
  /** The same for a bleed job: `heartbleed`'s capture time scales with the
   *  calling script's threads exactly as `authenticate`'s does (at 1.5x the
   *  base), so a drain is sized to its vantage too. Omitted, one thread. */
  bleedGbPerThread?: number;
  /** Hosts we hold a credential for. */
  vault?: ReadonlySet<string>;
  /** Hosts admitted by `planSpread`, already filtered and ordered. */
  plantable?: readonly { host: string; from: string; remote?: boolean }[];
  /** Farm work admitted by `planFarm`, already laddered and thread-sized.
   *  Three of the four calls act on the host the script stands on, so the
   *  vantage IS the target — but `memoryReallocation` reaches an authenticated
   *  adjacent host too, so a reclaim may carry its own `from` when a roomy
   *  neighbour grinds a cramped host's block remotely. */
  farm?: readonly {
    kind: "cache" | "reclaim" | "phish" | "promote";
    host: string;
    /** The vantage, when it is not the target: a remote reclaim's helper.
     *  Absent means self-host, which is every other farm task. */
    from?: string;
    threads: number;
    filename?: string;
    symbol?: string;
    reason: string;
  }[];
  /** The deliberate work `hold.ts` admitted: a stasis pin, an induced
   *  migration, a maze walk. Unlike the farm these are not self-host — an
   *  `induceServerMigration` REFUSES its own host — so each carries its own
   *  vantage. */
  hold?: readonly {
    kind: "pin" | "induce" | "walk" | "storm";
    host: string;
    from: string;
    threads?: number;
    reason: string;
    /** See `Task.role`: the walk planner may admit one finisher AND one scout
     *  for the same lab, distinguished by vantage. */
    role?: "scout";
    /** Pins only: the neighbour this pin exists to keep — the lab. The job
     *  re-probes for it at act time and refuses to spend the link if the
     *  mutation clock severed the edge after this was derived. */
    edge?: string;
    /** Pins only: run `setStasisLink(false)` instead — release a link whose
     *  host no longer earns it, freeing the slot. Same kind, same 12 GB call,
     *  opposite argument. */
    unpin?: boolean;
  }[];
  /** Unattributed passwords matched to hosts they could open, by reference.
   *
   *  Each is one `authenticate` with no penalty for being wrong, which is why
   *  they outrank the model attempt on the same host: a candidate that lands
   *  saves a whole solve. See `Task.guessId`. */
  guesses?: readonly { host: string; id: string; reason: string }[];
  /** How many deliberate probes an unsolved model may cost, per host. */
  probeLimit?: number;
  /** Our charisma, for the heartbleed gate: `heartbleed` refuses (451) below the
   *  host's `requiredCharisma`, and it is the only charisma-gated call. A bleed
   *  against a gated host can only ever collect a 451, and a probe attempt's
   *  whole payoff is the oracle heartbleed would read back — so both are
   *  withheld until charisma catches up, and the requirement is an identity
   *  fact, so it never quietly expires into "try again". Omitted, nothing is
   *  gated: one refused call per host is how the requirement gets learned. */
  charisma?: number;
  /** Latest `nextMutation()` event observed by the overseer. A resident's own
   * adjacency is re-surveyed once after this stamp, coalescing multiple ticks. */
  lastMutationAt?: number;
  /** Work a live process is already doing, keyed by TARGET. A `(kind, target)`
   *  pair in here emits no task.
   *
   *  Data only, and never a password: see the note above. The overseer builds
   *  it from `DnetClaim` by naming the two fields it may pass, so a field added
   *  to a claim later cannot leak in by default. */
  inFlight?: ReadonlyMap<string, readonly { from: string; kind: TaskKind }[]>;
}

/** Where the three farm kinds sit against everything else.
 *
 * All three are above (worse than) the +50 a deliberate probe carries, because
 * farming is what a host does when it has stopped teaching us anything. Within
 * the three the order is the ladder's own — and it is a tie-break rather than
 * the ladder itself, since `planFarm` only ever admits one rung per host. */
const FARM_PRIORITY: Readonly<Record<"cache" | "reclaim" | "phish" | "promote", number>> = {
  cache: 100,
  reclaim: 300,
  // These two only order ACROSS hosts now: which of the pair a given host runs
  // is `planFarm`'s expected-value comparison, and one rung per host means the
  // bands never arbitrate between them on the same host.
  phish: 400,
  promote: 500,
};

/** Where the three deliberate kinds sit.
 *
 * Two of them are ABOVE the farm and above every attempt, because neither is a
 * thing a host does — each is a decision made once for the whole net, and a
 * pin that queues behind a forty-second phish is a pin that may be spent on a
 * host that has already been restarted. `induce` is the exception: it is a
 * project of hundreds of calls whose value is realised at the end, so it waits
 * behind anything that opens the net. */
const HOLD_PRIORITY: Readonly<Record<"pin" | "induce" | "walk" | "storm", number>> = {
  // THE PIN GOES FIRST, and the order is load-bearing rather than aesthetic.
  // A host runs ONE process at a time, and a walk holds its host for hours — so
  // a pin queued behind a walk is a pin that starts after the thing it exists
  // to protect has already finished. The sequence that works is pin, re-plant,
  // walk: the pin's process ends without handing the host back (it cannot
  // afford the spawn), `planSpread` puts a resident back a tick later, and the
  // walk then starts on a host the mutation clock can no longer touch.
  pin: -95,
  walk: -90,
  // Below the pin STRUCTURALLY: a pending pin is a reason not to fire yet, and
  // the ordering enforces what `planStorm`'s `links-unspent` gate argues. Above
  // every attempt band, because the admitting policy has already proved a
  // timing window (a `.d.cache` landed seconds ago) and a storm queued behind a
  // 36-second attempt could miss it.
  storm: -85,
  // A project of hundreds of calls whose value arrives at the end, so it waits
  // behind everything that opens the net — cracking, caches AND the grind:
  // `memoryReallocation` is what makes a pushed giant plantable when it lands,
  // so freeing RAM comes first. Only the earn pair queues behind a push.
  induce: 350,
};

/** Placing a process is the scarcest thing we do — it is the only action that
 *  grows the set of places we can act FROM — so it outranks everything, the
 *  deliberate three included. */
const PLANT_PRIORITY = -100;

/** There is NO thread ceiling. A resident runs ONE job at a time, so RAM the
 * running job does not take is simply idle — the marginal gigabyte has no
 * opportunity cost, and "diminishing returns per GB" is the wrong lens. So an
 * attempt or a bleed takes every thread its vantage can afford, bounded only
 * by RAM. The per-thread price already carries the 1.6 GB script base, the
 * 2.0 GB `spawn` the atExit respawn needs, and the margin — and the engine
 * charges `ramOverride × threads` — so `floor(room / perThreadCost)` reserves
 * all of that once per thread, exactly as the engine requires. */

/** The per-host offsets, all applied to `rank` (the negated depth).
 *
 * These are BANDS rather than fine gradations: what matters is that no host's
 * bleed can reach into another kind's band, because the ordering across kinds
 * is a policy and the ordering within one is a detail. */

/** A leaked candidate is one `authenticate` with no oracle and no charisma gate,
 *  so it goes below every model attempt on the same host and still above a
 *  survey. */
const GUESS_BONUS = -5;
/** A solve that has to converse costs more than a dictionary hit or a
 *  closed-form decode, both of which are one call and read their own answer. */
const ORACLE_SOLVE_SURCHARGE = 10;
/** A probe buys information and nothing else — no credential, no vantage. */
const PROBE_SURCHARGE = 50;
/** The band a bleed sits in, above every attempt on the same host. */
const BLEED_BAND = 10;
/** A failed read is operational, not evidence that the ring is empty. Retry
 * eventually, without tying the backoff to passive traffic the API never
 * materialises. */
const BLEED_RETRY_MS = 10_000;

/** Every place a process could stand to reach `host`, best first.
 *
 * All of them so a task can avoid a vantage already occupied by another job.
 *
 * Ordered by the RAM a job would get there (`agentFreeGb`), most first, because
 * `authenticate`'s duration shrinks with the calling script's threads and
 * threads are bought with the vantage's free RAM — so the roomiest vantage is
 * the fastest crack. Self is a candidate like any other (a resident there
 * counts as directly connected). Ties break BY NAME rather than in `agents`
 * iteration order, because that order is insertion order and would make the
 * derived queue depend on the sequence in which hosts happened to be planted;
 * with no `agentFreeGb` at all, every vantage ties at 0 and the ordering is
 * the old name sort with self first.
 *
 * An empty list is itself the answer: the host is a rumour until someone stands
 * next to it. */
function vantagesFor(
  host: DarknetHostKnowledge,
  knowledge: DarknetKnowledge,
  now: number,
  opts: DeriveOptions,
): string[] {
  const agents = opts.agents ?? new Set<string>();
  const expiry = { netDepth: opts.netDepth, bitNode: opts.bitNode, backdoored: opts.backdoored };
  const vantages: string[] = [];
  if (agents.has(host.hostname)) vantages.push(host.hostname);
  for (const agentHost of agents) {
    if (agentHost === host.hostname) continue;
    const standing = knowledge.hosts[agentHost];
    if (!standing) continue;
    const neighbours = fresh<string[]>(standing, "neighbours", now, expiry);
    if (neighbours?.includes(host.hostname)) vantages.push(agentHost);
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
 * Deterministic and ordered, so two derivations of the same knowledge produce
 * the same queue. */
export function deriveTasks(
  knowledge: DarknetKnowledge,
  now: number,
  opts: DeriveOptions = {},
): Task[] {
  const expiry = { netDepth: opts.netDepth, bitNode: opts.bitNode, backdoored: opts.backdoored };
  const agents = opts.agents ?? new Set<string>();
  const vault = opts.vault ?? new Set<string>();
  const tasks: Task[] = [];
  /** Whether a live process is already doing this exact thing to this host.
   *  Passing no `inFlight` is exactly today's behaviour: nothing is busy. */
  const busy = (kind: TaskKind, host: string): boolean =>
    (opts.inFlight?.get(host) ?? []).some((claim) => claim.kind === kind);
  const netHasUncrackedMovable = Object.values(knowledge.hosts).some((candidate) =>
    candidate.goneAt === undefined
    && fresh<boolean>(candidate, "isStationary", now, expiry) !== true
    && !vault.has(candidate.hostname));


  for (const host of Object.values(knowledge.hosts)) {
    if (host.goneAt !== undefined) continue;
    const vantages = vantagesFor(host, knowledge, now, opts);
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
    // why the fallback is +1 rather than the old 99: with the sign flipped, 99
    // would have made the host we know least about the most urgent thing in the
    // net. `darkweb` at -1 lands there too, and belongs there — it is a shop,
    // not a vantage worth racing to.
    const placed = fresh<number>(host, "depth", now, expiry);
    const rank = placed === undefined ? 1 : -placed;
    // The heartbleed gate. An UNKNOWN requirement passes: the refused call's own
    // describeHost report is what teaches us the number, so the first try is
    // the survey.
    const requiredCharisma = fresh<number>(host, "requiredCharisma", now, expiry);
    const bleedable = opts.charisma === undefined
      || requiredCharisma === undefined
      || requiredCharisma <= opts.charisma;

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
    // rather than in the overseer because the vantage choice and the thread
    // count are the same decision: the roomiest vantage was picked FOR its
    // room. With no pricing input, one thread — today's behaviour.
    const attemptRoom = opts.agentFreeGb?.get(workFrom);
    const sized = (gbPerThread: number | undefined): number =>
      gbPerThread !== undefined && gbPerThread > 0 && attemptRoom !== undefined
        ? Math.max(1, Math.floor(attemptRoom / gbPerThread))
        : 1;
    const attemptThreads = sized(opts.attemptGbPerThread);
    const bleedThreads = sized(opts.bleedGbPerThread);
    // SURVEY: only when the adjacency we hold has stopped being believable.
    // While it is fresh there is nothing to learn, so there is no task, so two
    // workers cannot both go and learn it.
    const neighboursFact = host.facts["neighbours"];
    const changedSinceSurvey = agents.has(host.hostname)
      && opts.lastMutationAt !== undefined
      && (neighboursFact?.at ?? 0) < opts.lastMutationAt;
    if ((fresh<string[]>(host, "neighbours", now, expiry) === undefined || changedSinceSurvey)
      && !busy("survey", host.hostname)) {
      tasks.push({
        id: `survey:${host.hostname}`,
        kind: "survey",
        host: host.hostname,
        from,
        priority: rank,
        reason: changedSinceSurvey
          ? "mutation observed since last survey"
          : host.facts["neighbours"] ? "adjacency expired" : "never surveyed",
      });
    }

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
        // Below every model attempt on the same host and above every survey:
        // one call, no oracle, no charisma gate.
        priority: rank + GUESS_BONUS,
        reason: guess.reason,
        ...(attemptThreads !== 1 ? { threads: attemptThreads } : {}),
        guessId: guess.id,
      });
    }

    let scheduledAttempt = guessing;
    // ATTEMPT: only for a host we cannot already open, and only while its model
    // has something left to try.
    if (!pendingBleed && !guessing && !ringBusy && !vault.has(host.hostname) && host.hostname !== "darkweb") {
      const modelId = fresh<string>(host, "modelId", now, expiry);
      const entry = modelEntry(modelId);
      const attempt = planAttempt(
        entry,
        {
          ...(fresh<number>(host, "passwordLength", now, expiry) !== undefined
            ? { passwordLength: fresh<number>(host, "passwordLength", now, expiry)! }
            : {}),
          ...(fresh<string>(host, "passwordFormat", now, expiry) !== undefined
            ? { passwordFormat: fresh<string>(host, "passwordFormat", now, expiry)! }
            : {}),
          ...(fresh<string>(host, "passwordHint", now, expiry) !== undefined
            ? { passwordHint: fresh<string>(host, "passwordHint", now, expiry)! }
            : {}),
          ...(fresh<string>(host, "data", now, expiry) !== undefined
            ? { data: fresh<string>(host, "data", now, expiry)! }
            : {}),
          ...(fresh<number>(host, "difficulty", now, expiry) !== undefined
            ? { difficulty: fresh<number>(host, "difficulty", now, expiry)! }
            : {}),
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
      if (attempt.kind !== "none" && modelId !== undefined && !withheld) {
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
          priority: rank + surcharge,
          reason: attempt.kind === "candidate"
            ? `${entry?.name ?? modelId} candidate ${attempt.index + 1}/${attempt.total}`
            : attempt.kind === "solve"
              ? `${entry?.name ?? modelId}: ${attempt.note} (up to ${attempt.budget} attempts)`
              : attempt.reason,
          ...(attemptThreads !== 1 ? { threads: attemptThreads } : {}),
        });
      }
    }

    // INITIAL BLEED: attempts consume their own records, so listening is only
    // admitted when no authentication job owns this target's shared ring.
    const neighbours = fresh<string[]>(host, "neighbours", now, expiry);
    const initialRingUseful = !vault.has(host.hostname)
      || neighbours === undefined
      || neighbours.some((name) => !vault.has(name))
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
        priority: rank + BLEED_BAND,
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
      priority: PLANT_PRIORITY,
      reason: "a credential and room for an agent",
    });
  }

  // FARM: the leftovers, and they sort behind everything that learns, spreads
  // or opens the net. A host being farmed is a host with nothing better to do,
  // and the priorities say so — but `enqueue` files in priority order, so a
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

  // HOLD: the pin, the push and the walk. Same contract as the farm — the
  // planner named its refusals and this merely files what it admitted — but
  // each carries its own vantage, because `induceServerMigration` is the one
  // call in the feature that refuses the host it is running on.
  for (const entry of opts.hold ?? []) {
    // A walk dedups on (kind, target, VANTAGE), not (kind, target): the lab is
    // the one target that may legitimately carry two walks at once — the
    // pinned finisher and a disposable scout on another adjacent host. Every
    // other hold kind keeps the plain per-target check.
    const walking = entry.kind === "walk"
      ? (opts.inFlight?.get(entry.host) ?? []).some((claim) => claim.kind === "walk" && claim.from === entry.from)
      : busy(entry.kind, entry.host);
    if (walking) continue;
    tasks.push({
      id: entry.kind === "walk" ? `walk:${entry.host}:${entry.from}` : `${entry.kind}:${entry.host}`,
      kind: entry.kind,
      host: entry.host,
      from: entry.from,
      priority: HOLD_PRIORITY[entry.kind],
      reason: entry.reason,
      ...(entry.threads !== undefined && entry.threads !== 1 ? { threads: entry.threads } : {}),
      ...(entry.role !== undefined ? { role: entry.role } : {}),
      ...(entry.edge !== undefined ? { edge: entry.edge } : {}),
      ...(entry.unpin === true ? { unpin: true } : {}),
    });
  }

  tasks.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tasks;
}

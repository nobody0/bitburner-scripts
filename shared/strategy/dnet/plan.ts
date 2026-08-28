import {
  compareDepthDesc,
  planningView,
  type DnetHost,
  type DnetHosts,
  type ExpiryOpts,
} from "./host.ts";
import { modelEntry, planAttempt } from "./models.ts";
import { conclusiveAttempt } from "./courier.ts";
import type { HoldTask } from "./hold.ts";
import { compareQueuedDnetWork } from "./priority.ts";
import { JOBS, isTaskKind, priorityOf, type TaskKind } from "./jobs.ts";
import { STORM_PHISH_OVERLAP_MS, STORM_QUIET_MS, STORM_RESTART_BY_MS } from "./rates.ts";

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
 * entry point that owns `now` and the expiry opts. Sub-planners receive viewed
 * records, where an absent field means unknown. */

/** The kinds, and every scheduling fact about them, live in `jobs.ts`.
 *
 * `cache`, `reclaim`, `phish` and `promote` are decided by
 * `shared/strategy/dnet/farm.ts`; `pin`, `induce` and `walk` by
 * `shared/strategy/dnet/hold.ts`; `storm` by `planStorm` below. All are merged
 * exactly as `plant` is merged from `planSpread`: the queue does not
 * second-guess a planner that has already named its refusals. */
export type { TaskKind };

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
  /** Plants only: the whole frontier this one order opens, run concurrently.
   *  `host` is `targets[0].host` — the generic identity, not the whole job. */
  targets?: readonly PlantTarget[];
  /** Lower is more urgent. */
  priority: number;
  /** Why this task exists, in one line, for the panel and the failure line. */
  reason: string;
  /** Threads to run it at. Omitted means one. `ramOverride` is charged PER
   *  THREAD, so this multiplies the allocation rather than sharing it. */
  threads?: number;
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
  /** Bleeds only: wait for these authentication orders to settle, then drain
   * the records they wrote. This is staged on a separate direct vantage. */
  followAttemptIds?: readonly string[];
  /** Parallel candidate races authenticate immediately; none competes
   * for the shared ring before writing its result. */
  skipInitialBleed?: boolean;
  /** A conversational solve: the process needs `heartbleed` beside its
   *  `authenticate` and is priced for it. Everything else is lean. */
  needsRing?: boolean;
}

export interface DeriveOptions {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  /** Hosts we hold a stasis link on — the fourth `ExpiryOpts` term, and the one
   *  that makes a pinned host's position facts immune to expiry. Declared here
   *  because the controller spreads a whole `ExpiryOpts` in, and a field this
   *  interface does not name is silently dropped by the rebuild below. */
  stasisLinked?: ReadonlySet<string>;
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
  plantable?: readonly (PlantTarget & { from: string })[];
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
    /** A gang grinder: dedup per (kind, target, vantage) like an induce push,
     *  because several vantages grind the same block at once. */
    perVantage?: boolean;
  }[];
  /** The deliberate work `hold.ts`/`planStorm` admitted. Unlike the farm these
   *  are not self-host — an `induceServerMigration` REFUSES its own host — so
   *  each carries its own vantage. */
  hold?: readonly HoldTask[];
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

/** How far a solve that needs its oracle, and a deliberate probe, sort behind
 * work that can open a host outright. Divisors of the attempt score rather than
 * additions to a priority: the score is a ratio, so a penalty has to be one
 * too or it stops meaning the same thing at different difficulties. */
const ORACLE_PENALTY = 10;
const PROBE_PENALTY = 50;
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
  // Self wins RAM ties because it already holds the session.
  const selfBias = (name: string): number => (name === host.hostname ? 1 : 0);
  vantages.sort((a, b) =>
    roomOn(b) - roomOn(a)
    || selfBias(b) - selfBias(a)
    || (a < b ? -1 : a > b ? 1 : 0));
  return vantages;
}

export interface CredentialCheckAllocation {
  authSlots: number;
  bleedSlots: 0 | 1;
}

/** Allocate one candidate-check wave across direct vantages.
 *
 * One consuming heartbleed drains every authentication record in the ring, so
 * a second listener has no marginal value. A failed response is conservatively
 * valued at one bit: k checked candidates plus k response bits can distinguish
 * roughly `k + 2^k` candidates. Tiny exhaustive sets are raced directly. */
export function allocateCredentialChecks(
  candidateCount: number,
  vantageCount: number,
  hasInformativeOracle = true,
): CredentialCheckAllocation {
  const candidates = Math.max(0, Math.floor(candidateCount));
  const vantages = Math.max(0, Math.floor(vantageCount));
  if (candidates === 0 || vantages === 0) return { authSlots: 0, bleedSlots: 0 };
  if (vantages === 1) return { authSlots: 1, bleedSlots: 0 };
  if (!hasInformativeOracle) {
    return { authSlots: Math.min(candidates, vantages), bleedSlots: 0 };
  }

  const direct = Math.min(candidates, vantages);
  if (candidates <= 3 && candidates <= vantages) return { authSlots: direct, bleedSlots: 0 };

  let informativeAuth = 1;
  const authCapacity = Math.min(candidates, vantages - 1);
  while (informativeAuth < authCapacity
    && informativeAuth + 2 ** informativeAuth < candidates) informativeAuth++;
  return {
    authSlots: Math.max(1, Math.min(candidates, vantages - 1, informativeAuth)),
    bleedSlots: 1,
  };
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
  const expiry: ExpiryOpts = {
    netDepth: opts.netDepth,
    bitNode: opts.bitNode,
    backdoored: opts.backdoored,
    ...(opts.stasisLinked !== undefined ? { stasisLinked: opts.stasisLinked } : {}),
  };
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

  /** Every attempt this pass wants, with a total ordering across targets.
   * Hostname is the final key so equal candidates remain deterministic.
   *
   * Choosing a target only. Once an attempt has started it is not re-chosen —
   * `canPreempt` refuses same-kind displacement, so an authenticate never
   * cancels an authenticate. */
  const attemptRanking: {
    task: Task;
    /** Higher is better: `difficulty / calls / requiredCharisma`. Difficulty is
     * what the host is WORTH; calls and charisma are what it costs. A rough
     * proxy for real duration and deliberately so — `authenticateWaitMs` needs
     * a timing profile this planner does not have, and an exact number would
     * buy nothing an ordering does not. */
    score: number;
    depth: number;
    difficulty: number;
    maxRam: number;
    host: string;
  }[] = [];
  const attemptScore = (host: DnetHost, calls: number): number =>
    ((host.difficulty ?? 0) + 1)
    / Math.max(1, calls)
    / Math.max(1, host.requiredCharisma ?? 1);

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
    //
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
    const sizedAt = (vantage: string, gbPerThread: number | undefined): number => {
      const attemptRoom = opts.agentFreeGb?.get(vantage);
      return (
      gbPerThread !== undefined && gbPerThread > 0 && attemptRoom !== undefined
        ? Math.max(1, Math.floor(attemptRoom / gbPerThread))
        : 1
      );
    };
    const attemptThreads = sizedAt(workFrom, opts.attemptGbPerThread);
    const bleedThreads = sizedAt(workFrom, opts.bleedGbPerThread);
    const queueFollowerBleed = (attemptIds: readonly string[], used: ReadonlySet<string> = new Set([workFrom])): void => {
      const bleedFrom = free.find((vantage) => !used.has(vantage));
      if (bleedFrom === undefined || !bleedable) return;
      const threads = sizedAt(bleedFrom, opts.bleedGbPerThread);
      tasks.push({
        id: `bleed-after:${attemptIds.join("+")}`,
        kind: "bleed",
        host: host.hostname,
        from: bleedFrom,
        eligibleFrom: [bleedFrom],
        priority: priorityOf("bleed") + rank + BLEED_BAND,
        reason: `prequeued behind ${attemptIds.length} authentication${attemptIds.length === 1 ? "" : "s"}`,
        ...(threads !== 1 ? { threads } : {}),
        followAttemptIds: [...attemptIds],
      });
    };
    // GUESS: an unattributed password whose length and format match this host.
    //
    // It goes FIRST and it suppresses the model attempt below, because the two
    // are the same call against the same host and this one is a single
    // `authenticate` with no penalty for being wrong. A solve that runs while a
    // free candidate is waiting has paid for information the candidate might
    // have made unnecessary.
    // A password can arrive through both the loose and attributed pools. The
    // opaque id is password-derived, so keep the first (attributed entries are
    // ordered first by the controller) and never race the same password twice.
    const candidates: NonNullable<DeriveOptions["guesses"]>[number][] = [];
    const candidateIds = new Set<string>();
    for (const guess of opts.guesses ?? []) {
      if (guess.host !== host.hostname || candidateIds.has(guess.id)) continue;
      candidateIds.add(guess.id);
      candidates.push(guess);
    }
    const guessing = !pendingBleed && !ringBusy
      && candidates.length > 0
      && !vault.has(host.hostname)
      && !busy("attempt", host.hostname);
    if (guessing) {
      const available = free.length > 0 ? free : vantages;
      const feedback = modelEntry(host.modelId)?.feedback;
      const hasInformativeOracle = bleedable && feedback !== undefined
        && feedback !== "none"
        && feedback !== "dictionary"
        && feedback !== "echo"
        && feedback !== "encoded"
        && feedback !== "opaque";
      const allocation = allocateCredentialChecks(candidates.length, available.length, hasInformativeOracle);
      const selected = candidates.slice(0, allocation.authSlots);
      const attemptIds: string[] = [];
      const used = new Set<string>();
      selected.forEach((guess, index) => {
        const vantage = available[index]!;
        const threads = sizedAt(vantage, opts.attemptGbPerThread);
        const id = `guess:${host.hostname}:${guess.id}`;
        attemptIds.push(id);
        used.add(vantage);
        tasks.push({
          id,
          kind: "attempt",
          host: host.hostname,
          from: vantage,
          eligibleFrom: [vantage],
          // Replaced below by the total order over every attempt this pass.
          priority: priorityOf("attempt"),
          reason: guess.reason,
          ...(threads !== 1 ? { threads } : {}),
          guessId: guess.id,
          ...(selected.length > 1 ? { skipInitialBleed: true } : {}),
        });
        attemptRanking.push({
          task: tasks[tasks.length - 1]!,
          // A guess is ONE authenticate with nothing to lose by being wrong,
          // which is what a flat guess bonus was for. Under this score it needs no
          // bonus: one call is the fewest there is.
          score: attemptScore(host, 1),
          depth: host.depth ?? -Infinity,
          difficulty: host.difficulty ?? 0,
          maxRam: host.maxRam ?? 0,
          host: host.hostname,
        });
      });
      if (allocation.bleedSlots === 1) queueFollowerBleed(attemptIds, used);
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
        scheduledAttempt = true;
        tasks.push({
          id: `attempt:${host.hostname}`,
          kind: "attempt",
          host: host.hostname,
          from: workFrom,
          eligibleFrom: free.length > 0 ? free : vantages,
          // Replaced below by the total order over every attempt this pass.
          priority: priorityOf("attempt"),
          reason: attempt.kind === "candidate"
            ? `${entry?.name ?? host.modelId} candidate ${attempt.index + 1}/${attempt.total}`
            : attempt.kind === "solve"
              ? `${entry?.name ?? host.modelId}: ${attempt.note} (up to ${attempt.budget} attempts)`
              : attempt.reason,
          ...(attemptThreads !== 1 ? { threads: attemptThreads } : {}),
          // Only a conversation pays for the ring reader; see `priceOf`.
          ...(needsRing ? { needsRing: true } : {}),
        });
        attemptRanking.push({
          task: tasks[tasks.length - 1]!,
          // Probes and oracle conversations sort behind work that can open a
          // host outright.
          score: attemptScore(host, attempt.kind === "candidate"
            ? Math.max(1, attempt.total - attempt.index)
            : attempt.kind === "solve" ? attempt.budget : 1)
            / (attempt.kind === "probe" ? PROBE_PENALTY
              : attempt.kind === "solve" && attempt.needsOracle ? ORACLE_PENALTY : 1),
          depth: host.depth ?? -Infinity,
          difficulty: host.difficulty ?? 0,
          maxRam: host.maxRam ?? 0,
          host: host.hostname,
        });
        // Calls that do not need an oracle can finish independently; use a
        // second, smaller vantage to arrive at the ring immediately afterward.
        if (!needsRing) queueFollowerBleed([`attempt:${host.hostname}`]);
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
        priority: priorityOf("bleed") + rank + BLEED_BAND,
        reason: pendingBleed
          ? `drain ${ring!.pendingAuthRecords} authentication log record(s)`
          : "drain this identity's initial log ring",
        ...(bleedThreads !== 1 ? { threads: bleedThreads } : {}),
      });
    }
  }

  // PLANT: whatever the spread planner already admitted. It has its own bounds
  // and its own refusals; the queue does not second-guess them.
  //
  // ONE task per VANTAGE, carrying that vantage's whole admitted frontier.
  // A plant is `scp` plus two `exec`s and a wait on the new prober's first
  // report — no Darknet delay call anywhere — so N of them from one vantage
  // have no reason to queue behind N spawns. An agent runs one order at a
  // time; making the order the frontier rather than a single host is what
  // turns the spread from a serial walk into one concurrent wave per hop.
  const frontiers = new Map<string, PlantTarget[]>();
  // The total order, applied. Lower priority number is more urgent, so the
  // best-scoring attempt gets the smallest offset. The offsets stay inside the
  // attempt band (0) and well clear of the next one (bleed at 100).
  attemptRanking.sort((a, b) =>
    b.score - a.score
    || b.depth - a.depth
    || b.difficulty - a.difficulty
    || b.maxRam - a.maxRam
    || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  attemptRanking.forEach((ranked, index) => {
    ranked.task.priority = priorityOf("attempt") + index * 0.01;
  });

  for (const entry of opts.plantable ?? []) {
    if (agents.has(entry.host) || busy("plant", entry.host)) continue;
    const { from, ...target } = entry;
    const frontier = frontiers.get(from) ?? [];
    frontier.push(target);
    frontiers.set(from, frontier);
  }
  for (const [from, targets] of frontiers) {
    tasks.push({
      id: `plant:${from}`,
      kind: "plant",
      // The generic identity every task carries. The frontier is `targets`;
      // this names the deepest of them, which is the one the spread planner
      // ordered first and the scarcest vantage to lose.
      host: targets[0]!.host,
      from,
      targets,
      priority: priorityOf("plant"),
      reason: targets.length === 1
        ? "a credential and room for an agent"
        : `${targets.length} credentials and room for an agent on each`,
    });
  }

  // FARM: the leftovers, and they sort behind everything that learns, spreads
  // or opens the net. A host being farmed is a host with nothing better to do,
  // and the priorities say so — but the queue files in priority order, so a
  // plant derived while a phish is queued still goes in front of it.
  for (const entry of opts.farm ?? []) {
    const from = entry.from ?? entry.host;
    // A gang grinder dedups per (kind, target, VANTAGE) — the same treatment
    // an induce push gets, and for the same reason: several vantages work the
    // same target at once, so a per-target check would file only the first.
    const claimed = entry.perVantage === true
      ? (opts.inFlight?.get(entry.host) ?? []).some((claim) => claim.kind === entry.kind && claim.from === from)
      : busy(entry.kind, entry.host);
    if (claimed) continue;
    tasks.push({
      id: entry.perVantage === true ? `${entry.kind}:${entry.host}:${from}` : `${entry.kind}:${entry.host}`,
      kind: entry.kind,
      host: entry.host,
      from,
      priority: priorityOf(entry.kind),
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
    // Per-vantage work dedups on (kind, target, vantage). Today that is induce:
    // several callers may charge one target because its migration charge is
    // additive. Every other hold kind keeps the plain per-target check.
    const perVantage = JOBS[entry.kind].perVantage === true;
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
      priority: priorityOf(entry.kind),
      reason: entry.reason,
      ...(entry.threads !== undefined && entry.threads !== 1 ? { threads: entry.threads } : {}),
      ...(entry.edge !== undefined ? { edge: entry.edge } : {}),
      ...(entry.unpin === true ? { unpin: true } : {}),
    });
  }

  tasks.sort(compareQueuedDnetWork);
  return tasks;
}

// --- spread ------------------------------------------------------------------

/** Where to put the next agent, and why not everywhere else.
 *
 * Every reachable neighbour gets an agent. Each rejection names a current host
 * constraint so the panel can explain why expansion stopped.
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

/** How a plant reaches its target, on the two-axis rule spec/dnet.md:633-637
 * makes explicit — one axis, WHO may launch:
 *
 * - `adjacent`: the vantage and target share a still-believed edge (either
 *   direction of symmetric adjacency). The plant may `authenticate` if the
 *   session has lapsed, because it holds a direct connection.
 * - `remote`: no fresh edge, but the target's backdoor or stasis fact still
 *   makes remote `exec` believable, so ANY live resident is a vantage. The
 *   plant is session-only — it cannot `authenticate` at a distance.
 * - `ineligible`: neither — nothing may plant it this pass.
 *
 * The SECOND axis (stasis-durability → controller-managed) is deliberately
 * NOT decided here: it is the target's own property, keyed on stasis alone by
 * the controller, and a merely-backdoored host must keep its ordinary spawn
 * chain (agent.ts adoption/respawn). Conflating the two would mis-size a
 * backdoored resident and kill it at its first uncovered spawn. */
export type PlantRoute = "adjacent" | "remote" | "ineligible";

/** Classify one (vantage, target) pair. Adjacency WINS over remote: an
 * edge-backed launch keeps its authentication fallback, which a bare session
 * cannot, so it is strictly the safer route when both are available. */
export function classifyPlantRoute(input: {
  target: string;
  vantage: string;
  /** The vantage's own fresh neighbour list (stale groups already deleted). */
  vantageNeighbours: readonly string[] | undefined;
  /** The target's own fresh neighbour list — the reverse adjacency direction,
   * the only vantage an immune host is often reachable from. */
  targetNeighbours: readonly string[] | undefined;
  /** Target's backdoor/stasis fact is fresh enough to believe remote exec. */
  remoteExecCapable: boolean;
}): PlantRoute {
  const adjacent =
    (input.vantageNeighbours?.includes(input.target) ?? false) ||
    (input.targetNeighbours?.includes(input.vantage) ?? false);
  if (adjacent) return "adjacent";
  if (input.remoteExecCapable) return "remote";
  return "ineligible";
}

/** One host on a vantage's plant frontier, with the three facts that change
 * how it is launched. */
export interface PlantTarget {
  host: string;
  /** Reuse a global rooted session instead of the current adjacency. */
  remote?: boolean;
  /** Launch the minimal spawn-free self reclaimer, not prober+resident. */
  bootstrapReclaim?: boolean;
  bootstrapThreads?: number;
  /** The pinned lab candidate never shares RAM with a prober. */
  omitProber?: boolean;
}

export interface SpreadCandidate {
  host: string;
  /** Where a worker would have to be STANDING to do this. */
  from: string;
  /** The target is not adjacent; this vantage reuses a global rooted session
   * through a still-believable backdoor or stasis link. */
  remote?: boolean;
  depth?: number;
  usableRam?: number;
  /** Fresh owner block. A cramped host with some runnable RAM gets a minimal
   * local reclaimer instead of waiting until a full resident+prober fits. */
  blockedRam?: number;
  /** Lab candidate: reclaim locally without a prober, then plant only a
   * resident. The walker subsequently takes the entire pinned host. */
  reclaimOnly?: boolean;
  omitProber?: boolean;
  /** Stasis-linked target: its resident is controller-managed and spawn-free. */
  stasisManaged?: boolean;
  bootstrapReclaim?: boolean;
  bootstrapThreads?: number;
  hasCredential: boolean;
  /** A live agent is already here. */
  agentAlive: boolean;
  goneAt?: number;
}

export interface SpreadLimits {
  /** RAM the payload needs. The surveyor is the small one; a breaker needs more,
   *  and the caller picks which it is asking about. */
  agentRamGb: number;
  /** Resident alone, for the pinned lab candidate. */
  residentRamGb: number;
  /** The spawn-free controller-managed resident a stasis-linked host runs. */
  managedResidentRamGb: number;
  /** The constant prober, priced separately so a managed plant's bar is
   *  managed resident + prober rather than the unmanaged `agentRamGb`. */
  proberRamGb: number;
  /** The prober a STASIS-linked host actually runs, which is not the same one.
   *
   *  It drops `exec` (1.3 GB): the engine's mutation guard exempts a linked
   *  host, so it can never lose the processes `exec` exists to relaunch, and
   *  `plantOne` already execs it at this smaller size. Pricing the managed
   *  branch at the full `proberRamGb` demanded 1.3 GB that the plant was never
   *  going to spend, and refused the deepest hosts we hold for want of it. */
  managedProberRamGb: number;
  /** One thread of the spawn-free local reclaim bootstrap. */
  bootstrapRamGb: number;
}

/** The prices a caller that is NOT the controller plans against.
 *
 * The controller overrides every field from `game/dnet/shared.ts` at boot, so
 * these serve the sim lanes and the planner tests — which is exactly why they
 * must agree with it. They did not: `agentRamGb` and `residentRamGb` still
 * carried the 2.0 GB `spawn` of a resident that has not launched its own
 * successor since the controller started dispatching, and `proberRamGb` predated
 * `exec` joining the prober's surface. `tests/ram-budget.test.ts` now pins each
 * one against the constant it mirrors, so this cannot drift again.
 *
 * This layer may not import `game/`, which is why they are literals at all. */
export const DEFAULT_SPREAD_LIMITS: SpreadLimits = {
  agentRamGb: 4.75,
  residentRamGb: 1.6,
  managedResidentRamGb: 1.6,
  // base 1.6 + exec 1.3 + dnet.probe 0.2 + dnet.connectToSession 0.05.
  proberRamGb: 3.15,
  managedProberRamGb: 1.85,
  bootstrapRamGb: 2.6,
};

/** Every refusal is a fact about the host in front of us. */
export type RefusalReason =
  | "gone"
  | "agent-alive"
  | "no-credential"
  | "not-enough-ram"
  | "unknown-ram"
  /** Emitted by the CALLER, not this planner: `candidatesFrom` returns the
   *  hosts a plant could be aimed at and says nothing about the rest, so a
   *  host no vantage can reach never entered `planSpread` at all and had no
   *  refusal of its own. That is the commonest reason a cracked host sits
   *  empty, and it was the one reason the panel could not name. */
  | "no-route"
  /** Also emitted by the CALLER: the host is not a candidate because a process
   *  has already been launched at it and has not adopted yet. Distinct from
   *  `no-route`, which says the opposite — that nothing is coming. Reading one
   *  as the other sent a whole debugging session after a routing bug that was
   *  really a launch that never landed. */
  | "launching";

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
): SpreadPlan {
  const plant: SpreadCandidate[] = [];
  const refused: Refusal[] = [];

  const ordered = [...candidates].sort((a, b) => {
    const byDepth = compareDepthDesc(a.depth, b.depth);
    if (byDepth !== 0) return byDepth;
    const ra = a.usableRam ?? -1;
    const rb = b.usableRam ?? -1;
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
    if (candidate.usableRam === undefined) {
      // Unknown capacity must never read as "room for an agent": exec would
      // return a silent 0, indistinguishable from a host that is simply full.
      refuse("unknown-ram", "no believable RAM facts; survey it before planting");
      continue;
    }
    // A stasis target needs only its managed resident and optional prober.
    const needed = candidate.stasisManaged === true
      ? limits.managedResidentRamGb + (candidate.omitProber ? 0 : limits.managedProberRamGb)
      : candidate.omitProber
        ? limits.residentRamGb
        : limits.agentRamGb;
    // Bootstrap reclaim is reserved for the pinned lab candidate whose block
    // gates the walk. Ordinary cramped hosts wait for normal reclaim capacity.
    if (candidate.blockedRam !== undefined && candidate.blockedRam > 0
      && candidate.reclaimOnly === true
      && candidate.usableRam >= limits.bootstrapRamGb) {
      plant.push({
        ...candidate,
        bootstrapReclaim: true,
        bootstrapThreads: Math.floor(candidate.usableRam / limits.bootstrapRamGb),
      });
      continue;
    }
    if (candidate.usableRam < needed) {
      refuse(
        "not-enough-ram",
        `${candidate.usableRam.toFixed(2)}GB usable, needs ${needed.toFixed(2)}GB`
        + " — usually the owner's block, which memoryReallocation would have to grind down",
      );
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
    /** Targets whose backdoor/stasis fact is fresh enough for remote exec. */
    remoteExec?: ReadonlySet<string>;
    /** Live resident queues able to run a session-only remote plant. */
    remoteVantages?: readonly { host: string; freeGb?: number }[];
    /** Stasis-LINKED hosts, whose plant boots the cheaper managed resident. */
    stasisLinked?: ReadonlySet<string>;
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
    // Adjacency is SYMMETRIC (either side of a believed edge names the other)
    // and WINS over remote — an edge keeps the authentication fallback a bare
    // session lacks. The reverse direction (the target's own fresh neighbour
    // list naming a standing host) recovers a host we can no longer see from
    // outside — an immune (stasis) host above all, whose neighbour list never
    // expires and is frequently the ONLY vantage we get on it. The plant job
    // re-probes the live edge in its preflight, so a since-severed edge
    // refuses cleanly rather than being planted blind.
    const remoteExecCapable = opts.remoteExec?.has(host.hostname) ?? false;
    for (const where of opts.standing) {
      if (classifyPlantRoute({
        target: host.hostname,
        vantage: where,
        vantageNeighbours: views.get(where)?.neighbours,
        targetNeighbours: host.neighbours,
        remoteExecCapable: false,
      }) === "adjacent") {
        from = where;
        break;
      }
    }
    // Remote fallback: no adjacent vantage, but the target's backdoor/stasis
    // fact still makes remote exec believable, so ANY live resident serves —
    // pick the roomiest (name tie-break) so the volley has headroom.
    if (from === undefined && remoteExecCapable) {
      const vantage = [...(opts.remoteVantages ?? [])]
        .filter((candidate) => opts.standing.has(candidate.host))
        .sort((a, b) => (b.freeGb ?? -1) - (a.freeGb ?? -1)
          || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))[0];
      if (vantage !== undefined &&
        classifyPlantRoute({
          target: host.hostname,
          vantage: vantage.host,
          vantageNeighbours: views.get(vantage.host)?.neighbours,
          targetNeighbours: host.neighbours,
          remoteExecCapable,
        }) === "remote") {
        from = vantage.host;
        remote = true;
      }
    }
    if (from === undefined) continue;
    const raw = hosts.get(host.hostname);
    out.push({
      host: host.hostname,
      from,
      ...(remote ? { remote: true } : {}),
      ...(host.depth !== undefined ? { depth: host.depth } : {}),
      usableRam: viewedUsableRam(host),
      ...(host.blockedRam !== undefined ? { blockedRam: host.blockedRam } : {}),
      ...(opts.stasisLinked?.has(host.hostname) ? { stasisManaged: true } : {}),
      hasCredential: opts.vault.has(host.hostname),
      agentAlive: false,
      ...(raw?.goneAt !== undefined ? { goneAt: raw.goneAt } : {}),
    });
  }
  return out;
}

/** Usable script capacity over an already-viewed record. Runtime occupancy is
 * owned by the controller's live handles, not retained as host knowledge. */
function viewedUsableRam(view: DnetHost): number {
  if (view.maxRam === undefined) return 0;
  const blocked = view.blockedRam ?? 0;
  return Math.max(0, view.maxRam - blocked);
}

// --- storm -------------------------------------------------------------------

/** When to fire the storm — the endgame cache farm, and the one decision in the
 * feature that destroys most of what we know on purpose.
 *
 * `unleashStormSeed` fires `STORM_SEED.exe` from the host holding it and
 * discharges the whole mutation clock in one ~30-second burst: deletion targets
 * `0.6 * movable + random(0, netDepth) - 6`, then more hosts move, every
 * movable survivor restarts, and forty fresh ones are added.
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
  /** Hosts whose residual block `planFarm` refused to grind ON BUDGET this
   *  pass (`reclaim-not-needed`). Gate 4 exempts their `blockedRam` — the farm
   *  has already decided that block is not worth the wall clock, and a storm
   *  gate that still demands it produces a standing deadlock: the grind never
   *  happens AND the fire never fires. Built from the same `FarmPlan`'s
   *  refusals, so the two rules cannot disagree. */
  budgetRefusedBlocks?: ReadonlySet<string>;
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
  /** A storm is being fired NOW, or is already burning.
   *
   * This is the window in which the whole movable fleet is about to be
   * restarted at once, and `planArmour` spends it arming. It deliberately does
   * NOT include "every gate but the phish window is green": that state is the
   * established net's RESTING state — a seed in hand, harvest done, links
   * spent, waiting on the next `.d.cache` — and it persists for long stretches.
   * Treating it as imminent kept the fleet armed roughly half the time and
   * billed 245 GB-h against 10 GB-h of stranded capacity, which is the blanket
   * reserve this policy exists to avoid.
   *
   * The lead time comes from the controller's own pessimism instead: it stamps
   * `lastStormFiredAt` at CLAIM time, before the call, so `storm-in-flight`
   * opens seconds ahead of the engine's 5 s warning and well ahead of the phase
   * that actually restarts anything. */
  imminent: boolean;
  /** Every gate but the phish window is green: a seed is in hand on a
   * reachable host, the harvest is done, the links are spent and the walker is
   * safe. The storm fires on the next `.d.cache`.
   *
   * This is the established net's RESTING state and it persists for long
   * stretches, so it is reported separately from `imminent` rather than folded
   * into it. Arming on it buys lead time — more of the fleet reaches an order
   * boundary before the burst — at the cost of wearing armour while nothing is
   * happening. `bench:sim:dnet-farm` prices both. */
  awaitingPhishWindow?: boolean;
  refused: StormRefusal[];
}

/** The net-wide gates refuse against this pseudo-host, so the panel has one row
 * to hang them on even when no seed has ever been sighted. */
const NET = "(net)";

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
    // Imminent only until the restart WAVE has passed, which is a much shorter
    // window than the quiet period this gate enforces. The burst restarts every
    // movable survivor once, in one synchronous block ~5 s in, and does nothing
    // restart-shaped afterwards — so armour worn past that point is worn for an
    // event that has already happened.
    //
    // The lead-in is the controller's own pessimism: `lastStormFiredAt` is
    // stamped at claim time, before the call, so this opens ahead of the
    // engine's warning rather than behind it.
    return { imminent: ctx.now - ctx.lastStormFiredAt < STORM_RESTART_BY_MS, refused };
  }

  // 2. Prefer a live, stasis-linked seed holder, then break ties by name.
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
    return { imminent: false, refused };
  }
  // Prefer a holder that can fire now; otherwise retain the sorted refusal target.
  const holder = holders.find((candidate) => candidate.agentAlive === true) ?? holders[0]!;

  // 3. The fire job runs ON the holder; the file cannot be scp'd off it.
  if (holder.agentAlive !== true) {
    refuse(holder.hostname, "seed-unreachable", "the seed's host has no resident, and the seed cannot be moved; waiting for a plant");
    return { imminent: false, refused };
  }

  const incomplete = hosts.find((host) => host.goneAt === undefined && host.isStationary !== true && (
    !ctx.vault.has(host.hostname)
    || host.blockedRam === undefined
    // A block the farm refused ON BUDGET does not hold the fire: it was never
    // going to be ground, and demanding it here would deadlock the storm.
    || (host.blockedRam > 0 && ctx.budgetRefusedBlocks?.has(host.hostname) !== true)
    || host.caches === undefined
    || host.caches.length > 0
    || [...(host.busy ?? [])].some((kind) => isTaskKind(kind) && JOBS[kind].harvest === true)
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
    return { imminent: false, refused };
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
    return { imminent: false, refused };
  }

  // 6. A running walker must be pinned before a reroll.
  if (!ctx.labWalked && ctx.walkInFlight && !ctx.walkerPinned) {
    refuse(holder.hostname, "walker-unpinned", "a finisher is mid-walk on an unpinned host; a restart costs the whole walk");
    return { imminent: false, refused };
  }

  // 7. Fire into the dead phish window, not across an open one. Never having
  // seen a `.d.cache` reads as open — the conservative side, and it corrects
  // itself within one cache.
  const overlapMs = STORM_PHISH_OVERLAP_MS;
  if (ctx.lastPhishCacheAt === undefined || ctx.now - ctx.lastPhishCacheAt > overlapMs) {
    refuse(
      holder.hostname,
      "phish-window-open",
      ctx.lastPhishCacheAt === undefined
        ? "no .d.cache ever sighted; waiting to fire just after one lands"
        : `last .d.cache landed ${Math.round((ctx.now - ctx.lastPhishCacheAt) / 1000)}s ago; firing only within ${Math.round(overlapMs / 1000)}s of one`,
    );
    // NOT imminent — but READY. Every other gate is green, so the storm fires
    // on the next `.d.cache`. That is the only lead time anyone gets, and
    // whether it is worth arming on is a measured question, not a definition:
    // see `awaitingPhishWindow`.
    return { imminent: false, awaitingPhishWindow: true, refused };
  }

  return {
    imminent: true,
    fire: {
      host: holder.hostname,
      from: holder.hostname,
      reason: "unleash STORM_SEED.exe: reroll the net inside the dead phish window",
    },
    refused,
  };
}

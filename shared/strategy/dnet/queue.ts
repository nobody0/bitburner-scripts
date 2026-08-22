import { expiryMs, fresh, type DarknetKnowledge, type DarknetHostKnowledge } from "./knowledge.ts";
import { modelEntry, planAttempt } from "./models.ts";
import { shouldListen, type ListenContext, type ListenRefusal, type ListenTarget } from "./listen.ts";

/** What there is to do out there, and who is doing it.
 *
 * The controller does not keep a task list. It DERIVES one, and that is the
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
 * multi-second `authenticate`. Today that is hidden by the controller's
 * per-queue duplicate check, and the moment a target has two adjacent vantages
 * the check stops covering it and the same authenticate fires twice.
 *
 * So `inFlight` is admitted here, and it is deliberately as small as it can be:
 * `(target -> {from, kind})`, DATA ONLY. The controller's own claims carry a
 * password; those never reach this module, because a pure function that held a
 * credential would eventually be asked to explain itself in a log line. */

/** The four jobs that LEARN or SPREAD, the four that FARM, and the three
 * DELIBERATE ones.
 *
 * `cache`, `reclaim`, `phish` and `promote` are decided by
 * `shared/strategy/dnet/farm.ts`, and `pin`, `induce` and `walk` by
 * `shared/strategy/dnet/hold.ts`. Both are merged here exactly as `plant` is
 * merged from `spread.ts`: the queue does not second-guess a planner that has
 * already named its refusals. */
export type TaskKind =
  | "survey"
  | "bleed"
  | "attempt"
  | "plant"
  | "cache"
  | "reclaim"
  | "phish"
  | "promote"
  // --- the deliberate three, from `hold.ts` -----------------------------------
  //
  // Merged exactly as `plant` and the farm rungs are: `planStasis`, `planInduce`
  // and the walker's own gate have already named their refusals, and the queue
  // does not second-guess a planner that has.
  | "pin"
  | "induce"
  | "walk";

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
  /** Which unattributed password an `attempt` task is spending, BY REFERENCE.
   *
   *  The password itself never enters this module. A log's `--<password>--`
   *  line names no owner, so the controller matches it against the length and
   *  format facts it already holds and hands the result over as an opaque id;
   *  the id is what the job state's `guess` is resolved from, back in the
   *  controller, where credentials live. Same rule `inFlight` keeps, and for
   *  the same reason: a pure function that held a credential would eventually
   *  be asked to explain itself in a log line. */
  guessId?: string;
}

export interface DeriveOptions {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  // No `stasisLinked` here, deliberately. Stasis is a HOME decision — the
  // controller never sees the set — so a stasis-linked host looks perishable to
  // the queue and gets re-surveyed a little sooner than it needs to be. That
  // errs toward re-observing, which is the safe direction, and plumbing a
  // fourth channel to save a few jobs on at most four hosts is not worth it.
  // `isStationary` needs no plumbing: it is an identity fact, so `fresh` works
  // immunity out per host on its own.
  /** Hosts with a live agent, so we do not survey what is already being watched
   *  and do not plant where someone is standing. */
  agents?: ReadonlySet<string>;
  /** Hosts we hold a credential for. */
  vault?: ReadonlySet<string>;
  /** Hosts admitted by `planSpread`, already filtered and ordered. */
  plantable?: readonly { host: string; from: string }[];
  /** Farm work admitted by `planFarm`, already laddered and thread-sized. All
   *  four calls act on the host the script stands on, so the vantage IS the
   *  target and there is no pairing to do here. */
  farm?: readonly {
    kind: "cache" | "reclaim" | "phish" | "promote";
    host: string;
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
    kind: "pin" | "induce" | "walk";
    host: string;
    from: string;
    threads?: number;
    reason: string;
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
  /** Work a live process is already doing, keyed by TARGET. A `(kind, target)`
   *  pair in here emits no task.
   *
   *  Data only, and never a password: see the note above. The controller builds
   *  it from `DnetClaim` by naming the two fields it may pass, so a field added
   *  to a claim later cannot leak in by default. */
  inFlight?: ReadonlyMap<string, readonly { from: string; kind: TaskKind }[]>;
  /** Filled IN by the derivation: why each host we declined to listen to was
   *  declined, by name.
   *
   *  An out-parameter rather than a second return value, because `deriveTasks`
   *  returns the task list and every caller destructures it. Same contract
   *  `planSpread` and `planFarm` already keep: a planner that has run out of
   *  work must not look like one that has stopped working, and until now the
   *  bleed gate was the last decision in this file with no name for its "no". */
  listenOut?: { refused: Record<string, number>; examples: { host: string; why: string; detail: string }[] };
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
  phish: 400,
  // Last of everything, which is what "the bottom rung" means once the ladder's
  // one-rung-per-host rule has already decided nothing else fits.
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
const HOLD_PRIORITY: Readonly<Record<"pin" | "induce" | "walk", number>> = {
  // THE PIN GOES FIRST, and the order is load-bearing rather than aesthetic.
  // A host runs ONE process at a time, and a walk holds its host for hours — so
  // a pin queued behind a walk is a pin that starts after the thing it exists
  // to protect has already finished. The sequence that works is pin, re-plant,
  // walk: the pin's process ends without handing the host back (it cannot
  // afford the spawn), `planSpread` puts a resident back a tick later, and the
  // walk then starts on a host the mutation clock can no longer touch.
  pin: -95,
  walk: -90,
  // A project of hundreds of calls whose value arrives at the end, so it waits
  // behind anything that opens the net.
  induce: 200,
};

/** Every place a process could stand to reach `host`, best first.
 *
 * ALL of them, not the first one found, because two jobs against one target are
 * two calls the target's own log ring has to interleave — and because
 * `authenticate` and `heartbleed` both need adjacency, so running them from
 * different neighbours is the only way to overlap them at all.
 *
 * Ordered: the host itself first when we are standing on it (a resident is
 * already there, and self counts as directly connected), then every resident
 * neighbour BY NAME. Sorted rather than in `agents` iteration order, because
 * that order is insertion order and would make the derived queue depend on the
 * sequence in which hosts happened to be planted.
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
  const neighbourly: string[] = [];
  for (const agentHost of agents) {
    if (agentHost === host.hostname) continue;
    const standing = knowledge.hosts[agentHost];
    if (!standing) continue;
    const neighbours = fresh<string[]>(standing, "neighbours", now, expiry);
    if (neighbours?.includes(host.hostname)) neighbourly.push(agentHost);
  }
  neighbourly.sort();
  return agents.has(host.hostname) ? [host.hostname, ...neighbourly] : neighbourly;
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

  // Branch 6 of the noise generator leaks a password belonging to some OTHER
  // movable host, so its value is a property of the NET rather than of the host
  // being listened to: while one movable host anywhere is still shut, every ring
  // in the net is worth reading for that branch alone. Computed once — per-host
  // it would be both wrong-shaped and quadratic.
  const netHasUncrackedMovable = Object.values(knowledge.hosts).some((host) =>
      host.goneAt === undefined
      && fresh<boolean>(host, "isStationary", now, {
        netDepth: opts.netDepth,
        bitNode: opts.bitNode,
        backdoored: opts.backdoored,
      }) !== true
      && !vault.has(host.hostname));

  for (const host of Object.values(knowledge.hosts)) {
    if (host.goneAt !== undefined) continue;
    const vantages = vantagesFor(host, knowledge, now, opts);
    if (vantages.length === 0) continue;
    const from = vantages[0]!;
    // Vantages a live job is already working this target from. A second job
    // launched from the same host would queue behind the first anyway — one
    // resident, one process — so the pairing below spends the other neighbours
    // instead of stacking.
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

    // Whether a bleed is wanted is decided BEFORE the attempt is planned,
    // because the two are a pair: they are the same round trip against the same
    // ring, and splitting them across two neighbours is what lets them overlap.
    // `heartbleed` with `peek` leaves the ring intact, so nothing marks a host
    // as recently listened to except our own stamp.
    //
    // The gate used to be "has it been longer than the topology expiry", which
    // is a clock and not a reason. `shouldListen` prices the call instead: how
    // many lines the ring will have minted since we last looked, times the
    // chance a line carries something we do not already hold. The two scaling
    // laws pull in OPPOSITE directions — a deep host is chatty but its
    // neighbour-credential branch is 30x rarer — so no single proxy works, and
    // a clock is the worst of them.
    const lastBleedAt = host.facts["lastBleedAt"]?.at ?? 0;
    const neighbours = fresh<string[]>(host, "neighbours", now, expiry);
    const target: ListenTarget = {
      hostname: host.hostname,
      ...(fresh<number>(host, "difficulty", now, expiry) !== undefined
        ? { difficulty: fresh<number>(host, "difficulty", now, expiry)! }
        : {}),
      ...(fresh<number>(host, "logTrafficInterval", now, expiry) !== undefined
        ? { logTrafficIntervalSec: fresh<number>(host, "logTrafficInterval", now, expiry)! }
        : {}),
      ...(fresh<string>(host, "modelId", now, expiry) !== undefined
        ? { modelId: fresh<string>(host, "modelId", now, expiry)! }
        : {}),
      hasCredential: vault.has(host.hostname),
      uncrackedNeighbours: (neighbours ?? []).filter((name) => !vault.has(name)).length,
      topologyStale: neighbours === undefined,
      // Its ring holds our OWN attempt records, which is the only channel a
      // model's feedback ever uses — so a host mid-solve is always worth a look.
      solveInFlight: host.attempts?.solver !== undefined,
      ...(lastBleedAt > 0 ? { lastBleedAt } : {}),
    };
    // `charismaOk` reads as net-wide on `ListenContext` but its refusal says
    // "this host is above us", so it is the PER-HOST gate — the same `bleedable`
    // the attempt path uses. Only `netHasUncrackedMovable` is genuinely net-wide.
    const context: ListenContext = { netHasUncrackedMovable, charismaOk: bleedable };
    const verdict = shouldListen(target, now, context);
    // A refusal the derivation makes is only useful if it is attributable, and
    // "busy" and "nowhere to stand" are OURS rather than the model's — so they
    // are not counted here, where they would drown the three that mean
    // something about the host.
    const reachable = agents.has(host.hostname) || vault.has(host.hostname);
    if (reachable && !busy("bleed", host.hostname) && verdict.refusal !== undefined && opts.listenOut) {
      const out = opts.listenOut;
      out.refused[verdict.refusal] = (out.refused[verdict.refusal] ?? 0) + 1;
      if (out.refused[verdict.refusal] === 1) {
        out.examples.push({ host: host.hostname, why: verdict.refusal, detail: verdict.why });
      }
    }
    const wantsBleed = verdict.worth && !busy("bleed", host.hostname) && reachable;
    // The bleed takes the first vantage nobody is using; the attempt takes one
    // the bleed is NOT using. With a single vantage both fall back to it, which
    // is exactly the behaviour before there was ever a choice to make.
    const bleedFrom = free[0] ?? from;
    const attemptFrom = (wantsBleed ? free.find((vantage) => vantage !== bleedFrom) : undefined)
      ?? free[0]
      ?? from;

    // SURVEY: only when the adjacency we hold has stopped being believable.
    // While it is fresh there is nothing to learn, so there is no task, so two
    // workers cannot both go and learn it.
    if (fresh<string[]>(host, "neighbours", now, expiry) === undefined && !busy("survey", host.hostname)) {
      tasks.push({
        id: `survey:${host.hostname}`,
        kind: "survey",
        host: host.hostname,
        from,
        priority: rank,
        reason: host.facts["neighbours"] ? "adjacency expired" : "never surveyed",
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
    const guessing = candidates.length > 0
      && !vault.has(host.hostname)
      && !busy("attempt", host.hostname);
    if (guessing) {
      const guess = candidates[0]!;
      tasks.push({
        id: `guess:${host.hostname}:${guess.id}`,
        kind: "attempt",
        host: host.hostname,
        from: attemptFrom,
        // Below every model attempt on the same host and above every survey:
        // one call, no oracle, no charisma gate.
        priority: rank - 5,
        reason: guess.reason,
        guessId: guess.id,
      });
    }

    // ATTEMPT: only for a host we cannot already open, and only while its model
    // has something left to try.
    if (!guessing && !vault.has(host.hostname) && host.hostname !== "darkweb" && !busy("attempt", host.hostname)) {
      const modelId = fresh<string>(host, "modelId", now, expiry);
      const entry = modelEntry(modelId);
      const ledger = host.attempts;
      const attempt = planAttempt(
        entry,
        {
          ...(fresh<number>(host, "passwordLength", now, expiry) !== undefined
            ? { passwordLength: fresh<number>(host, "passwordLength", now, expiry)! }
            : {}),
          ...(fresh<string>(host, "passwordFormat", now, expiry) !== undefined
            ? { passwordFormat: fresh<string>(host, "passwordFormat", now, expiry)! }
            : {}),
        },
        ledger?.tried ?? 0,
        ledger?.probes ?? 0,
        opts.probeLimit ?? 1,
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
            ? (attempt.needsOracle ? 10 : 0)
            : 50;
        tasks.push({
          id: `attempt:${host.hostname}`,
          kind: "attempt",
          host: host.hostname,
          from: attemptFrom,
          priority: rank + surcharge,
          reason: attempt.kind === "candidate"
            ? `${entry?.name ?? modelId} candidate ${attempt.index + 1}/${attempt.total}`
            : attempt.kind === "solve"
              ? `${entry?.name ?? modelId}: ${attempt.note} (up to ${attempt.budget} attempts)`
              : attempt.reason,
        });
      }
    }

    // BLEED: a host we can already open is still worth listening to, because its
    // logs leak its NEIGHBOURS' passwords. That is the cheapest credential in
    // the game and it owes nothing to any minigame.
    if (wantsBleed) {
      tasks.push({
        id: `bleed:${host.hostname}`,
        kind: "bleed",
        host: host.hostname,
        from: bleedFrom,
        // Ordered by expected useful lines WITHIN the +10 band, never across it:
        // a host with a lot to say goes before one with a little, and neither
        // goes before a survey. Clamped so a single very chatty host cannot
        // reach into the band below.
        priority: rank + 10 - Math.min(9, Math.round(verdict.value)),
        // The verdict's own sentence, so the queue says WHY rather than
        // repeating a constant.
        reason: verdict.why,
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
      // Placing a process is the scarcest thing we do — it is the only action
      // that grows the set of places we can act FROM — so it outranks everything.
      priority: -100,
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
      from: entry.host,
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
    if (busy(entry.kind, entry.host)) continue;
    tasks.push({
      id: `${entry.kind}:${entry.host}`,
      kind: entry.kind,
      host: entry.host,
      from: entry.from,
      priority: HOLD_PRIORITY[entry.kind],
      reason: entry.reason,
      ...(entry.threads !== undefined && entry.threads !== 1 ? { threads: entry.threads } : {}),
    });
  }

  tasks.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tasks;
}

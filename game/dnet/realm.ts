import type { NS } from "@ns";
import type { AttemptOutcome, LogDrainOutcome, ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import type { TaskKind } from "../../shared/strategy/dnet/queue.ts";

/** The rendezvous the overseer and its resident agents meet at.
 *
 * This is `game/lib/dodge-shared.ts` for the darknet, and the differences are
 * all forced by one thing: RAM out there is scarce, uneven, and can vanish.
 *
 * ## The shape
 *
 * - The **overseer** is long-lived and holds every piece of state: the map,
 *   the credentials, and a QUEUE of work per darknet host. It never spawns and
 *   never execs, because it must not die and `spawn` kills its caller.
 * - Each darknet host holds exactly one **resident**, also long-lived. It is the
 *   only thing that can start work there.
 * - When the resident takes a job it `spawn`s into it with `spawnDelay: 0`,
 *   which kills the resident and starts the job immediately on the same host.
 *   The job runs, settles its promise, and spawns back to resident mode.
 *
 * So a host holds ONE agent process at a time, and its peak RAM is the largest
 * single link rather than the sum of everything running.
 *
 * ## Why not just exec
 *
 * `ns.exec` leaves the caller alive, so a resident that exec'd its jobs would
 * have both resident and job resident at once — `(1.6 + 1.3) + (1.6 + calls)`.
 * `spawn` costs 2.0 against exec's 1.3, but it frees the caller first, so the
 * peak is `max(resident, 1.6 + calls + 2.0)` instead of a sum. On the heaviest
 * job that is ~5.9 GB against ~6.8 GB, and on a host with a few gigabytes free
 * it is the difference between a job running and not running at all.
 *
 * **The tax is real and is stated rather than buried:** every job pays 2.0 GB
 * for the spawn back to resident mode. A chain of trivial steps would be WORSE
 * than one script. It pays here because darknet jobs are individually expensive
 * and because the alternative — leaving a host with no resident — cannot be
 * repaired from outside: re-planting one needs a session AND adjacency, which
 * the overseer has to nothing but `darkweb`.
 *
 * ## The rule that nearly makes it impossible, and the 0.05 GB that saves it
 *
 * A session belongs to the PID that won it, and `spawn` ends the PID. So a job
 * that authenticates cannot hand the session back to the resident, and the
 * ladder `authenticate -> scp -> exec` looks like it must be one process that
 * never spawns.
 *
 * `connectToSession(host, password)` re-acquires a session at any distance, with
 * no delay and no direct-connection requirement, for **0.05 GB**. So the queue
 * carries the password and any link that needs the session re-opens it for
 * almost nothing. That is what makes the chain viable at all.
 *
 * ## The rendezvous
 *
 * The job design depends on the overseer describing work it cannot afford to
 * perform and handing the description to a process that can — a live function
 * reference, which is why the conversation lives in the page realm rather than
 * in anything written down. That is not a shortcut past a game rule: what
 * preserves BN15's challenge is enforced by the engine — sessions are per-PID,
 * `probe()` is host-local, and the network kills your scripts.
 *
 * The hazard is that the realm holds live references that outlive the hosts they
 * describe, so four rules are enforced in this file:
 *
 * 1. **Entries are expired, never trusted.** A resident that stops beating is
 *    swept and its queue retired (`sweepQueues`); a job that stops settling is
 *    timed out; a claim on work whose vantage or job is gone is dropped
 *    (`sweepClaims`). A realm reference to a dead host is exactly the hazard.
 * 2. **A foreign generation is refused** (`overseerIsLive`), because agents
 *    outlive overseers and a live script from a dead run describes a world
 *    this one does not share.
 * 3. **Home keeps its own fold.** `drain()` hands observations over ONCE and
 *    home folds them into knowledge it owns, so an overseer dying loses
 *    scheduling rather than the map.
 * 4. **A credential never reaches telemetry.** It lives in the overseer's
 *    vault and in home's, and `publishKnowledge` publishes a boolean. */

/** Bumped from 1 when `claims` joined the rendezvous. It is a version on the
 * SHAPE, and the reason it has to move is that agents outlive overseers and a
 * build handoff leaves both on disk: an agent from the previous build reading a
 * rendezvous whose shape moved under it is a bug with no symptom. Refusing by
 * number makes it exit instead. */
export const RENDEZVOUS_PROTOCOL = 3;

/** The script base, which every allocation starts from. Transcribed rather than
 * read, because a launcher sizes a process it has not started yet.
 * Source: src/Netscript/RamCostGenerator.ts RamCostConstants.Base */
export const SCRIPT_BASE_GB = 1.6;

/** Headroom over the priced cost, matching `game/lib/dodge.ts`'s reasoning: the
 * engine compares DYNAMIC usage against the allocation and kills the script on
 * overrun, so an exact price is a coin flip — any call a body makes that is not
 * in its method list is fatal. Half a gigabyte is cheap next to losing the job. */
const PRICE_MARGIN_GB = 0.5;

/** What every agent process calls before doing anything else: it reads its own
 * hostname to find its queue, and it spawns — into a job, or back to resident
 * mode. Both modes pay these, so both lists below start from them. */
const AGENT_BASE_METHODS = ["getHostname", "spawn"] as const;

/** Resident mode: the base pair, the two RAM getters, and a last-moment
 * adjacency/identity preflight before it gives up the resident to spawn. */
export const RESIDENT_METHODS: readonly string[] = [
  ...AGENT_BASE_METHODS,
  "getServerMaxRam",
  "getServerUsedRam",
  "dnet.probe",
];

/** The overseer observes the mutation clock and process liveness, and holds the
 * one destructive member in the whole system: `kill`, for retiring a live job
 * whose work is provably pointless. It still cannot inspect a target, crack it,
 * or launch work. `kill` works by PID from anywhere — the engine's worker map
 * is global and the pid form checks no host — which is what lets the overseer
 * on darkweb reach a job seconds deep in an `authenticate` on a distant host. */
export const CONTROLLER_METHODS: readonly string[] = ["getHostname", "dnet.nextMutation", "isRunning", "kill"];

/** Every job also calls `describeHost`. */
const DESCRIBE_METHODS = ["dnet.getServerDetails", "getServerMaxRam", "getServerUsedRam"] as const;

/** What each job body calls, per kind.
 *
 * These lists are the contract between the overseer, which SIZES the process,
 * and the closures in `overseer.ts`, which make the calls. Getting one wrong is
 * a bug the simulator cannot catch — it does not model the dynamic-RAM check —
 * and that the game expresses as the script dying on its first call.
 * `tests/ram-budget.test.ts` asserts they cover every member the closures
 * actually reference. */
/** The work a host should always have room for.
 *
 * Everything a resident does as a matter of course. It exists to keep ONE
 * number honest: `planFarm`'s `wantedGb` is "the heaviest thing we would like a
 * host to be able to hold", and taking that as the max over every declared kind
 * silently redefines it the moment a deliberate one-off is added.
 *
 * A stasis pin is the case that forces the distinction — `setStasisLink` alone
 * is 12 GB, more than a shallow host's entire 16 — and taking the max over it
 * would mark every host in the net as cramped, stop `reclaim-not-needed` from
 * ever firing, and set the whole ladder grinding RAM it does not need. A pin is
 * something we do once to one host, not a size every host must fit. */
export const ROUTINE_JOB_KINDS: readonly string[] = [
  "survey",
  "bleed",
  "attempt",
  "plant",
  "cache",
  "reclaim",
  "phish",
];

export const JOB_METHODS: Readonly<Record<string, readonly string[]>> = {
  // `ls` is here and nowhere it is not needed: it is the only view of caches,
  // coding contracts and storm seeds. It works at any distance, so a surveyor
  // already standing at the right vantage can report the whole listing.
  survey: [...AGENT_BASE_METHODS, "dnet.probe", "getServer", "ls", ...DESCRIBE_METHODS],
  bleed: [...AGENT_BASE_METHODS, "dnet.heartbleed", ...DESCRIBE_METHODS],
  // authenticate and heartbleed together, because `authenticate()` answers with
  // a GENERIC failure for every model but the labyrinth: the model's real
  // response goes to the target's log ring, and only heartbleed reads it back.
  attempt: [...AGENT_BASE_METHODS, "dnet.authenticate", "dnet.heartbleed", "formulas.dnet.getAuthenticateTime", ...DESCRIBE_METHODS],
  // connectToSession FIRST, because the credential was usually won by an earlier
  // process whose session died with it, and re-opening one costs 0.05 GB and no
  // time. But it requires the host to be already ROOTED, which only a successful
  // `authenticate` sets — and a credential read out of a log belongs to a host we
  // may never have authenticated to. So the expensive call is carried as the
  // fallback rather than assumed away.
  plant: [
    ...AGENT_BASE_METHODS,
    "dnet.connectToSession",
    "dnet.authenticate",
    "scp",
    "exec",
    ...DESCRIBE_METHODS,
  ],
  // --- the farm, all three of them self-host ------------------------------
  //
  // None of these needs a credential or a neighbour. `memoryReallocation`
  // declares `requireAdminRights`, but the self early-out at
  // `offlineServerHandling.ts:98-101` returns before that check is reached, so a
  // resident grinds its OWN block open for nothing.
  // `ls` here too, and it is not optional: clearing a block to zero is what
  // DROPS a `.cache`, so a grind that ran to the end and did not look would
  // leave the file it just earned invisible until some neighbour's survey
  // happened past. The body calls it, so the list must declare it — the union
  // check in `tests/ram-budget.test.ts` cannot see a per-kind mismatch, and the
  // engine expresses one by killing the process on its first unlisted call.
  reclaim: [...AGENT_BASE_METHODS, "dnet.memoryReallocation", "getServer", "ls", ...DESCRIBE_METHODS],
  phish: [...AGENT_BASE_METHODS, "dnet.phishingAttack", ...DESCRIBE_METHODS],
  // `ls` again, and for two reasons: the job re-reads the host's file list after
  // opening one so the overseer's belief is not one tick stale, and it is the
  // guard against `openCache` THROWING — the call raises rather than refuses on
  // a filename the host does not hold, and a throw kills the agent.
  cache: [...AGENT_BASE_METHODS, "dnet.openCache", "getServer", "ls", ...DESCRIBE_METHODS],
  // --- the deliberate ones -------------------------------------------------
  //
  // None of these four is routine. Each is decided once, for one host, by a
  // policy that had to name a reason — so none of them belongs in
  // `ROUTINE_JOB_KINDS`, and `pin` in particular must not, because 12 GB of
  // `setStasisLink` would declare every host in the net cramped.
  //
  // Propaganda, on the calling host and taking no target. Cheap, and worth
  // nothing at all unless home has named a symbol — which is why the refusal
  // lives in `farm.ts` rather than here.
  promote: [...AGENT_BASE_METHODS, "dnet.promoteStock", ...DESCRIBE_METHODS],
  // A push against a NEIGHBOUR: `induceServerMigration` refuses its own host
  // outright, so this is the one deliberate job whose target is not where it
  // runs.
  induce: [...AGENT_BASE_METHODS, "dnet.induceServerMigration", ...DESCRIBE_METHODS],
  // THE ONE KIND WITH NO `spawn`, and it is not an economy: 12 GB of
  // `setStasisLink` plus the 2.0 GB spawn back is 16.15 GB, which does not fit
  // the 16 GB a shallow darknet host has. Dropping the spawn is what makes the
  // job runnable at all on such a host — the process simply ends, leaving the
  // host empty for `planSpread` to re-plant, which is safe precisely BECAUSE
  // the host is now immutable. The overseer files this variant only when a
  // neighbour could actually re-plant it, and refuses by name otherwise.
  // `dnet.probe` is the act-time edge check: the pin re-verifies the lab edge
  // it exists for immediately before the irrevocable `setStasisLink`, and
  // refuses (912 EdgeGone) rather than spend the slot on a severed one.
  pin: ["getHostname", "dnet.probe", "dnet.setStasisLink", ...DESCRIBE_METHODS],
  // The maze walker. It keeps `spawn` — the walk is over by the time it runs —
  // and it is the only long-lived kind, because a lab is hundreds of moves and
  // `DarknetState.labLocations` is keyed by PID, so the walk cannot be resumed
  // by a second process. No `heartbleed`: the labyrinth is the one model that
  // answers through `authenticate`'s own return value. `labradar` is 0 GB and
  // the planner pays its authentication-time price only when one radius-3
  // render decides the exit or scouts a seam's door candidates.
  // `ls` for the ONE report that matters: reaching the exit drops a `.cache` on
  // the lab (three on BonusLab), and a walk that finished without looking would
  // leave the file it just spent hours earning invisible.
  walk: [...AGENT_BASE_METHODS, "dnet.authenticate", "dnet.labradar", "getServer", "ls", ...DESCRIBE_METHODS],
  // The reroll. `unleashStormSeed` is 0.1 GB and fires `STORM_SEED.exe` off the
  // CALLING host — the seed cannot be scp'd, so the job runs where the file is.
  // `ls` is the act-time re-check: the sighting can go stale exactly like a
  // cache filename, and unlike `openCache` the member answers 404 rather than
  // throwing, but the fresh listing in the failure report is what corrects the
  // next derivation without spending anything. Deliberate, so not routine —
  // `wantedGb` must not grow to fit a job that runs a handful of times a run.
  storm: [...AGENT_BASE_METHODS, "dnet.unleashStormSeed", "ls", ...DESCRIBE_METHODS],
};

/** Kinds whose process does NOT hand the host back to a resident.
 *
 * `pin` is the only one, and the whole reason it exists — see `JOB_METHODS.pin`.
 * Read by `game/dnet/agent.ts`, which otherwise respawns unconditionally in a
 * `finally`. */
export const NO_RESPAWN_KINDS: readonly string[] = ["pin"];

/** Kinds the overseer's kill sweep must never hard-cancel, even armored.
 *
 * `pin` because it is never armored in the first place — no `spawn` in its
 * budget, so no atExit respawn (see `JOB_METHODS.pin`) — and a kill would
 * leave the host empty without the deliberate reasoning `planSpread` applies.
 * `walk` because a labyrinth position is keyed by PID and cannot be resumed:
 * its loop polls `cancelled?.()` at every move, so a cooperative cancel lands
 * within one authenticate-time, while a kill throws away hours of maze. */
export const HARD_CANCEL_EXEMPT_KINDS: readonly string[] = ["pin", "walk"];

/** Whether the overseer may `kill` this job outright. Pure, so the policy is
 * testable without an ns: armored (the agent proved its atExit respawn hook),
 * a live pid to aim at, and not a kind whose loss outweighs the cancel. The
 * sweep still vouches the pid with `isRunning` immediately before firing. */
export function hardCancelEligible(job: DnetJob): boolean {
  return job.armored === true && job.pid !== undefined && !HARD_CANCEL_EXEMPT_KINDS.includes(job.kind);
}

/** Price an allocation from the game's OWN table.
 *
 * `ns.getFunctionRamCost` is 0 GB, so this is free — and it is the only way to
 * get these right. Hand-arithmetic drifts the moment a body calls one more
 * member, and because the simulator does not model the dynamic-RAM check, the
 * drift stays invisible until the game kills the script in a real run. */
export function priceAgent(ns: NS, methods: readonly string[]): number {
  let total = SCRIPT_BASE_GB;
  for (const method of new Set(methods)) total += ns.getFunctionRamCost(method);
  return total + PRICE_MARGIN_GB;
}

/** How long a job may run before the overseer gives up on it.
 *
 * Generous, because the work is genuinely slow: one `authenticate` against a
 * deep host takes seconds and `heartbleed` is 1.5x that. This is here for a job
 * whose process was KILLED — a mutation tick restarts hosts and takes whatever
 * was running on them — not to police a slow call. */
export const JOB_TIMEOUT_MS = 60_000;

/** How long a LONG-LIVED job may go without stamping `beatAt` before it is
 * presumed dead with its host.
 *
 * This exists because the alternative was `Infinity`, and `Infinity` is a
 * promise the realm cannot keep. `residentLastLife` returned it for a long-lived
 * job and the overseer's timeout loop skipped one outright, so a job whose
 * PROCESS had been killed — which out here is the ordinary case, a mutation tick
 * restarts hosts and takes what was running on them — would pin its queue for
 * ever. The host would never be swept, never be re-planted, and never be
 * anything but a permanently busy entry in the panel.
 *
 * A long-lived job therefore has to say it is alive, exactly as a resident does.
 * The window is wider than the resident's because a long job's iterations are
 * genuinely slow: a labyrinth move is a full authentication time. */
export const LONG_JOB_BEAT_MS = 30_000;

/** A resident that has not beaten for this long is presumed gone with its host,
 * and its queue is retired. Three beats at the resident's own cadence. */
export const RESIDENT_BEAT_MS = 5_000;
export const RESIDENT_BEAT_MISSES = 3;

/** What a job hands back. Data, never live objects: the overseer folds it into
 * knowledge, and knowledge has to outlive the process that produced it. */
export interface DnetJobResult {
  ok: boolean;
  /** Network diagnosis for work that could not reach the identity it targeted. */
  targetState?: "edge-lost" | "gone" | "replaced" | "cancelled";
  hosts?: ReportHost[];
  /** Summary of attempts already written through to the target ledger. */
  attempts?: AttemptOutcome[];
  codes?: Record<string, number>;
  /** Charisma a job refused for want of, as the ENGINE stated it.
   *
   *  Only the maze walker reports this, and it is the one gate in the feature
   *  that cannot be worked around: below `labStage.cha` every move answers 451
   *  and the walk learns nothing at all. It rides the drain to home, which
   *  already posts `charismaNeeded` as a career need — so this is a second
   *  source for a channel that exists rather than a new one. */
  charismaNeeded?: number;
  /** Karma an `openCache` spent, as the engine returns it: NEGATIVE, because
   *  karma only ever moves down. That is what makes a cache free progress
   *  toward the gang threshold rather than a cost, so the overseer sums it
   *  and publishes the total for `gang` to read. */
  karmaLoss?: number;
  /** When a `storm` job's `unleashStormSeed` succeeded, by the job's own clock.
   *  The authoritative stamp — but the overseer has already stamped
   *  pessimistically at claim time, because `restartAllDarknetServers` reaches
   *  the firing host seconds after the call and this result may never drain. */
  stormFiredAt?: number;
  /** How far our log grammar has drifted from the game's.
   *
   *  SHAPES, never lines: an unrecognised line is one the parser failed to read,
   *  and the noise generator writes cleartext passwords into log lines — so
   *  examples would be exactly the passwords we missed. `logShape` erases every
   *  digit and letter run and keeps the structure. */
  grammar?: { unrecognised: number; shapes: string[] };
  detail?: string;
}

/** Everything a job needs that is not in its closure.
 *
 * It lives in the realm rather than in `ns.args` because it carries a password,
 * and `ns.args` is visible in the game's script listing. */
export interface DnetJobState {
  /** The TARGET the job acts on — not the host it runs on, which is `from`.
   *
   *  The two are the same for most kinds, which is exactly why the difference
   *  is worth stating: `induce` is the one call that REFUSES its own host
   *  (`Darknet.ts:428-439`), so there `host` is a neighbour and `from` is where
   *  the resident stands. Note the asymmetry with `DnetHostQueue.host`, which
   *  means the vantage. */
  host: string;
  /** Where the job RUNS — the resident's own host, the vantage. */
  from: string;
  /** IP identity observed when this work was derived. */
  targetIdentity?: string;
  /** Credential for `host`, when the overseer holds one. The one field that
   *  must never leave the realm: it travels only to home's vault, and
   *  `stripCredentials` keeps it out of anything that is published. */
  password?: string;
  /** All host identities known when a log is parsed. Heartbleed's bare
   * credential lines can name any server, not only the target being drained. */
  knownHosts?: string[];
  /** Actual process threads, needed by formulas whose time scales per thread. */
  jobThreads?: number;

  /** This plant is intentionally non-adjacent and may only reuse an existing
   * rooted session. Falling back to authenticate would always fail remotely. */
  sessionOnly?: boolean;
  /** Pins only: the neighbour the pin exists to keep — the lab. The job probes
   *  for it before `setStasisLink` and refuses (912 EdgeGone) rather than
   *  spend a near-irrevocable slot on a host whose edge was severed after the
   *  plan was derived. */
  edge?: string;
  /** Pins only: run `setStasisLink(false)` — release the link this host holds,
   *  freeing the slot for a host that still earns one. The edge check does not
   *  apply: a release is filed precisely BECAUSE the edge is gone. */
  unpin?: boolean;
  /** Payload filenames, for a job that plants a resident elsewhere. A job never
   *  builds a filename: they are build-versioned, and a guess would `exec` a
   *  version that is not on disk and get a silent 0. */
  payloads?: string[];
  /** Args for a resident this job plants. Built by the overseer so the
   *  positional order lives in exactly one place. */
  plantArgs?: (string | number)[];
  /** A password we do NOT believe belongs to this host, to be spent on one
   *  `authenticate` and no more.
   *
   *  Separate from `password` on purpose: `password` means "the credential we
   *  hold for this host" and drives `connectToSession`, while this is a
   *  lottery ticket off a log line that named no owner. Conflating them would
   *  have a plant try to open a host with a stranger's password. Realm-only,
   *  exactly as `password` is. */
  guess?: string;
  /** The symbol a `promote` job spreads propaganda about. Home names it —
   *  nothing out here can see the market — and a job never invents one. */
  symbol?: string;
  /** The `.cache` file a `cache` job opens, and nothing else carries one.
   *
   *  It is passed rather than discovered because `openCache` THROWS on a name
   *  the host does not hold, and a throw kills the agent process rather than
   *  failing the job — so the name comes from a listing we actually observed,
   *  and the job re-checks it before spending the call. */
  filename?: string;
  /** Walks only: this walker is the disposable SECOND one. It biases its
   *  route prior onto the macro-route the finisher is not on, and it is the
   *  walk whose loss costs only its own position — the shared field it fed
   *  lives with the overseer. Absent means the finisher. */
  role?: "scout";
}

export interface DnetJob {
  id: string;
  kind: string;
  /** For the panel and for the failure line. */
  label: string;
  /** Allocation for the process that runs it, PER THREAD: base + its calls + the
   *  spawn back to resident mode. Declared at launch rather than bought by
   *  referencing an expensive ns member in source. */
  budgetGb: number;
  /** Threads the job runs at.
   *
   *  `ramOverride` is charged PER THREAD by the engine, so the real cost is
   *  `budgetGb * threads` and BOTH fit checks — `nextJob` here and the
   *  overseer's pre-filter — have to multiply. `reclaim` and `phish` are the
   *  reason the field exists: both scale linearly with threads, and the agent
   *  hardcoded `threads: 1` at its `ns.spawn`, so asking for more would have
   *  been silently ignored while the planner believed it had been granted. */
  threads: number;
  /** Lower is more urgent, carried through from the derived `Task`.
   *
   *  The queue is filed IN PRIORITY ORDER rather than in arrival order, and that
   *  matters now that farm jobs exist: a resident takes the first pending job
   *  that fits, so a forty-second phish queued one tick before a plant would
   *  hold the host away from the plant for its whole batch. */
  priority: number;
  /** True for work that does not finish on its own. The overseer keeps the
   *  promise either way, but only times out jobs that SHOULD end: a long-lived
   *  one is expected to sit there, so a watchdog would kill exactly the thing it
   *  was meant to protect.
   *
   *  The labyrinth walk is the long-lived case: it holds its host for the whole
   *  maze and proves its liveness by beat (`LONG_JOB_BEAT_MS`) instead of by
   *  finishing. Everything else is short-lived and answers to `JOB_TIMEOUT_MS`. */
  longLived: boolean;
  state: DnetJobState;
  /** NOT named `run`: Bitburner's static analyser charges by MEMBER NAME, so a
   *  `job.run(...)` anywhere in a bundle that reaches a game script bills the
   *  full 1.0 GB of `ns.run`. The same trap catches `exec`, `scan`, `read` and
   *  friends — a field named after an ns member is never free.
   *
   *  Runs with the JOB process's ns, which is where the budget lives. Written
   *  with bracket notation on that ns so the analyser charges the declared
   *  override rather than the overseer's bundle. */
  body: (jobNs: NS, state: DnetJobState, beat?: JobBeat, cancelled?: JobCancellation) => Promise<DnetJobResult>;
  settle: (result: DnetJobResult) => void;
  fail: (error: unknown) => void;
  startedAt?: number;
  /** PID written through by job mode as soon as it starts. */
  pid?: number;
  /** Set by the overseer when the job's work became pointless. Cooperative
   * FIRST: bodies poll it at their loop boundaries and stop there. But a body
   * seconds deep in a blocking call cannot look — the engine's concurrency lock
   * blocks every ns call while one is in flight — so the overseer's kill sweep
   * also hard-kills an ARMORED job carrying a reason. Safe only because the
   * agent's atExit hook puts the resident back in the same `ns.kill` call;
   * `armored` is how a job proves it has that hook. */
  cancelReason?: string;
  /** Stamped true by job mode immediately after arming its atExit-respawn
   * hook, and the overseer's licence to hard-kill this job: a kill lands in a
   * process whose atExit settles the job and respawns the resident before the
   * killer's `ns.kill` even returns. Never set by a pre-armor agent build, so
   * an old process is never killed without its safety net. NOT named after any
   * ns member — the static analyser charges by member name (see `body`). */
  armored?: boolean;
  /** Last time a LONG-LIVED job's body said it was still going, stamped by the
   *  body itself once per iteration. Meaningless on a short job, which is
   *  vouched for by `startedAt + JOB_TIMEOUT_MS` instead. */
  beatAt?: number;
  /** Whatever the last beat carried, for a job whose progress is worth watching
   *  while it happens.
   *
   *  A short job reports once, at the end, and that is enough. A job that runs
   *  for an hour has to be able to say where it has got to, or its only
   *  observable state for that hour is "still going". Untyped here on purpose:
   *  the realm carries it, the overseer publishes it, and neither has to know
   *  what a given job's progress looks like. */
  progress?: Record<string, unknown>;
}

/** How a long-lived job says it is still going, and optionally how far.
 *
 * Called with nothing, it is the liveness stamp the claim sweep and the resident
 * watchdog both read. Called with a payload, it also records where the job has
 * got to — free in RAM, and the general mechanism any future long job wants. */
export type JobBeat = (progress?: Record<string, unknown>) => void;
export type JobCancellation = () => string | undefined;

/** One darknet host's work, as the overseer sees it.
 *
 * The overseer decides WHAT runs and in what order; the resident decides WHEN,
 * because only it knows how much RAM is actually free at the moment it looks —
 * and out here that changes without warning when the owner's processes move. */
export interface DnetHostQueue {
  /** The VANTAGE this queue's resident stands on — the host that will RUN every
   *  job filed here. Not the target: a job's target is `DnetJobState.host`, and
   *  for `induce` the two differ. */
  host: string;
  pending: DnetJob[];
  /** The job the resident has spawned into. While this is set the resident is
   *  not running: the process IS the job. */
  active?: DnetJob;
  /** The resident PID while resident mode is alive. */
  residentPid?: number;
  /** Last time the resident said it was alive. */
  lastBeatAt: number;
  /** Free RAM the resident last measured. The overseer uses it to avoid
   *  queueing work that cannot possibly fit. */
  freeGb?: number;
  /** Jobs finished here, for the panel. */
  completed: number;
  failed: number;
  /** Why the last one failed. A count with no reason is a number nobody can
   *  act on, and out here failures are the normal case rather than the alarm. */
  lastError?: string;
}

/** One planner refusal, as every rolled-up report carries it. */
export interface RefusalExample {
  host: string;
  why: string;
  detail: string;
}

/** What a planner declined, and by what name. The shape every report below
 * shares — it answers the same question everywhere, and one shape means one
 * renderer.
 *
 * A SNAPSHOT of the last derivation, not a counter. Counting would tally the
 * same standing refusal once per 2 s tick and report a host that has been
 * quietly full for a minute as thirty problems. */
export interface RefusalRollup {
  /** Refusals by name, from the last derivation. */
  refused: Record<string, number>;
  /** One host per reason, with the planner's own sentence. The counts say how
   *  much; these say what to go and look at. */
  examples: RefusalExample[];
}

/** Roll a planner's refusal list up into counts plus one example per reason.
 *
 * This was written out longhand at every report site until there were four
 * identical copies; the shape is load-bearing (the panel renders it), so it is
 * folded in exactly one place. Callers whose planner keys refusals `hostname`
 * map at the call site. */
export function foldRefusals(entries: readonly RefusalExample[]): RefusalRollup {
  const refused: Record<string, number> = {};
  const examples: RefusalExample[] = [];
  for (const entry of entries) {
    refused[entry.why] = (refused[entry.why] ?? 0) + 1;
    if (refused[entry.why] === 1) examples.push(entry);
  }
  return { refused, examples };
}

/** Why the net is not growing, as of the overseer's most recent derivation.
 *
 * `planSpread` has produced named refusals since it was written and every one of
 * them was thrown away, which made the named-refusal contract in `spec/dnet.md`
 * half-implemented: the panel could see that spreading had stopped and never why.
 * It matters more now than it did, because removing the three invented caps
 * would otherwise be completely unobservable — the whole point of the change is
 * that the surviving refusals are the real ones. */
export interface DnetSpreadReport extends RefusalRollup {
  /** Plants the last derivation admitted. */
  planted: number;
}

/** What the farm ladder decided last derivation, in the same shape and for the
 * same reason as `DnetSpreadReport`.
 *
 * `planFarm` names a refusal for every rung a host fell through, so "phishing,
 * because there is no cache and no block" arrives complete rather than as an
 * unexplained phish. */
export interface DnetFarmReport extends RefusalRollup {
  /** Farm tasks the last derivation admitted, by kind. */
  admitted: Record<string, number>;
  /** The resident elected to carry the net-wide phishing cache window. */
  cacheHunter?: string;
}

/** What the three DELIBERATE decisions did, and what they declined.
 *
 * These are the decisions with a real price — a stasis link is one of at most
 * four in a whole run, a push can cost the host, and a walk occupies a resident
 * for hours — so "why not" is the more common answer and by far the more useful
 * one to read. */
export interface DnetHoldReport extends RefusalRollup {
  admitted: Record<string, number>;
}

/** What the storm trigger decided last derivation, and where the seed stands.
 *
 * The refusal names ARE the status display: while no storm has fired, the one
 * open gate is exactly what the panel should show — "phish-window-open" says
 * everything is ready and we are waiting on a `.d.cache` to fire behind. */
export interface DnetStormReport extends RefusalRollup {
  /** Fires the last derivation admitted: 0 or 1. */
  admitted: number;
  /** The freshest believed seed holder, when there is one. */
  seedHost?: string;
  /** When that sighting was made. */
  seedSeenAt?: number;
  /** Our stamp of the last fire, pessimistic-at-claim or drained-authoritative. */
  firedAt?: number;
  /** Whether the farm is currently grinding blocks for seed rolls. */
  seedHunt?: boolean;
}

/** What one darknet run has learned and has not yet handed to home. */
export interface DnetDrain {
  hosts: ReportHost[];
  credentials: VaultEntry[];
  /** Attempt outcomes since the last drain, tagged with their target. Home folds
   *  them into its OWN ledger, so the panel's per-host cracking progress
   *  survives an overseer death the way the map itself does. `attempted` and
   *  the oracle stay inside the realm: only the ledger summary is published. */
  attempts: { hostname: string; outcome: AttemptOutcome }[];
  /** Ring evidence and pending counts, owned by the target just like attempts. */
  logDrains: { hostname: string; outcome: LogDrainOutcome }[];
  codes: Record<string, number>;
  /** The last spread derivation. Absent before the first one has run. */
  spread?: DnetSpreadReport;
  /** The last farm derivation. Absent before the first one has run. */
  farm?: DnetFarmReport;
  /** The last hold derivation: the pin, the push and the walk. */
  hold?: DnetHoldReport;
  /** The last storm derivation: the seed, the gates, the fire. */
  storm?: DnetStormReport;
  /** Our stamp of the last storm fire, so home can carry it across an overseer
   *  death exactly as it carries `lastPhishCacheAt`: `lastStormTime` is engine
   *  module state exposed nowhere, and our own stamp is the only clock there is
   *  for both the quiet period and the 30-minute seed-eligibility window. */
  stormFiredAt?: number;
  /** Hosts the overseer has pinned with a stasis link.
   *
   *  It travels UP rather than down because the overseer is the only thing
   *  that can spend one — `setStasisLink` pins the calling host — while home is
   *  the one that has to run its own fold's expiries against the set. A pinned
   *  host is outside every mutation branch's victim pool, so believing it
   *  perishable costs a survey a minute for ever. */
  stasisLinked?: string[];
  /** The highest charisma a job refused for want of. Only the maze walker
   *  reports one; home turns it into the career need it already posts. */
  charismaNeeded?: number;
  /** Karma spent on caches SINCE THE LAST DRAIN, summed and NEGATIVE. A delta
   *  like `codes` beside it, and for the same reason: an overseer dies with
   *  its host, so a since-boot total would reset home's tally every time one is
   *  re-seeded. Karma only ever moves down, so home's accumulation is progress
   *  toward the gang threshold rather than a cost — which is why it is
   *  published rather than merely logged. */
  karmaLoss?: number;
  /** When a `.d.cache` was last seen to land, so home can carry the net-wide
   *  phishing cooldown across an overseer death. The cooldown lives on
   *  `DarknetState` and is exposed nowhere, so our own sightings are the only
   *  evidence there is. */
  lastPhishCacheAt?: number;
  /** Accumulated log-grammar drift, by shape. See `DnetJobResult.grammar`. */
  grammar?: { unrecognised: number; shapes: Record<string, number> };
  residents: {
    host: string;
    lastBeatAt: number;
    pending: number;
    active?: string;
    freeGb?: number;
    completed: number;
    failed: number;
    lastError?: string;
  }[];
  residentsLost: number;
  mutations: number;
  /** The maze, as far as the walkers have got. Absent unless a walk has learned
   *  something or is running right now.
   *
   *  It is on the drain rather than derived from `hosts` for the reason nothing
   *  else here is: the discovered map lives in the overseer's `labFields` and
   *  in nothing else. A walker dies with its PID and the map does not, so this
   *  is the one channel that can report a walk that is HALF DONE rather than
   *  only one that finished. */
  lab?: DnetLabReport;
}

/** One PID-bound walker, as the overseer can see it from its queue. */
export interface DnetLabWalker {
  /** The vantage the walk RUNS on. Not the target: the target is the lab. */
  from: string;
  /** Absent for the finisher; `"scout"` for the disposable second walker. */
  role?: "scout";
  /** `"x,y"`, from the engine's own message. Absent before the first response. */
  at?: string;
  moves: number;
  walls: number;
  radars: number;
  /** Authentications spent, which is what actually costs time — moves plus
   *  refused moves plus radars. */
  attempts: number;
  /** The planner's own A* estimate of the authentications left. */
  believedLeft?: number;
  startedAt: number;
  beatAt: number;
  /** Whether a mutation can take this walker. The finisher's host is pinned
   *  first; a scout's never is, by design. */
  pinned: boolean;
}

/** The labyrinth as the panel needs it: the discovered map, the exit question,
 * and who is walking. */
export interface DnetLabReport {
  host: string;
  /** The PRODUCED maze size, which is never the size `labData` asks for. */
  width: number;
  height: number;
  /** One character per grid cell, row-major: `?` unknown, `#` wall, `.` open.
   *  See `renderLabField` — 2501 characters for the largest rung, which is what
   *  makes the map cheap enough to send every drain. */
  grid: string;
  /** Exit candidates not yet disproved, `"x,y"`. One entry once it is known. */
  candidates: string[];
  /** True once a radar showed the exit or eliminated everything else. */
  exitKnown: boolean;
  walkers: DnetLabWalker[];
}

/** What home tells the overseer. Small on purpose: home does not plan the
 * darknet, it only says what home alone can see. */
export interface DnetOrders {
  charisma: number;
  /** Credentials home already holds, replayed after a re-seed so a restarted
   *  overseer does not re-crack a net we already opened. */
  vault?: VaultEntry[];
  /** Time of home's authoritative vault snapshot. Locally verified entries
   * newer than this survive a concurrent order. */
  vaultSnapshotAt?: number;
  /** The net's real depth, when home has pinned it from a lab sighting. Without
   *  it the overseer derives tasks and expiries on `DEFAULT_NET_DEPTH`, which
   *  errs toward re-observing — safe, but paid for in jobs. */
  netDepth?: number;
  /** The mutation clock runs at half speed outside BN15, and only home can see
   *  which node this is. */
  bitNode?: number;
  standDown?: boolean;
  /** Home's permission to open the LABYRINTH cache, and nothing else.
   *
   *  A labyrinth cache calls `getLabReward`, which queues an augmentation
   *  directly — and the generic augmentation price multiplier is
   *  `1.9 ^ (queued non-SoA)`, charged against every purchase made after it. So
   *  opening one mid-shopping-trip multiplies the rest of the cycle's bill and
   *  silently invalidates the drain order the factions planner froze. Only home
   *  can see that the last purchase has been made, so only home may say go.
   *
   *  Ordinary caches need no permission: their rewards queue nothing and their
   *  hosts are movable, so holding one risks losing it for nothing. */
  openLabCache?: boolean;
  /** The net-wide phishing cooldown, replayed after a re-seed so a restarted
   *  overseer does not believe the window is open when it is not. */
  lastPhishCacheAt?: number;
  /** When the last storm was fired, replayed after a re-seed for two reasons: a
   *  restarted overseer must not mistake a fresh burst for ordinary churn, and
   *  the 30-minute seed-eligibility window (`STORM_COOLDOWN_MS`) is what gates
   *  the seed hunt. */
  lastStormAt?: number;
  /** Symbols worth spreading propaganda about, best first, each with home's
   *  expected profit for the position — the promote side of the farm's earn
   *  comparison.
   *
   *  The one farm rung whose value is invisible from the darknet: propaganda
   *  moves a symbol's VOLATILITY, and only home holds the market. Absent or
   *  empty — the usual answer — and the ladder refuses `promote` by name. */
  promoteSymbols?: { symbol: string; expectedProfit: number }[];
  /** The player's crime success multiplier, a term in both phishing chances.
   *  Only home can see the player object; absent means 1. */
  crimeSuccessMult?: number;
  /** `getStasisLinkedServers()`. Home's probe is the authority; a pin job's own
   *  0 GB reading updates the overseer's copy in between. */
  stasisLinked?: string[];

  /** Darknet hosts home has backdoored, with the install observation time.
   *
   *  A term in the mutation rates, not a status line: a backdoored host carries
   *  a ~9%/tick restart and a ~4%/tick delete on top of the ordinary branches,
   *  so every knowledge expiry the overseer runs is shorter once we hold any.
   *  Home installs them (`singularity.installBackdoor` acts on the terminal's
   *  own server), so home is the only thing that can stamp them. */
  backdoors?: { hostname: string; installedAt: number }[];
  /** Whether a labyrinth can exist in this world at all.
   *
   *  `getCurrentLabName` is gated on FULL darknet access (BN15 or an SF15), so
   *  a DarkscapeNavigator-only run gets the 5-deep net and no lab is ever
   *  generated. Only home can see the bitNode and the source files. False
   *  stands the walker's stasis reservation down and hands its bottom-row
   *  anchor to the spare targets (`stasisTargetDepths`), so links — and
   *  therefore the storm — are reachable in a lab-less net. Absent reads as
   *  true, the conservative side: holding a reservation for a walker that
   *  cannot exist costs a slot for a while; spending the walker's slot in a
   *  world that DOES have a lab costs the walk. */
  labExpected?: boolean;
  /** `getStasisLinkLimit()`: `1 + TheBrokenWings + TheHammer + TheStaff`.
   *
   *  Ordered rather than read because the overseer cannot afford
   *  `getOwnedAugmentations`, and defaulting to 1 — the value before the
   *  labyrinth pays out anything — is the direction that spends nothing it does
   *  not have. */
  stasisLimit?: number;
}

/** The overseer, as everything else sees it.
 *
 * This is the whole inter-process surface of the feature: residents find their
 * queue here, and home drains findings and pushes orders here. There is no other
 * channel. */
export interface DnetRendezvous {
  readonly protocol: number;
  /** `<bitNode>:<lastAugReset>`. An agent from another world refuses to run. */
  readonly generation: string;
  readonly controllerPid: number;
  readonly startedAt: number;
  lastBeatAt: number;
  /** Per-host queues. Keyed by hostname, because a host is exactly the thing
   *  that has one resident and one RAM budget. A resident REGISTERS itself by
   *  creating its entry here, which is how the overseer discovers it. */
  queues: Map<string, DnetHostQueue>;
  /** Work in flight, keyed by TARGET. Deliberately not part of `drain()`: it is
   *  work, not knowledge, and realm rule 3 is about knowledge. See `DnetClaim`. */
  claims: Map<string, DnetClaim[]>;
  /** Hand home everything learned since it last asked, and forget it.
   *
   * Draining rather than exposing is deliberate: it is what makes home's fold
   * the durable copy. An accessor that returned the same observations for ever
   * would let home double-count them, and one that never cleared would make the
   * overseer the only holder of the map. */
  drain(): DnetDrain;
  /** Home to the overseer. */
  order(orders: DnetOrders): void;
}

export interface DnetGlobals {
  dnet_overseer?: DnetRendezvous;
}

export type DnetGlobalThis = typeof globalThis & DnetGlobals;

export function dnetRealm(): DnetGlobalThis {
  return globalThis as DnetGlobalThis;
}

/** The rendezvous an agent should be talking to RIGHT NOW, or nothing.
 *
 * Read fresh and never held across an `await`. That is the whole point of the
 * function: an agent that bound the rendezvous at boot kept a reference to an
 * object a replacement overseer of the same generation has already retired —
 * it would pass every generation check while being invisible to the overseer
 * that is actually running, for ever.
 *
 * The protocol is checked here and the generation is checked here, and nothing
 * else is. In particular the beat window is deliberately NOT applied: an agent
 * is the one process that cannot be replaced from outside, so an overseer that
 * is merely slow must not empty the net. Home re-seeds a dead overseer, and
 * the residents that survived re-register with it on their next pass. The beat
 * window belongs to the single-overseer election below, which decides the
 * opposite question. */
export function liveRendezvous(generation: string): DnetRendezvous | undefined {
  const existing = dnetRealm().dnet_overseer;
  if (!existing) return undefined;
  if (existing.protocol !== RENDEZVOUS_PROTOCOL) return undefined;
  if (existing.generation !== generation) return undefined;
  return existing;
}

/** Whether an existing rendezvous should be left alone.
 *
 * The single-overseer election, in one function so the boot check and the
 * tests read the same rule. A rendezvous from another generation is not "live"
 * however recently it beat: it belongs to a world this one does not share, and
 * deferring to it would hand the net to a dead run. */
export function overseerIsLive(
  existing: DnetRendezvous | undefined,
  generation: string,
  now: number,
): boolean {
  if (!existing) return false;
  if (existing.protocol !== RENDEZVOUS_PROTOCOL) return false;
  if (existing.generation !== generation) return false;
  return now - existing.lastBeatAt < RESIDENT_BEAT_MS * RESIDENT_BEAT_MISSES;
}

/** Retire hosts whose resident stopped beating.
 *
 * The condition the whole realm exception rests on: an entry is expired by the
 * overseer, never trusted. A resident dies with its host — a mutation tick
 * restarts and deletes servers — and a queue left behind would have the
 * overseer filing work for a machine that is gone.
 *
 * Returns the hostnames dropped, so the caller can fail their in-flight jobs
 * rather than leaving promises nobody will ever settle. */
/** The last instant this queue's resident gave evidence of life.
 *
 * While a job runs the resident is dead BY DESIGN — spawn killed it — so
 * `lastBeatAt` freezes for the whole job. An active job is therefore evidence
 * of life until its own timeout has passed. One function, because two readers
 * decide from it: the sweep below, and home's re-seed gate — a seed gate on the
 * raw beat alone would exec a SECOND resident onto a host whose first is merely
 * mid-job. A long-lived job vouches for its queue indefinitely. */
export function residentLastLife(queue: DnetHostQueue): number {
  // A long-lived job vouches for its queue on its OWN heartbeat, not for ever.
  // Before the beat existed this returned Infinity, which meant a walker whose
  // host had been deleted held its queue open permanently and the host could
  // never be re-planted. See LONG_JOB_BEAT_MS.
  if (queue.active?.longLived === true) {
    const beat = queue.active.beatAt ?? queue.active.startedAt ?? queue.lastBeatAt;
    return Math.max(queue.lastBeatAt, beat + LONG_JOB_BEAT_MS);
  }
  return queue.active?.startedAt !== undefined
    ? Math.max(queue.lastBeatAt, queue.active.startedAt + JOB_TIMEOUT_MS)
    : queue.lastBeatAt;
}

export function sweepQueues(queues: Map<string, DnetHostQueue>, now: number): DnetHostQueue[] {
  const dead: DnetHostQueue[] = [];
  for (const [host, queue] of queues) {
    // Sweeping on the beat window alone retired any queue whose job ran longer
    // than three beats, losing the result of a merely slow authenticate and
    // miscounting it as a lost resident. The overseer's timeout loop fires at
    // exactly `startedAt + JOB_TIMEOUT_MS` and stamps the beat as it clears the
    // job, so the beat allowance on top of it here is what gives that loop
    // first claim, and the returning resident time to beat.
    if (now - residentLastLife(queue) <= RESIDENT_BEAT_MS * RESIDENT_BEAT_MISSES) continue;
    queues.delete(host);
    dead.push(queue);
  }
  return dead;
}

/** A process is alive doing this, right now.
 *
 * Keyed by TARGET rather than by vantage, because that is the axis the queues do
 * not cover: a queue is per-host because a host has one resident and one RAM
 * budget, while a claim answers "what is being done TO this machine, from
 * wherever". The moment a target has two adjacent vantages the queues stop
 * answering that at all — `enqueue`'s per-queue duplicate check only ever saw
 * one of them — and the same multi-second `authenticate` fires twice.
 *
 * It lives on the rendezvous and NOT in knowledge, which is the whole reason
 * this is a separate structure. Realm rule 3 drains knowledge to home so it
 * outlives the overseer; a claim's entire meaning is "this overseer has a
 * live process on it", so surviving the overseer's death is precisely wrong.
 * Folding it into knowledge would also send it home, and a claim carries a
 * password. */
export interface DnetClaim {
  /** What is being worked on. */
  target: string;
  /** The vantage — whose death ends this claim. */
  from: string;
  kind: TaskKind;
  jobId: string;
  /** Realm-only. Never published, never drained, never logged: this object
   *  exists so the overseer can describe work in flight completely, and
   *  `stripCredentials` is the backstop if it ever reaches a channel. */
  password?: string;
  claimedAt: number;
  /** When the overseer stops believing a claim whose job has not STARTED yet,
   *  on the clock alone. The same window the job timeout uses, because it is the
   *  same question: past it, the process is either dead or holding a vantage
   *  that has already rotated. Once the job starts, `sweepClaims` runs the
   *  timeout off `startedAt` instead — a job waits behind its queue, and a claim
   *  anchored on its filing time would expire under a process still working. */
  expectedDoneAt: number;
}

/** Drop claims whose work cannot still be happening.
 *
 * Three deaths, in this order, and the order is the point: the first two are
 * STRUCTURAL and reuse a verdict this tick already computed, so they need no
 * clock and cannot drift. Only the third is a timer, and it exists for the case
 * the other two cannot see — a job that is somehow still queued long after the
 * adjacency it depends on has rotated away.
 *
 * 1. the vantage is gone — `sweepQueues` has just deleted its queue;
 * 2. the job is no longer in that queue — it settled, failed or timed out, and
 *    the tick that cleared it is the same tick that ends the claim;
 * 3. the clock has run out — `startedAt + JOB_TIMEOUT_MS` once the job is
 *    running, `expectedDoneAt` while it is still waiting its turn. A LONG-LIVED
 *    job is exempt from that fixed timeout and runs off its own beat instead,
 *    for the reason in the body.
 *
 * Returns what it dropped, in case the caller wants to count it. */
export function sweepClaims(
  claims: Map<string, DnetClaim[]>,
  queues: ReadonlyMap<string, DnetHostQueue>,
  now: number,
): DnetClaim[] {
  const dropped: DnetClaim[] = [];
  for (const [target, held] of claims) {
    const alive = held.filter((claim) => {
      const queue = queues.get(claim.from);
      if (!queue) return false;
      const job = queue.active?.id === claim.jobId
        ? queue.active
        : queue.pending.find((entry) => entry.id === claim.jobId);
      if (!job) return false;
      // The clock runs from when the job STARTED, not from when it was filed.
      // A job waits behind whatever is already in its queue, and a claim that
      // expired on its filing time would go stale under a process that is still
      // working — after which the derivation stops seeing the target as busy
      // and files the same multi-second `authenticate` from a second vantage,
      // which is the one thing a claim exists to prevent. Before it starts,
      // `expectedDoneAt` is still the only clock there is.
      //
      // A long-lived job is the case the fixed timeout cannot express. It is
      // MEANT to sit there — the maze walker holds one PID for the whole walk,
      // because `DarknetState.labLocations` is keyed by pid and a dead process
      // abandons its progress with no way to resume. Judging it by
      // `JOB_TIMEOUT_MS` would drop its claim after a minute, the derivation
      // would stop seeing the target as busy, and a second vantage would file a
      // second walker: two PIDs in one maze, which is the exact failure the
      // whole design exists to prevent. So it is judged by whether it is still
      // BEATING, symmetrically with `residentLastLife`, and the overseer's own
      // timeout loop already skips it for the same reason.
      const deadline = job.longLived
        ? (job.beatAt ?? job.startedAt ?? claim.claimedAt) + LONG_JOB_BEAT_MS
        : job.startedAt !== undefined
          ? job.startedAt + JOB_TIMEOUT_MS
          : claim.expectedDoneAt;
      return now <= deadline;
    });
    if (alive.length === held.length) continue;
    for (const claim of held) if (!alive.includes(claim)) dropped.push(claim);
    if (alive.length === 0) claims.delete(target);
    else claims.set(target, alive);
  }
  return dropped;
}

/** The next job this host can actually start.
 *
 * The RAM check is the resident's, not the overseer's, and deliberately so:
 * only the resident can see how much is free at the instant it looks, and out
 * here that moves without warning. A job that does not fit is left in the queue
 * rather than dropped — blocked RAM gets freed, hosts get restarted, and the
 * work is still worth doing when it does.
 *
 * `freeGb` must already ACCOUNT for the resident's own allocation being returned
 * when it spawns: the caller passes what will be free once it dies. */
export function nextJob(queue: DnetHostQueue, freeGb: number): DnetJob | undefined {
  if (queue.active) return undefined;
  // `budgetGb` is PER THREAD, because that is how the engine charges
  // `ramOverride`. Comparing the bare figure would have admitted a four-thread
  // phish onto a host with room for one and had the engine refuse the spawn.
  return queue.pending.find((job) => job.budgetGb * job.threads <= freeGb);
}

import type { NS } from "@ns";
import type { AttemptOutcome, ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";

/** The rendezvous the controller and its resident agents meet at.
 *
 * This is `game/lib/dodge-shared.ts` for the darknet, and the differences are
 * all forced by one thing: RAM out there is scarce, uneven, and can vanish.
 *
 * ## The shape
 *
 * - The **controller** is long-lived and holds every piece of state: the map,
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
 * the controller has to nothing but `darkweb`.
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
 * ## There are no ports
 *
 * An earlier version of this design pushed observations, credentials and orders
 * over netscript ports, on the reasoning that a serialized queue forces a design
 * to say what it knows and when. The rendezvous replaced them, and it is worth
 * being precise about why that is sound rather than merely convenient:
 *
 * - **The realm is not a shortcut past a game rule.** Ports are documented as
 *   shared across every host at 0 GB and need no session; the realm is a faster
 *   version of a sanctioned mechanic, not a new capability. What preserves BN15's
 *   challenge is enforced by the engine — sessions are per-PID, `probe()` is
 *   host-local, and the network kills your scripts — and none of that is helped
 *   by a slower message.
 * - **A port cannot carry a closure.** The whole job design depends on the
 *   controller describing work it cannot afford to perform, and handing the
 *   description to a process that can. That is a live function reference.
 * - **One writer, one reader, no serialization step to drift.** The port version
 *   needed an encoder, a decoder, a version marker and a rejection path for each
 *   of three channels, and every one of those was a place for the two ends to
 *   disagree.
 *
 * What the port discipline was protecting against is real, and is kept as rules
 * enforced in this file rather than as a transport:
 *
 * 1. **Entries are expired, never trusted.** A resident that stops beating is
 *    swept and its queue retired (`sweepQueues`); a job that stops settling is
 *    timed out. A realm reference to a dead host is exactly the hazard.
 * 2. **A foreign generation is refused** (`overseerIsLive`), because agents
 *    outlive controllers and a live script from a dead run describes a world
 *    this one does not share.
 * 3. **Home keeps its own fold.** `drain()` hands observations over ONCE and
 *    home folds them into knowledge it owns, so a controller dying loses
 *    scheduling rather than the map.
 * 4. **A credential never reaches telemetry.** It lives in the controller's
 *    vault and in home's, and `publishKnowledge` publishes a boolean. */

export const RENDEZVOUS_PROTOCOL = 1;

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

/** Resident mode: the base pair, plus the two getters it uses to decide whether
 * the next queued job actually fits. */
export const RESIDENT_METHODS: readonly string[] = [
  ...AGENT_BASE_METHODS,
  "getServerMaxRam",
  "getServerUsedRam",
];

/** The controller: the base, and `getHostname`. It observes nothing, cracks
 * nothing and launches nothing, so it costs nothing else. */
export const CONTROLLER_METHODS: readonly string[] = ["getHostname"];

/** Every job also calls `describeHost`. */
const DESCRIBE_METHODS = ["dnet.getServerDetails", "getServerMaxRam", "getServerUsedRam"] as const;

/** What each job body calls, per kind.
 *
 * These lists are the contract between the controller, which SIZES the process,
 * and the closures in `overseer.ts`, which make the calls. Getting one wrong is
 * a bug the simulator cannot catch — it does not model the dynamic-RAM check —
 * and that the game expresses as the script dying on its first call.
 * `tests/ram-budget.test.ts` asserts they cover every member the closures
 * actually reference. */
export const JOB_METHODS: Readonly<Record<string, readonly string[]>> = {
  survey: [...AGENT_BASE_METHODS, "dnet.probe", ...DESCRIBE_METHODS],
  bleed: [...AGENT_BASE_METHODS, "dnet.heartbleed", ...DESCRIBE_METHODS],
  // authenticate and heartbleed together, because `authenticate()` answers with
  // a GENERIC failure for every model but the labyrinth: the model's real
  // response goes to the target's log ring, and only heartbleed reads it back.
  attempt: [...AGENT_BASE_METHODS, "dnet.authenticate", "dnet.heartbleed", ...DESCRIBE_METHODS],
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
};

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

/** How long a job may run before the controller gives up on it.
 *
 * Generous, because the work is genuinely slow: one `authenticate` against a
 * deep host takes seconds and `heartbleed` is 1.5x that. This is here for a job
 * whose process was KILLED — a mutation tick restarts hosts and takes whatever
 * was running on them — not to police a slow call. */
export const JOB_TIMEOUT_MS = 60_000;

/** A resident that has not beaten for this long is presumed gone with its host,
 * and its queue is retired. Three beats at the resident's own cadence. */
export const RESIDENT_BEAT_MS = 5_000;
export const RESIDENT_BEAT_MISSES = 3;

/** What a job hands back. Data, never live objects: the controller folds it into
 * knowledge, and knowledge has to outlive the process that produced it. */
export interface DnetJobResult {
  ok: boolean;
  hosts?: ReportHost[];
  attempts?: AttemptOutcome[];
  /** Credentials recovered. The controller keeps them so the NEXT job can use
   *  them without a round trip, and `drain()` hands them to home's vault. */
  credentials?: VaultEntry[];
  codes?: Record<string, number>;
  detail?: string;
}

/** Everything a job needs that is not in its closure.
 *
 * It lives in the realm rather than in `ns.args` because it carries a password,
 * and `ns.args` is visible in the game's script listing. */
export interface DnetJobState {
  /** The job's target. */
  host: string;
  /** Where the job runs — the resident's own host. */
  from: string;
  /** Credential for `host`, when the controller holds one. The one field that
   *  must never leave the realm: it travels only to home's vault, and
   *  `stripCredentials` keeps it out of anything that is published. */
  password?: string;
  /** Payload filenames, for a job that plants a resident elsewhere. A job never
   *  builds a filename: they are build-versioned, and a guess would `exec` a
   *  version that is not on disk and get a silent 0. */
  payloads?: string[];
  /** Args for a resident this job plants. Built by the controller so the
   *  positional order lives in exactly one place. */
  plantArgs?: (string | number)[];
}

export interface DnetJob {
  id: string;
  kind: string;
  /** For the panel and for the failure line. */
  label: string;
  /** Allocation for the process that runs it: base + its calls + the spawn back
   *  to resident mode. Declared at launch rather than bought by referencing an
   *  expensive ns member in source. */
  budgetGb: number;
  /** True for work that does not finish on its own. The controller keeps the
   *  promise either way, but only times out jobs that SHOULD end: a long-lived
   *  one is expected to sit there, so a watchdog would kill exactly the thing it
   *  was meant to protect.
   *
   *  Everything today is short-lived. The flag exists because the work that is
   *  not — `phishingAttack` in a loop, a stasis hold — is the obvious next step,
   *  and this is the one place that distinction can live. */
  longLived: boolean;
  state: DnetJobState;
  /** NOT named `run`: Bitburner's static analyser charges by MEMBER NAME, so a
   *  `job.run(...)` anywhere in a bundle that reaches a game script bills the
   *  full 1.0 GB of `ns.run`. The same trap catches `exec`, `scan`, `read` and
   *  friends — a field named after an ns member is never free.
   *
   *  Runs with the JOB process's ns, which is where the budget lives. Written
   *  with bracket notation on that ns so the analyser charges the declared
   *  override rather than the controller's bundle. */
  body: (jobNs: NS, state: DnetJobState) => Promise<DnetJobResult>;
  settle: (result: DnetJobResult) => void;
  fail: (error: unknown) => void;
  startedAt?: number;
}

/** One darknet host's work, as the controller sees it.
 *
 * The controller decides WHAT runs and in what order; the resident decides WHEN,
 * because only it knows how much RAM is actually free at the moment it looks —
 * and out here that changes without warning when the owner's processes move. */
export interface DnetHostQueue {
  host: string;
  pending: DnetJob[];
  /** The job the resident has spawned into. While this is set the resident is
   *  not running: the process IS the job. */
  active?: DnetJob;
  /** Last time the resident said it was alive. */
  lastBeatAt: number;
  /** Free RAM the resident last measured. The controller uses it to avoid
   *  queueing work that cannot possibly fit. */
  freeGb?: number;
  /** Jobs finished here, for the panel. */
  completed: number;
  failed: number;
  /** Why the last one failed. A count with no reason is a number nobody can
   *  act on, and out here failures are the normal case rather than the alarm. */
  lastError?: string;
}

/** What one darknet run has learned and has not yet handed to home. */
export interface DnetDrain {
  hosts: ReportHost[];
  credentials: VaultEntry[];
  codes: Record<string, number>;
  residents: { host: string; lastBeatAt: number; pending: number; active?: string; freeGb?: number }[];
  residentsLost: number;
}

/** What home tells the controller. Small on purpose: home does not plan the
 * darknet, it only says what home alone can see. */
export interface DnetOrders {
  charisma: number;
  /** Credentials home already holds, replayed after a re-seed so a restarted
   *  controller does not re-crack a net we already opened. */
  vault?: VaultEntry[];
  standDown?: boolean;
}

/** The controller, as everything else sees it.
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
   *  creating its entry here, which is how the controller discovers it. */
  queues: Map<string, DnetHostQueue>;
  /** Hand home everything learned since it last asked, and forget it.
   *
   * Draining rather than exposing is deliberate: it is what makes home's fold
   * the durable copy. An accessor that returned the same observations for ever
   * would let home double-count them, and one that never cleared would make the
   * controller the only holder of the map. */
  drain(): DnetDrain;
  /** Home to the controller. */
  order(orders: DnetOrders): void;
}

export interface DnetGlobals {
  dnet_overseer?: DnetRendezvous;
}

export type DnetGlobalThis = typeof globalThis & DnetGlobals;

export function dnetRealm(): DnetGlobalThis {
  return globalThis as DnetGlobalThis;
}

/** Whether an existing rendezvous should be left alone.
 *
 * The single-controller election, in one function so the boot check and the
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
 * controller, never trusted. A resident dies with its host — a mutation tick
 * restarts and deletes servers — and a queue left behind would have the
 * controller filing work for a machine that is gone.
 *
 * Returns the hostnames dropped, so the caller can fail their in-flight jobs
 * rather than leaving promises nobody will ever settle. */
export function sweepQueues(queues: Map<string, DnetHostQueue>, now: number): DnetHostQueue[] {
  const dead: DnetHostQueue[] = [];
  for (const [host, queue] of queues) {
    if (now - queue.lastBeatAt <= RESIDENT_BEAT_MS * RESIDENT_BEAT_MISSES) continue;
    queues.delete(host);
    dead.push(queue);
  }
  return dead;
}

/** The next job this host can actually start.
 *
 * The RAM check is the resident's, not the controller's, and deliberately so:
 * only the resident can see how much is free at the instant it looks, and out
 * here that moves without warning. A job that does not fit is left in the queue
 * rather than dropped — blocked RAM gets freed, hosts get restarted, and the
 * work is still worth doing when it does.
 *
 * `freeGb` must already ACCOUNT for the resident's own allocation being returned
 * when it spawns: the caller passes what will be free once it dies. */
export function nextJob(queue: DnetHostQueue, freeGb: number): DnetJob | undefined {
  if (queue.active) return undefined;
  return queue.pending.find((job) => job.budgetGb <= freeGb);
}

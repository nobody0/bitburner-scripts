import type { NS } from "@ns";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import {
  conclusiveAttempt,
  LOCAL_CODE,
  type AttemptOutcome,
  type LogDrainOutcome,
  type ProvisionalCredential,
  type ReportHost,
  type VaultEntry,
} from "../../shared/strategy/dnet/courier.ts";
import { captureLaunch } from "../lib/launch-shared.ts";
import type { DnetOverseerLaunch } from "./launch.ts";
import {
  coverage,
  emptyKnowledge,
  foldLogDrain,
  foldAttempts,
  foldReports,
  fresh,
  markCredentialKnown,
  stormWipe,
  type DarknetKnowledge,
  type ExpiryOpts,
} from "../../shared/strategy/dnet/knowledge.ts";
import { deriveTasks, PLANT_PRIORITY, type DeriveOptions, type Task, type TaskKind } from "../../shared/strategy/dnet/queue.ts";
import { DNET_PRIORITY, choosePreemptionVantage, type PreemptionCandidate } from '../../shared/strategy/dnet/priority.ts';
import { DEFAULT_SPREAD_LIMITS, candidatesFrom, planSpread } from '../../shared/strategy/dnet/spread.ts';
import { planFarm, type FarmHost, type FarmKind, type PromoteSymbol } from "../../shared/strategy/dnet/farm.ts";
import { chooseLabVantage, holdHostFrom, planInduce, planStasis, stasisTargetDepths, unconqueredBands, type HoldHost, type HoldView } from "../../shared/strategy/dnet/hold.ts";
import { planStorm, type StormHost } from "../../shared/strategy/dnet/storm.ts";
import { looseCandidates, type LooseTarget } from "../../shared/strategy/dnet/oracle.ts";
import type { PasswordEvidence } from "../../shared/strategy/dnet/evidence.ts";
import { exactNeighbourClueEpoch } from '../../shared/strategy/dnet/file-clues.ts';
import {
  DEFAULT_NET_DEPTH,
  STORM_BURST_MS,
  STORM_COOLDOWN_MS,
  STORM_QUIET_MS,
  isLabyrinth,
  labStage,
  msPerHostEvent,
  msPerHostEventAny,
} from "../../shared/strategy/dnet/rates.ts";
import {
  emptyField,
  labPrior,
  liveExitCandidates,
  mergeLabFields,
  renderLabField,
  type LabField,
} from "../../shared/strategy/dnet/maze.ts";
import {
  BOOTSTRAP_RECLAIM_METHODS,
  CONTROLLER_METHODS,
  JOB_METHODS,
  ROUTINE_JOB_KINDS,
  JOB_TIMEOUT_MS,
  LONG_JOB_BEAT_MS,
  RENDEZVOUS_PROTOCOL,
  RESIDENT_METHODS,
  dnetRealm,
  proberReserveGb,
  foldRefusals,
  hardCancelEligible,
  priceAgent,
  threadsForJob,
  overseerIsLive,
  signalQueueWork,
  sweepQueues,
  type DnetSpreadReport,
  type DnetFarmReport,
  type DnetHoldReport,
  type DnetStormReport,
  type DnetHostQueue,
  type DnetJob,
  type DnetJobResult,
  type DnetJobState,
  type DnetLabReport,
  type DnetLabWalker,
  type DnetOrders,
  type DnetRendezvous,
  type DnetStasisSnapshot,
} from "./realm.ts";
import { makeJobBodies } from "./jobs.ts";
import { initTelemetry } from "../lib/telemetry.ts";
import { realmSleep } from "../lib/wake.ts";

/** The darknet overseer: one long-lived script that decides, and never acts.
 * (The spec's vocabulary: the HOME DRIVER runs on home, this OVERSEER holds the
 * map on `darkweb`, and RESIDENTS spawn in and out of jobs on every other host.)
 *
 * It exists because of a shape the darknet forces on us. `probe()` is host-local
 * and `ns.scan` excludes the darknet, so the map can only be assembled by
 * scripts standing in different places — and those scripts are mortal, because
 * their hosts get restarted and deleted out from under them. Something has to
 * hold the accumulated picture and decide what happens next, and it cannot be
 * `home`: from there the darknet is one host wide.
 *
 * ## Why it cannot start anything itself
 *
 * It keeps state, so it must not die — and `spawn` kills its caller. It could
 * `exec`, but that leaves both processes resident, and on a darknet host the
 * second base plus 1.3 GB is usually RAM we do not have.
 *
 * So it does not launch work. It QUEUES work, per host, and the resident already
 * standing there spawns into it. The overseer decides WHAT runs and in what
 * order; the resident decides only WHEN to pick up the next job. It no longer
 * decides how much fits: the overseer sizes every job itself, because a darknet
 * host runs exactly two of our scripts — a fixed-cost prober and one worker — so
 * the worker's budget is `maxRam − blockedRam − prober`, a figure the overseer
 * computes from facts it reads for itself (see `usableGb`).
 *
 * ## What it costs, and what it may touch
 *
 * Its priced surface is the base plus the mutation clock, the two
 * kill-a-pointless-job members (`isRunning`/`kill`), and three SYNCHRONOUS reads —
 * `dnet.probe` (darkweb's own adjacency), `dnet.getServerDetails` and
 * `getServerMaxRam` (any host's facts, from anywhere, no connection). All pinned
 * by tests/ram-budget.test.ts; home launches it at `priceAgent`'s exact price.
 *
 * It OBSERVES, deliberately — but only through calls that return instantly. The
 * real rule is that it must never BLOCK: `heartbleed`, `authenticate`, `scp`,
 * `exec` and `spawn` are absent, so it cannot crack, cannot launch, and can never
 * be the process holding the only copy of the map while sitting inside a
 * multi-second `authenticate` on a host about to be restarted. A read that cannot
 * block does not put the map at risk, so adding the three above bought the whole
 * topology — probers file adjacency, the overseer reads every other fact — at no
 * cost to the one guarantee that matters.
 *
 * ## How it describes work it cannot do
 *
 * The bodies live in `game/dnet/jobs.ts` and run in the AGENT's process, not
 * this one, reaching ns only through bracket notation on the ns they are handed
 * — `jobNs["dnet"]["authenticate"]`. The static analyser therefore charges the
 * agent's declared `ramOverride` rather than this bundle, which is the same
 * trick `game/lib/dodge.ts` uses and the reason this file stays small while
 * the work it describes costs several times that. They bundle into this same
 * artifact, so that rule binds them exactly as hard as it binds this file. */

/** How often the overseer tells home it is alive. Home re-seeds if this stops. */
const BEAT_INTERVAL_MS = 15_000;
/** How often it reconsiders the queues. The wait is a realm timer, so this is
 * only a question of how promptly a freshly-queued job starts. */
const TICK_MS = 2_000;
/** Job kinds sized to FILL their host with threads rather than run at one.
 *
 * `ramOverride` is charged per thread and every one of these gets meaningfully
 * more out of the extra threads: `authenticate` (attempt) and every maze move
 * (walk) shrink `1/(1 + 0.2*(threads-1))`; `heartbleed` (bleed), the RAM grind
 * (reclaim) and the earners (phish/promote) all scale their throughput linearly.
 * A host holds one job at a time, so RAM left idle under a 1-thread job is RAM
 * wasted. The ABSENTEES are deliberate: a `setStasisLink` pin is a fixed 12 GB
 * act, and `inventory`/`plant`/`induce`/`storm` are single calls — more
 * threads would only reserve RAM they cannot use. */
const THREAD_SCALED_KINDS: ReadonlySet<string> = new Set([
  "attempt",
  "bleed",
  "reclaim",
  "phish",
  "promote",
  "walk",
]);

/** The floor between derivations, ~one game cycle. New observations and cracks
 * can re-derive early, but a fast net produces those many times a second,
 * and re-deriving on every one would spin the loop and starve the engine. This
 * caps the rate at ~4/s while keeping re-derivation effectively instant. */
const STAND_DOWN_POLL_MS = 250;
/** Jobs queued per host at once. The resident runs them one at a time, and a
 * deep queue is just a stale plan: the net rearranges itself every few seconds.
 *
 * This is also the ONLY thing bounding how many plants one source host files in
 * a pass, now that `planSpread` has no fan-out cap. That is where the bound
 * belongs: "how much work can this host hold" is a fact about this host's queue,
 * not a spreading policy, and `enqueue` below is where it is enforced. */
const MAX_QUEUED_PER_HOST = 3;

/** A stable, non-reversible name for an unattributed password.
 *
 * The id is what crosses into `shared/strategy/dnet/queue.ts`; the password
 * never does, and this is what keeps that true while still being the SAME name
 * every tick. FNV-1a, because the bar is "different passwords usually differ"
 * rather than collision resistance — a collision costs one wasted
 * `authenticate`, which the engine does not penalise. A character loop and
 * `Math.imul` only: no RegExp, for the reason `oracle.ts` gives at length. */
function looseId(password: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < password.length; i++) {
    h ^= password.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Distinct log shapes the overseer will remember.
 *
 * Drift shows up as a handful of recurring shapes, so a cap costs nothing real —
 * and without one a game update that broke the parser outright would grow this
 * map once per unparsed line for the life of the run. */
const MAX_GRAMMAR_SHAPES = 20;

/** One entry of the hold plan, in the shape `deriveTasks` merges. */
type HoldTask = NonNullable<DeriveOptions["hold"]>[number];

/** Unattributed passwords held at once.
 *
 * Branch 6 of the noise generator leaks one every twenty lines or so across the
 * whole net, and each one is only worth anything while the host it belongs to
 * is still alive — the expected time to a DELETION on one named host is about
 * ten minutes, and a deleted host comes back with a new password. So this is a
 * working set, not an archive, and the oldest entry is the one to lose. */
const MAX_LOOSE_PASSWORDS = 40;
/** Named but unverified leaks are more valuable than loose strings. */
const MAX_PROVISIONAL_CREDENTIALS = 80;

/** Reconcile one resident queue against a newly observed neighbour set.
 * Returns how many pending/active jobs were retired. Active work is flagged
 * here, not killed: setting `cancelReason` gives the body its cooperative
 * window, and `hardCancelSweep` on the next tick shoots whatever armored job
 * is still burning seconds inside a blocking call. */
export function retireLostEdgeJobs(
  queue: DnetHostQueue,
  vantage: string,
  neighbours: readonly string[],
): number {
  const applies = (job: DnetJob): boolean => job.state.from === vantage
    && job.state.host !== vantage
    && job.state.sessionOnly !== true
    && !neighbours.includes(job.state.host);
  const retired = queue.pending.filter(applies);
  if (retired.length > 0) {
    queue.pending = queue.pending.filter((job) => !applies(job));
    for (const job of retired) {
      job.settle({ ok: false, targetState: "edge-lost", detail: `${job.state.host} is no longer adjacent to ${vantage}` });
    }
  }
  let active = 0;
  if (queue.active && applies(queue.active)) {
    queue.active.cancelReason = `${queue.active.state.host} is no longer adjacent to ${vantage}`;
    active = 1;
  }
  return retired.length + active;
}

/** Retire a PENDING pin whose lab edge has just been observed severed.
 *
 * `retireLostEdgeJobs` cannot see this one: a pin is self-targeting
 * (`host === from`), so its `applies` check — which keys on the job's TARGET
 * no longer being adjacent to the vantage — never matches. But a pin exists
 * for a DIFFERENT edge, the lab it carries in `state.edge`, and when a probe
 * shows this host's fresh neighbours no longer include that lab the pin is
 * doomed: `pinJob`'s own act-time `probe()` would refuse it with 912. Retiring
 * it here just saves spawning the doomed job. Returns how many were retired.
 *
 * The ACTIVE pin is deliberately left alone. `setStasisLink` is a single quick
 * call rather than a minutes-long batch, so there is no in-flight window worth
 * a hard-cancel — and the act-time probe inside the body is the backstop for
 * the case where the edge dies between this observation and the call firing. */
export function retireLostPin(queue: DnetHostQueue, host: string, neighbours: readonly string[]): number {
  const doomed = (job: DnetJob): boolean =>
    job.kind === "pin"
    && job.state.unpin !== true
    && job.state.edge !== undefined
    && !neighbours.includes(job.state.edge);
  const retired = queue.pending.filter(doomed);
  if (retired.length > 0) {
    queue.pending = queue.pending.filter((job) => !doomed(job));
    for (const job of retired) {
      job.settle({ ok: false, targetState: "edge-lost", detail: `${host}'s edge to ${job.state.edge} is gone; pin abandoned before spending` });
    }
  }
  return retired.length;
}

/** Kill live jobs whose work is provably pointless. Returns how many died.
 *
 * A job carrying a `cancelReason` is pointless work still burning real
 * seconds, and a body deep inside a blocking call cannot look at the flag —
 * the engine's concurrency lock blocks every ns call while one is in flight.
 * If the job is ARMORED — its agent proved the atExit-respawn hook — it can be
 * killed outright: the engine runs that hook synchronously inside this very
 * `kill` call, with the dying process's ns fully usable, so by the time `kill`
 * returns the job has settled 'cancelled', `queue.active` is clear, and a
 * fresh resident is already running on the host.
 *
 * Called once per tick, AFTER the retire* setters stamped their reasons, so a
 * body at a loop boundary still gets to stop on its own first. `pin` and
 * `walk` never qualify (`HARD_CANCEL_EXEMPT_KINDS`), nor does any pre-armor
 * agent build — `hardCancelEligible` is the whole policy. Bracket notation
 * throughout: the overseer's static RAM figure must stay on its declared
 * synchronous control surface,
 * and its allocation prices `isRunning` and `kill` from `CONTROLLER_METHODS`. */
export function hardCancelSweep(ns: NS, queues: Map<string, DnetHostQueue>): number {
  let killed = 0;
  for (const queue of queues.values()) {
    const active = queue.active;
    const pid = active?.pid;
    if (!active || pid === undefined || active.cancelReason === undefined || !hardCancelEligible(active)) continue;
    // Vouch the pid this tick: a stale or recycled one is the timeout loop's
    // corpse to count, not ours to shoot at.
    let alive = false;
    try {
      alive = ns["isRunning"](pid, queue.host);
    } catch {
      alive = false;
    }
    if (!alive) continue;
    ns["kill"](pid);
    killed++;
  }
  return killed;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetOverseerLaunch>("dnet-overseer");
  if (!launch) return;
  const mission = launch;

  const realm = dnetRealm();
  const bootAt = Date.now();
  // Deferring to a live overseer of the same generation is what makes a
  // re-seed idempotent: home may launch us whenever it is unsure, and the
  // redundant copy exits instead of running a second scheduler.
  if (
    realm.dnet_overseer?.buildId === launch.buildId
    && overseerIsLive(realm.dnet_overseer, mission.generation, bootAt)
  ) return;

  const identity: ArtifactIdentity | undefined = mission.identity;

  let tel: ReturnType<typeof initTelemetry> | undefined;
  TELEMETRY: if (__TELEMETRY__) {
    if (identity) tel = initTelemetry(ns, ns.getScriptName(), identity);
  }

  const selfHost = launch.host;
  // Both stable artifacts travel to every planted host: the worker
  // (`payloads[0]`) and
  // the prober beside it (`payloads[1]`). The plant job scps the pair and execs
  // both — worker first, then prober best-effort. A stale prober is relaunched
  // by a worker job (see `game/dnet/jobs.ts` and `game/dnet/prober.ts`).
  const agentFile = "dnet/agent.js";
  const proberFile = "dnet/prober.js";
  const payloads = [agentFile, proberFile];
  let charisma = mission.charisma;
  // Home's readings of the clock the expiries run on. Undefined until ordered:
  // the shared defaults (depth 5, BN15) err toward re-observing, which is the
  // safe direction while home has not pinned the real values.
  let netDepth: number | undefined;
  let bitNode: number | undefined;
  let knowledge: DarknetKnowledge = emptyKnowledge(mission.generation);
  const vault = new Map<string, VaultEntry>();
  const codes: Record<string, number> = {};
  // The last derivation's spread verdict, overwritten every tick. A snapshot
  // rather than a tally: a host that has been full for a minute is one problem,
  // not the thirty ticks that noticed it.
  let spread: DnetSpreadReport | undefined;
  /** The last farm derivation, on the same snapshot discipline as `spread`. */
  let farm: DnetFarmReport | undefined;
  /** The last hold derivation — the pin, the push and the walk. Same
   *  discipline: a snapshot of the current answer, not a tally of the ticks
   *  that reached it. */
  let hold: DnetHoldReport | undefined;
  /** The last storm derivation, same snapshot discipline. */
  let storm: DnetStormReport | undefined;
  /** Passwords a log leaked with no owner attached.
   *
   *  Realm-only and never drained: an unattributed password is still a
   *  password, and the overseer is the only thing that holds both it and the
   *  length and format facts that say which hosts it could open. Bounded,
   *  because a chatty net mints these faster than they can be spent and the
   *  oldest are the least likely to still belong to a live host. */
  const loosePool: string[] = [];
  /** Named plaintext leaks, retained separately until authenticate verifies. */
  const provisionalPool: ProvisionalCredential[] = [];
  /** First successful authentication epoch for exact unnamed-neighbour clues. */
  const authenticationEpoch = new Map<string, number>();
  /** `<host>\u0000<password>` pairs already spent, so a candidate that was
   *  wrong is not offered again for the life of this overseer. The engine
   *  charges nothing for a wrong `authenticate`, but a call is still a call and
   *  the same wrong pair would otherwise re-derive every tick for ever. */
  const spentGuesses = new Set<string>();
  /** Guess id -> the password it stands for. The id is what crosses into
   *  `shared/strategy/dnet/queue.ts`; the password never does. */
  const guessFor = new Map<string, string>();
  /** Hosts WE have pinned. The set is ours rather than observed: nothing else
   *  in the run sets or releases a link, and `getStasisLinkedServers` is not a
   *  member the overseer can afford. Drained so home can carry it into the
   *  expiry it runs its own fold on. */
  const stasisLinked = new Set<string>();
  let stasisObservedAt = 0;
  let pendingStasisSnapshot: DnetStasisSnapshot | undefined;
  /** The highest charisma any job has said it needed and did not have. Only the
   *  maze walker reports one, and it is drained to home's existing career
   *  need rather than to a new channel. */
  let charismaNeeded: number | undefined;
  /** Symbols home has named as worth promoting, each carrying home's expected
   *  profit — the promote side of the farm's earn comparison. Empty is the
   *  usual answer, and the farm ladder refuses propaganda by name on it. */
  let promoteSymbols: PromoteSymbol[] = [];
  /** The player's crime success multiplier, a term in both phishing chances.
   *  Only home can see the player object; 1 until ordered. */
  let crimeSuccessMult = 1;
  /** `getStasisLinkLimit()`. One until the labyrinth pays out, and home says so
   *  when it can see the augmentations. */
  let stasisLimit = 1;
  /** Whether a labyrinth can exist in this world. True until home says
   *  otherwise — the conservative side, see `DnetOrders.labExpected`. */
  let labExpected = true;
  /** Home's stamped ordinary backdoors. Their count is a term in the mutation
   *  rates every expiry is derived from — a backdoored host carries a ~9%/tick
   *  restart and a ~4%/tick delete on top of the ordinary branches — so a
   *  overseer that did not hear about them would believe its facts lasted
   *  longer than they do. */
  const backdoors = new Map<string, number>();
  /** Karma spent opening caches SINCE THE LAST DRAIN. Negative, because karma
   *  only falls — which is what makes a cache free progress toward the gang
   *  threshold. A delta rather than a running total, so that home's tally
   *  survives this overseer being replaced; see `drain`. */
  let karmaLoss = 0;
  /** When a `.d.cache` was last seen to land. The phishing cache cooldown is
   *  NET-WIDE engine state (`DarknetState.lastPhishingCacheTime`) and is exposed
   *  through no ns member at all, so our own sightings are the only evidence
   *  there is. Undefined reads as "the window is open", which is the direction
   *  that costs nothing: the call is made either way. */
  let lastPhishCacheAt: number | undefined;
  /** When the last storm was fired, on OUR clock — `lastStormTime` is engine
   *  module state exposed nowhere. Stamped PESSIMISTICALLY the moment a storm
   *  job is filed, because the firing host's agent dies seconds after a
   *  successful call and the authoritative result may never drain: a lost
   *  report must not skip the quiet period or the wipe. Rolled back if the job
   *  reports it did not fire, confirmed by the drained `stormFiredAt`, and
   *  max-merged from home's replay after a re-seed. */
  let lastStormFiredAt: number | undefined;
  /** What `lastStormFiredAt` held before the pessimistic claim-time stamp, so
   *  a storm job that answered 404 can put the clock back. */
  let stormStampPrior: number | undefined;
  /** When the post-burst wipe is due. Set alongside every advance of
   *  `lastStormFiredAt`; cleared once the wipe has run. */
  let stormWipeAt: number | undefined;
  /** Log shapes our parser could not read, and how often each turned up.
   *
   *  A TALLY rather than a snapshot, unlike `spread` and `farm`: drift is a
   *  cumulative property of the run, and a shape that appeared once an hour ago
   *  is exactly what we want to still be able to see. Bounded so a pathological
   *  net cannot grow it without limit. */
  const grammarShapes: Record<string, number> = {};
  let grammarUnrecognised = 0;
  /** Home's permission to open the LABYRINTH cache — and only that one. See
   *  `DnetOrders.openLabCache` for why it is home's decision and nobody else's. */
  let openLabCache = false;
  const lastPlantAt = new Map<string, number>();
  const pendingHosts: ReportHost[] = [];
  const pendingCredentials: VaultEntry[] = [];
  const pendingCredentialRejections = new Map<string, { hostname: string; identity?: string; at: number }>();
  const pendingBackdoorInvalidations = new Map<string, { hostname: string; at: number }>();
  const pendingAttempts: { hostname: string; outcome: AttemptOutcome }[] = [];
  const pendingLogDrains: { hostname: string; outcome: LogDrainOutcome }[] = [];
  const queues = new Map<string, DnetHostQueue>();
  /** Project target-keyed scheduling state from the one authoritative copy.
   * Queues are keyed by vantage, while planners need to know what is being done
   * to a target from any vantage. Keeping a second mutable registry for that
   * view let it expire independently of the job that was still queued. */
  const projectInFlight = (): Map<string, { from: string; kind: TaskKind }[]> => {
    const projected = new Map<string, { from: string; kind: TaskKind }[]>();
    for (const queue of queues.values()) {
      for (const job of [queue.active, ...queue.pending]) {
        if (job === undefined) continue;
        const held = projected.get(job.state.host) ?? [];
        held.push({ from: queue.host, kind: job.kind });
        projected.set(job.state.host, held);
      }
    }
    return projected;
  };
  // The one prober map: host -> { neighbours, at, pid }. Probers stamp it every
  // mutation; the overseer folds new adjacency, revives a prober whose `at` has
  // gone stale, and keeps `pid` so it can kill a lab walker's prober. See
  // `reportProbe`.
  const probes = new Map<string, { neighbours: string[]; at: number; pid: number; epoch: number }>();
  const bootstraps = new Map<string, { pid: number; lastBeatAt: number }>();
  const bootstrapDone = new Set<string>();
  // Hosts an action job reported it may have dropped a file on (`result.dirtied`)
  // without spending an `ls` to look. Drained into instant, high-priority
  // inventory jobs that do the one `ls` — off the thread-scaled action jobs, so
  // those keep every thread. See the `dirtied` handling below.
  const dirty = new Set<string>();
  let residentsSeenEver = 0;

  // The derive-loop wake, declared HERE — ahead of the rendezvous literal and the
  // mutation waiter, which both reference it. A probe report, inventory, or a
  // credential makes a plant possible RIGHT NOW, so signalling re-derives on the
  // next microtask instead of waiting out TICK_MS. Coalescing (like the queue
  // wake): many signals in one tick collapse into a single re-derive, and one
  // arriving between waits is remembered by `derivePending` so it is never lost.
  let derivePending = false;
  let deriveWake: (() => void) | undefined;
  const signalDerive = (): void => {
    const wake = deriveWake;
    if (wake) wake();
    else derivePending = true;
  };
  const waitForDerive = (): Promise<void> => new Promise((resolve) => {
    if (derivePending) {
      derivePending = false;
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (deriveWake === finish) deriveWake = undefined;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, TICK_MS);
    deriveWake = finish;
  });
  let residentsLost = 0;
  let standDown = false;
  let lastMutationAt: number | undefined;
  let mutationTurnAt = -1;
  // The mutation BEFORE last, the staleness threshold for prober revival: a
  // prober whose stamp predates this missed a full mutation window and is dead.
  let prevMutationAt = 0;
  let pendingMutations = 0;
  let mutationSweepDue = false;
  /** The lab's shared maze knowledge, keyed by lab hostname. The ONE piece of
   * walk progress that survives a walker's PID: the walker folds it in before
   * deciding and merges its field back after observing, so a re-seeded walker
   * starts with its predecessor's map. Never cleared: rungs have distinct hostnames, a
   * finished lab derives no more walks, and the install that regenerates a maze
   * also ends this process. */
  const labFields = new Map<string, LabField>();

  /** The maze as the panel needs it, assembled from the two halves only this
   * process holds: the shared field, and the walks its queues are carrying.
   *
   * Absent when there is nothing to say — no field learned and nobody walking —
   * which is the common case, because most runs never reach a lab at all. */
  const labReport = (at: number): DnetLabReport | undefined => {
    /** Live walks, by the lab they are walking. A queue's `active` job is the
     *  process; a pending one has not started, so it has no position yet and is
     *  deliberately not reported as a walker. */
    const walkers = new Map<string, DnetLabWalker[]>();
    for (const queue of queues.values()) {
      const job = queue.active;
      if (job === undefined || job.kind !== "walk") continue;
      const held = job.progress ?? {};
      const moves = typeof held["moves"] === "number" ? held["moves"] : 0;
      const walls = typeof held["walls"] === "number" ? held["walls"] : 0;
      const radars = typeof held["radars"] === "number" ? held["radars"] : 0;
      const list = walkers.get(job.state.host) ?? [];
      list.push({
        from: queue.host,
        ...(typeof held["at"] === "string" ? { at: held["at"] } : {}),
        moves,
        walls,
        radars,
        // Moves that landed, moves the engine refused, and radars: every one of
        // them paid a full authentication, and that is what the walk's pace is
        // measured in.
        attempts: moves + walls + radars,
        ...(typeof held["believedLeft"] === "number" ? { believedLeft: held["believedLeft"] } : {}),
        startedAt: job.startedAt ?? at,
        beatAt: job.beatAt ?? job.startedAt ?? at,
        pinned: stasisLinked.has(queue.host),
      });
      walkers.set(job.state.host, list);
    }
    // The lab we have most to say about: one being walked beats one merely
    // mapped, and there is only ever one open rung anyway.
    const host = [...walkers.keys()][0] ?? [...labFields.keys()][0];
    if (host === undefined) return undefined;
    const stage = labStage(host);
    if (stage === undefined) return undefined;
    const prior = labPrior(stage);
    const field = labFields.get(host) ?? emptyField();
    return {
      host,
      width: prior.width,
      height: prior.height,
      grid: renderLabField(field, prior),
      candidates: liveExitCandidates(field, prior),
      exitKnown: field.exit !== undefined,
      walkers: (walkers.get(host) ?? []).sort((a, b) => a.from.localeCompare(b.from)),
    };
  };

  const rendezvous: DnetRendezvous = {
    protocol: RENDEZVOUS_PROTOCOL,
    buildId: launch.buildId,
    generation: mission.generation,
    controllerPid: ns.pid,
    startedAt: bootAt,
    lastBeatAt: bootAt,
    mutationEpoch: 0,
    noteMutation(at) {
      if (at <= mutationTurnAt) return rendezvous.mutationEpoch;
      mutationTurnAt = at;
      rendezvous.mutationEpoch++;
      prevMutationAt = lastMutationAt ?? 0;
      lastMutationAt = at;
      pendingMutations++;
      mutationSweepDue = true;
      signalDerive();
      return rendezvous.mutationEpoch;
    },
    queues,
    probes,
    bootstraps,
    bootstrapDone,
    signalDerive,
    // Home's whole view of the darknet, handed over once and forgotten. See the
    // note on DnetRendezvous.drain for why it clears.
    drain() {
      // Built once: the grid is a couple of thousand characters and rendering it
      // twice for a spread guard would be the most expensive thing in this
      // function.
      const lab = labReport(Date.now());
      const drained = {
        hosts: pendingHosts.splice(0, pendingHosts.length),
        credentials: pendingCredentials.splice(0, pendingCredentials.length),
        attempts: pendingAttempts.splice(0, pendingAttempts.length),
        logDrains: pendingLogDrains.splice(0, pendingLogDrains.length),
        codes: { ...codes },
        ...(spread ? { spread } : {}),
        ...(farm ? { farm } : {}),
        ...(hold ? { hold } : {}),
        ...(storm ? { storm } : {}),
        ...(pendingStasisSnapshot !== undefined ? { stasisSnapshot: pendingStasisSnapshot } : {}),
        credentialRejections: [...pendingCredentialRejections.values()],
        backdoorInvalidations: [...pendingBackdoorInvalidations.values()],
        ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
        ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
        ...(lastStormFiredAt !== undefined ? { stormFiredAt: lastStormFiredAt } : {}),
        ...(grammarUnrecognised > 0
          ? { grammar: { unrecognised: grammarUnrecognised, shapes: { ...grammarShapes } } }
          : {}),
        karmaLoss,
        residents: [...queues.values()].map((queue) => ({
          host: queue.host,
          lastBeatAt: queue.lastBeatAt,
          pending: queue.pending.length,
          ...(queue.active ? { active: queue.active.kind } : {}),
          // Computed, not reported: the worker no longer measures RAM. This is
          // what the overseer would size its next job into — see `usableGb`.
          freeGb: usableGb(queue.host, Date.now(), expiryOpts()),
          completed: queue.completed,
          failed: queue.failed,
          ...(queue.lastError !== undefined ? { lastError: queue.lastError } : {}),
        })),
        residentsLost,
        mutations: pendingMutations,
        // NOT cleared below with the deltas: the maze is a standing picture, not
        // a since-last-drain event, and home ASSIGNS it. Clearing it would blank
        // the panel between drains.
        ...(lab !== undefined ? { lab } : {}),
      };
      for (const key of Object.keys(codes)) delete codes[key];
      // A DELTA, cleared like `codes` and `residentsLost` beside it. Handing
      // home a running total instead would work only for as long as this
      // overseer lives: a re-seeded one starts at zero, and home — which
      // assigns rather than accumulates — would silently drop the karma every
      // cache before the restart bought.
      karmaLoss = 0;
      residentsLost = 0;
      pendingMutations = 0;
      pendingStasisSnapshot = undefined;
      pendingCredentialRejections.clear();
      pendingBackdoorInvalidations.clear();
      return drained;
    },
    order(orders: DnetOrders) {
      charisma = orders.charisma;
      if (orders.netDepth !== undefined) netDepth = orders.netDepth;
      if (orders.bitNode !== undefined) bitNode = orders.bitNode;
      if (orders.vaultSnapshot !== undefined) {
        const { entries, at: snapshotAt } = orders.vaultSnapshot;
        const supplied = new Set(entries.map((entry) => entry.hostname));
        for (const [hostname, entry] of vault) {
          if (!supplied.has(hostname) && entry.at <= snapshotAt) vault.delete(hostname);
        }
        for (const entry of entries) {
          const host = knowledge.hosts[entry.hostname];
          if (host?.goneAt !== undefined) continue;
          if (entry.identity !== undefined && host?.identity !== undefined && entry.identity !== host.identity) continue;
          vault.set(entry.hostname, entry);
          markCredentialKnown(host);
        }
      }
      if (orders.openLabCache !== undefined) openLabCache = orders.openLabCache;
      if (orders.promoteSymbols !== undefined) promoteSymbols = [...orders.promoteSymbols];
      if (orders.crimeSuccessMult !== undefined) crimeSuccessMult = orders.crimeSuccessMult;
      if (orders.backdoors !== undefined) {
        backdoors.clear();
        for (const entry of orders.backdoors) backdoors.set(entry.hostname, entry.installedAt);
      }
      if (orders.stasisLimit !== undefined) stasisLimit = orders.stasisLimit;
      if (orders.labExpected !== undefined) labExpected = orders.labExpected;
      // Home's probe is the timestamped authority on which hosts are pinned.
      // Reconcile it with newer local pin/release events so a stale snapshot
      // cannot resurrect a released link or erase a link just spent. Replaying
      // the snapshot also prevents a re-seeded overseer from filing duplicate
      // 16 GB pin jobs and collecting 453s.
      if (orders.stasisSnapshot !== undefined && orders.stasisSnapshot.at > stasisObservedAt) {
        stasisObservedAt = orders.stasisSnapshot.at;
        stasisLinked.clear();
        for (const hostname of orders.stasisSnapshot.hosts) stasisLinked.add(hostname);
      }
      // Replayed after a re-seed so a fresh overseer does not believe a window
      // is open that home watched close under the previous one.
      if (orders.lastPhishCacheAt !== undefined) {
        lastPhishCacheAt = Math.max(lastPhishCacheAt ?? 0, orders.lastPhishCacheAt);
      }
      // Same replay as the phishing window, with one extra duty: a stamp still
      // inside the quiet window means this (re-seeded) overseer is standing in
      // a net mid-storm or just after one, so the wipe it never saw is due.
      if (orders.lastStormAt !== undefined && orders.lastStormAt > (lastStormFiredAt ?? 0)) {
        lastStormFiredAt = orders.lastStormAt;
        if (Date.now() - lastStormFiredAt < STORM_QUIET_MS) {
          stormWipeAt = lastStormFiredAt + STORM_QUIET_MS;
        }
      }
      if (orders.standDown === true) standDown = true;
    },
  };
  // BOOTSTRAP. Give the fold a darkweb identity before its first direct probe
  // and details sweep enrich it.
  knowledge = foldReports(knowledge, [{ hostname: selfHost, at: bootAt, present: true }], bootAt).knowledge;

  // Pre-create darkweb's queue so work derived on the first observation pass is
  // retained even if the co-launched resident has not registered yet. The
  // absent guard preserves a queue if the resident won the launch race.
  if (!queues.has(selfHost)) {
    queues.set(selfHost, { host: selfHost, pending: [], lastBeatAt: bootAt, completed: 0, failed: 0 });
  }

  realm.dnet_overseer = rendezvous;

  // Permanent probers own the blocking `nextMutation()` waits and publish
  // their edge into `rendezvous.noteMutation`. Keeping the same waiter inside
  // the controller would occupy its one Netscript concurrency slot and collide
  // with every synchronous details, RAM, liveness, and cancellation call.

  const note = (code: number, n = 1): void => {
    codes[String(code)] = (codes[String(code)] ?? 0) + n;
  };

  const recordStasis = (hostname: string, linked: boolean): void => {
    if (linked) stasisLinked.add(hostname);
    else stasisLinked.delete(hostname);
    stasisObservedAt = Math.max(Date.now(), stasisObservedAt + 1);
    pendingStasisSnapshot = { hosts: [...stasisLinked].sort(), at: stasisObservedAt };
  };

  const removePendingFor = <T extends { hostname: string }>(entries: T[], hostname: string): void => {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]!.hostname === hostname) entries.splice(index, 1);
    }
  };

  const invalidateBackdoor = (hostname: string): void => {
    if (!backdoors.delete(hostname)) return;
    pendingBackdoorInvalidations.set(hostname, { hostname, at: Date.now() });
  };

  /** Settle pending work locally and ask active work to stop cooperatively. */
  const retireJobs = (
    hostname: string,
    reason: string,
    applies: (job: DnetJob) => boolean,
  ): void => {
    const targetsHost = (job: DnetJob): boolean => job.state.host === hostname && applies(job);
    for (const queue of queues.values()) {
      const retired = queue.pending.filter(targetsHost);
      if (retired.length > 0) {
        queue.pending = queue.pending.filter((job) => !targetsHost(job));
        for (const job of retired) job.settle({ ok: false, targetState: 'cancelled', detail: reason });
      }
      if (queue.active && targetsHost(queue.active)) queue.active.cancelReason = reason;
    }
  };

  const forgetGuesses = (hostname: string): void => {
    for (const key of [...spentGuesses]) {
      if (key.startsWith(`${hostname}\u0000`)) spentGuesses.delete(key);
    }
  };

  /** A verified credential makes only cracking work obsolete. */
  const retireCracking = (hostname: string, reason: string): void => {
    forgetGuesses(hostname);
    retireJobs(hostname, reason, (job) => job.kind === 'attempt');
  };

  /** Retire PID/session state for a host that stopped carrying a worker. This
   * is deliberately weaker than lifetime retirement: a restart preserves IP,
   * password, admin rights and the solver ledger. */
  const retireVantage = (hostname: string, reason: string, known?: DnetHostQueue): void => {
    const resident = known ?? queues.get(hostname);
    if (resident !== undefined) {
      queues.delete(hostname);
      if (resident.active !== undefined) resident.active.fail(new Error(reason));
      for (const job of resident.pending) job.fail(new Error(reason));
    }
    probes.delete(hostname);
    bootstraps.delete(hostname);
    bootstrapDone.delete(hostname);
    dirty.delete(hostname);
    lastPlantAt.delete(hostname);
  };

  /** Retire every fact and job tied to one server lifetime. */
  const retireLifetime = (hostname: string, reason: string): void => {
    // First retire work aimed AT the old identity, wherever it was running.
    // Then retire the host as a VANTAGE: a queue is PID-bound process state and
    // cannot survive deletion or hostname reuse.
    retireJobs(hostname, reason, () => true);
    retireVantage(hostname, reason);
    vault.delete(hostname);
    invalidateBackdoor(hostname);
    if (stasisLinked.has(hostname)) recordStasis(hostname, false);
    labFields.delete(hostname);
    authenticationEpoch.delete(hostname);
    forgetGuesses(hostname);
    removePendingFor(provisionalPool, hostname);
    removePendingFor(pendingHosts, hostname);
    removePendingFor(pendingCredentials, hostname);
    pendingCredentialRejections.delete(hostname);
    removePendingFor(pendingAttempts, hostname);
    removePendingFor(pendingLogDrains, hostname);
  };

  /** A cached credential was rejected while the same IP still answered. That
   * contradicts the engine's lifetime invariant, but it is not evidence that
   * the host died. Quarantine only the credential; topology, RAM, attempts and
   * ring evidence still describe the same live identity. */
  const retireRejectedCredential = (hostname: string): void => {
    retireJobs(hostname, "credential rejected", (job) => job.kind === "plant");
    vault.delete(hostname);
    const host = knowledge.hosts[hostname];
    if (host !== undefined) delete host.credentialKnown;
    authenticationEpoch.delete(hostname);
    removePendingFor(provisionalPool, hostname);
    removePendingFor(pendingCredentials, hostname);
    pendingCredentialRejections.set(hostname, {
      hostname,
      ...(host?.identity !== undefined ? { identity: host.identity } : {}),
      at: Date.now(),
    });
  };

  // Successful authentication writes through to the shared vault immediately;
  // it never depends on the worker surviving long enough to settle its job.
  // Authentication can only arrive after startup, once the task filer below is
  // installed. This forward callback breaks the construction cycle: job bodies
  // need recordCredential, while filing needs the job bodies.
  let queueAuthenticatedPlant!: (hostname: string, from: string) => void;
  let queueNeighbourGuess!: (hostname: string, password: string, from: string, at: number) => void;
  const recordCredential = (entry: VaultEntry, from: string): void => {
    if (entry.hostname.length === 0) return;
    const host = knowledge.hosts[entry.hostname];
    if (host?.goneAt !== undefined) return;
    const identity = entry.identity ?? host?.identity;
    if (entry.identity !== undefined && host?.identity !== undefined && entry.identity !== host.identity) return;
    const verified = { ...entry, ...(identity !== undefined ? { identity } : {}) };
    vault.set(entry.hostname, verified);
    markCredentialKnown(host);
    for (let index = provisionalPool.length - 1; index >= 0; index--) {
      if (provisionalPool[index]!.hostname === entry.hostname) provisionalPool.splice(index, 1);
    }
    retireCracking(entry.hostname, 'credential verified; cracking retired');
    pendingCredentials.push(verified);
    authenticationEpoch.set(entry.hostname, rendezvous.mutationEpoch);
    // File before returning: the authenticating process consumes this plant
    // from atExit without waiting for a promise reaction or derive tick.
    queueAuthenticatedPlant(entry.hostname, from);
  };
  const recordLoose = (password: string): void => {
    if (loosePool.includes(password)) return;
    loosePool.push(password);
    // Oldest out first. A leaked password belongs to a host that may since
    // have been deleted and re-minted, so age is exactly the right discard.
    if (loosePool.length > MAX_LOOSE_PASSWORDS) loosePool.shift();
  };

  const recordProvisional = (entry: ProvisionalCredential): void => {
    if (entry.hostname.length === 0) return;
    const host = knowledge.hosts[entry.hostname];
    if (host?.goneAt !== undefined || vault.has(entry.hostname)) return;
    const identity = entry.identity ?? host?.identity;
    const candidate = { ...entry, ...(identity !== undefined ? { identity } : {}) };
    const existing = provisionalPool.findIndex((held) =>
      held.hostname === candidate.hostname
      && held.password === candidate.password
      && held.identity === candidate.identity);
    if (existing >= 0) provisionalPool.splice(existing, 1);
    provisionalPool.push(candidate);
    if (provisionalPool.length > MAX_PROVISIONAL_CREDENTIALS) provisionalPool.shift();
  };

  const projectLooseTarget = (hostname: string, at: number, expiry: ExpiryOpts): LooseTarget => {
    const host = knowledge.hosts[hostname];
    const length = fresh<number>(host, "passwordLength", at, expiry);
    const format = fresh<string>(host, "passwordFormat", at, expiry);
    return {
      hostname,
      ...(length !== undefined ? { passwordLength: length } : {}),
      ...(format !== undefined ? { passwordFormat: format } : {}),
      hasCredential: vault.has(hostname),
      ...(fresh<boolean>(host, "isStationary", at, expiry) === true ? { isStationary: true } : {}),
      ...(host?.goneAt !== undefined ? { gone: true } : {}),
    };
  };

  const recordNeighbourPassword = (source: string, password: string, at: number): void => {
    const probe = probes.get(source);
    const authenticated = authenticationEpoch.get(source);
    // This file names no owner. It is safe to bind only when authentication,
    // the target's first probe and this inventory all belong to the same net.
    if (!probe || !exactNeighbourClueEpoch(
      authenticated,
      probe.epoch,
      rendezvous.mutationEpoch,
    )) {
      recordLoose(password);
      return;
    }
    const targets = probe.neighbours.map((hostname) => projectLooseTarget(hostname, at, expiryOpts()));
    for (const candidate of looseCandidates([password], targets)) {
      recordProvisional({ hostname: candidate.hostname, password, via: "neighbour-file", at });
      queueNeighbourGuess(candidate.hostname, password, source, at);
    }
  };

  const recordFileEvidence = (hostname: string, evidence: PasswordEvidence): void => {
    if (knowledge.hosts[hostname] === undefined) {
      // Upstream selected a real nearby server when it wrote this named clue.
      // Establish the owner before folding the evidence; otherwise both this
      // fold and home's later fold discard it for lack of a host record.
      const named: ReportHost = { hostname, at: evidence.at, present: true };
      knowledge = foldReports(knowledge, [named], evidence.at, expiryOpts()).knowledge;
      pendingHosts.push(named);
    }
    const pendingAuthRecords = knowledge.hosts[hostname]?.ring?.pendingAuthRecords ?? 0;
    const outcome: LogDrainOutcome = { pendingAuthRecords, evidence: [evidence] };
    foldLogDrain(knowledge.hosts[hostname], outcome);
    pendingLogDrains.push({ hostname, outcome });
  };

  /** Fold a finished job's ordinary findings into the map, so the next
   * derivation already accounts for them. Attempts and logs arrive earlier via
   * the write-through functions below. */
  const absorb = (result: DnetJobResult): void => {
    // The fold's own clock, not a fact's: each reported host carries the time
    // the job that saw it looked.
    const at = Date.now();
    if (result.hosts && result.hosts.length > 0) {
      const folded = foldReports(knowledge, result.hosts, at, expiryOpts());
      knowledge = folded.knowledge;
      for (const hostname of folded.hostsReplaced) retireLifetime(hostname, 'server identity replaced');
      for (const hostname of folded.hostsForgotten) retireLifetime(hostname, 'expired server tombstone forgotten');
      for (const host of result.hosts) {
        if (!host.present) retireLifetime(host.hostname, 'server is gone');
        else if (host.neighbours !== undefined) {
          const queue = queues.get(host.hostname);
          if (queue) {
            retireLostEdgeJobs(queue, host.hostname, host.neighbours);
            // A pin's edge is the lab, not its own adjacency, so it needs its
            // own retire pass — the release verdict fires on the next derive.
            retireLostPin(queue, host.hostname, host.neighbours);
          }
        }
      }
      pendingHosts.push(...result.hosts);
      // Fresh topology can make a host plantable this instant — re-derive now
      // rather than at the next tick. Only when a neighbour list actually
      // arrived: an attempt/bleed reports one host with no adjacency
      // and would wake the loop for nothing.
      if (result.hosts.some((host) => host.neighbours !== undefined)) signalDerive();
    }

    for (const [code, count] of Object.entries(result.codes ?? {})) note(Number(code), count);
    if (result.grammar) {
      grammarUnrecognised += result.grammar.unrecognised;
      for (const shape of result.grammar.shapes) {
        // Only ever counts a shape we have already met once the map is full, so
        // the bound cannot hide a shape that is actually recurring.
        if (grammarShapes[shape] !== undefined) grammarShapes[shape] += 1;
        else if (Object.keys(grammarShapes).length < MAX_GRAMMAR_SHAPES) grammarShapes[shape] = 1;
      }
    }
    if (result.karmaLoss !== undefined) karmaLoss += result.karmaLoss;
    if (result.charismaNeeded !== undefined) {
      charismaNeeded = Math.max(charismaNeeded ?? 0, result.charismaNeeded);
    }

    // A won cache window is the ONLY sighting we ever get of the net-wide
    // phishing cooldown. Stamping it here rather than in the job keeps the
    // belief in the one place that survives the job's process.
    if ((result.codes ?? {})[LOCAL_CODE.PhishingCacheWon] !== undefined) lastPhishCacheAt = at;
  };

  // Jobs write each completed call/read through immediately. The target entry,
  // not the worker process, owns the conversation and survives a worker death.
  const recordAttempt = (hostname: string, outcome: AttemptOutcome): void => {
    foldAttempts(knowledge.hosts[hostname], [outcome]);
    if (!pendingAttempts.some((entry) => entry.hostname === hostname && entry.outcome === outcome)) {
      pendingAttempts.push({ hostname, outcome });
    }
  };
  const recordLogDrain = (hostname: string, outcome: LogDrainOutcome): void => {
    foldLogDrain(knowledge.hosts[hostname], outcome);
    pendingLogDrains.push({ hostname, outcome });
  };

  /** Queue one job on a host, and KEEP ITS PROMISE.
   *
   * The promise is how the overseer tells "still working" from "died holding
   * the host", and out here the second is the common case: a mutation tick
   * restarts a server and takes whatever was running on it. A settled promise is
   * a result; one that never settles is a death, and the timeout below is what
   * turns the difference into a fact instead of a leak. */
  const enqueue = (queue: DnetHostQueue, draft: Omit<DnetJob, "settle" | "fail">): boolean => {
    // The queue-depth bound. `planSpread` deliberately files every plant it can
    // justify and lets this decide how many actually fit.
    if (queue.pending.length >= MAX_QUEUED_PER_HOST) return false;
    if (queue.pending.some((entry) => entry.id === draft.id) || queue.active?.id === draft.id) return false;
    const job = draft as DnetJob;
    // THE PESSIMISTIC STAMP. A storm job's host has ~5 s of life after a
    // successful `unleashStormSeed` — `restartAllDarknetServers` takes its
    // agent — so the authoritative result may never drain. Filed-means-fired
    // is the assumption that cannot be caught out: a wasted quiet period costs
    // 35 s of stillness, while a skipped wipe leaves the whole map asserting a
    // net that no longer exists. Rolled back below if the job reports it did
    // not fire.
    if (job.kind === "storm") {
      stormStampPrior = lastStormFiredAt;
      lastStormFiredAt = Date.now();
      stormWipeAt = lastStormFiredAt + STORM_QUIET_MS;
    }
    let absorbSettled: (result: DnetJobResult) => void = () => {};
    const promise = new Promise<DnetJobResult>((resolve, reject) => {
      job.settle = (result) => {
        // Fold before resolving: the dying process's atExit must see every job
        // and fact caused by this completion in the same engine turn.
        absorbSettled(result);
        resolve(result);
      };
      job.fail = reject;
    });
    absorbSettled = (result) => {
        absorb(result);
        // The job says it may have dropped a `.cache`/contract but did not look.
        // Mark the host so an inventory job reads it, and wake the loop so that
        // list is filed now. An inventory result is not itself dirtying.
        if (result.dirtied && job.kind !== "inventory") {
          dirty.add(job.state.host);
          fileListJobs();
          signalDerive();
        }
        if (result.targetState === 'edge-lost' || result.targetState === 'replaced') {
          lastMutationAt = Date.now();
        }
        const reportedGone = result.hosts?.some((host) => host.hostname === job.state.host && !host.present) === true;
        if (result.targetState === 'gone' && !reportedGone) {
          const gone: ReportHost = { hostname: job.state.host, at: Date.now(), present: false };
          knowledge = foldReports(knowledge, [gone], gone.at, expiryOpts()).knowledge;
          retireLifetime(job.state.host, 'server reported gone');
          pendingHosts.push(gone);
        } else if (result.targetState === 'replaced'
          && result.hosts?.some((host) => host.hostname === job.state.host && host.present
            && host.identity !== undefined && host.identity !== job.state.targetIdentity) !== true) {
          retireLifetime(job.state.host, 'server identity changed');
        } else if (result.targetState === 'credential-rejected') {
          retireRejectedCredential(job.state.host);
        } else if (result.targetState === 'launch-refused' && job.state.sessionOnly === true
          && !stasisLinked.has(job.state.host)) {
          // Remote exec through an ordinary backdoor is the only reach belief
          // the worker could not inspect directly. A refusal invalidates that
          // stamped route, not the server lifetime.
          invalidateBackdoor(job.state.host);
        }
        if (job.kind === "plant" && job.state.bootstrapReclaim !== true
          && (result.ok || result.targetState === "launch-refused")) {
          lastPlantAt.set(job.state.host, Date.now());
        }
        // The only place a link is ever recorded — or erased. `setStasisLink`
        // takes no host, so the host it acted on is the one the job ran on; a
        // 453 on the pin direction means the engine's limit is already spent,
        // which is home's belief being wrong rather than ours. Every success
        // publishes the complete new set with a monotonic observation time.
        if (job.kind === "pin" && result.ok) {
          const linked = job.state.unpin !== true;
          recordStasis(job.state.host, linked);
          // The lab pin transitions into probe-free preparation; spare pins
          // retain their prober and need only a remote resident launch.
          if (linked && job.state.edge !== undefined) killWalkHostProber(job.state.host);
          // The spawn-free pin/release process is about to end. Remove its dead
          // queue now and derive the remote (pin) or adjacent (release) plant.
          lastPlantAt.delete(job.state.host);
          queues.delete(job.state.host);
          signalDerive();
        }
        // The storm stamp resolves. A drained `stormFiredAt` is the
        // authoritative clock and replaces the pessimistic one; a result that
        // says the fire did NOT happen (the seed was gone, the engine refused)
        // puts the clock back so the quiet period and the wipe stand down.
        if (job.kind === "storm") {
          if (result.stormFiredAt !== undefined) {
            lastStormFiredAt = Math.max(lastStormFiredAt ?? 0, result.stormFiredAt);
            stormWipeAt = lastStormFiredAt + STORM_QUIET_MS;
          } else {
            lastStormFiredAt = stormStampPrior;
            stormWipeAt = undefined;
          }
        }
        // A guess that was refused is never offered again: the pair is wrong,
        // and it would otherwise re-derive on every tick for ever.
        const lastAttempt = result.attempts?.[result.attempts.length - 1];
        if (job.kind === "attempt" && job.state.guess !== undefined
          && lastAttempt !== undefined && conclusiveAttempt(lastAttempt)) {
          spentGuesses.add(`${job.state.host}\u0000${job.state.guess}`);
        }
    };
    void promise.catch(() => {
        if (job.kind === "plant" && job.state.bootstrapReclaim !== true) {
          lastPlantAt.set(job.state.host, Date.now());
        }
        // JobDied, not NotEnoughRam: this path is a job whose promise was
        // REJECTED — its host restarted under it, its resident was swept, or it
        // timed out — and counting that as a RAM shortage made a dying net read
        // as a full one.
        note(LOCAL_CODE.JobDied);
    });
    // Filed IN PRIORITY ORDER, not in arrival order. The resident takes the
    // first pending job that FITS, so with farm work in the queue a
    // forty-second phish enqueued one tick before a plant would hold the host
    // away from the plant for its whole batch. Stable: equal priorities keep
    // the order they were derived in, which is already deterministic.
    const at = queue.pending.findIndex((entry) => entry.priority > job.priority);
    if (at === -1) queue.pending.push(job);
    else queue.pending.splice(at, 0, job);
    // Wake the resident NOW rather than letting it discover the job on its next
    // poll: this is the whole point of the wake handle. Fired only here, on the
    // single path that actually adds work — the early returns above (queue full,
    // duplicate id) added nothing to wake for.
    signalQueueWork(queue);
    return true;
  };

  // What each job costs the host that runs it, priced from the game's own
  // table. `ns.getFunctionRamCost` is 0 GB, so this is free.
  const budgets: Record<string, number> = Object.fromEntries(
    Object.entries(JOB_METHODS).map(([kind, methods]) => [kind, priceAgent(ns, methods)]),
  );
  // The fixed reservation every planted host holds for its prober — the ONE
  // script that shares the host with the worker. Every host budget is computed
  // around it, so a worker never sizes a job into RAM the prober is standing in.
  // Exactly 1.8 GB (base + probe), NO margin: the prober's surface is known to
  // the byte, so there is nothing to hedge. See `proberReserveGb`.
  const proberGb = proberReserveGb(ns);
  const controllerGb = priceAgent(ns, CONTROLLER_METHODS);
  /** The RAM the overseer may size a worker's next job into, computed rather than
   *  reported. A darknet host runs exactly two of our scripts — the prober
   *  (reserved above) and the worker, which SPAWNS INTO its job — so the whole of
   *  `maxRam − blockedRam` less the prober's reserve is the worker's to fill.
   *
   *  NO guard band. `blockedRam` only ever FALLS for a host's lifetime
   *  (`memoryReallocation` grinds it toward 0, and a restart-and-re-roll is a NEW
   *  host identity with its own entry), so a stale reading always leaves us
   *  believing LESS is free than truly is — conservative, never an over-size.
   *  There is nothing left for a margin to hedge against.
   *
   *  `maxRam` is an identity fact read once; `blockedRam` refreshes every mutation
   *  when the overseer re-reads every host's details. `usedRam` is never consulted:
   *  the worker's own footprint is the thing being sized, not a subtrahend, and
   *  the prober's is the constant we already hold back. The worker's own
   *  base + spawn (1.6 + 2.0) are NOT a separate subtraction here — every job's
   *  per-thread price already carries them (`AGENT_BASE_METHODS` + base), so they
   *  are reserved inside the thread arithmetic, not beside it. */
  const usableGb = (hostname: string, at: number, expiry: ExpiryOpts, reserveProber = true): number => {
    const host = knowledge.hosts[hostname];
    const maxRam = fresh<number>(host, "maxRam", at, expiry);
    if (maxRam === undefined) return 0;
    const blocked = fresh<number>(host, "blockedRam", at, expiry) ?? 0;
    // A lab walker's host runs the walk ALONE — its prober is killed — so it keeps
    // nothing back for one. Every other host holds the 1.8 GB reserve.
    const fixedReserve = reserveProber ? (hostname === selfHost ? controllerGb : proberGb) : 0;
    return Math.max(0, maxRam - blocked - fixedReserve);
  };

  // Kill the prober on a host being turned into a lab walker. The walk wants
  // every byte for `authenticate`, and a prober beside it is 1.8 GB of threads
  // lost. `kill` by pid works from darkweb, no connection. Once only: `pid` is
  // zeroed after so a re-derive does not re-kill (harmless no-op) and the
  // staleness revival — which skips walk hosts regardless — never re-launches it.
  // The re-plant after the lab completes brings a fresh prober with a new pid.
  const killWalkHostProber = (host: string): void => {
    const probe = probes.get(host);
    if (probe === undefined || probe.pid <= 0) return;
    ns["kill"](probe.pid);
    probes.set(host, { ...probe, pid: 0 });
  };
  /** What one thread of each farm kind costs, for the ladder's own room checks.
   *  `ramOverride` is charged PER THREAD, so this is a unit price. */
  const farmGbPerThread: Record<FarmKind, number> = {
    cache: budgets["cache"] ?? budgets["inventory"]!,
    reclaim: budgets["reclaim"] ?? budgets["inventory"]!,
    phish: budgets["phish"] ?? budgets["inventory"]!,
    promote: budgets["promote"] ?? budgets["inventory"]!,
  };
  /** The heaviest thing we would like a host to be able to hold. It is what
   *  turns "this host is cramped" into a reason to grind its block down.
   *
   *  Over `ROUTINE_JOB_KINDS` rather than over every declared kind: a deliberate
   *  one-off like a stasis pin is far larger than anything a host does routinely,
   *  and letting it set this number would declare the whole net cramped and send
   *  the reclaim ladder grinding everywhere. See `ROUTINE_JOB_KINDS`. */
  const heaviestJobGb = Math.max(
    ...ROUTINE_JOB_KINDS.map((kind) => budgets[kind] ?? 0),
  );

  // The work itself, in `game/dnet/jobs.ts`. Charisma and the ledger travel as
  // FUNCTIONS because this file reassigns both — charisma on every order from
  // home, the ledger on every attempt that lands — and a body that captured
  // either by value would be authenticating on a stale number.
  const bodies = makeJobBodies({
    charisma: () => charisma,
    ledgerFor: (host) => knowledge.hosts[host]?.attempts,
    ringFor: (host) => knowledge.hosts[host]?.ring,
    recordAttempt,
    recordLogDrain,
    recordCredential,
    recordLoose,
    recordNeighbourPassword,
    recordFileEvidence,
    labField: (host) => labFields.get(host),
    // MERGED, never assigned: two walkers publish into this between each
    // other's reads, so an assignment would drop whatever the other one learned
    // since. `mergeLabFields` returns the base untouched when there is nothing
    // to fold in, so the first publish costs nothing.
    publishLabField: (host, field) => {
      const held = labFields.get(host);
      labFields.set(host, held === undefined ? field : mergeLabFields(held, field));
    },
    recordProvisional,
  });
  // The clock the expiries run on, rebuilt per tick because home's orders can
  // update both fields at any time.
  const expiryOpts = (): ExpiryOpts => ({
    ...(netDepth !== undefined ? { netDepth } : {}),
    ...(bitNode !== undefined ? { bitNode } : {}),
    backdoored: backdoors.size,
    // Ours, and exact: nothing else in the run pins or releases a host, so an
    // observed copy would be a worse source that can itself go stale.
    ...(stasisLinked.size > 0 ? { stasisLinked } : {}),
  });

  /** The three DELIBERATE decisions: what to pin, what to push, and whether to
   * start walking a maze.
   *
   * None of these is something a host does as a matter of course, which is why
   * none of them is in `ROUTINE_JOB_KINDS` and why they are planned here rather
   * than in the farm ladder. Each is decided once, for one host, out of the
   * whole net — and each has a real price, which is what separates them from
   * spreading and cracking, where the answer is always "yes, everywhere".
   *
   * The policies themselves are pure and live in `shared/strategy/dnet/hold.ts`.
   * What this function adds is the two things that file cannot see: how much RAM
   * a candidate actually has, and whether anything could put a resident back. */
  /** Every host as the hold policies need to see it.
   *
   * The two things `hold.ts` cannot work out for itself are added here: how much
   * RAM a candidate actually has (the resident's own measurement, plus the
   * allocation it hands back when it spawns), and which hosts are carrying a
   * walk. A host running the maze walker is IRREPLACEABLE, and that is not a
   * figure of speech: the walk is keyed by PID, so losing the process loses the
   * whole maze with no way to resume. */
  const projectHoldHosts = (at: number, expiry: ExpiryOpts): HoldHost[] => {
    // A running or pending walker is irreplaceable because maze position is
    // keyed by PID; its host must remain the first stasis target.
    const walking = new Set<string>();
    for (const queue of queues.values()) {
      if (queue.active?.kind === "walk") walking.add(queue.host);
      for (const job of queue.pending) {
        if (job.kind === "walk") walking.add(queue.host);
      }
    }
    return Object.values(knowledge.hosts).map((host) => {
      const queue = queues.get(host.hostname);
      const difficulty = fresh<number>(host, "difficulty", at, expiry);
      const maxRam = fresh<number>(host, "maxRam", at, expiry);
      return {
        ...holdHostFrom(host, {
          at,
          expiry,
          agentAlive: queue !== undefined,
          hasCredential: vault.has(host.hostname),
          stasisLinked: stasisLinked.has(host.hostname),
        }),
        ...(difficulty !== undefined ? { difficulty } : {}),
        ...(maxRam !== undefined ? { maxRam } : {}),
        freeGb: usableGb(host.hostname, at, expiry),
        ...(walking.has(host.hostname) ? { irreplaceable: true } : {}),
      };
    });
  };

  /** Whether to start the single maze walker, and from where.
   *
   * The whole point of the feature's deep half. A completed lab hands over admin
   * rights, a cache and a queued augmentation, and it DEEPENS THE NET, which is
   * the only thing that ever changes the mutation clock.
   *
   * A closure rather than a top-level function because it both reads `charisma`
   * and writes `charismaNeeded`, and the overseer reassigns the first on every
   * order from home: a version that captured either by value would gate the walk
   * on last hour's number. */
  const planWalk = (
    at: number,
    expiry: ExpiryOpts,
    hosts: readonly HoldHost[],
    refuse: (host: string, why: string, detail: string) => void,
  ): { lab?: HoldHost; candidate?: string; tasks: HoldTask[]; walking: boolean } => {
    const lab = hosts.find((host) => isLabyrinth(
      host.hostname,
      fresh<string>(knowledge.hosts[host.hostname]!, "modelId", at, expiry),
    ) && !host.gone);
    // Not a refusal worth a name per host: there is exactly one lab in a net
    // and we have not laid eyes on it.
    if (lab === undefined) return { tasks: [], walking: false };
    if (vault.has(lab.hostname)) {
      refuse(lab.hostname, "lab-walked", "we already hold this lab's password, so its maze has been finished");
      return { lab, tasks: [], walking: false };
    }
    const needed = labStage(lab.hostname)?.cha;
    if (needed !== undefined && charisma < needed) {
      // The one gate in the feature that cannot be worked around: below the
      // lab's charisma EVERY move answers 451, so starting would spend a host
      // for hours and learn nothing. Posted as a career need instead.
      charismaNeeded = Math.max(charismaNeeded ?? 0, needed);
      refuse(lab.hostname, "charisma", `the maze needs charisma ${needed}, and every move below it answers 451`);
      return { lab, tasks: [], walking: false };
    }
    // A lab has one walker. A second PID would spend the same shared map while
    // competing for the stasis link and the candidate host.
    let walkerAt: string | undefined;
    for (const queue of queues.values()) {
      for (const job of [queue.active, ...queue.pending]) {
        if (job === undefined || job.kind !== "walk") continue;
        walkerAt = queue.host;
      }
    }
    // Its host must be ADJACENT to the lab, which out here means on the
    // bottom row — `addServerToNetwork` wires anything landing at
    // `netDepth - 1` to the labyrinth automatically.
    const vantageHost = chooseLabVantage(hosts.filter((host) =>
      (host.agentAlive || host.stasisLinked === true)
      && host.neighbours?.includes(lab.hostname) === true
      && vault.has(host.hostname)));
    const tasks: HoldTask[] = [];
    // A walker is threaded to its vantage: every maze move is an
    // `authenticate`, whose duration shrinks `1/(1 + 0.2*(threads-1))` with
    // the calling script's threads, and a deep lab is thousands of moves — so
    // the same RAM that would sit idle under a 1-thread walk buys hours of
    // wall clock. The host holds one job at a time, so there is nothing else
    // the RAM could have done. No ceiling: the spawn-free per-thread
    // `budgets["walk"]` is exactly 2.0 GB (base + authenticate + labradar), and
    // the engine charges it per thread, so this fills the vantage exactly.
    if (walkerAt === undefined) {
      const vantage = vantageHost?.hostname;
      if (vantage === undefined) {
        refuse(
          lab.hostname,
          "no-vantage",
          "nothing of ours is standing next to the labyrinth with room for a walker",
        );
        return { lab, tasks, walking: false };
      }
      const standing = hosts.find((host) => host.hostname === vantage);
      if (standing?.stasisLinked !== true) {
        refuse(vantage, "walker-unpinned", "the lab candidate must be in position and stasis-linked before preparation finishes");
        return { lab, candidate: vantage, tasks, walking: false };
      }
      if (standing.blockedRam === undefined) {
        refuse(vantage, "ram-unknown", "the lab candidate's blocked RAM is not fresh");
        return { lab, candidate: vantage, tasks, walking: false };
      }
      if (standing.blockedRam > 0) {
        refuse(vantage, "ram-blocked", `${standing.blockedRam.toFixed(2)}GB remains before the lab walker can start`);
        return { lab, candidate: vantage, tasks, walking: false };
      }
      if (!queues.has(vantage)) {
        refuse(vantage, "walker-unstaffed", "the pinned lab candidate is being reclaimed or awaiting its resident");
        return { lab, candidate: vantage, tasks, walking: false };
      }
      const maxRam = fresh<number>(knowledge.hosts[vantage], "maxRam", at, expiry) ?? 0;
      if (budgets["walk"] === undefined || maxRam < budgets["walk"]) {
        refuse(vantage, "no-room", "the lab candidate cannot fit one legal walker thread");
        return { lab, candidate: vantage, tasks, walking: false };
      }
      tasks.push({
        kind: "walk",
        host: lab.hostname,
        from: vantage,
        threads: Math.floor(maxRam / budgets["walk"]),
        reason: `walk the maze from ${vantage}`,
      });
      walkerAt = vantage;
    }
    return { lab, candidate: walkerAt, tasks, walking: walkerAt !== undefined };
  };

  /** Which pins `planStasis` asked for can actually be carried out.
   *
   * Both refusals here are things the pure policy cannot see: whether the host
   * has room for a 12 GB call, and whether anything could put a resident back
   * afterwards. */
  const admitPins = (
    at: number,
    expiry: ExpiryOpts,
    pin: readonly string[],
    refuse: (host: string, why: string, detail: string) => void,
    labHost?: string,
    remoteAfter = true,
  ): HoldTask[] => {
    const tasks: HoldTask[] = [];
    for (const hostname of pin) {
      const queue = queues.get(hostname);
      const free = usableGb(hostname, at, expiry);
      if (queue !== undefined && budgets["pin"]! > free) {
        refuse(hostname, "no-room", `a 12 GB setStasisLink needs ${budgets["pin"]!.toFixed(2)}GB and ${free.toFixed(2)}GB is free`);
        continue;
      }
      // The job runs on the host it changes and omits spawn. A successful pin
      // makes that host remotely executable, so any remaining resident can
      // plant it again; a release removes that ability and still requires an
      // adjacent replanter. Either direction needs a usable credential/session.
      const replanter = [...queues.keys()].some((other) => {
        if (other === hostname) return false;
        const standing = knowledge.hosts[other];
        if (!standing) return false;
        return (fresh<string[]>(standing, "neighbours", at, expiry) ?? []).includes(hostname);
      });
      if ((!remoteAfter && !replanter) || !vault.has(hostname)) {
        refuse(
          hostname,
          "no-replanter",
          remoteAfter
            ? "the host has no credential for its post-pin remote plant"
            : "releasing the link would leave no neighbour able to re-plant this host",
        );
        continue;
      }
      tasks.push({
        kind: "pin",
        host: hostname,
        from: hostname,
        reason: "pin the host nothing can replace",
        // The edge the pin exists to keep. Every pin is lab-adjacent by policy
        // — the walker's vantage by `planWalk`'s collection, a spare by the
        // bottom-row-giant-with-proven-edge standard — and the job re-probes
        // for it at act time, because the mutation clock can sever it between
        // this derivation and the 12 GB call landing.
        ...(labHost !== undefined ? { edge: labHost } : {}),
      });
    }
    return tasks;
  };

  let labCandidateHost: string | undefined;
  const planHold = (at: number): { tasks: HoldTask[]; report: DnetHoldReport; labWalked: boolean; labCandidate?: string } => {
    const expiry = expiryOpts();
    const refused: DnetHoldReport["examples"] = [];
    const refuse = (host: string, why: string, detail: string): void => {
      refused.push({ host, why, detail });
    };
    const tasks: HoldTask[] = [];

    const hosts = projectHoldHosts(at, expiry);
    const view: HoldView = {
      hosts,
      netDepth: netDepth ?? DEFAULT_NET_DEPTH,
      stasisLimit,
      // Where the spare links should sit: depth-weighted coverage anchors for
      // the post-storm reconquest. In a lab world one slot is the walker's
      // (bottom row, exact), so the spares are the rest; lab-less, every slot
      // is a spare and the bottom row is the first anchor.
      spareTargets: stasisTargetDepths(
        netDepth ?? DEFAULT_NET_DEPTH,
        labExpected ? stasisLimit - 1 : stasisLimit,
        labExpected,
      ),
      charisma,
      // Backdoors are home's to install and home's to count; from out here the
      // multiplier is unobservable, and 1 is the value that makes `planStasis`
      // and `planInduce` decide on their own terms rather than on a guess.
      authDurationMultiplier: 1,
    };

    // --- the walk ----------------------------------------------------------
    const walk = planWalk(at, expiry, hosts, refuse);
    labCandidateHost = walk.candidate;
    const labCandidate = hosts.find((host) => host.hostname === walk.candidate);
    if (labCandidate) labCandidate.irreplaceable = true;
    for (const task of walk.tasks) {
      tasks.push(task);
      // Marked BEFORE `planStasis` runs, and that is the whole point: the
      // host is about to carry work that cannot be rebuilt, and a link
      // spent after the walk has started is a link spent on a host whose
      // walk has already survived without one. `planStasis` ranks
      // `irreplaceable` above everything else, so this is what makes the
      // walker's host the first stasis target rather than merely the best
      // argued one. The order of these three blocks is the policy.
      const standing = hosts.find((host) => host.hostname === task.from);
      if (standing) standing.irreplaceable = true;
    }

    // --- the pin -----------------------------------------------------------
    //
    // While the labyrinth still needs walking — including before it has even
    // been sighted, since one always exists — one free slot is held back for
    // the walk's vantage. Spending every link on spare coverage and then
    // finding the walker unpinnable would trade the critical thing for a nice
    // one; the reservation stands down on its own once an irreplaceable host
    // is linked or being pinned, because that IS the walker's slot in use.
    const labWalked = walk.lab !== undefined && vault.has(walk.lab.hostname);
    const stasis = planStasis({
      ...view,
      // No reservation for a walker that cannot exist: a lab-less world
      // (program-only access — home says so) has no walk to hold a slot for.
      reserveForWalker: !labWalked && labExpected,
    });
    for (const refusal of stasis.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
    // A RELEASE the planner wants is now CARRIED OUT: `setStasisLink(false)` is
    // the same 12 GB call with the opposite argument, filed as a `pin` task
    // with `unpin` set. It shares the pin's admission gates — the job cannot
    // spawn back, so its host still needs a re-planter — but never the edge
    // check, because a release is filed precisely when the edge is gone.
    for (const task of admitPins(at, expiry, stasis.release, refuse, undefined, false)) {
      tasks.push({ ...task, unpin: true, reason: "release a link its host no longer earns" });
    }
    // Only the WALKER's pin carries the lab edge for the act-time re-probe: a
    // spare sits at its coverage target, nowhere near the lab, and holding it
    // to the walker's edge check would refuse every spare ever filed.
    const walkerPin = (name: string): boolean =>
      hosts.find((entry) => entry.hostname === name)?.irreplaceable === true;
    tasks.push(...admitPins(at, expiry, stasis.pin.filter(walkerPin), refuse, walk.lab?.hostname));
    tasks.push(...admitPins(at, expiry, stasis.pin.filter((name) => !walkerPin(name)), refuse));

    // --- the push ----------------------------------------------------------
    //
    // In service of the walk, and of the spare-stasis standard that feeds it.
    // `induceServerMigration` is a re-roll of one host's position inside
    // `[difficulty - 2, difficulty + 4]`, and the one thing that re-roll buys
    // is landing on the bottom row, where `addServerToNetwork` wires a host to
    // the labyrinth for free. So pushing is worth paying for on three
    // occasions: while the lab still needs reaching (the landing is the walk's
    // vantage — paused during the walk itself, when repositioning the bottom
    // row buys nothing), while unspent stasis links remain (`seat` pushes a
    // big host into an open target's window), and while an air-gapped band
    // holds no resident of ours (`ferry` — the only deliberate way across a
    // gap). With all three answered, a push is churn: hundreds of calls and,
    // if the net is full, the host itself.
    const lab = walk.lab;
    const spareLinks = Math.max(0, stasisLimit - stasisLinked.size);
    // "A walk exists" means filed this pass OR already in flight — with the
    // in-flight finisher no longer re-filed each pass, checking only `tasks`
    // would have started repositioning the bottom row mid-walk.
    const labNeed = lab !== undefined && !vault.has(lab.hostname) && walk.candidate === undefined;
    const ferryWanted = unconqueredBands(view).length > 0;
    if (!labNeed && spareLinks === 0 && !ferryWanted) {
      if (lab !== undefined) {
        refuse(
          lab.hostname,
          "push-not-needed",
          "the labyrinth is reachable, every stasis link is spent, and every band holds a resident",
        );
      }
    } else {
      const induce = planInduce({
        ...view,
        induceGbPerThread: budgets["induce"],
        needLabVantage: labNeed,
      });
      for (const refusal of induce.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
      // EVERY admitted push is filed — one per pusher, several may share a
      // target (the charge accumulates on the target). The queue's per-agent
      // priorities run each one exactly when its agent has nothing better to
      // do: induce sits below observation, attempt and reclaim, above the earn
      // pair — exploration's last step, with money as the filler behind it.
      for (const push of induce.pushes) {
        tasks.push({
          kind: "induce",
          host: push.host,
          from: push.from,
          // Sized from the pusher's free RAM: the charge is linear in the
          // calling script's threads and the 6 s wait is not.
          threads: push.threads,
          reason: push.reason,
        });
      }
    }

    const admitted: Record<string, number> = {};
    for (const task of tasks) admitted[task.kind] = (admitted[task.kind] ?? 0) + 1;
    // `labWalked` is surfaced for the storm trigger: the walker-protection gate
    // retires itself once the vault holds the lab's password, and this closure
    // is the one place that already knows both halves.
    return {
      tasks,
      report: { admitted, ...foldRefusals(refused) },
      labWalked,
      ...(walk.candidate !== undefined ? { labCandidate: walk.candidate } : {}),
    };
  };

  /** Every host the farm ladder could act on.
   *
   * Only hosts we are STANDING on: all four farm calls act on the calling host,
   * so a host with no resident has nothing to offer here whatever its blocked
   * RAM says. */
  const projectFarmHosts = (at: number, expiry: ExpiryOpts): FarmHost[] => {
    const farmHosts: FarmHost[] = [];
    const inFlight = projectInFlight();
    for (const queue of queues.values()) {
      const host = knowledge.hosts[queue.host];
      if (!host) continue;
      const busy = new Set<FarmKind>();
      for (const job of inFlight.get(queue.host) ?? []) {
        // All FOUR rungs, `promote` included. Leaving it out did not risk a
        // duplicate — `deriveTasks` drops a busy kind either way — it made the
        // ladder spend a host's one rung re-admitting propaganda that was then
        // silently dropped, inflated `farm.admitted.promote` with work nobody
        // filed, and left `promote-in-flight` a refusal name that could never
        // fire.
        if (
          job.kind === "cache" || job.kind === "reclaim"
          || job.kind === "phish" || job.kind === "promote"
        ) busy.add(job.kind);
      }
      const depth = fresh<number>(host, "depth", at, expiry);
      const difficulty = fresh<number>(host, "difficulty", at, expiry);
      const blockedRam = fresh<number>(host, "blockedRam", at, expiry);
      const neighbours = fresh<string[]>(host, "neighbours", at, expiry);
      farmHosts.push({
        host: queue.host,
        ...(depth !== undefined ? { depth } : {}),
        ...(difficulty !== undefined ? { difficulty } : {}),
        ...(blockedRam !== undefined ? { blockedRam } : {}),
        // For the remote-reclaim election: a helper proves the edge from its
        // own fresh adjacency, and a target proves its admin rights from the
        // vault — the cross-host call checks both.
        ...(neighbours !== undefined ? { neighbours } : {}),
        hasCredential: vault.has(queue.host),
        // What a JOB would get, computed from the host's own facts: the whole of
        // `maxRam − blockedRam` less the prober's reserve. The worker spawns INTO
        // its job, so its own footprint is not subtracted. See `usableGb`.
        freeGb: usableGb(queue.host, at, expiry),
        caches: fresh<string[]>(host, "caches", at, expiry) ?? [],
        isLab: isLabyrinth(queue.host, fresh<string>(host, "modelId", at, expiry)),
        ...(host.goneAt !== undefined ? { goneAt: host.goneAt } : {}),
        busy,
      });
    }
    // A host with less than the bootstrap's 2.6 GB cannot run its own cure and
    // therefore has no queue yet. Keep it in the farm view as a TARGET only so
    // an authenticated adjacent resident can perform memoryReallocation on it.
    // Its freeGb is deliberately zero: it cannot be elected as a helper or file
    // self-host work, and the spread pass takes over as soon as one bootstrap
    // thread fits.
    for (const host of Object.values(knowledge.hosts)) {
      if (queues.has(host.hostname) || bootstraps.has(host.hostname) || !vault.has(host.hostname)) continue;
      const blockedRam = fresh<number>(host, "blockedRam", at, expiry);
      if (blockedRam === undefined || blockedRam <= 0) continue;
      const isStationary = fresh<boolean>(host, "isStationary", at, expiry) === true;
      if (isStationary || host.goneAt !== undefined) continue;
      const difficulty = fresh<number>(host, "difficulty", at, expiry);
      const depth = fresh<number>(host, "depth", at, expiry);
      const busy = new Set<FarmKind>();
      for (const job of inFlight.get(host.hostname) ?? []) {
        if (job.kind === "reclaim") busy.add("reclaim");
      }
      farmHosts.push({
        host: host.hostname,
        ...(depth !== undefined ? { depth } : {}),
        ...(difficulty !== undefined ? { difficulty } : {}),
        blockedRam,
        hasCredential: true,
        freeGb: 0,
        // Cache opening is self-host only and there is no resident here yet;
        // suppress that rung until reclaim has made the host plantable.
        caches: [],
        busy,
      });
    }
    return farmHosts;
  };

  /** Every host an unattributed password could belong to.
   *
   * `harvestLogs` has been collecting `--<password>--` lines all along. A bare
   * string looks useless and is not: `passwordLength` and `passwordFormat` are
   * IDENTITY facts — they are replaced only when the host is — so they never
   * expire underneath a guess in flight, and between them they usually name a
   * handful of candidates out of the whole net. Each candidate is one
   * `authenticate`, which has no penalty for being wrong. */
  const projectLooseTargets = (at: number, expiry: ExpiryOpts): LooseTarget[] =>
    Object.keys(knowledge.hosts).map((hostname) => projectLooseTarget(hostname, at, expiry));

  /** One derived task, mapped onto the queue of the host that must run it.
   *
   * This is the only place a `Task` becomes a `DnetJob`, and the only place a
   * password is put back into one: the queue carried an opaque id precisely so
   * that a pure module never had to hold a credential. */
  const fileTask = (task: Task): boolean => {
    const queue = queues.get(task.from);
    // No resident there: nothing can run it, and filing it would be a plan for
    // a machine we cannot reach.
    if (!queue) return false;
    const budget = budgets[task.kind] ?? budgets["inventory"]!;
    // Sized against the overseer's own computed budget for the host — the whole
    // of `maxRam − blockedRam` less the prober's reserve, since the worker spawns
    // INTO its job. `budgetGb` is PER THREAD, exactly as the engine charges
    // `ramOverride`, so the product is the cost. Only a host whose `maxRam` we
    // have yet to learn returns 0, and one with a resident has always been probed,
    // so this never starves a real host.
    // A walk claims its host ALONE: no prober reserve (the overseer kills it,
    // below) and its own budget carries no spawn, so the whole of maxRam−blocked
    // becomes `authenticate` threads.
    const isWalk = task.kind === "walk";
    if (isWalk) killWalkHostProber(task.from);
    const room = usableGb(task.from, Date.now(), expiryOpts(), !isWalk);
    // Fill the host with threads for the kinds that get faster or earn more with
    // them (`THREAD_SCALED_KINDS`); a `setStasisLink` pin or a `plant` is a single
    // fixed-size act and keeps whatever the planner asked for. `budget` carries
    // the base (+ spawn, except pin/walk), so `floor(room / budget)` is the exact count
    // that fits — and it is a floor, so the product can never exceed `room`.
    const threads = threadsForJob(room, budget, THREAD_SCALED_KINDS.has(task.kind), task.threads ?? 1);
    // Skipping here rather than queueing keeps a job that can never fit from
    // blocking the ones that can. Scaled kinds already fit by construction; this
    // guards the fixed-size ones.
    if (threads < 1 || budget * threads > room) return false;
    return enqueue(queue, {
      id: task.id,
      kind: task.kind,
      label: task.reason,
      budgetGb: budget,
      threads,
      priority: task.priority,
      // The walker is the ONE long-lived job in the feature: a lab is
      // hundreds of moves and `DarknetState.labLocations` is keyed by PID, so
      // nothing can pick the walk up if this process ends. It is watched by
      // its own beat instead of by `JOB_TIMEOUT_MS`.
      longLived: task.kind === "walk",
      state: {
        host: task.host,
        from: task.from,
        jobThreads: threads,
        ...(task.kind === "reclaim" && task.host === task.from
          ? (() => {
            const maxRam = fresh<number>(knowledge.hosts[task.from], "maxRam", Date.now(), expiryOpts());
            const threshold = maxRam === undefined
              ? undefined
              : maxRam - proberGb - budget * (threads + 1);
            return threshold !== undefined && threshold >= 0
              ? { resizeAtBlockedRam: threshold }
              : {};
          })()
          : {}),
        ...(vault.has(task.host) ? { password: vault.get(task.host)!.password } : {}),
        ...(knowledge.hosts[task.host]?.identity !== undefined
          ? { targetIdentity: knowledge.hosts[task.host]!.identity }
          : {}),
        ...(task.filename !== undefined ? { filename: task.filename } : {}),
        ...(task.symbol !== undefined ? { symbol: task.symbol } : {}),
        ...(task.edge !== undefined ? { edge: task.edge } : {}),
        ...(task.unpin === true ? { unpin: true } : {}),
        // Resolved HERE and nowhere else: the queue carried an id precisely so
        // that a pure module never had to hold a password.
        ...(task.guessId !== undefined && guessFor.has(task.guessId)
          ? { guess: guessFor.get(task.guessId)! }
          : {}),
        ...(task.kind === "bleed" || task.kind === "attempt"
          ? { knownHosts: Object.keys(knowledge.hosts) }
          : {}),
        ...(task.kind === "plant"
          ? {
            ...(task.remote ? { sessionOnly: true } : {}),
            ...(task.bootstrapReclaim ? { bootstrapReclaim: true } : {}),
            ...(task.bootstrapThreads !== undefined ? { bootstrapThreads: task.bootstrapThreads } : {}),
            ...(task.omitProber ? { omitProber: true } : {}),
            payloads,
          }
          : {}),
      },
      body: bodies[task.kind],
    });
  };

  /** Derive what there is to do, and file it.
   *
   * The order is the policy and every step feeds the next: spread and farm and
   * hold each produce admitted work plus named refusals, the loose-password pass
   * turns leaked strings into opaque guess ids, and `deriveTasks` merges all four
   * with what the map alone implies. */
  // The overseer's OWN reader. `probe()` is host-local, so adjacency arrives
  // from the residents' probers — but every other host fact is a SYNCHRONOUS,
  // instant read the overseer can make itself from darkweb with no connection
  // (`spec/dnet.md`). Bracket notation throughout so the STATIC RAM figure stays
  // on the declared controller surface (as with `nextMutation`/`kill`); the dynamic cost is
  // covered by the overseer's `ramOverride` = `priceAgent(CONTROLLER_METHODS)`.
  // `usedRam` is not read: a host the overseer describes has no worker yet, so
  // its used RAM IS its owner block — `freeRam = maxRam − blockedRam` — and a
  // host that has a worker is described by that worker's own job reports.
  const describeHostLocal = (host: string, neighbours?: readonly string[], seenAt = Date.now()): ReportHost => {
    const details = ns["dnet"]["getServerDetails"](host);
    if (!details.isOnline) return { hostname: host, at: seenAt, present: false };
    const identity = ns["dnsLookup"](host);
    const maxRam = ns["getServerMaxRam"](host);
    return {
      hostname: host,
      ...(identity.length > 0 ? { identity } : {}),
      at: seenAt,
      present: true,
      depth: details.depth,
      blockedRam: details.blockedRam,
      requiredCharisma: details.requiredCharismaSkill,
      difficulty: details.difficulty,
      isStationary: details.isStationary,
      modelId: details.modelId,
      passwordLength: details.passwordLength,
      passwordFormat: details.passwordFormat,
      passwordHint: details.passwordHint,
      data: details.data,
      logTrafficInterval: details.logTrafficInterval,
      maxRam,
      // usedRam is deliberately NOT reported: `freeRam` treats a missing one as
      // `maxRam − blockedRam`, exactly right for a host with no worker, and
      // omitting it means the overseer never clobbers the real `usedRam` a
      // worker's own job reports for a host that IS running one.
      ...(neighbours !== undefined ? { neighbours: [...neighbours] } : {}),
    };
  };

  // Darkweb has no prober — the overseer stands on it, so it probes darkweb
  // itself. Only after a mutation (or the first pass): darkweb's adjacency is as
  // stable as any host's between ticks, and re-probing every derive would spend a
  // call for nothing. Stamped into `probes` with our own pid so it drains through
  // the one path; darkweb's stamp advances every mutation, so it never looks
  // stale and is never "revived".
  let lastDarkwebProbeAt = 0;
  const probeDarkweb = (): void => {
    if (lastDarkwebProbeAt !== 0 && (lastMutationAt ?? 0) <= lastDarkwebProbeAt) return;
    lastDarkwebProbeAt = Date.now();
    probes.set(selfHost, {
      neighbours: [...ns["dnet"]["probe"]()],
      at: lastDarkwebProbeAt,
      pid: ns.pid,
      epoch: rendezvous.mutationEpoch,
    });
  };

  // A host's details, read defensively. Missing hosts normally return
  // `isOnline:false`; a throw means the name no longer resolves to a darknet
  // server, which is the same terminal observation for this lifetime.
  const tryDescribe = (host: string, neighbours?: readonly string[], seenAt = Date.now()): ReportHost => {
    try {
      return describeHostLocal(host, neighbours, seenAt);
    } catch {
      return { hostname: host, at: seenAt, present: false };
    }
  };

  // Fold new probe reports AND refresh every known host's details once per
  // mutation. The probers give ADJACENCY (host-local, one stamp per host per
  // mutation); the overseer reads DETAILS itself — `getServerDetails` for every
  // host from darkweb, no connection — so `blockedRam` stays fresh for `usableGb`
  // across the whole net. `probes` is never cleared (it is also the liveness
  // record); only stamps NEWER than the last drain are folded, so a persistent
  // map costs no re-folding. One `absorb` handles the observation batch.
  let lastProbeDrainAt = 0;
  let lastDetailSweepAt = 0;
  const drainProbes = (at: number): void => {
    probeDarkweb();
    const foldFrom = lastProbeDrainAt;
    lastProbeDrainAt = Date.now();
    const hosts: ReportHost[] = [];
    const newlySeen = new Set<string>();
    const covered = new Set<string>();
    const cover = (host: ReportHost | undefined): void => {
      if (host === undefined) return;
      const known = knowledge.hosts[host.hostname];
      if (host.present && (known === undefined
        || (host.identity !== undefined && known.identity !== undefined && host.identity !== known.identity))) {
        newlySeen.add(host.hostname);
      }
      hosts.push(host);
      covered.add(host.hostname);
    };
    for (const [host, probe] of probes) {
      if (probe.at <= foldFrom) continue; // already folded on an earlier drain
      cover(tryDescribe(host, probe.neighbours, probe.at));
      for (const neighbour of probe.neighbours) {
        if (knowledge.hosts[neighbour] === undefined) cover(tryDescribe(neighbour, undefined, at));
      }
    }
    // The once-per-mutation sweep of every OTHER known host — the ones with no
    // fresh stamp this drain (their prober is between mutations, or dead). Details
    // only; their adjacency arrives with their own prober's next stamp.
    if (lastDetailSweepAt < (lastMutationAt ?? 0) || lastDetailSweepAt === 0) {
      lastDetailSweepAt = Date.now();
      for (const host of Object.values(knowledge.hosts)) {
        if (host.goneAt !== undefined || host.hostname === selfHost || covered.has(host.hostname)) continue;
        cover(tryDescribe(host.hostname, undefined, at));
      }
    }
    if (hosts.length > 0) absorb({ ok: true, hosts });
    // A probe is the first authoritative sighting of a server lifetime. Files
    // are not part of getServerDetails, so remember that this identity still
    // needs one file listing. The bit deliberately survives while the host has
    // no resident; preparePlantedHost/fileListJobs consumes it once we can run
    // the inventory locally.
    for (const host of newlySeen) dirty.add(host);
  };

  /** A minimal local reclaimer has no details call in its 2.6 GB/thread
   * surface. Its exit wakes us here; the controller performs the one fresh
   * details read and immediately derives the next bootstrap or real plant. */
  const drainBootstrapDone = (at: number): void => {
    for (const [host, running] of [...bootstraps]) {
      let alive = false;
      try {
        alive = ns["isRunning"](running.pid, host);
      } catch {
        alive = false;
      }
      if (!alive) {
        bootstraps.delete(host);
        bootstrapDone.add(host);
      }
    }
    if (bootstrapDone.size === 0) return;
    const hosts = [...bootstrapDone]
      .map((host) => tryDescribe(host, undefined, at))
      .filter((host): host is ReportHost => host !== undefined);
    for (const host of bootstrapDone) lastPlantAt.delete(host);
    for (const host of bootstrapDone) dirty.add(host);
    bootstrapDone.clear();
    if (hosts.length > 0) absorb({ ok: true, hosts, dirtied: true });
  };

  // Re-establish dead probers. The prober carries no `spawn` and reports no
  // death — a host restart just kills it, and its stamp in `probes` stops
  // advancing. A stamp that has fallen behind the PREVIOUS mutation (a full cycle
  // of slack, so a prober mid-report is never mistaken for dead) means the prober
  // is gone; the overseer re-`exec`s it through the host's own worker, a
  // max-priority `relaunchProbe` job (one local `exec` of the prober already on
  // disk). A LAB WALKER's host is skipped deliberately: its prober was killed to
  // give the walk every byte, and it comes back with the re-plant after the walk.
  const reviveProbers = (): void => {
    if (prevMutationAt === 0) return; // no full mutation window has elapsed yet
    for (const [host, queue] of queues) {
      if (host === selfHost || host === labCandidateHost || queue.active?.kind === "walk") continue;
      const probe = probes.get(host);
      if (probe !== undefined && probe.at >= prevMutationAt) continue;
      if (queue.active?.kind === "relaunchProbe" || queue.pending.some((job) => job.kind === "relaunchProbe")) {
        continue;
      }
      fileTask({
        id: `relaunchProbe:${host}`,
        kind: "relaunchProbe",
        host,
        from: host,
        // The stable prober filename, carried on the task so the job never
        // constructs one — the same discipline the plant follows with payloads.
        filename: proberFile,
        // More urgent than a plant (−100): a host cannot spread what it cannot
        // see, so getting its eyes back outranks everything but a job already
        // running. It does not hard-cancel — the running job finishes first.
        priority: DNET_PRIORITY['relaunchProbe'],
        reason: "prober stamp went stale; re-establishing this host's adjacency",
      });
    }
  };

  // File the instant inventory job for each dirty host. High priority so
  // the drop is read soon, but it is NOT hard-cancel-eligible — a long action job
  // running here finishes first, and the list slots in on the next spawn-back.
  // Clear only after the list is actually queued. A full three-job queue used to
  // reject fileTask after this function had already erased the dirty bit, losing
  // the only observation path for a cache forever. Dedup against a list already
  // in flight here; that list will observe the latest files when it runs.
  const fileListJobs = (): void => {
    if (dirty.size === 0) return;
    for (const host of [...dirty]) {
      const queue = queues.get(host);
      if (!queue) continue;
      if (queue.active?.kind === "inventory" || queue.pending.some((job) => job.kind === "inventory")) {
        dirty.delete(host);
        continue;
      }
      const filed = fileTask({
        id: `inventory:${host}`,
        kind: "inventory",
        host,
        from: host,
        priority: DNET_PRIORITY['inventory'],
        reason: "files may have changed; listing them",
      });
      if (filed) dirty.delete(host);
    }
  };

  rendezvous.preparePlantedHost = (host: string): void => {
    if (!queues.has(host)) {
      queues.set(host, { host, pending: [], lastBeatAt: Date.now(), completed: 0, failed: 0 });
    }
    dirty.add(host);
    // Called after the first probe and before exec'ing the resident. File the
    // inventory now so the new agent's first queue lookup finds real work.
    fileListJobs();
  };

  queueAuthenticatedPlant = (hostname: string, from: string): void => {
    const at = Date.now();
    // Authentication is a synchronous state transition. Refresh the newly-open
    // host before choosing how to migrate there; no controller timer sits
    // between the credential and this observation.
    const report = tryDescribe(hostname, undefined, at);
    knowledge = foldReports(knowledge, [report], at, expiryOpts()).knowledge;
    pendingHosts.push(report);
    if (!report.present) return;
    const candidates = candidatesFrom(knowledge, at, {
      standing: new Set([selfHost, ...queues.keys(), ...bootstraps.keys()]),
      vault: new Set(vault.keys()),
      lastPlantAt,
      expiry: expiryOpts(),
    });
    const candidate = candidates.find((candidate) => candidate.host === hostname);
    if (!candidate) {
      return;
    }
    // Authentication just proved this edge. Reuse the process that performed
    // it instead of letting a later derivation choose another vantage.
    const planned = planSpread([{ ...candidate, from }], {
      ...DEFAULT_SPREAD_LIMITS,
      agentRamGb: priceAgent(ns, RESIDENT_METHODS) + proberGb,
      residentRamGb: priceAgent(ns, RESIDENT_METHODS),
      bootstrapRamGb: priceAgent(ns, BOOTSTRAP_RECLAIM_METHODS),
    }, at).plant[0];
    if (!planned) {
      signalDerive();
      return;
    }
    fileTask({
      id: `plant:${planned.host}`,
      kind: "plant",
      host: planned.host,
      from,
      priority: PLANT_PRIORITY,
      reason: "authentication completed; migrate immediately",
      ...(planned.bootstrapReclaim ? { bootstrapReclaim: true } : {}),
      ...(planned.bootstrapThreads !== undefined ? { bootstrapThreads: planned.bootstrapThreads } : {}),
      ...(planned.omitProber ? { omitProber: true } : {}),
    });
  };

  queueNeighbourGuess = (hostname: string, password: string, from: string, at: number): void => {
    if (!queues.has(from) || vault.has(hostname) || knowledge.hosts[hostname]?.goneAt !== undefined) return;
    const id = looseId(password);
    guessFor.set(id, password);
    const depth = fresh<number>(knowledge.hosts[hostname], 'depth', at, expiryOpts());
    fileTask({
      id: `guess:${hostname}:${id}`,
      kind: 'attempt',
      host: hostname,
      from,
      priority: DNET_PRIORITY['attempt'] + (depth === undefined ? 1 : -depth) - 5,
      reason: `same-epoch first-auth file from ${from}`,
      guessId: id,
    });
  };

  const fileWork = (at: number): Task[] => {
    drainBootstrapDone(at);
    drainProbes(at);
    reviveProbers();
    fileListJobs();
    // THE QUIET PERIOD. While our own storm is believed to be running, every
    // movable host is being deleted, moved or restarted under us: a job filed
    // now dies into the churn and poisons the failure counters, and a plan
    // derived now is a plan against a net that will not exist in thirty
    // seconds. So nothing is derived at all — 35 s of stillness is cheaper
    // than 35 s of jobs dying — and the panel is told why. The post-burst
    // wipe in the main loop is what ends this state.
    if (lastStormFiredAt !== undefined && at - lastStormFiredAt < STORM_QUIET_MS) {
      const quietLeft = Math.round((STORM_QUIET_MS - (at - lastStormFiredAt)) / 1000);
      storm = {
        admitted: 0,
        refused: { "storm-in-flight": 1 },
        examples: [{
          host: "(net)",
          why: "storm-in-flight",
          detail: `the storm we fired is rerolling the net; deriving nothing for ${quietLeft}s more`,
        }],
        firedAt: lastStormFiredAt,
      };
      return [];
    }
    const remoteExec = new Set(stasisLinked);
    const backdoorLife = msPerHostEventAny(
      ["restarted", "deleted"],
      netDepth ?? DEFAULT_NET_DEPTH,
      bitNode ?? 15,
      backdoors.size,
    );
    for (const [hostname, installedAt] of backdoors) {
      const host = knowledge.hosts[hostname];
      if (host !== undefined && host.goneAt === undefined && at - installedAt <= backdoorLife) {
        remoteExec.add(hostname);
      }
    }
    const spreadCandidates = candidatesFrom(knowledge, at, {
        standing: new Set([selfHost, ...queues.keys(), ...bootstraps.keys()]),
        vault: new Set(vault.keys()),
        lastPlantAt,
        remoteExec,
        remoteVantages: [...queues.values()].map((queue) => ({ host: queue.host, freeGb: usableGb(queue.host, at, expiryOpts()) })),
        expiry: expiryOpts(),
      });

    // The storm's projection of every knowledge host, built here because the
    // seed-hunt decision below reads it too. Only the trigger CALL waits for
    // the hold pass — see the storm block.
    const stormExpiry = expiryOpts();
    const stormHosts: StormHost[] = Object.values(knowledge.hosts).map((host) => {
      const seed = fresh<boolean>(host, "stormSeed", at, stormExpiry);
      const blockedRam = fresh<number>(host, "blockedRam", at, stormExpiry);
      const caches = fresh<string[]>(host, "caches", at, stormExpiry);
      const harvestBusy = [...queues.values()].some((queue) =>
        [queue.active, ...queue.pending].some((job) => job !== undefined
          && job.state.host === host.hostname
          && (job.kind === "attempt" || job.kind === "reclaim" || job.kind === "cache")));
      return {
        hostname: host.hostname,
        ...(seed !== undefined ? { stormSeed: seed } : {}),
        agentAlive: queues.has(host.hostname),
        ...(fresh<boolean>(host, "isStationary", at, stormExpiry) === true ? { isStationary: true } : {}),
        hasCredential: vault.has(host.hostname),
        ...(blockedRam !== undefined ? { blockedRam } : {}),
        ...(caches !== undefined ? { caches } : {}),
        ...(harvestBusy ? { harvestBusy: true } : {}),
        ...(stasisLinked.has(host.hostname) ? { stasisLinked: true } : {}),
        ...(host.goneAt !== undefined ? { gone: true } : {}),
      };
    });

    // --- the farm ---------------------------------------------------------
    //
    // THE SEED HUNT. Every RAM block ground to zero is a 15% roll for
    // `STORM_SEED.exe`, so while the storm's preparation gates are already met
    // (every link spent, or the lab walked), no seed is in hand, and the
    // engine could actually mint one (30+ minutes since our last storm — its
    // own clock is unreadable, so ours is the only evidence), the reclaim
    // rung's clear budget stands down and blocks keep being ground outright.
    // Never having fired reads as eligible, which errs toward grinding: the
    // grind still pays RAM, caches and charisma even when the roll cannot.
    const seedHolder = stormHosts.find((host) => host.gone !== true && host.stormSeed === true);
    const labWalkedNow = Object.values(knowledge.hosts).some((host) =>
      isLabyrinth(host.hostname, fresh<string>(host, "modelId", at, stormExpiry))
      && vault.has(host.hostname));
    const seedHunt = seedHolder === undefined
      && (labWalkedNow || stasisLinked.size >= stasisLimit)
      && (lastStormFiredAt === undefined || at - lastStormFiredAt > STORM_COOLDOWN_MS);
    const farmPlan = planFarm(projectFarmHosts(at, expiryOpts()), {
      now: at,
      charisma,
      gbPerThread: farmGbPerThread,
      wantedGb: heaviestJobGb,
      ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
      ...(promoteSymbols.length > 0 ? { promoteSymbols } : {}),
      crimeSuccessMult,
      openLabCache,
      ...(seedHunt ? { seedHunt: true } : {}),
    });
    const farmAdmitted: Record<string, number> = {};
    for (const task of farmPlan.tasks) farmAdmitted[task.kind] = (farmAdmitted[task.kind] ?? 0) + 1;
    farm = {
      admitted: farmAdmitted,
      ...foldRefusals(farmPlan.refused),
      ...(farmPlan.cacheHunter !== undefined ? { cacheHunter: farmPlan.cacheHunter } : {}),
    };

    // --- what to hold, and what to push -----------------------------------
    const holdPlan = planHold(at);
    hold = holdPlan.report;

    // The lab candidate is pinned BEFORE its remaining owner block is ground
    // down. From that point through the PID-bound walk it never shares RAM with
    // a prober: blocked hosts get the 2.6 GB/thread bootstrap, clear hosts get a
    // resident alone, and that resident immediately spawns into the full-RAM
    // walker. Every other cramped host uses the same bootstrap but returns to
    // the ordinary resident+prober pair once clear enough.
    for (const candidate of spreadCandidates) {
      if (candidate.host === holdPlan.labCandidate && stasisLinked.has(candidate.host)) {
        candidate.omitProber = true;
        candidate.reclaimOnly = true;
      }
    }
    const plan = planSpread(
      spreadCandidates,
      {
        ...DEFAULT_SPREAD_LIMITS,
        agentRamGb: priceAgent(ns, RESIDENT_METHODS) + proberGb,
        residentRamGb: priceAgent(ns, RESIDENT_METHODS),
        bootstrapRamGb: priceAgent(ns, BOOTSTRAP_RECLAIM_METHODS),
      },
      at,
    );
    spread = { planted: plan.plant.length, ...foldRefusals(plan.refused) };

    // --- the storm --------------------------------------------------------
    //
    // Decided AFTER the hold pass on purpose: `links-unspent` reads the pins
    // this very derivation just filed, so a storm can never race the pin it is
    // waiting for. The policy is pure (`storm.ts`); the view was projected
    // above, beside the seed hunt that shares it.
    // A pin still pending — filed this pass, or queued and not yet landed —
    // is a slot mid-spend, and the storm waits for it.
    const pinsPending = holdPlan.tasks.some((task) => task.kind === "pin" && task.unpin !== true)
      || [...projectInFlight().values()].some((held) => held.some((job) => job.kind === "pin"));
    // The finisher's vantage, whether the walk is in flight or filed this pass.
    let walkFrom: string | undefined;
    for (const queue of queues.values()) {
      for (const job of [queue.active, ...queue.pending]) {
        if (job !== undefined && job.kind === "walk") walkFrom = queue.host;
      }
    }
    for (const task of holdPlan.tasks) {
      if (task.kind === "walk") walkFrom = task.from;
    }
    const stormPlan = planStorm({
      hosts: stormHosts,
      now: at,
      stasisLimit,
      stasisLinked: stasisLinked.size,
      pinsPending,
      walkInFlight: walkFrom !== undefined,
      walkerPinned: walkFrom !== undefined && stasisLinked.has(walkFrom),
      labWalked: holdPlan.labWalked,
      ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
      ...(lastStormFiredAt !== undefined ? { lastStormFiredAt } : {}),
    });
    const seedSeenAt = seedHolder !== undefined
      ? knowledge.hosts[seedHolder.hostname]?.facts["stormSeed"]?.at
      : undefined;
    storm = {
      admitted: stormPlan.fire !== undefined ? 1 : 0,
      ...foldRefusals(stormPlan.refused.map((entry) =>
        ({ host: entry.hostname, why: entry.why, detail: entry.detail }))),
      ...(seedHolder !== undefined ? { seedHost: seedHolder.hostname } : {}),
      ...(seedSeenAt !== undefined ? { seedSeenAt } : {}),
      ...(lastStormFiredAt !== undefined ? { firedAt: lastStormFiredAt } : {}),
      ...(seedHunt ? { seedHunt: true } : {}),
    };

    // --- unattributed passwords -------------------------------------------
    const looseTargets = projectLooseTargets(at, expiryOpts());
    guessFor.clear();
    const guesses: { host: string; id: string; reason: string }[] = [];
    for (const candidate of looseCandidates(loosePool, looseTargets)) {
      if (spentGuesses.has(`${candidate.hostname}\u0000${candidate.password}`)) continue;
      // Derived from the PASSWORD rather than from its position in the pool,
      // which is what the id has to be for `enqueue`'s duplicate check to keep
      // covering it across ticks: the pool is a bounded FIFO, so an eviction
      // renumbers every entry behind it and the same leak would arrive under a
      // different `guess:<host>:<id>` on the very next derivation.
      const id = looseId(candidate.password);
      guessFor.set(id, candidate.password);
      guesses.push({ host: candidate.hostname, id, reason: candidate.reason });
    }
    // Named leaks stay provisional but target exactly the host the line named.
    // Their lifetime is the password-changing deletion class, never a guessed
    // TTL; replacement and disappearance also remove them eagerly above.
    const provisionalLife = msPerHostEvent(
      "deleted",
      netDepth ?? DEFAULT_NET_DEPTH,
      bitNode ?? 15,
      backdoors.size,
    );
    for (let index = provisionalPool.length - 1; index >= 0; index--) {
      const candidate = provisionalPool[index]!;
      const host = knowledge.hosts[candidate.hostname];
      const stale = at - candidate.at > provisionalLife;
      const replaced = candidate.identity !== undefined && host?.identity !== undefined
        && candidate.identity !== host.identity;
      if (stale || replaced || host?.goneAt !== undefined || vault.has(candidate.hostname)) {
        provisionalPool.splice(index, 1);
        continue;
      }
      if (spentGuesses.has(`${candidate.hostname}\u0000${candidate.password}`)) continue;
      const id = looseId(candidate.password);
      guessFor.set(id, candidate.password);
      guesses.unshift({ host: candidate.hostname, id, reason: `a ${candidate.via} log named this host and password` });
    }

    const tasks = deriveTasks(knowledge, at, {
      ...expiryOpts(),
      charisma,
      // Data only: credentials remain in the realm-only queued job state.
      inFlight: projectInFlight(),
      agents: new Set([selfHost, ...queues.keys()]),
      // What a job would get on each vantage — the same figure `fileTask`'s fit
      // check compares against, so a vantage the derivation prefers is one the
      // filed job actually fits on. `selfHost` is absent deliberately: the
      // overseer never runs attempts.
      agentFreeGb: new Map(
        [...queues.values()].map((queue) => [queue.host, usableGb(queue.host, at, expiryOpts())]),
      ),
      ...(budgets["attempt"] !== undefined ? { attemptGbPerThread: budgets["attempt"] } : {}),
      ...(budgets["bleed"] !== undefined ? { bleedGbPerThread: budgets["bleed"] } : {}),
      vault: new Set(vault.keys()),
      plantable: plan.plant.map((entry) => ({
        host: entry.host,
        from: entry.from,
        ...(entry.remote ? { remote: true } : {}),
        ...(entry.bootstrapReclaim ? { bootstrapReclaim: true } : {}),
        ...(entry.bootstrapThreads !== undefined ? { bootstrapThreads: entry.bootstrapThreads } : {}),
        ...(entry.omitProber ? { omitProber: true } : {}),
      })),
      farm: farmPlan.tasks,
      hold: [
        ...holdPlan.tasks,
        ...(stormPlan.fire !== undefined
          ? [{
            kind: "storm" as const,
            host: stormPlan.fire.host,
            from: stormPlan.fire.from,
            reason: stormPlan.fire.reason,
          }]
          : []),
      ],
      ...(guesses.length > 0 ? { guesses } : {}),
    });
    routeUrgentTasks(tasks, at);
    for (const task of tasks) fileTask(task);
    return tasks;
  };

  /** Route urgent work onto the cheapest eligible vantage: idle first, then the
   * lowest-value cancellable job, with greater remaining time as the tiebreaker.
   * A worker already being cancelled can accept another directly chained job,
   * turning one kill into several queued targets. Lab walking/pinning and storm
   * execution are protected; heartbleed is the first non-preempting class.
   *
   * Runs before `fileTask` so the repointed `from` is what gets enqueued. */
  const routeUrgentTasks = (tasks: Task[], at: number): void => {
    const expiry = expiryOpts();
    // Track both fresh assignments and cancellations so later tasks can reuse a
    // single cancellation without accidentally preferring a newly busy worker.
    const cancelled = new Set<string>();
    const assigned = new Map<string, number>();
    for (const task of tasks) {
      if (task.kind !== 'walk' && task.kind !== 'plant' && task.kind !== 'cache'
        && task.kind !== 'pin' && task.kind !== 'attempt' && task.kind !== 'bleed') continue;
      // Eligible vantages: the one `planSpread` chose (adjacent or a stamped
      // remote), plus every OTHER resident adjacent to the target. Remote
      // alternatives are not enumerated here — the chosen remote vantage was
      // already the roomiest — so a repoint is always onto an adjacent host and
      // therefore an ordinary directly-connected plant.
      const targetNeighbours = fresh<string[]>(knowledge.hosts[task.host], "neighbours", at, expiry) ?? [];
      const candidates: PreemptionCandidate[] = [];
      const possible = task.kind === 'plant'
        ? new Set<string>([task.from, ...queues.keys()])
        : new Set<string>(task.eligibleFrom ?? [task.from]);
      for (const host of possible) {
        if (task.kind === 'plant' && host === task.host) continue;
        const queue = queues.get(host);
        if (queue === undefined) continue;
        if (queue.pending.length + (assigned.get(host) ?? 0) >= MAX_QUEUED_PER_HOST) continue;
        // Symmetric adjacency, exactly as `candidatesFrom`: a vantage names the
        // target, or the target names it. task.from is always eligible.
        const adjacent = task.kind !== 'plant'
          || host === task.from
          || (fresh<string[]>(knowledge.hosts[host], "neighbours", at, expiry) ?? []).includes(task.host)
          || targetNeighbours.includes(host);
        if (!adjacent) continue;
        candidates.push({
          host,
          usableGb: usableGb(host, at, expiry),
          ...(assigned.has(host) ? { assigned: assigned.get(host)! } : {}),
          ...(cancelled.has(host) ? { cancelling: true } : {}),
          ...(queue.active !== undefined
            ? {
              activeKind: queue.active.kind,
              activePriority: queue.active.priority,
              ...(queue.active.startedAt !== undefined ? { activeStartedAt: queue.active.startedAt } : {}),
              ...(queue.active.expectedDoneAt !== undefined ? { activeExpectedDoneAt: queue.active.expectedDoneAt } : {}),
            }
            : {}),
        });
      }
      const choice = choosePreemptionVantage(task.kind, candidates, at);
      if (choice === undefined) continue;
      // Repoint. An adjacent alternative is a direct plant, so its remote/session
      // flag is cleared; keeping the originally-chosen vantage leaves it as it
      // was (it may be a legitimate remote recovery plant).
      if (choice.vantage !== task.from) {
        task.from = choice.vantage;
        if (task.kind === 'plant') delete task.remote;
      }
      assigned.set(choice.vantage, (assigned.get(choice.vantage) ?? 0) + 1);
      if (choice.preempt && !cancelled.has(choice.vantage)) {
        const queue = queues.get(choice.vantage);
        if (queue?.active !== undefined && queue.active.cancelReason === undefined) {
          // Cooperative: a long job (an induce) stops at its next `cancelled?()`
          // poll, and `hardCancelSweep` shoots an armored short one carrying a
          // reason. Either way the resident respawns and takes the pending plant,
          // which is top priority in its queue.
          queue.active.cancelReason = `preempted: ${task.kind} on ${task.host} outranks ${queue.active.kind}`;
          cancelled.add(choice.vantage);
        }
      }
    }
  };

  /** Keep the materialized per-resident queues aligned with the facts that
   * derive them. This is deliberately conservative for standalone ring drains;
   * every impossible or already-completed form is retired immediately. */
  const reconcilePending = (at: number): void => {
    const expiry = expiryOpts();
    for (const queue of queues.values()) {
      const keep: DnetJob[] = [];
      for (const job of queue.pending) {
        const host = knowledge.hosts[job.state.host];
        let reason: string | undefined;
        if (!host || host.goneAt !== undefined) reason = 'target is gone';
        else if (job.state.targetIdentity !== undefined && host.identity !== undefined
          && job.state.targetIdentity !== host.identity) reason = 'target identity changed';
        else if (job.kind === 'attempt' && vault.has(job.state.host)) reason = 'credential already verified';
        else if (job.kind === 'plant' && queues.has(job.state.host)) reason = 'resident already present';
        else if (job.kind === 'cache' && job.state.filename !== undefined
          && !(fresh<string[]>(host, 'caches', at, expiry) ?? []).includes(job.state.filename)) {
          reason = 'cache listing changed';
        }
        if (reason === undefined) keep.push(job);
        else job.settle({ ok: false, targetState: 'cancelled', detail: reason });
      }
      queue.pending = keep;
    }
  };

  let lastBeat = bootAt;

  while (true) {
    // Surface a kill. The realm sleep below outlives a killed script, the
    // mutation sweep's `isRunning` is try/caught (which would swallow the
    // ScriptDeath the engine delivers through it), and nothing else in a
    // quiet pass touches ns unconditionally — so a killed overseer could
    // otherwise loop on as a zombie, stamping beats that stop home from ever
    // re-seeding. One unguarded priced call per tick makes the engine's stop
    // flag lethal within a tick.
    ns.getServerMaxRam(selfHost);
    const at = Date.now();
    rendezvous.lastBeatAt = at;

    if (standDown) {
      for (const queue of queues.values()) {
        for (const job of queue.pending) {
          job.settle({ ok: false, targetState: "cancelled", detail: "overseer build retired" });
        }
        queue.pending = [];
      }
      if ([...queues.values()].every((queue) => queue.active === undefined)) break;
      await realmSleep(STAND_DOWN_POLL_MS);
      continue;
    }

    // THE POST-BURST WIPE, exactly once per storm. Everything outside
    // stationary/stasis was just deleted, moved or restarted, and we KNOW —
    // we fired it — so the ordinary expiries are the wrong clock: they would
    // keep asserting positions and free RAM for a net that no longer exists.
    // `stormWipe` drops the perishable fact classes on every non-immune host
    // and keeps identities (survivors' are still true; the dead die by the
    // ordinary goneAt path when later probes miss them). `lastMutationAt` is
    // stamped to the burst's end so the normal probe/detail refresh runs from
    // darkweb and the pinned survivors.
    if (stormWipeAt !== undefined && at >= stormWipeAt) {
      stormWipeAt = undefined;
      knowledge = stormWipe(knowledge, expiryOpts());
      lastMutationAt = Math.max(lastMutationAt ?? 0, (lastStormFiredAt ?? at) + STORM_BURST_MS);
    }

    if (mutationSweepDue) {
      mutationSweepDue = false;
      for (const [hostname, queue] of [...queues]) {
        const pid = queue.active?.pid ?? queue.residentPid;
        if (pid === undefined) continue;
        let alive = false;
        try {
          alive = ns["isRunning"](pid, hostname);
        } catch {
          alive = false;
        }
        if (alive) continue;
        residentsLost++;
        retireVantage(hostname, `${hostname} process died during a mutation`, queue);
        invalidateBackdoor(hostname);
      }
    }

    // The condition the realm exception rests on: entries are expired by the
    // overseer, never trusted. A resident dies with its host, and a queue left
    // behind would be a plan for a machine that is gone.
    for (const dead of sweepQueues(queues, at)) {
      residentsLost++;
      // `sweepQueues` already removed the map entry; retire the remaining
      // process registries and fail work nobody can settle.
      retireVantage(dead.host, `${dead.host} lost its resident`, dead);
    }
    reconcilePending(at);
    // A job whose process was killed never settles. The timeout is what turns
    // that into a counted fact rather than a leak.
    for (const queue of queues.values()) {
      const active = queue.active;
      if (active?.startedAt === undefined) continue;
      // Two clocks, one rule: a job is timed out when the evidence that it is
      // alive has run out. A short job's evidence is that it started recently;
      // a LONG-LIVED one's is its own beat, because it is expected to sit there
      // and a fixed watchdog would kill exactly the thing it was meant to
      // protect. What must never happen is the third case — no clock at all,
      // which is what `Infinity` used to mean: a long job whose process died
      // with its host would pin its queue open for ever and the host could
      // never be re-planted.
      const expired = active.longLived
        ? at - (active.beatAt ?? active.startedAt) > LONG_JOB_BEAT_MS
        : at - active.startedAt > JOB_TIMEOUT_MS;
      if (expired) {
        queue.active = undefined;
        queue.failed++;
        // Stamp the beat as the job is cleared: `lastBeatAt` froze for the whole
        // job, and the sweep falls back to it the moment `active` is gone — an
        // unstamped timeout handed the returning resident one tick, not the full
        // beat window the sweep promises.
        queue.lastBeatAt = at;
        active.fail(new Error(
          active.longLived
            ? `${active.label} stopped beating on ${queue.host}`
            : `${active.label} timed out on ${queue.host}`,
        ));
      }
    }
    residentsSeenEver = Math.max(residentsSeenEver, queues.size);

    const tasks = fileWork(at);
    // Assignment may have selected cancellation victims. Kill them in this
    // transaction so atExit consumes newly-filed work before any timer/tick.
    hardCancelSweep(ns, queues);

    if (at - lastBeat >= BEAT_INTERVAL_MS) {
      lastBeat = at;
      TELEMETRY: if (__TELEMETRY__ && tel) {
        tel.mirror(`dnet.overseer:${selfHost}`, {
          at,
          host: selfHost,
          charisma,
          residents: queues.size,
          residentsSeenEver,
          residentsLost,
          coverage: coverage(knowledge, at, expiryOpts()),
          tasks: tasks.length,
          queued: [...queues.values()].map((queue) => ({
            host: queue.host,
            pending: queue.pending.length,
            active: queue.active?.kind,
            freeGb: usableGb(queue.host, at, expiryOpts()),
            completed: queue.completed,
            failed: queue.failed,
            ...(queue.lastError !== undefined ? { lastError: queue.lastError } : {}),
          })),
        });
      }
    }

    // Wake on the next synchronous queue/fact signal, with TICK_MS only as a
    // watchdog. A realm timer yields a real macrotask without holding the
    // controller's Netscript concurrency slot.
    await waitForDerive();
  }

  if (realm.dnet_overseer === rendezvous) delete realm.dnet_overseer;
  // Retire the residents' probers so they do not linger reporting into a dead
  // rendezvous. Skip darkweb's own stamp — its pid is THIS process, and a
  // self-kill here would truncate the final telemetry flush below. A prober
  // already killed (pid 0, a lab-walk host) is skipped too.
  for (const probe of probes.values()) {
    if (probe.pid > 0 && probe.pid !== ns.pid) ns["kill"](probe.pid);
  }
  TELEMETRY: if (__TELEMETRY__ && tel) tel.flush();
}

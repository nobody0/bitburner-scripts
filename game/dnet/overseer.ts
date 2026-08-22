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
import { parseOverseerArgs, residentArgs } from "../../shared/strategy/dnet/mission.ts";
import {
  coverage,
  emptyKnowledge,
  foldLogDrain,
  foldAttempts,
  foldReports,
  freeRam,
  fresh,
  markCredentialKnown,
  stormWipe,
  type DarknetKnowledge,
  type ExpiryOpts,
} from "../../shared/strategy/dnet/knowledge.ts";
import { deriveTasks, type DeriveOptions, type Task, type TaskKind } from "../../shared/strategy/dnet/queue.ts";
import { DEFAULT_SPREAD_LIMITS, candidatesFrom, planSpread } from "../../shared/strategy/dnet/spread.ts";
import { planFarm, type FarmHost, type FarmKind, type PromoteSymbol } from "../../shared/strategy/dnet/farm.ts";
import { holdHostFrom, planInduce, planStasis, stasisTargetDepths, type HoldHost, type HoldView } from "../../shared/strategy/dnet/hold.ts";
import { planStorm, type StormHost } from "../../shared/strategy/dnet/storm.ts";
import { looseCandidates, type LooseTarget } from "../../shared/strategy/dnet/oracle.ts";
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
  JOB_METHODS,
  ROUTINE_JOB_KINDS,
  JOB_TIMEOUT_MS,
  LONG_JOB_BEAT_MS,
  RENDEZVOUS_PROTOCOL,
  RESIDENT_METHODS,
  dnetRealm,
  foldRefusals,
  hardCancelEligible,
  priceAgent,
  overseerIsLive,
  sweepClaims,
  sweepQueues,
  type DnetSpreadReport,
  type DnetFarmReport,
  type DnetHoldReport,
  type DnetStormReport,
  type DnetClaim,
  type DnetHostQueue,
  type DnetJob,
  type DnetJobResult,
  type DnetJobState,
  type DnetLabReport,
  type DnetLabWalker,
  type DnetOrders,
  type DnetRendezvous,
} from "./realm.ts";
import { makeJobBodies } from "./jobs.ts";
import { initTelemetry } from "../lib/telemetry.ts";

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
 * order; the resident decides WHEN, because only it can see how much RAM is free
 * at the instant it looks — and out here that moves without warning.
 *
 * ## What it costs
 *
 * Its priced surface is the base plus `getHostname`, `nextMutation` and
 * `isRunning`, pinned by tests/ram-budget.test.ts. Home launches it with
 * `priceAgent`'s margin. Target observation and action remain absent.
 *
 * Deliberately absent: `probe`, `getServerDetails`, `heartbleed`, `authenticate`,
 * `scp`, `exec` and `spawn`. It cannot observe, cannot crack, and cannot launch.
 *
 * That absence is the design rather than an economy. An overseer that COULD do
 * the work would, and then the process holding the only copy of the map would be
 * the one sitting inside a multi-second `authenticate` on a host about to be
 * restarted.
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
/** How often it reconsiders the queues. `ns.sleep` is 0 GB, so this is only a
 * question of how promptly a freshly-queued job starts. */
const TICK_MS = 2_000;
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
 * for a DIFFERENT edge, the lab it carries in `state.edge`, and when a survey
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
 * throughout: the overseer's static RAM figure must stay `getHostname` alone,
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

  const mission = parseOverseerArgs(ns.args);
  if (!mission) return;

  const realm = dnetRealm();
  const bootAt = Date.now();
  // Deferring to a live overseer of the same generation is what makes a
  // re-seed idempotent: home may launch us whenever it is unsure, and the
  // redundant copy exits instead of running a second scheduler.
  if (overseerIsLive(realm.dnet_overseer, mission.generation, bootAt)) return;

  let identity: ArtifactIdentity | undefined;
  try {
    identity = JSON.parse(mission.identity) as ArtifactIdentity;
  } catch {
    /* Unreadable identity costs telemetry, never the work. */
  }

  let tel: ReturnType<typeof initTelemetry> | undefined;
  TELEMETRY: if (__TELEMETRY__) {
    if (identity) tel = initTelemetry(ns, ns.getScriptName(), identity);
  }

  const selfHost = ns.getHostname();
  const payloads = [mission.agentFile];
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
  /** Hosts whose link we RELEASED, by release time. Home's `stasisLinked`
   *  order is a union (a pin we just made is newer than a probe that missed
   *  it), and the same asymmetry cuts the other way: a probe taken before our
   *  release would union the dead link back in. Entries older than the window
   *  defer to home again — by then its probe has seen the release. */
  const recentUnpins = new Map<string, number>();
  const RECENT_UNPIN_MS = 60_000;
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
  const pendingAttempts: { hostname: string; outcome: AttemptOutcome }[] = [];
  const pendingLogDrains: { hostname: string; outcome: LogDrainOutcome }[] = [];
  const queues = new Map<string, DnetHostQueue>();
  // What is being done TO each host, from wherever. The other axis from
  // `queues`, which is per-VANTAGE. See DnetClaim.
  const claims = new Map<string, DnetClaim[]>();
  let residentsSeenEver = 0;
  let residentsLost = 0;
  let standDown = false;
  let lastMutationAt: number | undefined;
  let pendingMutations = 0;
  let mutationSweepDue = false;
  /** The lab's shared maze knowledge, keyed by lab hostname. The ONE piece of
   * walk progress that survives a walker's PID: every walker folds it in before
   * deciding and merges its own field back after observing, so a finisher and a
   * scout act as one mapper and a re-seeded walker starts with its
   * predecessor's map. Merged, never replaced — two concurrent walkers must not
   * clobber each other's slots. Never cleared: rungs have distinct hostnames, a
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
        ...(job.state.role !== undefined ? { role: job.state.role } : {}),
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
    generation: mission.generation,
    controllerPid: ns.pid,
    startedAt: bootAt,
    lastBeatAt: bootAt,
    queues,
    claims,
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
        ...(stasisLinked.size > 0 ? { stasisLinked: [...stasisLinked].sort() } : {}),
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
          ...(queue.freeGb !== undefined ? { freeGb: queue.freeGb } : {}),
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
      return drained;
    },
    order(orders: DnetOrders) {
      charisma = orders.charisma;
      if (orders.netDepth !== undefined) netDepth = orders.netDepth;
      if (orders.bitNode !== undefined) bitNode = orders.bitNode;
      if (orders.vault !== undefined) {
        const snapshotAt = orders.vaultSnapshotAt ?? Date.now();
        const supplied = new Set(orders.vault.map((entry) => entry.hostname));
        for (const [hostname, entry] of vault) {
          if (!supplied.has(hostname) && entry.at <= snapshotAt) vault.delete(hostname);
        }
        for (const entry of orders.vault) {
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
      // Home's probe is the AUTHORITY on which hosts are pinned; the set below
      // is only what this overseer has seen itself do. Replayed for the same
      // reason the vault and the phishing window are: a re-seeded overseer
      // starts with an empty set, and would otherwise spend its whole first
      // stretch filing 16 GB pin jobs for links the game already holds and
      // collecting 453s. Union rather than replacement, because a pin this
      // overseer has just made is newer than the probe that missed it.
      for (const hostname of orders.stasisLinked ?? []) {
        const releasedAt = recentUnpins.get(hostname);
        if (releasedAt !== undefined && Date.now() - releasedAt < RECENT_UNPIN_MS) continue;
        recentUnpins.delete(hostname);
        stasisLinked.add(hostname);
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
  // BOOTSTRAP. The queue is DERIVED from knowledge, so an overseer that knows
  // nothing derives nothing and files no work — for ever. Recording that our own
  // host exists, with no facts at all, is what makes the first
  // `survey:<selfHost>` job appear: an absent adjacency IS the work, and the
  // resident standing here is the only thing that can learn it.
  knowledge = foldReports(knowledge, [{ hostname: selfHost, at: bootAt, present: true }], bootAt).knowledge;

  realm.dnet_overseer = rendezvous;

  // The API supplies no mutation details, only an exact edge-triggered clock.
  // Keep one waiter alive, coalesce ticks for surveys, and let the controller
  // prove process death before clearing any active queue.
  void (async () => {
    while (!standDown) {
      await ns["dnet"]["nextMutation"]();
      if (standDown) break;
      lastMutationAt = Date.now();
      pendingMutations++;
      mutationSweepDue = true;
    }
  })();

  const note = (code: number, n = 1): void => {
    codes[String(code)] = (codes[String(code)] ?? 0) + n;
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

  /** Retire every fact and job tied to one server lifetime. */
  const retireLifetime = (hostname: string, reason: string): void => {
    vault.delete(hostname);
    lastPlantAt.delete(hostname);
    backdoors.delete(hostname);
    forgetGuesses(hostname);
    for (let index = provisionalPool.length - 1; index >= 0; index--) {
      if (provisionalPool[index]!.hostname === hostname) provisionalPool.splice(index, 1);
    }
    retireJobs(hostname, reason, () => true);
  };

  // Successful authentication writes through to the shared vault immediately;
  // it never depends on the worker surviving long enough to settle its job.
  const recordCredential = (entry: VaultEntry): void => {
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
  const enqueue = (queue: DnetHostQueue, draft: Omit<DnetJob, "settle" | "fail">): void => {
    // The queue-depth bound. `planSpread` deliberately files every plant it can
    // justify and lets this decide how many actually fit.
    if (queue.pending.length >= MAX_QUEUED_PER_HOST) return;
    if (queue.pending.some((entry) => entry.id === draft.id) || queue.active?.id === draft.id) return;
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
    const promise = new Promise<DnetJobResult>((resolve, reject) => {
      job.settle = resolve;
      job.fail = reject;
    });
    void promise.then(
      (result) => {
        absorb(result);
        if (result.targetState === 'edge-lost' || result.targetState === 'replaced') {
          lastMutationAt = Date.now();
        }
        if (result.targetState === 'gone') {
          const gone: ReportHost = { hostname: job.state.host, at: Date.now(), present: false };
          knowledge = foldReports(knowledge, [gone], gone.at, expiryOpts()).knowledge;
          pendingHosts.push(gone);
          retireLifetime(job.state.host, 'server reported gone');
        } else if (result.targetState === 'replaced') {
          const host = knowledge.hosts[job.state.host];
          if (host) {
            host.facts = {};
            delete host.attempts;
            delete host.ring;
            delete host.credentialKnown;
          }
          retireLifetime(job.state.host, 'server identity changed');
        }
        if (job.kind === "plant") lastPlantAt.set(job.state.host, Date.now());
        // The only place a link is ever recorded — or erased. `setStasisLink`
        // takes no host, so the host it acted on is the one the job ran on; a
        // 453 on the pin direction means the engine's limit is already spent,
        // which is home's belief being wrong rather than ours. A successful
        // RELEASE is also remembered briefly, so home's next order — whose
        // probe may predate the release — cannot union the dead link back in
        // and trigger a second 12 GB release of nothing.
        if (job.kind === "pin" && result.ok) {
          if (job.state.unpin === true) {
            stasisLinked.delete(job.state.host);
            recentUnpins.set(job.state.host, Date.now());
          } else {
            stasisLinked.add(job.state.host);
          }
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
      },
      () => {
        if (job.kind === "plant") lastPlantAt.set(job.state.host, Date.now());
        // JobDied, not NotEnoughRam: this path is a job whose promise was
        // REJECTED — its host restarted under it, its resident was swept, or it
        // timed out — and counting that as a RAM shortage made a dying net read
        // as a full one.
        note(LOCAL_CODE.JobDied);
      },
    );
    // Filed IN PRIORITY ORDER, not in arrival order. The resident takes the
    // first pending job that FITS, so with farm work in the queue a
    // forty-second phish enqueued one tick before a plant would hold the host
    // away from the plant for its whole batch. Stable: equal priorities keep
    // the order they were derived in, which is already deterministic.
    const at = queue.pending.findIndex((entry) => entry.priority > job.priority);
    if (at === -1) queue.pending.push(job);
    else queue.pending.splice(at, 0, job);
    // The claim is filed with the job and dies with it: `sweepClaims` drops it
    // the moment the job leaves this queue, so there is no completion protocol
    // and nothing to get out of sync. Same discipline as the derived queue.
    const held = claims.get(job.state.host) ?? [];
    held.push({
      target: job.state.host,
      from: job.state.from,
      // `DnetJob.kind` is a string because the realm must not import the queue's
      // vocabulary to describe a process; every job filed here comes from a
      // derived Task, so the narrowing is sound at this one call site.
      kind: job.kind as TaskKind,
      jobId: job.id,
      ...(job.state.password !== undefined ? { password: job.state.password } : {}),
      claimedAt: Date.now(),
      expectedDoneAt: Date.now() + JOB_TIMEOUT_MS,
    });
    claims.set(job.state.host, held);
  };

  // What each job costs the host that runs it, priced from the game's own
  // table. `ns.getFunctionRamCost` is 0 GB, so this is free.
  const budgets: Record<string, number> = Object.fromEntries(
    Object.entries(JOB_METHODS).map(([kind, methods]) => [kind, priceAgent(ns, methods)]),
  );
  const residentGb = priceAgent(ns, RESIDENT_METHODS);
  /** What one thread of each farm kind costs, for the ladder's own room checks.
   *  `ramOverride` is charged PER THREAD, so this is a unit price. */
  const farmGbPerThread: Record<FarmKind, number> = {
    cache: budgets["cache"] ?? budgets["survey"]!,
    reclaim: budgets["reclaim"] ?? budgets["survey"]!,
    phish: budgets["phish"] ?? budgets["survey"]!,
    promote: budgets["promote"] ?? budgets["survey"]!,
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
  const bodyFor = (kind: string): DnetJob["body"] => bodies[kind] ?? bodies["survey"]!;

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
    // Only the FINISHER's host is irreplaceable. A scout walk is disposable by
    // design — its map lives in `labFields`, its position is the only thing a
    // mutation can take — so its host must not attract a stasis link.
    const walking = new Set<string>();
    for (const queue of queues.values()) {
      if (queue.active?.kind === "walk" && queue.active.state.role !== "scout") walking.add(queue.host);
      for (const job of queue.pending) {
        if (job.kind === "walk" && job.state.role !== "scout") walking.add(queue.host);
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
        freeGb: (queue?.freeGb ?? freeRam(host, at, expiry)) + (queue ? residentGb : 0),
        ...(walking.has(host.hostname) ? { irreplaceable: true } : {}),
      };
    });
  };

  /** Whether to start walking a maze, and from where — and whether a SECOND
   * adjacent host should walk it too.
   *
   * The whole point of the feature's deep half. A completed lab hands over admin
   * rights, a cache and a queued augmentation, and it DEEPENS THE NET, which is
   * the only thing that ever changes the mutation clock.
   *
   * The second walker is a SCOUT, and the engine facts that make it worth
   * filing are all verified in `sim/dnet-lab.ts`'s party arena: the maze is
   * global while positions are per PID, both walkers' delays run in parallel,
   * every failed move feeds the one charisma pool, and EITHER pid reaching the
   * endpoint roots the lab. The scout commits to the southern macro-route and
   * shares its map through `labFields`, which is also why it is disposable —
   * a mutation eating it costs its position, never the map. Reading the lab's
   * log ring instead would be worthless: the ring holds only the responses our
   * own walkers already received, so a second vantage is always better spent
   * WALKING than bleeding. And the arena's mortality runs are why the scout
   * never gets a stasis link: a pinned scout buys a few percent over a mortal
   * one, and a link is worth far more on the ladder itself.
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
  ): { lab?: HoldHost; tasks: HoldTask[]; walking: boolean } => {
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
    // What is already in flight, by role. The finisher is never doubled: two
    // unbiased walkers would shadow each other, and the second could steal the
    // stasis argument from the first.
    let finisherAt: string | undefined;
    const scoutsAt = new Set<string>();
    for (const queue of queues.values()) {
      for (const job of [queue.active, ...queue.pending]) {
        if (job === undefined || job.kind !== "walk") continue;
        if (job.state.role === "scout") scoutsAt.add(queue.host);
        else finisherAt = queue.host;
      }
    }
    // Its host must be ADJACENT to the lab, which out here means on the
    // bottom row — `addServerToNetwork` wires anything landing at
    // `netDepth - 1` to the labyrinth automatically.
    const vantages = [...queues.values()]
      .map((queue) => queue.host)
      .filter((host) => {
        const standing = knowledge.hosts[host];
        if (!standing) return false;
        return (fresh<string[]>(standing, "neighbours", at, expiry) ?? []).includes(lab.hostname);
      })
      .sort()
      .filter((host) => {
        const queue = queues.get(host)!;
        return queue.freeGb === undefined || budgets["walk"]! <= queue.freeGb + residentGb;
      });
    const tasks: HoldTask[] = [];
    // A walker is threaded to its vantage: every maze move is an
    // `authenticate`, whose duration shrinks `1/(1 + 0.2*(threads-1))` with
    // the calling script's threads, and a deep lab is thousands of moves — so
    // the same RAM that would sit idle under a 1-thread walk buys hours of
    // wall clock. The host holds one job at a time, so there is nothing else
    // the RAM could have done. No ceiling: the per-thread `budgets["walk"]`
    // carries the script base and the 2.0 GB spawn the walker's atExit needs,
    // and the engine charges per thread, so this fills the vantage exactly.
    const walkThreadsOn = (host: string): number => {
      const queue = queues.get(host);
      if (queue?.freeGb === undefined || budgets["walk"] === undefined) return 1;
      return Math.max(1, Math.floor((queue.freeGb + residentGb) / budgets["walk"]));
    };
    if (finisherAt === undefined) {
      const vantage = vantages[0];
      if (vantage === undefined) {
        refuse(
          lab.hostname,
          "no-vantage",
          "nothing of ours is standing next to the labyrinth with room for a walker",
        );
        return { lab, tasks, walking: false };
      }
      finisherAt = vantage;
      tasks.push({
        kind: "walk",
        host: lab.hostname,
        from: vantage,
        threads: walkThreadsOn(vantage),
        reason: `walk the maze from ${vantage}`,
      });
    }
    // One scout at most: the party arena shows a second walker buys ~10% of
    // the walk and a third much less, and every extra vantage held here is a
    // vantage not doing the net's other work.
    if (scoutsAt.size === 0) {
      const second = vantages.find((host) => host !== finisherAt);
      if (second !== undefined) {
        tasks.push({
          kind: "walk",
          host: lab.hostname,
          from: second,
          threads: walkThreadsOn(second),
          role: "scout",
          reason: `scout the maze's southern route from ${second}`,
        });
      }
    }
    return { lab, tasks, walking: finisherAt !== undefined };
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
  ): HoldTask[] => {
    const tasks: HoldTask[] = [];
    for (const hostname of pin) {
      const queue = queues.get(hostname);
      const free = (queue?.freeGb ?? 0) + residentGb;
      if (queue !== undefined && queue.freeGb !== undefined && budgets["pin"]! > free) {
        refuse(hostname, "no-room", `a 12 GB setStasisLink needs ${budgets["pin"]!.toFixed(2)}GB and ${free.toFixed(2)}GB is free`);
        continue;
      }
      // THE PIN'S ONE HONEST PROBLEM. `setStasisLink` is 12 GB, and with the
      // 2.0 GB spawn back that is more than a 16 GB darknet host has — so the
      // job's allocation drops the spawn and its process simply ENDS, leaving
      // the host with no resident. That is safe only because something else can
      // put one back, and out here only an adjacent host holding our credential
      // can. Refused by name when nothing can, because a pin that stranded its
      // own host would have spent the scarcest thing in the feature to make a
      // host unreachable for ever.
      const replanter = [...queues.keys()].some((other) => {
        if (other === hostname) return false;
        const standing = knowledge.hosts[other];
        if (!standing) return false;
        return (fresh<string[]>(standing, "neighbours", at, expiry) ?? []).includes(hostname);
      });
      if (!replanter || !vault.has(hostname)) {
        refuse(
          hostname,
          "no-replanter",
          "the pin job cannot afford the spawn back, and no neighbour of ours could re-plant this host",
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

  const planHold = (at: number): { tasks: HoldTask[]; report: DnetHoldReport; labWalked: boolean } => {
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
    for (const task of walk.tasks) {
      tasks.push(task);
      // Marked BEFORE `planStasis` runs, and that is the whole point: the
      // host is about to carry work that cannot be rebuilt, and a link
      // spent after the walk has started is a link spent on a host whose
      // walk has already survived without one. `planStasis` ranks
      // `irreplaceable` above everything else, so this is what makes the
      // walker's host the first stasis target rather than merely the best
      // argued one. The order of these three blocks is the policy.
      // ONLY the finisher: a scout is disposable on purpose — its map lives in
      // `labFields` — and marking it would let it steal the scarcest resource
      // in the feature from the walk that actually must survive.
      if (task.role === "scout") continue;
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
    for (const task of admitPins(at, expiry, stasis.release, refuse)) {
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
    // the labyrinth for free. So pushing is worth paying for on two occasions:
    // while the lab still needs reaching (the landing is the walk's vantage),
    // and while unspent stasis links remain (`planInduce`'s `seat` purpose
    // pushes a big host into an open target's window when nothing stands
    // there already). With the lab reachable AND every link spent, a push is
    // churn: hundreds of calls and, if the net is full, the host itself.
    const lab = walk.lab;
    const spareLinks = Math.max(0, stasisLimit - stasisLinked.size);
    // "A walk exists" now means filed this pass OR already in flight — with the
    // in-flight finisher no longer re-filed each pass, checking only `tasks`
    // would have started pushing hosts around mid-walk.
    const wantsPush = !walk.walking
      && ((lab !== undefined && !vault.has(lab.hostname)) || spareLinks > 0);
    if (!wantsPush) {
      if (lab !== undefined) {
        refuse(
          lab.hostname,
          "push-not-needed",
          walk.walking
            ? "a walk is in flight; pushing hosts around mid-walk is churn"
            : "the labyrinth is reachable and every stasis link is spent",
        );
      }
    } else {
      const induce = planInduce({
        ...view,
        induceGbPerThread: budgets["induce"],
        // The bottom row is only worth minting a landing on while a walk still
        // needs a vantage — afterwards (and in a lab-less world) the same big
        // hosts serve the spare seats instead.
        needLabVantage: lab !== undefined && !labWalked,
      });
      for (const refusal of induce.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
      if (induce.push) {
        tasks.push({
          kind: "induce",
          host: induce.push.host,
          from: induce.push.from,
          // Sized from the pusher's free RAM: the charge is linear in the
          // calling script's threads and the 6 s wait is not.
          threads: induce.push.threads,
          reason: induce.push.reason,
        });
      }
    }

    const admitted: Record<string, number> = {};
    for (const task of tasks) admitted[task.kind] = (admitted[task.kind] ?? 0) + 1;
    // `labWalked` is surfaced for the storm trigger: the walker-protection gate
    // retires itself once the vault holds the lab's password, and this closure
    // is the one place that already knows both halves.
    return { tasks, report: { admitted, ...foldRefusals(refused) }, labWalked };
  };

  /** Every host the farm ladder could act on.
   *
   * Only hosts we are STANDING on: all four farm calls act on the calling host,
   * so a host with no resident has nothing to offer here whatever its blocked
   * RAM says. */
  const projectFarmHosts = (at: number, expiry: ExpiryOpts): FarmHost[] => {
    const farmHosts: FarmHost[] = [];
    for (const queue of queues.values()) {
      const host = knowledge.hosts[queue.host];
      if (!host) continue;
      const busy = new Set<FarmKind>();
      for (const claim of claims.get(queue.host) ?? []) {
        // All FOUR rungs, `promote` included. Leaving it out did not risk a
        // duplicate — `deriveTasks` drops a busy kind either way — it made the
        // ladder spend a host's one rung re-admitting propaganda that was then
        // silently dropped, inflated `farm.admitted.promote` with work nobody
        // filed, and left `promote-in-flight` a refusal name that could never
        // fire.
        if (
          claim.kind === "cache" || claim.kind === "reclaim"
          || claim.kind === "phish" || claim.kind === "promote"
        ) busy.add(claim.kind);
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
        // What a JOB would get: the resident hands its own allocation back when
        // it spawns. `freeGb` is the resident's own measurement where it has
        // made one, and the folded facts otherwise.
        freeGb: (queue.freeGb ?? freeRam(host, at, expiry)) + residentGb,
        caches: fresh<string[]>(host, "caches", at, expiry) ?? [],
        isLab: isLabyrinth(queue.host, fresh<string>(host, "modelId", at, expiry)),
        ...(host.goneAt !== undefined ? { goneAt: host.goneAt } : {}),
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
    Object.values(knowledge.hosts).map((host) => {
      const length = fresh<number>(host, "passwordLength", at, expiry);
      const format = fresh<string>(host, "passwordFormat", at, expiry);
      return {
        hostname: host.hostname,
        ...(length !== undefined ? { passwordLength: length } : {}),
        ...(format !== undefined ? { passwordFormat: format } : {}),
        hasCredential: vault.has(host.hostname),
        ...(fresh<boolean>(host, "isStationary", at, expiry) === true ? { isStationary: true } : {}),
        ...(host.goneAt !== undefined ? { gone: true } : {}),
      };
    });

  /** One derived task, mapped onto the queue of the host that must run it.
   *
   * This is the only place a `Task` becomes a `DnetJob`, and the only place a
   * password is put back into one: the queue carried an opaque id precisely so
   * that a pure module never had to hold a credential. */
  const fileTask = (task: Task): void => {
    const queue = queues.get(task.from);
    // No resident there: nothing can run it, and filing it would be a plan for
    // a machine we cannot reach.
    if (!queue) return;
    const budget = budgets[task.kind] ?? budgets["survey"]!;
    const threads = task.threads ?? 1;
    // The resident's own allocation comes back when it spawns, so that is what
    // a job actually gets. Skipping here rather than queueing keeps a job that
    // can never fit from blocking the ones that can. `budgetGb` is PER THREAD,
    // exactly as the engine charges `ramOverride`, so the product is the cost.
    if (queue.freeGb !== undefined && budget * threads > queue.freeGb + residentGb) return;
    enqueue(queue, {
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
        ...(vault.has(task.host) ? { password: vault.get(task.host)!.password } : {}),
        ...(knowledge.hosts[task.host]?.identity !== undefined
          ? { targetIdentity: knowledge.hosts[task.host]!.identity }
          : {}),
        ...(task.filename !== undefined ? { filename: task.filename } : {}),
        ...(task.symbol !== undefined ? { symbol: task.symbol } : {}),
        ...(task.edge !== undefined ? { edge: task.edge } : {}),
        ...(task.unpin === true ? { unpin: true } : {}),
        // A scout walk stays a scout in the job: `walkJob` biases its route
        // prior off this, and the sweep above kept its host un-pinnable.
        ...(task.role !== undefined ? { role: task.role } : {}),
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
            payloads,
            plantArgs: residentArgs({
              missionId: mission.missionId,
              generation: mission.generation,
              identity: mission.identity,
              agentId: `resident-${task.host}`,
            }),
          }
          : {}),
      },
      body: bodyFor(task.kind),
    });
  };

  /** Derive what there is to do, and file it.
   *
   * The order is the policy and every step feeds the next: spread and farm and
   * hold each produce admitted work plus named refusals, the loose-password pass
   * turns leaked strings into opaque guess ids, and `deriveTasks` merges all four
   * with what the map alone implies. */
  const fileWork = (at: number): Task[] => {
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
    const plan = planSpread(
      candidatesFrom(knowledge, at, {
        standing: new Set([selfHost, ...queues.keys()]),
        vault: new Set(vault.keys()),
        lastPlantAt,
        remoteExec,
        remoteVantages: [...queues.values()].map((queue) => ({ host: queue.host, freeGb: queue.freeGb })),
        expiry: expiryOpts(),
      }),
      DEFAULT_SPREAD_LIMITS,
      at,
    );
    // Recorded rather than discarded: `plan.refused` is the only answer the
    // feature has to "why has the net stopped growing", and one example per
    // reason is what turns a count into somewhere to look.
    spread = { planted: plan.plant.length, ...foldRefusals(plan.refused) };

    // The storm's projection of every knowledge host, built here because the
    // seed-hunt decision below reads it too. Only the trigger CALL waits for
    // the hold pass — see the storm block.
    const stormExpiry = expiryOpts();
    const stormHosts: StormHost[] = Object.values(knowledge.hosts).map((host) => {
      const seed = fresh<boolean>(host, "stormSeed", at, stormExpiry);
      return {
        hostname: host.hostname,
        ...(seed !== undefined ? { stormSeed: seed } : {}),
        agentAlive: queues.has(host.hostname),
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

    // --- the storm --------------------------------------------------------
    //
    // Decided AFTER the hold pass on purpose: `links-unspent` reads the pins
    // this very derivation just filed, so a storm can never race the pin it is
    // waiting for. The policy is pure (`storm.ts`); the view was projected
    // above, beside the seed hunt that shares it.
    // A pin still pending — filed this pass, or claimed and not yet landed —
    // is a slot mid-spend, and the storm waits for it.
    const pinsPending = holdPlan.tasks.some((task) => task.kind === "pin" && task.unpin !== true)
      || [...claims.values()].some((held) => held.some((claim) => claim.kind === "pin"));
    // The finisher's vantage, whether the walk is in flight or filed this pass.
    let walkFrom: string | undefined;
    for (const queue of queues.values()) {
      for (const job of [queue.active, ...queue.pending]) {
        if (job !== undefined && job.kind === "walk" && job.state.role !== "scout") walkFrom = queue.host;
      }
    }
    for (const task of holdPlan.tasks) {
      if (task.kind === "walk" && task.role !== "scout") walkFrom = task.from;
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
      ...(lastMutationAt !== undefined ? { lastMutationAt } : {}),
      // Data only. The two fields are NAMED rather than spread, which is what
      // keeps `queue.ts` pure: a claim carries a password, and a field added to
      // `DnetClaim` later cannot arrive in a shared module by default.
      inFlight: new Map(
        [...claims].map(([target, held]) => [
          target,
          held.map((entry) => ({ from: entry.from, kind: entry.kind })),
        ]),
      ),
      agents: new Set([selfHost, ...queues.keys()]),
      // What a job would get on each vantage — the same figure `fileTask`'s fit
      // check compares against, so a vantage the derivation prefers is one the
      // filed job actually fits on. `selfHost` is absent deliberately: the
      // overseer never runs attempts.
      agentFreeGb: new Map(
        [...queues.values()]
          .filter((queue) => queue.freeGb !== undefined)
          .map((queue) => [queue.host, queue.freeGb! + residentGb]),
      ),
      ...(budgets["attempt"] !== undefined ? { attemptGbPerThread: budgets["attempt"] } : {}),
      ...(budgets["bleed"] !== undefined ? { bleedGbPerThread: budgets["bleed"] } : {}),
      vault: new Set(vault.keys()),
      plantable: plan.plant.map((entry) => ({
        host: entry.host,
        from: entry.from,
        ...(entry.remote ? { remote: true } : {}),
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
    for (const task of tasks) fileTask(task);
    return tasks;
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
        } else if (job.kind === 'survey') {
          const neighbours = fresh<string[]>(host, 'neighbours', at, expiry);
          const mutationFresh = lastMutationAt === undefined || (host.facts['neighbours']?.at ?? 0) >= lastMutationAt;
          if (neighbours !== undefined && mutationFresh) reason = 'survey already satisfied';
        }
        if (reason === undefined) keep.push(job);
        else job.settle({ ok: false, targetState: 'cancelled', detail: reason });
      }
      queue.pending = keep;
    }
  };

  let lastBeat = bootAt;

  while (!standDown) {
    const at = Date.now();
    rendezvous.lastBeatAt = at;

    // THE POST-BURST WIPE, exactly once per storm. Everything outside
    // stationary/stasis was just deleted, moved or restarted, and we KNOW —
    // we fired it — so the ordinary expiries are the wrong clock: they would
    // keep asserting positions and free RAM for a net that no longer exists.
    // `stormWipe` drops the perishable fact classes on every non-immune host
    // and keeps identities (survivors' are still true; the dead die by the
    // ordinary goneAt path when re-surveys miss them). `lastMutationAt` is
    // stamped to the burst's end so the existing changed-since-survey
    // machinery fans the re-surveys out from darkweb and the pinned
    // survivors on its own.
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
        queues.delete(hostname);
        residentsLost++;
        if (queue.active) queue.active.fail(new Error(`${hostname} process died during a mutation`));
        for (const job of queue.pending) job.fail(new Error(`${hostname} resident died during a mutation`));
        backdoors.delete(hostname);
      }
    }

    // The condition the realm exception rests on: entries are expired by the
    // overseer, never trusted. A resident dies with its host, and a queue left
    // behind would be a plan for a machine that is gone.
    for (const dead of sweepQueues(queues, at)) {
      residentsLost++;
      // Fail what it was holding, so a promise nobody will ever settle does not
      // sit in memory pretending to be work in progress.
      if (dead.active) dead.active.fail(new Error(`${dead.host} lost its resident mid-job`));
      for (const job of dead.pending) job.fail(new Error(`${dead.host} lost its resident`));
    }
    // Right after the queue sweep, so it reads the verdict that sweep just
    // reached: a claim whose vantage was retired has no queue to be in.
    sweepClaims(claims, queues, at);
    reconcilePending(at);
    hardCancelSweep(ns, queues);
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
            freeGb: queue.freeGb,
            completed: queue.completed,
            failed: queue.failed,
            ...(queue.lastError !== undefined ? { lastError: queue.lastError } : {}),
          })),
        });
      }
    }

    await ns.sleep(TICK_MS);
  }

  if (realm.dnet_overseer === rendezvous) delete realm.dnet_overseer;
  TELEMETRY: if (__TELEMETRY__ && tel) tel.flush();
}

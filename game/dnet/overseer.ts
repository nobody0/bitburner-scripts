import type { NS } from "@ns";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import type { AttemptOutcome, ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import { parseOverseerArgs, residentArgs } from "../../shared/strategy/dnet/mission.ts";
import {
  coverage,
  emptyKnowledge,
  foldAttempts,
  foldReports,
  freeRam,
  fresh,
  type DarknetKnowledge,
  type ExpiryOpts,
} from "../../shared/strategy/dnet/knowledge.ts";
import { deriveTasks, type DeriveOptions, type Task, type TaskKind } from "../../shared/strategy/dnet/queue.ts";
import { DEFAULT_SPREAD_LIMITS, candidatesFrom, planSpread } from "../../shared/strategy/dnet/spread.ts";
import { planFarm, type FarmHost, type FarmKind } from "../../shared/strategy/dnet/farm.ts";
import { planInduce, planStasis, type HoldHost, type HoldView } from "../../shared/strategy/dnet/hold.ts";
import { looseCandidates, type LooseTarget } from "../../shared/strategy/dnet/listen.ts";
import { getPasswordType } from "../../shared/strategy/dnet/codecs.ts";
import { DEFAULT_NET_DEPTH, isLabyrinth, labStage } from "../../shared/strategy/dnet/rates.ts";
import {
  JOB_METHODS,
  ROUTINE_JOB_KINDS,
  JOB_TIMEOUT_MS,
  LONG_JOB_BEAT_MS,
  RENDEZVOUS_PROTOCOL,
  RESIDENT_METHODS,
  dnetRealm,
  priceAgent,
  overseerIsLive,
  sweepClaims,
  sweepQueues,
  type DnetSpreadReport,
  type DnetFarmReport,
  type DnetHoldReport,
  type DnetListenReport,
  type DnetClaim,
  type DnetHostQueue,
  type DnetJob,
  type DnetJobResult,
  type DnetJobState,
  type DnetOrders,
  type DnetRendezvous,
} from "./realm.ts";
import { makeJobBodies } from "./jobs.ts";
import { initTelemetry } from "../lib/telemetry.ts";

/** The darknet controller: one long-lived script that decides, and never acts.
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
 * standing there spawns into it. The controller decides WHAT runs and in what
 * order; the resident decides WHEN, because only it can see how much RAM is free
 * at the instant it looks — and out here that moves without warning.
 *
 * ## What it costs
 *
 * base 1.6 + `getHostname` 0.05 = **1.65 GB static**, pinned by
 * tests/ram-budget.test.ts. Home launches it with a little more than that, since
 * every allocation carries `priceAgent`'s margin. Everything else it does is
 * free: `sleep` is 0 GB and the queues are live objects in the page realm.
 *
 * Deliberately absent: `probe`, `getServerDetails`, `heartbleed`, `authenticate`,
 * `scp`, `exec` and `spawn`. It cannot observe, cannot crack, and cannot launch.
 *
 * That absence is the design rather than an economy. A controller that COULD do
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
 * trick `game/lib/dodge.ts` uses and the reason this file stays at 1.65 GB while
 * the work it describes costs several times that. They bundle into this same
 * artifact, so that rule binds them exactly as hard as it binds this file. */

/** How often the controller tells home it is alive. Home re-seeds if this stops. */
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

/** Distinct log shapes the controller will remember.
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

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const mission = parseOverseerArgs(ns.args);
  if (!mission) return;

  const realm = dnetRealm();
  const bootAt = Date.now();
  // Deferring to a live controller of the same generation is what makes a
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
  const vault = new Map<string, string>();
  const codes: Record<string, number> = {};
  // The last derivation's spread verdict, overwritten every tick. A snapshot
  // rather than a tally: a host that has been full for a minute is one problem,
  // not the thirty ticks that noticed it.
  let spread: DnetSpreadReport | undefined;
  /** The last farm derivation, on the same snapshot discipline as `spread`. */
  let farm: DnetFarmReport | undefined;
  /** The last bleed-gate verdict, same discipline again. */
  let listen: DnetListenReport | undefined;
  /** The last hold derivation — the pin, the push and the walk. Same
   *  discipline: a snapshot of the current answer, not a tally of the ticks
   *  that reached it. */
  let hold: DnetHoldReport | undefined;
  /** Passwords a log leaked with no owner attached.
   *
   *  Realm-only and never drained: an unattributed password is still a
   *  password, and the controller is the only thing that holds both it and the
   *  length and format facts that say which hosts it could open. Bounded,
   *  because a chatty net mints these faster than they can be spent and the
   *  oldest are the least likely to still belong to a live host. */
  const loosePool: string[] = [];
  /** `<host>\u0000<password>` pairs already spent, so a candidate that was
   *  wrong is not offered again for the life of this controller. The engine
   *  charges nothing for a wrong `authenticate`, but a call is still a call and
   *  the same wrong pair would otherwise re-derive every tick for ever. */
  const spentGuesses = new Set<string>();
  /** Guess id -> the password it stands for. The id is what crosses into
   *  `shared/strategy/dnet/queue.ts`; the password never does. */
  const guessFor = new Map<string, string>();
  /** Hosts WE have pinned. The set is ours rather than observed: nothing else
   *  in the run sets or releases a link, and `getStasisLinkedServers` is not a
   *  member the controller can afford. Drained so home can carry it into the
   *  expiry it runs its own fold on. */
  const stasisLinked = new Set<string>();
  /** The highest charisma any job has said it needed and did not have. Only the
   *  maze walker reports one, and it is drained to home's existing career
   *  need rather than to a new channel. */
  let charismaNeeded: number | undefined;
  /** Symbols home has named as worth promoting. Empty is the usual answer, and
   *  the farm ladder refuses propaganda by name on it. */
  let promoteSymbols: string[] = [];
  /** `getStasisLinkLimit()`. One until the labyrinth pays out, and home says so
   *  when it can see the augmentations. */
  let stasisLimit = 1;
  /** How many darknet hosts home has backdoored. It is a term in the mutation
   *  rates every expiry is derived from — a backdoored host carries a ~9%/tick
   *  restart and a ~4%/tick delete on top of the ordinary branches — so a
   *  controller that did not hear about them would believe its facts lasted
   *  longer than they do. */
  let backdoored: number | undefined;
  /** Karma spent opening caches SINCE THE LAST DRAIN. Negative, because karma
   *  only falls — which is what makes a cache free progress toward the gang
   *  threshold. A delta rather than a running total, so that home's tally
   *  survives this controller being replaced; see `drain`. */
  let karmaLoss = 0;
  /** When a `.d.cache` was last seen to land. The phishing cache cooldown is
   *  NET-WIDE engine state (`DarknetState.lastPhishingCacheTime`) and is exposed
   *  through no ns member at all, so our own sightings are the only evidence
   *  there is. Undefined reads as "the window is open", which is the direction
   *  that costs nothing: the call is made either way. */
  let lastPhishCacheAt: number | undefined;
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
  const queues = new Map<string, DnetHostQueue>();
  // What is being done TO each host, from wherever. The other axis from
  // `queues`, which is per-VANTAGE. See DnetClaim.
  const claims = new Map<string, DnetClaim[]>();
  let residentsSeenEver = 0;
  let residentsLost = 0;
  let standDown = false;

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
      const drained = {
        hosts: pendingHosts.splice(0, pendingHosts.length),
        credentials: pendingCredentials.splice(0, pendingCredentials.length),
        attempts: pendingAttempts.splice(0, pendingAttempts.length),
        codes: { ...codes },
        ...(spread ? { spread } : {}),
        ...(farm ? { farm } : {}),
        ...(listen ? { listen } : {}),
        ...(hold ? { hold } : {}),
        ...(stasisLinked.size > 0 ? { stasisLinked: [...stasisLinked].sort() } : {}),
        ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
        ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
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
      };
      for (const key of Object.keys(codes)) delete codes[key];
      // A DELTA, cleared like `codes` and `residentsLost` beside it. Handing
      // home a running total instead would work only for as long as this
      // controller lives: a re-seeded one starts at zero, and home — which
      // assigns rather than accumulates — would silently drop the karma every
      // cache before the restart bought.
      karmaLoss = 0;
      residentsLost = 0;
      return drained;
    },
    order(orders: DnetOrders) {
      charisma = orders.charisma;
      if (orders.netDepth !== undefined) netDepth = orders.netDepth;
      if (orders.bitNode !== undefined) bitNode = orders.bitNode;
      for (const entry of orders.vault ?? []) vault.set(entry.hostname, entry.password);
      if (orders.openLabCache !== undefined) openLabCache = orders.openLabCache;
      if (orders.promoteSymbols !== undefined) promoteSymbols = [...orders.promoteSymbols];
      if (orders.backdoored !== undefined) backdoored = orders.backdoored;
      if (orders.stasisLimit !== undefined) stasisLimit = orders.stasisLimit;
      // Home's probe is the AUTHORITY on which hosts are pinned; the set below
      // is only what this controller has seen itself do. Replayed for the same
      // reason the vault and the phishing window are: a re-seeded controller
      // starts with an empty set, and would otherwise spend its whole first
      // stretch filing 16 GB pin jobs for links the game already holds and
      // collecting 453s. Union rather than replacement, because a pin this
      // controller has just made is newer than the probe that missed it.
      for (const hostname of orders.stasisLinked ?? []) stasisLinked.add(hostname);
      // Replayed after a re-seed so a fresh controller does not believe a window
      // is open that home watched close under the previous one.
      if (orders.lastPhishCacheAt !== undefined) {
        lastPhishCacheAt = Math.max(lastPhishCacheAt ?? 0, orders.lastPhishCacheAt);
      }
      if (orders.standDown === true) standDown = true;
    },
  };
  // BOOTSTRAP. The queue is DERIVED from knowledge, so a controller that knows
  // nothing derives nothing and files no work — for ever. Recording that our own
  // host exists, with no facts at all, is what makes the first
  // `survey:<selfHost>` job appear: an absent adjacency IS the work, and the
  // resident standing here is the only thing that can learn it.
  knowledge = foldReports(knowledge, [{ hostname: selfHost, at: bootAt, present: true }], bootAt).knowledge;

  realm.dnet_overseer = rendezvous;

  const note = (code: number, n = 1): void => {
    codes[String(code)] = (codes[String(code)] ?? 0) + n;
  };

  /** Fold a finished job's findings into the map, so the very next derivation
   * already accounts for them. This is the dedup: work a believable fact covers
   * does not exist, so a job that just refreshed one has, by returning, removed
   * the task that asked for it. No acknowledgement protocol, nothing to drift. */
  const absorb = (result: DnetJobResult): void => {
    // The fold's own clock, not a fact's: each reported host carries the time
    // the job that saw it looked.
    const at = Date.now();
    if (result.hosts && result.hosts.length > 0) {
      knowledge = foldReports(knowledge, result.hosts, at, expiryOpts()).knowledge;
      pendingHosts.push(...result.hosts);
    }
    for (const entry of result.credentials ?? []) {
      if (entry.hostname.length === 0) continue;
      vault.set(entry.hostname, entry.password);
      const host = knowledge.hosts[entry.hostname];
      if (host) host.credentialKnown = true;
      pendingCredentials.push(entry);
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
    for (const bare of result.loose ?? []) {
      if (loosePool.includes(bare)) continue;
      loosePool.push(bare);
      // Oldest out first. A leaked password belongs to a host that may since
      // have been deleted and re-minted, so age is exactly the right thing to
      // discard on.
      if (loosePool.length > MAX_LOOSE_PASSWORDS) loosePool.shift();
    }
    // 911 is the ONLY sighting we ever get of the net-wide phishing cooldown.
    // Stamping it here rather than in the job keeps the belief in the one place
    // that survives the job's process.
    if ((result.codes ?? {})["911"] !== undefined) lastPhishCacheAt = at;
  };

  const recordAttempts = (hostname: string, result: DnetJobResult): void => {
    const outcomes = result.attempts ?? [];
    if (outcomes.length === 0) return;
    foldAttempts(knowledge.hosts[hostname], outcomes);
    // Queued for the drain as well: home keeps its own copy of the ledger, so
    // the panel's cracking progress survives this process the way the map does.
    for (const outcome of outcomes) pendingAttempts.push({ hostname, outcome });
  };

  /** Queue one job on a host, and KEEP ITS PROMISE.
   *
   * The promise is how the controller tells "still working" from "died holding
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
    const promise = new Promise<DnetJobResult>((resolve, reject) => {
      job.settle = resolve;
      job.fail = reject;
    });
    // The bleed task derives from this fact, and NOTHING else ever writes it:
    // heartbleed with `peek` leaves the ring intact, so the game gives no
    // signal that a host was just listened to. Without the stamp,
    // `bleed:<host>` re-derives on every tick for every held host, for ever.
    // Stamped on failure and rejection too, deliberately: a bleed that answers
    // 351/408/503 — or whose process died — re-derived on the NEXT tick, one
    // wasted spawn every couple of seconds until the target vanished. The read
    // site's clock is topology expiry, so a failure-stamped host retries at
    // exactly the cadence a success produces, once the belief that failed it
    // has had time to be resurveyed.
    const stampBleed = (): void => {
      if (job.kind !== "bleed") return;
      const host = knowledge.hosts[job.state.host];
      if (host) host.facts["lastBleedAt"] = { value: true, at: Date.now() };
    };
    void promise.then(
      (result) => {
        absorb(result);
        recordAttempts(job.state.host, result);
        if (job.kind === "plant" && result.ok) lastPlantAt.set(job.state.host, Date.now());
        // The only place a link is ever recorded. `setStasisLink` takes no
        // host, so the host it pinned is the one the job ran on — and a 453
        // means the engine's limit is already spent, which is home's belief
        // being wrong rather than ours.
        if (job.kind === "pin" && result.ok) stasisLinked.add(job.state.host);
        // A guess that was refused is never offered again: the pair is wrong,
        // and it would otherwise re-derive on every tick for ever.
        if (job.kind === "attempt" && job.state.guess !== undefined) {
          spentGuesses.add(`${job.state.host}\u0000${job.state.guess}`);
        }
        stampBleed();
      },
      () => {
        // 905, not 903: this path is a job whose promise was REJECTED — its host
        // restarted under it, its resident was swept, or it timed out — and
        // counting that as NotEnoughRam made a dying net read as a RAM shortage.
        note(905);
        stampBleed();
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
  });
  const bodyFor = (kind: string): DnetJob["body"] => bodies[kind] ?? bodies["survey"]!;

  // The clock the expiries run on, rebuilt per tick because home's orders can
  // update both fields at any time.
  const expiryOpts = (): ExpiryOpts => ({
    ...(netDepth !== undefined ? { netDepth } : {}),
    ...(bitNode !== undefined ? { bitNode } : {}),
    ...(backdoored !== undefined ? { backdoored } : {}),
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
  const planHold = (at: number): { tasks: HoldTask[]; report: DnetHoldReport } => {
    const expiry = expiryOpts();
    const refused: DnetHoldReport["examples"] = [];
    const refuse = (host: string, why: string, detail: string): void => {
      refused.push({ host, why, detail });
    };
    const tasks: HoldTask[] = [];

    // A host running the maze walker is IRREPLACEABLE, and that is not a
    // figure of speech: the walk is keyed by PID, so losing the process loses
    // the whole maze with no way to resume. It is what `planStasis` ranks
    // first and what `planInduce` refuses to push.
    const walking = new Set<string>();
    for (const queue of queues.values()) {
      if (queue.active?.kind === "walk") walking.add(queue.host);
      for (const job of queue.pending) if (job.kind === "walk") walking.add(queue.host);
    }

    const hosts: HoldHost[] = Object.values(knowledge.hosts).map((host) => {
      const queue = queues.get(host.hostname);
      const depth = fresh<number>(host, "depth", at, expiry);
      const difficulty = fresh<number>(host, "difficulty", at, expiry);
      const maxRam = fresh<number>(host, "maxRam", at, expiry);
      const blockedRam = fresh<number>(host, "blockedRam", at, expiry);
      const neighbours = fresh<string[]>(host, "neighbours", at, expiry);
      return {
        hostname: host.hostname,
        ...(depth !== undefined ? { depth } : {}),
        ...(difficulty !== undefined ? { difficulty } : {}),
        ...(maxRam !== undefined ? { maxRam } : {}),
        ...(blockedRam !== undefined ? { blockedRam } : {}),
        freeGb: (queue?.freeGb ?? freeRam(host, at, expiry)) + (queue ? residentGb : 0),
        agentAlive: queue !== undefined,
        hasCredential: vault.has(host.hostname),
        ...(neighbours !== undefined ? { neighbours } : {}),
        ...(fresh<boolean>(host, "isStationary", at, expiry) === true ? { isStationary: true } : {}),
        ...(stasisLinked.has(host.hostname) ? { stasisLinked: true } : {}),
        ...(walking.has(host.hostname) ? { irreplaceable: true } : {}),
        ...(host.goneAt !== undefined ? { gone: true } : {}),
      };
    });
    const view: HoldView = {
      hosts,
      netDepth: netDepth ?? DEFAULT_NET_DEPTH,
      stasisLimit,
      charisma,
      // Backdoors are home's to install and home's to count; from out here the
      // multiplier is unobservable, and 1 is the value that makes `planStasis`
      // and `planInduce` decide on their own terms rather than on a guess.
      authDurationMultiplier: 1,
    };

    // --- the walk ----------------------------------------------------------
    //
    // The whole point of the feature's deep half. A completed lab hands over
    // admin rights, a cache and a queued augmentation, and it DEEPENS THE NET,
    // which is the only thing that ever changes the mutation clock.
    const lab = hosts.find((host) => isLabyrinth(
      host.hostname,
      fresh<string>(knowledge.hosts[host.hostname]!, "modelId", at, expiry),
    ) && !host.gone);
    if (lab === undefined) {
      // Not a refusal worth a name per host: there is exactly one lab in a net
      // and we have not laid eyes on it.
    } else if (vault.has(lab.hostname)) {
      refuse(lab.hostname, "lab-walked", "we already hold this lab's password, so its maze has been finished");
    } else {
      const stage = labStage(lab.hostname);
      const needed = stage?.cha;
      if (needed !== undefined && charisma < needed) {
        // The one gate in the feature that cannot be worked around: below the
        // lab's charisma EVERY move answers 451, so starting would spend a host
        // for hours and learn nothing. Posted as a career need instead.
        charismaNeeded = Math.max(charismaNeeded ?? 0, needed);
        refuse(lab.hostname, "charisma", `the maze needs charisma ${needed}, and every move below it answers 451`);
      } else {
        // Its host must be ADJACENT to the lab, which out here means on the
        // bottom row — `addServerToNetwork` wires anything landing at
        // `netDepth - 1` to the labyrinth automatically.
        const vantage = [...queues.values()]
          .map((queue) => queue.host)
          .filter((host) => {
            const standing = knowledge.hosts[host];
            if (!standing) return false;
            return (fresh<string[]>(standing, "neighbours", at, expiry) ?? []).includes(lab.hostname);
          })
          .sort()
          .find((host) => {
            const queue = queues.get(host)!;
            return queue.freeGb === undefined || budgets["walk"]! <= queue.freeGb + residentGb;
          });
        if (vantage === undefined) {
          refuse(
            lab.hostname,
            "no-vantage",
            "nothing of ours is standing next to the labyrinth with room for a walker",
          );
        } else {
          tasks.push({
            kind: "walk",
            host: lab.hostname,
            from: vantage,
            reason: `walk the maze from ${vantage}`,
          });
          // Marked BEFORE `planStasis` runs, and that is the whole point: the
          // host is about to carry work that cannot be rebuilt, and a link
          // spent after the walk has started is a link spent on a host whose
          // walk has already survived without one. `planStasis` ranks
          // `irreplaceable` above everything else, so this is what makes the
          // walker's host the first stasis target rather than merely the best
          // argued one.
          const standing = hosts.find((host) => host.hostname === vantage);
          if (standing) standing.irreplaceable = true;
        }
      }
    }

    // --- the pin -----------------------------------------------------------
    const stasis = planStasis(view);
    for (const refusal of stasis.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
    // A RECYCLE the planner wants and nothing carries out. `setStasisLink(false)`
    // is the same 12 GB call with a different argument, and no job kind takes
    // one — so rather than dropping the verdict on the floor (which is what
    // `planSpread`'s refusals did for months and why nobody could tell a
    // planner with nothing to do from a broken one), it is published by name.
    for (const hostname of stasis.release) {
      refuse(
        hostname,
        "release-unwired",
        "this link would be better spent elsewhere, but no job carries setStasisLink(false)",
      );
    }
    for (const hostname of stasis.pin) {
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
      tasks.push({ kind: "pin", host: hostname, from: hostname, reason: "pin the host nothing can replace" });
    }

    // --- the push ----------------------------------------------------------
    //
    // Only ever in service of the walk. `induceServerMigration` is a re-roll of
    // one host's position inside `[difficulty - 2, difficulty + 4]`, and the
    // one thing that re-roll buys is landing on the bottom row, where
    // `addServerToNetwork` wires a host to the labyrinth for free. With a
    // vantage on the lab already, pushing anything is churn we are paying for:
    // it costs hundreds of calls and, if the net is full, the host itself.
    const wantsPush = lab !== undefined
      && !vault.has(lab.hostname)
      && !tasks.some((task) => task.kind === "walk");
    if (!wantsPush) {
      if (lab !== undefined) refuse(lab.hostname, "push-not-needed", "we can already reach the labyrinth, or have finished it");
    } else {
      const induce = planInduce(view);
      for (const refusal of induce.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
      if (induce.push) {
        tasks.push({
          kind: "induce",
          host: induce.push.host,
          from: induce.push.from,
          reason: induce.push.reason,
        });
      }
    }

    const admitted: Record<string, number> = {};
    for (const task of tasks) admitted[task.kind] = (admitted[task.kind] ?? 0) + 1;
    const byReason: Record<string, number> = {};
    const examples: DnetHoldReport["examples"] = [];
    for (const refusal of refused) {
      byReason[refusal.why] = (byReason[refusal.why] ?? 0) + 1;
      if (byReason[refusal.why] === 1) examples.push(refusal);
    }
    return { tasks, report: { admitted, refused: byReason, examples } };
  };

  /** Turn the derived task list into queued jobs, filed against the host a
   * resident would have to be standing on to do them. */
  const fileWork = (at: number): Task[] => {
    const plan = planSpread(
      candidatesFrom(knowledge, at, {
        standing: new Set([selfHost, ...queues.keys()]),
        vault: new Set(vault.keys()),
        lastPlantAt,
        expiry: expiryOpts(),
      }),
      DEFAULT_SPREAD_LIMITS,
      at,
    );
    // Recorded rather than discarded: `plan.refused` is the only answer the
    // feature has to "why has the net stopped growing", and one example per
    // reason is what turns a count into somewhere to look.
    const byReason: Record<string, number> = {};
    const examples: DnetSpreadReport["examples"] = [];
    for (const refusal of plan.refused) {
      byReason[refusal.why] = (byReason[refusal.why] ?? 0) + 1;
      if (byReason[refusal.why] === 1) {
        examples.push({ host: refusal.host, why: refusal.why, detail: refusal.detail });
      }
    }
    spread = { planted: plan.plant.length, refused: byReason, examples };

    // --- the farm ---------------------------------------------------------
    //
    // Only hosts we are STANDING on: all three farm calls act on the calling
    // host, so a host with no resident has nothing to offer here whatever its
    // blocked RAM says.
    const farmHosts: FarmHost[] = [];
    for (const queue of queues.values()) {
      const host = knowledge.hosts[queue.host];
      if (!host) continue;
      const held = claims.get(queue.host) ?? [];
      const busy = new Set<FarmKind>();
      for (const claim of held) {
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
      const depth = fresh<number>(host, "depth", at, expiryOpts());
      const difficulty = fresh<number>(host, "difficulty", at, expiryOpts());
      const blockedRam = fresh<number>(host, "blockedRam", at, expiryOpts());
      farmHosts.push({
        host: queue.host,
        ...(depth !== undefined ? { depth } : {}),
        ...(difficulty !== undefined ? { difficulty } : {}),
        ...(blockedRam !== undefined ? { blockedRam } : {}),
        // What a JOB would get: the resident hands its own allocation back when
        // it spawns. `freeGb` is the resident's own measurement where it has
        // made one, and the folded facts otherwise.
        freeGb: (queue.freeGb ?? freeRam(host, at, expiryOpts())) + residentGb,
        caches: fresh<string[]>(host, "caches", at, expiryOpts()) ?? [],
        isLab: isLabyrinth(queue.host, fresh<string>(host, "modelId", at, expiryOpts())),
        ...(host.goneAt !== undefined ? { goneAt: host.goneAt } : {}),
        busy,
      });
    }
    const farmPlan = planFarm(farmHosts, {
      now: at,
      charisma,
      gbPerThread: farmGbPerThread,
      wantedGb: heaviestJobGb,
      ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
      ...(promoteSymbols.length > 0 ? { promoteSymbols } : {}),
      openLabCache,
    });
    const farmAdmitted: Record<string, number> = {};
    const farmByReason: Record<string, number> = {};
    const farmExamples: DnetFarmReport["examples"] = [];
    for (const task of farmPlan.tasks) farmAdmitted[task.kind] = (farmAdmitted[task.kind] ?? 0) + 1;
    for (const refusal of farmPlan.refused) {
      farmByReason[refusal.why] = (farmByReason[refusal.why] ?? 0) + 1;
      if (farmByReason[refusal.why] === 1) {
        farmExamples.push({ host: refusal.host, why: refusal.why, detail: refusal.detail });
      }
    }
    farm = {
      admitted: farmAdmitted,
      refused: farmByReason,
      examples: farmExamples,
      ...(farmPlan.cacheHunter !== undefined ? { cacheHunter: farmPlan.cacheHunter } : {}),
    };

    // --- what to hold, and what to push -----------------------------------
    const holdPlan = planHold(at);
    hold = holdPlan.report;

    // --- unattributed passwords -------------------------------------------
    //
    // `harvestLogs` has been collecting `--<password>--` lines all along. A
    // bare string looks useless and is not: `passwordLength` and
    // `passwordFormat` are IDENTITY facts — they are replaced only when the
    // host is — so they never expire underneath a guess in flight, and between
    // them they usually name a handful of candidates out of the whole net.
    // Each candidate is one `authenticate`, which has no penalty for being
    // wrong.
    const looseTargets: LooseTarget[] = [];
    for (const host of Object.values(knowledge.hosts)) {
      const length = fresh<number>(host, "passwordLength", at, expiryOpts());
      const format = fresh<string>(host, "passwordFormat", at, expiryOpts());
      looseTargets.push({
        hostname: host.hostname,
        ...(length !== undefined ? { passwordLength: length } : {}),
        ...(format !== undefined ? { passwordFormat: format } : {}),
        hasCredential: vault.has(host.hostname),
        ...(fresh<boolean>(host, "isStationary", at, expiryOpts()) === true ? { isStationary: true } : {}),
        ...(host.goneAt !== undefined ? { gone: true } : {}),
      });
    }
    guessFor.clear();
    const guesses: { host: string; id: string; reason: string }[] = [];
    for (const candidate of looseCandidates(loosePool, looseTargets, getPasswordType)) {
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

    // Filled in BY the derivation. The bleed gate is the one decision in
    // `deriveTasks` that used to refuse silently, so a net with nothing left to
    // overhear read exactly like a gate that had stopped working.
    const listenOut: DnetListenReport = { refused: {}, examples: [] };
    const tasks = deriveTasks(knowledge, at, {
      listenOut,
      ...expiryOpts(),
      charisma,
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
      vault: new Set(vault.keys()),
      plantable: plan.plant.map((entry) => ({ host: entry.host, from: entry.from })),
      farm: farmPlan.tasks,
      hold: holdPlan.tasks,
      ...(guesses.length > 0 ? { guesses } : {}),
    });
    listen = listenOut;
    for (const task of tasks) {
      const queue = queues.get(task.from);
      // No resident there: nothing can run it, and filing it would be a plan for
      // a machine we cannot reach.
      if (!queue) continue;
      const budget = budgets[task.kind] ?? budgets["survey"]!;
      const threads = task.threads ?? 1;
      // The resident's own allocation comes back when it spawns, so that is what
      // a job actually gets. Skipping here rather than queueing keeps a job that
      // can never fit from blocking the ones that can. `budgetGb` is PER THREAD,
      // exactly as the engine charges `ramOverride`, so the product is the cost.
      if (queue.freeGb !== undefined && budget * threads > queue.freeGb + residentGb) continue;
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
          ...(vault.has(task.host) ? { password: vault.get(task.host)! } : {}),
          ...(task.filename !== undefined ? { filename: task.filename } : {}),
          ...(task.symbol !== undefined ? { symbol: task.symbol } : {}),
          // Resolved HERE and nowhere else: the queue carried an id precisely so
          // that a pure module never had to hold a password.
          ...(task.guessId !== undefined && guessFor.has(task.guessId)
            ? { guess: guessFor.get(task.guessId)! }
            : {}),
          ...(task.kind === "plant"
            ? {
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
    }
    return tasks;
  };

  let lastBeat = bootAt;

  while (!standDown) {
    const at = Date.now();
    rendezvous.lastBeatAt = at;

    // The condition the realm exception rests on: entries are expired by the
    // controller, never trusted. A resident dies with its host, and a queue left
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

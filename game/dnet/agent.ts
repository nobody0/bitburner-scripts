import type { NS } from "@ns";
import { parseAgentMode, residentArgsFrom } from "../../shared/strategy/dnet/mission.ts";
import {
  NO_RESPAWN_KINDS,
  RESIDENT_METHODS,
  liveRendezvous,
  nextJob,
  priceAgent,
  type DnetHostQueue,
  type DnetJob,
  type DnetJobResult,
} from "./realm.ts";

/** The one thing that runs on a darknet host, in two modes.
 *
 * As a RESIDENT it beats into the overseer's queue for this host, measures
 * what is actually free, and `spawn`s into the first queued job that fits —
 * which kills it and hands the job the RAM it was holding. As a JOB it runs that
 * one job, settles the overseer's promise, and spawns back to resident mode.
 * `shared/strategy/dnet/mission.ts` owns which of the two a set of arguments
 * means; `game/dnet/realm.ts` states why the round trip is cheaper than `exec`
 * and how a session survives it.
 *
 * One file serves both modes because they differ only in that sixth argument,
 * and a second artifact differing in three lines would be one more thing to
 * sync, scp and keep versioned on every host we ever reach.
 *
 * **The one rule that binds this file:** no expensive `ns` member may be
 * REFERENCED in source. A job's cost arrives as the `ramOverride` its launcher
 * declares; a single `ns.scan` here would be charged to every resident on every
 * host we ever reach. `tests/ram-budget.test.ts` pins the four that are
 * allowed. */

/** How long resident mode waits between looks. Short enough that a job queued by
 * the overseer starts promptly; long enough that an idle net costs nothing.
 * `ns.sleep` is 0 GB. */
const RESIDENT_POLL_MS = 1_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const mode = parseAgentMode(ns.args);
  // Wrong argument shape: exit quietly rather than crashing into the game log.
  if (!mode) return;
  const generation = mode.mission.generation;

  // Priced from the game's own table rather than guessed: the engine compares
  // DYNAMIC usage against this allocation and kills the script on overrun, and
  // the simulator does not model that check — so a hand-computed number is a bug
  // that only ever shows up in a real run. `getFunctionRamCost` is 0 GB, so
  // pricing it once here and passing it down costs nothing and drifts nowhere.
  const residentGb = priceAgent(ns, RESIDENT_METHODS);

  const host = ns.getHostname();

  // The safety net that makes this process killable: an armed atExit puts a
  // resident back on the host, and the engine makes that reliable in exactly
  // the case that matters. A kill releases the concurrency lock and runs atExit
  // callbacks synchronously in the KILLER's stack before the script is marked
  // stopped — so ns is fully callable here even when the process was seconds
  // deep in a blocking `authenticate`, and `spawn` with `spawnDelay: 0` frees
  // this allocation and launches the replacement inside the same `ns.kill`
  // call. The job's own catch/finally still runs afterwards, as a zombie on a
  // microtask where every ns call throws — which is why the respawn lives HERE
  // and not in the `finally` below.
  //
  // Armed only against murder: a deliberate exit — the spawn into a job, the
  // spawn back to resident, a dead-rendezvous return — also fires atExit, and
  // an armed hook there would respawn forever. So every intentional exit path
  // disarms first.
  let deliberate = false;
  const disarm = (): void => {
    deliberate = true;
  };
  const armExit = (cleanup?: () => void): void => {
    ns.atExit(() => {
      if (deliberate) return;
      cleanup?.();
      // A host-DELETE mutation kills us too, and there is no host to respawn
      // on: the engine's spawn would throw out of atExit into an error dialog.
      // getServerMaxRam is in every armed budget and throws cheaply on a host
      // that no longer exists.
      try {
        ns.getServerMaxRam(host);
      } catch {
        return;
      }
      ns.spawn(
        ns.getScriptName(),
        { threads: 1, spawnDelay: 0, ramOverride: residentGb, temporary: true },
        ...residentArgsFrom(ns.args),
      );
    }, "dnet-respawn");
  };

  if (mode.kind === "job") {
    // No overseer, or one from a world this run no longer shares. Exit rather
    // than freelancing: without the queue there is nothing to coordinate with,
    // and two uncoordinated agents would spend the same calls on the same hosts.
    const rendezvous = liveRendezvous(generation);
    if (!rendezvous) return;
    // The job settles into the queue it was spawned from. If the overseer was
    // replaced mid-job the promise it kept died with it, and the respawned
    // resident below re-registers with whatever is live.
    const queue = ensureQueue(rendezvous.queues, host);
    queue.residentPid = undefined;
    await performJob(ns, queue, mode.jobId, residentGb, armExit, disarm);
    return;
  }

  // A resident killed by a host-RESTART mutation (killall runs atExit too)
  // self-revives on the restarted host; on a DELETE the guard above declines.
  // The cleanup reads the LIVE rendezvous inside the callback, never a binding
  // held across the loop's sleep, for the same reason the loop itself does.
  armExit(() => {
    const live = liveRendezvous(generation);
    const queue = live?.queues.get(host);
    if (!queue) return;
    if (queue.residentPid === ns.pid) queue.residentPid = undefined;
    queue.lastBeatAt = Date.now();
  });

  for (;;) {
    // Resolved from the LIVE rendezvous every pass, never bound at boot and
    // never held across the sleep below. An overseer dies with its host, a
    // prestige changes the generation outright, and a replacement overseer of
    // the same generation installs a fresh queues Map — a resident still beating
    // into the old one would pass every check while being invisible to the
    // overseer that is actually running. Nothing else will ever clean this
    // process up either: `reclaimFleet` walks the ordinary `ns.scan` snapshot,
    // which never contains a darknet host.
    const live = liveRendezvous(generation);
    if (!live) {
      disarm();
      return;
    }
    const queue = ensureQueue(live.queues, host);

    queue.residentPid = ns.pid;
    queue.lastBeatAt = Date.now();
    // Measured every pass, not cached: out here free RAM moves without warning
    // when the owner's blocked processes shift.
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    queue.freeGb = free;
    // What will be free once THIS process dies is what a job actually gets.
    const job = nextJob(queue, free + residentGb);
    if (job) {
      const refused = preflightJob(ns, job);
      if (refused) {
        queue.pending = queue.pending.filter((entry) => entry !== job);
        job.settle(refused);
        continue;
      }
      queue.pending = queue.pending.filter((entry) => entry !== job);
      queue.active = job;
      job.startedAt = Date.now();
      queue.residentPid = undefined;
      // Kills this process and starts the job immediately on this host, with the
      // allocation the overseer sized for it. `ramOverride` is charged PER
      // THREAD, so the pair is `(job.threads, job.budgetGb)` and the fit check
      // above compares their product — a hardcoded `threads: 1` here would have
      // quietly ignored every thread count a planner asked for.
      disarm();
      ns.spawn(
        ns.getScriptName(),
        { threads: job.threads, spawnDelay: 0, ramOverride: job.budgetGb, temporary: true },
        ...residentArgsFrom(ns.args),
        job.id,
      );
      return;
    }
    await ns.sleep(RESIDENT_POLL_MS);
  }
}

/** This host's queue, creating it if the overseer has not seen this host
 * before. Creating it here IS the registration: the overseer discovers a
 * resident by finding its queue, so a planted agent announces itself simply by
 * starting. */
function ensureQueue(queues: Map<string, DnetHostQueue>, host: string): DnetHostQueue {
  const existing = queues.get(host);
  if (existing) return existing;
  const created: DnetHostQueue = {
    host,
    pending: [],
    lastBeatAt: Date.now(),
    completed: 0,
    failed: 0,
  };
  queues.set(host, created);
  return created;
}

/** Check the edge and lifetime identity immediately before surrendering the
 * resident to `spawn`. `probe(true)` is shuffled, but membership is all we
 * need: the expected IP must still be one of this vantage's neighbours. */
export function preflightJob(ns: NS, job: DnetJob): DnetJobResult | undefined {
  const state = job.state;
  if (state.from === state.host || state.sessionOnly === true || job.kind === 'survey') return undefined;
  const names = ns["dnet"]["probe"]();
  if (!names.includes(state.host)) {
    return { ok: false, targetState: 'edge-lost', detail: `${state.host} is no longer adjacent to ${state.from}` };
  }
  if (state.targetIdentity !== undefined) {
    const identities = ns["dnet"]["probe"](true);
    if (!identities.includes(state.targetIdentity)) {
      return { ok: false, targetState: 'replaced', detail: `${state.host} was replaced before ${job.kind}` };
    }
  }
  return undefined;
}

/** Run one job, settle its promise, and hand the host back to a resident.
 *
 * The `finally` matters more than the try: whatever happens, the host must end
 * up with a resident again, because nothing outside can put one there. */
async function performJob(
  ns: NS,
  queue: DnetHostQueue,
  jobId: string,
  residentGb: number,
  armExit: (cleanup?: () => void) => void,
  disarm: () => void,
): Promise<void> {
  const job: DnetJob | undefined = queue.active?.id === jobId
    ? queue.active
    : queue.pending.find((entry) => entry.id === jobId);
  if (!job) {
    // The overseer retired the job while we were being launched. Go straight
    // back to resident mode rather than leaving the host empty. Nothing is
    // armed yet, but respawnResident's spawn fires atExit — disarm regardless.
    disarm();
    respawnResident(ns, residentGb);
    return;
  }
  // Murder is settled HERE, synchronously inside the killer's `ns.kill`, not
  // in the catch/finally below: those still run afterwards, but as a zombie
  // continuation in which every ns call throws. `murdered` is what tells them
  // the books are already closed — without it the zombie would double-count
  // the failure and stomp whatever the respawned resident put in
  // `queue.active` next. A hard cancel counts as COMPLETED, like a cooperative
  // one: the job settled with a result; `failed` stays for genuine errors.
  let murdered = false;
  if (!NO_RESPAWN_KINDS.includes(job.kind)) {
    armExit(() => {
      murdered = true;
      job.pid = undefined;
      if (queue.active === job) queue.active = undefined;
      queue.lastBeatAt = Date.now();
      queue.completed++;
      job.settle({
        ok: false,
        targetState: "cancelled",
        detail: job.cancelReason ?? "killed mid-call",
      });
    });
    // The overseer's licence to hard-kill: only a job that PROVED it has the
    // respawn hook may be murdered. A pin never sets it; nor does an agent
    // build older than the hook.
    job.armored = true;
  }
  try {
    // The beat is what a LONG-LIVED job uses to say it is still going. A short
    // job never calls it and does not need to: it is vouched for by
    // `startedAt + JOB_TIMEOUT_MS`. A long one is skipped by the overseer's
    // timeout loop entirely, so without this its queue would be pinned open for
    // ever by a process that died with its host.
    job.pid = ns.pid;
    const result = await job.body(ns, job.state, (progress) => {
      job.beatAt = Date.now();
      // Carried rather than replaced wholesale, so a body that beats without a
      // payload does not erase the last position it reported.
      if (progress !== undefined) job.progress = progress;
    }, () => job.cancelReason);
    queue.completed++;
    job.settle(result);
  } catch (error) {
    if (murdered) return;
    queue.failed++;
    queue.lastError = `${job.kind}: ${String(error)}`.slice(0, 200);
    job.fail(error);
  } finally {
    // A murdered job's books were closed by the atExit cleanup, and its
    // resident is already back: this zombie must touch nothing.
    if (!murdered) {
      job.pid = undefined;
      queue.active = undefined;
      queue.lastBeatAt = Date.now();
      disarm();
      // Almost always: whatever happened, the host must end up with a resident,
      // because nothing outside can put one there.
      //
      // The exception is a job whose ALLOCATION does not include `spawn`, and
      // there is exactly one — the stasis pin, at 12 GB for `setStasisLink`
      // alone, which does not fit a 16 GB host with the 2.0 GB spawn back on top
      // of it. Calling `spawn` from a process that did not budget for it is not a
      // slow path, it is a dead one: the engine's dynamic RAM check kills the
      // script on the call. So the process simply ends and leaves the host empty
      // — which the overseer only ever asks for on a host a neighbour can
      // re-plant, and which is safe precisely because the pin just made the host
      // immutable.
      if (!NO_RESPAWN_KINDS.includes(job.kind)) respawnResident(ns, residentGb);
    }
  }
}

/** Back to resident mode. This is the last thing a job process does, and it does
 * not return: `spawn` kills the caller. */
function respawnResident(ns: NS, residentGb: number): void {
  ns.spawn(
    ns.getScriptName(),
    { threads: 1, spawnDelay: 0, ramOverride: residentGb, temporary: true },
    ...residentArgsFrom(ns.args),
  );
}

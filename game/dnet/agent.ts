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

  if (mode.kind === "job") {
    // No overseer, or one from a world this run no longer shares. Exit rather
    // than freelancing: without the queue there is nothing to coordinate with,
    // and two uncoordinated agents would spend the same calls on the same hosts.
    const rendezvous = liveRendezvous(generation);
    if (!rendezvous) return;
    // The job settles into the queue it was spawned from. If the overseer was
    // replaced mid-job the promise it kept died with it, and the respawned
    // resident below re-registers with whatever is live.
    await performJob(ns, ensureQueue(rendezvous.queues, host), mode.jobId, residentGb);
    return;
  }

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
    if (!live) return;
    const queue = ensureQueue(live.queues, host);

    queue.lastBeatAt = Date.now();
    // Measured every pass, not cached: out here free RAM moves without warning
    // when the owner's blocked processes shift.
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    queue.freeGb = free;
    // What will be free once THIS process dies is what a job actually gets.
    const job = nextJob(queue, free + residentGb);
    if (job) {
      queue.pending = queue.pending.filter((entry) => entry !== job);
      queue.active = job;
      job.startedAt = Date.now();
      // Kills this process and starts the job immediately on this host, with the
      // allocation the overseer sized for it. `ramOverride` is charged PER
      // THREAD, so the pair is `(job.threads, job.budgetGb)` and the fit check
      // above compares their product — a hardcoded `threads: 1` here would have
      // quietly ignored every thread count a planner asked for.
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

/** Run one job, settle its promise, and hand the host back to a resident.
 *
 * The `finally` matters more than the try: whatever happens, the host must end
 * up with a resident again, because nothing outside can put one there. */
async function performJob(
  ns: NS,
  queue: DnetHostQueue,
  jobId: string,
  residentGb: number,
): Promise<void> {
  const job: DnetJob | undefined = queue.active?.id === jobId
    ? queue.active
    : queue.pending.find((entry) => entry.id === jobId);
  if (!job) {
    // The overseer retired the job while we were being launched. Go straight
    // back to resident mode rather than leaving the host empty.
    respawnResident(ns, residentGb);
    return;
  }
  try {
    // The beat is what a LONG-LIVED job uses to say it is still going. A short
    // job never calls it and does not need to: it is vouched for by
    // `startedAt + JOB_TIMEOUT_MS`. A long one is skipped by the overseer's
    // timeout loop entirely, so without this its queue would be pinned open for
    // ever by a process that died with its host.
    const result = await job.body(ns, job.state, (progress) => {
      job.beatAt = Date.now();
      // Carried rather than replaced wholesale, so a body that beats without a
      // payload does not erase the last position it reported.
      if (progress !== undefined) job.progress = progress;
    });
    queue.completed++;
    job.settle(result);
  } catch (error) {
    queue.failed++;
    queue.lastError = `${job.kind}: ${String(error)}`.slice(0, 200);
    job.fail(error);
  } finally {
    queue.active = undefined;
    queue.lastBeatAt = Date.now();
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

/** Back to resident mode. This is the last thing a job process does, and it does
 * not return: `spawn` kills the caller. */
function respawnResident(ns: NS, residentGb: number): void {
  ns.spawn(
    ns.getScriptName(),
    { threads: 1, spawnDelay: 0, ramOverride: residentGb, temporary: true },
    ...residentArgsFrom(ns.args),
  );
}

import type { NS } from "@ns";
import { jobIdFrom, parseWorkerArgs } from "../../shared/strategy/dnet/mission.ts";
import {
  RESIDENT_METHODS,
  dnetRealm,
  nextJob,
  priceAgent,
  type DnetHostQueue,
  type DnetJob,
} from "./realm.ts";

/** The one thing that runs on a darknet host, in two modes.
 *
 * `game/lib/dodge-stub.ts` is the model, with one difference worth stating: the
 * stub imports no VALUES at all, because its cost must stay at exactly the
 * 1.6 GB base. This file may import pure helpers — they cost nothing — but it
 * must reference no expensive `ns` member, because a job's real cost arrives as
 * the `ramOverride` its launcher declares. A single `ns.scan` in this file would
 * be charged to every resident on every host we ever reach.
 *
 * One file serves both modes because they differ only in whether `ns.args`
 * carries a job id, and a second artifact differing in three lines would be one
 * more thing to sync, scp and keep versioned everywhere.
 *
 * ## Resident mode — `agent.js <missionId> <generation> <identity> <role> <agentId>`
 *
 * Sits on the host and does nothing expensive. Every loop it beats into the
 * controller's queue for this host, measures what is actually free, and asks
 * whether the next queued job fits. When one does it `spawn`s into it with
 * `spawnDelay: 0` — which KILLS this process and starts the job immediately on
 * the same host, so the job gets the RAM the resident was holding.
 *
 * ## Job mode — the same, plus a sixth argument: the job id
 *
 * Runs exactly one job with the allocation the resident declared, settles the
 * controller's promise, and spawns back to resident mode.
 *
 * ## Why the round trip, rather than exec
 *
 * A resident that `exec`'d its jobs would stay alive alongside them, so the host
 * would need `(1.6 + 1.3) + (1.6 + calls)`. Spawning costs 2.0 against exec's
 * 1.3 but frees the caller first, so the host needs
 * `max(resident, 1.6 + calls + 2.0)`. That is a real saving on the heavy jobs
 * and the difference between running and not running on a host whose owner has
 * blocked most of its RAM.
 *
 * The spawn back is not optional and is the expensive half of the tax. It is
 * still the cheap option, because a host left with no resident cannot be
 * repaired from outside: planting one needs a session AND adjacency, and the
 * controller has neither to anything but `darkweb`.
 *
 * ## The thing that looks impossible
 *
 * A session belongs to the PID that won it, and `spawn` ends the PID — so a job
 * that authenticates cannot hand its session onward. `connectToSession` buys it
 * back at any distance for 0.05 GB, which is why the queue carries passwords and
 * why this design works at all. See `game/dnet/realm.ts`. */

/** The resident's own arguments, which every spawn carries forward unchanged. A
 * job adds its id as a sixth; going back to resident mode drops it again. */
const RESIDENT_ARG_COUNT = 5;

/** How long resident mode waits between looks. Short enough that a job queued by
 * the controller starts promptly; long enough that an idle net costs nothing.
 * `ns.sleep` is 0 GB. */
const RESIDENT_POLL_MS = 1_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const mission = parseWorkerArgs(ns.args);
  // Wrong argument shape: exit quietly rather than crashing into the game log.
  if (!mission) return;

  const realm = dnetRealm();
  const rendezvous = realm.dnet_overseer;
  // No controller, or one from a world this run no longer shares. Exit rather
  // than freelancing: without the queue there is nothing to coordinate with, and
  // two uncoordinated agents would spend the same calls on the same hosts.
  if (!rendezvous || rendezvous.generation !== mission.generation) return;

  const host = ns.getHostname();
  const jobId = jobIdFrom(ns.args);

  if (jobId !== undefined) {
    // The job settles into the queue it was spawned from. If the controller was
    // replaced mid-job the promise it kept died with it, and the respawned
    // resident below re-registers with whatever is live.
    await performJob(ns, ensureQueue(rendezvous.queues, host), jobId);
    return;
  }

  // --- resident mode -------------------------------------------------------
  // Priced from the game's own table rather than guessed: the engine compares
  // DYNAMIC usage against this allocation and kills the script on overrun, and
  // the simulator does not model that check — so a hand-computed number is a bug
  // that only ever shows up in a real run.
  const residentGb = priceAgent(ns, RESIDENT_METHODS);
  for (;;) {
    // Re-checked every pass, not just at boot. A controller dies with its host
    // and a prestige changes the generation outright, and neither is something a
    // resident can be told: `reclaimFleet` walks the ordinary `ns.scan`
    // snapshot, which never contains a darknet host, so nothing else will ever
    // clean this process up. Without this it holds its RAM for the rest of the
    // session, on a host whose queue no longer exists.
    const live = dnetRealm().dnet_overseer;
    if (!live || live.generation !== mission.generation) return;
    // The queue is resolved from the LIVE rendezvous every pass, not bound at
    // boot. A replacement controller of the same generation — darkweb reboots,
    // home re-seeds — installs a fresh rendezvous with a fresh queues Map, and a
    // resident still beating into the old one would pass the generation check
    // above while being invisible to the new controller for ever.
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
      // allocation the controller sized for it.
      ns.spawn(
        ns.getScriptName(),
        { threads: 1, spawnDelay: 0, ramOverride: job.budgetGb, temporary: true },
        ...(ns.args.slice(0, RESIDENT_ARG_COUNT) as (string | number)[]),
        job.id,
      );
      return;
    }
    await ns.sleep(RESIDENT_POLL_MS);
  }
}

/** This host's queue, creating it if the controller has not seen this host
 * before. Creating it here IS the registration: the controller discovers a
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
async function performJob(ns: NS, queue: DnetHostQueue, jobId: string): Promise<void> {
  const job: DnetJob | undefined = queue.active?.id === jobId
    ? queue.active
    : queue.pending.find((entry) => entry.id === jobId);
  if (!job) {
    // The controller retired the job while we were being launched. Go straight
    // back to resident mode rather than leaving the host empty.
    respawnResident(ns);
    return;
  }
  try {
    const result = await job.body(ns, job.state);
    queue.completed++;
    job.settle(result);
  } catch (error) {
    queue.failed++;
    queue.lastError = `${job.kind}: ${String(error)}`.slice(0, 200);
    job.fail(error);
  } finally {
    queue.active = undefined;
    queue.lastBeatAt = Date.now();
    respawnResident(ns);
  }
}

/** Back to resident mode. This is the last thing a job process does, and it does
 * not return: `spawn` kills the caller. */
function respawnResident(ns: NS): void {
  ns.spawn(
    ns.getScriptName(),
    { threads: 1, spawnDelay: 0, ramOverride: priceAgent(ns, RESIDENT_METHODS), temporary: true },
    ...(ns.args.slice(0, RESIDENT_ARG_COUNT) as (string | number)[]),
  );
}

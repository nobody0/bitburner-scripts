import type { NS } from "@ns";
import { realmSleep } from "../lib/wake.ts";
import { captureLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch } from "./launch.ts";
import {
  JOB_TIMEOUT_MS,
  NO_RESPAWN_KINDS,
  RESIDENT_METHODS,
  liveRendezvous,
  nextJob,
  priceAgent,
  waitForQueueWork,
  type DnetHostQueue,
  type DnetJob,
  type DnetJobResult,
} from "./realm.ts";

/** The one thing that runs on a darknet host, in two modes.
 *
 * As a RESIDENT it beats into the overseer's queue and `spawn`s into the next
 * job the controller already sized for this host. As a JOB it runs that work,
 * settles it, then atExit spawns directly into the next job or an idle resident.
 * The live host queue selects resident versus job mode; `game/dnet/realm.ts`
 * states why the round trip is cheaper than `exec` and how a session survives it.
 *
 * One file serves both modes because the queue already holds the distinction;
 * a second artifact would only duplicate the deployed process shell.
 *
 * **The one rule that binds this file:** no expensive `ns` member may be
 * REFERENCED in source. A job's cost arrives as the `ramOverride` its launcher
 * declares; a single `ns.scan` here would be charged to every resident on every
 * host we ever reach. `tests/ram-budget.test.ts` pins the four that are
 * allowed. */

/** How long resident mode waits between looks. Short enough that a job queued by
 * the overseer starts promptly; long enough that an idle net costs nothing.
 * The wait is a realm timer, so it costs no RAM and holds no Netscript lock. */
const RESIDENT_POLL_MS = 1_000;

/** How long a freshly-launched resident waits for its co-launched overseer to
 * register before concluding there is none. The overseer registers within an
 * engine cycle of starting, so this only ever spans the launch race — but it is
 * generous against a paused or lag-stalled game. It is safely inside home's
 * post-seed re-launch backoff, so no second resident can be seeded during it. */
const OVERSEER_STARTUP_GRACE_MS = 15_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetAgentLaunch>("dnet-agent");
  const hostArg = typeof ns.args[0] === "string" ? ns.args[0] : undefined;
  const host = launch?.host ?? hostArg;
  // Wrong argument shape: exit quietly rather than crashing into the game log.
  if (!host) return;
  const rendezvousNow = () => liveRendezvous();

  // A host that cannot yet fit the ordinary 1.8 GB prober + 3.6 GB resident
  // runs this deliberately tiny mode. Every byte is action threads: no probe,
  // no details read and no spawn safety net. Once it stops, the overseer reads
  // fresh details immediately and either retries or plants the ordinary pair.
  if (launch?.bootstrapReclaim === true) {
    const finish = (): void => {
      const live = liveRendezvous();
      const held = live?.bootstraps.get(host);
      if (held?.pid === ns.pid) live!.bootstraps.delete(host);
      live?.bootstrapDone.add(host);
      live?.signalDerive?.();
    };
    ns.atExit(finish, "dnet-bootstrap-reclaim");
    try {
      const live = liveRendezvous();
      if (!live) return;
      live.bootstraps.set(host, { pid: ns.pid, lastBeatAt: Date.now() });
      // Exactly one call per launch. Its completion wakes the controller, which
      // refreshes blocked RAM and relaunches at floor(newFree / 2.6) threads.
      // That makes the bootstrap upscale as RAM opens without charging every
      // action thread for getServerDetails + spawn.
      await ns["dnet"]["memoryReallocation"](host);
    } finally {
      finish();
    }
    return;
  }
  const jobId = rendezvousNow()?.queues.get(host)?.active?.id;

  // Priced from the game's own table rather than guessed: the engine compares
  // DYNAMIC usage against this allocation and kills the script on overrun, and
  // the simulator does not model that check — so a hand-computed number is a bug
  // that only ever shows up in a real run. `getFunctionRamCost` is 0 GB, so
  // pricing it once here and passing it down costs nothing and drifts nowhere.
  const residentGb = priceAgent(ns, RESIDENT_METHODS);

  // Captured from the launch descriptor, or carried as the sole self-spawn
  // argument. The launching process already knows the host.
  // The safety net that makes this process killable: an armed atExit puts a
  // resident back on the host, and the engine makes that reliable in exactly
  // the case that matters. A kill releases the concurrency lock and runs atExit
  // callbacks synchronously in the KILLER's stack before the script is marked
  // stopped — so ns is fully callable here even when the process was seconds
  // deep in a blocking `authenticate`, and `spawn` with `spawnDelay: 0` frees
  // this allocation and launches the replacement inside the same `ns.kill`
  // call. The job's own catch can still run afterwards, as a zombie on a
  // microtask where every ns call throws — which is why the respawn lives HERE
  // and not after the awaited body.
  //
  // A resident disarms before spawning into a job. An ordinary job deliberately
  // stays armed through a clean return: after its result clears the active slot,
  // atExit selects the next queued job or a resident. Only terminal exits disarm.
  let deliberate = false;
  const disarm = (): void => {
    deliberate = true;
  };
  const armExit = (cleanup?: () => boolean | void): void => {
    ns.atExit(() => {
      if (deliberate) return;
      // A movable-host restart/delete is performed by a LIVE Map iteration in
      // v3.0.1. Inserting a zero-delay replacement from that callback makes the
      // same iterator kill it again. Only natural completion, a controller-
      // marked kill may self-handoff here.
      if (cleanup?.() === false) return;
      // The respawn, wrapped rather than pre-checked. `spawn` with `spawnDelay: 0`
      // runs its server check SYNCHRONOUSLY (NetscriptFunctions.ts `spawnCb`) and
      // THROWS "Cannot find server" before launching anything if this host was
      // DELETED out from under us — the one case we must not respawn into. Catching
      // that is exactly as safe as the old `getServerMaxRam` pre-check and costs no
      // billable member, so the resident's whole surface is now `spawn`. The catch
      // also swallows the ScriptDeath `spawn` throws on SUCCESS, which is harmless
      // in an atExit that is already exiting; a live host still relaunches cleanly.
      try {
        const live = rendezvousNow();
        const queue = live?.queues.get(host);
        const next = queue ? nextJob(queue) : undefined;
        if (queue && next) {
          queue.pending = queue.pending.filter((entry) => entry !== next);
          queue.active = next;
          next.startedAt = Date.now();
          if (next.longLived) delete next.expectedDoneAt;
          else next.expectedDoneAt = next.startedAt + JOB_TIMEOUT_MS;
          queue.residentPid = undefined;
          ns.spawn(
            ns.getScriptName(),
            temporaryRunOptions({ threads: next.threads, spawnDelay: 0, ramOverride: next.budgetGb }),
            host,
          );
        } else {
          ns.spawn(
            ns.getScriptName(),
            temporaryRunOptions({ threads: 1, spawnDelay: 0, ramOverride: residentGb }),
            host,
          );
        }
      } catch {
        // Host gone → no replacement, no dialog. Or the normal post-spawn
        // ScriptDeath → nothing after this needs to run anyway.
      }
    }, "dnet-respawn");
  };

  // A death report WITHOUT a respawn, for a NO_RESPAWN kind that still wants to
  // settle the instant it is killed rather than wait out the overseer's
  // beat-timeout sweep — the lab walker, which holds its host for hours. It is
  // spawn-free (the freed host is re-planted by `planSpread`), so it needs no
  // `spawn` in its budget; that is the whole point of stripping the walk's spawn.
  const settleExit = (cleanup: () => void): void => {
    ns.atExit(() => {
      if (deliberate) return;
      cleanup();
    }, "dnet-settle");
  };

  if (jobId !== undefined) {
    // No overseer, or one from a world this run no longer shares. Exit rather
    // than freelancing: without the queue there is nothing to coordinate with,
    // and two uncoordinated agents would spend the same calls on the same hosts.
    const rendezvous = rendezvousNow();
    if (!rendezvous) return;
    // The job settles into the queue it was spawned from. If the overseer was
    // replaced mid-job the promise it kept died with it, and the respawned
    // resident below re-registers with whatever is live.
    const queue = ensureQueue(rendezvous.queues, host);
    queue.residentPid = undefined;
    await performJob(ns, queue, jobId, host, residentGb, armExit, settleExit, disarm);
    return;
  }

  // A resident killed by a host restart/delete reports its loss but deliberately
  // does not insert a replacement into the engine's live killall iterator. The
  // controller sees the cleared PID synchronously and replants from a survivor.
  // The cleanup reads the LIVE rendezvous inside the callback, never a binding
  // held across the loop's sleep, for the same reason the loop itself does.
  armExit(() => {
    const live = rendezvousNow();
    const queue = live?.queues.get(host);
    if (!queue) return false;
    if (queue.residentPid === ns.pid) queue.residentPid = undefined;
    queue.lastBeatAt = Date.now();
    live?.signalDerive?.();
    return false;
  });

  // Home launches the resident ALONGSIDE its overseer, in one seed. If the
  // resident wins that launch race it reaches the check below before the
  // overseer has assigned `realm.dnet_overseer`, so a missing rendezvous right
  // after our own start is "the overseer is still booting", not "there is no
  // overseer". Exiting on it — as this once did — dropped the resident on the
  // spot, and home, having seen both execs return a pid, counted the seed a
  // success and did not re-launch the resident until its ~30 s backoff elapsed:
  // the darkweb agent appeared half a minute late while the overseer sat there
  // alone. So a resident that has NEVER seen its overseer waits a bounded grace
  // for the co-launched one to register.
  //
  // The grace is startup-only. Once we HAVE registered with an overseer, a
  // later disappearance is a real death (a crash, a re-seed), and we must exit
  // at once so home's replacement is the only resident — a lingering poller
  // would re-register into the replacement's fresh queues Map and double the
  // host. `sawOverseer` is exactly that latch.
  const startupAt = Date.now();
  let sawOverseer = false;
  for (;;) {
    // Resolved from the LIVE rendezvous every pass, never bound at boot and
    // never held across the sleep below. An overseer dies with its host, a
    // prestige changes the generation outright, and a replacement overseer of
    // the same generation installs a fresh queues Map — a resident still beating
    // into the old one would pass every check while being invisible to the
    // overseer that is actually running. Nothing else will ever clean this
    // process up either: `reclaimFleet` walks the ordinary `ns.scan` snapshot,
    // which never contains a darknet host.
    const live = rendezvousNow();
    if (!live) {
      // Exit at once if we ever saw an overseer (real death), or if the startup
      // grace has elapsed with none appearing (a genuinely dead run). Otherwise
      // keep waiting for the co-launched overseer to finish booting.
      if (sawOverseer || Date.now() - startupAt >= OVERSEER_STARTUP_GRACE_MS) {
        disarm();
        return;
      }
      await realmSleep(RESIDENT_POLL_MS);
      continue;
    }
    sawOverseer = true;
    const queue = ensureQueue(live.queues, host);

    queue.residentPid = ns.pid;
    queue.lastBeatAt = Date.now();
    // The worker no longer measures RAM: the overseer sized every filed job to
    // fit `maxRam − blockedRam − prober` for this host (it reads those facts
    // itself, off darkweb, and holds the prober's reserve constant), so the
    // resident just takes the next job it was handed. This is what keeps a host
    // to exactly two of our scripts — the prober and this worker — with no third
    // measurement process and no free-RAM round-trip through the rendezvous.
    const job = nextJob(queue);
    if (job) {
      // No preflight `probe` here any more: the OVERSEER owns adjacency (its
      // probers refresh every host's neighbours every mutation) and only files a
      // job against an edge it believes current. If the edge went stale in the
      // gap, the job body's own connect/authenticate fails with `edge-lost` /
      // `replaced` and the overseer retries — the same verdict preflight produced,
      // one spawn later, in exchange for keeping `dnet.probe` off every resident.
      queue.pending = queue.pending.filter((entry) => entry !== job);
      queue.active = job;
      job.startedAt = Date.now();
      if (job.longLived) delete job.expectedDoneAt;
      else job.expectedDoneAt = job.startedAt + JOB_TIMEOUT_MS;
      queue.residentPid = undefined;
      // Kills this process and starts the job immediately on this host, with the
      // allocation the overseer sized for it. `ramOverride` is charged PER
      // THREAD, so the pair is `(job.threads, job.budgetGb)` and the fit check
      // above compares their product — a hardcoded `threads: 1` here would have
      // quietly ignored every thread count a planner asked for.
      disarm();
      ns.spawn(
        ns.getScriptName(),
        temporaryRunOptions({ threads: job.threads, spawnDelay: 0, ramOverride: job.budgetGb }),
        host,
      );
      return;
    }
    // Idle: wait for the overseer to file work here, waking the INSTANT it does
    // rather than after a full poll — a job no longer sits queued while its
    // target mutates out from under it. `RESIDENT_POLL_MS` is the fallback, and
    // it is still the heartbeat: every fallback wake re-beats, re-measures RAM,
    // re-checks the rendezvous and touches ns (so a kill lands within one
    // interval), which is why it stays well under the sweep window and is not
    // lengthened by the wake. Realm timer inside, so no Netscript lock is held.
    await waitForQueueWork(queue, RESIDENT_POLL_MS);
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

/** Run one job and close its queue entry before atExit selects the successor. */
async function performJob(
  ns: NS,
  queue: DnetHostQueue,
  jobId: string,
  host: string,
  residentGb: number,
  armExit: (cleanup?: () => boolean | void) => void,
  settleExit: (cleanup: () => void) => void,
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
    respawnResident(ns, host, residentGb);
    return;
  }
  // Murder is settled HERE, synchronously inside the killer's `ns.kill`, not
  // in the catch below: it can still run afterwards, but as a zombie
  // continuation in which every ns call throws. `murdered` is what tells them
  // the books are already closed — without it the zombie would double-count
  // the failure and stomp whatever the respawned resident put in
  // `queue.active` next. A hard cancel counts as COMPLETED, like a cooperative
  // one: the job settled with a result; `failed` stays for genuine errors.
  let murdered = false;
  let finished = false;
  const settleOnMurder = (): boolean => {
    // A clean return also fires atExit. In that case the callback still owns
    // the same-tick handoff below, but the completed job's books are already
    // closed and must not be settled or counted a second time.
    if (finished) return true;
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
    return job.cancelReason !== undefined;
  };
  const respawns = !NO_RESPAWN_KINDS.includes(job.kind);
  if (respawns) {
    // Ordinary kinds settle-and-respawn in one atExit: the host must end up with
    // a resident, and only this process can put one there.
    armExit(settleOnMurder);
    job.armored = true;
  } else if (job.kind === "walk" || job.kind === "pin") {
    // The lab walker is NO_RESPAWN — its host is re-planted, not respawned — but
    // it is long-lived, so it still reports its death the instant it is killed
    // rather than waiting out the overseer's beat sweep. Spawn-free, so it needs
    // no `spawn` in its 1.8-GB-free budget. A clean completion settles below with
    // `ok: true`; this fires only on an UNINTENDED kill (a host restart).
    settleExit(settleOnMurder);
  }
  // Pin and walk remain spawn-free for their RAM constraints, but they still
  // always run an atExit settlement callback. They are never hard-cancelled;
  // a host death is reported immediately and re-planting stays controller-owned.
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
    finished = true;
    job.pid = undefined;
    if (queue.active === job) queue.active = undefined;
    queue.lastBeatAt = Date.now();
    queue.completed++;
    job.settle(result);
    if (!respawns) disarm();
  } catch (error) {
    if (murdered) return;
    finished = true;
    job.pid = undefined;
    if (queue.active === job) queue.active = undefined;
    queue.lastBeatAt = Date.now();
    queue.failed++;
    queue.lastError = `${job.kind}: ${String(error)}`.slice(0, 200);
    job.fail(error);
    if (!respawns) disarm();
  }
}

/** Back to resident mode. This is the last thing a job process does, and it does
 * not return: `spawn` kills the caller. */
function respawnResident(ns: NS, host: string, residentGb: number): void {
  ns.spawn(
    ns.getScriptName(),
    temporaryRunOptions({ threads: 1, spawnDelay: 0, ramOverride: residentGb }),
    host,
  );
}

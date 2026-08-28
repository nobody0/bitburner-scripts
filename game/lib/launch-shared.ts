/** Realm-global handoff for scripts launched by another script.
 *
 * The parent publishes a live descriptor under the launch id it is about to
 * pass the child as its one argument; the child looks that id up at the top of
 * main() and acknowledges the capture before doing any work.
 *
 * Nothing here serializes. Descriptors used to share ONE realm slot, which
 * meant a launch had to hold a FIFO from publish until the child had booted
 * and read it — and a child cannot boot inside its parent's turn, so every
 * exec in the whole automation queued behind one engine cycle each. A darknet
 * vantage opening a frontier of five paid ten of them in a row. Keying by
 * launch id removes the shared slot and with it the reason to queue: each
 * child can only ever find its own descriptor, so launches overlap freely.
 *
 *
 * This is the focused worker handoff used by bitburner-2024@master (dc0720b),
 * servers/home/scripts/worker.ts and imports/batchRunner.ts. */

export interface ScriptLaunch {
  readonly kind: string;
}

interface PendingLaunch {
  descriptor: ScriptLaunch;
  acknowledge: () => void;
}

interface LaunchGlobals {
  /** Live descriptors awaiting capture, by the launch id the child is given. */
  spawning_scripts?: Map<number, PendingLaunch>;
  script_launch_id?: number;
}

type LaunchGlobalThis = typeof globalThis & LaunchGlobals;

const launchGlobal = (): LaunchGlobalThis => globalThis as LaunchGlobalThis;

/** Options shared by every automation-owned exec/spawn/run. Temporary scripts
 * are omitted from the save's completed-script history, and duplicate checks
 * are skipped because every launch already has a unique handoff id. */
export function temporaryRunOptions<T extends object>(
  options: T,
): T & { temporary: true; preventDuplicates: false } {
  return { ...options, temporary: true, preventDuplicates: false };
}

/** A PID without a capture is not a successful launch. A stale helper bundle,
 * a load failure or a child killed before its first line leaves a descriptor
 * nobody will ever claim, and the launcher is waiting on it — this is how long
 * it waits before calling that a failed launch. It no longer holds anyone
 * else's exec behind it; only its own caller's. */
export const LAUNCH_CAPTURE_TIMEOUT_MS = 1_000;

/** Why a `handoffLaunch` returned 0. The two cases need OPPOSITE recovery:
 * a refused exec started nothing and may be retried, while an uncaptured
 * child is already running and holding its RAM — retrying that one stacks a
 * second process on the host instead of replacing the first. */
export interface LaunchOutcome {
  /** `start` itself returned 0: the engine refused the exec outright. */
  refused?: boolean;
  /** The child started but never captured its descriptor in time. */
  uncaptured?: boolean;
}

/** Publish a descriptor and hand back its id, WITHOUT waiting to be captured.
 *
 * `handoffLaunch` waits for the child's acknowledgement so it can tell a
 * refused exec from a child that started and died before its first line. That
 * wait makes it async, and the darknet controller launches from inside
 * synchronous paths — `fileWork`, and the plant's own stack — which cannot
 * await anything.
 *
 * It does not need to. The child's `adopt` IS the acknowledgement: a worker
 * that never adopts leaves the host with a placing window whose pid the engine
 * reports as gone, which the controller already reaps by fact. So the caller
 * takes the id, execs, and either the launch is claimed or `withdraw` puts the
 * descriptor back.
 *
 * `withdraw` MUST be called when the exec is refused, or the descriptor sits in
 * the realm map for the rest of the run. */
export function offerLaunch<T extends ScriptLaunch>(
  descriptor: T,
): { launchId: number; withdraw: () => void } {
  const realm = launchGlobal();
  const publishing = realm.spawning_scripts ??= new Map();
  const launchId = realm.script_launch_id = (realm.script_launch_id ?? 0) + 1;
  publishing.set(launchId, { descriptor, acknowledge: () => {} });
  return { launchId, withdraw: () => { publishing.delete(launchId); } };
}

/** Publish, start, and wait until the child has captured this exact object. */
export async function handoffLaunch<T extends ScriptLaunch>(
  descriptor: T,
  start: (launchId: number) => number,
  outcome?: LaunchOutcome,
): Promise<number> {
  const realm = launchGlobal();
  const publishing = realm.spawning_scripts ??= new Map();
  // Bitburner rejects a process whose filename and args match one already on
  // the host. This one integer serves twice over: the process key needed
  // before the child PID exists, and the key it reads its descriptor back by.
  const launchId = realm.script_launch_id = (realm.script_launch_id ?? 0) + 1;

  let claimed = false;
  let acknowledge!: () => void;
  const captured = new Promise<void>((resolve) => {
    acknowledge = () => { claimed = true; resolve(); };
  });
  publishing.set(launchId, { descriptor, acknowledge });
  try {
    const pid = start(launchId);
    if (pid === 0) {
      if (outcome !== undefined) outcome.refused = true;
      return 0;
    }
    // Almost never true today, and kept because it costs nothing to check.
    //
    // v3.0.1 does NOT run the child inline: `createAndAddWorkerScript` starts
    // `startNetscript2Script` without awaiting it, and that function's first
    // suspension is `await compile(script, scripts)` — so when `exec` (or a
    // zero-delay `spawn`) returns the pid, the process is registered, its RAM
    // is deducted and `ns.ps` can see it, but not one line of it has run. With
    // the module cached that is one microtask hop; on first compile it is a
    // real module load, several event-loop turns.
    if (claimed) return pid;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    const acknowledged = await Promise.race([
      captured.then(() => true),
      new Promise<false>((resolve) => {
        captureTimer = setTimeout(() => resolve(false), LAUNCH_CAPTURE_TIMEOUT_MS);
      }),
    ]);
    if (captureTimer !== undefined) clearTimeout(captureTimer);
    // The child may exist, but without the descriptor it can do no valid work.
    if (!acknowledged) {
      if (outcome !== undefined) outcome.uncaptured = true;
      return 0;
    }
    return pid;
  } finally {
    publishing.delete(launchId);
  }
}

/** Claim the descriptor published under this process's launch id.
 *
 * `launchId` is whatever the child was handed as its first argument — a number
 * for an `exec` handoff, anything else (a hostname, nothing at all) for a
 * `spawn` chain or a cold start, both of which correctly capture nothing. */
export function captureLaunch<T extends ScriptLaunch>(
  kind: T["kind"],
  launchId: unknown,
): T | undefined {
  if (typeof launchId !== "number") return undefined;
  const publishing = launchGlobal().spawning_scripts;
  const pending = publishing?.get(launchId);
  if (!pending || pending.descriptor.kind !== kind) return undefined;
  publishing!.delete(launchId);
  pending.acknowledge();
  return pending.descriptor as T;
}

/** A cold boot/prestige kills every child, while the simulator deliberately
 * keeps the JS realm. Drop only the process-owned handoff state. */
export function resetLaunchState(): void {
  const realm = launchGlobal();
  realm.spawning_scripts = undefined;
  realm.script_launch_id = undefined;
  const slots = globalThis as Record<string, unknown>;
  for (const timer of ["dispatch_weaken_timer"]) {
    const handle = slots[timer] as ReturnType<typeof setTimeout> | undefined;
    if (handle !== undefined) clearTimeout(handle);
  }
  // The per-target JIT deadlines are a MAP of live handles. Deleting the slot
  // alone leaves every armed timer running: it would fire on the new realm's
  // globals and wake a target that no longer has a pipeline behind it.
  const jitTimers = slots["dispatch_jit_timers"] as
    Map<string, { timer: ReturnType<typeof setTimeout> }> | undefined;
  for (const deadline of jitTimers?.values() ?? []) clearTimeout(deadline.timer);
  for (const key of [
    "worker_info",
    "worker_jobs",
    "worker_wake",
    "dispatch_done",
    "dispatch_wake",
    "dispatch_wake_pending",
    "dispatch_wake_targets",
    "dispatch_jit_timers",
    "dispatch_weaken_timer",
    "charge_context_pending",
    // The ns resident handles. A cold boot killed the processes behind them,
    // so the handles are stale; start.ts republishes after this runs. `nsMain`
    // is NOT dropped — it is the calling process's own live `ns`.
    "ns_proxy",
    "ns_proxy_long",
    "dnet_controller",
  ]) delete slots[key];
}

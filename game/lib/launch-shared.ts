/** Realm-global handoff for scripts launched by another script.
 *
 * The parent publishes one live descriptor immediately before exec. The child
 * captures it at the top of main() and acknowledges that capture before doing
 * any work. Only the short publish/exec/capture window is serialized; the
 * launched scripts themselves remain fully concurrent.
 *
 * This is the focused worker handoff used by bitburner-2024@master (dc0720b),
 * servers/home/scripts/worker.ts and imports/batchRunner.ts. */

export interface ScriptLaunch {
  readonly kind: string;
}

export interface StartLaunch extends ScriptLaunch {
  readonly kind: "start";
  readonly buildId: string;
}

interface PendingLaunch {
  descriptor: ScriptLaunch;
  acknowledge: () => void;
}

interface LaunchGlobals {
  spawning_script?: PendingLaunch;
  script_launch_tail?: Promise<void>;
  script_launch_id?: number;
}

type LaunchGlobalThis = typeof globalThis & LaunchGlobals;

const launchGlobal = (): LaunchGlobalThis => globalThis as LaunchGlobalThis;

/** Options shared by every automation-owned exec/spawn/run. Temporary scripts
 * are omitted from the save's completed-script history. */
export function temporaryRunOptions<T extends object>(options: T): T & { temporary: true } {
  return { ...options, temporary: true };
}

/** A PID without a capture is not a successful launch. A stale helper bundle,
 * load failure or killed child must not hold every later exec behind it. */
export const LAUNCH_CAPTURE_TIMEOUT_MS = 1_000;

/** Publish, start, and wait until the child has captured this exact object. */
export async function handoffLaunch<T extends ScriptLaunch>(
  descriptor: T,
  start: (launchId: number) => number,
): Promise<number> {
  const realm = launchGlobal();
  const previous = realm.script_launch_tail ?? Promise.resolve();
  let release!: () => void;
  realm.script_launch_tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;

  let acknowledge!: () => void;
  const captured = new Promise<void>((resolve) => { acknowledge = resolve; });
  const pending = { descriptor, acknowledge };
  realm.spawning_script = pending;
  try {
    // Bitburner rejects a process whose filename and args match one already on
    // the host. This one integer is only the process key needed before the
    // child PID exists; the descriptor remains the semantic identity.
    const launchId = realm.script_launch_id = (realm.script_launch_id ?? 0) + 1;
    const pid = start(launchId);
    if (pid === 0) return 0;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    const acknowledged = await Promise.race([
      captured.then(() => true),
      new Promise<false>((resolve) => {
        captureTimer = setTimeout(() => resolve(false), LAUNCH_CAPTURE_TIMEOUT_MS);
      }),
    ]);
    if (captureTimer !== undefined) clearTimeout(captureTimer);
    // The child may exist, but without the descriptor it can do no valid work.
    if (!acknowledged) return 0;
    return pid;
  } finally {
    if (realm.spawning_script === pending) realm.spawning_script = undefined;
    release();
  }
}

/** Capture the descriptor before the parent is allowed to publish another. */
export function captureLaunch<T extends ScriptLaunch>(kind: T["kind"]): T | undefined {
  const realm = launchGlobal();
  const pending = realm.spawning_script;
  if (!pending || pending.descriptor.kind !== kind) return undefined;
  realm.spawning_script = undefined;
  pending.acknowledge();
  return pending.descriptor as T;
}

/** A cold boot/prestige kills every child, while the simulator deliberately
 * keeps the JS realm. Drop only the process-owned handoff state. */
export function resetLaunchState(): void {
  const realm = launchGlobal();
  realm.spawning_script = undefined;
  realm.script_launch_tail = undefined;
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
    "dodge_tail",
    "dnet_controller",
  ]) delete slots[key];
}

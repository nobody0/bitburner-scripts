import type { NS } from "@ns";

export interface ScriptLaunch { readonly kind: string }

export interface LaunchDeferred<T> {
  /** BOXED, and never `Promise<T>`. A resident resolves its readiness with its
   * own live `ns`, and native promise resolution PROBES whatever it is handed
   * for a `then` member. On the real engine that read is merely wasteful; on
   * the simulator's modelled `ns` it is an unmodelled member and it takes the
   * whole run down. The box is never thenable, so nothing ever reads `ns.then`.
   * Unwrap it synchronously (`(await d.promise).value`). */
  readonly promise: Promise<{ value: T }>;
  resolve(value: T): void;
  /** Ownership transitions that must happen inside the engine's atExit stack. */
  onResolve(listener: (value: T) => void): void;
}

/** One process identity, its job descriptor, readiness, and lifetime. */
export interface ExecLaunchEntity<T extends ScriptLaunch = ScriptLaunch, R = void> {
  readonly pid: number;
  readonly descriptor: T;
  readonly ready: LaunchDeferred<R>;
  readonly exited: LaunchDeferred<void>;
}

interface SpawnTicket<T extends ScriptLaunch = ScriptLaunch, R = void> {
  descriptor: T;
  ready: LaunchDeferred<R>;
  exited: LaunchDeferred<void>;
}

interface LaunchGlobals {
  exec_launches?: Map<number, ExecLaunchEntity<ScriptLaunch, any>>;
  spawn_launches?: Map<number, SpawnTicket>;
  spawn_launch_ticket?: number;
}

type LaunchGlobalThis = typeof globalThis & LaunchGlobals;
const launchGlobal = (): LaunchGlobalThis => globalThis as LaunchGlobalThis;

function deferred<T>(): LaunchDeferred<T> {
  let settled = false;
  let settledValue: T;
  const listeners = new Set<(value: T) => void>();
  let resolvePromise!: (value: { value: T }) => void;
  const promise = new Promise<{ value: T }>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      settledValue = value;
      for (const listener of listeners) listener(value);
      listeners.clear();
      resolvePromise({ value });
    },
    onResolve(listener) {
      if (settled) listener(settledValue);
      else listeners.add(listener);
    },
  };
}

export function temporaryRunOptions<T extends object>(
  options: T,
): T & { temporary: true; preventDuplicates: false } {
  return { ...options, temporary: true, preventDuplicates: false };
}

/** Exec, publish by returned pid, and bind ownership without yielding. */
export function launchExec<T extends ScriptLaunch, R = void>(
  descriptor: T,
  start: () => number,
  bind?: (entity: ExecLaunchEntity<T, R>) => void,
): ExecLaunchEntity<T, R> | undefined {
  const pid = start();
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const entity: ExecLaunchEntity<T, R> = {
    pid,
    descriptor,
    ready: deferred<R>(),
    exited: deferred<void>(),
  };
  const launches = launchGlobal().exec_launches ??= new Map();
  launches.set(pid, entity as ExecLaunchEntity<ScriptLaunch, any>);
  bind?.(entity);
  return entity;
}

/** Capture the entity already published under this process's engine pid. */
export function captureExecLaunch<T extends ScriptLaunch, R = void>(
  ns: NS,
  kind: T["kind"],
): ExecLaunchEntity<T, R> | undefined {
  const launches = launchGlobal().exec_launches;
  const entity = launches?.get(ns.pid);
  if (entity === undefined || entity.descriptor.kind !== kind) return undefined;
  launches!.delete(ns.pid);
  ns.atExit(() => entity.exited.resolve(), "exec-handover-exit");
  return entity as ExecLaunchEntity<T, R>;
}

/** Resolve lifetime when an owner observes a child that never captured. */
export function observeExecGone(entity: ExecLaunchEntity<ScriptLaunch, any>): void {
  const launches = launchGlobal().exec_launches;
  if (launches?.get(entity.pid) === entity) launches.delete(entity.pid);
  entity.exited.resolve();
}

export type ExecReadyResult<R> =
  | { readonly status: "ready"; readonly value: R }
  | { readonly status: "gone" };

/** Wait without a compile deadline; only an observed-dead pid fails. The zero
 * timer yields one scheduler turn so compilation can advance, then asks the
 * engine again immediately. It is an observation cadence, never a retry. */
export async function waitExecReady<R>(
  entity: ExecLaunchEntity<ScriptLaunch, R>,
  isRunning: (pid: number) => boolean | Promise<boolean>,
): Promise<ExecReadyResult<R>> {
  // Unboxed INTO a wrapper object, never into a bare value: `then` may not hand
  // the promise machinery an `ns` to probe for a `then` member of its own.
  const ready = entity.ready.promise.then((box) => ({ status: "ready" as const, value: box.value }));
  const exited = entity.exited.promise.then(() => ({ status: "gone" as const }));
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      ready,
      exited,
      new Promise<{ status: "observe" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "observe" }), 0);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (observed.status !== "observe") return observed;
    if (!await isRunning(entity.pid)) {
      observeExecGone(entity);
      return { status: "gone" };
    }
  }
}

/** Publish the sole launch kind for which the caller receives no pid. */
export function offerSpawnLaunch<T extends ScriptLaunch, R = void>(
  descriptor: T,
): { ticket: number; withdraw(): void } {
  const realm = launchGlobal();
  const tickets = realm.spawn_launches ??= new Map();
  const ticket = realm.spawn_launch_ticket = (realm.spawn_launch_ticket ?? 0) + 1;
  tickets.set(ticket, { descriptor, ready: deferred<R>(), exited: deferred<void>() });
  return { ticket, withdraw: () => { tickets.delete(ticket); } };
}

/** Bind a spawn ticket to the successor's actual pid inside the child. */
export function captureSpawnLaunch<T extends ScriptLaunch, R = void>(
  ns: NS,
  kind: T["kind"],
  ticket: unknown,
): ExecLaunchEntity<T, R> | undefined {
  if (typeof ticket !== "number") return undefined;
  const tickets = launchGlobal().spawn_launches;
  const pending = tickets?.get(ticket);
  if (pending === undefined || pending.descriptor.kind !== kind) return undefined;
  tickets!.delete(ticket);
  const entity: ExecLaunchEntity<T, R> = {
    pid: ns.pid,
    descriptor: pending.descriptor as T,
    ready: pending.ready as LaunchDeferred<R>,
    exited: pending.exited,
  };
  ns.atExit(() => entity.exited.resolve(), "spawn-handover-exit");
  return entity;
}

export function resetLaunchState(): void {
  const realm = launchGlobal();
  realm.exec_launches = undefined;
  realm.spawn_launches = undefined;
  realm.spawn_launch_ticket = undefined;
  const slots = globalThis as Record<string, unknown>;
  for (const timer of ["dispatch_weaken_timer"]) {
    const handle = slots[timer] as ReturnType<typeof setTimeout> | undefined;
    if (handle !== undefined) clearTimeout(handle);
  }
  const jitTimers = slots["dispatch_jit_timers"] as
    Map<string, { timer: ReturnType<typeof setTimeout> }> | undefined;
  for (const deadline of jitTimers?.values() ?? []) clearTimeout(deadline.timer);
  for (const key of [
    "worker_info", "worker_jobs", "worker_wake", "dispatch_done",
    "dispatch_wake", "dispatch_wake_pending", "dispatch_wake_targets",
    "dispatch_jit_timers", "dispatch_weaken_timer", "charge_context_pending",
    "ns_proxy", "ns_proxy_long", "dnet_controller",
  ]) delete slots[key];
}

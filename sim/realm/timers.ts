import { Clock } from "../clock.ts";

/** Virtual time for the whole process.
 *
 * Why this and not a clock injected into game/: in Bitburner, script timing is
 * NOT the script's own business. `netscriptDelay`
 * (bitburner-src/src/Netscript/NetscriptHelpers.tsx:419 @ v3.0.1) is a bare
 * `window.setTimeout`, and the 200ms engine cycle (src/engine.tsx) is another
 * one. Both live below the script. So the only way to run game/ unmodified at
 * accelerated time is to replace the primitives underneath it.
 *
 * The ordering this preserves is load-bearing for HWGW: equal-deadline timers
 * fire in registration order, and the microtask queue is drained between them
 * (Clock.runAsync), so each op's `.then` effect lands before the next op's timer
 * callback — exactly the browser's task/microtask checkpoint discipline.
 *
 * Blast radius: these are process-wide globals, so anything else in the process
 * also moves onto virtual time. Keep the sim child process free of real I/O
 * timers (buffer records in memory, never open the telemetry socket), and use
 * `restore()` in tests. */

/** Deterministic wall-clock base, so a run's Date.now() is reproducible.
 * 2024-01-01T00:00:00Z. */
export const DEFAULT_EPOCH_MS = 1_704_067_200_000;

/** HTML spec: once a chain of timers nests deeper than this, delays below
 * MIN_NESTED_DELAY_MS are clamped up. `ns.sleep(0)` spin loops hit this. */
const MAX_UNCLAMPED_NESTING = 5;
const MIN_NESTED_DELAY_MS = 4;

interface TimerRecord {
  clockId: number;
  /** Set for setInterval, so the timer reschedules itself. */
  intervalMs?: number;
  nesting: number;
}

export interface RealPrimitives {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  dateNow: () => number;
  Date: DateConstructor;
  performanceNow: () => number;
  random: () => number;
}

export interface VirtualTime {
  clock: Clock;
  /** The unpatched primitives, captured before install. */
  real: RealPrimitives;
  /** Virtual wall-clock ms (epoch + clock position). */
  nowMs(): number;
  restore(): void;
}

/** The installed realm, if any. Module-level because the patched Date subclass
 * and timer shims need to reach it, and a process hosts exactly one run
 * (sim/vendor's currentNodeMults is module state too). */
let active: { clock: Clock; epochMs: number } | undefined;

function virtualNow(): number {
  return active ? active.epochMs + active.clock.now() : Date.now();
}

export function installVirtualTime(clock: Clock, opts: { epochMs?: number; random?: () => number } = {}): VirtualTime {
  if (active) throw new Error("virtual time is already installed");

  const real: RealPrimitives = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    dateNow: Date.now,
    Date: globalThis.Date,
    performanceNow: globalThis.performance.now.bind(globalThis.performance),
    random: Math.random,
  };

  const epochMs = opts.epochMs ?? DEFAULT_EPOCH_MS;
  active = { clock, epochMs };

  const timers = new Map<number, TimerRecord>();
  let nextId = 1;
  /** Nesting level of the timer callback currently running (0 = not in one). */
  let nesting = 0;

  /** Browser coercion: non-numeric and negative delays become 0, then the
   * nested-timer clamp applies. */
  function normalizeDelay(raw: unknown): number {
    const ms = Number(raw);
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    return nesting + 1 > MAX_UNCLAMPED_NESTING && delay < MIN_NESTED_DELAY_MS ? MIN_NESTED_DELAY_MS : delay;
  }

  function fire(id: number, callback: (...args: unknown[]) => void, args: unknown[]): void {
    const record = timers.get(id);
    if (!record) return;
    const outer = nesting;
    nesting = record.nesting;
    try {
      // Reschedule BEFORE the callback, so clearInterval() from inside it
      // cancels the repeat we just queued rather than leaking one more tick.
      // Each repeat counts as a further nesting level, so a 0ms interval runs
      // free five times and then clamps, as it would in a browser.
      if (record.intervalMs === undefined) {
        timers.delete(id);
      } else {
        record.nesting++;
        const period =
          record.nesting > MAX_UNCLAMPED_NESTING && record.intervalMs < MIN_NESTED_DELAY_MS
            ? MIN_NESTED_DELAY_MS
            : record.intervalMs;
        record.clockId = clock.in(period, () => fire(id, callback, args));
      }
      callback(...args);
    } finally {
      nesting = outer;
    }
  }

  function schedule(callback: unknown, raw: unknown, args: unknown[], intervalMs?: number): number {
    if (typeof callback !== "function") return 0;
    const fn = callback as (...a: unknown[]) => void;
    const delay = normalizeDelay(raw);
    const id = nextId++;
    const record: TimerRecord = { clockId: 0, nesting: nesting + 1 };
    if (intervalMs !== undefined) record.intervalMs = delay;
    timers.set(id, record);
    record.clockId = clock.in(delay, () => fire(id, fn, args));
    return id;
  }

  function cancel(id: unknown): void {
    const record = timers.get(Number(id));
    if (!record) return;
    clock.cancel(record.clockId);
    timers.delete(Number(id));
  }

  // Date is both a constructor and a callable function. A class patch gets
  // `new Date()` right but makes legacy `Date()` throw; Reflect.construct plus
  // a normal function preserves both sides of the native contract.
  const VirtualDate = function(this: unknown, ...args: unknown[]): Date | string {
    if (!new.target) return new real.Date(virtualNow()).toString();
    return Reflect.construct(real.Date, args.length === 0 ? [virtualNow()] : args, new.target);
  };
  Object.setPrototypeOf(VirtualDate, real.Date);
  VirtualDate.prototype = Object.create(real.Date.prototype, {
    constructor: { value: VirtualDate, writable: true, configurable: true },
  }) as Date;
  Object.defineProperty(VirtualDate, "now", { value: virtualNow, configurable: true });

  const patched = {
    setTimeout: ((cb: unknown, ms?: unknown, ...args: unknown[]) => schedule(cb, ms, args)) as unknown,
    setInterval: ((cb: unknown, ms?: unknown, ...args: unknown[]) => schedule(cb, ms, args, 0)) as unknown,
    clearTimeout: ((id: unknown) => cancel(id)) as unknown,
    clearInterval: ((id: unknown) => cancel(id)) as unknown,
  };

  globalThis.setTimeout = patched.setTimeout as typeof globalThis.setTimeout;
  globalThis.setInterval = patched.setInterval as typeof globalThis.setInterval;
  globalThis.clearTimeout = patched.clearTimeout as typeof globalThis.clearTimeout;
  globalThis.clearInterval = patched.clearInterval as typeof globalThis.clearInterval;
  globalThis.Date = VirtualDate as unknown as DateConstructor;
  globalThis.performance.now = () => clock.now();
  if (opts.random) Math.random = opts.random;

  return {
    clock,
    real,
    nowMs: virtualNow,
    restore(): void {
      globalThis.setTimeout = real.setTimeout;
      globalThis.setInterval = real.setInterval;
      globalThis.clearTimeout = real.clearTimeout;
      globalThis.clearInterval = real.clearInterval;
      globalThis.Date = real.Date;
      globalThis.performance.now = real.performanceNow;
      Math.random = real.random;
      timers.clear();
      active = undefined;
    },
  };
}

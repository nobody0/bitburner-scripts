import type { NS } from "@ns";
import { stateKey } from "../../shared/telemetry/schema.ts";
import type { DodgeGlobalThis } from "./dodge-shared.ts";
import { setMirror, type GameState } from "./state.ts";

/** RAM dodger — TypeScript port of the legacy stubCall design
 * (bitburner-legacy/lib/stubcall.js). A temporary stub script buys a dynamic
 * RAM budget, runs one closure with ITS ns, hands the raw result back through
 * globalThis, and dies. The caller pays only ns.exec (1.3 GB), not the cost of
 * the dodged functions.
 *
 * Inside a dodged closure, call ns members with bracket notation on the
 * closure's own ns argument — `stubNs["getServer"](host)` — otherwise the
 * static parser charges the calling bundle and the saving evaporates. */

const g = globalThis as DodgeGlobalThis;

export const DODGE_STUB = "lib/dodge-stub.js";
const DODGE_TIMEOUT_MS = 10_000;
/** Stub base script cost (no ns functions referenced). */
const STUB_BASE_GB = 1.6;
/** Default dynamic budget for the dodged calls themselves — matches the
 * legacy 2.5GB stub (fits scan + getServer + stock getters). */
export const DODGE_BUDGET_GB = 2.5;

/** budgetGb = dynamic RAM the closure may use inside the stub. Declared via
 * exec's ramOverride (no in-source RAM-purchase hack), so callers can size
 * each dodge: dodge(ns, fn, 10) for a contract batch, default 2.5. */
export async function dodge<T>(ns: NS, func: (stubNs: NS) => T | Promise<T>, budgetGb = DODGE_BUDGET_GB): Promise<T> {
  if (g.dodge_running) {
    await g.dodge_running.catch(() => {});
    if (g.dodge_running !== undefined) throw new Error("dodge error after queueing");
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    g.dodge_func = func;
    g.dodge_cb = resolve as (result: unknown) => void;
    g.dodge_reject = reject;
    watchdog = setTimeout(() => reject(new Error("dodge timed out")), DODGE_TIMEOUT_MS);
    const pid = ns.exec(DODGE_STUB, "home", { ramOverride: STUB_BASE_GB + budgetGb });
    if (pid === 0) reject(new Error(`failed to exec ${DODGE_STUB} — is it synced and is home RAM free?`));
  });
  g.dodge_running = promise;

  try {
    return await promise;
  } finally {
    clearTimeout(watchdog);
    g.dodge_func = undefined;
    g.dodge_cb = undefined;
    g.dodge_reject = undefined;
    g.dodge_running = undefined;
    // One microtask tick so the game reaps the stub before the caller resumes.
    await Promise.resolve();
  }
}

type NsMethods = { [K in keyof NS]: NS[K] extends (...args: never[]) => unknown ? K : never }[keyof NS];

export interface Dodger {
  /** Typed dodged call: runs ns[method](...args) inside the stub. The result
   * is mirrored into the game-state store under `method:args`. */
  call<K extends NsMethods>(
    method: K,
    ...args: Parameters<NS[K]>
  ): Promise<Awaited<ReturnType<NS[K]>>>;
  /** Batching escape hatch: many calls, one stub launch (one mutex slot). */
  batch<T>(func: (stubNs: NS) => T | Promise<T>, budgetGb?: number): Promise<T>;
}

/** `state` is the game-state store, not a telemetry sink: a dodged get is a
 * read of the world like any other, so it lands in the store unconditionally
 * and reaches the wire only if a sink is flushing. */
export function makeDodger(ns: NS, state?: GameState): Dodger {
  return {
    call: async (method, ...args) => {
      const value = await dodge(ns, (stubNs) => {
        const fn = stubNs[method] as (...a: unknown[]) => unknown;
        return fn.apply(stubNs, args);
      });
      if (state) {
        const key = stateKey(method, ...(args.filter((a) => typeof a !== "object") as (string | number | boolean)[]));
        setMirror(state, key, value);
      }
      return value as never;
    },
    batch: (func, budgetGb) => dodge(ns, func, budgetGb),
  };
}

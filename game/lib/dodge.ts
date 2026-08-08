import type { NS } from "@ns";
import { STUB_BASE_GB } from "../../shared/ram/placement.ts";
import { stateKey } from "../../shared/telemetry/schema.ts";
import type { DodgeGlobalThis } from "./dodge-shared.ts";
import { setMirror, type GameState } from "./state.ts";

/** RAM dodger — TypeScript port of the stubCall design from the predecessor
 * scripts (bitburner-legacy/src/_lib/stub-call.ts,
 * nobody01/bitburnerscript@2023). A temporary stub script buys a dynamic RAM
 * budget, runs one closure with ITS ns, hands the raw result back through
 * globalThis, and dies. The caller pays only ns.exec (1.3 GB), not the cost of
 * the dodged functions.
 *
 * Inside a dodged closure, call ns members with bracket notation on the
 * closure's own ns argument — `stubNs["getServer"](host)` — otherwise the
 * static parser charges the calling bundle and the saving evaporates. */

const g = globalThis as DodgeGlobalThis;

export const DODGE_STUB = "lib/dodge-stub.js";
const DODGE_TIMEOUT_MS = 10_000;
/** How many times to retry `ns.exec` of the stub before giving up.
 *
 * From the predecessor scripts (src/_lib/stub-call.ts:11-39), and worth
 * copying: `exec` returns 0 for a transient condition as readily as a
 * permanent one — the target host can be momentarily full because a worker has
 * not been reaped yet. Failing immediately turns a RAM blip into a lost probe
 * and a 30 s wait for the next sweep. A `sleep(0)` between attempts yields to
 * the game's scheduler, which is exactly long enough for a reap to land. */
const EXEC_RETRIES = 10;
/** Default dynamic budget for the dodged calls themselves — fits scan +
 * getServer + stock getters. (The predecessor scripts default to 6.6 GB and
 * carry a table of per-call exceptions; see spec/dodging.md.) */
export const DODGE_BUDGET_GB = 2.5;

/** Re-exported so callers sizing a dodge have one import. The value lives with
 * the placement policy, which has to price the same stub. */
export { STUB_BASE_GB };

/** Headroom over the priced cost.
 *
 * The game compares DYNAMIC usage against the allocation and kills the script
 * on overrun, so an exact price is a coin flip: any call the closure makes that
 * was not listed — or a rounding difference between our sum and the engine's —
 * is fatal. Half a gigabyte is cheap next to losing the action. */
const PRICE_MARGIN_GB = 0.5;

/** Price a dodged closure from the ns functions it will call.
 *
 * `ns.getFunctionRamCost` is itself FREE (0 GB) and it already folds in the
 * singularity 16/4/1 multiplier, so this is correct at every SF4 level and
 * inside BN4 without the caller knowing which it is in.
 *
 * Guessing instead is a real bug, and it was found by RUNNING IN THE GAME, not
 * by any test: a hardcoded 2.5 GB budget for `singularity.joinFaction` gives a
 * 4.10 GB allocation (1.6 stub + 2.5) against 4.60 GB of dynamic usage
 * (1.6 + joinFaction's 3.0), and the game kills the stub with a RAM USAGE
 * ERROR.
 *
 * Note the arithmetic: `joinFaction` is SingularityFn2 = 3.0 GB, so 2.5 was
 * short even at SF4 level 3 where the multiplier is 1x. The guess was wrong at
 * EVERY SF4 level, not merely at the expensive ones — which is the general
 * lesson. A budget that is not derived from the call is a coin flip.
 *
 * The simulator cannot catch this class of bug at all: it does not enforce
 * dynamic RAM, so an under-allocated stub runs there quite happily. */
export function priceCalls(ns: NS, methods: readonly string[]): number {
  let total = 0;
  for (const method of new Set(methods)) {
    try {
      total += ns.getFunctionRamCost(method);
    } catch {
      // An unknown name (renamed API, typo) prices as the most expensive
      // singularity tier rather than as free — being over-allocated costs
      // headroom, being under-allocated loses the call entirely.
      total += 5;
    }
  }
  return total + PRICE_MARGIN_GB;
}

export interface DodgeOptions {
  /** Where to run the stub. Defaults to home.
   *
   *  Any rooted host holding the stub script works: all scripts share one JS
   *  realm, so the globalThis rendezvous is realm-wide and a remote stub hands
   *  its result back exactly as a home stub does. This is what lifts the RAM
   *  ceiling off expensive probes — see shared/ram/placement.ts. */
  host?: string;
}

/** budgetGb = dynamic RAM the closure may use inside the stub. Declared via
 * exec's ramOverride (no in-source RAM-purchase hack), so callers can size
 * each dodge: dodge(ns, fn, 10) for a contract batch, default 2.5. */
export async function dodge<T>(
  ns: NS,
  func: (stubNs: NS) => T | Promise<T>,
  budgetGb = DODGE_BUDGET_GB,
  options: DodgeOptions = {},
): Promise<T> {
  if (g.dodge_running) {
    await g.dodge_running.catch(() => {});
    if (g.dodge_running !== undefined) throw new Error("dodge error after queueing");
  }

  const host = options.host ?? "home";
  let settle!: (result: unknown) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve as (result: unknown) => void;
    fail = reject;
  });
  // Claimed before the first exec attempt: the retry loop awaits, and the
  // mutex has to be held across that await or a second dodge could interleave
  // and overwrite the rendezvous slots.
  g.dodge_func = func;
  g.dodge_cb = settle;
  g.dodge_reject = fail;
  g.dodge_running = promise;
  // The rejection path below settles `promise` and then throws the same error.
  // Without a handler attached here that settle would be an unhandled
  // rejection, because the `await` never happens on that path.
  void promise.catch(() => {});
  const watchdog = setTimeout(() => fail(new Error("dodge timed out")), DODGE_TIMEOUT_MS);

  try {
    let pid = 0;
    for (let attempt = 0; attempt < EXEC_RETRIES && pid === 0; attempt++) {
      pid = ns.exec(DODGE_STUB, host, { ramOverride: STUB_BASE_GB + budgetGb });
      // Yield to the game's scheduler so a pending reap can free the RAM.
      if (pid === 0) await ns.sleep(0);
    }
    if (pid === 0) {
      const error = new Error(
        `failed to exec ${DODGE_STUB} on ${host} after ${EXEC_RETRIES} attempts ` +
          `— is it synced there, and is ${STUB_BASE_GB + budgetGb}GB free?`,
      );
      fail(error);
      throw error;
    }
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

import type { NS } from "@ns";
import { STUB_BASE_GB } from '../../shared/ram/broker.ts';
import type { DodgeGlobalThis, DodgeStarted } from "./dodge-shared.ts";
import { handoffLaunch, temporaryRunOptions } from "./launch-shared.ts";
import { realmSleep } from "./wake.ts";

/** RAM dodger — TypeScript port of the stubCall design from
 * nobody01/bitburnerscript@2023 (43e8585), src/_lib/stub-call.ts. A temporary stub script buys a dynamic RAM
 * budget, runs one closure with ITS ns, hands the raw result back through
 * globalThis, and dies. The caller pays only ns.exec (1.3 GB), not the cost of
 * the dodged functions.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L10-L29 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L434-L474
 *
 * Inside a dodged closure, call ns members with bracket notation on the
 * closure's own ns argument — `stubNs["getServer"](host)` — otherwise the
 * static parser charges the calling bundle and the saving evaporates.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Script/RamCalculations.ts#L405-L440 */

const g = globalThis as DodgeGlobalThis;

export function dodgeStubScript(): string {
  return "lib/dodge-stub.js";
}
/** How many times to retry `ns.exec` of the stub before giving up.
 *
 * From the predecessor scripts (src/_lib/stub-call.ts:11-39), and worth
 * copying: `exec` returns 0 for a transient condition as readily as a
 * permanent one — the target host can be momentarily full because a worker has
 * not been reaped yet. Failing immediately turns a RAM blip into a lost probe
 * and a 30 s wait for the next sweep. A `realmSleep(0)` between attempts
 * yields a macrotask to the game's scheduler — the same bare `setTimeout(0)`
 * that `ns.asleep(0)` was upstream, minus the ns surface. */
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
/** Conservative v3.0.1 fallback for a name the runtime cannot price: the
 * largest ordinary API cost is SF4-level-1 SingularityFn3, 5 * 16 = 80 GB.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L82-L95 */
export const UNKNOWN_CALL_GB = 80;

/** Price a dodged closure from the ns functions it will call.
 *
 * `ns.getFunctionRamCost` is itself FREE (0 GB) and it already folds in the
 * singularity 16/4/1 multiplier, so this is correct at every SF4 level and
 * inside BN4 without the caller knowing which it is in.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L82-L95 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1501-L1507
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
      // A renamed API or typo must not price as free: under-allocation kills
      // the stub, while this conservative price merely postpones the action.
      total += UNKNOWN_CALL_GB;
    }
  }
  return total + PRICE_MARGIN_GB;
}

/** The stub could not be exec'd at all — an INFRASTRUCTURE failure (heap
 * drift, a race with a just-launched batch), not a game refusal. Callers may
 * treat it as retryable; a body throw keeps its own type. */
export class DodgeExecError extends Error {}

export interface DodgeOptions {
  /** Where to run the stub. Defaults to home.
   *
   *  Any rooted host holding the stub script works: all scripts share one JS
   *  realm, so the globalThis rendezvous is realm-wide and a remote stub hands
   *  its result back exactly as a home stub does. This is what lifts the RAM
   *  ceiling off expensive probes — see shared/ram/broker.ts. */
  host?: string;
}

/** budgetGb = dynamic RAM the closure may use inside the stub. Declared via
 * exec's ramOverride (no in-source RAM-purchase hack), so callers can size
 * each dodge: dodge(ns, fn, 10) for a contract batch, default 2.5. */
export async function dodge<T>(
  ns: NS,
  func: (stubNs: NS) => T,
  budgetGb = DODGE_BUDGET_GB,
  options: DodgeOptions = {},
): Promise<Awaited<T>> {
  const started = await startDodge(ns, func, budgetGb, options);
  return await started.result;
}

/** Start one serialized dodge and return as soon as its stub hands back the
 * raw result. Promise-valued results are deliberately not awaited here. */
export async function startDodge<T>(
  ns: NS,
  func: (stubNs: NS) => T,
  budgetGb = DODGE_BUDGET_GB,
  options: DodgeOptions = {},
): Promise<DodgeStarted<T>> {
  const predecessor = g.dodge_tail ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const turn = predecessor.catch(() => {}).then(() => gate);
  g.dodge_tail = turn;
  await predecessor.catch(() => {});
  try {
    return await runCall(ns, func, budgetGb, options);
  } finally {
    release();
    if (g.dodge_tail === turn) g.dodge_tail = undefined;
  }
}

async function runCall<T>(
  ns: NS,
  func: (stubNs: NS) => T,
  budgetGb: number,
  options: DodgeOptions,
): Promise<DodgeStarted<T>> {
  const host = options.host ?? "home";
  let settle!: (result: unknown) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<DodgeStarted<T>>((resolve, reject) => {
    settle = resolve as (result: unknown) => void;
    fail = reject;
  });
  // The rejection path below settles `promise` and then throws the same error.
  // Without a handler attached here that settle would be an unhandled
  // rejection, because the `await` never happens on that path.
  void promise.catch(() => {});
  try {
    const stubScript = dodgeStubScript();
    let pid = 0;
    for (let attempt = 0; attempt < EXEC_RETRIES && pid === 0; attempt++) {
      pid = await handoffLaunch(
        {
          kind: "dodge",
          func,
          resolve: settle,
          reject: fail,
        },
        (launchId) => ns.exec(
          stubScript,
          host,
          temporaryRunOptions({ ramOverride: STUB_BASE_GB + budgetGb }),
          launchId,
        ),
      );
      // Yield to the game's scheduler so a pending reap can free the RAM.
      if (pid === 0) await realmSleep(0);
    }
    if (pid === 0) {
      const error = new DodgeExecError(
        `failed to exec ${stubScript} on ${host} after ${EXEC_RETRIES} attempts ` +
          `— is it synced there, and is ${STUB_BASE_GB + budgetGb}GB free?`,
      );
      fail(error);
      throw error;
    }
    return await promise;
  } finally {
    // The engine awaits main() and only then queues its cleanup handler, so
    // two microtask turns are required before that handler has synchronously
    // returned the stub's RAM. Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L48-L66 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L143-L159
    await Promise.resolve();
    await Promise.resolve();
  }
}

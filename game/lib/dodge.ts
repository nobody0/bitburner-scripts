import type { NS } from "@ns";
import { versionedScript } from "../../shared/deployment.ts";
import { STUB_BASE_GB } from '../../shared/ram/broker.ts';
import { gameBuildId } from "./build-id.ts";
import type { DodgeGlobalThis } from "./dodge-shared.ts";

/** RAM dodger — TypeScript port of the stubCall design from the predecessor
 * scripts (bitburner-legacy/src/_lib/stub-call.ts,
 * nobody01/bitburnerscript@2023). A temporary stub script buys a dynamic RAM
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
  return versionedScript("lib/dodge-stub.js", gameBuildId());
}
const DODGE_TIMEOUT_MS = 10_000;
/** How many times to retry `ns.exec` of the stub before giving up.
 *
 * From the predecessor scripts (src/_lib/stub-call.ts:11-39), and worth
 * copying: `exec` returns 0 for a transient condition as readily as a
 * permanent one — the target host can be momentarily full because a worker has
 * not been reaped yet. Failing immediately turns a RAM blip into a lost probe
 * and a 30 s wait for the next sweep. An `asleep(0)` between attempts yields
 * to the game's scheduler without registering a cancellable Netscript delay;
 * unlike `sleep`, `asleep` is explicitly concurrency-exempt. */
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

export type DodgeLane = "default" | "long";

type DodgeFunc = (ns: NS) => unknown;
interface DodgeSlots {
  func?: DodgeFunc;
  cb?: (result: unknown) => void;
  reject?: (error: unknown) => void;
  running?: Promise<unknown>;
}

interface DodgeLaneDescriptor {
  slots: DodgeSlots;
  /** Passed to the stub as ns.args[0] so one deployed file serves both lanes. */
  laneArg: string;
  busy: "wait" | "reject";
  watchdogMs?: number;
  cleanup: "unconditional" | "owner";
}

const DEFAULT_SLOTS: DodgeSlots = {
  get func() { return g.dodge_func; },
  set func(value) { g.dodge_func = value; },
  get cb() { return g.dodge_cb; },
  set cb(value) { g.dodge_cb = value; },
  get reject() { return g.dodge_reject; },
  set reject(value) { g.dodge_reject = value; },
  get running() { return g.dodge_running; },
  set running(value) { g.dodge_running = value; },
};

const LONG_SLOTS: DodgeSlots = {
  get func() { return g.go_dodge_func; },
  set func(value) { g.go_dodge_func = value; },
  get cb() { return g.go_dodge_cb; },
  set cb(value) { g.go_dodge_cb = value; },
  get reject() { return g.go_dodge_reject; },
  set reject(value) { g.go_dodge_reject = value; },
  get running() { return g.go_dodge_running; },
  set running(value) { g.go_dodge_running = value; },
};

const LANES: Record<DodgeLane, DodgeLaneDescriptor> = {
  default: {
    slots: DEFAULT_SLOTS,
    laneArg: "default",
    busy: "wait",
    watchdogMs: DODGE_TIMEOUT_MS,
    cleanup: "unconditional",
  },
  long: {
    slots: LONG_SLOTS,
    laneArg: "long",
    busy: "reject",
    // Go's makeMove/passTurn await opponentNextTurn inside the same call. The
    // turn duration therefore belongs to the game AI, not to controller
    // scheduling; timing it out would free the lane while that stub is still
    // alive and permit two turns to overlap. Preserve the former Go lane's
    // deliberately disabled watchdog.
    cleanup: "owner",
  },
};

export interface DodgeOptions {
  /** Where to run the stub. Defaults to home.
   *
   *  Any rooted host holding the stub script works: all scripts share one JS
   *  realm, so the globalThis rendezvous is realm-wide and a remote stub hands
   *  its result back exactly as a home stub does. This is what lifts the RAM
   *  ceiling off expensive probes — see shared/ram/broker.ts. */
  host?: string;
  /** Independent rendezvous lane. The long lane rejects concurrent calls and
   * has no watchdog because its Go worker awaits the opponent. */
  lane?: DodgeLane;
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
  const lane = LANES[options.lane ?? "default"];
  const slots = lane.slots;
  // Resolution wakes promise waiters before the owner's finally block clears
  // the rendezvous slots. Yield until that exact owner has completed cleanup;
  // the next ordinary probe can otherwise crash the controller with "dodge
  // error after queueing". The long lane must fail instead of queueing because
  // a second Go turn means its driver lifecycle has drifted.
  if (lane.busy === "reject" && slots.running) {
    throw new Error("a Go turn is already running");
  }
  while (slots.running) {
    const owner = slots.running;
    await owner.catch(() => {});
    while (slots.running === owner) await Promise.resolve();
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
  slots.func = func;
  slots.cb = settle;
  slots.reject = fail;
  slots.running = promise;
  // The rejection path below settles `promise` and then throws the same error.
  // Without a handler attached here that settle would be an unhandled
  // rejection, because the `await` never happens on that path.
  void promise.catch(() => {});
  const watchdog = lane.watchdogMs === undefined
    ? undefined
    : setTimeout(() => fail(new Error("dodge timed out")), lane.watchdogMs);

  try {
    const stubScript = dodgeStubScript();
    let pid = 0;
    for (let attempt = 0; attempt < EXEC_RETRIES && pid === 0; attempt++) {
      pid = ns.exec(stubScript, host, { ramOverride: STUB_BASE_GB + budgetGb, temporary: true }, lane.laneArg);
      // Yield to the game's scheduler so a pending reap can free the RAM.
      if (pid === 0) await ns.asleep(0);
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
    if (watchdog !== undefined) clearTimeout(watchdog);
    // A prestige can let a successor controller claim the long lane before
    // this killed worker's rejection continuation runs. Never erase its newer
    // rendezvous slots. Default cleanup remains deliberately unconditional.
    if (lane.cleanup === "unconditional" || slots.running === promise) {
      slots.func = undefined;
      slots.cb = undefined;
      slots.reject = undefined;
      slots.running = undefined;
    }
    // The engine awaits main() and only then queues its cleanup handler, so
    // two microtask turns are required before that handler has synchronously
    // returned the stub's RAM. Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L48-L66 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L143-L159
    await Promise.resolve();
    await Promise.resolve();
  }
}

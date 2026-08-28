import type { WorkerGlobalThis } from "./worker-shared.ts";

/** The weaken-landing wake: the second scheduling window.
 *
 * JIT effects land on 200 ms slots, but the instant a weaken LANDS is the only
 * moment the target's security is provably at minimum — and the instant any op
 * lands is when its heap reservation can be freed. Waiting out the remainder
 * of the heartbeat wastes up to one landing slot of both. A finishing worker pokes
 * `dispatch_wake` from its atExit (game/worker/worker.ts); arming a resolver
 * here turns that poke into a promise the controller can race against its tick
 * sleep.
 *
 * The race deliberately uses the REALM timer, never `ns.sleep`: Bitburner
 * forbids concurrent ns calls from one script, so racing `ns.sleep` against
 * the wake and then issuing ns calls while the sleep is still pending would
 * kill the controller. `ns.asleep` is concurrency-exempt but still cannot be
 * canceled; a realm `setTimeout` is cancellable, and the simulator
 * virtualizes it (sim/realm/timers.ts), so both worlds behave identically. A
 * script parked on a foreign promise is only interrupted at its next ns call —
 * the controller makes ns calls every pass, so a kill still surfaces within
 * one tick.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L398-L431 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L250-L265
 */

/** Sleep on the REALM timer — the one delay primitive our long-running loops
 * use, replacing both `ns.sleep` and `ns.asleep` everywhere.
 *
 * `ns.sleep` is actively dangerous in any script with a second async arm: it
 * holds the Netscript concurrency lock (`netscriptDelay` sets
 * `ws.env.runningFn`), and the engine kills a script whose other arm makes any
 * ns call while it is pending. `ns.asleep` is lock-free but is itself a bare
 * `setTimeout` upstream (NetscriptFunctions.ts:259-265), so it buys nothing a
 * realm timer does not, while still LOOKING like an ns call that might hold
 * the lock.
 *
 * The one thing neither this nor `ns.asleep` provides is prompt kill delivery:
 * a killed script parked on a foreign promise only dies at its next ns call.
 * Every loop that parks here must therefore touch ns each pass (they all do —
 * a beat, a RAM measurement, a read), so a kill still surfaces within one
 * tick. The simulator virtualizes realm timers (sim/realm/timers.ts), so both
 * worlds behave identically. */
export function realmSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Signal a controller wake without losing it when the controller is inside
 * another feature tick and has not armed its promise yet. */
export function signalWake(globals: WorkerGlobalThis, target?: string): void {
  if (target) (globals.dispatch_wake_targets ??= new Set()).add(target);
  const resolve = globals.dispatch_wake;
  if (resolve) resolve();
  else globals.dispatch_wake_pending = true;
}

/** Install a fresh resolver into `dispatch_wake`. Resolving disarms it, so N
 * completions landing in one engine tick coalesce into a single wake. A wake
 * which arrived between arms is consumed immediately. */
export function armWake(globals: WorkerGlobalThis): Promise<void> {
  return new Promise<void>((resolve) => {
    if (globals.dispatch_wake_pending) {
      globals.dispatch_wake_pending = false;
      resolve();
      return;
    }
    globals.dispatch_wake = () => {
      globals.dispatch_wake = undefined;
      resolve();
    };
  });
}

/** Sleep until the tick deadline on the realm timer, racing the wake promise.
 * Clears the timer when the wake wins. */
export function sleepOrWake(delayMs: number, wake: Promise<void>): Promise<"tick" | "wake"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("tick"), delayMs);
    void wake.then(() => {
      clearTimeout(timer);
      resolve("wake");
    });
  });
}

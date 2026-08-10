import type { WorkerGlobalThis } from "./worker-shared.ts";

/** The weaken-landing wake: the second scheduling window.
 *
 * Batch ops land on 200 ms slots, but the instant a weaken LANDS is the only
 * moment the target's security is provably at minimum — and the instant any op
 * lands is when its heap reservation can be freed. Waiting out the remainder
 * of the tick wastes up to one full spacer of both. A finishing worker pokes
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

/** Install a fresh resolver into `dispatch_wake`. Resolving disarms it, so N
 * completions landing in one engine tick coalesce into a single wake. */
export function armWake(globals: WorkerGlobalThis): Promise<void> {
  return new Promise<void>((resolve) => {
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

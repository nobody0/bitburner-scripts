import type { NS } from "@ns";
import type { DodgeLaunch } from "./dodge-shared.ts";
import { captureLaunch } from "./launch-shared.ts";

/** Dodge stub worker. Synced as lib/dodge-stub.js; launched by dodge() via
 * ns.exec with a ramOverride sized per call — the RAM budget is declared at
 * launch, not bought by referencing an expensive ns member in source. Keep
 * this file free of value imports and ns references so the base stays 1.6GB.
 *
 * The call itself is synchronous. If an ns API returns a Promise, that live
 * Promise is handed to the controller inside an envelope and awaited there, so
 * the dodge FIFO is released at once; the stub then stays alive only for as
 * long as that Promise is pending, because the ns calls it makes after an
 * await are this process's. A synchronous closure releases its RAM
 * immediately. */

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const launch = captureLaunch<DodgeLaunch>("dodge");
  // Missing rendezvous happens after a game restart; die quietly.
  if (!launch) return;
  const { func, resolve: cb, reject } = launch;

  try {
    const result = func(ns);
    // Envelope FIRST: the caller's FIFO turn ends here, so a pending Promise
    // never owns the dodge queue.
    cb({ result });
    // ...but a closure that AWAITS is still using this stub. Its post-await
    // `stubNs` calls, and any engine delay it is parked on, belong to this
    // process — returning now finalizes the script under them (a `ScriptDeath`
    // on the next call, or a `netscriptDelay` that is cancelled and never
    // settles, wedging the controller that awaits the envelope). Synchronous
    // closures — every probe — never reach this line and release their RAM at
    // once, which is the whole point of the envelope.
    if (result instanceof Promise) await result.catch(() => {});
  } catch (err) {
    reject(err instanceof Error || (typeof err === "object" && err !== null && "pid" in err) ? err : new Error(String(err)));
  }
}

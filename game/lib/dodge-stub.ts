import type { NS } from "@ns";
import type { DodgeLaunch } from "./dodge-shared.ts";
import { captureLaunch } from "./launch-shared.ts";

/** Dodge stub worker. Synced as lib/dodge-stub.js; launched by dodge() via
 * ns.exec with a ramOverride sized per call — the RAM budget is declared at
 * launch, not bought by referencing an expensive ns member in source. Keep
 * this file free of value imports and ns references so the base stays 1.6GB.
 *
 * The call itself is synchronous. If an ns API returns a Promise, that live
 * Promise is handed to the controller inside an envelope and awaited there;
 * this RAM-consuming stub exits immediately. */

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const launch = captureLaunch<DodgeLaunch>("dodge");
  // Missing rendezvous happens after a game restart; die quietly.
  if (!launch) return;
  const { func, resolve: cb, reject } = launch;

  try {
    cb({ result: func(ns) });
  } catch (err) {
    reject(err instanceof Error || (typeof err === "object" && err !== null && "pid" in err) ? err : new Error(String(err)));
  }
}

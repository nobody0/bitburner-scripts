import type { NS } from "@ns";
import type { DodgeGlobalThis } from "./dodge-shared.ts";

/** Dodge stub worker. Synced as lib/dodge-stub.<build-id>.js; launched by dodge() via
 * ns.exec with a ramOverride sized per call — the RAM budget is declared at
 * launch, not bought by referencing an expensive ns member in source. Keep
 * this file free of value imports and ns references so the base stays 1.6GB. */

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const g = globalThis as DodgeGlobalThis;
  const reject = g.dodge_reject;
  // Missing rendezvous happens after a game restart; die quietly.
  if (!reject) return;
  const func = g.dodge_func;
  const cb = g.dodge_cb;
  if (!func || !cb) {
    reject(new Error("dodge stub started without a pending call"));
    return;
  }

  try {
    const result = func(ns);
    if (result instanceof Promise) {
      // Forward instead of awaiting so synchronous closures resolve before any
      // other script gets a scheduling slot; keep main alive until settled.
      result.then(cb, reject);
      await result.catch(() => {});
      return;
    }
    cb(result);
  } catch (err) {
    reject(err instanceof Error || (typeof err === "object" && err !== null && "pid" in err) ? err : new Error(String(err)));
  }
}

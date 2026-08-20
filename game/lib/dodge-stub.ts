import type { NS } from "@ns";
import type { DodgeGlobalThis } from "./dodge-shared.ts";

/** Dodge stub worker. Synced as lib/dodge-stub.<build-id>.js; launched by dodge() via
 * ns.exec with a ramOverride sized per call — the RAM budget is declared at
 * launch, not bought by referencing an expensive ns member in source. Keep
 * this file free of value imports and ns references so the base stays 1.6GB.
 *
 * One file serves both lanes. `ns.args` is a property, not an API call, so
 * reading the lane from it costs nothing; a second stub file differing only in
 * four slot names would be duplication deployed to every rooted host. */

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const g = globalThis as DodgeGlobalThis;
  const long = ns.args[0] === "long";
  const reject = long ? g.go_dodge_reject : g.dodge_reject;
  // Missing rendezvous happens after a game restart; die quietly.
  if (!reject) return;
  const func = long ? g.go_dodge_func : g.dodge_func;
  const cb = long ? g.go_dodge_cb : g.dodge_cb;
  if (!func || !cb) {
    reject(new Error(`dodge stub started without a pending call${long ? " (long lane)" : ""}`));
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

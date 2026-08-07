import type { NS } from "@ns";
import { stateKey } from "../../shared/telemetry/schema.ts";
import type { Telemetry } from "./telemetry.ts";

/** Instrumented getters: reading state IS logging state. Every call passes
 * through to ns and mirrors the result to the telemetry stream, typed by the
 * getter itself.
 *
 * Methods are written out explicitly (no Proxy, no name loop) so Bitburner's
 * static RAM parser sees exactly the ns members this wrapper can call — a
 * dynamically-dispatched call the parser can't see would crash at runtime with
 * a dynamic-RAM violation on this path. The flip side: every getter listed
 * here is charged to any bundle importing this module, so keep the surface
 * minimal and use dodge() for occasional expensive reads.
 *
 * Perf builds bypass this module entirely; calling code assigns this wrapper
 * only inside a removable `TELEMETRY: if (__TELEMETRY__)` statement.
 */
export type WatchedNS = Pick<NS, "getPlayer">;

export function watchNs(ns: NS, tel: Telemetry): WatchedNS {
  return {
    getPlayer: () => {
      const value = ns.getPlayer();
      tel.mirror(stateKey("getPlayer"), value);
      return value;
    },
  };
}

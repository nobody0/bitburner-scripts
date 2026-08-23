import type { NS } from "@ns";
import type { ScriptLaunch } from "./launch-shared.ts";

export interface DodgeLaunch extends ScriptLaunch {
  readonly kind: "dodge";
  readonly func: (ns: NS) => unknown;
  readonly resolve: (result: DodgeStarted<unknown>) => void;
  readonly reject: (err: unknown) => void;
}

/** Envelope prevents Promise resolution from assimilating an async ns result
 * before the stub has returned and released its RAM. */
export interface DodgeStarted<T> {
  readonly result: T;
}

/** Rendezvous slots on globalThis shared between dodge.ts (caller) and
 * dodge-stub.ts (worker). All scripts run in one JS realm, so results are
 * handed over as live references — no serialization, class instances and Maps
 * survive. This follows from the game importing every script as an ES module
 * in the same browser page. Type-only module: nothing here exists at runtime.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptJSEvaluator.ts#L208-L223 */
export interface DodgeGlobals {
  dodge_tail?: Promise<void>;
}

export type DodgeGlobalThis = typeof globalThis & DodgeGlobals;

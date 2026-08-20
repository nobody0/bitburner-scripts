import type { NS } from "@ns";

/** Rendezvous slots on globalThis shared between dodge.ts (caller) and
 * dodge-stub.ts (worker). All scripts run in one JS realm, so results are
 * handed over as live references — no serialization, class instances and Maps
 * survive. This follows from the game importing every script as an ES module
 * in the same browser page. Type-only module: nothing here exists at runtime.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptJSEvaluator.ts#L208-L223 */
export interface DodgeGlobals {
  dodge_func?: (ns: NS) => unknown;
  dodge_cb?: (result: unknown) => void;
  dodge_reject?: (err: unknown) => void;
  dodge_running?: Promise<unknown>;
}

/** Rendezvous state for the long (Go) lane. A separate slot set, not a separate
 * stub: one stub file serves both lanes and picks its slots from ns.args. */
export interface GoDodgeGlobals {
  go_dodge_func?: (ns: NS) => unknown;
  go_dodge_cb?: (result: unknown) => void;
  go_dodge_reject?: (err: unknown) => void;
  go_dodge_running?: Promise<unknown>;
}

export type DodgeGlobalThis = typeof globalThis & DodgeGlobals & GoDodgeGlobals;
export type GoDodgeGlobalThis = DodgeGlobalThis;

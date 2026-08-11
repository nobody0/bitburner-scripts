import type { NS } from "@ns";

/** Rendezvous state for the Go worker lane. */
export interface GoDodgeGlobals {
  go_dodge_func?: (ns: NS) => unknown;
  go_dodge_cb?: (result: unknown) => void;
  go_dodge_reject?: (err: unknown) => void;
  go_dodge_running?: Promise<unknown>;
}

export type GoDodgeGlobalThis = typeof globalThis & GoDodgeGlobals;

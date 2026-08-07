import type { NS } from "@ns";

/** Rendezvous slots on globalThis shared between dodge.ts (caller) and
 * dodge-stub.ts (worker). All scripts run in one JS realm, so results are
 * handed over as live references — no serialization, class instances and Maps
 * survive. Type-only module: nothing here exists at runtime. */
export interface DodgeGlobals {
  dodge_func?: (ns: NS) => unknown;
  dodge_cb?: (result: unknown) => void;
  dodge_reject?: (err: unknown) => void;
  dodge_running?: Promise<unknown>;
}

export type DodgeGlobalThis = typeof globalThis & DodgeGlobals;

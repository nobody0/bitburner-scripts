import type { CycleSolution, PrepPlan, TargetStatics } from "./targeting.ts";

/** Contract between the evaluator (which target, which strategy) and the
 * dispatcher (which ops, where, when). Both halves are pure; the drivers
 * (sim/run.ts, game/lib/dispatch-driver.ts) only move data. */

export type SegmentKind = "farm" | "prep" | "share";

export interface Segment {
  kind: SegmentKind;
  /** RAM budget in GB. Ordered list: earlier segments claim RAM first. */
  gb: number;
}

export interface TargetDirective {
  farm?: { host: string; statics: TargetStatics; solution: CycleSolution };
  prep?: { host: string; statics: TargetStatics; plan: PrepPlan };
  /** Ordered — the reorder rule can put prep ahead of farm. */
  segments: Segment[];
  /** Context generation the solutions were scored under (never mix). */
  ctxGeneration: number;
  decidedAt: number;
}

export interface FleetState {
  fleetGb: number;
  freeGb: number;
  inFlight: { hack: number; grow: number; weaken: number };
  /** Live security/money for the hot set, kept fresh by the dispatcher. */
  live: Map<string, { hackDifficulty: number; moneyAvailable: number }>;
  prepped: boolean;
}

export const EMPTY_DIRECTIVE: TargetDirective = { segments: [], ctxGeneration: -1, decidedAt: -Infinity };

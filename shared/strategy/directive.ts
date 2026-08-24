import type { CycleSolution, PrepPlan, TargetStatics } from "./targeting.ts";
import type { ShareCutover } from "./share.ts";
import type { ChargeCutover } from "./stanek/charge.ts";

/** Contract between the evaluator (which target, which strategy) and the
 * dispatcher (which ops, where, when). Both halves are pure; the drivers
 * (sim/run.ts, game/lib/dispatch-driver.ts) only move data. */

export type SegmentKind = "farm" | "prep" | "charge" | "share";

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
  /** Marginal-value evidence behind the share reservation. */
  share?: ShareCutover;
  /** Marginal-value evidence behind the current one-shot charge budget. */
  charge?: ChargeCutover;
  /** Context generation the solutions were scored under (never mix). */
  ctxGeneration: number;
  decidedAt: number;
}

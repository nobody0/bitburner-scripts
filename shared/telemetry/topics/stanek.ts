/** Stanek's Gift feature — BN13's theme. Problem: two nested optimizations —
 * pack the chosen fragments into the gift grid (2D bin packing with rotation)
 * and then schedule charging so the fragments you actually need reach high
 * charge first. Fully isolated: the grid never interacts with anything else. */

export interface StanekFragment {
  id: number;
  type: string;
  x: number;
  y: number;
  rotation: number;
  power: number;
  limit: number;
  effect: string;
  numCharge: number;
  highestCharge: number;
  chargedEffect: number;
}

export interface StanekState {
  width: number;
  height: number;
  /** Occupied cells as "x,y" -> fragment id, so the UI can draw the grid
   * without re-deriving shapes. */
  occupied: Record<string, number>;
  fragments: StanekFragment[];
  /** Fragment ids that exist but are not placed. */
  availableTypes?: { id: number; type: string; power: number; limit: number }[];
  plan?: StanekPlan;
}

export interface StanekPlan {
  placements: { id: number; x: number; y: number; rotation: number }[];
  value: number;
  /** True when the exhaustive search was capped — the packing may not be
   *  optimal, and saying so matters because optimality is this feature's
   *  entire evidence claim. */
  approximated: boolean;
  chargeOrder: number[];
  why: string;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}

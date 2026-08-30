import type { FeatureId } from "../shared/features/ids.ts";

/** Simulator-owned feature selection. A specialized scenario may exclude a
 * controller module, but selection never changes what the game
 * reports as unlocked and can never force a locked API into existence. */
export type FeatureSelection = readonly FeatureId[];

/** Exclude every feature except the named scenario surface. */
export function only(...enabled: FeatureId[]): FeatureSelection {
  return enabled;
}

export function describeFeatureSelection(selection?: FeatureSelection): string {
  if (!selection) return "all features";
  return selection.length > 0 ? `only ${selection.join(", ")}` : "no features";
}

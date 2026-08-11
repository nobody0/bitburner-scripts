import type { FeatureId } from "../shared/features/ids.ts";

export type RunValidity = "valid" | "partial" | "invalid-for-goal";
export type ScenarioClass = "save-snapshot" | "synthetic-early-game";
export type FeatureCoverage = "full" | "partial" | "oracle-only" | "unmodeled";

/** Static implementation coverage, carried in every run rather than hidden in
 * prose. "Full" means the controller-facing lifecycle exists; parity tests of
 * pure rules alone are deliberately called oracle-only. */
export const SIM_FEATURE_COVERAGE: Readonly<Record<FeatureId, FeatureCoverage>> = {
  progression: "partial",
  hacking: "full",
  factions: "full",
  career: "partial",
  hacknet: "full",
  // Full for the shipped controller lifecycle: fresh market generation,
  // prices/cycles, positions, unlocks, prestige, and hack/grow influence.
  // User-created limit/stop orders remain outside that lifecycle and still
  // fail loudly when a save contains them or a script tries to place one.
  stock: "full",
  gang: "unmodeled",
  corp: "unmodeled",
  bladeburner: "unmodeled",
  sleeves: "unmodeled",
  go: "oracle-only",
  stanek: "unmodeled",
  dnet: "unmodeled",
  side: "oracle-only",
};

export function scenarioClass(hasSave: boolean): ScenarioClass {
  return hasSave ? "save-snapshot" : "synthetic-early-game";
}

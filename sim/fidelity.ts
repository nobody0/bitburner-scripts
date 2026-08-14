import type { FeatureId } from "../shared/features/ids.ts";

export type RunValidity = "valid" | "partial" | "invalid-for-goal";
export type ScenarioClass = "save-snapshot" | "seeded-vanilla" | "synthetic-early-game";
export type FeatureCoverage = "full" | "partial" | "oracle-only" | "unmodeled";

/** Increment whenever handwritten simulator semantics change in a way that can
 * alter an outcome. It is part of every comparison fingerprint. */
export const SIMULATOR_MODEL_VERSION = 5;
/** Pinned upstream revision mirrored by sim/vendor/manifest.json. */
export const SIMULATOR_VENDOR_COMMIT = "3162fd2590e221eadd0c0fbd46151913f7c4c41c";

/** Explicit speedrun-harness allowance. A fully unattended route cannot cross
 * the initial Singularity boundary without manual input, so every run of the
 * real controller receives active and owned SF4.3. This changes only the
 * controller run's entrance state; SimWorld itself remains capable of testing
 * the upstream no-SF4 behavior. */
export const CONTROLLER_AUTOMATION_SOURCE_FILES = Object.freeze({ "4": 3 } as const);

/** Full-route simulations collapse the trained policy's per-move interior to
 * a seeded game outcome calibrated by GO_REWARD_RULES. Exact action parity and
 * WebGPU strength remain the responsibility of the arena lane. */
export const AGGREGATE_GO_MODEL = "v9-arena-2026-08-14-v1" as const;
export type GoSimulationFidelity = "action-exact" | typeof AGGREGATE_GO_MODEL;

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
  // Full for fresh/controller runs. Save snapshots intentionally invalidate
  // when Go is probed because the decoder does not retain a live board.
  go: "full",
  // Core placement/charge/effect/process lifecycle is modeled. acceptGift,
  // sleeves, and save-seeded gift state remain explicit gaps.
  stanek: "partial",
  dnet: "unmodeled",
  side: "oracle-only",
};

export function scenarioClass(hasSave: boolean, seededVanilla = false): ScenarioClass {
  return hasSave ? "save-snapshot" : seededVanilla ? "seeded-vanilla" : "synthetic-early-game";
}

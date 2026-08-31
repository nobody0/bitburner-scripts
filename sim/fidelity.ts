import type { FeatureId } from "../shared/features/ids.ts";

export type RunValidity = "valid" | "partial" | "invalid-for-goal";
export type ScenarioClass = "save-snapshot" | "seeded-vanilla" | "synthetic-early-game";
export type FeatureCoverage = "full" | "partial" | "oracle-only" | "unmodeled";

/** Increment whenever handwritten simulator semantics change in a way that can
 * alter an outcome. It is part of every comparison fingerprint. */
export const SIMULATOR_MODEL_VERSION = 12;
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
 * WebGPU strength remain the responsibility of the arena lane.
 *
 * The id names the calibration, so it moves whenever the priors do: the win
 * rates now come from the 3,072-game combined arena of 2026-08-19, not the
 * 2026-08-14 fit the previous id claimed. GO_REWARD_RULES is also hashed into
 * the scenario fingerprint, so a refit can no longer pass as the same
 * scenario even if this id is forgotten. */
export const AGGREGATE_GO_MODEL = "v9-arena-2026-08-19-v2" as const;
export type GoSimulationFidelity = "action-exact" | typeof AGGREGATE_GO_MODEL;

/** Implementation ceiling before a concrete run's scenario is considered.
 * Do not emit this object directly: save decoding and deliberately aggregate
 * models can make a particular run less faithful than this ceiling. */
const BASE_FEATURE_COVERAGE: Readonly<Record<FeatureId, FeatureCoverage>> = {
  progression: "partial",
  // The three verbs, server generation and the batcher's landing model are
  // exact. The analysis/formulas half of the namespace (hackAnalyze*,
  // growthAnalyze*, getHackTime and ns.formulas.hacking) is not implemented and
  // throws; the shipped controller computes those from shared/formulas.ts,
  // which is pinned against the same vendored source.
  hacking: "partial",
  factions: "full",
  career: "partial",
  // Node/server economics, hash production and capacity are exact. Of the
  // eleven hash upgrades (Hacknet/Enums.ts HashUpgradeEnum), five have modeled
  // effects; the other six (Sell for Corporation Funds, Exchange for
  // Corporation Research, both Bladeburner exchanges, Generate Coding
  // Contract, Company Favor) throw rather than pretending to spend, so a run
  // that wants one is refused and not quietly mispriced.
  hacknet: "partial",
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
  // Full for fresh and multi-install controller runs: all 22 ns.dnet members
  // (RamCostGenerator.ts lists 23 because it still carries a `getServer` entry
  // for a member removed from the Darknet interface; sim/ns/ram-costs.ts keeps
  // that stale price and correctly implements no such member),
  // mutation/restart, sessions, labyrinth/storms, exact cache/clue rewards,
  // live stock grants, and coding-contract generation/solve/reward lifecycle.
  // Save/offline/UI-only state is intentionally outside this coverage claim.
  // Downgraded from "full" by the v3.0.1 audit: hostnames are synthetic rather
  // than generated (see DNET_ASSUMPTIONS "dnet.hostnames"), which both spends a
  // different number of draws than the game and shows strategy a hostname shape
  // the game never produces.
  dnet: "partial",
  // Generated and cache-minted contracts use the vendored problem definitions;
  // the real side driver discovers, solves and claims them through Netscript.
  // `getContract`, `getDescription` and `createDummyContract` are still absent
  // from ns.codingcontract and throw when called.
  side: "partial",
};

export interface FidelityContext {
  scenario: ScenarioClass;
  goFidelity?: GoSimulationFidelity;
  /** Save decoders set these only when the complete live subsystem was
   * retained. Absence is deliberately a downgrade, never an invented reset. */
  savedState?: Partial<Record<"go" | "gang" | "corp" | "bladeburner" | "sleeves" | "stanek", boolean>>;
}

export interface FeatureCoverageReport {
  coverage: Readonly<Record<FeatureId, FeatureCoverage>>;
  reasons: Readonly<Partial<Record<FeatureId, string>>>;
}

/** Resolve the fidelity advertised by one concrete run. "Full" means its
 * controller-facing lifecycle exists for this scenario, not merely that a
 * formula oracle exists somewhere in the repository. */
export function resolveFeatureCoverage(context: FidelityContext): FeatureCoverageReport {
  const coverage = { ...BASE_FEATURE_COVERAGE } as Record<FeatureId, FeatureCoverage>;
  const reasons: Partial<Record<FeatureId, string>> = {};

  if (context.goFidelity === AGGREGATE_GO_MODEL) {
    coverage.go = "partial";
    reasons.go = `route model ${AGGREGATE_GO_MODEL} collapses move-level play`;
  }

  if (context.scenario === "save-snapshot") {
    const saved = context.savedState ?? {};
    for (const feature of ["go", "gang", "corp", "bladeburner", "sleeves", "stanek"] as const) {
      if (saved[feature]) continue;
      coverage[feature] = "unmodeled";
      reasons[feature] = "save snapshot does not retain this subsystem's live state";
    }
  }

  return { coverage: Object.freeze(coverage), reasons: Object.freeze(reasons) };
}

export function scenarioClass(hasSave: boolean, seededVanilla = false): ScenarioClass {
  return hasSave ? "save-snapshot" : seededVanilla ? "seeded-vanilla" : "synthetic-early-game";
}

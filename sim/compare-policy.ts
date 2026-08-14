import type { RunValidity } from "./fidelity.ts";

export interface ComparableRun {
  goal: string;
  driver: string;
  scenario: string;
  scenarioFingerprint?: string;
  experimentClass?: string;
  validity: RunValidity;
  gaps: string[];
}

/** Guardrail for A/B output: a delta is attributable only when every initial
 * condition (including the seed) has the same scenario fingerprint. */
export function assertComparable(runs: readonly ComparableRun[], allowInvalid = false): void {
  const goals = new Set(runs.map((run) => run.goal));
  if (goals.size > 1) throw new Error(`refusing to compare different goals: ${[...goals].join(" vs ")}`);

  const drivers = new Set(runs.map((run) => run.driver));
  if (drivers.size > 1) throw new Error(`refusing to compare different drivers: ${[...drivers].join(" vs ")}`);
  const scenarios = new Set(runs.map((run) => run.scenario));
  if (scenarios.size > 1) throw new Error(`refusing to compare different scenario classes: ${[...scenarios].join(" vs ")}`);
  const experiments = new Set(runs.map((run) => run.experimentClass ?? "legacy-unknown"));
  if (experiments.size > 1) {
    throw new Error(`refusing to compare different experiment classes: ${[...experiments].join(" vs ")}`);
  }
  if (runs.some((run) => !run.scenarioFingerprint)) {
    throw new Error("refusing to compare legacy runs without a scenario fingerprint");
  }
  const fingerprints = new Set(runs.map((run) => run.scenarioFingerprint));
  if (fingerprints.size > 1) {
    throw new Error("refusing to compare runs with different seeds or initial scenario state");
  }
  const gapSets = new Set(runs.map((run) => run.gaps.join("\0")));
  if (gapSets.size > 1) throw new Error("refusing to compare runs with different unmodeled gap sets");
  const invalid = runs.filter((run) => run.validity === "invalid-for-goal");
  if (invalid.length > 0 && !allowInvalid) {
    throw new Error("refusing invalid-for-goal run(s); inspect their gaps or pass --allow-invalid for diagnostics only");
  }
}

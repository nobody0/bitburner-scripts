import { describe, expect, test } from "bun:test";
import { assertComparable, type ComparableRun } from "../compare-policy.ts";

const BASE: ComparableRun = {
  goal: "earn:1e6",
  driver: "game",
  scenario: "synthetic-early-game",
  scenarioFingerprint: "v1:same",
  experimentClass: "feature-scenario",
  validity: "valid",
  gaps: [],
};

describe("simulation comparison policy", () => {
  test("accepts only runs with the same complete scenario identity", () => {
    expect(() => assertComparable([BASE, { ...BASE }])).not.toThrow();
    expect(() => assertComparable([BASE, { ...BASE, scenarioFingerprint: "v1:different" }])).toThrow(
      "different seeds or initial scenario state",
    );
    expect(() => assertComparable([BASE, { ...BASE, scenarioFingerprint: undefined }])).toThrow(
      "legacy runs without a scenario fingerprint",
    );
  });

  test("invalid runs remain diagnostic-only", () => {
    const invalid = { ...BASE, validity: "invalid-for-goal" as const, gaps: ["ns go.getBoardState"] };
    expect(() => assertComparable([invalid, { ...invalid }])).toThrow("refusing invalid-for-goal");
    expect(() => assertComparable([invalid, { ...invalid }], true)).not.toThrow();
  });

  test("route benchmarks cannot be compared with synthetic feature scenarios", () => {
    expect(() => assertComparable([BASE, { ...BASE, experimentClass: "bitnode-route" }])).toThrow(
      "different experiment classes",
    );
  });
});

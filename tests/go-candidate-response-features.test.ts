import { describe, expect, test } from "bun:test";
import {
  GO_CANDIDATE_RESPONSE_FEATURES,
  candidateResponseFeatures,
} from "../shared/strategy/go/neural/candidate-features.ts";
import { GO_OPPONENT_BRANCHES } from "../shared/strategy/go/opponent.ts";

describe("exact candidate response features", () => {
  test("encode a complete seeded White branch distribution without labels", () => {
    const features = candidateResponseFeatures({
      size: 5,
      rows: [".....", "..O..", ".....", "..X..", "....."],
    }, [], 0, "Netburners", 1.5, 12_345_600, 12);
    expect(features).toHaveLength(GO_CANDIDATE_RESPONSE_FEATURES);
    expect([...features].every(Number.isFinite)).toBe(true);
    const branchMass = [...features.slice(0, GO_OPPONENT_BRANCHES.length)]
      .reduce((sum, value) => sum + value, 0);
    expect(branchMass).toBeCloseTo(1, 6);
  });

  test("marks a terminal second pass directly", () => {
    const features = candidateResponseFeatures({
      size: 5, rows: Array.from({ length: 5 }, () => "....."),
    }, [], 1, "Slum Snakes", 3.5, 200, 25);
    expect(features[GO_OPPONENT_BRANCHES.indexOf("pass")]).toBe(1);
    expect(features[GO_OPPONENT_BRANCHES.length + 8]).toBe(1);
  });
});

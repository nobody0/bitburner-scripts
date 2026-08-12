import { describe, expect, test } from "bun:test";
import { BITNODE_FALLBACK, nextBitNode } from "../shared/strategy/progression/bitnode-order.ts";
import { chooseNextBitNode } from "../shared/strategy/progression/decide.ts";

describe("live BitNode speedrun order", () => {
  test("follows the enabled milestones and then falls back to BN12", () => {
    expect(nextBitNode(1, {})).toBe(4);
    expect(nextBitNode(4, { "4": 2, "1": 3 })).toBe(5);
    expect(nextBitNode(5, { "4": 3, "1": 3 })).toBe(5);
    expect(nextBitNode(5, { "4": 3, "1": 3, "5": 2 })).toBe(12);
    expect(nextBitNode(12, { "4": 3, "1": 3, "5": 3, "12": 2 })).toBe(BITNODE_FALLBACK);
  });

  test("credits the Source-File level awarded by the destruction being planned", () => {
    const plan = [{ node: 4, level: 3 }, { node: 1, level: 3 }];
    // We currently hold SF4.2. Finishing the current BN4 run awards SF4.3,
    // so the destination is BN1 rather than an unnecessary fourth BN4 run.
    expect(nextBitNode(4, { "4": 2 }, plan)).toBe(1);
    expect(nextBitNode(1, { "4": 3, "1": 2 }, plan)).toBe(BITNODE_FALLBACK);
  });

  test("the controller selector consumes the same enabled plan", () => {
    expect(chooseNextBitNode(4, { "4": 2 }).bitNode).toBe(nextBitNode(4, { "4": 2 }));
    expect(chooseNextBitNode(5, { "4": 3, "1": 3, "5": 2 }).bitNode)
      .toBe(nextBitNode(5, { "4": 3, "1": 3, "5": 2 }));
  });
});

import { describe, expect, test } from "bun:test";
import { BITNODE_FALLBACK, nextBitNode } from "../shared/strategy/progression/bitnode-order.ts";

describe("live BitNode speedrun order", () => {
  test("credits the Source-File level awarded by the destruction being planned", () => {
    const plan = [{ node: 4, level: 3 }, { node: 1, level: 3 }];
    // We currently hold SF4.2. Finishing the current BN4 run awards SF4.3,
    // so the destination is BN1 rather than an unnecessary fourth BN4 run.
    expect(nextBitNode(4, { "4": 2 }, plan)).toBe(1);
    expect(nextBitNode(1, { "4": 3, "1": 2 }, plan)).toBe(BITNODE_FALLBACK);
  });
});

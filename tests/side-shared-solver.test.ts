import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTRACT_SOLVERS, solveContract } from "../game/lib/features/side.ts";
import { SOLVERS, solve } from "../shared/strategy/side/contracts.ts";
import { contractOrigin } from "../game/lib/contracts.ts";

/** Requirement: darknet and network contracts share ONE solver implementation.
 *
 * The two origins differ only in how a contract is DISCOVERED — the darknet
 * side publishes resident listings, the ordinary sweep calls `ls` — and from
 * the queue onward they run the same inspect/getData/attempt pipeline. This
 * pins that, because a forked copy is the kind of thing that gets added for a
 * plausible local reason and then drifts silently out of parity with the
 * game's own validators. */
describe("one contract solver serves both origins", () => {
  test("the deployed boundary IS the shared registry, not a copy", () => {
    expect(CONTRACT_SOLVERS).toBe(SOLVERS);
    expect(solveContract).toBe(solve);
  });

  test("the darknet feature never imports solver logic", () => {
    // It may import the queue limit; it must not reach the solvers. Anything
    // that solves a contract belongs in the one driver.
    const source = readFileSync("game/lib/features/dnet.ts", "utf8");
    const importBlocks = source.match(/import[\s\S]*?from\s+"[^"]*side\/contracts\.ts";/g) ?? [];
    for (const block of importBlocks) {
      expect(block).not.toContain("SOLVERS");
      expect(block).not.toContain("solve");
      expect(block).not.toContain("canSolve");
    }
    expect(source).not.toContain("codingcontract");
  });

  test("origin changes attribution and nothing about the answer", () => {
    const network = { host: "n00dles", file: "jump.cct" };
    const darknet = { host: "dn-1", file: "jump.cct", dnet: { identity: "10.0.0.1", observedAt: 1 } };
    expect(contractOrigin(network)).toBe("network");
    expect(contractOrigin(darknet)).toBe("darknet");

    // Same type, same data, same answer — whichever origin it came from.
    expect(solveContract("Array Jumping Game", [2, 3, 1, 1, 4])).toBe(1);
  });
});

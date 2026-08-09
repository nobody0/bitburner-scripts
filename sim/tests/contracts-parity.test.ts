import { describe, expect, test } from "bun:test";
import { CONTRACT_SOLVERS, solveContract } from "../../game/lib/features/side.ts";
import { mulberry32 } from "../core/rng.ts";
import { CodingContractTypes } from "../vendor/bitburner/src/CodingContract/ContractTypes.ts";

function replay(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item);
}

describe("coding contract parity with Bitburner v3.0.1", () => {
  test("the deployed registry covers every official type", () => {
    expect(Object.keys(CONTRACT_SOLVERS).sort()).toEqual(Object.keys(CodingContractTypes).sort());
  });

  test("official generators and validators accept every handcrafted solver", () => {
    const originalRandom = Math.random;
    Math.random = mulberry32(0xc0de_0301);
    try {
      for (const [type, definition] of Object.entries(CodingContractTypes)) {
        // Expression search is exponential; five generated cases still cover
        // the official state/data conversion without dominating the suite.
        const cases = type === "Find All Valid Math Expressions" ? 5 : 20;
        for (let index = 0; index < cases; index++) {
          const state = definition.generate();
          const data = definition.getData ? definition.getData(state) : state;
          const answer = solveContract(type, data);
          if (!definition.validateAnswer(answer) || !definition.solver(state, answer)) {
            throw new Error(`${type} case ${index} rejected\ndata=${replay(data)}\nanswer=${replay(answer)}`);
          }
        }
      }
    } finally {
      Math.random = originalRandom;
    }
  });
});

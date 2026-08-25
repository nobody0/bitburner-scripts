import { describe, expect, test } from "bun:test";
import {
  candidateMatchesEvidence,
  fixedPositionsFromEvidence,
} from "../shared/strategy/dnet/evidence.ts";
import { DEEP_SOLVERS } from "../shared/strategy/dnet/solvers/deep.ts";
import { GROUP_SOLVERS } from "../shared/strategy/dnet/solvers/group.ts";

describe("harvested password evidence", () => {
  test("a duplicated contains hint on a one-character password means one occurrence", () => {
    expect(candidateMatchesEvidence("x", [{ kind: "contains", chars: ["x", "x"], at: 1 }])).toBe(true);
    expect(candidateMatchesEvidence("y", [{ kind: "contains", chars: ["x", "x"], at: 1 }])).toBe(false);
  });

  test("only uniquely placed probe characters become fixed positions", () => {
    expect(fixedPositionsFromEvidence(4, [
      { kind: "placement", attempted: "1a23", placed: ["1", "2"], at: 1 },
      { kind: "placement", attempted: "7777", placed: ["7", "7"], at: 2 },
    ])).toEqual(["1", undefined, "2", undefined]);
  });

  test("group and prefix solvers start with positions already learned from logs", () => {
    const evidence = [{ kind: "placement" as const, attempted: "12xx", placed: ["1", "2"], at: 1 }];
    const group = GROUP_SOLVERS.mastermind.first({
      passwordLength: 4,
      passwordFormat: "numeric",
      evidence,
    });
    expect(group.kind).toBe("attempt");
    if (group.kind === "attempt") expect(group.state.scratch["solved"]).toEqual(["1", "2", null, null]);

    const timing = DEEP_SOLVERS.timingAttack.first({
      passwordLength: 4,
      passwordFormat: "numeric",
      evidence,
    });
    expect(timing.kind).toBe("attempt");
    if (timing.kind === "attempt") {
      expect(timing.password.startsWith("12")).toBe(true);
      expect(timing.state.scratch["known"]).toBe("12");
    }
  });

  test("the timing solver places a non-contiguous fixed suffix in every probe", () => {
    const timing = DEEP_SOLVERS.timingAttack.first({
      passwordLength: 4,
      passwordFormat: "numeric",
      evidence: [{ kind: "placement", attempted: "!!!7", placed: ["7"], at: 1 }],
    });
    expect(timing.kind).toBe("attempt");
    if (timing.kind === "attempt") {
      expect(timing.password[3]).toBe("7");
      expect(timing.state.scratch["fixed"]).toEqual([null, null, null, "7"]);
    }
  });
});

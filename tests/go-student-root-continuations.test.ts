import { describe, expect, test } from "bun:test";
import {
  boundedExpectedPositions, DAEMON_STUDENT_PROBE_TOP_K, DAEMON_STUDENT_ROUTE_K,
  futureMarginalizedTarget, selectRoots,
} from "../go-ai/teacher/export-student-root-continuations.ts";
import { terminalRankingRecords } from "../go-ai/teacher/add-student-root-terminal-rankings.ts";

function point(elapsed: number, aligned: boolean) {
  return {
    elapsed, aligned,
    state: { board: { size: 19, rows: Array(19).fill(".".repeat(19)) },
      previousBoards: [], consecutivePasses: 0, dispatchPlaytime: elapsed * 200 },
    studentFinalists: aligned ? [1, 2] : [2], studentPolicyTop16: aligned ? [1, 2] : [2],
    studentRequestedLimit: 16, studentAdaptiveLimit: aligned ? 2 : 1,
    studentPerSeedReserve: 1, studentProposalSeedCount: 1,
    studentAction: 2, handcraftedAction: 1,
  };
}

describe("student-root counterfactual selection", () => {
  test("keeps production K1 routes separate from wider policy probes", () => {
    expect(DAEMON_STUDENT_ROUTE_K).toBe(1);
    expect(DAEMON_STUDENT_PROBE_TOP_K).toBe(16);
  });

  test("uses only position content and enforces exact quotas", () => {
    const routes = Array.from({ length: 128 }, (_, index) => ({
      environmentId: `environment-${index}`,
      points: [point(0, true), point(1, true), point(2, false), point(3, false)],
    }));
    const selected = selectRoots(routes);
    expect(selected).toHaveLength(128);
    expect(new Set(selected.map((value) => value.environmentId)).size).toBe(128);
    expect(selected.filter((value) => value.selectionKind === "last-aligned")).toHaveLength(64);
    expect(selected.filter((value) => value.selectionKind === "first-divergence")).toHaveLength(64);
    for (const value of selected) {
      expect(value.elapsed).toBe(value.selectionKind === "last-aligned" ? 1 : 2);
      expect(value.aligned).toBe(value.selectionKind === "last-aligned");
    }
  });

  test("bounded expected-value roots are content-selected and balanced before outcomes", () => {
    const positions = Array.from({ length: 128 }, (_, index) => ({
      ...point(index, index < 64),
      selectionKind: index < 64 ? "last-aligned" : "first-divergence",
      positionContentSha256: index.toString(16).padStart(64, "0"),
    })) as any[];
    const selected = boundedExpectedPositions(positions, 24);
    expect(selected).toHaveLength(24);
    expect(selected.filter((value) => value.selectionKind === "last-aligned")).toHaveLength(12);
    expect(selected.filter((value) => value.selectionKind === "first-divergence")).toHaveLength(12);
    expect(boundedExpectedPositions([...positions].reverse(), 24)
      .map((value) => value.positionContentSha256).sort())
      .toEqual(selected.map((value) => value.positionContentSha256).sort());
    const expanded = new Set(boundedExpectedPositions(positions, 64)
      .map((value) => value.positionContentSha256));
    expect(selected.every((value) => expanded.has(value.positionContentSha256))).toBe(true);
  });

  test("retains scarce alignment and samples post-divergence recovery without outcomes", () => {
    const routes = Array.from({ length: 128 }, (_, index) => ({
      environmentId: `diverged-${index}`,
      points: index < 2
        ? [point(0, true), point(1, false), point(2, false), point(3, false)]
        : [point(0, false), point(1, false), point(2, false), point(3, false)],
    }));
    const selected = selectRoots(routes);
    expect(selected.filter((value) => value.selectionKind === "last-aligned")).toHaveLength(2);
    expect(selected.filter((value) => value.selectionKind === "first-divergence")).toHaveLength(64);
    expect(selected.filter((value) => value.selectionKind === "post-divergence")).toHaveLength(62);
    expect(selected.filter((value) => value.selectionKind === "post-divergence")
      .every((value) => value.elapsed > 0)).toBe(true);
  });

  test("future marginalization preserves expected Power per total turn exactly", () => {
    const target = futureMarginalizedTarget(10, [
      { won: true, blackPower: 100, lossPenalizedBlackPower: 100,
        continuationLength: 10, totalRouteTurns: 20 },
      { won: false, blackPower: 200, lossPenalizedBlackPower: 100,
        continuationLength: 30, totalRouteTurns: 40 },
    ]);
    expect(target.expectedWinProbability).toBe(0.5);
    expect(target.expectedLossPenalizedPowerPerTotalTurn).toBe(3.75);
    expect(target.effectiveContinuationLength).toBe(20);
    expect(target.effectiveLossPenalizedBlackPower).toBe(112.5);
    expect(target.effectiveLossPenalizedBlackPower
      / (10 + target.effectiveContinuationLength)).toBe(3.75);
  });
});

describe("student-root terminal rankings", () => {
  test("orders candidates by win then loss-penalized Power per total turn", () => {
    const rows = [
      { move: 1, won: false, power: 100, turns: 10 },
      { move: 2, won: true, power: 50, turns: 10 },
      { move: 3, won: true, power: 90, turns: 10 },
    ].map(({ move, won, power, turns }, index) => ({
      schema: "bitburner-go-v9.5", kind: "trajectory", profile: "daemon19",
      teacherSha256: "teacher", opponentOracle: "oracle", split: "train", episode: index,
      values: [{ state: "state", behavior: [], elapsed: 2, won: Number(won), score: power,
        remaining: turns, weight: 1 / 3, author: "environment-rollout:student-root-handcrafted-continuation-v2" }],
      generation: { numericAuthor: "environment-rollout:student-root-handcrafted-continuation-v2",
        counterfactualTargetScope: "immediate-post-reply", counterfactualGroupId: "group",
        counterfactualCandidateIndex: index, counterfactualCandidateCount: 3,
        candidateMoves: [1, 2, 3], forcedAction: move, originState: "origin", originBehavior: [],
        originElapsed: 1, originatingStudentSha256: "student",
        terminalOutcome: { won, lossPenalizedBlackPower: power, totalRouteTurns: turns } },
    }));
    const result = terminalRankingRecords(rows);
    expect(result.groups).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.example.bestMove).toBe(3);
    expect(result.records[0]!.example.winGroupMoves).toEqual([2, 3]);
    expect(result.records[0]!.example.candidates.map((candidate: any[]) => candidate[0].weight))
      .toEqual([1, 1, 1]);
  });

  test("orders future-marginalized candidates by expected win then expected rate", () => {
    const rows = [
      { move: 1, win: 0.5, rate: 5 },
      { move: 2, win: 0.75, rate: 1 },
      { move: 3, win: 0.75, rate: 3 },
    ].map(({ move, win, rate }, index) => ({
      schema: "bitburner-go-v9.5", kind: "trajectory", profile: "daemon19",
      teacherSha256: "teacher", opponentOracle: "oracle", split: "train", episode: index,
      values: [{ state: "state", behavior: [], elapsed: 2, won: win, score: rate * 10,
        remaining: 9, weight: 1 / 3,
        author: "environment-rollout:student-root-future-marginalized-v1" }],
      generation: { numericAuthor: "environment-rollout:student-root-future-marginalized-v1",
        counterfactualTargetScope: "immediate-post-reply-future-marginalized",
        counterfactualGroupId: "expected-group", counterfactualCandidateIndex: index,
        counterfactualCandidateCount: 3, candidateMoves: [1, 2, 3], forcedAction: move,
        originState: "origin", originBehavior: [], originElapsed: 1,
        originatingStudentSha256: "student", selectionKind: "first-divergence",
        terminalOutcome: { expectedWinProbability: win,
          expectedLossPenalizedPowerPerTotalTurn: rate } },
    }));
    const result = terminalRankingRecords(rows);
    expect(result.records[0]!.example.bestMove).toBe(3);
    expect(result.records[0]!.example.winGroupMoves).toEqual([2, 3]);
    expect(result.records[0]!.generation.counterfactualRankingAuthority)
      .toBe("future-marginalized-terminal-v1");
    expect(result.records[0]!.generation.selectionKind).toBe("first-divergence");
  });
});

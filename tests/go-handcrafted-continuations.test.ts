import { describe, expect, test } from "bun:test";
import { selectPositions } from "../go-ai/teacher/export-handcrafted-continuations.ts";

function ranking(route: number, elapsed: number, marker = 0) {
  return {
    schema: "bitburner-go-exhaustive-proposals-v9.5",
    kind: "actor-ranking",
    profile: "daemon19",
    teacherSha256: "c73cb5811a441e466c4a6112da313c53f37219d68ef499b69c5e8a39ac71703e",
    opponentOracle: "bitburner-go-ai-v3.0.1",
    split: route % 10 === 0 ? "heldout" : "train",
    example: {
      episode: route,
      state: `${String(route).padStart(361, ".")}|${"1".repeat(361)}|0|0|0`,
      behavior: [marker, 0.1, 0.2, 0.3, ...Array(26).fill(0)],
      elapsed,
      moves: [0, 1, 2, 3, 4, 361],
      bestMove: 0,
      candidates: Array.from({ length: 6 }, () => [{ won: marker }]),
      source: "handcrafted",
    },
    generation: {
      originalEpisode: route,
      environmentId: `daemon19:test:${route}`,
    },
  } as never;
}

describe("handcrafted continuation selection", () => {
  test("is outcome-blind, stage-balanced, and capped at two positions per route", () => {
    const trajectories = new Map<number, never>();
    const rankings: never[] = [];
    for (let route = 0; route < 200; route++) {
      trajectories.set(route, { values: Array.from({ length: 90 }, () => ({ won: 1 })) } as never);
      rankings.push(ranking(route, 10), ranking(route, 40), ranking(route, 70));
    }
    const first = selectPositions(rankings, trajectories, 256);
    const changedOutcomes = rankings.map((row: any) => ({
      ...row,
      example: {
        ...row.example,
        candidates: row.example.candidates.map((group: any[]) =>
          group.map((value) => ({ ...value, won: Number(!value.won) }))),
      },
    }));
    for (const trajectory of trajectories.values() as Iterable<any>) {
      trajectory.values.forEach((value: any) => value.won = 0);
    }
    const second = selectPositions(changedOutcomes, trajectories, 256);
    expect(second.map((position) => position.contentHash))
      .toEqual(first.map((position) => position.contentHash));
    expect(Object.fromEntries(["early", "middle", "late"].map((stage) => [
      stage, first.filter((position) => position.stage === stage).length,
    ]))).toEqual({ early: 86, middle: 85, late: 85 });
    const counts = new Map<number, number>();
    for (const position of first) {
      counts.set(position.originalEpisode, (counts.get(position.originalEpisode) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBe(2);
  });
});

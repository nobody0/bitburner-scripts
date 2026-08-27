import { describe, expect, test } from "bun:test";
import {
  ahead,
  decideLab,
  emptyField,
  labPrior,
  liveExitCandidates,
  observeLab,
  renderLabField,
  readCoords,
  readExit,
  readSurroundings,
  refuseEdge,
  type Cell,
  type LabField,
} from "../shared/strategy/dnet/maze.ts";

/** Unit tests for the pure parser and decision boundary. Route performance is
 * measured only by `sim/tests/dnet-lab-benchmark.test.ts`, against the exact
 * stitched maze generator and paid-action model. */

describe("labyrinth wire format", () => {
  test("maps the centered 3x3 render to the four walls", () => {
    expect(readSurroundings("# #\n#@ \n###"))
      .toEqual({ north: true, east: true, south: false, west: false });
  });

  test("treats the exit overlay as passable", () => {
    expect(readSurroundings("#X#\n#@ \n###")?.north).toBe(true);
  });

  test("rejects a render that is not exactly 3x3", () => {
    expect(readSurroundings("##")).toBeUndefined();
    expect(readSurroundings("#######\n#######\n###@###\n#######\n#######\n#######\n#######"))
      .toBeUndefined();
  });

  test("reads both position-message variants", () => {
    expect(readCoords("You have moved to 12,34.")).toEqual([12, 34]);
    expect(readCoords("You cannot go that way. You are still at 7,9.")).toEqual([7, 9]);
    expect(readCoords("You have discovered the end of the labyrinth.")).toBeUndefined();
  });

  test("locates the exit in a radius-3 radar render", () => {
    const wide = ["#######", "#######", "#######", "###@###", "#####X#", "#######", "#######"].join("\n");
    expect(readExit(wide, [10, 10])).toEqual([12, 11]);
  });
});

describe("labyrinth decision boundary", () => {
  test("steps two cells while testing the wall between them", () => {
    expect(ahead([3, 5], "north")).toEqual([3, 3]);
    expect(ahead([3, 5], "east")).toEqual([5, 5]);
  });

});

describe("the planner's prior", () => {
  test("computes the produced size, the seams, and the door candidates of the first rung", () => {
    // 20x14 requested, 21x13 produced, seams at column 10 and row 6. The gap
    // draws: top rows {1,3,5}, bottom rows {7,9,11} (indexed off the REQUESTED
    // height), left columns {1,3}, right columns {15,17} (off the requested
    // width). All four sets are disjoint, so each holds exactly one door.
    const prior = labPrior({ mazeWidth: 20, mazeHeight: 14, offsetStartAndEnd: false });
    expect({ width: prior.width, height: prior.height }).toEqual({ width: 21, height: 13 });
    expect({ seamX: prior.seamX, seamY: prior.seamY }).toEqual({ seamX: 10, seamY: 6 });
    expect(prior.doorSets).toEqual([
      ["10,1", "10,3", "10,5"],
      ["10,11", "10,9", "10,7"],
      ["1,6", "3,6"],
      ["17,6", "15,6"],
    ]);
    expect(prior.doorSetExclusive).toEqual([true, true, true, true]);
    expect(prior.exitCandidates).toEqual(["19,11"]);
  });

  test("a deep rung has nine exit candidates within four cells of the corner", () => {
    const prior = labPrior({ mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true });
    expect({ width: prior.width, height: prior.height }).toEqual({ width: 61, height: 41 });
    expect(prior.exitCandidates).toHaveLength(9);
    expect(prior.exitCandidates).toContain("59,39");
    expect(prior.exitCandidates).toContain("55,35");
  });
});

describe("what the walk publishes", () => {
  const tinyStage = { mazeWidth: 20, mazeHeight: 14, offsetStartAndEnd: false };

  test("the grid is one character per cell, with the parts the generator fixes already settled", () => {
    // The panel's whole picture of a maze is this string, so what it asserts
    // before anything has been walked is load-bearing: the border is wall, the
    // even/even pillars are wall, every odd/odd standing cell is floor, and only
    // the wall SLOTS between them are ever a question.
    const prior = labPrior(tinyStage);
    const grid = renderLabField(emptyField(), prior);
    expect(grid.length).toBe(prior.width * prior.height);
    const cell = (x: number, y: number): string => grid[y * prior.width + x]!;
    expect(cell(0, 0)).toBe("#");
    expect(cell(prior.width - 1, prior.height - 1)).toBe("#");
    expect(cell(2, 2)).toBe("#");
    expect(cell(1, 1)).toBe(".");
    expect(cell(2, 1)).toBe("?");
    // Nothing is claimed about the slots until something has seen one.
    expect(grid.split("").filter((char) => char === "?").length).toBeGreaterThan(0);
  });

  test("an observed slot leaves the fog, in both directions", () => {
    const prior = labPrior(tinyStage);
    // Standing at [1,1] with east open and everything else walled.
    const field = observeLab(emptyField(), [1, 1], "###\n#@ \n###", prior)!;
    const grid = renderLabField(field, prior);
    const cell = (x: number, y: number): string => grid[y * prior.width + x]!;
    expect(cell(2, 1)).toBe(".");
    expect(cell(1, 2)).toBe("#");
    // ...and a slot nobody has looked at is still a question.
    expect(cell(4, 1)).toBe("?");
  });

  test("the exit candidates shrink as they are disproved, and collapse once one is known", () => {
    const deep = labPrior({ mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true });
    expect(liveExitCandidates(emptyField(), deep)).toHaveLength(9);
    const some = liveExitCandidates({ ...emptyField(), ruledOut: ["59,39", "57,39"] }, deep);
    expect(some).toHaveLength(7);
    expect(some).not.toContain("59,39");
    // A known exit outranks the arithmetic entirely: it IS the answer.
    expect(liveExitCandidates({ ...emptyField(), exit: "55,35" }, deep)).toEqual(["55,35"]);
    // The shallow rungs have no jitter, so there is one candidate from the start.
    expect(liveExitCandidates(emptyField(), labPrior(tinyStage))).toEqual(["19,11"]);
  });
});

describe("the planner's decision boundary", () => {
  const tiny = { mazeWidth: 20, mazeHeight: 14, offsetStartAndEnd: false };

  const observed = (at: Cell, render: string): LabField => {
    const field = observeLab(emptyField(), at, render, labPrior(tiny));
    expect(field).toBeDefined();
    return field!;
  };

  test("moves along a known-open edge toward the exit, never into a rendered wall", () => {
    // At [1,1] with east open and everything else walled, the only move toward
    // the exit's corner is east — chosen off the free render alone.
    const field = observed([1, 1], "###\n#@ \n###");
    const plan = decideLab(field, [1, 1], labPrior(tiny));
    expect(plan).toMatchObject({ kind: "move", direction: "east" });
  });

  test("a refused edge outranks a render that claimed it was open", () => {
    const lied = observed([3, 3], "   \n @ \n   ");
    const plan = decideLab(lied, [3, 3], labPrior(tiny));
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    const corrected = refuseEdge(plan.field, [3, 3], plan.direction);
    const next = decideLab(corrected, [3, 3], labPrior(tiny));
    expect(next.kind).toBe("move");
    if (next.kind === "move") expect(next.direction).not.toBe(plan.direction);
  });

  test("a radar that shows no exit rules out every candidate its window covered", () => {
    const prior = labPrior({ mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true });
    // Standing at the centre candidate, a 7x7 window with no X covers all nine.
    const window = Array.from({ length: 7 }, (_, row) => (row === 3 ? "███@███" : "███████")).join("\n");
    const field = observeLab(emptyField(), [57, 37], window, prior);
    expect(field).toBeDefined();
    expect(field!.ruledOut).toHaveLength(9);
  });

  test("a radar showing the exit names it, and the plan then walks known ground", () => {
    const prior = labPrior({ mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true });
    const rows = Array.from({ length: 7 }, (_, row) => {
      if (row === 3) return "█ █@█ █";
      if (row === 5) return "███████".slice(0, 5) + "X█"; // X at window col 5, row 5
      return "███████";
    });
    const field = observeLab(emptyField(), [57, 37], rows.join("\n"), prior);
    expect(field?.exit).toBe("59,39");
  });

  test("the decisive radar fires once per vantage and never again from the same cell", () => {
    const prior = labPrior({ mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true });
    // Fold in a plain radius-1 render so the adjacent slots are known, then
    // stand at the centre candidate: the window covers all nine, so decideLab
    // pays for the decisive radar exactly once.
    const field = observeLab(emptyField(), [57, 37], "███\n█@ \n█ █", prior)!;
    const first = decideLab(field, [57, 37], prior);
    expect(first.kind).toBe("radar");
    if (first.kind !== "radar") return;
    const second = decideLab(first.field, [57, 37], prior);
    expect(second.kind).toBe("move");
  });

  test("the field survives a JSON round trip without changing the decision", () => {
    const prior = labPrior(tiny);
    const field = observed([1, 1], "###\n#@ \n# #");
    const revived = JSON.parse(JSON.stringify(field)) as LabField;
    expect(decideLab(revived, [1, 1], prior)).toEqual(decideLab(field, [1, 1], prior));
  });
});

import { describe, expect, test } from "bun:test";
import { applyGoCheat, GO_CHEAT_LIMITS_BY_SIZE, type GoBoard, type GoView } from "../shared/strategy/go/rules.ts";
import { decideGoNeural, GoNeuralEngine } from "../shared/strategy/go/neural/engine.ts";
import {
  GO_ENGINE_CYCLE_MS,
  goCheatSucceeds,
  goCheatSucceedsSafely,
  goOpponentSeedCandidates,
} from "../shared/strategy/go/rng.ts";
import { StubGoValueBackend } from "./support/go-value-backend.ts";

const empty: GoBoard = { size: 5, rows: Array<string>(5).fill(".....") };

function view(successChance: number): GoView {
  return {
    board: empty,
    currentPlayer: "Black",
    opponent: "Netburners",
    status: "inProgress",
    previousBoards: [],
    consecutivePasses: 0,
    komi: 1.5,
    bonusCycles: 0,
    cheat: {
      unlocked: true,
      count: 0,
      successByCount: [successChance],
      candidateLimit: 2,
      doubleMoveLimit: 1,
    },
  };
}

describe("IPvGO cheat planning", () => {
  test("applies both routers before the one shared capture resolution", () => {
    const board: GoBoard = {
      size: 5,
      rows: [".X...", "XOX..", ".....", ".....", "....."],
    };
    const played = applyGoCheat(board, {
      type: "cheatTwoMoves",
      x1: 2, y1: 1,
      x2: 4, y2: 4,
    });
    expect(played?.board.rows[1]?.[1]).toBe(".");
    expect(played?.board.rows[2]?.[1]).toBe("X");
    expect(played?.board.rows[4]?.[4]).toBe("X");
    expect(played?.captures).toBe(1);
  });

  test("does not report friendly suicide cleanup as a capture", () => {
    const board: GoBoard = {
      size: 5,
      rows: [".O...", "O.O..", ".O.O.", "..O..", "....."],
    };
    const played = applyGoCheat(board, {
      type: "cheatTwoMoves",
      x1: 0, y1: 0,
      x2: 2, y2: 2,
    });
    expect(played?.board.rows[0]?.[0]).toBe(".");
    expect(played?.board.rows[2]?.[2]).toBe(".");
    expect(played?.captures).toBe(0);
  });

  test("a successful dispatch seed excludes ordinary placements", async () => {
    const dispatch = 10_000;
    const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));
    const decision = await decideGoNeural(
      view(1),
      goOpponentSeedCandidates(dispatch, 0),
      engine,
      dispatch,
    );
    expect(decision.action.type.startsWith("cheat") || decision.action.type === "pass").toBe(true);
    expect(decision.action.type).toBe("cheatTwoMoves");
    await engine.dispose();
  });

  test("a failed dispatch seed uses the ordinary policy", async () => {
    const dispatch = 10_000;
    const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));
    const decision = await decideGoNeural(
      view(0),
      goOpponentSeedCandidates(dispatch, 0),
      engine,
      dispatch,
    );
    expect(decision.action.type === "move" || decision.action.type === "pass").toBe(true);
    await engine.dispose();
  });
});

/** First tick on the 200 ms grid at or after `from` whose own roll relates to
 * its successor's roll as requested. The WHRNG is exact, so the search is a
 * deterministic scan, not a probabilistic one. */
function findTick(from: number, chance: number, own: boolean, next: boolean): number {
  for (let tick = from; tick < from + 4_000_000; tick += GO_ENGINE_CYCLE_MS) {
    if (goCheatSucceeds(tick, chance) === own
      && goCheatSucceeds(tick + GO_ENGINE_CYCLE_MS, chance) === next) return tick;
  }
  throw new Error("no tick with the requested roll pattern in range");
}

describe("slip-safe cheat rolls", () => {
  test("requires the dispatch tick AND its successor to pass", () => {
    const chance = 0.5;
    const unsafe = findTick(10_000, chance, true, false);
    expect(goCheatSucceeds(unsafe, chance)).toBe(true);
    expect(goCheatSucceedsSafely(unsafe, chance)).toBe(false);
    const safe = findTick(10_000, chance, true, true);
    expect(goCheatSucceedsSafely(safe, chance)).toBe(true);
  });

  test("degenerate chances behave", () => {
    for (const tick of [10_000, 123_400, 29_999_800]) {
      expect(goCheatSucceedsSafely(tick, 1)).toBe(true);
      expect(goCheatSucceedsSafely(tick, 0)).toBe(false);
    }
  });

  test("stays the conjunction of the two plain rolls across the period wrap", () => {
    const chance = 0.37;
    for (let tick = 29_998_000; tick <= 30_002_000; tick += GO_ENGINE_CYCLE_MS) {
      expect(goCheatSucceedsSafely(tick, chance)).toBe(
        goCheatSucceeds(tick, chance) && goCheatSucceeds(tick + GO_ENGINE_CYCLE_MS, chance));
    }
  });

  test("the engine skips the cheat on a tick whose successor roll fails", async () => {
    const chance = 0.5;
    const unsafe = findTick(10_000, chance, true, false);
    const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));
    const decision = await decideGoNeural(
      view(chance),
      goOpponentSeedCandidates(unsafe, 0),
      engine,
      unsafe,
    );
    expect(decision.action.type === "move" || decision.action.type === "pass").toBe(true);
    const safe = findTick(10_000, chance, true, true);
    const safeDecision = await decideGoNeural(
      view(chance),
      goOpponentSeedCandidates(safe, 0),
      engine,
      safe,
    );
    expect(safeDecision.action.type).toBe("cheatTwoMoves");
    await engine.dispose();
  });
});

describe("playbook-seeded double move", () => {
  test("the preferred first stone seeds the double and is force-retained as a finalist", async () => {
    const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));
    const dispatch = 10_000;
    const seeds = goOpponentSeedCandidates(dispatch, 0);
    const baseline = await decideGoNeural(view(1), seeds, engine, dispatch);
    expect(baseline.action.type).toBe("cheatTwoMoves");
    const baselineFirst = baseline.action.type === "cheatTwoMoves"
      ? { x: baseline.action.x1, y: baseline.action.y1 } : undefined;
    // Any empty point the stub's flat policy did not already pick first.
    const preferred = baselineFirst?.x === 3 && baselineFirst.y === 3
      ? { x: 1, y: 1 } : { x: 3, y: 3 };
    const seeded = await decideGoNeural(view(1), seeds, engine, dispatch, {
      preferredFirstMove: preferred,
    });
    // The stub's values tie everywhere, so the seeded double — inserted ahead
    // of the ranked first placements — wins the tie: the mechanism is visible
    // without a real value head.
    expect(seeded.action).toMatchObject({ type: "cheatTwoMoves", x1: preferred.x, y1: preferred.y });
    // One extra double plus the force-retained plain certified move.
    expect(seeded.finalists).toBe(baseline.finalists + 2);
    await engine.dispose();
  });

  test("an occupied preferred point is ignored", async () => {
    const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));
    const dispatch = 10_000;
    const seeds = goOpponentSeedCandidates(dispatch, 0);
    const occupied: GoView = {
      ...view(1),
      board: { size: 5, rows: ["X....", ".....", ".....", ".....", "....."] },
    };
    const baseline = await decideGoNeural(occupied, seeds, engine, dispatch);
    const seeded = await decideGoNeural(occupied, seeds, engine, dispatch, {
      preferredFirstMove: { x: 0, y: 0 },
    });
    expect(seeded.action).toEqual(baseline.action);
    expect(seeded.finalists).toBe(baseline.finalists);
    await engine.dispose();
  });
});

describe("per-size cheat limits", () => {
  test("the shared table matches the benched production values", () => {
    // The limits are hashed into every worker position identity; changing a
    // value silently re-keys the cache, so edits must come with an arena run
    // (see the table's comment). Only 5x5 has a value head: every other size
    // must stay on the greedy candidateLimit-0 path or the policy-only
    // daemon19 artifact refuses the evaluation.
    expect(GO_CHEAT_LIMITS_BY_SIZE[5]).toEqual({ candidateLimit: 4, doubleMoveLimit: 2 });
    for (const size of [7, 9, 13, 19] as const) {
      expect(GO_CHEAT_LIMITS_BY_SIZE[size]).toEqual({ candidateLimit: 0, doubleMoveLimit: 1 });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { GO_REWARD_RULES } from "../../shared/strategy/go/rewards.ts";
import type { GoView } from "../../shared/strategy/go/rules.ts";
import { mulberry32 } from "../core/rng.ts";
import { FactionSystem } from "../features/factions.ts";
import { AggregateGoNeuralRuntime } from "../features/go-aggregate-runtime.ts";
import { GoSystem } from "../features/go-system.ts";
import { GoPlayType } from "../vendor/bitburner/src/Go/Enums.ts";
import { SimWorld } from "../world.ts";

const activeView: GoView = {
  board: { size: 5, rows: [".....", ".....", ".....", ".....", "....."] },
  currentPlayer: "Black",
  opponent: "Netburners",
  status: "inProgress",
  previousBoards: [],
  komi: 1.5,
};

describe("aggregate Go simulation lane", () => {
  test("uses no WebGPU while retaining exact immediate transitions and a legal trigger", async () => {
    const runtime = new AggregateGoNeuralRuntime();
    const installed = await runtime.install(activeView);
    const evaluated = await runtime.evaluate(installed.positionId, 10_000);
    expect(evaluated.backend).toBe("aggregate");
    expect(evaluated.decision.action).toMatchObject({ type: "move" });
    expect(evaluated.decision.positionValue).toBe(GO_REWARD_RULES.Netburners.priorWinProbability);

    const completed: GoView = {
      ...activeView,
      currentPlayer: "None",
      status: "gameOver",
      nextGame: { opponent: "Daedalus", boardSize: 5 },
    };
    const next = await runtime.install(completed);
    expect((await runtime.evaluate(next.positionId, 10_000)).decision.action).toMatchObject({
      type: "newGame",
      opponent: "Daedalus",
      boardSize: 5,
    });
  });

  test("settles one seeded calibrated game with measured virtual duration and normal rewards", async () => {
    const records: Array<{ name?: string; data?: Record<string, unknown> }> = [];
    const world = new SimWorld({
      seed: 7,
      random: mulberry32(7),
      onRecord: (record) => {
        if (record.kind === "event") records.push(record as typeof records[number]);
      },
    });
    const factions = new FactionSystem(world, world.player);
    const go = new GoSystem(world, factions, mulberry32(11), "aggregate");
    const board = go.resetBoardState("Netburners", 5);
    const playable = board.reduce(
      (sum, column) => sum + [...column].filter((cell) => cell !== "#").length,
      0,
    );
    const expectedDuration = Math.round(
      playable * GO_REWARD_RULES.Netburners.aiSecondsPerPlayableNode * 1_000,
    );
    const move = board.flatMap((column, x) => [...column].map((cell, y) => ({ cell, x, y })))
      .find(({ cell }) => cell === ".")!;
    let settled = false;
    const pending = go.makeMove(move.x, move.y).finally(() => { settled = true; });
    expect(await world.clock.runAsync(() => settled, expectedDuration + 1)).toBe("goal");
    expect((await pending).type).toBe(GoPlayType.gameOver);
    expect(world.clock.now()).toBe(expectedDuration);
    expect(go.getCurrentPlayer()).toBe("None");
    expect([...go.stats.values()].reduce((sum, stat) => sum + stat.wins + stat.losses, 0)).toBe(1);
    expect(go.getGameState().blackScore).toBeGreaterThan(0);
    expect(records).toContainEqual(expect.objectContaining({
      name: "go.game",
      data: expect.objectContaining({ opponent: "Netburners", fidelity: "aggregate" }),
    }));
  });
});

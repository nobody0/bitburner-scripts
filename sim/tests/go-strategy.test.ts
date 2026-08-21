import { describe, expect, test } from "bun:test";
import { firstLegalPolicy, productionPolicy, simulateGoGameAsync } from "../features/go.ts";
import { decideGoNeural, GoNeuralEngine } from "../../shared/strategy/go/neural/engine.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";

/** Policy-level properties of the deployed neural engine.
 *
 * Strength is not measured here: `sim/tests/go-selection.test.ts` and
 * `sim/tests/go-arena.test.ts` play complete games against the vendored
 * upstream faction AI, which is the only opponent worth being scored against. */
describe("Go neural policy", () => {
  const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));

  test("play is deterministic, and ends only on two passes or the explicit cap", async () => {
    const options = { size: 5, komi: 1.5 };
    const first = await simulateGoGameAsync(productionPolicy(undefined, engine), firstLegalPolicy, options);
    const second = await simulateGoGameAsync(productionPolicy(undefined, engine), firstLegalPolicy, options);
    expect(second).toEqual(first);
    expect(first.completed || first.turns === 100).toBe(true);
  });

  test("every ranked candidate carries an exact seeded reply forecast", async () => {
    const decision = await decideGoNeural({
      board: { size: 5, rows: [".....", ".O...", ".....", ".....", "#...."] },
      currentPlayer: "Black",
      opponent: "Illuminati",
      status: "inProgress",
      previousBoards: [],
      komi: 7.5,
    }, [1_200], engine);
    expect(decision.ranked.length).toBeGreaterThan(0);
    // Illuminati's per-opponent budget is K=8, adaptively doubled on this flat
    // proposal boundary.
    expect(decision.finalists).toBe(16);
    for (const move of decision.ranked) {
      expect(move.forecastCertainty).toBe("exact");
      expect(move.predictedReplies!.length).toBeGreaterThan(0);
      expect(move.score).toBeGreaterThanOrEqual(0);
      expect(move.score).toBeLessThanOrEqual(1);
    }
  });

  test("a white pass is accepted immediately when exact komi scoring says black won", async () => {
    const decision = await decideGoNeural({
      board: { size: 5, rows: ["XXXXX", "XXXXX", "XXXXX", "XXXXX", "XXXX."] },
      currentPlayer: "Black",
      opponent: "Illuminati",
      status: "inProgress",
      previousBoards: [],
      consecutivePasses: 1,
      komi: 7.5,
    }, [1_200], engine);
    expect(decision.action).toMatchObject({ type: "pass" });
  });
});

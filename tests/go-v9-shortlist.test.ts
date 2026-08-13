import { describe, expect, test } from "bun:test";
import {
  decideGoNeural,
  GoNeuralEngine,
} from "../shared/strategy/go/neural/engine.ts";
import type {
  GoProposalRaw,
  GoValueBackend,
  GoValueBatch,
} from "../shared/strategy/go/neural/backend.ts";
import type { GoView } from "../shared/strategy/go/rules.ts";

class RecordingV9Backend implements GoValueBackend {
  readonly extent = 5;
  readonly behaviorFeatures = 31;
  proposalBatches: GoValueBatch[] = [];
  valueCounts: number[] = [];
  passOnly = false;

  evaluateProposal(batch: GoValueBatch): Promise<GoProposalRaw> {
    this.proposalBatches.push(batch);
    const candidates = this.extent * this.extent + 1;
    const moves = new Float32Array(batch.count * candidates);
    for (let row = 0; row < batch.count; row++) {
      for (let move = 0; move < candidates; move++) {
        moves[row * candidates + move] = this.passOnly
          ? (move === candidates - 1 ? 100 : -move)
          : row % 2 === 0 ? -move : move === candidates - 2 ? 100 : -move;
      }
    }
    return Promise.resolve({
      value: new Float32Array(batch.count * 3),
      moves,
    });
  }

  evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    this.valueCounts.push(batch.count);
    return Promise.resolve(new Float32Array(batch.count * 3));
  }

  dispose(): void {}
}

const view: GoView = {
  board: { size: 5, rows: [".....", ".....", ".....", ".....", "....."] },
  currentPlayer: "Black",
  opponent: "Daedalus",
  status: "inProgress",
  previousBoards: [],
  komi: 5.5,
};

describe("V9 learned shortlist", () => {
  test("scores the original board and predicts exact replies only for finalists", async () => {
    const backend = new RecordingV9Backend();
    const engine = new GoNeuralEngine(() => backend);
    const decision = await decideGoNeural(view, [10_200, 10_400], engine);

    expect(backend.proposalBatches).toHaveLength(1);
    expect(backend.proposalBatches[0]!.count).toBe(2);
    expect(backend.proposalBatches[0]!.behavior?.length).toBe(62);
    expect(decision.finalists).toBe(8);
    expect(backend.valueCounts[0]!).toBeLessThan(26);
    // Per-seed reservations retain both seeds' distinct preferred corners.
    expect(decision.ranked.some(({ x, y }) => x === 0 && y === 0)).toBe(true);
    expect(decision.ranked.some(({ x, y }) => x === 4 && y === 4)).toBe(true);
  });

  test("treats pass as a normal proposal candidate", async () => {
    const backend = new RecordingV9Backend();
    backend.passOnly = true;
    const engine = new GoNeuralEngine(() => backend);
    const decision = await decideGoNeural({ ...view, candidateLimit: 1 }, [10_200], engine);

    expect(decision.finalists).toBe(1);
    expect(decision.action.type).toBe("pass");
  });

  test("supports exhaustive shadow evaluation without letting proposals prune labels", async () => {
    const backend = new RecordingV9Backend();
    const engine = new GoNeuralEngine(() => backend);
    const decision = await decideGoNeural({
      ...view,
      candidateLimit: Number.POSITIVE_INFINITY,
    }, [10_200], engine);

    expect(decision.finalists).toBe(26);
  });

  test("rejects invalid shortlist limits instead of silently producing an empty policy", async () => {
    const backend = new RecordingV9Backend();
    const engine = new GoNeuralEngine(() => backend);
    await expect(decideGoNeural({ ...view, candidateLimit: 0 }, [10_200], engine))
      .rejects.toThrow("candidate limit must be positive");
  });
});

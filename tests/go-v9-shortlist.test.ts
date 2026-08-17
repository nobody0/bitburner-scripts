import { describe, expect, test } from "bun:test";
import {
  decideGoNeural,
  GO_OPPONENT_SEARCH,
  GO_PROFILE_CANDIDATE_LIMITS,
  GO_PROFILE_DEEP_SEARCH,
  GoNeuralEngine,
  selectV9ProposalFinalists,
} from "../shared/strategy/go/neural/engine.ts";
import type {
  GoProposalRaw,
  GoValueBackend,
  GoValueBatch,
} from "../shared/strategy/go/neural/backend.ts";
import type { GoView } from "../shared/strategy/go/rules.ts";

class RecordingV9Backend implements GoValueBackend {
  proposalBatches: GoValueBatch[] = [];
  valueCounts: number[] = [];
  valueBehaviors: Float32Array[] = [];
  valueStates: Float32Array[] = [];
  passOnly = false;

  constructor(readonly extent = 5, readonly behaviorFeatures = 31) {}

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
    this.valueBehaviors.push(new Float32Array(batch.behavior));
    this.valueStates.push(new Float32Array(batch.state));
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
  test("applies adaptive expansion, per-seed reservation, and stable proposal ties", () => {
    const moves = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const seed0 = [10, 9, 8, 7, 6, 5, 4, 3, 2.8, 0];
    const seed1 = [0, 2.8, 3, 4, 5, 6, 7, 8, 9, 10];
    const selected = selectV9ProposalFinalists(
      moves, [...seed0, ...seed1], 2, moves.length, 4);
    expect(selected.baseLimit).toBe(4);
    expect(selected.adaptiveLimit).toBe(8);
    expect(selected.perSeedReserve).toBe(2);
    expect(selected.finalists).toContain(0);
    expect(selected.finalists).toContain(9);

    const tied = selectV9ProposalFinalists([1, 0, 2], [1, 1, 0], 1, 3, 1);
    expect(tied.ranked.slice(0, 2)).toEqual([0, 1]);
    expect(tied.baseLimit).toBe(1);
    expect(tied.adaptiveLimit).toBe(1);
    expect(tied.finalists).toEqual([0]);
  });

  test("pins the per-profile production candidate limits and deep-search defaults", () => {
    expect(GO_PROFILE_CANDIDATE_LIMITS).toEqual({ small5: 4, daemon19: 1 });
    expect(GO_PROFILE_DEEP_SEARCH).toEqual({
      small5: { schema: "bitburner-go-deep-search-v1", followUpK: 3, uncertaintyTicks: 1 },
    });
  });

  test("strict K=1 keeps exactly the seed-averaged argmax even when seeds disagree", () => {
    // Seed 0 prefers move 0, seed 1 prefers move 2; the averages favor move 2.
    // Per-seed reservation would retain both; the strict contract retains one.
    const selected = selectV9ProposalFinalists(
      [0, 1, 2], [10, 0, 8, 0, 0, 14], 2, 3, 1);
    expect(selected.baseLimit).toBe(1);
    expect(selected.finalists).toEqual([2]);
  });

  test("scores the original board and predicts exact replies only for finalists", async () => {
    const backend = new RecordingV9Backend();
    const engine = new GoNeuralEngine(() => backend);
    const decision = await decideGoNeural(view, [10_200, 10_400], engine);

    expect(backend.proposalBatches).toHaveLength(1);
    expect(backend.proposalBatches[0]!.count).toBe(2);
    expect(backend.proposalBatches[0]!.behavior?.length).toBe(62);
    expect(Array.from(backend.proposalBatches[0]!.behavior!.slice(1, 4))
      .every((value) => value >= 0)).toBe(true);
    expect(decision.finalists).toBe(GO_PROFILE_CANDIDATE_LIMITS.small5);
    expect(backend.valueCounts).toHaveLength(1);
    expect(backend.valueCounts[0]!).toBeLessThan(26);
    expect(backend.valueBehaviors[0]!.length).toBe(backend.valueCounts[0]! * 31);
    for (let row = 0; row < backend.valueCounts[0]!; row++) {
      expect(Array.from(backend.valueBehaviors[0]!.slice(row * 31 + 1, row * 31 + 4)))
        .toEqual([-1, -1, -1]);
    }
    // Per-seed reservations retain both seeds' distinct preferred corners.
    expect(decision.ranked.some(({ x, y }) => x === 0 && y === 0)).toBe(true);
    expect(decision.ranked.some(({ x, y }) => x === 4 && y === 4)).toBe(true);
    // All value rows are identical, so the deployed final tie-break is the
    // first finalist in candidate scan order, not proposal rank.
    expect(decision.action).toMatchObject({ type: "move", x: 0, y: 0 });
  });

  test("strict K=1 selects from the policy alone and never dispatches the value batch", async () => {
    const backend = new RecordingV9Backend();
    const engine = new GoNeuralEngine(() => backend);
    const decision = await decideGoNeural({ ...view, candidateLimit: 1 }, [10_200], engine);

    expect(decision.finalists).toBe(1);
    expect(backend.valueCounts).toEqual([]);
    expect(decision.action).toMatchObject({ type: "move", x: 0, y: 0 });
    // The exact reply forecast still runs: push-ahead and telemetry need it.
    expect(decision.forecast!.length).toBeGreaterThan(0);
  });

  test("K=1 fast path decides identically to the full pipeline under a neutral value head", async () => {
    const fastBackend = new RecordingV9Backend();
    const fast = await decideGoNeural({ ...view, candidateLimit: 1 }, [10_200],
      new GoNeuralEngine(() => fastBackend));
    const fullBackend = new RecordingV9Backend();
    const full = await decideGoNeural({ ...view, candidateLimit: 2 }, [10_200],
      new GoNeuralEngine(() => fullBackend));

    expect(fastBackend.valueCounts).toEqual([]);
    expect(fullBackend.valueCounts).toHaveLength(1);
    expect(fast.action).toEqual(full.action);
    expect(fast.forecast).toEqual(full.forecast);
    expect(fast.ranked[0]!.score).toBe(full.ranked[0]!.score);
    expect(fast.ranked[0]!.powerPerRound).toBe(full.ranked[0]!.powerPerRound);
  });

  test("boards above 5x5 resolve the daemon19 strict K=1 deployment default", async () => {
    const backend = new RecordingV9Backend(19, 30);
    const engine = new GoNeuralEngine(() => backend);
    const decision = await decideGoNeural({
      board: { size: 13, rows: Array.from({ length: 13 }, () => ".".repeat(13)) },
      currentPlayer: "Black",
      opponent: "Illuminati",
      status: "inProgress",
      previousBoards: [],
      komi: 7.5,
    }, [10_200], engine);

    expect(decision.finalists).toBe(GO_PROFILE_CANDIDATE_LIMITS.daemon19);
    expect(backend.valueCounts).toEqual([]);
    expect(decision.action).toMatchObject({ type: "move", x: 0, y: 0 });
  });

  test("a policy-only backend rejects any K>1 request instead of mis-selecting", async () => {
    class PolicyOnlyBackend extends RecordingV9Backend {
      readonly valuePath = "absent" as const;
    }
    const engine = new GoNeuralEngine(() => new PolicyOnlyBackend());
    await expect(decideGoNeural({ ...view, candidateLimit: 2 }, [10_200], engine))
      .rejects.toThrow("policy-only");
    const k1 = await decideGoNeural({ ...view, candidateLimit: 1 }, [10_200],
      new GoNeuralEngine(() => new PolicyOnlyBackend()));
    expect(k1.finalists).toBe(1);
  });

  test("treats pass as a normal proposal candidate", async () => {
    const backend = new RecordingV9Backend();
    backend.passOnly = true;
    const engine = new GoNeuralEngine(() => backend);
    const decision = await decideGoNeural({ ...view, candidateLimit: 1 }, [10_200], engine);

    expect(decision.finalists).toBe(1);
    expect(decision.action.type).toBe("pass");
  });

  test("scores a terminal second pass exactly without value inference", async () => {
    const backend = new RecordingV9Backend();
    backend.passOnly = true;
    const engine = new GoNeuralEngine(() => backend);
    const decision = await decideGoNeural({
      ...view,
      board: { size: 5, rows: ["O....", ".....", ".....", ".....", "....."] },
      consecutivePasses: 1,
      candidateLimit: 1,
    }, [10_200], engine);

    expect(decision.action.type).toBe("pass");
    expect(decision.finalists).toBe(1);
    expect(backend.valueCounts).toEqual([]);
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

  test("deep search expands round two through one successor proposal and one value batch", async () => {
    const backend = new RecordingV9Backend();
    const engine = new GoNeuralEngine(() => backend, {}, {
      schema: "bitburner-go-deep-search-v1",
      followUpK: 2,
      uncertaintyTicks: 1,
    });
    const decision = await decideGoNeural(
      { ...view, candidateLimit: 2 }, [10_200], engine, 10_000);

    // Root proposal plus exactly one batched successor proposal.
    expect(backend.proposalBatches).toHaveLength(2);
    // Two finalists, each reply expanded over two successor dispatch ticks.
    expect(backend.proposalBatches[1]!.count).toBeGreaterThanOrEqual(4);
    // Exactly one value dispatch, and it holds round-two boards (elapsed +2),
    // never the greedy depth-one boards (+1).
    expect(backend.valueCounts).toHaveLength(1);
    const norm = 2 * 25;
    for (let row = 0; row < backend.valueCounts[0]!; row++) {
      expect(backend.valueStates[0]![row * 4 + 1]).toBeCloseTo(2 / norm, 6);
    }
    expect(decision.finalists).toBe(2);
    expect(decision.forecast!.length).toBeGreaterThan(0);
  });

  test("deep search stays inert without a dispatch tick or under strict K=1", async () => {
    const config = {
      schema: "bitburner-go-deep-search-v1",
      followUpK: 2,
      uncertaintyTicks: 0,
    } as const;
    const noTick = new RecordingV9Backend();
    await decideGoNeural({ ...view, candidateLimit: 2 }, [10_200],
      new GoNeuralEngine(() => noTick, {}, config));
    expect(noTick.proposalBatches).toHaveLength(1);
    expect(noTick.valueCounts).toHaveLength(1);

    const k1 = new RecordingV9Backend();
    await decideGoNeural({ ...view, candidateLimit: 1 }, [10_200],
      new GoNeuralEngine(() => k1, {}, config), 10_000);
    expect(k1.proposalBatches).toHaveLength(1);
    expect(k1.valueCounts).toEqual([]);
  });

  test("rejects invalid shortlist limits instead of silently producing an empty policy", async () => {
    const backend = new RecordingV9Backend();
    const engine = new GoNeuralEngine(() => backend);
    await expect(decideGoNeural({ ...view, candidateLimit: 0 }, [10_200], engine))
      .rejects.toThrow("candidate limit must be positive");
  });
});

describe("per-opponent search budget", () => {
  test("the table is scoped to opponents with replicated arena evidence", () => {
    // Illuminati only: three disjoint 384-game corpora put K=8/f5 at 865/1152
    // against the profile default's 788/1152 inside the 50 ms budget. Every
    // other 5x5 opponent is already at or near 100% and keeps the cheaper
    // profile default.
    expect(Object.keys(GO_OPPONENT_SEARCH)).toEqual(["Illuminati"]);
    expect(GO_OPPONENT_SEARCH.Illuminati).toEqual({
      candidateLimit: 8,
      deepSearch: { schema: "bitburner-go-deep-search-v1", followUpK: 5, uncertaintyTicks: 1 },
    });
  });

  test("a 5x5 Illuminati view resolves the wider root, other opponents the default", async () => {
    const engine = new GoNeuralEngine(() => new RecordingV9Backend());
    const view = (opponent: GoView["opponent"], komi: number): GoView => ({
      board: { size: 5, rows: [".....", ".....", ".....", ".....", "....."] },
      currentPlayer: "Black",
      opponent,
      status: "inProgress",
      previousBoards: [],
      consecutivePasses: 0,
      komi,
    });
    const illuminati = await decideGoNeural(view("Illuminati", 7.5), [10_200], engine, 10_000);
    const tetrads = await decideGoNeural(view("Tetrads", 5.5), [10_200], engine, 10_000);
    expect(illuminati.finalists).toBeGreaterThan(tetrads.finalists);
    await engine.dispose();
  });
});

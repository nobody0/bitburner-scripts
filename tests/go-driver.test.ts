import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import type { GoDodgeGlobals } from "../game/lib/dodge-shared.ts";
import { emptyBoard, type DriverContext } from "../game/lib/features/index.ts";
import { GO_ANCHOR_POLL_MS, goModule, setGoCheatSuccessTableForTest, setGoNeuralRuntimeForTest } from "../game/lib/features/remaining.ts";
import { GO_ENGINE_CYCLE_MS } from "../shared/strategy/go/rng.ts";
import { GO_DISPATCH_GUARD_MS } from "../shared/strategy/go/tick.ts";
import { StubGoValueBackend } from "./support/go-value-backend.ts";
import { TestGoNeuralRuntime } from "./support/go-neural-runtime.ts";
import type { GameState } from "../game/lib/state.ts";
import { emptyArbitration } from "../shared/strategy/arbiter.ts";
import { unknownForecast } from "../shared/strategy/progression/forecast.ts";
import type { GoDecision } from "../shared/strategy/go/rules.ts";
import type { GoWorkerEvaluation } from "../shared/strategy/go/neural/worker-protocol.ts";

function goState(): GameState {
  return {
    topics: {
      player: { totalPlaytime: 1_000, money: 0 },
      factions: { joined: [] },
      go: {
        status: "inProgress",
        currentPlayer: "Black",
        opponent: "Netburners",
        boardSize: 5,
        board: [".....", ".....", ".....", ".....", "....."],
        previousBoards: [[".....", ".....", ".....", ".....", "....."]],
        bonusCycles: 0,
        stats: [],
      },
      farm: {
        ramPie: { farm: 1_000, prep: 0, share: 0, free: 0, reserve: 0 },
        totals: { moneyEarned: 0, hacks: 0 },
      },
    },
    dirty: new Set(),
    mirrors: {},
    mirrorDirty: new Set(),
    probeFailures: {},
    featureLastRun: {},
  } as unknown as GameState;
}

const unknown = unknownForecast(0, "test", "test fixture");

beforeEach(() => {
  setGoNeuralRuntimeForTest(new TestGoNeuralRuntime((weights) => new StubGoValueBackend(weights)));
  goModule.reset?.(goState(), "bitnode");
});

afterAll(() => {
  setGoNeuralRuntimeForTest();
});

async function runGrantedTurn(
  state: GameState,
  stubNs: NS,
  clock?: { playtimes: number[]; sleeps: number[] },
  caps: DriverContext["caps"] = {
    bitNode: 14, sourceFiles: {}, unlocked: {}, reason: {}, restrictions: {},
  } as DriverContext["caps"],
  ramOverrides: number[] = [],
): Promise<void> {
  let dodgedPlaytime = 10_000;
  let clockRead = 0;
  const dodgedNs = {
    ...stubNs,
    go: Object.assign({
      getGameState: () => ({ bonusCycles: 0 }),
    }, stubNs.go),
    getPlayer: () => ({
      totalPlaytime: clock?.playtimes[Math.min(clockRead++, clock.playtimes.length - 1)] ?? dodgedPlaytime,
      money: 0,
    }),
    sleep: async (ms: number) => {
      if (clock) clock.sleeps.push(ms);
      else dodgedPlaytime += 200;
    },
  } as unknown as NS;
  const ns = {
    getPlayer: () => ({ totalPlaytime: 10_000, money: 0 }),
    sleep: async () => {},
    getFunctionRamCost: (method: string) => method === "go.cheat.playTwoMoves"
      ? 8 : method === "go.makeMove" ? 4 : method === "getPlayer" ? 0.5 : 0,
    exec: (_script: string, _host: string, options: { ramOverride?: number }) => {
      if (options.ramOverride !== undefined) ramOverrides.push(options.ramOverride);
      const globals = globalThis as typeof globalThis & GoDodgeGlobals;
      queueMicrotask(async () => {
        try {
          globals.go_dodge_cb?.(await globals.go_dodge_func!(dodgedNs));
        } catch (error) {
          globals.go_dodge_reject?.(error);
        }
      });
      return 1;
    },
  } as unknown as NS;
  const result = emptyArbitration();
  await goModule.driver.tick({
    ns,
    state,
    caps,
    board: emptyBoard(),
    grants: {
      money: 0,
      ramClaims: new Map([["action:turn", {
        by: "go", id: "action:turn", resource: "ram", amount: 10, priority: 50, why: "test",
      }]]),
      slot: false,
      result,
    },
    horizons: { node: unknown, install: unknown },
    acquireDodge: () => ({ host: "home", release: () => {} }),
  } as unknown as DriverContext);
  // Go intentionally finishes outside the controller's serial driver loop so
  // the opponent's wait cannot stall HWGW dispatch. Wait for that detached
  // action here; the production loop observes the same completion via wake().
  for (let turns = 0; turns < 20 && !state.topics.go?.lastTurn; turns++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!state.topics.go?.lastTurn) throw new Error("detached Go action did not complete");
}

/** Reads consumed by the anchoring dodge, which polls until totalPlaytime
 * changes: one before its first sleep, one after. A pair whose second value
 * differs anchors the 200 ms phase immediately. */
const ANCHOR_READS = [9_800, 10_000] as const;

/** Anchoring emits only short poll sleeps; a dispatch wait is longer. */
const dispatchSleeps = (sleeps: readonly number[]) => sleeps.filter((ms) => ms > GO_ANCHOR_POLL_MS);

describe("Go live seed observation", () => {
  test("finalizes and dispatches in the current public playtime slot", async () => {
    const state = goState();
    // Anchored at the start of tick 10,000, so the whole 200 ms cycle is
    // available and the turn dispatches without waiting.
    const clock = { playtimes: [...ANCHOR_READS, 10_000], sleeps: [] as number[] };
    await runGrantedTurn(state, {
      go: { makeMove: async () => ({ type: "gameOver", x: null, y: null }) },
    } as unknown as NS, clock);
    expect(dispatchSleeps(clock.sleeps)).toEqual([]);
    expect(state.topics.go?.plan?.prediction).toMatchObject({
      sampledTotalPlaytime: 10_000,
      engineCycleMs: 200,
      aiWaitMs: 200,
      seedCandidates: [10_200],
      dispatchPlaytime: 10_000,
      boundaryRetries: 0,
      waitedForRollover: false,
    });
    // Real planning time has elapsed since the anchor, so the remaining margin
    // is whatever is left of the cycle — but never inside the guard band, or
    // the turn would have targeted the next cycle instead.
    expect(state.topics.go?.plan?.prediction?.rolloverMarginMs).toBeGreaterThanOrEqual(GO_DISPATCH_GUARD_MS);
    expect(state.topics.go?.plan?.prediction?.readyToDispatchMs).toBeGreaterThanOrEqual(0);
    expect(state.topics.go?.lastTurn?.timing).toMatchObject({
      alignment: "same-slot",
      dispatchPlaytime: 10_000,
      seed: 10_200,
      readyToDispatchMs: state.topics.go?.plan?.prediction?.readyToDispatchMs,
    });
    expect(state.topics.go?.plan?.input.komi).toBe(1.5);
  });

  test("records chained Black-turn-to-dispatch latency", async () => {
    const state = goState();
    const clock = {
      playtimes: [...ANCHOR_READS, ...Array<number>(32).fill(10_000)],
      sleeps: [] as number[],
    };
    let calls = 0;
    const opponentMove = (x?: number, y?: number) => {
      for (let candidateX = 0; candidateX < 5; candidateX++) {
        for (let candidateY = 0; candidateY < 5; candidateY++) {
          if (candidateX !== x || candidateY !== y) {
            return { type: "move" as const, x: candidateX, y: candidateY };
          }
        }
      }
      return { type: "pass" as const, x: null, y: null };
    };
    const response = async (x?: number, y?: number) => {
      calls++;
      return calls === 1
        ? opponentMove(x, y)
        : { type: "gameOver" as const, x: null, y: null };
    };
    await runGrantedTurn(state, {
      go: {
        makeMove: (x: number, y: number) => response(x, y),
        passTurn: () => response(),
      },
    } as unknown as NS, clock);
    for (let attempts = 0; attempts < 20 && calls < 2; attempts++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(calls).toBe(2);
    const readyToDispatchMs = state.topics.go?.plan?.prediction?.readyToDispatchMs;
    expect(readyToDispatchMs).toBeDefined();
    expect(readyToDispatchMs!).toBeLessThan(50);
    expect(state.topics.go?.lastTurn?.timing?.readyToDispatchMs).toBe(readyToDispatchMs);
  });

  test("claims the current lifecycle action before a prior plan exists", () => {
    const state = goState();
    const context = {
      state,
      caps: { bitNode: 14, sourceFiles: {}, unlocked: {}, reason: {}, restrictions: {} },
      now: 0,
      budgetGb: 10,
      board: emptyBoard(),
      horizons: { node: unknown, install: unknown },
      ramPrice: () => 4.5,
    } as never;
    expect(goModule.claims?.(context)[0]?.id).toBe("action:turn");
    state.topics.go!.status = "waitingOnAI";
    state.topics.go!.currentPlayer = "White";
    expect(goModule.claims?.(context)[0]?.id).toBe("action:turn");
    state.topics.go!.status = "gameOver";
    state.topics.go!.currentPlayer = "None";
    expect(goModule.claims?.(context)[0]?.id).toBe("action:newGame");
  });

  test("does not reserve the bootstrap fleet until Go is a small fixed share", () => {
    const state = goState();
    state.topics.go!.previousBoards = [];
    state.topics.farm!.ramPie = { farm: 100, prep: 0, share: 0, free: 0, reserve: 0 };
    const context = {
      state,
      caps: { bitNode: 1, sourceFiles: {}, unlocked: {}, reason: {}, restrictions: {} },
      now: 0,
      budgetGb: 10,
      board: emptyBoard(),
      horizons: { node: unknown, install: unknown },
      ramPrice: () => 4.5,
    } as never;
    expect(goModule.claims?.(context)).toEqual([]);
    state.topics.farm!.ramPie.farm = 400;
    expect(goModule.claims?.(context)[0]?.id).toBe("action:turn");
  });

  test("a crossed engine boundary replans once against the tick actually in force", async () => {
    const state = goState();
    // Planning starts in tick 10,000 but the verification read shows 10,200:
    // the engine advanced while the batch was in flight.
    const clock = { playtimes: [...ANCHOR_READS, 10_000, 10_200, 10_200], sleeps: [] as number[] };
    await runGrantedTurn(state, {
      go: { makeMove: async () => ({ type: "gameOver", x: null, y: null }) },
    } as unknown as NS, clock);

    // No fixed 10 ms penalty any more: the replan is immediate, and it is
    // bounded to one because the retry dispatches against a freshly read tick.
    expect(dispatchSleeps(clock.sleeps)).toEqual([]);
    expect(state.topics.go?.plan?.prediction).toMatchObject({
      dispatchPlaytime: 10_200,
      seedCandidates: [10_400],
      boundaryRetries: 1,
    });
    expect(state.topics.go?.lastTurn?.timing?.alignment).toBe("boundary-replan");
  });

  test("a boundary replan executes the exact V9 action even when move flips to pass", async () => {
    const move: GoDecision = {
      action: { type: "move", x: 0, y: 0, why: "first seed" },
      ranked: [], why: "test", finalists: 1, positionValue: 0.5, forecast: [],
    };
    const pass: GoDecision = {
      action: { type: "pass", why: "second seed" },
      ranked: [], why: "test", finalists: 1, positionValue: 0.5, forecast: [],
    };
    const evaluation = (decision: GoDecision): GoWorkerEvaluation => ({
      decision,
      opponentSeeds: [],
      preparationMs: 0,
      finalizationMs: 0,
      modelProfile: "small5",
      modelExtent: 5,
      cached: true,
      pushed: false,
      continuations: [],
    });
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "flip", preparationMs: 0, cached: true }),
      evaluate: async (_positionId, dispatchPlaytime) => evaluation(dispatchPlaytime === 10_200 ? pass : move),
      playbook: async () => undefined,
      playbookRoute: async () => undefined,
      commit: () => "flip:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = goState();
    const clock = { playtimes: [...ANCHOR_READS, 10_000, 10_200, 10_200], sleeps: [] as number[] };
    let moves = 0;
    let passes = 0;
    await runGrantedTurn(state, {
      go: {
        makeMove: async () => { moves++; return { type: "gameOver", x: null, y: null }; },
        passTurn: async () => { passes++; return { type: "gameOver", x: null, y: null }; },
      },
    } as unknown as NS, clock);

    expect(moves).toBe(0);
    expect(passes).toBe(1);
    expect(state.topics.go?.plan?.action).toEqual({ type: "pass" });
    expect(state.topics.go?.plan?.prediction?.boundaryRetries).toBe(1);
  });

  test("dispatches a predicted successful cheat and advances the local count", async () => {
    const state = goState();
    state.topics.go!.cheat = { unlocked: true, count: 0, successChance: 1 };
    setGoCheatSuccessTableForTest([1, 1]);
    const calls: number[][] = [];
    const ramOverrides: number[] = [];
    await runGrantedTurn(state, {
      go: {
        getGameState: () => ({ bonusCycles: 17 }),
        cheat: {
          playTwoMoves: async (...coordinates: number[]) => {
            calls.push(coordinates);
            return { type: "gameOver", x: null, y: null };
          },
        },
      },
    } as unknown as NS, { playtimes: [...ANCHOR_READS, 10_000], sleeps: [] }, {
      bitNode: 1,
      sourceFiles: { "14": 2 },
      unlocked: {}, reason: {}, restrictions: {},
    } as unknown as DriverContext["caps"], ramOverrides);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
    expect(state.topics.go?.lastTurn?.action.type).toBe("cheatTwoMoves");
    expect(state.topics.go?.cheat?.count).toBe(1);
    expect(state.topics.go?.bonusCycles).toBe(17);
    // 1.6 GB stub + 8 GB cheat + 0.5 GB player read + pricing margin.
    // This catches execution accidentally resizing the granted cheat dodge to
    // the cheaper ordinary-move method list.
    expect(ramOverrides.at(-1)).toBeGreaterThan(10);
  });

  test("a reset discards an in-flight planning result before dispatch", async () => {
    let releaseBatch!: () => void;
    const batchReleased = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    let markBatchStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      markBatchStarted = resolve;
    });
    setGoNeuralRuntimeForTest(new TestGoNeuralRuntime((weights) => ({
      extent: weights.extent,
      behaviorFeatures: weights.behaviorFeatures,
      async evaluateProposal(batch) {
        const candidates = weights.extent * weights.extent + 1;
        return {
          value: new Float32Array(batch.count * 3),
          moves: new Float32Array(batch.count * candidates),
        };
      },
      async evaluateBatch(batch) {
        markBatchStarted();
        await batchReleased;
        return new Float32Array(batch.count * 3);
      },
      dispose() {},
    })));
    const state = goState();
    goModule.reset?.({ ...goState(), topics: {} } as GameState, "bitnode");
    let makeMoves = 0;
    let playtimeRead = 0;
    const dodgedNs = {
      getPlayer: () => ({ totalPlaytime: playtimeRead++ ? 10_000 : 9_800, money: 0 }),
      sleep: async () => {},
      go: {
        makeMove: async () => {
          makeMoves++;
          return { type: "gameOver", x: null, y: null };
        },
      },
    } as unknown as NS;
    const ns = {
      getFunctionRamCost: () => 1,
      exec: () => {
        const globals = globalThis as typeof globalThis & GoDodgeGlobals;
        queueMicrotask(async () => {
          try {
            globals.go_dodge_cb?.(await globals.go_dodge_func!(dodgedNs));
          } catch (error) {
            globals.go_dodge_reject?.(error);
          }
        });
        return 1;
      },
    } as unknown as NS;
    const result = emptyArbitration();
    const tick = goModule.driver.tick({
      ns,
      state,
      caps: { bitNode: 14, sourceFiles: {}, unlocked: {}, reason: {}, restrictions: {} },
      board: emptyBoard(),
      grants: {
        money: 0,
        ramClaims: new Map([["action:turn", {
          by: "go", id: "action:turn", resource: "ram", amount: 10, priority: 50, why: "test",
        }]]),
        slot: false,
        result,
      },
      horizons: { node: unknown, install: unknown },
      acquireDodge: () => ({ host: "home", release: () => {} }),
    } as unknown as DriverContext);

    await batchStarted;
    goModule.reset?.(state, "bitnode");
    releaseBatch();
    await tick;

    expect(makeMoves).toBe(0);
    expect(state.topics.go?.lastTurn).toBeUndefined();
  });

  test("a 40 ms bonus wait keeps only the two engine phases it can reach", async () => {
    const state = goState();
    state.topics.go!.bonusCycles = 2;
    const clock = { playtimes: [...ANCHOR_READS, 10_000, 10_000], sleeps: [] as number[] };
    await runGrantedTurn(state, {
      go: { makeMove: async () => ({ type: "gameOver", x: null, y: null }) },
    } as unknown as NS, clock);

    expect(state.topics.go?.plan?.prediction).toMatchObject({
      dispatchPlaytime: 10_000,
      seedCandidates: [10_000, 10_200],
      boundaryRetries: 0,
    });
  });

  test("a clock that keeps advancing replans until the dispatch read is stable", async () => {
    const state = goState();
    // Every initial read returns a later tick. Dispatching after a fixed single
    // retry knowingly used the wrong seed; the assured runner instead consumes
    // the finite drift and calls Go only once two reads agree.
    const clock = { playtimes: [...ANCHOR_READS, 10_000, 10_200, 10_400, 10_600], sleeps: [] as number[] };
    await runGrantedTurn(state, {
      go: { makeMove: async () => ({ type: "gameOver", x: null, y: null }) },
    } as unknown as NS, clock);

    expect(dispatchSleeps(clock.sleeps)).toEqual([]);
    expect(state.topics.go?.plan?.prediction?.boundaryRetries).toBe(3);
    expect(state.topics.go?.lastTurn?.opponentResponse?.type).toBe("gameOver");
  });

  test("the makeMove promise runs off-controller and productive turns bypass the failure cadence", async () => {
    const state = goState();
    goModule.reset?.({ ...goState(), topics: {} } as GameState, "bitnode");
    let makeMoves = 0;
    let opponentTurns = 0;
    // A clock that never advances: anchoring cannot observe a rollover, so the
    // turn falls back to dispatching against the tick it read. Two turns chain
    // here, and the second must not re-poll — the failed attempt is on cooldown.
    const clock = { playtimes: [10_000], sleeps: [] as number[] };
    const stubNs = {
      go: {
        makeMove: async () => {
          makeMoves++;
          return makeMoves === 1
            ? { type: "pass", x: null, y: null }
            : { type: "gameOver", x: null, y: null };
        },
        opponentNextTurn: async () => {
          opponentTurns++;
          return { type: "pass", x: null, y: null };
        },
      },
    } as unknown as NS;

    expect(goModule.driver.wake?.()).toBe(false);
    await runGrantedTurn(state, stubNs, clock);
    // The chained tick's preparation yields through real zero-delay timers, so
    // pump the clock rather than bare immediates.
    for (let waited = 0; waited < 400 && makeMoves < 2; waited++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    expect(makeMoves).toBe(2);
    expect(opponentTurns).toBe(0);
    expect(dispatchSleeps(clock.sleeps)).toEqual([]);
    // The second turn reuses the cooldown instead of polling a stuck clock again.
    expect(clock.sleeps.length).toBeLessThanOrEqual(GO_ENGINE_CYCLE_MS / GO_ANCHOR_POLL_MS + 2);
    expect(state.topics.go?.lastTurn?.opponentResponse?.type).toBe("gameOver");
    expect(goModule.driver.everyMs).toBe(5_000);
    expect(goModule.driver.wake?.()).toBe(true);
    goModule.reset?.(state, "bitnode");
    expect(goModule.driver.wake?.()).toBe(false);
  });

  test("opponentNextTurn reattaches only to an already-running white turn", async () => {
    const state = goState();
    state.topics.go!.status = "waitingOnAI";
    state.topics.go!.currentPlayer = "White";
    goModule.reset?.({ ...goState(), topics: {} } as GameState, "bitnode");
    const calls: unknown[][] = [];
    const stubNs = {
      go: {
        opponentNextTurn: async (...args: unknown[]) => {
          calls.push(args);
          return { type: "gameOver", x: null, y: null };
        },
      },
    } as unknown as NS;

    await runGrantedTurn(state, stubNs);

    expect(calls).toEqual([[false, false]]);
    expect(state.topics.go?.lastTurn?.action.type).toBe("resume");
    expect(goModule.driver.wake?.()).toBe(true);
    goModule.reset?.(state, "bitnode");
  });
});

describe("Go certified playbook integration", () => {
  const neuralMove: GoDecision = {
    action: { type: "move", x: 2, y: 2, why: "neural" },
    ranked: [], why: "test", finalists: 1, positionValue: 0.5, forecast: [],
  };
  const evaluation = (decision: GoDecision): GoWorkerEvaluation => ({
    decision,
    opponentSeeds: [],
    preparationMs: 0,
    finalizationMs: 0,
    modelProfile: "small5",
    modelExtent: 5,
    cached: true,
    pushed: false,
    continuations: [],
  });
  const playbookState = (): GameState => {
    const state = goState();
    state.topics.go!.opponent = "Illuminati";
    return state;
  };

  test("a certified hit dispatches the playbook move and spends alignment credit", async () => {
    const credits: number[] = [];
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "cert", preparationMs: 0, cached: true }),
      evaluate: async () => evaluation(neuralMove),
      playbook: async (_positionId, _dispatchPlaytime, credit) => {
        credits.push(credit);
        return {
          action: { kind: "move", x: 4, y: credits.length === 1 ? 4 : 3 },
          alignmentCredit: 5,
          alignmentBoards: 12,
        };
      },
      playbookRoute: async () => undefined,
      commit: () => "cert:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = playbookState();
    const moves: Array<[number, number]> = [];
    const stubNs = {
      go: {
        makeMove: async (x: number, y: number) => {
          moves.push([x, y]);
          // A White reply chains straight into the next Black turn, which
          // must consult with the spent credit (5 - 1) of the first hit.
          return moves.length === 1 ? { type: "move", x: 0, y: 0 } : { type: "gameOver", x: null, y: null };
        },
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });
    // Chained turns keep running after the first turn's record; settle them.
    for (let settle = 0; settle < 200 && moves.length < 2; settle++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(moves).toEqual([[4, 4], [4, 3]]);
    expect(credits).toEqual([0, 4]);
    expect(state.topics.go?.plan?.prediction?.playbook).toBe(true);
    expect(state.topics.go?.plan?.action.type).toBe("move");
    goModule.reset?.(state, "bitnode");
  });

  test("a miss keeps the neural action and carries the line credit", async () => {
    const credits: number[] = [];
    let hits = 0;
    let neuralCalls = 0;
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "miss", preparationMs: 0, cached: true }),
      evaluate: async () => evaluation({
        ...neuralMove,
        action: { type: "move", x: 2, y: ++neuralCalls, why: "neural" },
      }),
      playbook: async (_positionId, _dispatchPlaytime, credit) => {
        credits.push(credit);
        return hits++ === 0
          ? { action: { kind: "move", x: 4, y: 4 }, alignmentCredit: 5, alignmentBoards: 12 }
          : undefined;
      },
      playbookRoute: async () => undefined,
      commit: () => "miss:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = playbookState();
    const moves: Array<[number, number]> = [];
    const stubNs = {
      go: {
        makeMove: async (x: number, y: number) => {
          moves.push([x, y]);
          return moves.length < 3
            ? { type: "move", x: 0, y: moves.length - 1 }
            : { type: "gameOver", x: null, y: null };
        },
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });
    for (let settle = 0; settle < 300 && moves.length < 3; settle++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Hit at credit 0 grants 5 and spends one; the miss at credit 4 hands the
    // turn to the network but still spends a board, so the third lookup sees
    // 3 rather than 0 — that carry is what keeps a stripped entry's line
    // matchable once the network reproduces its move.
    expect(credits).toEqual([0, 4, 3]);
    expect(moves.length).toBe(3);
    expect(moves[0]).toEqual([4, 4]);
    expect(moves[1]?.[0]).toBe(2);
    expect(moves[2]?.[0]).toBe(2);
    expect(state.topics.go?.plan?.prediction?.playbook).toBeUndefined();
    goModule.reset?.(state, "bitnode");
  });

  test("a certified align entry holds the turn instead of dispatching", async () => {
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "align", preparationMs: 0, cached: true }),
      evaluate: async () => evaluation(neuralMove),
      playbook: async () => ({ action: { kind: "align" }, alignmentCredit: 0, alignmentBoards: 12 }),
      playbookRoute: async () => undefined,
      commit: () => "align:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = playbookState();
    let moves = 0;
    const stubNs = {
      go: { makeMove: async () => { moves++; return { type: "gameOver", x: null, y: null }; } },
    } as unknown as NS;
    await expect(runGrantedTurn(
      state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] },
    )).rejects.toThrow("detached Go action did not complete");
    expect(moves).toBe(0);
    expect(state.topics.go?.lastTurn).toBeUndefined();
    // The hold waits on the engine clock, so the driver asks to be re-run.
    expect(goModule.driver.wake?.()).toBe(true);
    goModule.reset?.(state, "bitnode");
  });

  test("a cheat-unlocked game never consults the playbook", async () => {
    let consulted = 0;
    setGoCheatSuccessTableForTest(Array.from({ length: 32 }, () => 1));
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "cheat", preparationMs: 0, cached: true }),
      evaluate: async () => evaluation(neuralMove),
      playbook: async () => { consulted++; return undefined; },
      playbookRoute: async () => undefined,
      commit: () => "cheat:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = playbookState();
    state.topics.go!.cheat = { unlocked: true, count: 0, successChance: 1 };
    const stubNs = {
      go: { makeMove: async () => ({ type: "gameOver", x: null, y: null }) },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });
    expect(consulted).toBe(0);
    setGoCheatSuccessTableForTest();
    goModule.reset?.(state, "bitnode");
  });

  test("a 19x19 board never consults the 5x5 playbook", async () => {
    let consulted = 0;
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "nb", preparationMs: 0, cached: true }),
      evaluate: async () => evaluation(neuralMove),
      playbook: async () => { consulted++; return undefined; },
      playbookRoute: async () => undefined,
      commit: () => "nb:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = goState();
    state.topics.go!.boardSize = 19;
    state.topics.go!.board = Array.from({ length: 19 }, () => ".".repeat(19));
    state.topics.go!.previousBoards = [state.topics.go!.board.map((column) => column)];
    const stubNs = {
      go: { makeMove: async () => ({ type: "gameOver", x: null, y: null }) },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });
    expect(consulted).toBe(0);
    expect(state.topics.go?.lastTurn?.action.type).toBe("move");
    goModule.reset?.(state, "bitnode");
  });
});

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import type { DodgeGlobals, GoDodgeGlobals } from "../game/lib/dodge-shared.ts";
import { emptyBoard, type DriverContext } from "../game/lib/features/index.ts";
import { GO_ANCHOR_POLL_MS, goModule, setGoCheatSuccessTableForTest, setGoNeuralRuntimeForTest, setGoPlaybookCheatSeedForTest } from "../game/lib/features/remaining.ts";
import { GO_ENGINE_CYCLE_MS } from "../shared/strategy/go/rng.ts";
import { GO_DISPATCH_GUARD_MS } from "../shared/strategy/go/tick.ts";
import { StubGoValueBackend } from "./support/go-value-backend.ts";
import { TestGoNeuralRuntime } from "./support/go-neural-runtime.ts";
import type { GameState } from "../game/lib/state.ts";
import { emptyArbitration } from "../shared/strategy/arbiter.ts";
import { unknownForecast } from "../shared/strategy/progression/forecast.ts";
import { scoreBoard, territory } from "../shared/strategy/go/rules.ts";
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
      // The post-turn verification reads these. Default to agreeing with the
      // mirror so ordinary turns verify clean; a test that wants drift
      // overrides getBoardState in its own stubNs.go.
      getBoardState: () => state.topics.go?.board ?? [],
      getMoveHistory: () => state.topics.go?.previousBoards ?? [],
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
      ? 8 : method === "go.makeMove" || method === "go.getBoardState" ? 4
        : method === "getPlayer" ? 0.5 : 0,
    // The 4th argument is the lane (dodge.ts passes lane.laneArg). The turn
    // runs on "long"; the post-turn board verification runs on the ordinary
    // lane, which uses a different global slot set — servicing only the long
    // slots would hang that dodge until its watchdog.
    exec: (_script: string, _host: string, options: { ramOverride?: number }, lane?: string) => {
      if (options.ramOverride !== undefined) ramOverrides.push(options.ramOverride);
      const globals = globalThis as typeof globalThis & DodgeGlobals & GoDodgeGlobals;
      queueMicrotask(async () => {
        if (lane === "long") {
          try {
            globals.go_dodge_cb?.(await globals.go_dodge_func!(dodgedNs));
          } catch (error) {
            globals.go_dodge_reject?.(error);
          }
          return;
        }
        try {
          globals.dodge_cb?.(await globals.dodge_func!(dodgedNs));
        } catch (error) {
          globals.dodge_reject?.(error);
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
        by: "go", id: "action:turn", resource: "ram", amount: 10, priority: 50,
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
    expect(state.topics.go?.lastTurn?.prediction).toMatchObject({
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
    expect(state.topics.go?.lastTurn?.prediction?.rolloverMarginMs).toBeGreaterThanOrEqual(GO_DISPATCH_GUARD_MS);
    // The segments partition the total, so a slow worker is separable from the
    // deliberate wait for the next engine cycle. This turn waited for neither.
    const breakdown = state.topics.go?.lastTurn?.prediction?.dispatchBreakdown;
    expect(breakdown).toBeDefined();
    expect(breakdown!.alignMs).toBe(0);
    const named = breakdown!.admitMs + breakdown!.prepareMs + breakdown!.leaseMs
      + breakdown!.finalizeMs + breakdown!.alignMs + breakdown!.dispatchMs + breakdown!.residualMs;
    expect(named).toBe(breakdown!.totalMs);
    expect(state.topics.go?.plan?.input.komi).toBe(1.5);
  });

  test("publishes a score and territory that match the board beside them", async () => {
    // The fixture has no komi: the core probe has not run yet, which is the
    // state every new game starts in. The score used to be withheld in that
    // window, leaving the PREVIOUS game's numbers next to a fresh board.
    const state = goState();
    expect(state.topics.go?.komi).toBeUndefined();
    const clock = { playtimes: [...ANCHOR_READS, 10_000], sleeps: [] as number[] };
    await runGrantedTurn(state, {
      go: { makeMove: async () => ({ type: "move", x: 4, y: 4 }) },
    } as unknown as NS, clock);

    const go = state.topics.go!;
    expect(go.komi).toBe(1.5);
    const board = { rows: go.board!, size: go.boardSize! };
    expect(go.blackScore).toBe(scoreBoard(board, go.komi!).X);
    expect(go.whiteScore).toBe(scoreBoard(board, go.komi!).O);
    const owned = territory(board);
    expect(go.territory).toEqual({ black: owned.X, white: owned.O });
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
    // The next turn's provisional plan has already been published by now, so a
    // digest parked on `plan` would have been replaced before any viewer saw
    // it. Reading it back here proves it rides the turn record instead.
    const breakdown = state.topics.go?.lastTurn?.prediction?.dispatchBreakdown;
    expect(breakdown).toBeDefined();
    expect(breakdown!.totalMs).toBeLessThan(50);
    expect(state.topics.go?.plan).toBeDefined();
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
    expect(state.topics.go?.lastTurn?.prediction).toMatchObject({
      dispatchPlaytime: 10_200,
      seedCandidates: [10_400],
      boundaryRetries: 1,
    });
  });

  test("a boundary replan executes the exact V9 action even when move flips to pass", async () => {
    const move: GoDecision = {
      action: { type: "move", x: 0, y: 0 },
      ranked: [], finalists: 1, positionValue: 0.5, forecast: [],
    };
    const pass: GoDecision = {
      action: { type: "pass" },
      ranked: [], finalists: 1, positionValue: 0.5, forecast: [],
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
    expect(state.topics.go?.lastTurn?.prediction?.boundaryRetries).toBe(1);
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
    // the cheaper ordinary-move method list. Not `.at(-1)`: the post-turn board
    // verification runs its own smaller stub after the turn, so the cheat grant
    // is no longer necessarily the last exec.
    expect(ramOverrides.some((gb) => gb > 10)).toBe(true);
    // This turn ends the game, where the post-turn verification is skipped by
    // design (newGame's resetBoardState returns the game's own rows next).
    expect(ramOverrides).not.toContain(6.1);
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
          by: "go", id: "action:turn", resource: "ram", amount: 10, priority: 50,
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

    expect(state.topics.go?.lastTurn?.prediction).toMatchObject({
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
    expect(state.topics.go?.lastTurn?.prediction?.boundaryRetries).toBe(3);
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
    action: { type: "move", x: 2, y: 2 },
    ranked: [], finalists: 1, positionValue: 0.5, forecast: [],
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
    expect(state.topics.go?.lastTurn?.prediction?.playbook).toBe(true);
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
        action: { type: "move", x: 2, y: ++neuralCalls },
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
    expect(state.topics.go?.lastTurn?.prediction?.playbook).toBeUndefined();
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

  test("an unseeded cheat game consults the playbook and the certified move overrides an engine cheat", async () => {
    let consulted = 0;
    const preferreds: ({ x: number; y: number } | undefined)[] = [];
    setGoCheatSuccessTableForTest(Array.from({ length: 32 }, () => 1));
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "cheat", preparationMs: 0, cached: true }),
      // The engine would cheat on this roll-safe tick; the certified move
      // must still win because Illuminati has no cheatSeedFromTurn.
      evaluate: async (_positionId, _dispatchPlaytime, _parent, preferredFirstMove) => {
        preferreds.push(preferredFirstMove);
        return evaluation({ ...neuralMove,
          action: { type: "cheatTwoMoves", x1: 1, y1: 1, x2: 0, y2: 0 } });
      },
      playbook: async () => {
        consulted++;
        return { action: { kind: "move", x: 4, y: 4 }, alignmentCredit: 5, alignmentBoards: 12 };
      },
      playbookRoute: async () => undefined,
      commit: () => "cheat:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = playbookState();
    state.topics.go!.cheat = { unlocked: true, count: 0, successChance: 1 };
    const moves: Array<[number, number]> = [];
    let cheats = 0;
    const stubNs = {
      go: {
        makeMove: async (x: number, y: number) => {
          moves.push([x, y]);
          return { type: "gameOver", x: null, y: null };
        },
        cheat: {
          playTwoMoves: async () => { cheats++; return { type: "gameOver", x: null, y: null }; },
        },
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs,
      { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] }, cheatCaps);
    expect(consulted).toBeGreaterThan(0);
    expect(preferreds[0]).toBeUndefined();
    expect(cheats).toBe(0);
    expect(moves).toEqual([[4, 4]]);
    expect(state.topics.go?.lastTurn?.prediction?.playbook).toBe(true);
    setGoCheatSuccessTableForTest();
    goModule.reset?.(state, "bitnode");
  });

  const cheatCaps = {
    bitNode: 1,
    sourceFiles: { "14": 2 },
    unlocked: {}, reason: {}, restrictions: {},
  } as unknown as DriverContext["caps"];

  test("past cheatSeedFromTurn the double is seeded from the certified stone and leaves the line", async () => {
    const credits: number[] = [];
    const preferreds: ({ x: number; y: number } | undefined)[] = [];
    setGoPlaybookCheatSeedForTest({ Illuminati: 0 });
    setGoCheatSuccessTableForTest(Array.from({ length: 32 }, () => 1));
    let playbookCalls = 0;
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "seeded", preparationMs: 0, cached: true }),
      evaluate: async (_positionId, _dispatchPlaytime, _parent, preferredFirstMove) => {
        preferreds.push(preferredFirstMove);
        return evaluation(preferredFirstMove
          ? { ...neuralMove, action: {
            type: "cheatTwoMoves",
            x1: preferredFirstMove.x, y1: preferredFirstMove.y, x2: 0, y2: 0,
          } }
          : neuralMove);
      },
      playbook: async (_positionId, _dispatchPlaytime, credit) => {
        credits.push(credit);
        return playbookCalls++ === 0
          ? { action: { kind: "move", x: 4, y: 4 }, alignmentCredit: 5, alignmentBoards: 12 }
          : undefined;
      },
      playbookRoute: async () => undefined,
      commit: () => "seeded:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = playbookState();
    state.topics.go!.cheat = { unlocked: true, count: 0, successChance: 1 };
    const cheats: number[][] = [];
    const moves: Array<[number, number]> = [];
    const stubNs = {
      go: {
        cheat: {
          playTwoMoves: async (...coordinates: number[]) => {
            cheats.push(coordinates);
            // The cheat succeeds and White replies: the game continues so the
            // next turn can prove the line credit was zeroed, not spent to 4.
            return { type: "move", x: 2, y: 2 };
          },
        },
        makeMove: async (x: number, y: number) => {
          moves.push([x, y]);
          return { type: "gameOver", x: null, y: null };
        },
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs,
      { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] }, cheatCaps);
    for (let settle = 0; settle < 300 && moves.length < 1; settle++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(cheats).toEqual([[4, 4, 0, 0]]);
    // The engine-chosen cheat wins over the certified move: it is not a
    // certified dispatch, so the record carries no playbook flag...
    expect(state.topics.go?.lastTurn?.prediction?.playbook).toBeUndefined();
    // ...and the certified move rode into the evaluation as the seed.
    expect(preferreds[0]).toEqual({ x: 4, y: 4 });
    // The dispatched cheat abandoned the line: the follow-up turn consults at
    // credit 0, not at the certified grant's 5 - 1.
    expect(credits).toEqual([0, 0]);
    expect(moves).toHaveLength(1);
    setGoCheatSuccessTableForTest();
    setGoPlaybookCheatSeedForTest();
    goModule.reset?.(state, "bitnode");
  });

  test("a certified move still overrides when the engine keeps plain play", async () => {
    const preferreds: ({ x: number; y: number } | undefined)[] = [];
    setGoPlaybookCheatSeedForTest({ Illuminati: 0 });
    setGoCheatSuccessTableForTest(Array.from({ length: 32 }, () => 1));
    setGoNeuralRuntimeForTest({
      install: async () => ({ positionId: "kept", preparationMs: 0, cached: true }),
      evaluate: async (_positionId, _dispatchPlaytime, _parent, preferredFirstMove) => {
        preferreds.push(preferredFirstMove);
        return evaluation(neuralMove);
      },
      playbook: async () => ({
        action: { kind: "move", x: 4, y: 4 }, alignmentCredit: 5, alignmentBoards: 12,
      }),
      playbookRoute: async () => undefined,
      commit: () => "kept:test",
      confirm() {},
      async reset() {},
      dispose() {},
    });
    const state = playbookState();
    state.topics.go!.cheat = { unlocked: true, count: 0, successChance: 1 };
    const moves: Array<[number, number]> = [];
    const stubNs = {
      go: {
        makeMove: async (x: number, y: number) => {
          moves.push([x, y]);
          return { type: "gameOver", x: null, y: null };
        },
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs,
      { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] }, cheatCaps);

    expect(moves).toEqual([[4, 4]]);
    expect(preferreds[0]).toEqual({ x: 4, y: 4 });
    expect(state.topics.go?.lastTurn?.prediction?.playbook).toBe(true);
    setGoCheatSuccessTableForTest();
    setGoPlaybookCheatSeedForTest();
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

describe("Go board desync recovery", () => {
  // The mirror is advanced by applying rules LOCALLY; the game is the authority.
  // Every one of these asserts the SAME recovery, reached by a different route,
  // because the invalidation keys on whether a board-changing call was issued —
  // never on what any error said.

  test("a board the game disagrees with is detected and rebuilt, not replanned", async () => {
    const state = goState();
    const stubNs = {
      go: {
        makeMove: async (x: number, y: number) => ({ type: "move", x: x === 0 ? 4 : 0, y: y === 0 ? 4 : 0 }),
        // The game's rows, and they are not the mirror's.
        getBoardState: () => ["XXXXX", ".....", ".....", ".....", "....."],
        getMoveHistory: () => [],
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });

    // The drift is recorded, and the chained continuation rebuilds from the
    // game in the same breath — the whole point being that it never replans on
    // a board the game does not agree with.
    for (let settle = 0; settle < 200 && !state.topics.go?.boardResyncs; settle++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(state.topics.go?.lastTurn?.boardVerify?.result).toBe("drift");
    expect(state.topics.go?.boardDrifts).toBe(1);
    expect(state.topics.go?.boardResyncs).toBe(1);
    expect(state.topics.go?.lastBoardResyncReason).toContain("board");
    expect(state.topics.go?.boardUnverified).toBe(false);
    expect(state.topics.go?.board).toEqual(["XXXXX", ".....", ".....", ".....", "....."]);
    goModule.reset?.(state, "bitnode");
  });

  test("a history the game disagrees with is drift even when the rows match", async () => {
    const state = goState();
    const stubNs = {
      go: {
        makeMove: async (x: number, y: number) => ({ type: "move", x: x === 0 ? 4 : 0, y: y === 0 ? 4 : 0 }),
        // Rows agree, superko history does not — the case the board read alone
        // can never see, and the one that indicts the local rules.
        getBoardState: () => state.topics.go?.board ?? [],
        getMoveHistory: () => [],
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });

    for (let settle = 0; settle < 200 && !state.topics.go?.boardResyncs; settle++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(state.topics.go?.lastTurn?.boardVerify?.result).toBe("drift");
    expect(state.topics.go?.lastBoardResyncReason).toContain("history");
    expect(state.topics.go?.boardResyncs).toBe(1);
    expect(state.topics.go?.boardUnverified).toBe(false);
    goModule.reset?.(state, "bitnode");
  });

  test("a refused move rebuilds from the game instead of replanning it forever", async () => {
    const state = goState();
    let attempts = 0;
    let hydrations = 0;
    const stubNs = {
      go: {
        // The wedge as observed in-game: the mirror believes a point is empty
        // and the game refuses it.
        makeMove: async () => {
          attempts++;
          throw new Error("go.makeMove: The point 2,1 is occupied by a router, so you cannot place a router there");
        },
        getBoardState: () => {
          hydrations++;
          return ["XX...", ".....", ".....", ".....", "....."];
        },
        getMoveHistory: () => [],
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });

    expect(attempts).toBe(1);
    expect(state.topics.go?.lastTurn?.ok).toBe(false);
    // The board is still shown (never blanked), but it is no longer trusted.
    expect(state.topics.go?.board).toBeDefined();
    expect(state.topics.go?.boardUnverified).toBe(true);

    // THE POINT OF THE FIX: the next pass reads the game rather than dispatching
    // the same illegal move again.
    const before = hydrations;
    // A failed turn releases its claim on the completion edge, so the first pass
    // after it is consumed by that transition; the next one rebuilds.
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });
    expect(hydrations).toBeGreaterThan(before);
    expect(attempts).toBe(1);
    expect(state.topics.go?.board).toEqual(["XX...", ".....", ".....", ".....", "....."]);
    expect(state.topics.go?.boardUnverified).toBe(false);
    expect(state.topics.go?.boardResyncs).toBe(1);
    // Published with the resync that fixed it: a refused turn shows a failure in
    // lastTurn, but a silent divergence would show nothing without this.
    expect(state.topics.go?.lastBoardResyncReason).toContain("refused");
    goModule.reset?.(state, "bitnode");
  });

  test("a clean turn verifies and leaves nothing to resync", async () => {
    const state = goState();
    const stubNs = {
      go: {
        makeMove: async (x: number, y: number) => ({ type: "move", x: x === 0 ? 4 : 0, y: y === 0 ? 4 : 0 }),
      },
    } as unknown as NS;
    await runGrantedTurn(state, stubNs, { playtimes: [...ANCHOR_READS, 10_000, 10_000, 10_000], sleeps: [] });

    expect(state.topics.go?.lastTurn?.boardVerify?.result).toBe("match");
    expect(state.topics.go?.boardUnverified).toBe(false);
    expect(state.topics.go?.boardDrifts).toBeUndefined();
    expect(state.topics.go?.boardResyncs).toBeUndefined();
    goModule.reset?.(state, "bitnode");
  });
});

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import type { GoDodgeGlobals } from "../game/lib/go-dodge-shared.ts";
import { emptyBoard, type DriverContext } from "../game/lib/features/index.ts";
import { GO_ANCHOR_POLL_MS, goModule, setGoBackendFactoryForTest } from "../game/lib/features/remaining.ts";
import { GO_ENGINE_CYCLE_MS } from "../shared/strategy/go/rng.ts";
import { StubGoValueBackend } from "./support/go-value-backend.ts";
import type { GameState } from "../game/lib/state.ts";
import { resolveClaims } from "../shared/strategy/arbiter.ts";
import { unknownForecast } from "../shared/strategy/progression/forecast.ts";

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
    probeSkips: {},
    featureLastRun: {},
  } as unknown as GameState;
}

const unknown = unknownForecast(0, "test", "test fixture");

beforeEach(() => {
  setGoBackendFactoryForTest((weights) => new StubGoValueBackend(weights));
  goModule.reset?.(goState(), "bitnode");
});

afterAll(() => {
  setGoBackendFactoryForTest();
});

async function runGrantedTurn(
  state: GameState,
  stubNs: NS,
  clock?: { playtimes: number[]; sleeps: number[] },
): Promise<void> {
  let dodgedPlaytime = 10_000;
  let clockRead = 0;
  const dodgedNs = {
    ...stubNs,
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
  const result = resolveClaims({
    now: 0,
    pools: { money: 0, ram: 10 },
    claims: [{ by: "go", id: "action:turn", resource: "ram", amount: 10, priority: 50, mode: "spend", why: "test" }],
  });
  await goModule.driver.tick({
    ns,
    state,
    caps: { bitNode: 14, sourceFiles: {}, unlocked: {}, reason: {}, restrictions: {} },
    board: emptyBoard(),
    grants: { money: 0, ram: 10, slot: false, result },
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
    expect(state.topics.go?.plan?.prediction?.rolloverMarginMs).toBeGreaterThanOrEqual(20);
    expect(state.topics.go?.lastTurn?.timing).toMatchObject({
      alignment: "same-slot",
      dispatchPlaytime: 10_000,
      seed: 10_200,
    });
    expect(state.topics.go?.plan?.input.komi).toBe(1.5);
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

  test("a clock that keeps advancing still dispatches after exactly one replan", async () => {
    const state = goState();
    // Every read returns a later tick. The old design retried per crossing and
    // could stack delays; this one accepts the second read and dispatches, so
    // a pathologically drifting clock costs one replan, never a loop.
    const clock = { playtimes: [...ANCHOR_READS, 10_000, 10_200, 10_400, 10_600], sleeps: [] as number[] };
    await runGrantedTurn(state, {
      go: { makeMove: async () => ({ type: "gameOver", x: null, y: null }) },
    } as unknown as NS, clock);

    expect(dispatchSleeps(clock.sleeps)).toEqual([]);
    expect(state.topics.go?.plan?.prediction?.boundaryRetries).toBe(1);
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

import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import type { DodgeGlobals } from "../game/lib/dodge-shared.ts";
import { emptyBoard, selectDue, type DriverContext } from "../game/lib/features/index.ts";
import { goModule } from "../game/lib/features/remaining.ts";
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
        previousBoards: [],
        bonusCycles: 0,
        stats: [],
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

async function runGrantedTurn(
  state: GameState,
  action: "move" | "resume",
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
      const globals = globalThis as typeof globalThis & DodgeGlobals;
      queueMicrotask(async () => {
        try {
          globals.dodge_cb?.(await globals.dodge_func!(dodgedNs));
        } catch (error) {
          globals.dodge_reject?.(error);
        }
      });
      return 1;
    },
  } as unknown as NS;
  const result = resolveClaims({
    now: 0,
    pools: { money: 0, ram: 10 },
    claims: [{ by: "go", id: `action:${action}`, resource: "ram", amount: 10, priority: 50, mode: "spend", why: "test" }],
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
}

describe("Go live seed observation", () => {
  test("finalizes and dispatches in the current public playtime slot", async () => {
    const state = goState();
    await runGrantedTurn(state, "move", {
      go: { makeMove: async () => ({ type: "pass", x: null, y: null }) },
    } as unknown as NS);
    expect(state.topics.go?.plan?.prediction).toMatchObject({
      sampledTotalPlaytime: 10_000,
      engineCycleMs: 200,
      aiWaitMs: 200,
      seedCandidates: [10_200],
      dispatchPlaytime: 10_000,
      boundaryRetries: 0,
    });
    expect(state.topics.go?.lastTurn?.timing).toMatchObject({
      alignment: "same-slot",
      dispatchPlaytime: 10_000,
      seed: 10_200,
    });
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
    expect(goModule.claims?.(context)[0]?.id).toBe("action:move");
    state.topics.go!.status = "waitingOnAI";
    state.topics.go!.currentPlayer = "White";
    expect(goModule.claims?.(context)[0]?.id).toBe("action:resume");
    state.topics.go!.status = "gameOver";
    state.topics.go!.currentPlayer = "None";
    expect(goModule.claims?.(context)[0]?.id).toBe("action:newGame");
  });

  test("a crossed engine boundary pays only one 10 ms replan", async () => {
    const state = goState();
    const clock = { playtimes: [10_000, 10_200, 10_200, 10_200], sleeps: [] as number[] };
    await runGrantedTurn(state, "move", {
      go: { makeMove: async () => ({ type: "pass", x: null, y: null }) },
    } as unknown as NS, clock);

    expect(clock.sleeps).toEqual([10]);
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
    await runGrantedTurn(state, "move", {
      go: { makeMove: async () => ({ type: "pass", x: null, y: null }) },
    } as unknown as NS);

    expect(state.topics.go?.plan?.prediction).toMatchObject({
      dispatchPlaytime: 10_000,
      seedCandidates: [10_000, 10_200],
      boundaryRetries: 0,
    });
  });

  test("the makeMove promise wakes the next controller pass without waiting five seconds", async () => {
    const state = goState();
    goModule.reset?.({ ...goState(), topics: {} } as GameState, "bitnode");
    let makeMoves = 0;
    let opponentTurns = 0;
    const stubNs = {
      go: {
        makeMove: async () => {
          makeMoves++;
          return { type: "pass", x: null, y: null };
        },
        opponentNextTurn: async () => {
          opponentTurns++;
          return { type: "pass", x: null, y: null };
        },
      },
    } as unknown as NS;

    expect(goModule.driver.wake?.()).toBe(false);
    await runGrantedTurn(state, "move", stubNs);

    expect(makeMoves).toBe(1);
    expect(opponentTurns).toBe(0);
    expect(state.topics.go?.lastTurn?.opponentResponse?.type).toBe("pass");
    expect(goModule.driver.everyMs).toBe(5_000);
    expect(goModule.driver.wake?.()).toBe(true);
    const caps = {
      bitNode: 14,
      sourceFiles: {},
      unlocked: { go: "yes" },
      reason: {},
      restrictions: {},
    } as never;
    expect(selectDue([goModule.driver], { go: 9_999 }, caps, 10_000)).toEqual([goModule.driver]);
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
          return { type: "pass", x: null, y: null };
        },
      },
    } as unknown as NS;

    await runGrantedTurn(state, "resume", stubNs);

    expect(calls).toEqual([[false, false]]);
    expect(state.topics.go?.lastTurn?.action.type).toBe("resume");
    expect(goModule.driver.wake?.()).toBe(true);
    goModule.reset?.(state, "bitnode");
  });
});

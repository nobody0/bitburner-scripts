import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { runGoNeuralSeedDispatch } from "../game/lib/go-neural.ts";
import type { GoTickPhase } from "../shared/strategy/go/tick.ts";

function player(totalPlaytime: number): ReturnType<NS["getPlayer"]> {
  return { totalPlaytime } as ReturnType<NS["getPlayer"]>;
}

describe("seed-assured Go neural dispatch", () => {
  const phase: GoTickPhase = { wallAt: 1_000, playtime: 10_000 };

  test("uses the current tick without sleeping when inference finishes safely", async () => {
    let wall = 1_020;
    const sleeps: number[] = [];
    const inferred: number[] = [];
    const dispatched: number[] = [];
    const result = await runGoNeuralSeedDispatch({
      phase,
      clock: {
        now: () => wall,
        player: () => player(wall < 1_200 ? 10_000 : 10_200),
        sleep: async (ms) => { sleeps.push(ms); wall += ms; },
      },
      infer: async (_player, target) => {
        inferred.push(target!.targetPlaytime);
        wall += 30;
        return target!.targetPlaytime;
      },
      dispatch: async (value) => { dispatched.push(value); return "ok"; },
    });

    expect(inferred).toEqual([10_000]);
    expect(dispatched).toEqual([10_000]);
    expect(sleeps).toEqual([]);
    expect(result.boundaryRetries).toBe(0);
  });

  test("guards only the final read-to-call boundary", async () => {
    let wall = 1_199; // One millisecond remains: inside the 2 ms guard.
    const sleeps: number[] = [];
    const result = await runGoNeuralSeedDispatch({
      phase,
      clock: {
        now: () => wall,
        player: () => player(wall < 1_200 ? 10_000 : 10_200),
        sleep: async (ms) => { sleeps.push(ms); wall += ms; },
      },
      infer: async (_player, target) => {
        expect(target?.targetPlaytime).toBe(10_200);
        wall += 0.5;
        return "decision";
      },
      dispatch: async () => "ok",
    });

    expect(sleeps).toEqual([1.5]);
    expect(result.attempt.dispatchPlaytime).toBe(10_200);
    expect(result.boundaryRetries).toBe(0);
  });

  test("adds no sleep when inference itself carries the turn into the target tick", async () => {
    let wall = 1_199;
    const sleeps: number[] = [];
    const result = await runGoNeuralSeedDispatch({
      phase,
      clock: {
        now: () => wall,
        player: () => player(wall < 1_200 ? 10_000 : 10_200),
        sleep: async (ms) => { sleeps.push(ms); wall += ms; },
      },
      infer: async () => { wall += 5; return "decision"; },
      dispatch: async () => "ok",
    });

    expect(sleeps).toEqual([]);
    expect(result.attempt.dispatchPlaytime).toBe(10_200);
  });

  test("an inference overrun replans instead of dispatching with the wrong seed", async () => {
    let wall = 1_140;
    const inferred: number[] = [];
    const dispatched: number[] = [];
    const result = await runGoNeuralSeedDispatch({
      phase,
      clock: {
        now: () => wall,
        player: () => player(wall < 1_200 ? 10_000 : wall < 1_400 ? 10_200 : 10_400),
        sleep: async (ms) => { wall += ms; },
      },
      infer: async (_player, target) => {
        inferred.push(target!.targetPlaytime);
        wall += inferred.length === 1 ? 80 : 20;
        return target!.targetPlaytime;
      },
      dispatch: async (value) => { dispatched.push(value); return "ok"; },
    });

    expect(inferred).toEqual([10_000, 10_200]);
    expect(dispatched).toEqual([10_200]);
    expect(result.boundaryRetries).toBe(1);
  });

  test("an early rollover timer polls forward without repeating inference", async () => {
    let wall = 1_199;
    let enginePlaytime = 10_000;
    let readsAfterSleep = 0;
    let inferences = 0;
    const sleeps: number[] = [];
    const result = await runGoNeuralSeedDispatch({
      phase,
      clock: {
        now: () => wall,
        player: () => {
          if (wall >= 1_201 && readsAfterSleep++ >= 1) enginePlaytime = 10_200;
          return player(enginePlaytime);
        },
        sleep: async (ms) => { sleeps.push(ms); wall += ms; },
      },
      infer: async () => { inferences++; return "decision"; },
      dispatch: async () => "ok",
    });

    expect(inferences).toBe(1);
    expect(sleeps).toEqual([2, 2]);
    expect(result.attempt.dispatchPlaytime).toBe(10_200);
  });

  test("1,024 varied inference runtimes all dispatch in their predicted tick", async () => {
    let random = 0x51eed;
    const nextRandom = () => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      return random;
    };
    let correct = 0;
    for (let trial = 0; trial < 1_024; trial++) {
      const offset = nextRandom() % 200;
      let wall = 1_000 + offset;
      const playtime = () => 10_000 + Math.floor((wall - 1_000) / 200) * 200;
      const result = await runGoNeuralSeedDispatch({
        phase,
        clock: {
          now: () => wall,
          player: () => player(playtime()),
          sleep: async (ms) => { wall += ms; },
        },
        infer: async (_player, target) => {
          // Model browser/GPU jitter without manufacturing a fixed runtime.
          wall += nextRandom() % 61;
          return target!.targetPlaytime;
        },
        dispatch: async (predictedTick) => {
          expect(playtime()).toBe(predictedTick);
          correct++;
          return "ok";
        },
      });
      expect(result.attempt.player.totalPlaytime).toBe(result.attempt.dispatchPlaytime);
    }
    expect(correct).toBe(1_024);
  });
});

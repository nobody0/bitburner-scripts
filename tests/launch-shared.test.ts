import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  captureLaunch,
  handoffLaunch,
  resetLaunchState,
  temporaryRunOptions,
  type ScriptLaunch,
} from "../game/lib/launch-shared.ts";

interface TestLaunch extends ScriptLaunch {
  readonly kind: "test";
  readonly value: number;
}

describe("script launch process identity", () => {
  beforeEach(resetLaunchState);
  afterEach(resetLaunchState);

  test("automation launches skip duplicate checks", () => {
    expect(temporaryRunOptions({ threads: 2, preventDuplicates: true })).toEqual({
      threads: 2,
      temporary: true,
      preventDuplicates: false,
    });
  });

  test("every exec receives one monotonically increasing scalar key", async () => {
    const args: unknown[][] = [];
    for (let value = 1; value <= 3; value++) {
      const pid = await handoffLaunch<TestLaunch>(
        { kind: "test", value },
        (...launchArgs) => {
          args.push(launchArgs);
          expect(captureLaunch<TestLaunch>("test", launchArgs[0])).toEqual({ kind: "test", value });
          return 100 + value;
        },
      );
      expect(pid).toBe(100 + value);
    }

    expect(args).toEqual([[1], [2], [3]]);
  });

  test("launches overlap: a slow child never holds up another", async () => {
    // Descriptors are keyed by launch id, so a slow child cannot serialize a
    // later independent launch.
    // darknet vantage open its frontier one host at a time.
    const acknowledge: (() => void)[] = [];
    const captured: number[] = [];
    const started: number[] = [];

    const launches = [1, 2, 3].map((value) => handoffLaunch<TestLaunch>(
      { kind: "test", value },
      (launchId) => {
        started.push(value);
        // The child boots LATER, out of order, exactly as the engine does it.
        acknowledge.push(() => {
          captured.push(captureLaunch<TestLaunch>("test", launchId)!.value);
        });
        return 100 + value;
      },
    ));

    // All three published and exec'd without any of them having booted.
    expect(started).toEqual([1, 2, 3]);

    acknowledge[2]!();
    acknowledge[0]!();
    acknowledge[1]!();
    expect(await Promise.all(launches)).toEqual([101, 102, 103]);
    // Each child found its OWN descriptor despite the scrambled order.
    expect(captured).toEqual([3, 1, 2]);
  });

  test("an unacknowledged child gets a 0 without stalling the next launch", async () => {
    expect(await handoffLaunch<TestLaunch>(
      { kind: "test", value: 1 },
      () => 101,
    )).toBe(0);

    expect(await handoffLaunch<TestLaunch>(
      { kind: "test", value: 2 },
      (launchId) => {
        expect(captureLaunch<TestLaunch>("test", launchId)?.value).toBe(2);
        return 102;
      },
    )).toBe(102);
  });
});

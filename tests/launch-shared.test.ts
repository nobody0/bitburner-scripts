import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  captureLaunch,
  handoffLaunch,
  resetLaunchState,
  type ScriptLaunch,
} from "../game/lib/launch-shared.ts";

interface TestLaunch extends ScriptLaunch {
  readonly kind: "test";
  readonly value: number;
}

describe("script launch process identity", () => {
  beforeEach(resetLaunchState);
  afterEach(resetLaunchState);

  test("every exec receives one monotonically increasing scalar key", async () => {
    const args: unknown[][] = [];
    for (let value = 1; value <= 3; value++) {
      const pid = await handoffLaunch<TestLaunch>(
        { kind: "test", value },
        (...launchArgs) => {
          args.push(launchArgs);
          expect(captureLaunch<TestLaunch>("test")).toEqual({ kind: "test", value });
          return 100 + value;
        },
      );
      expect(pid).toBe(100 + value);
    }

    expect(args).toEqual([[1], [2], [3]]);
  });

  test("an unacknowledged child releases the queue for the next launch", async () => {
    expect(await handoffLaunch<TestLaunch>(
      { kind: "test", value: 1 },
      () => 101,
    )).toBe(0);

    expect(await handoffLaunch<TestLaunch>(
      { kind: "test", value: 2 },
      () => {
        expect(captureLaunch<TestLaunch>("test")?.value).toBe(2);
        return 102;
      },
    )).toBe(102);
  });
});

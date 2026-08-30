import { describe, expect, test } from "bun:test";
import { parseGoals } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";
import { findProfile } from "../profiles.ts";

describe("telemetry-free simulator runs", () => {
  test("observe installed augmentations without game telemetry", async () => {
    const result = await runGame({
      goal: parseGoals(["augs:1"]),
      seed: 1,
      horizonMs: 1_000,
      telemetry: false,
      playerState: { augmentations: [{ name: "BitWire", level: 1 }] },
      features: [],
    });

    expect(result.reached).toBe(true);
    expect(result.timeToGoalMs).toBe(0);
  });

  test("reach the same install at the same virtual time with fewer records", async () => {
    const profile = findProfile("bn1-progression");
    const run = (telemetry: boolean) => runGame({
      goal: parseGoals(["installs:1"]),
      seed: 1,
      horizonMs: 2 * 60_000,
      bitnode: profile.bitnode,
      homeRam: profile.homeRam,
      startingMoney: profile.startingMoney,
      features: profile.features,
      ...profile.world,
      telemetry,
    });

    const normal = await run(true);
    const perf = await run(false);
    expect(normal.validity).toBe("valid");
    expect(perf.validity).toBe("valid");
    expect(normal.reached).toBe(true);
    expect(perf.reached).toBe(true);
    expect(perf.timeToGoalMs).toBe(normal.timeToGoalMs);
    expect(perf.records).toBeLessThan(normal.records);
    expect(perf.unmodeled).toEqual({});
    expect(perf.crashes).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { runFarmCase, SHIPPED_FARM, summarizeFarmRuns } from "../dnet-farm.ts";
import { generateNet } from "../dnet-spread.ts";

/** The earn-in-a-full-net lane's CI mirror. The axis-4 contract is asserted
 * here — the storm must NEVER disturb the walker — while the storm's cache
 * value is a number the benchmark REPORTS rather than a claim this test
 * enshrines (`bun run bench:sim:dnet-farm` for the full paired sweep). */

const SEEDS = [1, 2, 3];
const HOURS = 0.5;
const WARMUP_HOURS = 0.5;

const shipped = SEEDS.map((seed) =>
  runFarmCase(generateNet(seed, { stock: true }), SHIPPED_FARM, HOURS, WARMUP_HOURS));

describe("the earn-in-a-full-net arena", () => {
  test("the walker is never disturbed — the axis-4 invariant", () => {
    for (const run of shipped) {
      expect(run.walkerInterruptions, `${run.caseId}: farm/storm work touched the walker's host`).toBe(0);
      // And the walk actually progressed the whole time: a stalled metronome
      // would make a zero interruption count vacuous.
      expect(run.walkerAttempts).toBeGreaterThan(100);
    }
  });

  test("an established net actually earns", () => {
    const summary = summarizeFarmRuns(shipped);
    // Check every seed, not only an average that one lucky world can carry.
    // These floors sit well below the recorded lower tail (~284 caches/h and
    // ~$905m/h) while still catching a disabled rung or stalled controller.
    for (const run of shipped) {
      expect(run.cachesPerHour).toBeGreaterThan(100);
      expect(run.moneyPerHour).toBeGreaterThan(100e6);
      expect(run.inventoryCalls).toBeGreaterThan(0);
    }
    expect(summary.meanCachesPerHour).toBeGreaterThan(150);
    expect(summary.meanMoneyPerHour).toBeGreaterThan(500e6);
    // The one net-wide `.d.cache` window is ~3 minutes, so an hour holds at
    // most ~20; more would mean the cooldown model broke.
    expect(summary.meanPhishCaches).toBeLessThanOrEqual(11);
    expect(summary.meanPhishCaches).toBeGreaterThan(0);
  });

  // These two each run a fresh warmup-plus-measurement case inside the test body, so
  // they get an explicit budget instead of bun's 5 s default.
  test("a seed is deterministic: the same world replays to the same run", () => {
    const again = runFarmCase(generateNet(2, { stock: true }), SHIPPED_FARM, HOURS, WARMUP_HOURS);
    const reference = shipped[1]!;
    expect(again.cachesOpened).toBe(reference.cachesOpened);
    expect(again.moneyEarned).toBe(reference.moneyEarned);
    expect(again.crackedTotal).toBe(reference.crackedTotal);
    expect(again.walkerAttempts).toBe(reference.walkerAttempts);
  }, 30_000);

  test("withholding the storm still leaves the invariant intact", () => {
    const quiet = runFarmCase(
      generateNet(1, { stock: true }),
      { name: "no-storm", stormEnabled: false, labPresent: true },
      HOURS,
      WARMUP_HOURS,
    );
    expect(quiet.stormsFired).toBe(0);
    expect(quiet.walkerInterruptions).toBe(0);
    expect(quiet.cachesOpened).toBeGreaterThan(0);
  }, 30_000);
});

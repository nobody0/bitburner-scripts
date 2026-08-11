import { describe, expect, test } from "bun:test";
import {
  chooseJitSchedule,
  jitCapacity,
  latestJitStart,
  type JitRole,
} from "../../shared/strategy/jit.ts";

const roles: JitRole[] = [
  { role: "h", kind: "hack", gb: 10, holdMs: 1_000 },
  { role: "w1", kind: "weaken", gb: 5, holdMs: 4_000 },
  { role: "g", kind: "grow", gb: 20, holdMs: 3_200 },
  { role: "w2", kind: "weaken", gb: 5, holdMs: 4_000 },
];

describe("JIT pipeline capacity", () => {
  test("short operations reuse their role RAM while weakens remain in flight", () => {
    const schedule = jitCapacity(roles, 1_000);
    expect(schedule.quotaGb).toEqual({ h: 10, w1: 20, g: 80, w2: 20 });
    expect(schedule.totalGb).toBe(130);
    expect(schedule.totalGb).toBeLessThan(4 * 40);
  });

  test("slows the cadence by whole batch intervals until every role fits", () => {
    const schedule = chooseJitSchedule(roles, 75, 1_000);
    expect(schedule).toBeDefined();
    expect(schedule!.intervalMs).toBe(2_000);
    expect(schedule!.totalGb).toBe(70);
  });

  test("rejects a fleet that cannot hold one slot for every role", () => {
    expect(chooseJitSchedule(roles, 39, 1_000)).toBeUndefined();
  });

  test("slows down when atomic hack and grow slots compete for the same hosts", () => {
    const competing: JitRole[] = [
      { role: "h", kind: "hack", gb: 40, holdMs: 2_000, atomic: true },
      { role: "g", kind: "grow", gb: 40, holdMs: 2_000, atomic: true },
      { role: "w2", kind: "weaken", gb: 10, holdMs: 1_000 },
    ];
    // 170 GB is enough in aggregate at 1s, and each role independently sees
    // enough slots. But three hosts can hold only three simultaneous 40 GB
    // atomic calls, not Hx2 + Gx2. At 2s only H+G are needed and it fits.
    const schedule = chooseJitSchedule(competing, 170, 1_000, {
      hostBlocksGb: [60, 60, 50],
      divisibleBlockGb: 1.75,
    });
    expect(schedule?.intervalMs).toBe(2_000);
  });
});

describe("latest safe JIT start", () => {
  const durationMs = (difficulty: number) => difficulty * 1_000;

  test("uses the live-security deadline when no effect crosses it", () => {
    expect(latestJitStart({
      now: 0,
      landing: 10_000,
      currentDifficulty: 2,
      minDifficulty: 1,
      events: [],
      durationMs,
      launchGuardMs: 200,
    })).toBe(7_800);
  });

  test("waits through an early fortify and uses its longer native duration", () => {
    expect(latestJitStart({
      now: 0,
      landing: 10_000,
      currentDifficulty: 2,
      minDifficulty: 1,
      events: [{ at: 3_000, order: 1, deltaDifficulty: 2 }],
      durationMs,
      launchGuardMs: 200,
    })).toBe(5_800);
  });

  test("launches before a fortify that makes the post-effect deadline impossible", () => {
    expect(latestJitStart({
      now: 0,
      landing: 10_000,
      currentDifficulty: 2,
      minDifficulty: 1,
      events: [{ at: 7_000, order: 1, deltaDifficulty: 2 }],
      durationMs,
      launchGuardMs: 200,
    })).toBe(6_800);
  });

  test("uses a later deadline unlocked by weaken", () => {
    expect(latestJitStart({
      now: 0,
      landing: 10_000,
      currentDifficulty: 4,
      minDifficulty: 1,
      events: [{ at: 5_000, order: 1, deltaDifficulty: -3 }],
      durationMs,
      launchGuardMs: 200,
    })).toBe(8_800);
  });

  test("applies equal-time effects in deterministic landing order", () => {
    expect(latestJitStart({
      now: 0,
      landing: 10_000,
      currentDifficulty: 1,
      minDifficulty: 1,
      events: [
        { at: 3_000, order: 2, deltaDifficulty: -3 },
        { at: 3_000, order: 1, deltaDifficulty: 3 },
      ],
      durationMs,
      launchGuardMs: 200,
    })).toBe(8_800);
  });
});

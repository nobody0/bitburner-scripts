import { describe, expect, test } from "bun:test";
import { lane } from "./support/lanes.ts";
import {
  chooseJitSchedule,
  jitCapacity,
  jitTopologyFits,
  latestJitStart,
  retainOrExpandJitSchedule,
  type JitRole,
} from "../shared/strategy/jit.ts";

const roles: JitRole[] = [
  { role: "h", kind: "hack", gb: 10, holdMs: 1_000 },
  { role: "w1", kind: "weaken", gb: 5, holdMs: 4_000 },
  { role: "g", kind: "grow", gb: 20, holdMs: 3_200 },
  { role: "w2", kind: "weaken", gb: 5, holdMs: 4_000 },
];

describe("JIT pipeline capacity", () => {
  test("never forms an over-cap union from two valid generation schedules", () => {
    const incumbent = { intervalMs: 40, quotaGb: { h: 30, w1: 10, g: 20, w2: 40 }, totalGb: 100 };
    const mixed = { intervalMs: 40, quotaGb: { h: 20, w1: 20, g: 40, w2: 20 }, totalGb: 100 };
    // Component-wise maxima would total 130 GB even though both inputs fit 100.
    expect(retainOrExpandJitSchedule(incumbent, mixed, 100)).toBe(incumbent);
    const expansion = { intervalMs: 40, quotaGb: { h: 30, w1: 15, g: 25, w2: 40 }, totalGb: 110 };
    expect(retainOrExpandJitSchedule(incumbent, expansion, 110)).toBe(expansion);
    expect(retainOrExpandJitSchedule(incumbent, expansion, 105)).toBe(incumbent);
  });

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

/** Late-game shape: minutes-long weakens against a purchased-server fleet. */
const LATE_GAME: JitRole[] = [
  { role: "h", kind: "hack", gb: 1.7, holdMs: 45_000, atomic: true },
  { role: "w1", kind: "weaken", gb: 60, holdMs: 180_000 },
  { role: "g", kind: "grow", gb: 120, holdMs: 144_000, atomic: true },
  { role: "w2", kind: "weaken", gb: 80, holdMs: 180_000 },
];

const topology = (hostBlocksGb: number[]) => ({ hostBlocksGb, divisibleBlockGb: 1.75 });

/** Atomic slots are placed as RUNS of one size rather than one entry per slot,
 * so these cover both what the packing must decide and the scale it has to
 * decide it at. */
describe("JIT topology packing", () => {
  test("packs atomic slots into the hosts that can hold them", () => {
    const fleet: JitRole[] = [{ role: "g", kind: "grow", gb: 40, holdMs: 2_000, atomic: true }];
    const schedule = jitCapacity(fleet, 1_000);
    // Two concurrent 40 GB grows: one 100 GB host holds both, two 50 GB hosts
    // hold one each, and 60+30 cannot hold the second.
    expect(jitTopologyFits(fleet, schedule, topology([100]))).toBe(true);
    expect(jitTopologyFits(fleet, schedule, topology([50, 50]))).toBe(true);
    expect(jitTopologyFits(fleet, schedule, topology([60, 30]))).toBe(false);
  });

  test("divisible roles must still fit in what the atomic placement leaves", () => {
    const fleet: JitRole[] = [
      { role: "g", kind: "grow", gb: 40, holdMs: 1_000, atomic: true },
      { role: "w2", kind: "weaken", gb: 20, holdMs: 1_000 },
    ];
    const schedule = jitCapacity(fleet, 1_000);
    // The grow takes 40, and the weaken's 20 GB has to come out of the
    // remainder in whole 1.75 GB blocks — so 21 GB of remainder (12 blocks)
    // clears it and 20 GB (11 blocks, 19.25) does not. Aggregate GB alone
    // would have said yes to both.
    expect(jitTopologyFits(fleet, schedule, topology([61]))).toBe(true);
    expect(jitTopologyFits(fleet, schedule, topology([60]))).toBe(false);
  });

  test("leads with each role in turn rather than only largest-first", () => {
    // Two 10 GB hacks and two 15 GB grows into hosts of 20 and 30. Largest
    // first packs 15 into the 20 (tightest fit) and 15 into the 30, leaving
    // 5 and 15 — the second 10 GB hack has nowhere to go. Leading with the
    // hacks fills the 20 exactly and leaves the 30 for both grows. Only the
    // per-role retry finds it, and aggregate GB (50 into 50) hides it.
    const fleet: JitRole[] = [
      { role: "h", kind: "hack", gb: 10, holdMs: 2_000, atomic: true },
      { role: "g", kind: "grow", gb: 15, holdMs: 2_000, atomic: true },
    ];
    const schedule = jitCapacity(fleet, 1_000);
    expect(schedule.quotaGb).toEqual({ h: 20, w1: 0, g: 30, w2: 0 });
    expect(jitTopologyFits(fleet, schedule, topology([20, 30]))).toBe(true);
  });

  test("places thousands of slots when a slow weaken fills the grid", () => {
    // `slotsFor` is holdMs/intervalMs, so a three-minute weaken on a 20 ms
    // grid is thousands of slots per role — 7,200 for this grow alone. The
    // fleet holds them comfortably; the soak case below covers the cost.
    const fleet = topology([...Array.from({ length: 25 }, () => 1_048_576), 65_536]);
    expect(jitTopologyFits(LATE_GAME, jitCapacity(LATE_GAME, 20), fleet)).toBe(true);
  });
});

/** A timing measurement, so it runs in its own process rather than beside the
 * rest of the suite — under parallel load the reading is of the machine, not
 * the code. `bun run long hacking`. */
const soak = lane({ feature: "hacking" });

soak.describe("JIT topology packing cost", () => {
  soak.test("does not scale with the number of slots on the grid", () => {
    // Slot count is holdMs/intervalMs, so a tenfold finer grid is tenfold the
    // slots for identical work. Placing runs rather than individual slots
    // makes the two cost the same; building one array entry per slot made the
    // fine grid ten times dearer and this function the most expensive in a
    // profile of the running game. A RATIO, because the absolute figure
    // belongs to whichever machine ran it.
    const fleet = topology([...Array.from({ length: 25 }, () => 1_048_576), 65_536]);
    const costMs = (intervalMs: number): number => {
      const schedule = jitCapacity(LATE_GAME, intervalMs);
      for (let i = 0; i < 5; i++) jitTopologyFits(LATE_GAME, schedule, fleet);
      let best = Infinity;
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        jitTopologyFits(LATE_GAME, schedule, fleet);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const coarse = costMs(200);
    const fine = costMs(20);
    console.log(`bench: jitTopologyFits 200ms grid=${coarse.toFixed(4)}ms 20ms grid=${fine.toFixed(4)}ms`);
    expect(fine).toBeLessThan(coarse * 3);
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

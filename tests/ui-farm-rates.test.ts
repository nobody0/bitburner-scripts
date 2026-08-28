import { describe, expect, test } from "bun:test";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import type { BatchAggregateReport, FarmRollup, SettledBatchReport } from "../shared/telemetry/topics/hacking.ts";
import {
  DEFAULT_RATE_WINDOW_MS,
  MAX_RATE_WINDOW_MS,
  appendRecords,
  emptyState,
} from "../ui/app/project.ts";

/** The farm rollup carries CUMULATIVE counters because per-op telemetry is
 * impossible here — landings run at roughly one per 20 ms at scale. Every
 * curve the Hacking tab draws is therefore derived in the viewer, which costs
 * no telemetry at all but puts the burden of correctness on this fold.
 *
 * Two shapes, and the tests below separate them deliberately: the per-batch
 * launched/landed pair is a running TOTAL, because the band between the two is
 * the finding; the allocation share and the batch settle rate are WINDOWED,
 * because a 1 Hz sample of a minutes-long cycle is the wrong resolution. In
 * both cases a counter that went backwards is a reset, not a negative rate. */

let seq = 0;

function rollup(t: number, farm: Partial<FarmRollup>): LogRecord {
  return {
    t,
    seq: seq++,
    run: "test",
    src: "sim",
    kind: "state",
    key: "farm",
    data: { totals: { moneyEarned: 0, hacks: 0 }, ...farm },
  } as LogRecord;
}

function counts(hack: number, grow: number, weaken: number): { hack: number; grow: number; weaken: number } {
  return { hack, grow, weaken };
}

/** A per-kind aggregate with only the fields a series reads spelled out; the
 * rest are structurally required but never differentiated. */
function aggregate(over: Partial<BatchAggregateReport>): BatchAggregateReport {
  return {
    batches: 0,
    ops: 0,
    landed: 0,
    threads: counts(0, 0, 0),
    gb: 0,
    moneyEarned: 0,
    hacks: 0,
    spanMs: 0,
    inOrder: 0,
    noHack: 0,
    ...over,
  };
}

function settled(id: number, at: number, over: Partial<SettledBatchReport> = {}): SettledBatchReport {
  return {
    id,
    kind: "hgw",
    target: "phantasy",
    at,
    spanMs: 1_000,
    ops: 3,
    landed: 3,
    threads: counts(1, 1, 1),
    gb: 100,
    moneyEarned: 1_000,
    ...over,
  };
}

describe("farm series projection", () => {
  test("one rollup produces no windowed quantity at all", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(10, 20, 40),
        landed: counts(5, 10, 20),
        allocation: { threads: { farm: counts(16, 5, 4) }, effectThreads: { farm: counts(16, 5, 4) } },
      }),
    ]);
    // A windowed quantity needs an interval. Plotting the first sample as
    // though it were one would draw the run's entire history as a single point.
    expect(state.allocShare.hack).toEqual([]);
  });

  test("windows a sparse counter rather than differencing adjacent rollups", () => {
    // A settled farm completes one batch per weakenTime. At 1 Hz, adjacent
    // samples would alternate between zero and spikes, so use a windowed rate.
    const records = [];
    for (let second = 0; second <= 40; second++) {
      records.push(
        rollup(second * 1_000, {
          launched: counts(second, second, second),
          landed: counts(second, second, second),
          // One batch settles every 20 s.
          batches: { hwgw: aggregate({ batches: Math.floor(second / 20), ops: second, landed: second }) },
        }),
      );
    }
    const state = appendRecords(emptyState(), records);
    // No batch period is published here, so the default window applies.
    expect(state.farmWindowMs).toBe(DEFAULT_RATE_WINDOW_MS);
    const last = state.batchSeries.hwgw!.perSec.at(-1)!;
    expect(last[0]).toBe(40_000);
    // Two batches across the 30 s window, not "zero in the last second".
    expect(last[1]).toBeCloseTo(2 / 30, 6);
  });

  test("takes the window from the target's batch period when one is published", () => {
    const records = [];
    for (let second = 0; second <= 5; second++) {
      records.push(
        rollup(second * 1_000, {
          launched: counts(second, second, second),
          landed: counts(second, second, second),
          batches: { hwgw: aggregate({ batches: second, ops: second * 4, landed: second * 4 }) },
          pipelines: [{
            host: "phantasy",
            role: "farm",
            segment: "farm",
            gb: 1,
            inFlight: counts(0, 0, 0),
            weakenTimeMs: 216_000,
          }],
        }),
      );
    }
    const state = appendRecords(emptyState(), records);
    // One weakenTime IS the batch period, which is the interval over which a
    // windowed quantity is meaningful — clamped so it can neither be noise nor
    // unresponsive.
    expect(state.farmWindowMs).toBe(216_000);
    expect(state.farmWindowMs).toBeLessThanOrEqual(MAX_RATE_WINDOW_MS);
    // The ring is shorter than the window this early, so the rate is averaged
    // over what exists rather than withheld for the first three minutes.
    expect(state.batchSeries.hwgw!.perSec.at(-1)![1]).toBeCloseTo(1, 6);
    // And the span it was ACTUALLY averaged over is reported separately, because
    // it is five seconds and not the 3m 36s the window asked for. The panel used
    // to caption the one with the other — a ~43x overclaim for the first minutes
    // of every long-cycle target, which is the phase being watched.
    expect(state.farmWindowActualMs).toBe(5_000);
  });

  test("the measured span is absent until there is one, and dropped at a reset", () => {
    const state = emptyState();
    // One rollup: no baseline, so there is no rate point to caption.
    appendRecords(state, [rollup(1_000, { launched: counts(1, 1, 1), landed: counts(1, 1, 1) })]);
    expect(state.farmWindowActualMs).toBeUndefined();
    appendRecords(state, [rollup(4_000, { launched: counts(2, 2, 2), landed: counts(2, 2, 2) })]);
    expect(state.farmWindowActualMs).toBe(3_000);
    // An install wipes the topic and the ring with it. A span left over from the
    // previous run would caption this one's first points with the old window.
    appendRecords(state, [rollup(5_000, { launched: counts(0, 0, 0), landed: counts(0, 0, 0) })]);
    expect(state.farmWindowActualMs).toBeUndefined();
  });

  test("a counter reset drops the ring rather than differencing across it", () => {
    const alloc = (hack: number, grow: number, weaken: number): FarmRollup["allocation"] => ({
      threads: { farm: counts(hack, grow, weaken) },
      effectThreads: { farm: counts(hack, grow, weaken) },
    });
    const state = appendRecords(emptyState(), [
      rollup(1_000, { launched: counts(100, 200, 400), landed: counts(90, 180, 360), allocation: alloc(0, 0, 0) }),
      rollup(2_000, { launched: counts(110, 220, 440), landed: counts(100, 200, 400), allocation: alloc(16, 5, 4) }),
      // An install wipes the topic and the next rollup restarts from zero.
      rollup(3_000, { launched: counts(1, 2, 4), landed: counts(0, 0, 0), allocation: alloc(0, 0, 0) }),
      rollup(4_000, { launched: counts(11, 22, 44), landed: counts(10, 20, 40), allocation: alloc(32, 10, 8) }),
    ]);
    // Two points: one before the install, one after. The reset sample itself
    // yields nothing and becomes the baseline for the run that follows, so no
    // point is ever differenced across the discontinuity.
    expect(state.allocShare.hack.map(([t]) => t)).toEqual([2_000, 4_000]);
  });

  test("allocation is a share of the threads launched in the interval", () => {
    const alloc = (hack: number, grow: number, weaken: number): FarmRollup["allocation"] => ({
      threads: { farm: counts(hack, grow, weaken) },
      effectThreads: { farm: counts(hack, grow, weaken) },
    });
    const state = appendRecords(emptyState(), [
      rollup(1_000, { launched: counts(1, 1, 1), landed: counts(1, 1, 1), allocation: alloc(0, 0, 0) }),
      rollup(2_000, { launched: counts(2, 2, 2), landed: counts(2, 2, 2), allocation: alloc(16, 5, 4) }),
    ]);
    // Two samples: the window has nothing older to reach for, so this is the
    // whole span and the shares are of every thread launched in it.
    // The three shares are of one interval's threads and so sum to 1 — the
    // point of plotting them together is that the ratio is readable directly.
    const total = 16 + 5 + 4;
    expect(state.allocShare.hack).toEqual([[2_000, 16 / total]]);
    expect(state.allocShare.grow).toEqual([[2_000, 5 / total]]);
    expect(state.allocShare.weaken).toEqual([[2_000, 4 / total]]);
    const sum = (["hack", "grow", "weaken"] as const).reduce(
      (acc, kind) => acc + (state.allocShare[kind][0]?.[1] ?? 0),
      0,
    );
    expect(sum).toBeCloseTo(1, 12);
  });

  test("an interval that launched nothing contributes no allocation point", () => {
    const idle = (): FarmRollup["allocation"] => ({
      threads: { farm: counts(16, 5, 4) },
      effectThreads: { farm: counts(16, 5, 4) },
    });
    const state = appendRecords(emptyState(), [
      rollup(1_000, { launched: counts(1, 1, 1), landed: counts(1, 1, 1), allocation: idle() }),
      rollup(2_000, { launched: counts(1, 1, 1), landed: counts(1, 1, 1), allocation: idle() }),
    ]);
    // 0/0 is not 0. Plotting a zero share would read as "the farm stopped
    // allocating to hack", which is a claim about a decision, not about an
    // idle window.
    expect(state.allocShare.hack).toEqual([]);
  });

});

describe("dispatcher health curves", () => {
  test("a gauge is folded from the FIRST rollup, not once a window has filled", () => {
    // These are read straight off each rollup rather than differenced against a
    // baseline. Folding them behind the rate window left every health curve
    // empty for the first thirty seconds of a run, and permanently on a short
    // one — which is exactly when an operator is watching them.
    const state = appendRecords(emptyState(), [
      rollup(1_000, { launched: counts(1, 1, 1), landed: counts(1, 1, 1), pumpOccupancy: 0.04 }),
      rollup(2_000, { launched: counts(2, 2, 2), landed: counts(2, 2, 2), pumpOccupancy: 0.06 }),
    ]);
    expect(state.farmHealth.pumpOccupancy).toEqual([[1_000, 0.04], [2_000, 0.06]]);
  });

  test("ops adrift subtracts what is still in flight", () => {
    // launched - landed alone is mostly BACKLOG at steady state, and a curve
    // that never returns to zero cannot be read as loss.
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(10, 10, 10),
        landed: counts(7, 7, 7),
        inFlight: { hack: 3, grow: 3, weaken: 3 },
      }),
    ]);
    expect(state.farmHealth.opsLost).toEqual([[1_000, 0]]);
  });

  test("ops adrift is what is left when nothing is in flight to explain it", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(10, 10, 10),
        landed: counts(9, 9, 9),
        inFlight: { hack: 0, grow: 0, weaken: 0 },
      }),
    ]);
    expect(state.farmHealth.opsLost).toEqual([[1_000, 3]]);
  });

  test("the in-order share is graded batches, not all batches", () => {
    // A prep wave has no landing grid and can never be in order. Dividing by
    // every batch would report a farm that grades perfectly as failing.
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(1, 1, 1),
        landed: counts(1, 1, 1),
        batches: {
          hgw: aggregate({ batches: 100, graded: 100, inOrder: 100 }),
          prep: aggregate({ batches: 50, graded: 0, inOrder: 0 }),
        },
      }),
      rollup(2_000, {
        launched: counts(2, 2, 2),
        landed: counts(2, 2, 2),
        batches: {
          hgw: aggregate({ batches: 110, graded: 110, inOrder: 109 }),
          prep: aggregate({ batches: 60, graded: 0, inOrder: 0 }),
        },
      }),
    ]);
    // Ten graded batches in the window, one of them out of order — 0.9, and NOT
    // the 109/110 lifetime figure that reads as a healthy 0.99. The card is
    // captioned "is it getting worse", which a denominator that only grows
    // cannot answer: after an hour it is tens of thousands of batches deep and a
    // pipeline that starts slipping now moves the curve by a rounding error.
    expect(state.farmHealth.inOrderShare).toEqual([[2_000, 0.9]]);
  });

  test("the mean batch span is the batches that settled in the window", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(1, 1, 1),
        landed: counts(1, 1, 1),
        // A long, healthy history: 100 batches averaging 10 s.
        batches: { hgw: aggregate({ batches: 100, spanMs: 1_000_000 }) },
      }),
      rollup(2_000, {
        launched: counts(2, 2, 2),
        landed: counts(2, 2, 2),
        // The two that settled since took 30 s each. The lifetime mean barely
        // twitches (10.2 s); the windowed one says what is happening now.
        batches: { hgw: aggregate({ batches: 102, spanMs: 1_060_000 }) },
      }),
    ]);
    expect(state.farmHealth.batchSpanMs).toEqual([[2_000, 30_000]]);
  });

  test("a window that settled nothing contributes no span point", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, { launched: counts(1, 1, 1), landed: counts(1, 1, 1), batches: { hgw: aggregate({ batches: 4, spanMs: 40_000 }) } }),
      rollup(2_000, { launched: counts(2, 2, 2), landed: counts(2, 2, 2), batches: { hgw: aggregate({ batches: 4, spanMs: 40_000 }) } }),
    ]);
    // 0/0 is not 0, and a zero mean span would read as a farm that had started
    // settling instantly.
    expect(state.farmHealth.batchSpanMs).toEqual([]);
  });
});

describe("per-batch-kind projection", () => {
  test("a batch COMPLETION rate is windowed, unlike the op totals", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(1, 1, 1),
        landed: counts(1, 1, 1),
        batches: { hgw: aggregate({ batches: 10, ops: 30, landed: 30, moneyEarned: 1e6 }) },
      }),
      rollup(3_000, {
        launched: counts(2, 2, 2),
        landed: counts(2, 2, 2),
        batches: { hgw: aggregate({ batches: 14, ops: 42, landed: 42, moneyEarned: 5e6 }) },
      }),
    ]);
    // Four batches settled across two seconds. A batch is a discrete
    // completion, so its rate is a throughput where an op backlog is a level.
    expect(state.batchSeries.hgw!.perSec).toEqual([[3_000, 2]]);
    // $4e6 earned by those four batches.
    expect(state.batchSeries.hgw!.moneyPerBatch).toEqual([[3_000, 1e6]]);
  });

  test("a window that settled no batch contributes no money-per-batch point", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(1, 1, 1),
        landed: counts(1, 1, 1),
        batches: { prep: aggregate({ batches: 4, ops: 40, landed: 40 }) },
      }),
      rollup(2_000, {
        launched: counts(2, 2, 2),
        landed: counts(2, 2, 2),
        batches: { prep: aggregate({ batches: 4, ops: 40, landed: 40 }) },
      }),
    ]);
    // 0/0 is not 0. Plotting zero would read as "a batch now earns nothing".
    expect(state.batchSeries.prep!.moneyPerBatch).toEqual([]);
    expect(state.batchSeries.prep!.perSec).toEqual([[2_000, 0]]);
  });

  test("a kind that settles its first batch mid-window starts from zero", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(1, 1, 1),
        landed: counts(1, 1, 1),
        batches: { hgw: aggregate({ batches: 1, ops: 3, landed: 3 }) },
      }),
      rollup(2_000, {
        launched: counts(2, 2, 2),
        landed: counts(2, 2, 2),
        batches: {
          hgw: aggregate({ batches: 2, ops: 6, landed: 6 }),
          // Only kinds with batches > 0 are published, so prep's absence from
          // the baseline is a first settle, not a gap.
          prep: aggregate({ batches: 3, ops: 30, landed: 30, moneyEarned: 0 }),
        },
      }),
    ]);
    expect(state.batchSeries.prep!.perSec).toEqual([[2_000, 3]]);
  });
});

describe("settled-batch history", () => {
  test("accumulates past the rollup's bounded ring by deduping on id", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, { recentBatches: [settled(1, 1_000), settled(2, 1_010), settled(3, 1_020)] }),
      // Successive rollups overlap: the ring is bounded, the ids are not.
      rollup(2_000, { recentBatches: [settled(2, 1_010), settled(3, 1_020), settled(4, 1_030)] }),
      rollup(3_000, { recentBatches: [settled(4, 1_030), settled(5, 1_040)] }),
    ]);
    expect(state.batchHistory.map((batch) => batch.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a batch that settles out of id order is KEPT, not discarded", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, { recentBatches: [settled(40, 1_000), settled(41, 1_010)] }),
      // Batch 7 opened long before 40 and settled long after it: ids are handed
      // out when a batch OPENS, the ring is ordered by when it SETTLED, and one
      // counter serves both prep waves and farm cycles. A prep wave spans a
      // whole grow, so this is the ordinary case, not a corner one.
      rollup(2_000, { recentBatches: [settled(41, 1_010), settled(7, 2_000)] }),
    ]);
    expect(state.batchHistory.map((batch) => batch.id)).toEqual([40, 41, 7]);
  });

  test("an out-of-order id arriving LAST does not wipe the history", () => {
    // The regression this set replaced a watermark for. With "newer than the
    // newest kept" as the dedupe, a low id at the end of the ring read as a
    // restarted counter and discarded every batch accumulated so far.
    const state = appendRecords(emptyState(), [
      rollup(1_000, { recentBatches: [settled(40, 1_000), settled(41, 1_010), settled(42, 1_020)] }),
      rollup(2_000, { recentBatches: [settled(9, 2_000)] }),
    ]);
    expect(state.batchHistory.map((batch) => batch.id)).toEqual([40, 41, 42, 9]);
  });

  test("an install clears the history, detected on the counters not the ids", () => {
    // A fresh dispatcher restarts nextBatchId, so its id 1 is a different batch
    // from the previous life's id 1. That is a real reset — but it is read off
    // the cumulative op counters moving backwards, which is unambiguous, rather
    // than inferred from an arrival order that is legitimately out of order.
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(100, 100, 100),
        landed: counts(100, 100, 100),
        recentBatches: [settled(40, 1_000), settled(41, 1_010)],
      }),
      rollup(2_000, {
        launched: counts(1, 1, 1),
        landed: counts(1, 1, 1),
        recentBatches: [settled(1, 2_000)],
      }),
    ]);
    expect(state.batchHistory.map((batch) => batch.id)).toEqual([1]);
  });

  test("a settled batch carries its size-normalised figures", () => {
    // Batches are not comparable as they arrive: a prep wave is a hundred grow
    // threads that steal nothing, a farm cycle is four ops that do. $/GB·s is
    // the figure that asks both the same question.
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        recentBatches: [settled(1, 1_000, {
          spanMs: 2_000, gb: 500, moneyEarned: 1_000,
          threads: counts(10, 20, 30), order: "h-g-w2", planned: "h-w1-g-w2",
        })],
      }),
    ]);
    const batch = state.batchHistory[0]!;
    expect(batch.totalThreads).toBe(60);
    // 1000 / (500 GB * 2 s)
    expect(batch.moneyPerGbSec).toBeCloseTo(1);
    expect(batch.misordered).toBe(true);
  });

  test("a counter reset also clears the per-kind series", () => {
    const state = appendRecords(emptyState(), [
      rollup(1_000, {
        launched: counts(100, 100, 100),
        landed: counts(100, 100, 100),
        batches: { hgw: aggregate({ batches: 50, ops: 150, landed: 150 }) },
      }),
      rollup(2_000, {
        launched: counts(200, 200, 200),
        landed: counts(200, 200, 200),
        batches: { hgw: aggregate({ batches: 60, ops: 180, landed: 180 }) },
      }),
      rollup(3_000, {
        launched: counts(1, 1, 1),
        landed: counts(1, 1, 1),
        batches: { hgw: aggregate({ batches: 1, ops: 3, landed: 3 }) },
      }),
    ]);
    // The reset sample yields nothing and becomes the next baseline; the
    // pre-install curve must not survive to be differenced against it.
    expect(state.batchSeries.hgw?.perSec ?? []).toEqual([]);
    expect(state.batchSeries.hgw?.moneyPerBatch ?? []).toEqual([]);
  });
});

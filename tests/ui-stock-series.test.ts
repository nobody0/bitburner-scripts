import { describe, expect, test } from "bun:test";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import type { StockState } from "../shared/telemetry/topics/stock.ts";
import { SERIES_LIMIT, appendRecords, emptyState, project } from "../ui/app/project.ts";

/** The stock tab's capital and earnings curves are derived entirely in the
 * viewer, from a topic that is republished whole every few hundred milliseconds.
 * Two properties carry all of the difficulty and neither is visible from the
 * rendered panel, so they are asserted here.
 *
 * ABSENCE IS NOT ZERO. The book comes from a 3-second probe while the trade
 * ledger is written only by the driver's `execute()`, so a run that has not yet
 * traded has a book and NO ledger — and drawing that as $0 realised would claim
 * the run broke even when it had not started.
 *
 * A RESET DROPS EVERYTHING. `tradeCashFlow` is a cash delta and goes negative on
 * every position it opens, so the "counter went backwards" test the farm series
 * use is meaningless here. `market.tick` is the sentinel, and a vanished ledger
 * is the second tell. */

let seq = 0;

function stockRecord(t: number, stock: Partial<StockState>): LogRecord {
  return {
    t,
    seq: seq++,
    run: "test",
    src: "sim",
    kind: "state",
    key: "stock",
    data: { hasWseAccount: true, hasTixApiAccess: true, ...stock },
  } as LogRecord;
}

describe("stock capital and earnings series", () => {
  test("the book is plotted at market and at cost", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { portfolioValue: 0, portfolioCost: 0, market: { tick: 1, cyclesSeen: 0, lastFlipCount: 0 } }),
      stockRecord(1_000, { portfolioValue: 10_500, portfolioCost: 10_000, market: { tick: 2, cyclesSeen: 0, lastFlipCount: 0 } }),
    ]);
    expect(state.stockSeries.value).toEqual([[0, 0], [1_000, 10_500]]);
    expect(state.stockSeries.cost).toEqual([[0, 0], [1_000, 10_000]]);
  });

  test("realised net is cost basis, so opening a position does not move it", () => {
    // The trade spent $10k of cash and received $10k of book: the run has
    // realised nothing, and the naive `tradeCashFlow + portfolioValue`
    // definition would report a profit here purely from the spread.
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: -10_000, portfolioValue: 9_800, portfolioCost: 10_000 }),
    ]);
    expect(state.stockSeries.realized).toEqual([[0, 0]]);
  });

  test("a price fall leaves realised net alone and only a sale moves it", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: -10_000, portfolioValue: 10_000, portfolioCost: 10_000 }),
      // Price halves. Cost basis is untouched, so realised is untouched.
      stockRecord(1_000, { tradeCashFlow: -10_000, portfolioValue: 5_000, portfolioCost: 10_000 }),
      // Sold at that price: now the loss is real and the curve takes it.
      stockRecord(2_000, { tradeCashFlow: -5_000, portfolioValue: 0, portfolioCost: 0 }),
    ]);
    expect(state.stockSeries.realized).toEqual([[0, 0], [1_000, 0], [2_000, -5_000]]);
  });

  test("a book without a ledger contributes nothing to realised net", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { portfolioValue: 10_500, portfolioCost: 10_000 }),
    ]);
    expect(state.stockSeries.value).toHaveLength(1);
    expect(state.stockSeries.cost).toHaveLength(1);
    // Not `[[0, 10_000]]`: nothing has been realised because nothing has traded.
    expect(state.stockSeries.realized).toEqual([]);
    expect(state.stockSeries.unlockSpend).toEqual([]);
    expect(state.stockFlowSince).toBeNull();
  });

  test("the measured-rate clock starts at the first non-zero cash flow", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: 0 }),
      stockRecord(1_000, { tradeCashFlow: -10_000 }),
      stockRecord(2_000, { tradeCashFlow: -4_000 }),
    ]);
    expect(state.stockFlowSince).toBe(1_000);
  });

  test("the unlock ladder is its own step curve, excluded from realised net", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: 0, unlockSpend: 200e6 }),
      stockRecord(1_000, { tradeCashFlow: 0, unlockSpend: 5.2e9 }),
    ]);
    expect(state.stockSeries.unlockSpend).toEqual([[0, 200e6], [1_000, 5.2e9]]);
    // A purchase is not a trading loss.
    expect(state.stockSeries.realized).toEqual([[0, 0], [1_000, 0]]);
  });

  test("a market tick going backwards is an install: the rings drop, the profit is kept", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: 4e8, unlockSpend: 5.2e9, portfolioValue: 0, portfolioCost: 0, market: { tick: 500, cyclesSeen: 6, lastFlipCount: 0 } }),
      // A new install re-rolls the market, so the observed tick restarts.
      stockRecord(1_000, { tradeCashFlow: 0, unlockSpend: 0, portfolioValue: 0, portfolioCost: 0, market: { tick: 1, cyclesSeen: 0, lastFlipCount: 0 } }),
    ]);
    expect(state.stockInstalls).toEqual([{ realized: 4e8, unlockSpend: 5.2e9, endedAt: 0 }]);
    // The pre-install segment is gone, not spliced: it describes a market whose
    // every price, spread and volatility was re-rolled.
    expect(state.stockSeries.realized).toEqual([[1_000, 0]]);
    expect(state.stockSeries.value).toEqual([[1_000, 0]]);
    expect(state.stockFlowSince).toBeNull();
    expect(state.stockTick).toBe(1);
  });

  test("a ledger that vanishes after having been present is the same install", () => {
    // `stockModule.reset` deletes the whole topic, so the rebuilt one carries
    // the account flags and no ledger at all — and no market clock either, which
    // is why the tick sentinel cannot be the only one.
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: 4e8, portfolioValue: 0, portfolioCost: 0 }),
      stockRecord(1_000, {}),
    ]);
    expect(state.stockInstalls).toEqual([{ realized: 4e8, unlockSpend: 0, endedAt: 0 }]);
    expect(state.stockSeries.realized).toEqual([]);
  });

  test("a topic that never carried a ledger is not mistaken for a reset", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { portfolioValue: 1_000, portfolioCost: 1_000 }),
      stockRecord(1_000, { portfolioValue: 1_200, portfolioCost: 1_000 }),
    ]);
    expect(state.stockInstalls).toEqual([]);
    expect(state.stockSeries.value).toHaveLength(2);
  });

  test("decimation keeps the endpoints", () => {
    const points = SERIES_LIMIT * 2 + 10;
    const state = emptyState();
    for (let i = 0; i < points; i++) {
      appendRecords(state, [stockRecord(i, { portfolioValue: i, portfolioCost: 0 })]);
    }
    expect(state.stockSeries.value.length).toBeLessThanOrEqual(SERIES_LIMIT);
    expect(state.stockSeries.value[0]).toEqual([0, 0]);
    expect(state.stockSeries.value[state.stockSeries.value.length - 1]).toEqual([points - 1, points - 1]);
  });

  test("a replay scrub recomputes the identical curves", () => {
    // The whole reason the series are derived rather than sent: projecting the
    // record stream from scratch must equal folding it incrementally, or
    // dragging the scrubber would show a different run.
    const records = [
      stockRecord(0, { tradeCashFlow: -10_000, portfolioValue: 10_000, portfolioCost: 10_000, market: { tick: 1, cyclesSeen: 0, lastFlipCount: 0 } }),
      stockRecord(1_000, { tradeCashFlow: -10_000, portfolioValue: 12_000, portfolioCost: 10_000, market: { tick: 2, cyclesSeen: 0, lastFlipCount: 0 } }),
      stockRecord(2_000, { tradeCashFlow: 2_000, portfolioValue: 0, portfolioCost: 0, market: { tick: 3, cyclesSeen: 0, lastFlipCount: 0 } }),
    ];
    const incremental = emptyState();
    for (const record of records) appendRecords(incremental, [record]);
    const whole = project(records, Infinity, { id: "test", src: "sim", live: true, t0: 0 });
    expect(incremental.stockSeries).toEqual(whole.stockSeries);
    expect(incremental.stockFlowSince).toBe(whole.stockFlowSince);
    expect(incremental.stockTick).toBe(whole.stockTick);
  });
});

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
 * NOTHING IS DROPPED. One artifact is one install — the run file is keyed on the
 * install id — so an install boundary is a different file and cannot appear in
 * one stream. What does appear is a controller HANDOFF, which restarts
 * `market.tick` (a module-level counter) and leaves the rebuilt topic without a
 * ledger for a tick, while the ledger itself is parked in the page realm and
 * survives. Both of those used to close out a phantom "earlier install".
 *
 * A RATE NEEDS A DENOMINATOR IT CAN SEE. The measured $/sec clock is armed only
 * by observing the ledger at zero; a viewer that attached after the first trade
 * has no start time on the wire and must say so. */

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
    // An absent ledger is not evidence that this emitter has not traded, so the
    // clock stays unarmed.
    expect(state.stockRateSince).toBeNull();
    expect(state.sawStockLedgerOpen).toBe(false);
  });

  test("the measured-rate clock starts at the first WATCHED trade", () => {
    // An explicit zero is proof that this emitter has not traded yet.
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: 0 }),
      stockRecord(1_000, { tradeCashFlow: -10_000 }),
      stockRecord(2_000, { tradeCashFlow: -4_000 }),
    ]);
    expect(state.sawStockLedgerOpen).toBe(true);
    expect(state.stockRateSince).toBe(1_000);
  });

  test("attaching after the ledger opened leaves the rate clock unarmed", () => {
    // A live attach folds the hub snapshot plus a 2 MB tail, and a compacted
    // replay keeps exactly one record per state key — so the first ledger a
    // viewer sees is routinely an hours-old cumulative figure. Arming on it
    // divided a whole install's realised P/L by the age of the ATTACH and
    // printed the result as a confident rate.
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: 4e8, portfolioValue: 0, portfolioCost: 0 }),
      stockRecord(1_000, { tradeCashFlow: 4.2e8, portfolioValue: 0, portfolioCost: 0 }),
    ]);
    expect(state.stockRateSince).toBeNull();
    expect(state.sawStockLedgerOpen).toBe(false);
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

  test("a backwards market tick is a controller restart, and drops nothing", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: 0, unlockSpend: 5.2e9, portfolioValue: 0, portfolioCost: 0, market: { tick: 500, cyclesSeen: 6, lastFlipCount: 0 } }),
      stockRecord(1_000, { tradeCashFlow: 4e8, unlockSpend: 5.2e9, portfolioValue: 0, portfolioCost: 0, market: { tick: 501, cyclesSeen: 6, lastFlipCount: 0 } }),
      // The successor process: its market clock restarts, and its rebuilt topic
      // carries no ledger until the next stock action.
      stockRecord(2_000, { portfolioValue: 0, portfolioCost: 0, market: { tick: 1, cyclesSeen: 0, lastFlipCount: 0 } }),
      stockRecord(3_000, { tradeCashFlow: 4.1e8, unlockSpend: 5.2e9, portfolioValue: 0, portfolioCost: 0, market: { tick: 2, cyclesSeen: 0, lastFlipCount: 0 } }),
    ]);
    // Every pre-restart point is still there.
    expect(state.stockSeries.realized).toEqual([[0, 0], [1_000, 4e8], [3_000, 4.1e8]]);
    expect(state.stockSeries.value).toEqual([[0, 0], [1_000, 0], [2_000, 0], [3_000, 0]]);
    expect(state.stockSeries.unlockSpend).toEqual([[0, 5.2e9], [1_000, 5.2e9], [3_000, 5.2e9]]);
    // And the rate denominator survives too: the trade it dates from happened.
    expect(state.stockRateSince).toBe(1_000);
  });

  test("a ledger that vanishes during a controller restart does not erase history", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { tradeCashFlow: 4e8, portfolioValue: 0, portfolioCost: 0 }),
      stockRecord(1_000, {}),
    ]);
    expect(state.stockSeries.realized).toEqual([[0, 4e8]]);
  });

  test("a topic that never carried a ledger plots the book and no earnings", () => {
    const state = appendRecords(emptyState(), [
      stockRecord(0, { portfolioValue: 1_000, portfolioCost: 1_000 }),
      stockRecord(1_000, { portfolioValue: 1_200, portfolioCost: 1_000 }),
    ]);
    expect(state.stockSeries.realized).toEqual([]);
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
    expect(incremental.stockRateSince).toBe(whole.stockRateSince);
    expect(incremental.sawStockLedgerOpen).toBe(whole.sawStockLedgerOpen);
  });
});

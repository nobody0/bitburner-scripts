import { expect, test } from "bun:test";
import { STOCK_VOLATILITY_STEP, volatilityRange } from "../../shared/features/stocks.ts";
import { parseGoal } from "../../shared/goals/presets.ts";
import { runGame, type GameRunResult } from "../game-run.ts";
import { findProfile } from "../profiles.ts";
import { SymbolToStockMap } from "../vendor/bitburner/src/StockMarket/MarketAdapter.ts";
import { Stock } from "../vendor/bitburner/src/StockMarket/Stock.ts";
import { lane } from "../../tests/support/lanes.ts";

/** The stock capability ladder: the real controller on ONE BN5 world at three
 * strictly increasing capability rungs. `bun run long stock` / `bun run long bn5`.
 *
 *  1. `stock-ladder-blind` — no 4S (node option), no shorts: every signal must
 *     be inferred by watching prices against the transcribed generation ranges.
 *  2. `stock-ladder-4s`    — identical world, 4S TIX API granted.
 *  3. `stock-ladder-shorts`— identical world, plus owned SF8.2.
 *
 * Two claims are pinned. FIDELITY: a blind run acts only on estimated signals,
 * never buys 4S (the option refuses it, like upstream), and its recovered
 * volatilities lie inside the vendored generation ranges — the transcription IS
 * the outlier detector — and match the actual hidden per-symbol roll read
 * straight off the vendored market. LADDER: each rung's terminal wealth does
 * not underperform the rung below it (median across seeds at a fixed horizon:
 * reading the signal beats inferring it, and both sides of the market beat
 * one). */

interface RankedDigest {
  sym: string;
  forecast: number;
  volatility: number;
  exact: boolean;
}

interface StageRun {
  result: GameRunResult;
  /** Last published plan digest's ranking. */
  ranked: RankedDigest[];
  /** Last published market clock digest. */
  market?: { tick: number; ticksUntilCycle?: number; cyclesSeen: number };
  /** `stock.unlock` events seen, by `what`. */
  unlocks: string[];
  shortTrades: number;
}

async function runStage(id: string, seed: number, horizonMs: number): Promise<StageRun> {
  const profile = findProfile(id);
  const captured: Omit<StageRun, "result"> = { ranked: [], unlocks: [], shortTrades: 0 };
  const result = await runGame({
    // Unreachable goal: every stage runs the SAME fixed horizon, so terminal
    // wealth is the comparable outcome rather than time-to-goal.
    goal: parseGoal("wealth:1e99"),
    seed,
    horizonMs,
    bitnode: profile.bitnode,
    startingMoney: profile.startingMoney,
    features: profile.features,
    ...profile.world,
    recordFilter: (record) =>
      (record.kind === "state" && record.key === "stock")
      || (record.kind === "event" && (record.name === "stock.unlock" || record.name === "stock.trade")),
    onRecord: (line) => {
      const record = JSON.parse(line) as {
        kind: string;
        key?: string;
        name?: string;
        data?: {
          what?: string;
          kind?: string;
          plan?: { ranked?: RankedDigest[] };
          market?: { tick: number; ticksUntilCycle?: number; cyclesSeen: number };
        };
      };
      if (record.kind === "event" && record.name === "stock.unlock" && record.data?.what) {
        captured.unlocks.push(record.data.what);
      }
      if (record.kind === "event" && record.name === "stock.trade"
        && (record.data?.kind === "short" || record.data?.kind === "closeShort")) {
        captured.shortTrades++;
      }
      if (record.kind === "state" && record.key === "stock") {
        if (record.data?.plan?.ranked) captured.ranked = record.data.plan.ranked;
        if (record.data?.market) captured.market = record.data.market;
      }
    },
  });
  return { result, ...captured };
}

function expectValid(run: StageRun, label: string): void {
  expect(run.result.unmodeled, label).toEqual({});
  expect(run.result.crashes, label).toEqual([]);
  expect(run.result.validity, label).toBe("valid");
  expect(run.result.stock.wealth, label).toBe(run.result.stock.cash + run.result.stock.liquidationValue);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const HOUR = 60 * 60_000;

lane({ feature: "stock", bn: 5 }).describe("stock capability ladder", () => {
  test("stage 1 (blind): trades profitably on inferred signal, and the inferred volatilities match the hidden rolls", async () => {
    const run = await runStage("stock-ladder-blind", 1, HOUR);
    expectValid(run, "blind");
    expect(run.result.stock.tradesMade).toBeGreaterThan(0);

    // Blind means blind: the node option kept 4S unpurchasable, no short was
    // ever emitted, and every acted-on signal was estimated rather than read.
    expect(run.unlocks).not.toContain("4sData");
    expect(run.unlocks).not.toContain("4sApi");
    expect(run.shortTrades).toBe(0);
    expect(run.ranked.length).toBeGreaterThan(0);
    for (const entry of run.ranked) expect(entry.exact, entry.sym).toBe(false);

    // The 3 s sampler is strictly faster than the 4 s tick floor, so over an
    // hour (600 six-second ticks) the observed tick count must be essentially
    // complete — a missed tick here is the aliasing bug coming back.
    expect(run.market).toBeDefined();
    expect(run.market!.tick).toBeGreaterThanOrEqual(580);

    // The transcribed generation ranges are the outlier detector: a recovered
    // volatility outside its vendored range means either the transcription or
    // the estimator is wrong. And after 600 ticks the shared-roll inversion
    // must have solved the discrete grid, so the estimate is not merely inside
    // the range but equal to the actual hidden per-symbol roll, read straight
    // off the vendored market this run traded against.
    for (const entry of run.ranked) {
      const range = volatilityRange(entry.sym);
      expect(range, entry.sym).toBeDefined();
      expect(entry.volatility, entry.sym).toBeGreaterThanOrEqual(range![0] - 1e-12);
      expect(entry.volatility, entry.sym).toBeLessThanOrEqual(range![1] + 1e-12);
      const stock = SymbolToStockMap[entry.sym];
      expect(stock instanceof Stock, entry.sym).toBe(true);
      const actual = (stock as Stock).mv / 100;
      expect(Math.abs(entry.volatility - actual), entry.sym).toBeLessThanOrEqual(STOCK_VOLATILITY_STEP / 2);
    }
  }, 600_000);

  test("each rung is a straight upgrade: 4S does not underperform blind, and shorts do not underperform 4S", async () => {
    // Median across the profiles' full seed set at one fixed horizon. `>=` is
    // the claim being made — a capability upgrade must not LOSE money; strict
    // `>` is a tuning target, not a correctness gate.
    const seeds = [...findProfile("stock-ladder-blind").seeds];
    const horizon = HOUR;
    const wealth = async (id: string): Promise<number[]> => {
      const out: number[] = [];
      for (const seed of seeds) {
        const run = await runStage(id, seed, horizon);
        expectValid(run, `${id} seed ${seed}`);
        out.push(run.result.stock.wealth);
      }
      return out;
    };

    const blind = await wealth("stock-ladder-blind");
    const fourS = await wealth("stock-ladder-4s");
    const shorts = await wealth("stock-ladder-shorts");

    expect(median(fourS)).toBeGreaterThanOrEqual(median(blind));
    expect(median(shorts)).toBeGreaterThanOrEqual(median(fourS));
  }, 800_000);
});

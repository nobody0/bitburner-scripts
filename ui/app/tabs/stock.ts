import { STOCK_METADATA } from "../../../shared/features/stocks.ts";
import { chartCanvas, mountChart } from "../lib/chart.ts";
import { NONE, card, dataTable, dot, hint, meter, note, table, tiles, waiting } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import { decisionHistory } from "../lib/history.ts";
import { html, raw, type Html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Signed money, for a figure whose SIGN is the reading.
 *
 * `fmtMoney` puts the minus inside the amount (`$-4.000e8`), which is right for
 * a column of magnitudes and wrong for a P/L: the eye has to reach past the
 * currency mark to find out whether the run made money. */
function fmtSigned(n: number): string {
  return `${n < 0 ? "-" : ""}${fmtMoney(Math.abs(n))}`;
}

/** A P/L figure, coloured by which way it went.
 *
 * `Html` and not a plain string: a tile value is a TEXT slot and would escape
 * the span, printing the markup at the operator. Table cells are raw slots and
 * accept either. */
function pnl(n: number): Html {
  return html`<span class="${n >= 0 ? "good" : "bad"}">${fmtSigned(n)}</span>`;
}

export const stockTab: Tab = {
  id: "stock",
  render(state: ProjectedState) {
    const s = state.topics.stock;
    if (!s) return waiting("the stock probe");

    // Every field below `hasWseAccount` can be genuinely absent: the four
    // account flags come from `stock.account`, which runs unconditionally, while
    // prices and positions come from `stock.tick`, which is gated on the TIX API.
    // So a locked market publishes a topic with flags and nothing else, and a
    // replayed run can be projected at exactly that moment.
    const positions = s.positions ?? [];
    const portfolioValue = s.portfolioValue ?? 0;
    const portfolioCost = s.portfolioCost ?? 0;
    const unrealised = portfolioValue - portfolioCost;

    // --- Capital: what went in, what came out ------------------------------
    //
    // Three different questions, and the tab used to answer only the first:
    // how much capital is deployed (cost basis), what the book is worth right
    // now (mark-to-market), and what the market has actually CONTRIBUTED —
    // realized net plus the open book. The last is the one a run is judged on,
    // and it needs `tradeCashFlow`, which the driver self-measures around each
    // trade precisely because the game's own money-sources ledger counts an
    // open position's purchase as money gone.
    const cash = s.tradeCashFlow;
    const contribution = cash === undefined ? undefined : cash + portfolioValue;
    // Cost basis, not mark-to-market, matching game/lib/income.ts: opening a
    // position leaves this untouched, so it moves only on a realised gain or
    // loss.
    const realised = cash === undefined ? undefined : cash + Math.max(0, portfolioCost);
    const elapsedSec = state.stockFlowSince === null ? 0 : (state.lastT - state.stockFlowSince) / 1_000;
    const rate = realised !== undefined && elapsedSec > 0 ? realised / elapsedSec : undefined;
    const lifetime = state.stockInstalls.reduce((sum, install) => sum + install.realized, 0) + (realised ?? 0);

    const capitalTiles = tiles([
      {
        label: "contribution",
        value: contribution === undefined ? NONE : pnl(contribution),
        sub: "realised + open book",
      },
      {
        label: "realised P/L",
        value: realised === undefined ? NONE : pnl(realised),
        sub: rate === undefined ? "no trade yet" : `${fmtSigned(rate)}/s since first trade`,
      },
      { label: "deployed", value: fmtMoney(portfolioCost), sub: `${fmtMoney(portfolioValue)} at market` },
      { label: "unrealised P/L", value: pnl(unrealised), sub: portfolioCost ? fmtPct(unrealised / portfolioCost) : undefined },
      { label: "wealth", value: fmtMoney(s.wealth), sub: "cash + book, one snapshot" },
      ...(s.unlockSpend ? [{ label: "unlocks paid", value: fmtMoney(s.unlockSpend), sub: "WSE · TIX · 4S" }] : []),
    ]);

    // Two charts, each drawn for its CROSSING rather than its level. Book value
    // under cost basis is the moment the open book went underwater; realised net
    // under cumulative unlock spend is a market that has not yet earned back the
    // price of admission. Both bands are levels, never rates — see StockSeries.
    //
    // Withheld entirely until something can be drawn: a series under two points
    // draws nothing (see drawSeries), and a pair of empty boxes under a legend
    // reads as a broken panel rather than as a market that has not moved yet.
    // PER CHART, not one flag for both: `value`/`cost` come from the 3-second
    // tick probe and `realized`/`unlockSpend` only from a completed trade, so
    // before the first trade the book chart has data and the earnings chart has
    // none. One shared gate would draw the empty one anyway, which is the
    // "pair of empty boxes reads as a broken panel" failure this is avoiding.
    const drawable = (...points: [number, number][][]): boolean =>
      points.some((series) => series.length >= 2);
    const hasBook = drawable(state.stockSeries.value, state.stockSeries.cost);
    const hasEarnings = drawable(state.stockSeries.realized, state.stockSeries.unlockSpend);
    const hasSeries = hasBook || hasEarnings;
    // A 140px chart has no room for a legend, and the two curves coincide
    // exactly in the good case — so the caption carries the colour key.
    const banded = (id: string, why: string, left: Html, right: Html): string =>
      `<div>${chartCanvas(id)}<p class="muted" title="${esc(why)}">${left} vs ${right}</p></div>`;
    const charts = hasSeries
      ? `<div class="chartgrid">` +
        (hasBook ? banded(
          "stock-book",
          "the book marked at bid/ask against what was paid for it. The gap IS unrealised P/L, and value crossing below cost is the book going underwater.",
          html`<span class="k1">${fmtMoney(portfolioValue)} at market</span>`,
          html`<span class="k2">${fmtMoney(portfolioCost)} cost</span>`,
        ) : "") +
        (hasEarnings ? banded(
          "stock-earnings",
          "realised net against the cumulative WSE/TIX/4S spend. Until the first curve clears the second, the market has not paid for its own access.",
          html`<span class="k1">${realised === undefined ? NONE : fmtSigned(realised)} realised</span>`,
          html`<span class="k5">${fmtMoney(s.unlockSpend ?? 0)} unlocks</span>`,
        ) : "") +
        `</div>`
      : "";

    const closed = state.stockInstalls.length;
    const installs = closed
      ? note(html`${closed} earlier install${closed === 1 ? "" : "s"} · lifetime realised ${fmtSigned(lifetime)}`)
      : "";

    // --- Market state ------------------------------------------------------
    const clock = s.market;
    const access = (label: string, has: boolean | undefined, why: string) =>
      html`${dot(has ? "good" : "wait", why)}${label}`;
    const marketTiles = tiles([
      {
        // The ladder, not two loose bits: the driver climbs WSE -> TIX -> 4S and
        // which rung it is on is the whole shape of what it can do. `hasWseAccount`
        // had no reader at all before this.
        label: "access",
        value: raw(
          [
            access("WSE", s.hasWseAccount, "$200m — the exchange UI; a script reads nothing through it"),
            access("TIX", s.hasTixApiAccess, "$5b — prices, positions, buy and sell"),
            access("4S", s.has4SDataApi, "$25b — getForecast and getVolatility; without it forecasts are estimated"),
          ]
            .map(String)
            .join(" "),
        ),
        sub: "the unlock ladder",
      },
      // The cycle clock. Once one boundary has been observed the period is
      // exactly 75 ticks, so this is a countdown to the next regime change —
      // the moment ~45% of symbols invert their forecast. The flip count is the
      // EVIDENCE for that: a dozen symbols turning at once cannot be anything
      // else, and it is what the countdown was derived from.
      {
        label: "next cycle",
        value: clock?.ticksUntilCycle !== undefined ? `${clock.ticksUntilCycle} ticks` : NONE,
        sub: clock
          ? `${clock.tick} seen · ${clock.cyclesSeen} cycles · ${clock.lastFlipCount} flips` +
            (clock.lastV !== undefined ? ` · v ${clock.lastV.toFixed(2)}` : "")
          : undefined,
      },
      { label: "symbols", value: String(positions.length), sub: `${positions.filter((p) => p.shares > 0 || p.sharesShort > 0).length} held` },
    ]);

    // --- Plan -------------------------------------------------------------
    const plan = s.plan;
    const horizons = plan?.horizons;
    const planTiles = plan
      ? tiles([
          { label: "book", value: plan.flat ? "flat" : "open", sub: plan.flat ? "an install may proceed" : "an install would destroy it" },
          { label: "mode", value: plan.liquidate ? "liquidate" : "trade" },
          { label: "actions", value: String(plan.actions.length) },
          // A collapsed position horizon refuses every trade SILENTLY: no entry
          // clears its round trip, so the actions table is empty and looks idle.
          // That is why the field is published, and it had no reader.
          ...(horizons
            ? [{
                label: "horizon",
                value: horizons.positionSec > 0
                  ? fmtTime(horizons.positionSec * 1_000)
                  : html`<span class="bad">collapsed</span>`,
                sub: horizons.positionSec > 0
                  ? `unlock ${fmtTime(horizons.unlockSec * 1_000)}`
                  : "no trade can clear its round trip",
              }]
            : []),
        ])
      : "";

    const planCard = plan
      ? planTiles +
        (plan.unlock
          ? table(
              // `investmentCost` beside `cost`: the measured constraint was that
              // an unlock proposal reports ROI against ALL the capital it
              // requires, not just the next rung's price. Showing only the rung
              // makes a $25b proposal look like a $5b one.
              ["unlock", "next spend", "total capital", "gain/sec", "payback", "horizon net"],
              [[
                esc(plan.unlock.type),
                fmtMoney(plan.unlock.cost),
                fmtMoney(plan.unlock.investmentCost),
                fmtMoney(plan.unlock.gainPerSec),
                `${fmtNum(plan.unlock.paybackSec, 0)}s`,
                pnl(plan.unlock.netOverHorizon),
              ]],
              { left: [0] },
            )
          : "") +
        (plan.entry
          ? note(html`entry <b>${plan.entry.side} ${plan.entry.sym}</b>: ${fmtNum(plan.entry.shares, 0)} shares for ${fmtMoney(plan.entry.cost)}, breaks even in ${plan.entry.breakEvenTicks.toFixed(1)} of ${plan.entry.holdTicks} ticks, expected ${fmtMoney(plan.entry.expectedProfit)}`)
          : plan.reserve
            // Working capital claimed while nothing is worth entering. Without
            // this, a tab with no entry and no actions reads as a stalled
            // feature rather than one deliberately holding its bankroll.
            ? note(html`reserving ${fmtMoney(plan.reserve.amount)} at ${fmtMoney(plan.reserve.ratePerSec)}/s — no entry clears its round trip yet`)
            : "") +
        table(
          ["action", "symbol", "side", "shares", "cost"],
          plan.actions.map((action) => [
            esc(action.type),
            esc(action.sym ?? NONE),
            action.short === undefined ? NONE : action.short ? "short" : "long",
            action.shares === undefined ? NONE : fmtNum(action.shares, 0),
            action.cost === undefined ? NONE : fmtMoney(action.cost),
          ]),
          { empty: "no actions this tick", left: [0, 1, 2] },
        ) +
        (plan.lastResult
          ? note(html`last: <span class="${plan.lastResult.ok ? "good" : "bad"}">${plan.lastResult.action}</span> — ${plan.lastResult.detail}`)
          : "")
      : note("no plan yet");

    // --- Positions and open orders ----------------------------------------
    const held = positions.filter((p) => p.shares > 0 || p.sharesShort > 0);
    const positionsTable = dataTable("stock.positions", held, [
      { id: "sym", label: "sym", left: true, cell: (p) => esc(p.sym), sort: (p) => p.sym },
      { id: "shares", label: "shares", cell: (p) => fmtNum(p.shares || -p.sharesShort, 0), sort: (p) => p.shares || -p.sharesShort },
      { id: "avg", label: "avg", cell: (p) => fmtMoney(p.shares > 0 ? p.avgPx : p.avgPxShort), sort: (p) => (p.shares > 0 ? p.avgPx : p.avgPxShort) },
      { id: "bid", label: "bid", cell: (p) => fmtMoney(p.bid), sort: (p) => p.bid },
      { id: "value", label: "value", cell: (p) => fmtMoney(p.value), sort: (p) => p.value },
      { id: "pl", label: "P/L", cell: (p) => pnl(p.value - p.costBasis), sort: (p) => p.value - p.costBasis },
    ], { defaultSort: { key: "value", dir: -1 }, empty: "no open positions" });

    // 4S/BN8 only, and we never place one — so anything here is the game's, and
    // worth seeing precisely because we did not put it there. The probe pays RAM
    // for this every five minutes.
    const orderRows = Object.entries(s.orders ?? {}).flatMap(([sym, orders]) =>
      orders.map((order) => [esc(sym), esc(order.type), esc(order.position), fmtNum(order.shares, 0), fmtMoney(order.price)]),
    );
    const orders = orderRows.length
      ? table(["sym", "order", "position", "shares", "price"], orderRows, { left: [0, 1, 2] })
      : "";

    // --- The 33 symbols ----------------------------------------------------
    // Prices come from stock.tick, the 4S signal from stock.forecast — two
    // probes gated on different flags, joined here by symbol. The organization
    // is static game data, not a probed field.
    const signal = (sym: string) => s.signals?.[sym];
    const ranked = new Map((plan?.ranked ?? []).map((r) => [r.sym, r]));
    const market = dataTable(
      "stock.market",
      positions,
      [
        { id: "sym", label: "sym", left: true, sort: (p) => p.sym, cell: (p) => esc(p.sym) },
        {
          id: "org",
          label: "org",
          left: true,
          sort: (p) => STOCK_METADATA[p.sym]?.organization ?? "",
          cell: (p) => esc(STOCK_METADATA[p.sym]?.organization ?? "—"),
        },
        {
          // The other half of this feature: hack pushes a symbol down and grow
          // pushes it up, so a symbol whose host the farm can currently drive is
          // one we could PUSH rather than merely wait on. See spec/targeting.md.
          id: "farm",
          label: "farm",
          sort: (p) => (ranked.get(p.sym)?.manipulable ? 1 : 0),
          cell: (p) =>
            ranked.get(p.sym)?.manipulable
              ? dot("ready", "the farm can drive this symbol's host, so a position in it can be pushed")
              : `<span class="muted">–</span>`,
        },
        { id: "price", label: "price", sort: (p) => p.price, cell: (p) => fmtMoney(p.price) },
        {
          id: "spread",
          label: "spread",
          // The cost the previous version could not see at all: a round trip
          // crosses this twice, which on a wide symbol dwarfs the $200k fee.
          sort: (p) => (p.ask > 0 ? (p.ask - p.bid) / p.ask : 0),
          cell: (p) => (p.ask > 0 ? fmtPct((p.ask - p.bid) / p.ask, 2) : `<span class="muted">–</span>`),
        },
        {
          id: "forecast",
          label: "forecast",
          sort: (p) => signal(p.sym)?.forecast ?? ranked.get(p.sym)?.forecast ?? 0,
          cell: (p) => {
            const entry = ranked.get(p.sym);
            const forecast = signal(p.sym)?.forecast ?? entry?.forecast;
            if (forecast === undefined) return `<span class="muted">–</span>`;
            // A forecast is a probability centred on 0.5, so the meter shows
            // distance from the coin flip rather than the raw value. An
            // ESTIMATED forecast (recovered from price history, no 4S) is marked
            // so a thin estimate is never mistaken for the exact figure.
            const label = entry && !entry.exact ? `~${fmtPct(forecast)}` : fmtPct(forecast);
            return meter(forecast, label, forecast > 0.5);
          },
        },
        {
          id: "vol",
          label: "volatility",
          sort: (p) => signal(p.sym)?.volatility ?? ranked.get(p.sym)?.volatility ?? 0,
          cell: (p) => {
            const vol = signal(p.sym)?.volatility ?? ranked.get(p.sym)?.volatility;
            return vol !== undefined ? fmtPct(vol, 2) : `<span class="muted">–</span>`;
          },
        },
        {
          id: "breakeven",
          label: "break-even",
          sort: (p) => ranked.get(p.sym)?.breakEvenTicks ?? Infinity,
          cell: (p) => {
            const be = ranked.get(p.sym)?.breakEvenTicks;
            return be !== undefined && be >= 0 ? `${be.toFixed(1)} ticks` : `<span class="muted">–</span>`;
          },
        },
        {
          // What the solver thinks the position is worth over its hold. The
          // ranking was already sent and only its break-even was ever read.
          id: "expected",
          label: "expected",
          sort: (p) => ranked.get(p.sym)?.expectedProfit ?? -Infinity,
          cell: (p) => {
            const expected = ranked.get(p.sym)?.expectedProfit;
            return expected === undefined ? `<span class="muted">–</span>` : pnl(expected);
          },
        },
        { id: "max", label: "max shares", sort: (p) => p.maxShares, cell: (p) => fmtNum(p.maxShares, 0) },
      ],
      { defaultSort: { key: "forecast", dir: -1 }, empty: "no symbols" },
    );

    const manipulation = table(
      ["host", "sym", "op", "$/op", "notional"],
      Object.entries(s.manipulation ?? {}).map(([host, m]) => [
        esc(host),
        esc(m.sym),
        m.side === "long" ? "grow" : "hack",
        fmtMoney(m.valuePerOp),
        fmtMoney(m.notional),
      ]),
      { empty: "no symbol worth manipulating", left: [0, 1, 2] },
    );

    // The recent trade log. Bounded by the event ring, so it is a log and not a
    // run history — the run history is the earnings curve above, which is the
    // division of labour the two exist for.
    const history = decisionHistory(state, { subsystem: "stock", by: "stock" });

    return (
      `<div class="col wide">` +
      card("Capital", capitalTiles + charts + installs) +
      card("Market", marketTiles + market) +
      `</div>` +
      `<div class="col">` +
      card("Plan", planCard) +
      card("Positions", positionsTable + orders) +
      (history ? card("Decision history", history) : "") +
      // hack pushes a symbol DOWN and grow pushes it UP, so this is the channel
      // by which the market commandeers the HWGW farm. See spec/targeting.md.
      card("Manipulation", manipulation) +
      (s.has4SDataApi
        ? ""
        : card(
            html`Forecasts (${hint("estimated", "no 4S API: forecasts are estimated from up-tick frequency and the shared per-tick volatility roll. The $1b 4S Market Data is deliberately never bought — only the $25b TIX API unlocks getForecast for a script.")})`,
            note("no 4S API — hover for how forecasts are estimated"),
          )) +
      `</div>`
    );
  },

  mount(state, el) {
    mountChart(
      el,
      "stock-book",
      [
        { pts: state.stockSeries.value, color: "--series-1", label: "at market" },
        { pts: state.stockSeries.cost, color: "--series-2", label: "cost" },
      ],
      state.t0,
    );
    mountChart(
      el,
      "stock-earnings",
      [
        { pts: state.stockSeries.realized, color: "--series-1", label: "realised" },
        { pts: state.stockSeries.unlockSpend, color: "--series-5", label: "unlocks" },
      ],
      state.t0,
    );
  },
};

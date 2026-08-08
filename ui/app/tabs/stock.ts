import { card, dataTable, meter, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const stockTab: Tab = {
  id: "stock",
  render(state: ProjectedState) {
    const s = state.topics.stock;
    if (!s) return note("waiting for the stock probe");

    const pnl = s.portfolioValue - s.portfolioCost;
    const summary = tiles([
      { label: "portfolio", value: fmtMoney(s.portfolioValue) },
      { label: "cost basis", value: fmtMoney(s.portfolioCost) },
      { label: "unrealised P/L", value: fmtMoney(pnl), sub: s.portfolioCost ? fmtPct(pnl / s.portfolioCost) : undefined },
      { label: "TIX API", value: s.hasTixApiAccess ? "yes" : "no" },
      { label: "4S data", value: s.has4SData ? "yes" : "no" },
    ]);

    const held = s.positions.filter((p) => p.shares > 0 || p.sharesShort > 0);
    const positions = table(
      ["sym", "shares", "avg", "price", "value", "P/L"],
      held.map((p) => {
        const gain = p.value - p.costBasis;
        return [
          esc(p.sym),
          fmtNum(p.shares || -p.sharesShort, 0),
          fmtMoney(p.shares > 0 ? p.avgPx : p.avgPxShort),
          fmtMoney(p.price),
          fmtMoney(p.value),
          `<span class="${gain >= 0 ? "good" : "bad"}">${fmtMoney(gain)}</span>`,
        ];
      }),
      { empty: "no open positions", left: [0] },
    );

    // Prices come from stock.core, 4S signal from stock.forecast — two probes
    // at different cadences, joined here by symbol.
    const signal = (sym: string) => s.signals?.[sym];
    const market = dataTable(
      "stock.market",
      s.positions,
      [
        { id: "sym", label: "sym", left: true, sort: (p) => p.sym, cell: (p) => esc(p.sym) },
        {
          id: "org",
          label: "org",
          left: true,
          sort: (p) => signal(p.sym)?.organization ?? "",
          cell: (p) => esc(signal(p.sym)?.organization ?? "—"),
        },
        { id: "price", label: "price", sort: (p) => p.price, cell: (p) => fmtMoney(p.price) },
        {
          id: "forecast",
          label: "forecast",
          sort: (p) => signal(p.sym)?.forecast ?? 0,
          cell: (p) => {
            const forecast = signal(p.sym)?.forecast;
            if (forecast === undefined) return `<span class="muted">–</span>`;
            // A forecast is a probability centred on 0.5, so the meter shows
            // distance from the coin flip rather than the raw value.
            return meter(forecast, fmtPct(forecast), forecast > 0.5);
          },
        },
        {
          id: "vol",
          label: "volatility",
          sort: (p) => signal(p.sym)?.volatility ?? 0,
          cell: (p) => {
            const vol = signal(p.sym)?.volatility;
            return vol !== undefined ? fmtPct(vol, 2) : `<span class="muted">–</span>`;
          },
        },
        { id: "max", label: "max shares", sort: (p) => p.maxShares, cell: (p) => fmtNum(p.maxShares, 0) },
      ],
      { defaultSort: { key: "forecast", dir: -1 }, empty: "no symbols" },
    );

    return (
      `<div class="col wide">` +
      card("Market", summary + market) +
      `</div>` +
      `<div class="col">` +
      card("Positions", positions) +
      (s.has4SData ? "" : card("4S market data", note("forecast and volatility require the 4S Market Data TIX API"))) +
      `</div>`
    );
  },
};

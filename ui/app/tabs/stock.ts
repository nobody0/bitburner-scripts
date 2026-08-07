import { card, note, table, tiles } from "../lib/dom.ts";
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
      "no open positions",
    );

    // Prices come from stock.core, 4S signal from stock.forecast — two probes
    // at different cadences, joined here by symbol.
    const signal = (sym: string) => s.signals?.[sym];
    const market = table(
      ["sym", "org", "price", "forecast", "volatility", "max shares"],
      s.positions
        .slice()
        .sort((a, b) => (signal(b.sym)?.forecast ?? 0) - (signal(a.sym)?.forecast ?? 0))
        .map((p) => {
          const sig = signal(p.sym);
          return [
            esc(p.sym),
            esc(sig?.organization ?? "—"),
            fmtMoney(p.price),
            sig?.forecast !== undefined
              ? `<span class="${sig.forecast > 0.5 ? "good" : "bad"}">${fmtPct(sig.forecast)}</span>`
              : "–",
            sig?.volatility !== undefined ? fmtPct(sig.volatility, 2) : "–",
            fmtNum(p.maxShares, 0),
          ];
        }),
      "no symbols",
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

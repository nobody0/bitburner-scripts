import { STOCK_METADATA } from "../../../shared/features/stocks.ts";
import { card, dataTable, meter, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const stockTab: Tab = {
  id: "stock",
  render(state: ProjectedState) {
    const s = state.topics.stock;
    if (!s) return note("waiting for the stock probe");

    // Every field below `hasWseAccount` can be genuinely absent: the four
    // account flags come from `stock.account`, which runs unconditionally, while
    // prices and positions come from `stock.tick`, which is gated on the TIX API.
    // So a locked market publishes a topic with flags and nothing else, and a
    // replayed run can be projected at exactly that moment.
    const positions = s.positions ?? [];
    const portfolioValue = s.portfolioValue ?? 0;
    const portfolioCost = s.portfolioCost ?? 0;
    const pnl = portfolioValue - portfolioCost;
    const clock = s.market;
    const summary = tiles([
      { label: "portfolio", value: fmtMoney(portfolioValue) },
      { label: "cost basis", value: fmtMoney(portfolioCost) },
      { label: "unrealised P/L", value: fmtMoney(pnl), sub: portfolioCost ? fmtPct(pnl / portfolioCost) : undefined },
      { label: "TIX API", value: s.hasTixApiAccess ? "yes" : "no" },
      { label: "4S API", value: s.has4SDataApi ? "yes" : "no" },
      // The cycle clock. Once one boundary has been observed the period is
      // exactly 75 ticks, so this is a countdown to the next regime change —
      // the moment ~45% of symbols invert their forecast.
      {
        label: "next cycle",
        value: clock?.ticksUntilCycle !== undefined ? `${clock.ticksUntilCycle} ticks` : "—",
        sub: clock ? `${clock.tick} ticks seen, ${clock.cyclesSeen} cycles` : undefined,
      },
    ]);

    const plan = s.plan;
    const planCard = plan
      ? note(esc(plan.why)) +
        (plan.blocker ? note(`<span class="bad">blocked:</span> ${esc(plan.blocker)}`) : "") +
        (plan.hold ? note(`holding: ${esc(plan.hold)}`) : "") +
        // What progression gates the irreversible reset on. Worth showing next to
        // the plan, because a run that cannot install is often waiting on this.
        note(plan.flat ? "book is <b>flat</b> — an install may proceed" : "book is <b>not flat</b> — an install would destroy it") +
        (plan.unlock
          ? note(
              `next unlock <b>${esc(plan.unlock.type)}</b> at ${fmtMoney(plan.unlock.cost)} — ` +
                `${esc(plan.unlock.why)}`,
            )
          : "") +
        (plan.entry
          ? note(
              `entry <b>${esc(plan.entry.side)} ${esc(plan.entry.sym)}</b>: ${fmtNum(plan.entry.shares, 0)} shares ` +
                `for ${fmtMoney(plan.entry.cost)}, breaks even in ${plan.entry.breakEvenTicks.toFixed(1)} of ` +
                `${plan.entry.holdTicks} ticks, expected ${fmtMoney(plan.entry.expectedProfit)}`,
            )
          : "") +
        table(
          ["action", "why"],
          plan.actions.map((a) => [esc(a.type), esc(a.why)]),
          { empty: "no actions this tick", left: [0, 1] },
        ) +
        (plan.lastResult
          ? note(
              `last: <span class="${plan.lastResult.ok ? "good" : "bad"}">${esc(plan.lastResult.action)}</span> — ` +
                esc(plan.lastResult.detail),
            )
          : "")
      : note("no plan yet");

    const held = positions.filter((p) => p.shares > 0 || p.sharesShort > 0);
    const positionsTable = table(
      ["sym", "shares", "avg", "bid", "value", "P/L"],
      held.map((p) => {
        const gain = p.value - p.costBasis;
        return [
          esc(p.sym),
          fmtNum(p.shares || -p.sharesShort, 0),
          fmtMoney(p.shares > 0 ? p.avgPx : p.avgPxShort),
          fmtMoney(p.bid),
          fmtMoney(p.value),
          `<span class="${gain >= 0 ? "good" : "bad"}">${fmtMoney(gain)}</span>`,
        ];
      }),
      { empty: "no open positions", left: [0] },
    );

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
        { id: "max", label: "max shares", sort: (p) => p.maxShares, cell: (p) => fmtNum(p.maxShares, 0) },
      ],
      { defaultSort: { key: "forecast", dir: -1 }, empty: "no symbols" },
    );

    const manipulation = table(
      ["host", "sym", "op", "$/op", "why"],
      Object.entries(s.manipulation ?? {}).map(([host, m]) => [
        esc(host),
        esc(m.sym),
        m.side === "long" ? "grow" : "hack",
        fmtMoney(m.valuePerOp),
        esc(m.why),
      ]),
      { empty: "no symbol worth manipulating", left: [0, 1, 2, 4] },
    );

    return (
      `<div class="col wide">` +
      card("Market", summary + market) +
      `</div>` +
      `<div class="col">` +
      card("Plan", planCard) +
      card("Positions", positionsTable) +
      // hack pushes a symbol DOWN and grow pushes it UP, so this is the channel
      // by which the market commandeers the HWGW farm. See spec/targeting.md.
      card("Manipulation", manipulation) +
      (s.has4SDataApi
        ? ""
        : card(
            "4S market data",
            note(
              "no 4S API: forecasts below are ESTIMATED from up-tick frequency and the volatility " +
                "from the shared per-tick roll. The $1b 4S Market Data is deliberately never bought — " +
                "only the $25b TIX API unlocks getForecast for a script.",
            ),
          )) +
      `</div>`
    );
  },
};

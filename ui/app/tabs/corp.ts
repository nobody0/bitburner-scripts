import { card, definitions, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const corpTab: Tab = {
  id: "corp",
  render(state: ProjectedState) {
    const c = state.topics.corp;
    if (!c) return note("waiting for the corporation probe (getCorporation is 10 GB — it needs home headroom)");

    const profit = c.revenue - c.expenses;
    const summary = tiles([
      { label: "corporation", value: c.name, sub: c.public ? "public" : "private" },
      { label: "funds", value: fmtMoney(c.funds) },
      { label: "revenue", value: `${fmtMoney(c.revenue)}/s` },
      { label: "profit", value: `<span>${fmtMoney(profit)}</span>/s` },
      { label: "valuation", value: fmtMoney(c.valuation) },
      { label: "share price", value: fmtMoney(c.sharePrice), sub: `${fmtNum(c.numShares, 0)} owned` },
      { label: "state", value: c.state },
    ]);

    const divisions = table(
      ["division", "industry", "revenue", "expenses", "research", "adverts", "cities", "products"],
      (c.divisions ?? []).map((d) => [
        esc(d.name),
        esc(d.industry || "—"),
        fmtMoney(d.lastCycleRevenue),
        fmtMoney(d.lastCycleExpenses),
        fmtNum(d.researchPoints, 0),
        String(d.numAdVerts),
        String(d.cities.length),
        `${d.products.length}/${d.maxProducts}`,
      ]),
      "waiting for the corp.divisions probe",
    );

    const detail = (c.divisions ?? [])
      .filter((d) => d.offices?.length)
      .map((d) =>
        card(
          `${d.name} — offices`,
          table(
            ["city", "employees", "energy", "morale", "warehouse"],
            (d.offices ?? []).map((o) => {
              const w = d.warehouses?.find((x) => x.city === o.city);
              return [
                esc(o.city),
                `${o.numEmployees}/${o.size}`,
                fmtNum(o.avgEnergy, 1),
                fmtNum(o.avgMorale, 1),
                w ? `${fmtNum(w.sizeUsed, 0)}/${fmtNum(w.size, 0)}` : "—",
              ];
            }),
          ),
        ),
      )
      .join("");

    const offer = c.investmentOffer
      ? definitions([
          ["round", String(c.investmentOffer.round)],
          ["funds", fmtMoney(c.investmentOffer.funds)],
          ["shares", fmtNum(c.investmentOffer.shares, 0)],
        ])
      : note("no investment offer available");

    const shares = definitions([
      ["total shares", fmtNum(c.totalShares, 0)],
      ["owned", `${fmtNum(c.numShares, 0)} (${fmtPct(c.totalShares ? c.numShares / c.totalShares : 0)})`],
      ["issued", fmtNum(c.issuedShares, 0)],
      ["dividend rate", fmtPct(c.dividendRate)],
      ["dividend earnings", `${fmtMoney(c.dividendEarnings)}/s`],
    ]);

    return (
      `<div class="col wide">` +
      card("Corporation", summary + divisions) +
      detail +
      `</div>` +
      `<div class="col">` +
      card("Shares", shares) +
      card("Investment", offer) +
      `</div>`
    );
  },
};

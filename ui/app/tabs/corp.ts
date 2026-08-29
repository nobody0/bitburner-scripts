import { stamp } from "../lib/clock.ts";
import { card, definitions, dot, hint, NONE, outcome, table, tiles, waiting, waitingPanel } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";
import type { CorpAction } from "../../../shared/strategy/corp/decide.ts";

function actionTarget(action: CorpAction): string {
  const parts: string[] = [];
  if ("division" in action) parts.push(action.division);
  else if ("name" in action) parts.push(action.name);
  else parts.push(action.unlock);
  if ("city" in action) parts.push(action.city);
  if ("position" in action) parts.push(action.position);
  else if ("material" in action) parts.push(action.material);
  return parts.join(" / ") || "—";
}

export const corpTab: Tab = {
  id: "corp",
  render(state: ProjectedState) {
    const c = state.topics.corp;
    if (!c) {
      const access = state.caps.corporation;
      if (access.exists === "no" && state.caps.unlocked.corp === "yes") {
        return waitingPanel("Corporation", "corporation founding", "waiting for the creation check or its one-shot funding grant");
      }
      return waitingPanel("Corporation", "the corporation probe", "getCorporation needs an existing corporation and home RAM headroom");
    }

    const profit = c.revenue - c.expenses;
    const summary = tiles([
      { label: "corporation", value: c.name, sub: c.public ? "public" : "private" },
      { label: "funds", value: fmtMoney(c.funds) },
      { label: "revenue", value: `${fmtMoney(c.revenue)}/s` },
      { label: "profit", value: html`<span>${fmtMoney(profit)}</span>/s` },
      { label: "valuation", value: fmtMoney(c.valuation) },
      { label: "share price", value: fmtMoney(c.sharePrice), sub: `${fmtNum(c.numShares, 0)} owned` },
      { label: "state", value: c.state },
    ]);

    const divisions = c.divisions === undefined
      ? waiting("the corp.divisions probe", "office and warehouse detail runs every two minutes")
      : table(
          ["division", "industry", "revenue", "expenses", "research", "adverts", "cities", "products"],
          c.divisions.map((d) => [
            esc(d.name), esc(d.industry || "—"), fmtMoney(d.lastCycleRevenue), fmtMoney(d.lastCycleExpenses),
            fmtNum(d.researchPoints, 0), String(d.numAdVerts), String(d.cities.length), `${d.products.length}/${d.maxProducts}`,
          ]),
          "no divisions yet",
        );

    const detail = (c.divisions ?? []).filter((d) => d.offices?.length).map((d) => card(
      `${d.name} — offices`,
      table(
        ["city", "employees", hint("jobs", "observed headcount by job title"), "energy", "morale", "warehouse", "smart supply", "sales"],
        (d.offices ?? []).map((o) => {
          const w = d.warehouses?.find((entry) => entry.city === o.city);
          const jobs = Object.entries(o.jobs);
          // `materials` is newer than the warehouse digest itself, so a stored
          // run recorded before it carries warehouses without the field.
          const sales = w?.materials?.filter((material) =>
            material.desiredSellAmount === "MAX" && material.desiredSellPrice === "MP"
          ).map((material) => material.name).join(", ");
          return [
            esc(o.city), `${o.numEmployees}/${o.size}`,
            jobs.length ? `<div class="chips">${jobs.map(([title, count]) => `<span class="chip idle">${esc(title)} ${fmtNum(count, 0)}</span>`).join("")}</div>` : NONE,
            fmtNum(o.avgEnergy, 1), fmtNum(o.avgMorale, 1),
            w ? `${fmtNum(w.sizeUsed, 0)}/${fmtNum(w.size, 0)}` : NONE,
            w ? (w.smartSupplyEnabled ? `${dot("good", "observed enabled")} on` : `${dot("ready", "observed disabled")} off`) : NONE,
            sales || NONE,
          ];
        }),
        { wrap: [2] },
      ),
    )).join("");

    const shares = definitions([
      ["total shares", fmtNum(c.totalShares, 0)],
      ["owned", `${fmtNum(c.numShares, 0)} (${fmtPct(c.totalShares ? c.numShares / c.totalShares : 0)})`],
      ["issued", fmtNum(c.issuedShares, 0)],
      ["dividend rate", fmtPct(c.dividendRate)],
      ["dividend earnings", `${fmtMoney(c.dividendEarnings)}/s`],
    ]);

    const plan = c.plan;
    const decision = plan
      ? tiles([
          { label: "stage", value: plan.stage, sub: plan.status },
          { label: "batch", value: `${plan.actions.length} action(s)`, sub: plan.detail },
        ]) +
        (plan.actions.length
          ? table(
              ["action", "target"],
              plan.actions.map((action) => [
                esc(action.type),
                esc(actionTarget(action)),
              ]),
              "",
            )
          : "") +
        // Results are sticky: the module-level buffer is only cleared when a
        // NEW observation is acted on, so an unstamped line reads as fresh
        // long after it was issued.
        (plan.lastResults ?? []).map((entry) => outcome({
          ok: entry.ok,
          detail: html`${entry.detail} · ${stamp(state, entry.at)}`,
        })).join("")
      : waiting("the first corporation decision");

    return `<div class="col wide">${card("Corporation", summary + divisions)}${card("Decision", decision)}${detail}</div>` +
      `<div class="col">${card("Shares", shares)}</div>`;
  },
};

import { card, definitions, dot, hint, NONE, note, outcome, table, tiles, waiting, waitingPanel } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const corpTab: Tab = {
  id: "corp",
  render(state: ProjectedState) {
    const c = state.topics.corp;
    if (!c) return waitingPanel("Corporation", "the corporation probe", "getCorporation is 10 GB — it needs home headroom");

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

    // `undefined` and `[]` are different facts here, and one shared
    // empty-message reported them as the same one. `corp.divisions` publishes
    // only when every step of its probe ran (priced.ts `finish` gates on
    // `complete`), and a corporation that has no divisions publishes an empty
    // array — so "waiting for the corp.divisions probe" was printed beside a
    // Decision card reading stage `agriculture` / action `expandIndustry` off
    // that very array. Corp actions are never executed (features/remaining.ts),
    // so the empty case is not a first-minutes transient either: it stands
    // until the operator expands by hand.
    //
    // awareness / popularity / productionMult are shown as plain columns next
    // to `adverts` and deliberately not captioned as what the adverts bought:
    // nothing in this repo calls hireAdVert, so any adverts present were not
    // bought here and a causal reading would be ours, not the data's.
    const divisions =
      c.divisions === undefined
        ? waiting("the corp.divisions probe", "getDivision is 10 GB — it runs every two minutes")
        : table(
            [
              "division",
              "industry",
              "revenue",
              "expenses",
              "research",
              "adverts",
              "awareness",
              "popularity",
              "production",
              "cities",
              "products",
            ],
            c.divisions.map((d) => [
              esc(d.name),
              esc(d.industry || "—"),
              fmtMoney(d.lastCycleRevenue),
              fmtMoney(d.lastCycleExpenses),
              fmtNum(d.researchPoints, 0),
              String(d.numAdVerts),
              fmtNum(d.awareness, 1),
              fmtNum(d.popularity, 1),
              `${fmtNum(d.productionMult, 2)}×`,
              String(d.cities.length),
              `${d.products.length}/${d.maxProducts}`,
            ]),
            "no divisions yet — the corp plan's expandIndustry stage is next",
          );

    const detail = (c.divisions ?? [])
      .filter((d) => d.offices?.length)
      .map((d) =>
        card(
          `${d.name} — offices`,
          table(
            [
              "city",
              "employees",
              hint("jobs", "headcount by job title as last probed — no stage hires, and corp actions are not executed"),
              "energy",
              "morale",
              "warehouse",
              "level",
              hint("smart supply", "the smart-supply stage is done only once every warehouse of the division has it on"),
            ],
            (d.offices ?? []).map((o) => {
              const w = d.warehouses?.find((x) => x.city === o.city);
              // A city with no warehouse is a THIRD state, not "smart supply
              // off": the probe's warehouse-presence step only reads
              // getWarehouse for cities that have one, so telemetry never said
              // anything about supply or level here. Painting those cells as
              // off/0 would be the panel asserting a fact of its own — and
              // this is exactly the city the buyWarehouse stage is waiting on.
              const jobs = Object.entries(o.jobs);
              return [
                esc(o.city),
                `${o.numEmployees}/${o.size}`,
                jobs.length
                  ? `<div class="chips">${jobs
                      .map(([title, count]) => `<span class="chip idle">${esc(title)} ${fmtNum(count, 0)}</span>`)
                      .join("")}</div>`
                  : NONE,
                fmtNum(o.avgEnergy, 1),
                fmtNum(o.avgMorale, 1),
                w ? `${fmtNum(w.sizeUsed, 0)}/${fmtNum(w.size, 0)}` : "—",
                w ? fmtNum(w.level, 0) : NONE,
                w
                  ? w.smartSupplyEnabled
                    ? `${dot("good", "smart supply is on")} on`
                    : `${dot("ready", "the corp plan's smart-supply stage targets a warehouse with it off")} off`
                  : NONE,
              ];
            }),
            { wrap: [2] },
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

    const plan = c.plan;
    const actionSubject = plan
      ? [plan.action.division ?? plan.action.industry, plan.action.city, plan.action.name ?? plan.action.material]
          .filter((value): value is string => Boolean(value))
          .join(" / ")
      : "";
    const decision = plan
      ? tiles([
          { label: "stage", value: plan.stage, sub: `${plan.completed.length} stage(s) complete` },
          {
            label: "selected",
            value: plan.action.type,
            sub: actionSubject || (plan.action.round !== undefined ? `round ${plan.action.round}` : undefined),
          },
        ]) +
        (plan.completed.length
          ? table(["completed stage"], plan.completed.map((stage) => [esc(stage)]), { left: [0] })
          : note("no stages complete yet")) +
        (plan.lastResult ? outcome(plan.lastResult) : "")
      : waiting("the first corporation decision");

    return (
      `<div class="col wide">` +
      card("Corporation", summary + divisions) +
      card("Decision", decision) +
      detail +
      `</div>` +
      `<div class="col">` +
      card("Shares", shares) +
      card("Investment", offer) +
      `</div>`
    );
  },
};

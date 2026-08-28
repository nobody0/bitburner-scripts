import { describeMults } from "../../../shared/features/augmentations.ts";
import { stamp } from "../lib/clock.ts";
import { card, dataTable, hint, NONE, note, outcome, table, tiles, waiting, waitingPanel } from "../lib/dom.ts";
import { esc, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const sleevesTab: Tab = {
  id: "sleeves",
  render(state: ProjectedState) {
    const s = state.topics.sleeves;
    if (!s) return waitingPanel("Sleeves", "the sleeves probe");

    type Sleeve = (typeof s.sleeves)[number];
    // An empty roster has no average, and 0% shock is the BEST reading there
    // is: averaging over nothing would present a run with no sleeves as fully
    // recovered and perfectly synchronised. `fmtPct` renders the absence.
    const avgOf = (pick: (x: Sleeve) => number): number | undefined =>
      s.sleeves.length ? s.sleeves.reduce((sum, x) => sum + pick(x), 0) / s.sleeves.length / 100 : undefined;
    const summary = tiles([
      { label: "sleeves", value: String(s.count) },
      { label: "avg shock", value: fmtPct(avgOf((x) => x.shock)), sub: "lower is better" },
      { label: "avg sync", value: fmtPct(avgOf((x) => x.sync)), sub: "higher is better" },
    ]);

    // `memory` and `storedCycles` are declared as always present, but a record
    // written before the probe read them carries neither — and `x.memory ?? 0`
    // would print the lowest possible reading for a sleeve nobody measured.
    // `Number.isFinite` is the runtime test the non-optional type cannot
    // express; the sort sentinel sits below every real reading (memory starts
    // at 1, stored cycles at 0) so unmeasured rows group at one end of the sort
    // instead of mixing into the figures.
    const measured = (value: number | undefined): boolean => typeof value === "number" && Number.isFinite(value);
    const skillColumn = (id: string, label: string, pick: (x: Sleeve) => number) => ({
      id,
      label,
      cell: (x: Sleeve) => String(pick(x)),
      sort: pick,
    });
    const rows = dataTable("sleeves.list", s.sleeves, [
      { id: "index", label: "#", cell: (x) => String(x.index), sort: (x) => x.index },
      {
        id: "task",
        label: "task",
        left: true,
        cell: (x) => esc(x.task ? `${x.task.type}${x.task.detail ? `: ${x.task.detail}` : ""}` : "idle"),
        sort: (x) => (x.task ? x.task.type : "idle"),
      },
      {
        id: "shock",
        label: "shock",
        cell: (x) => `<span class="${x.shock > 0 ? "bad" : "good"}">${x.shock.toFixed(1)}</span>`,
        sort: (x) => x.shock,
      },
      { id: "sync", label: "sync", cell: (x) => x.sync.toFixed(1), sort: (x) => x.sync },
      {
        id: "memory",
        label: "memory",
        cell: (x) => (measured(x.memory) ? String(x.memory) : NONE),
        sort: (x) => (measured(x.memory) ? x.memory : -1),
      },
      {
        // This feature's bonus time, the figure gang and bladeburner both put on
        // a tile — except that sleeves bank it per sleeve, so it is a column.
        // Rendered as time rather than as the raw count because a cycle is a
        // game constant (200 ms) and "312 cycles" is not a duration anyone can
        // compare against the ages elsewhere on the page. The drain is 15 cycles
        // per tick and only while the sleeve HAS work, so an idle sleeve's bank
        // grows — which is the reading worth seeing here.
        // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Sleeve.ts#L263-L275
        id: "bonus",
        label: "bonus",
        cell: (x) =>
          measured(x.storedCycles)
            ? hint(
                fmtTime(x.storedCycles * 200),
                `${fmtNum(x.storedCycles, 0)} stored cycles at 200ms each — spent at up to 15x, and only while the sleeve has work`,
              )
            : NONE,
        sort: (x) => (measured(x.storedCycles) ? x.storedCycles : -1),
      },
      { id: "city", label: "city", left: true, cell: (x) => esc(x.city), sort: (x) => x.city },
      { id: "hp", label: "hp", cell: (x) => `${x.hp.current}/${x.hp.max}` },
      skillColumn("hack", "hack", (x) => x.skills.hacking),
      skillColumn("str", "str", (x) => x.skills.strength),
      skillColumn("def", "def", (x) => x.skills.defense),
      skillColumn("dex", "dex", (x) => x.skills.dexterity),
      skillColumn("agi", "agi", (x) => x.skills.agility),
      skillColumn("cha", "cha", (x) => x.skills.charisma),
    ], { defaultSort: { key: "index", dir: 1 }, empty: "no sleeves" });

    // The topic publishes sleeve multipliers but no per-sleeve offer table or
    // next-sleeve cost. Render the available evidence without inventing missing
    // purchase state; reuse the augmentation panels' multiplier vocabulary.
    const multRows = s.sleeves
      .filter((x) => x.mults !== undefined)
      .map((x) => {
        // A multiplier AT 1.0 is not an effect, and describing it as "+0%" fills
        // the row with noise a fresh sleeve would be entirely made of.
        const modifiers = Object.entries(x.mults ?? {}).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] !== 1,
        );
        const all = describeMults(Object.fromEntries(modifiers), modifiers.length);
        const shown = all.slice(0, 4);
        const rest = all.length - shown.length;
        return [
          String(x.index),
          all.length === 0
            ? `<span class="muted">unmodified</span>`
            : `<span class="chips">` +
              shown.map((m, index) => `<span class="chip ${index < 2 ? "on" : "idle"}">${esc(m.text)}</span>`).join("") +
              (rest > 0
                ? `<span class="chip off" title="${esc(all.map((m) => m.text).join(", "))}">+${rest}</span>`
                : "") +
              `</span>`,
        ];
      });
    const mults = table(["sleeve", "multipliers"], multRows, {
      empty: s.sleeves.length ? "this replay predates sleeve multipliers" : "no sleeves",
      left: [1],
      wrap: [1],
    });

    const plan = s.plan;
    const decision = plan?.selection
      ? tiles([
          { label: "total score", value: fmtNum(plan.totalScore, 4) },
          { label: "task changes", value: String(plan.assignments.length) },
        ]) +
        table(
          ["sleeve", "selected task", "score", "change"],
          plan.selection.map((entry) => [
            String(entry.index),
            esc(entry.task),
            fmtNum(entry.score, 4),
            plan.assignments.some((change) => change.index === entry.index) ? "queued" : "unchanged",
          ]),
          { empty: "no task candidates", left: [1, 3] },
        ) +
        (plan.lastResult
          ? outcome({
              ok: plan.lastResult.ok,
              detail: html`${plan.lastResult.detail} · ${stamp(state, plan.lastResult.at)}`,
            })
          : "")
      : plan
        ? note("this replay predates structured sleeve scores")
        : waiting("the first sleeve decision");

    return `<div class="col wide">` + card("Sleeves", summary + rows) + card("Decision", decision) + `</div>` + `<div class="col">${card("Multipliers", mults)}</div>`;
  },
};

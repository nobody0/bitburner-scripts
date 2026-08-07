import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Side income: coding contracts and infiltration. The casino belongs to this
 * feature conceptually but exposes no ns API, so it can only be noted. */

export const sideTab: Tab = {
  id: "side",
  render(state: ProjectedState) {
    const s = state.topics.side;
    if (!s) return note("waiting for the side probe");

    const summary = tiles([
      { label: "open contracts", value: String(s.contracts.length) },
      {
        label: "infiltration targets",
        value: s.infiltrationTotal !== undefined ? String(s.infiltrationTotal) : "–",
      },
    ]);

    const contracts = table(
      ["host", "file", "type", "tries left"],
      s.contracts.map((c) => [
        esc(c.host),
        esc(c.file),
        esc(c.type),
        `<span class="${c.triesRemaining <= 2 ? "bad" : ""}">${c.triesRemaining}</span>`,
      ]),
      "no contracts on the network",
    );

    const infiltration = s.infiltration?.length
      ? table(
          ["location", "city", "difficulty", "levels", "cash", "rep", "$/difficulty"],
          s.infiltration.map((i) => [
            esc(i.location),
            esc(i.city),
            fmtNum(i.difficulty, 3),
            String(i.maxClearanceLevel),
            fmtMoney(i.moneyReward),
            fmtNum(i.repReward, 0),
            fmtMoney(i.moneyPerDifficulty),
          ]),
        )
      : note("infiltration ranking needs 15 GB of dodge budget — it is probed every 10 minutes when affordable");

    return (
      `<div class="col wide">` +
      card("Side income", summary) +
      card("Coding contracts", contracts) +
      card("Infiltration", infiltration) +
      `</div>` +
      `<div class="col">` +
      card("Casino", note("no ns API exists for the casino — it is DOM-driven only, so nothing can be reported here")) +
      `</div>`
    );
  },
};

import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Side income: coding contracts and infiltration. The casino belongs to this
 * feature conceptually but exposes no ns API, so it can only be noted.
 *
 * Contracts arrive pre-partitioned (see CONTRACT_LIMIT): a window onto the
 * ones we can solve, and a per-TYPE count of the ones we cannot. That second
 * table is the actionable one — every row is a solver worth writing, and the
 * count is how many contracts are quietly expiring without it. */

export const sideTab: Tab = {
  id: "side",
  render(state: ProjectedState) {
    const s = state.topics.side;
    if (!s) return note("waiting for the side probe");

    const solvableTotal = s.solvableTotal ?? s.contracts.length;
    const unsolvableTotal = s.unsolvableTotal ?? 0;
    const summary = tiles([
      { label: "contracts on the network", value: fmtNum(s.contractTotal ?? s.contracts.length) },
      { label: "we can solve", value: fmtNum(solvableTotal) },
      {
        label: "no solver",
        value: fmtNum(unsolvableTotal),
        sub: `${Object.keys(s.unsolvableByType ?? {}).length} type(s)`,
      },
      {
        label: "infiltration targets",
        value: s.infiltrationTotal !== undefined ? String(s.infiltrationTotal) : "–",
      },
    ]);

    const queue =
      table(
        ["host", "file", "type", "tries left"],
        s.contracts.map((c) => [
          esc(c.host),
          esc(c.file),
          esc(c.type),
          `<span class="${c.triesRemaining <= 2 ? "bad" : ""}">${c.triesRemaining}</span>`,
        ]),
        "no solvable contracts on the network",
      ) +
      (solvableTotal > s.contracts.length
        ? note(`showing the ${s.contracts.length} most at risk of ${solvableTotal} — one is attempted per minute`)
        : "");

    const missing = Object.entries(s.unsolvableByType ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const gaps = missing.length
      ? table(
          ["contract type", "waiting", "share"],
          missing.map(([type, count]) => [
            esc(type),
            String(count),
            unsolvableTotal ? `${((count / unsolvableTotal) * 100).toFixed(0)}%` : "–",
          ]),
        ) + note("each row is one missing solver in shared/strategy/side/contracts.ts")
      : note("every contract type on the network has a solver");

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
      card("Attempt queue", queue) +
      card("Infiltration", infiltration) +
      `</div>` +
      `<div class="col">` +
      card("Missing solvers", gaps) +
      card("Casino", note("no ns API exists for the casino — it is DOM-driven only, so nothing can be reported here")) +
      `</div>`
    );
  },
};

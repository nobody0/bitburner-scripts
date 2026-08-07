import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtNum, fmtPct } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Go (IPvGO). The board is rendered as a grid of cells: X black, O white,
 * '.' empty, '#' dead node. Colours come from the shared series tokens. */

const CELL_CLASS: Record<string, string> = { X: "black", O: "white", ".": "empty", "#": "dead" };

export const goTab: Tab = {
  id: "go",
  render(state: ProjectedState) {
    const g = state.topics.go;
    if (!g) return note("waiting for the Go probe");

    const summary = tiles([
      { label: "opponent", value: g.opponent },
      { label: "status", value: g.status },
      { label: "to move", value: g.currentPlayer },
      { label: "black", value: fmtNum(g.blackScore ?? 0, 1) },
      { label: "white", value: fmtNum(g.whiteScore ?? 0, 1) },
      ...(g.boardSize ? [{ label: "board", value: `${g.boardSize}x${g.boardSize}` }] : []),
      ...(g.moveCount !== undefined ? [{ label: "moves", value: String(g.moveCount) }] : []),
    ]);

    const board = g.board?.length
      ? `<div class="goboard" style="grid-template-columns:repeat(${g.board.length},1fr)">` +
        g.board
          .map((row) =>
            [...row].map((cell) => `<span class="cell ${CELL_CLASS[cell] ?? "empty"}"></span>`).join(""),
          )
          .join("") +
        `</div>` +
        (g.territory
          ? note(`controlled empty nodes — black ${g.territory.black}, white ${g.territory.white}`)
          : "")
      : note("no board — the board probe runs once a minute");

    const stats = g.stats.length
      ? table(
          ["opponent", "W", "L", "streak", "best", "rep", "bonus"],
          g.stats
            .slice()
            .sort((a, b) => b.wins - a.wins)
            .map((s) => [
              esc(s.opponent),
              String(s.wins),
              String(s.losses),
              String(s.winStreak),
              String(s.highestWinStreak),
              fmtNum(s.rep, 0),
              `${fmtPct(s.bonusPercent / 100)} ${esc(s.bonusDescription)}`,
            ]),
        )
      : note("no games played yet");

    return (
      `<div class="col">` +
      card("Subnet", summary + board) +
      `</div>` +
      `<div class="col wide">` +
      card("Record", stats) +
      `</div>`
    );
  },
};

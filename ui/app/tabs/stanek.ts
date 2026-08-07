import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtNum } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Stanek's Gift: the grid is the whole problem, so it is drawn literally.
 * Each placed fragment gets a colour bucket so the packing is legible. */

export const stanekTab: Tab = {
  id: "stanek",
  render(state: ProjectedState) {
    const s = state.topics.stanek;
    if (!s) return note("waiting for the Stanek probe");

    const summary = tiles([
      { label: "grid", value: `${s.width} x ${s.height}` },
      { label: "fragments placed", value: String(s.fragments.length) },
      { label: "cells used", value: `${Object.keys(s.occupied).length} / ${s.width * s.height}` },
    ]);

    const cells: string[] = [];
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const id = s.occupied[`${x},${y}`];
        cells.push(
          id === undefined
            ? `<span class="cell empty"></span>`
            : `<span class="cell f${id % 6}" title="${esc(`fragment ${id}`)}"></span>`,
        );
      }
    }
    const grid = s.width
      ? `<div class="gift" style="grid-template-columns:repeat(${s.width},1fr)">${cells.join("")}</div>`
      : note("no gift grid");

    const fragments = table(
      ["id", "type", "at", "rot", "power", "charges", "effect"],
      s.fragments.map((f) => [
        `<span class="swatch f${f.id % 6}"></span>${f.id}`,
        esc(f.type),
        `${f.x},${f.y}`,
        String(f.rotation),
        fmtNum(f.power, 2),
        fmtNum(f.numCharge, 0),
        esc(f.effect),
      ]),
      "nothing placed",
    );

    const available = s.availableTypes?.length
      ? table(
          ["id", "type", "power", "limit"],
          s.availableTypes.map((f) => [String(f.id), esc(f.type), fmtNum(f.power, 2), String(f.limit)]),
        )
      : "";

    return (
      `<div class="col">` +
      card("Gift", summary + grid) +
      `</div>` +
      `<div class="col wide">` +
      card("Placed fragments", fragments) +
      (available ? card("Fragment catalogue", available) : "") +
      `</div>`
    );
  },
};

import { esc } from "./format.ts";

/** Markup helpers. Tabs return HTML strings rather than building nodes: the
 * panels are small, fully re-rendered on each frame, and string templates keep
 * each tab readable as a description of its layout. Everything dynamic goes
 * through esc(). */

export interface Tile {
  label: string;
  value: string;
  /** Optional smaller line under the value. */
  sub?: string;
}

export function tiles(items: Tile[]): string {
  if (items.length === 0) return "";
  return `<div class="tiles">${items
    .map(
      (t) =>
        `<div class="tile"><div class="v">${esc(t.value)}</div><div class="l">${esc(t.label)}</div>${
          t.sub ? `<div class="l">${esc(t.sub)}</div>` : ""
        }</div>`,
    )
    .join("")}</div>`;
}

export function card(title: string, body: string): string {
  return `<section class="card"><h2>${esc(title)}</h2>${body}</section>`;
}

/** A table. Cells are pre-escaped HTML fragments so a column can carry a
 * class; use esc() when building them. */
export function table(headers: string[], rows: string[][], empty = "no data"): string {
  if (rows.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  return (
    `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
    `</tbody></table>`
  );
}

/** Label/value pairs for the "one object, many fields" panels. */
export function definitions(pairs: [string, string][]): string {
  if (pairs.length === 0) return `<p class="muted">no data</p>`;
  return `<dl class="defs">${pairs
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("")}</dl>`;
}

export function note(text: string): string {
  return `<p class="muted">${esc(text)}</p>`;
}

/** Horizontal proportional bar — used for the RAM pie and territory splits. */
export function bar(segments: { label: string; value: number; className?: string }[]): string {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  if (total <= 0) return note("nothing allocated");
  return (
    `<div class="bar">` +
    segments
      .map(
        (s) =>
          `<span class="seg ${s.className ?? ""}" style="width:${((Math.max(0, s.value) / total) * 100).toFixed(2)}%" title="${esc(
            `${s.label}: ${s.value.toFixed(1)}`,
          )}"></span>`,
      )
      .join("") +
    `</div><div class="barkey">` +
    segments.map((s) => `<span class="seg ${s.className ?? ""}"></span>${esc(s.label)}`).join("") +
    `</div>`
  );
}

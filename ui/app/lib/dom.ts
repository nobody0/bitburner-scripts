import { esc } from "./format.ts";
import { sortOf, view, type Sort } from "./viewstate.ts";

/** Markup helpers. Tabs return HTML strings rather than building nodes: the
 * panels are small, fully re-rendered on each frame, and string templates keep
 * each tab readable as a description of its layout. Everything dynamic goes
 * through esc().
 *
 * Anything interactive here is declarative — a `data-*` attribute that the
 * delegated listeners in main.ts recognise — so a helper never has to hold a
 * node reference across a re-render that will destroy it. */

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

export function card(title: string, body: string, actions = ""): string {
  return (
    `<section class="card">` +
    `<h2>${esc(title)}${actions ? `<span class="acts">${actions}</span>` : ""}</h2>` +
    body +
    `</section>`
  );
}

export interface TableOptions {
  empty?: string;
  /** Column indices that carry prose and must WRAP rather than force the card
   *  into horizontal scroll. Cells are `nowrap` by default because most
   *  columns are numeric and should stay aligned; a requirement tree or a
   *  rationale is the exception, not the rule. */
  wrap?: number[];
  /** Column indices to left-align. Only the first column is left by default. */
  left?: number[];
  /** Header cells rendered as-is (already escaped) — used for sort controls. */
  rawHeaders?: boolean;
}

/** A table. Cells are pre-escaped HTML fragments so a column can carry a
 * class; use esc() when building them. */
export function table(
  headers: string[],
  rows: string[][],
  emptyOrOptions: string | TableOptions = "no data",
): string {
  const options: TableOptions = typeof emptyOrOptions === "string" ? { empty: emptyOrOptions } : emptyOrOptions;
  if (rows.length === 0) return `<p class="muted">${esc(options.empty ?? "no data")}</p>`;
  const wrap = new Set(options.wrap ?? []);
  const left = new Set(options.left ?? []);
  const cls = (index: number): string => {
    const names = [wrap.has(index) ? "wrap" : "", left.has(index) ? "l" : ""].filter(Boolean).join(" ");
    return names ? ` class="${names}"` : "";
  };
  return (
    `<table><thead><tr>${headers
      .map((h, i) => `<th${cls(i)}>${options.rawHeaders ? h : esc(h)}</th>`)
      .join("")}</tr></thead><tbody>` +
    rows.map((cells) => `<tr>${cells.map((c, i) => `<td${cls(i)}>${c}</td>`).join("")}</tr>`).join("") +
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

// --- status ----------------------------------------------------------------

/** Four states, and they mean the same thing everywhere in the app:
 *  - `good`  — done, owned, at target, nothing to do
 *  - `ready` — actionable right now
 *  - `wait`  — reachable, but something has to happen first
 *  - `bad`   — not reachable in this run
 *  - `off`   — not applicable */
export type Status = "good" | "ready" | "wait" | "bad" | "off";

export function dot(status: Status, title = ""): string {
  return `<span class="dot ${status}"${title ? ` title="${esc(title)}"` : ""}>●</span>`;
}

/** Inline progress meter for a table cell: a bar behind a label.
 *
 * `atTarget` is separate from `value >= max` on purpose — "security is at its
 * minimum" is a target reached at the BOTTOM of the range, and the caller is
 * the only one that knows which end counts as done. */
export function meter(fraction: number, label: string, atTarget = false, title = ""): string {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    `<span class="meter${atTarget ? " done" : ""}"${title ? ` title="${esc(title)}"` : ""}>` +
    `<span class="fill" style="width:${pct.toFixed(1)}%"></span>` +
    `<span class="lab">${label}</span>` +
    `</span>`
  );
}

/** A ratio against a baseline, coloured by whether it HELPS us.
 *
 * The sign alone is meaningless: `CrimeMoney 0.70` and `AugmentationMoneyCost
 * 1.43` are both bad news, and colouring by direction would paint them
 * opposite ways. `harderWhen` says which end hurts. */
export function ratio(value: number, base: number, harderWhen: "higher" | "lower" = "lower"): string {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return `<span class="muted">–</span>`;
  const pct = (value / base) * 100;
  const harder = harderWhen === "higher" ? value > base : value < base;
  const cls = value === base ? "muted" : harder ? "bad" : "good";
  return `<span class="${cls}">${pct.toFixed(0)}%</span>`;
}

// --- interactive -----------------------------------------------------------

export interface FilterOption {
  value: string;
  label: string;
  /** Shown after the label, e.g. a count. */
  badge?: string;
}

/** A row of filter chips. `key` is the viewstate key; the selected value is
 * read back with `view(key, fallback)`. */
export function filters(key: string, options: FilterOption[], fallback: string): string {
  const current = view(key, fallback);
  return (
    `<div class="chips filters">` +
    options
      .map(
        (o) =>
          `<button class="chip pick${o.value === current ? " sel" : ""}" data-view-key="${esc(key)}" ` +
          `data-view-value="${esc(o.value)}">${esc(o.label)}` +
          (o.badge ? `<span class="badge">${esc(o.badge)}</span>` : "") +
          `</button>`,
      )
      .join("") +
    `</div>`
  );
}

/** A search box that survives the panel being rebuilt under it — main.ts
 * restores focus and selection by id after each render. */
export function search(key: string, placeholder: string): string {
  return (
    `<input class="search" type="search" id="search-${esc(key)}" data-view-key="${esc(key)}" ` +
    `placeholder="${esc(placeholder)}" value="${esc(view(key))}" />`
  );
}

export function collapsible(summary: string, body: string, open = false): string {
  return `<details${open ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
}

// --- data tables -----------------------------------------------------------

export interface Column<T> {
  /** Stable id, used as the sort key. */
  id: string;
  label: string;
  cell(row: T): string;
  /** Omit to make the column unsortable. */
  sort?(row: T): number | string;
  wrap?: boolean;
  left?: boolean;
}

export interface DataTableOptions<T> {
  empty?: string;
  /** Applied when no sort has been chosen. */
  defaultSort: Sort;
  /** Rows past this are dropped, with a note saying how many. */
  limit?: number;
}

/** A sortable table. Header cells carry `data-sort-table`/`data-sort-key`; the
 * delegated click handler in main.ts writes the choice to viewstate, so the
 * sort survives the re-render it triggers. */
export function dataTable<T>(id: string, rows: readonly T[], columns: Column<T>[], options: DataTableOptions<T>): string {
  if (rows.length === 0) return note(options.empty ?? "no data");
  const active = sortOf(id, options.defaultSort);
  const column = columns.find((c) => c.id === active.key && c.sort) ?? columns.find((c) => c.sort);
  const sorted = column?.sort
    ? [...rows].sort((a, b) => {
        const av = column.sort!(a);
        const bv = column.sort!(b);
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return cmp * active.dir;
      })
    : [...rows];

  const shown = options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
  const headers = columns.map((c) => {
    const arrow = column?.id === c.id ? (active.dir === 1 ? " ▲" : " ▼") : "";
    if (!c.sort) return esc(c.label);
    return (
      `<button class="sortby${column?.id === c.id ? " sel" : ""}" data-sort-table="${esc(id)}" ` +
      `data-sort-key="${esc(c.id)}">${esc(c.label)}${arrow}</button>`
    );
  });

  const body = table(
    headers,
    shown.map((row) => columns.map((c) => c.cell(row))),
    {
      empty: options.empty ?? "no data",
      wrap: columns.flatMap((c, i) => (c.wrap ? [i] : [])),
      left: columns.flatMap((c, i) => (c.left ? [i] : [])),
      rawHeaders: true,
    },
  );

  const truncated =
    options.limit !== undefined && sorted.length > options.limit
      ? note(`showing ${options.limit} of ${sorted.length} — sort or filter to see the rest`)
      : "";
  return body + truncated;
}

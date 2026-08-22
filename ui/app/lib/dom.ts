import { esc } from "./format.ts";
import { Html, html, inline, raw, type Markup } from "./html.ts";
import { sortOf, view, type Sort } from "./viewstate.ts";

/** Markup helpers. Tabs return HTML strings rather than building nodes: the
 * panels are small, re-rendered on each frame, and string templates keep each
 * tab readable as a description of its layout.
 *
 * Two kinds of slot, and the type says which:
 *  - `Markup` (`string | Html`) is a TEXT slot. A plain string is escaped; an
 *    `Html` — from html`` or `raw()` — is inserted as-is. Prose is safe by
 *    default and markup is opt-in.
 *  - Places documented as pre-escaped fragments (table cells, a card body)
 *    take whatever the caller built and insert it verbatim; use `esc()` there.
 *
 * Anything interactive here is declarative — a `data-*` attribute that the
 * delegated listeners in main.ts recognise — so a helper never has to hold a
 * node reference across a re-render that could destroy it. */

export interface Tile {
  label: Markup;
  value: Markup;
  /** Optional smaller line under the value. */
  sub?: Markup;
}

export function tiles(items: Tile[]): string {
  if (items.length === 0) return "";
  return `<div class="tiles">${items
    .map(
      (t) =>
        `<div class="tile"><div class="v">${inline(t.value)}</div><div class="l">${inline(t.label)}</div>${
          t.sub ? `<div class="l">${inline(t.sub)}</div>` : ""
        }</div>`,
    )
    .join("")}</div>`;
}

export function card(title: Markup, body: Markup, actions: Markup = ""): string {
  return (
    `<section class="card">` +
    `<h2>${inline(title)}${actions ? `<span class="acts">${actions}</span>` : ""}</h2>` +
    body +
    `</section>`
  );
}

export interface TableOptions {
  empty?: Markup;
  /** Column indices that carry prose and must WRAP rather than force the card
   *  into horizontal scroll. Cells are `nowrap` by default because most
   *  columns are numeric and should stay aligned; a requirement tree or a
   *  rationale is the exception, not the rule. */
  wrap?: number[];
  /** Column indices to left-align. Only the first column is left by default. */
  left?: number[];
  /** Header cells rendered as-is (already escaped) — used for sort controls. */
  rawHeaders?: boolean;
  /** Optional class for a row, by index — used for the ranked `.picked` row. */
  rowClass?(index: number): string;
}

/** A table. Cells are pre-escaped HTML fragments so a column can carry a
 * class; use esc() when building them. */
export function table(
  headers: Markup[],
  rows: readonly Markup[][],
  emptyOrOptions: Markup | TableOptions = "no data",
): string {
  const options: TableOptions =
    typeof emptyOrOptions === "object" && !(emptyOrOptions instanceof Html)
      ? emptyOrOptions
      : { empty: emptyOrOptions };
  if (rows.length === 0) return note(options.empty ?? "no data");
  const wrap = new Set(options.wrap ?? []);
  const left = new Set(options.left ?? []);
  const cls = (index: number): string => {
    const names = [wrap.has(index) ? "wrap" : "", left.has(index) ? "l" : ""].filter(Boolean).join(" ");
    return names ? ` class="${names}"` : "";
  };
  return (
    `<table><thead><tr>${headers
      .map((h, i) => `<th${cls(i)}>${options.rawHeaders ? h : inline(h)}</th>`)
      .join("")}</tr></thead><tbody>` +
    rows
      .map((cells, r) => {
        const rc = options.rowClass?.(r);
        return `<tr${rc ? ` class="${rc}"` : ""}>${cells.map((c, i) => `<td${cls(i)}>${c}</td>`).join("")}</tr>`;
      })
      .join("") +
    `</tbody></table>`
  );
}

/** Label/value pairs for the "one object, many fields" panels. Values are
 * pre-escaped fragments; labels are prose. */
export function definitions(pairs: [Markup, Markup][]): string {
  if (pairs.length === 0) return note("no data");
  return `<dl class="defs">${pairs
    .map(([k, v]) => `<dt>${inline(k)}</dt><dd>${v}</dd>`)
    .join("")}</dl>`;
}

export function note(text: Markup): string {
  return `<p class="muted">${inline(text)}</p>`;
}

/** The empty-value convention: an en dash in a cell that has no value yet.
 * Em dashes are prose separators; `note("no data")` is the empty TABLE. */
export const NONE = "–";

/** The "nothing yet" note, worded once. A longer explanation (which probe,
 * how often, what it costs) belongs in `hint`, shown on hover. */
export function waiting(probe: Markup, hint = ""): string {
  return `<p class="muted"${hint ? ` title="${esc(hint)}"` : ""}>waiting for ${inline(probe)}</p>`;
}

/** The last action's result as a coloured dot plus its detail — replaces the
 * per-tab "last action succeeded/failed: …" sentences. */
export function outcome(result: { ok: boolean; detail: Markup }): string {
  return `<p class="muted">${dot(result.ok ? "good" : "bad", result.ok ? "last action succeeded" : "last action failed")} ${inline(result.detail)}</p>`;
}

/** The truncation note, worded once. */
export function shownOf(shown: number, total: number, hint = "sort or filter to see the rest"): string {
  return note(`${shown} of ${total} — ${hint}`);
}

/** Prose whose full explanation lives in the title tooltip. */
export function hint(text: Markup, tip: string): Html {
  return html`<span class="hint" title="${tip}">${text}</span>`;
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

export function dot(status: Status, title = ""): Html {
  return html`<span class="dot ${status}"${title ? raw(` title="${esc(title)}"`) : ""}>●</span>`;
}

/** Inline progress meter for a table cell: a bar behind a label.
 *
 * `atTarget` is separate from `value >= max` on purpose — "security is at its
 * minimum" is a target reached at the BOTTOM of the range, and the caller is
 * the only one that knows which end counts as done. */
export function meter(fraction: number, label: Markup, atTarget = false, title = ""): Html {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return html`<span class="meter${atTarget ? " done" : ""}"${title ? raw(` title="${esc(title)}"`) : ""}>${raw(
    `<span class="fill" style="width:${pct.toFixed(1)}%"></span>`,
  )}<span class="lab">${label}</span></span>`;
}

/** A ratio against a baseline, coloured by whether it HELPS us.
 *
 * The sign alone is meaningless: `CrimeMoney 0.70` and `AugmentationMoneyCost
 * 1.43` are both bad news, and colouring by direction would paint them
 * opposite ways. `harderWhen` says which end hurts. */
export function ratio(value: number, base: number, harderWhen: "higher" | "lower" = "lower"): Html {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return html`<span class="muted">–</span>`;
  const pct = (value / base) * 100;
  const harder = harderWhen === "higher" ? value > base : value < base;
  const cls = value === base ? "muted" : harder ? "bad" : "good";
  return html`<span class="${cls}">${pct.toFixed(0)}%</span>`;
}

// --- interactive -----------------------------------------------------------

export interface FilterOption {
  value: string;
  label: string;
  /** Shown after the label, e.g. a count. */
  badge?: string;
  /** Hover explanation of what the filter selects. */
  title?: string;
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
          `data-view-value="${esc(o.value)}"${o.title ? ` title="${esc(o.title)}"` : ""}>${esc(o.label)}` +
          (o.badge ? `<span class="badge">${esc(o.badge)}</span>` : "") +
          `</button>`,
      )
      .join("") +
    `</div>`
  );
}

/** A search box. The panel is patched in place rather than rebuilt, so the
 * caret and any selection stay where the operator left them. */
export function search(key: string, placeholder: string): string {
  return (
    `<input class="search" type="search" id="search-${esc(key)}" data-view-key="${esc(key)}" ` +
    `placeholder="${esc(placeholder)}" value="${esc(view(key))}" />`
  );
}

/** A disclosure whose open/closed state belongs to the OPERATOR, not to the
 * frame that drew it.
 *
 * `key` names the disclosure in viewstate (main.ts records every toggle), so a
 * section opened by hand stays open across the re-renders a live run fires
 * twice a second — and across leaving the tab and coming back. Without it the
 * markup would assert `defaultOpen` again on every frame and snap the section
 * shut under the reader. */
export function collapsible(key: string, summary: Markup, body: Markup, defaultOpen = false): string {
  const open = view(`open.${key}`, defaultOpen ? "1" : "0") === "1";
  return (
    `<details data-open-key="${esc(key)}"${open ? " open" : ""}>` +
    `<summary>${inline(summary)}</summary>${body}</details>`
  );
}

export interface RankedOptions {
  /** Which row (by index) is the chosen one. */
  selected(index: number): boolean;
  empty?: Markup;
  wrap?: number[];
  left?: number[];
  /** When the caller truncated the list, say so once via shownOf(). */
  shown?: number;
  total?: number;
  /** What the hidden rows are, e.g. "scored options". */
  truncationHint?: string;
}

/** A ranked-candidates table: a `▶` marker column plus a `.picked` row class
 * on the chosen option. One implementation for every "options considered"
 * panel. Column indices in `wrap`/`left` refer to the caller's columns. */
export function rankedTable(headers: Markup[], rows: readonly Markup[][], options: RankedOptions): string {
  const body = table(
    [raw(`<span title="chosen option"></span>`), ...headers],
    rows.map((cells, i) => [options.selected(i) ? `<span class="good" title="chosen option">▶</span>` : "", ...cells]),
    {
      empty: options.empty ?? "no data",
      wrap: (options.wrap ?? []).map((i) => i + 1),
      left: (options.left ?? []).map((i) => i + 1),
      rowClass: (i) => (options.selected(i) ? "picked" : ""),
    },
  );
  const truncated =
    options.shown !== undefined && options.total !== undefined && options.total > options.shown
      ? shownOf(options.shown, options.total, options.truncationHint ?? "scored options")
      : "";
  return body + truncated;
}

// --- data tables -----------------------------------------------------------

export interface Column<T> {
  /** Stable id, used as the sort key. */
  id: string;
  label: string;
  cell(row: T): Markup;
  /** Omit to make the column unsortable. */
  sort?(row: T): number | string;
  wrap?: boolean;
  left?: boolean;
}

export interface DataTableOptions<T = unknown> {
  empty?: Markup;
  /** Applied when no sort has been chosen. */
  defaultSort: Sort;
  /** Rows past this are dropped, with a note saying how many. */
  limit?: number;
  /** Optional visual state for a row after filtering and sorting. */
  rowClass?(row: T): string;
}

/** A sortable table. Header cells carry `data-sort-table`/`data-sort-key`; the
 * delegated click handler in main.ts writes the choice to viewstate, so the
 * sort survives the re-render it triggers. */
export function dataTable<T>(id: string, rows: readonly T[], columns: Column<T>[], options: DataTableOptions<T>): string {
  if (rows.length === 0) return note(options.empty ?? "no data");
  const active = sortOf(id, options.defaultSort);
  // A persisted key can outlive its column (mode-dependent columns, renames);
  // fall back to the DECLARED default, not whichever column sorts first.
  const column =
    columns.find((c) => c.id === active.key && c.sort) ??
    columns.find((c) => c.id === options.defaultSort.key && c.sort) ??
    columns.find((c) => c.sort);
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
      rowClass: (index) => options.rowClass?.(shown[index]!) ?? "",
    },
  );

  const truncated =
    options.limit !== undefined && sorted.length > options.limit ? shownOf(options.limit, sorted.length) : "";
  return body + truncated;
}

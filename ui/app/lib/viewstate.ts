/** Interaction state that has to outlive the panel showing it.
 *
 * Panels are rebuilt from an HTML string on every frame, so anything the
 * operator set by clicking — a filter chip, a sort column, a search box — is
 * destroyed several times a minute unless it is held outside the DOM. This is
 * that holder: a flat string map, keyed by `<tab>.<control>`, read while
 * rendering and written by the delegated handlers in main.ts.
 *
 * Deliberately not part of ProjectedState. That is a projection of the record
 * stream and is rebuilt from scratch whenever the replay cutoff moves; view
 * state belongs to the viewer, not to the run. */

const values = new Map<string, string>();

export function view(key: string, fallback = ""): string {
  return values.get(key) ?? fallback;
}

export function setView(key: string, value: string): void {
  if (value === "") values.delete(key);
  else values.set(key, value);
}

/** Sort state is two fields that always change together. */
export interface Sort {
  key: string;
  dir: 1 | -1;
}

/** "Nothing has been clicked yet", for the delegated handler.
 *
 * The handler must NOT pass the clicked column as its own fallback: that makes
 * `current.key === key` true on the very first click, so the first click on
 * any column flips to ASCENDING — smallest money first, weakest server first —
 * when what a first click means is "rank by this". An unmatchable key sends
 * the first click down the "new column" path instead. */
export const NO_SORT: Sort = { key: "", dir: -1 };

export function sortOf(table: string, fallback: Sort): Sort {
  const raw = values.get(`${table}.sort`);
  if (!raw) return fallback;
  const [key, dir] = raw.split(":");
  return { key: key ?? fallback.key, dir: dir === "-1" ? -1 : 1 };
}

/** Clicking the active column flips direction; clicking another switches to
 * it. New columns start descending, which is what "show me the biggest" means
 * for every numeric column in this app. */
export function toggleSort(table: string, key: string, fallback: Sort): void {
  const current = sortOf(table, fallback);
  const next: Sort = current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: -1 };
  values.set(`${table}.sort`, `${next.key}:${next.dir}`);
}

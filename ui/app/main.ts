import { FEATURES } from "../../shared/features/registry.ts";
import type { LogRecord } from "../../shared/telemetry/schema.ts";
import { esc, fmtTime } from "./lib/format.ts";
import { note } from "./lib/dom.ts";
import { morph } from "./lib/morph.ts";
import { NO_SORT, setView, toggleSort } from "./lib/viewstate.ts";
import { appendRecords, emptyState, project, type ProjectedState } from "./project.ts";
import { TABS, type TabId } from "./tabs/index.ts";
import { BITNODES } from "../../shared/features/bitnode.ts";
import type { RunCatalogEntry } from "../../shared/run-catalog.ts";
import { renderMarkdown } from "./lib/markdown.ts";
import { featureSpecFile } from "../specs.ts";

/** Viewer shell: one live socket, one loaded run, one active tab.
 *
 * The tab bar is generated from FEATURES (shared/features/registry.ts) so the
 * feature decomposition has exactly one definition. A feature the current save
 * cannot play still gets a tab — it renders the reason it is locked and the
 * optimization problem it represents, which is more useful than hiding it. */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface RunSummaryLike {
  id: string;
  hello?: { src: "game" | "sim"; script: string };
  state?: LogRecord[];
  tail?: LogRecord[];
  metadata?: RunCatalogEntry;
}

/** The loaded run.
 *
 * `records` is retained ONLY for a run that can be scrubbed — a stored file
 * small enough to hold. A live run folds incrementally into `state` and keeps
 * no history at all: it has no scrubber, and holding every record of a
 * multi-hour run was both the memory and the per-frame cost. */
const run = {
  id: null as string | null,
  src: null as "game" | "sim" | null,
  live: false,
  records: null as LogRecord[] | null,
  t0: null as number | null,
};
let cutoff = Infinity;
let liveRuns: RunSummaryLike[] = [];
let storedRuns: RunCatalogEntry[] = [];
let compactOverBytes = 8_000_000;
let active: TabId = "overview";
let state: ProjectedState = emptyState();
let specOpen = false;
let specRequest = 0;
/** Rendered HTML per feature id: renderSpec runs on every telemetry render
 * while the drawer is open, so the markdown parse must not be repeated. */
const specCache = new Map<string, string>();
const specPending = new Map<string, Promise<string>>();
/** Error text per feature id, for a spec whose fetch FAILED. Kept apart from
 * specCache — that map holds parsed markdown, and a failure parked in it could
 * never be told from a real spec nor replaced by a later success. Without a memo
 * of some kind the open drawer re-fetched on every frame: twice a second against
 * the hub, with the body flashing between "loading…" and the error. */
const specFailed = new Map<string, string>();
/** Load token for loadStored, the way specRequest is one for renderSpec. */
let loadRequest = 0;

const TAB_ORDER: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  ...FEATURES.map((f) => ({ id: f.id as TabId, label: f.label })),
];

// --- tab bar ---------------------------------------------------------------

function readHash(): TabId {
  const id = location.hash.replace(/^#\/?/, "");
  return TAB_ORDER.some((t) => t.id === id) ? (id as TabId) : "overview";
}

function renderTabs(): void {
  const links = TAB_ORDER.map((tab) => {
    const feature = FEATURES.find((f) => f.id === tab.id);
    const unlocked = feature ? state.caps.unlocked[feature.id] : "yes";
    const current = tab.id === active;
    const cls = [current ? "on" : "", unlocked === "no" ? "locked" : unlocked === "unknown" ? "unknown" : ""]
      .filter(Boolean)
      .join(" ");
    const title = feature ? feature.problem : "Cross-feature view";
    const mark = unlocked === "no" ? "✕ " : unlocked === "unknown" ? "? " : "";
    // aria-current is emitted off the same test as `.on`, in the same
    // expression so the two cannot drift: `.on` is a colour and a weight, so
    // nothing programmatic said which tab was the current one.
    return `<a class="tab ${cls}"${current ? ` aria-current="page"` : ""} href="#/${tab.id}" title="${esc(title)}">${mark}${esc(tab.label)}</a>`;
  }).join("");
  const feature = FEATURES.find((candidate) => candidate.id === active);
  const spec = feature
    ? `<button class="tab spec-toggle${specOpen ? " on" : ""}" type="button" data-spec-toggle="1" ` +
      `title="Read the checked-in ${esc(feature.label)} strategy specification">spec</button>`
    : "";
  morph($("tabs"), links + spec);
}

function closeSpec(): void {
  specOpen = false;
  specRequest++;
  $("specdrawer").hidden = true;
  renderTabs();
}

async function renderSpec(): Promise<void> {
  const feature = FEATURES.find((candidate) => candidate.id === active);
  const drawer = $("specdrawer");
  if (!specOpen || !feature) {
    drawer.hidden = true;
    return;
  }

  drawer.hidden = false;
  $("spectitle").textContent = `${feature.label} specification`;
  $("specpath").textContent = featureSpecFile(feature.id);
  const cached = specCache.get(feature.id);
  if (cached !== undefined) {
    morph($("specbody"), cached);
    return;
  }

  // Read BEFORE the loading note, not after the fetch: a feature whose spec
  // cannot be read renders the error steadily instead of flashing "loading…"
  // at the reader on every frame.
  const failed = specFailed.get(feature.id);
  if (failed !== undefined) {
    morph($("specbody"), note(`spec unavailable: ${failed}`));
    return;
  }

  morph($("specbody"), note("loading checked-in specification..."));
  const request = specRequest;
  let pending = specPending.get(feature.id);
  if (!pending) {
    const created = fetch(`/spec/${encodeURIComponent(feature.id)}`).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.text();
    });
    pending = created;
    specPending.set(feature.id, created);
    void created.then(
      () => {
        if (specPending.get(feature.id) === created) specPending.delete(feature.id);
      },
      () => {
        if (specPending.get(feature.id) === created) specPending.delete(feature.id);
      },
    );
  }
  try {
    const markdown = await pending;
    const rendered = renderMarkdown(markdown);
    specCache.set(feature.id, rendered);
    if (request === specRequest && specOpen && active === feature.id) {
      morph($("specbody"), rendered);
    }
  } catch (error) {
    // Remembered, not merely displayed: render() calls renderSpec on every
    // frame while the drawer is open, so an unremembered failure is a fresh
    // request twice a second. The hub answers a moved or missing spec file with
    // a 404 by design, and a restarting hub fails the same way.
    specFailed.set(feature.id, String(error));
    if (request === specRequest) {
      morph($("specbody"), note(`spec unavailable: ${String(error)}`));
    }
  }
}

/** Locked and unknown panels explain themselves rather than showing nothing. */
function lockedPanel(id: TabId): string | null {
  const feature = FEATURES.find((f) => f.id === id);
  if (!feature) return null;
  const unlocked = state.caps.unlocked[feature.id];
  if (unlocked === "yes") return null;
  const reason = state.caps.reason[feature.id] ?? "not available";
  const nodes = feature.bitnodes.length ? feature.bitnodes.map((n) => `BN${n}`).join(", ") : "";
  const facts = [nodes, feature.api ? "" : "no ns API"].filter(Boolean).join(" · ");
  return (
    `<section class="card locked-card">` +
    `<h2>${esc(feature.label)} — ${unlocked === "no" ? "locked" : "not probed yet"}</h2>` +
    `<p>${esc(reason)}</p>` +
    (facts ? `<p class="muted">${esc(facts)}</p>` : "") +
    `</section>`
  );
}

/** The tab the DOM currently holds, so a patch is only attempted against the
 * SAME tab's markup. A different tab is a different tree; patching one into
 * the other would be a full rebuild done the slow way. */
let renderedTab: string | undefined;

/** Re-render the active tab by PATCHING the live DOM.
 *
 * Panels are produced as an HTML string on every frame, which is what keeps
 * each tab readable as a description of its layout. What the string is then
 * used for is the difference between a stable page and one that fights the
 * reader: assigning it to `innerHTML` destroys every node in the panel, and
 * with them the selection, the caret, hover, an open disclosure and every
 * scroll offset. On a live run that happened twice a second.
 *
 * `morph` instead edits the live tree until it matches, leaving untouched any
 * subtree that already agrees — which is nearly all of it, since a frame
 * typically moves a few numbers. Nothing has to be captured and restored
 * afterwards because nothing was thrown away. */
function renderView(): void {
  const el = $("view");
  const tab = TABS[active];
  if (!run.id) {
    morph(el, `<section class="card">${note("no run selected")}</section>`);
    renderedTab = undefined;
    return;
  }
  const locked = lockedPanel(active);
  if (locked) {
    morph(el, locked);
    renderedTab = undefined;
    return;
  }

  // Switching tabs starts from an empty panel: the trees have nothing in
  // common, and it also puts the reader at the top of the new tab rather than
  // at whatever offset the previous one was scrolled to.
  if (renderedTab !== active) {
    el.replaceChildren();
    window.scrollTo(window.scrollX, 0);
  }
  morph(el, tab.render(state));
  tab.mount?.(state, el);
  renderedTab = active;
}

/** Rebuild `state` from the retained records. Only a scrubbable run has any,
 * so a live run just re-renders whatever the incremental fold has produced. */
function reproject(): void {
  if (!run.records) return;
  const compacted = state.compacted;
  state = project(run.records, cutoff, {
    id: run.id,
    src: run.src,
    live: run.live,
    t0: run.t0,
    compacted,
  });
}

function render(): void {
  reproject();
  renderTabs();
  void renderSpec();
  renderView();
  const offset = cutoff === Infinity ? "" : fmtTime(cutoff - (run.t0 ?? 0));
  $("scrubt").textContent = offset;
  // The slider's value is a raw epoch millisecond — announced as a 13-digit
  // number — while what the operator is choosing is the offset beside it.
  $("scrub").setAttribute("aria-valuetext", offset || "end of run");
}

/** Minimum wall-clock between live re-renders.
 *
 * The dispatcher publishes a rollup every second and the game flushes on its
 * own cadence, so an unthrottled rAF render repaints the whole panel several
 * times per second for data that changed in the third decimal place. Half a
 * second still reads as live and leaves the main thread free enough to
 * scroll. */
const MIN_RENDER_MS = 500;
let queued = false;
let lastRenderAt = 0;

function queueRender(): void {
  if (queued) return;
  queued = true;
  const wait = Math.max(0, MIN_RENDER_MS - (Date.now() - lastRenderAt));
  setTimeout(() => {
    requestAnimationFrame(() => {
      queued = false;
      lastRenderAt = Date.now();
      render();
    });
  }, wait);
}

window.addEventListener("hashchange", () => {
  active = readHash();
  render();
});
window.addEventListener("resize", queueRender);

$("tabs").addEventListener("click", (ev) => {
  const toggle = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-spec-toggle]");
  if (!toggle) return;
  specOpen = !specOpen;
  // Reopening the drawer IS the retry: a spec that failed because the hub was
  // restarting must not stay unavailable until the page is reloaded.
  if (specOpen) specFailed.delete(active);
  renderTabs();
  void renderSpec();
});
$("specclose").addEventListener("click", closeSpec);

// --- panel interaction -----------------------------------------------------

/** Filters, sorting and search are DELEGATED from the container rather than
 * bound to the controls themselves. The panel is replaced wholesale on every
 * frame, so a listener attached to a chip would be discarded within the
 * second; `#view` is the only node that survives. Handlers write to viewstate
 * and re-render, which is what makes a choice outlive the frame that made it. */
$("view").addEventListener("click", (ev) => {
  const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-view-key],[data-sort-key]");
  if (!target) return;
  const sortKey = target.dataset["sortKey"];
  if (sortKey) {
    toggleSort(target.dataset["sortTable"] ?? "", sortKey, NO_SORT);
    render();
    return;
  }
  const key = target.dataset["viewKey"];
  if (key !== undefined && target.dataset["viewValue"] !== undefined) {
    setView(key, target.dataset["viewValue"]);
    render();
  }
});

/** A disclosure's open state lives in viewstate, not in the DOM.
 *
 * `collapsible()` renders `open` from viewstate on every frame, so a section
 * opened by hand snaps shut on the next render unless the toggle is recorded.
 * Nothing recorded it, which is why every expandable section closed itself
 * within half a second of being opened.
 *
 * Listened for in the CAPTURE phase because `toggle` does not bubble: it is
 * dispatched at the `<details>` element and would never reach `#view`
 * otherwise. No re-render is needed — the browser has already opened the
 * section, and this only makes that outlive the next frame. */
$("view").addEventListener(
  "toggle",
  (ev) => {
    const details = ev.target as HTMLDetailsElement | null;
    const key = details?.dataset?.["openKey"];
    if (key === undefined || !details) return;
    setView(`open.${key}`, details.open ? "1" : "0");
    // A canvas inside a closed disclosure measures 0x0, so anything drawn
    // while it was shut is a blank bitmap. A stored run never re-renders on
    // its own (only `resize` and live records queue one), so opening a section
    // has to redraw it or the chart stays empty until the pointer wanders in.
    if (details.open) render();
  },
  true,
);

$("view").addEventListener("input", (ev) => {
  const target = ev.target as HTMLInputElement | null;
  const key = target?.dataset["viewKey"];
  if (!target || key === undefined || target.dataset["viewValue"] !== undefined) return;
  setView(key, target.value);
  // Typing must not wait on the live-render throttle, or the box lags a
  // keystroke behind what it filters.
  render();
});

// --- run selection & replay ------------------------------------------------

/** The picker key of the LOADED run: a live run is keyed by its run id, a
 * stored run by its catalogue file name. The selection and the pin rule are
 * both derived from this instead of read back out of the `<select>`, which is
 * what let a vanished key drop the picker to option 0 while `run` still pointed
 * elsewhere — the header naming one run over panels showing another. */
function runKey(): string | null {
  if (run.id === null) return null;
  return run.live ? `live:${run.id}` : `file:${run.id}`;
}

function refreshPicker(): void {
  const pick = $<HTMLSelectElement>("runpick");
  const loaded = runKey();
  const liveInstallIds = new Set(liveRuns.map((entry) => entry.metadata?.identity?.install.id).filter(Boolean));
  const choices = [
    ...liveRuns.map((summary) => ({
      key: `live:${summary.id}`,
      metadata: summary.metadata,
      fallback: `live — ${summary.hello?.src}/${summary.hello?.script} (${summary.id})`,
      live: true,
    })),
    ...storedRuns
      .filter((entry) => !entry.identity || !liveInstallIds.has(entry.identity.install.id))
      .map((metadata) => ({ key: `file:${metadata.file}`, metadata, fallback: metadata.file, live: false })),
  ];
  const grouped = new Map<string, typeof choices>();
  for (const choice of choices) {
    const key = choice.metadata?.identity?.lineage.id ?? "legacy";
    const bucket = grouped.get(key) ?? [];
    bucket.push(choice);
    grouped.set(key, bucket);
  }
  const groups = [...grouped.entries()].sort(([, a], [, b]) =>
    Math.max(...b.map((x) => x.metadata?.updatedAt ?? 0)) - Math.max(...a.map((x) => x.metadata?.updatedAt ?? 0))
  );
  // Patched rather than rebuilt: replacing the options of an open `<select>`
  // closes the dropdown under the operator, and the hub re-sends the catalogue
  // whenever any run starts, ends or is pinned. `data-key` lets a lineage that
  // moved up the recency order be MOVED rather than rewritten.
  // The loaded run's own option can be absent from the catalogue: a live key
  // stops existing the moment the run closes, pinning renames the file under
  // pinned/, and the filter above hides a stored entry while the game holds the
  // same install live. A single <select> cannot show a key it has no option
  // for, so it sat on option 0 and named a run the panels were not showing.
  // One synthetic option keeps the header honest instead.
  const orphan = loaded !== null && !choices.some((choice) => choice.key === loaded)
    ? `<option data-key="${esc(loaded)}" value="${esc(loaded)}">${esc(`${run.id} — no longer listed`)}</option>`
    : "";
  morph(pick, orphan + groups.map(([lineageId, entries]) => {
    entries.sort((a, b) =>
      (a.metadata?.identity?.bitNode?.startedAt ?? 0) - (b.metadata?.identity?.bitNode?.startedAt ?? 0) ||
      (a.metadata?.identity?.install.startedAt ?? 0) - (b.metadata?.identity?.install.startedAt ?? 0)
    );
    const lineage = entries[0]?.metadata?.identity?.lineage;
    const label = lineage?.label ?? (lineageId === "legacy" ? "Legacy / ungrouped" : lineageId);
    const nodeOrdinals = new Map<string, number>();
    return `<optgroup data-key="${esc(lineageId)}" label="${esc(label)}">${entries.map((entry) => {
      const metadata = entry.metadata;
      if (!metadata?.identity) {
        return `<option data-key="${esc(entry.key)}" value="${esc(entry.key)}">${esc(entry.fallback)}</option>`;
      }
      const node = metadata.identity.bitNode;
      const nodeInfo = node ? BITNODES.find((known) => known.n === node.bitNode) : undefined;
      const nodeKey = node?.id ?? "none";
      const ordinal = nodeOrdinals.get(nodeKey) ?? 0;
      nodeOrdinals.set(nodeKey, ordinal + 1);
      const install = (metadata.identity.install.index ?? ordinal) + 1;
      const date = new Date(metadata.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
      const duration = fmtTime(metadata.durationMs ?? (
        metadata.firstT === null || metadata.lastT === null ? 0 : metadata.lastT - metadata.firstT
      ));
      const onlyOneSimInstall = metadata.identity.lineage.kind === "sim" && entries.length === 1;
      const bn = node && !onlyOneSimInstall ? `BN${node.bitNode}${nodeInfo ? ` ${nodeInfo.name}` : ""} › ` : "";
      const flags = `${entry.live ? "● " : ""}${metadata.pinned ? "📌 " : ""}`;
      return (
        `<option data-key="${esc(entry.key)}" value="${esc(entry.key)}">` +
        `${esc(`${flags}${bn}Install ${install} · ${date} · ${duration}`)}</option>`
      );
    }).join("")}</optgroup>`;
  }).join(""));
  // Re-asserted after the patch, not before: morph can ADD the loaded run's
  // option (a lineage that just appeared in the catalogue) or remove and
  // re-add the node around it, and a `<select>` whose selected option is
  // detached falls back to option 0. `syncValue` no longer clears selectedness
  // — an absent `selected` attribute means "the builder stated no selection" —
  // so this is the only place that states one.
  if (loaded !== null) pick.value = loaded;
  // Only an unpinned stored run the hub still lists can be pinned, and the rule
  // reads the LOADED run, never pick.value: while the select was falling back
  // to option 0 this re-enabled for a run the operator had never opened, and
  // one further click pinned it.
  const pin = $<HTMLButtonElement>("simpin");
  pin.disabled = loaded === null || !loaded.startsWith("file:") || loaded.startsWith("file:pinned/") ||
    !storedRuns.some((entry) => entry.file === run.id);
}

/** Load a stored run.
 *
 * Large runs are fetched COMPACTED — one record per state key plus a bounded
 * event tail, folded server-side by streaming the file. A 126 MB JSONL parsed
 * whole in the browser is minutes of blocked main thread for a panel that only
 * ever shows the last write of each topic, and the scrubber is the only thing
 * that genuinely needs the history. So the trade is made explicit: a compacted
 * run loads instantly and says its timeline is gone. */
async function loadStored(file: string): Promise<void> {
  // Every load carries a token, the way renderSpec's fetch does, and nothing
  // is committed once it is stale. Two orderings were observed without one: a
  // 7.9 MB run fetched whole resolved seconds after the operator had moved on
  // to a small one and overwrote it, leaving the picker naming one run and
  // every panel showing another; and a stored load landing after attachLive
  // set run.live = false, which silently disarmed the `records` guard below and
  // froze the live panel with no way back.
  const token = ++loadRequest;
  const size = storedRuns.find((r) => r.file === file)?.size ?? 0;
  const compact = size > compactOverBytes;
  setStatus(`loading ${file}…`);

  let records: LogRecord[];
  let total: number;
  let t0: number | null;
  try {
    if (compact) {
      const response = await fetch(`/runs/${encodeURIComponent(file)}?compact=1`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body = (await response.json()) as {
        entries: LogRecord[];
        records: number;
        t0: number | null;
      };
      if (token !== loadRequest) return;
      records = body.entries;
      total = body.records;
      t0 = body.t0;
    } else {
      // `ok` is checked before the body is ever parsed: the hub answers a swept
      // or renamed run with a 404 whose body is the text "not found", and the
      // per-line guard below cannot tell that apart from a live run's partial
      // trailing write — so a missing run used to commit as "replay — 0
      // records", an empty run the file never was.
      const response = await fetch(`/runs/${encodeURIComponent(file)}`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const text = await response.text();
      if (token !== loadRequest) return;
      records = text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as LogRecord];
          } catch {
            return []; // a live run's last line can be a partial write
          }
        });
      total = records.length;
      t0 = records[0]?.t ?? null;
    }
  } catch (error) {
    if (token !== loadRequest) return;
    // Clear the whole run rather than leave the previous one on screen under
    // the new one's name. `cutoff` goes back to Infinity because render() would
    // otherwise print a scrub offset against no run, and the scrubber is hidden
    // by hand because renderView never touches it.
    run.id = null;
    run.src = null;
    run.live = false;
    run.records = null;
    run.t0 = null;
    cutoff = Infinity;
    $("scrubrow").style.display = "none";
    state = emptyState();
    // A failed load also proves this client's catalogue is stale: sweep()
    // unlinks unpinned runs past the retention window and broadcasts nothing.
    // Drop the entry, or the same dead run stays one click away forever.
    storedRuns = storedRuns.filter((entry) => entry.file !== file);
    refreshPicker();
    setStatus(`could not load ${file}: ${String(error)}`);
    render();
    return;
  }

  run.records = records;
  run.id = file;
  run.src = records[0]?.src ?? null;
  run.live = false;
  // Assigned here with the rest of the run rather than at the fetch, so a load
  // the operator has abandoned cannot leave its t0 on the run still on screen.
  run.t0 = t0;
  cutoff = Infinity;

  // The slider spans the run's own timeline. `min` must be t0, not 0: game
  // records carry Date.now() timestamps, so a 0-based range puts the entire
  // run inside its last pixel and any drag lands decades before the start.
  // A compacted run has no timeline left to span, so it gets no slider.
  const scrub = $<HTMLInputElement>("scrub");
  $("scrubrow").style.display = compact ? "none" : "flex";
  scrub.min = String(run.t0 ?? 0);
  // NOT the last record's `t`: the store defers a span's closing record and
  // flushes every open one at detach, so a closed run ends with a run of span
  // closers whose timestamps are older than the run's real end. Taking the
  // maximum keeps the slider able to reach the last thing that happened.
  scrub.max = String(records.reduce((latest, record) => Math.max(latest, record.t), run.t0 ?? 0));
  scrub.value = scrub.max;

  state = emptyState();
  state.compacted = compact;
  setStatus(
    compact ? `compacted · ${total}→${records.length} records (${fmtBytes(size)})` : `replay — ${total} records`,
    compact ? "run too large to load whole: topics are folded server-side, so there is no timeline to scrub" : "",
  );
  refreshPicker();
  render();
}

function setStatus(text: string, title = ""): void {
  const status = $("status");
  status.textContent = text;
  status.title = title;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`;
  return `${(bytes / 1e3).toFixed(0)}kB`;
}

function attachLive(summary: RunSummaryLike): void {
  // Cancels any stored load still in flight: one landing after this point would
  // set run.live = false and freeze the live panel (see loadStored's token).
  loadRequest++;
  run.id = summary.id;
  run.src = summary.hello?.src ?? null;
  run.live = true;
  // A live run keeps no history: the snapshot is folded once, and every later
  // batch is folded as it arrives.
  run.records = null;
  const seen = new Set<string>();
  const initial = [...(summary.state ?? []), ...(summary.tail ?? [])]
    .sort((a, b) => a.t - b.t || a.run.localeCompare(b.run) || a.seq - b.seq)
    .filter((r) => {
      const key = `${r.run}\0${r.seq}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  // The run's OWN start, not the snapshot's. The hub's tail is bounded in
  // BYTES (store.ts TAIL_BYTES), so its oldest record is where the snapshot
  // window begins: reading that as t0 made a six-hour run's "elapsed" tile say
  // five minutes while the picker beside it read 6h off this same object's
  // metadata.firstT. The fallback is for a legacy summary carrying no metadata;
  // a null firstT means nothing was ever ingested, and the `records` handler
  // below then fills t0 from the first record that arrives.
  run.t0 = summary.metadata?.firstT ?? initial[0]?.t ?? null;
  cutoff = Infinity;
  $("scrubrow").style.display = "none";

  state = emptyState();
  state.runId = run.id;
  state.src = run.src;
  state.live = true;
  state.t0 = run.t0;
  appendRecords(state, initial);
  refreshPicker();
  render();
}

$("runpick").addEventListener("change", () => {
  const value = $<HTMLSelectElement>("runpick").value;
  const kind = value.slice(0, value.indexOf(":"));
  const id = value.slice(value.indexOf(":") + 1);
  if (kind === "live") {
    const summary = liveRuns.find((r) => r.id === id);
    if (summary) attachLive(summary);
  } else {
    void loadStored(id);
  }
});

$("scrub").addEventListener("input", () => {
  cutoff = Number($<HTMLInputElement>("scrub").value);
  render();
});

// --- live socket -----------------------------------------------------------

interface HubMessage {
  type: string;
  runs?: RunSummaryLike[];
  stored?: RunCatalogEntry[];
  run?: RunSummaryLike & { id: string };
  records?: LogRecord[];
  busy?: boolean;
  code?: number;
  output?: string;
  syncBusy?: boolean;
  /** Snapshot: whether a simulation is already running. */
  simBusy?: boolean;
  /** Snapshot: whether the game holds its Remote File API connection. */
  rfaConnected?: boolean;
  /** rfa-status: the same, live. */
  connected?: boolean;
  compactOverBytes?: number;
}

// --- sync button --------------------------------------------------------
// Syncing needs the game's persistent Remote File API connection to the hub,
// so the button reflects both "a sync is running" and "the game is attached".
let gameConnected = false;
let syncRunning = false;
const syncIdleTitle = $<HTMLButtonElement>("sync").title;

function refreshSyncButton(): void {
  const button = $<HTMLButtonElement>("sync");
  button.disabled = syncRunning || !gameConnected;
  button.title = gameConnected
    ? syncIdleTitle
    : "Bitburner is not connected — enable the Remote API in the game options";
}

/** The sim button, kept in module state for the same reason as the sync button:
 * it has to be reconstructible from a snapshot. No connection term — a sim
 * spawns `bun run sim/run.ts` locally and does not need the game attached. */
let simRunning = false;

function refreshSimButton(): void {
  $<HTMLButtonElement>("simrun").disabled = simRunning;
}

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/live`);
  ws.onopen = () => {
    $("status").title = "";
    $("status").innerHTML = '<span class="live">connected</span>';
  };
  ws.onclose = () => {
    setStatus("disconnected — retrying…");
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as HubMessage;
    if (msg.type === "snapshot") {
      liveRuns = msg.runs ?? [];
      storedRuns = msg.stored ?? [];
      if (msg.compactOverBytes !== undefined) compactOverBytes = msg.compactOverBytes;
      syncRunning = Boolean(msg.syncBusy);
      gameConnected = Boolean(msg.rfaConnected);
      // The snapshot is the only channel that can tell a reloaded or
      // reconnected page a sim is in flight: broadcast() sends nothing while no
      // viewer is attached, so sim-status and sim-finished can both be missed.
      simRunning = Boolean(msg.simBusy);
      refreshSyncButton();
      refreshSimButton();
      if (simRunning) setStatus("sim running…");
      refreshPicker();
      // A snapshot arrives on EVERY /live open (ui/server.ts websocket.open)
      // and is indistinguishable on the wire from the first one. This branch
      // used to treat each of them as first load, so a two-second socket blip
      // discarded a replay's retained records and scrub position and attached
      // whatever live run the hub happened to list first. Auto-attach only when
      // nothing is loaded.
      if (run.id === null) {
        if (liveRuns.length > 0) attachLive(liveRuns[0]!);
        else if (storedRuns.length > 0) void loadStored(storedRuns[0]!.file);
        else render();
      } else if (run.live && liveRuns.some((entry) => entry.id === run.id)) {
        // Re-folded from the new snapshot rather than appended to the state
        // already held: appendRecords has no seq dedupe across snapshots (that
        // filter lives inside attachLive), so folding this tail in on top of
        // the old one would double-count every counter and event.
        attachLive(liveRuns.find((entry) => entry.id === run.id)!);
      } else if (run.live) {
        // The snapshot carries the whole live list, so a run missing from it has
        // ended — and its run-ended was broadcast while this viewer was gone.
        // Freeze it here, or the panel keeps counting a dead run's forecasts
        // against the wall clock.
        run.live = false;
        state.live = false;
        setStatus("run ended");
        refreshPicker();
        render();
      } else {
        // A stored run's file cannot have changed under it: keep the replay and
        // the scrub position exactly where the operator left them.
        render();
      }
    } else if (msg.type === "run-started" && msg.run) {
      const existing = liveRuns.findIndex((entry) => entry.id === msg.run!.id);
      if (existing < 0) liveRuns.push({ ...msg.run, state: [], tail: [] });
      else liveRuns[existing] = { ...liveRuns[existing], ...msg.run };
      refreshPicker();
      // Gated on "nothing loaded" rather than on this being the only live run:
      // pressing sync while a deliberately chosen replay was open started a
      // game run, and that used to yank the operator straight off the replay.
      if (run.id === null) {
        const summary = liveRuns.find((entry) => entry.id === msg.run!.id);
        if (summary) attachLive(summary);
      }
    } else if (msg.type === "run-ended" && msg.run) {
      liveRuns = liveRuns.filter((r) => r.id !== msg.run!.id);
      if (msg.stored) storedRuns = msg.stored;
      if (run.id === msg.run.id) {
        run.live = false;
        // The live key stops existing the moment the run closes, so the loaded
        // run has to become its stored file or the picker cannot name it at
        // all: metadata.file is basename(store.file), exactly the relative name
        // listRunFiles() emits for an unpinned run. `records` stays null —
        // reproject() returns early for a run with no retained history, so the
        // folded state and the hidden scrub row remain correct — and pin now
        // enables for the run actually on screen.
        if (msg.run.metadata?.file) run.id = msg.run.metadata.file;
        // A run that has ended has no more records, so its countdowns must
        // freeze at the last observed record time instead of racing the wall
        // clock into "ready now" (bitnode.ts picks Date.now() on this flag).
        // Mutated on `state` directly and not through the projection:
        // reproject() bails for a run with no retained records and
        // appendRecords never reads run metadata, so there is no other channel.
        state.live = false;
        setStatus("run ended");
        // Nothing else re-renders here — setStatus only rewrites #status, and
        // the `records` branch is now gated off by run.live — so without this
        // the panel keeps its last wall-clock frame until some unrelated click.
        render();
      }
      refreshPicker();
    } else if (msg.type === "runs-changed") {
      // A run was pinned: its name gained a "pinned/" prefix, so the picker
      // has to be rebuilt or the selection would point at a moved file.
      if (msg.stored) storedRuns = msg.stored;
      refreshPicker();
    } else if (msg.type === "sim-status") {
      simRunning = Boolean(msg.busy);
      refreshSimButton();
      if (msg.busy) setStatus("sim running…");
    } else if (msg.type === "sim-finished") {
      simRunning = false;
      refreshSimButton();
      if (msg.stored) {
        storedRuns = msg.stored;
        refreshPicker();
      }
      setStatus(`sim finished (exit ${msg.code})`);
    } else if (msg.type === "sync-status") {
      syncRunning = Boolean(msg.busy);
      refreshSyncButton();
      if (msg.busy) setStatus("sync: building & pushing…");
    } else if (msg.type === "sync-finished") {
      syncRunning = false;
      refreshSyncButton();
      const status = $("status");
      status.textContent = msg.code === 0 ? "sync complete" : `sync failed (exit ${msg.code})`;
      status.title = msg.output?.trim() ?? "";
    } else if (msg.type === "rfa-status") {
      gameConnected = Boolean(msg.connected);
      refreshSyncButton();
    } else if (msg.type === "records" && run.live && (msg as { run?: string }).run === run.id) {
      if (run.t0 === null && msg.records?.length) {
        run.t0 = msg.records[0]!.t;
        state.t0 = run.t0;
      }
      appendRecords(state, msg.records ?? []);
      queueRender();
    }
  };
}

/** Populate the profile and save pickers from the hub. Both are optional: an
 * empty profile means "use the goal box", an empty save means a fresh BN1. */
async function refreshLaunchers(): Promise<void> {
  const [profiles, saves] = await Promise.all([
    fetch("/profiles").then((r) => r.json() as Promise<{ id: string; description: string }[]>),
    fetch("/saves").then((r) => r.json() as Promise<{ id: string; bitNode: number; label: string }[]>),
  ]).catch(() => [[], []] as [{ id: string; description: string }[], { id: string; bitNode: number; label: string }[]]);

  $<HTMLSelectElement>("simprofile").innerHTML = [
    `<option value="">— goal below —</option>`,
    ...profiles.map((p) => `<option value="${esc(p.id)}" title="${esc(p.description)}">${esc(p.id)}</option>`),
  ].join("");
  $<HTMLSelectElement>("simsave").innerHTML = [
    `<option value="">fresh BN1</option>`,
    ...saves.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} (BN${s.bitNode})</option>`),
  ].join("");
}
void refreshLaunchers();

$("sync").addEventListener("click", async () => {
  $<HTMLButtonElement>("sync").disabled = true;
  try {
    // Resolves when the sync completes; progress and the final status also
    // arrive as sync-status/sync-finished broadcasts on the live socket.
    const res = await fetch("/sync", { method: "POST" });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) setStatus(`sync failed: ${body.error ?? res.statusText}`);
  } catch (error) {
    setStatus(`sync failed: ${String(error)}`);
  }
  refreshSyncButton();
});

$("simrun").addEventListener("click", async () => {
  simRunning = true;
  refreshSimButton();
  const profile = $<HTMLSelectElement>("simprofile").value;
  const save = $<HTMLSelectElement>("simsave").value;
  try {
    const res = await fetch("/sim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // A profile brings its own goals, seeds and horizon; the boxes only
        // override what the operator actually typed over.
        ...(profile ? { profile } : { goals: $<HTMLInputElement>("simgoal").value.trim().split(/\s+/).filter(Boolean) }),
        ...(save ? { save } : {}),
        seeds: $<HTMLInputElement>("simseeds").value.trim(),
        horizon: $<HTMLInputElement>("simhorizon").value.trim(),
        ...(profile ? {} : { label: "dashboard" }),
      }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) {
      simRunning = false;
      refreshSimButton();
      // statusText as the fallback: an error response carrying no `error` key
      // used to render as "sim error: undefined".
      setStatus(`sim error: ${body.error ?? res.statusText}`);
    } else {
      // Left disabled on purpose: sim-status and sim-finished own the button
      // from here, because the simulation outlives this request.
      setStatus("sim running…");
    }
  } catch (error) {
    // The request never reached the hub — the same condition the socket's 2s
    // reconnect exists for — so no sim-status will ever arrive to release the
    // button, and the launcher stayed dead until the page was reloaded.
    simRunning = false;
    refreshSimButton();
    setStatus(`sim failed: ${String(error)}`);
  }
});

$("simpin").addEventListener("click", async () => {
  // The loaded run, not pick.value: the two agree now, and the button pins what
  // the panels are showing.
  const key = runKey();
  if (key === null || !key.startsWith("file:")) return;
  const file = key.slice("file:".length);
  const res = await fetch("/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  const body = (await res.json()) as { error?: string; pinned?: string };
  // Follow the rename: pinning moves x.jsonl to pinned/x.jsonl, so a run.id
  // left on the old name names a file the hub no longer has. runs-changed can
  // land before this response, which is why refreshPicker has to survive the
  // gap rather than this being the only correction.
  if (res.ok && body.pinned && !run.live && run.id === file) {
    run.id = body.pinned;
    refreshPicker();
  }
  setStatus(res.ok ? `pinned ${body.pinned}` : `pin failed: ${body.error ?? res.statusText}`);
});

active = readHash();
render();
connect();

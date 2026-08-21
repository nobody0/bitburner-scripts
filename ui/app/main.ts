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
  morph($("tabs"), TAB_ORDER.map((tab) => {
    const feature = FEATURES.find((f) => f.id === tab.id);
    const unlocked = feature ? state.caps.unlocked[feature.id] : "yes";
    const cls = [tab.id === active ? "on" : "", unlocked === "no" ? "locked" : unlocked === "unknown" ? "unknown" : ""]
      .filter(Boolean)
      .join(" ");
    const title = feature ? feature.problem : "Cross-feature view";
    const mark = unlocked === "no" ? "✕ " : unlocked === "unknown" ? "? " : "";
    return `<a class="tab ${cls}" href="#/${tab.id}" title="${esc(title)}">${mark}${esc(tab.label)}</a>`;
  }).join(""));
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
  renderView();
  $("scrubt").textContent = cutoff === Infinity ? "" : fmtTime(cutoff - (run.t0 ?? 0));
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

function refreshPicker(): void {
  const pick = $<HTMLSelectElement>("runpick");
  const current = pick.value;
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
  morph(pick, groups.map(([lineageId, entries]) => {
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
  if ([...pick.options].some((o) => o.value === current)) pick.value = current;
  // Only an unpinned stored run can be pinned.
  const selected = pick.value;
  const pin = $<HTMLButtonElement>("simpin");
  pin.disabled = !selected.startsWith("file:") || selected.startsWith("file:pinned/");
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
  const size = storedRuns.find((r) => r.file === file)?.size ?? 0;
  const compact = size > compactOverBytes;
  setStatus(`loading ${file}…`);

  let records: LogRecord[];
  let total: number;
  if (compact) {
    const body = (await fetch(`/runs/${encodeURIComponent(file)}?compact=1`).then((r) => r.json())) as {
      entries: LogRecord[];
      records: number;
      t0: number | null;
    };
    records = body.entries;
    total = body.records;
    run.t0 = body.t0;
  } else {
    const text = await fetch(`/runs/${encodeURIComponent(file)}`).then((r) => r.text());
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
    run.t0 = records[0]?.t ?? null;
  }

  run.records = records;
  run.id = file;
  run.src = records[0]?.src ?? null;
  run.live = false;
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
  run.t0 = initial[0]?.t ?? null;
  cutoff = Infinity;
  $("scrubrow").style.display = "none";

  state = emptyState();
  state.runId = run.id;
  state.src = run.src;
  state.live = true;
  state.t0 = run.t0;
  appendRecords(state, initial);
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
      refreshSyncButton();
      refreshPicker();
      if (liveRuns.length > 0) {
        $<HTMLSelectElement>("runpick").value = `live:${liveRuns[0]!.id}`;
        attachLive(liveRuns[0]!);
      } else if (storedRuns.length > 0) {
        $<HTMLSelectElement>("runpick").value = `file:${storedRuns[0]!.file}`;
        void loadStored(storedRuns[0]!.file);
      } else {
        render();
      }
    } else if (msg.type === "run-started" && msg.run) {
      const existing = liveRuns.findIndex((entry) => entry.id === msg.run!.id);
      if (existing < 0) liveRuns.push({ ...msg.run, state: [], tail: [] });
      else liveRuns[existing] = { ...liveRuns[existing], ...msg.run };
      refreshPicker();
      if (existing < 0 && liveRuns.length === 1) {
        $<HTMLSelectElement>("runpick").value = `live:${msg.run.id}`;
        attachLive(liveRuns[0]!);
      }
    } else if (msg.type === "run-ended" && msg.run) {
      liveRuns = liveRuns.filter((r) => r.id !== msg.run!.id);
      if (msg.stored) storedRuns = msg.stored;
      if (run.id === msg.run.id) {
        run.live = false;
        setStatus("run ended");
      }
      refreshPicker();
    } else if (msg.type === "runs-changed") {
      // A run was pinned: its name gained a "pinned/" prefix, so the picker
      // has to be rebuilt or the selection would point at a moved file.
      if (msg.stored) storedRuns = msg.stored;
      refreshPicker();
    } else if (msg.type === "sim-status") {
      $<HTMLButtonElement>("simrun").disabled = Boolean(msg.busy);
    } else if (msg.type === "sim-finished") {
      $<HTMLButtonElement>("simrun").disabled = false;
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
  $<HTMLButtonElement>("simrun").disabled = true;
  const profile = $<HTMLSelectElement>("simprofile").value;
  const save = $<HTMLSelectElement>("simsave").value;
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
    $<HTMLButtonElement>("simrun").disabled = false;
    setStatus(`sim error: ${body.error}`);
  } else {
    setStatus("sim running…");
  }
});

$("simpin").addEventListener("click", async () => {
  const value = $<HTMLSelectElement>("runpick").value;
  if (!value.startsWith("file:")) return;
  const file = value.slice("file:".length);
  const res = await fetch("/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  const body = (await res.json()) as { error?: string; pinned?: string };
  setStatus(res.ok ? `pinned ${body.pinned}` : `pin failed: ${body.error}`);
});

active = readHash();
render();
connect();

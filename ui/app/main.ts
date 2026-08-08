import { FEATURES } from "../../shared/features/registry.ts";
import type { LogRecord } from "../../shared/telemetry/schema.ts";
import { esc, fmtTime } from "./lib/format.ts";
import { note } from "./lib/dom.ts";
import { emptyState, project, type ProjectedState } from "./project.ts";
import { TABS, type TabId } from "./tabs/index.ts";

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
}

const run = { id: null as string | null, src: null as "game" | "sim" | null, live: false, records: [] as LogRecord[], t0: null as number | null };
let cutoff = Infinity;
let liveRuns: RunSummaryLike[] = [];
let storedRuns: { file: string; size: number; pinned?: boolean }[] = [];
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
  $("tabs").innerHTML = TAB_ORDER.map((tab) => {
    const feature = FEATURES.find((f) => f.id === tab.id);
    const unlocked = feature ? state.caps.unlocked[feature.id] : "yes";
    const cls = [tab.id === active ? "on" : "", unlocked === "no" ? "locked" : unlocked === "unknown" ? "unknown" : ""]
      .filter(Boolean)
      .join(" ");
    const title = feature ? feature.problem : "Cross-feature view";
    return `<a class="tab ${cls}" href="#/${tab.id}" title="${esc(title)}">${esc(tab.label)}</a>`;
  }).join("");
}

/** Locked and unknown panels explain themselves rather than showing nothing. */
function lockedPanel(id: TabId): string | null {
  const feature = FEATURES.find((f) => f.id === id);
  if (!feature) return null;
  const unlocked = state.caps.unlocked[feature.id];
  if (unlocked === "yes") return null;
  const reason = state.caps.reason[feature.id] ?? "not available";
  const nodes = feature.bitnodes.length ? `Themed by ${feature.bitnodes.map((n) => `BN${n}`).join(", ")}.` : "";
  return (
    `<section class="card locked-card">` +
    `<h2>${esc(feature.label)} — ${unlocked === "no" ? "locked" : "not probed yet"}</h2>` +
    `<p>${esc(reason)}</p>` +
    `<p class="muted">${esc(feature.problem)}</p>` +
    (nodes ? `<p class="muted">${esc(nodes)}</p>` : "") +
    (feature.api ? "" : `<p class="muted">No ns API exists for this feature.</p>`) +
    `</section>`
  );
}

/** The tab the DOM currently holds, so scroll is only restored across a
 * re-render of the SAME tab. Switching tabs should start at the top. */
let renderedTab: string | undefined;

/** Re-render the active tab, preserving scroll position.
 *
 * Panels are fully re-rendered from an HTML string on every frame, which is
 * what keeps each tab readable as a description of its layout — but replacing
 * `innerHTML` destroys every scroll offset in the subtree. On a live run that
 * fires every flush, so the page yanks back to the top while you are reading
 * it, and any horizontally-scrolled card snaps back to the left.
 *
 * Capturing and restoring is enough because the DOM shape is stable between
 * frames: the same tab renders the same cards in the same order. */
function renderView(): void {
  const el = $("view");
  const tab = TABS[active];
  if (!run.id) {
    el.innerHTML = `<section class="card">${note("no run selected")}</section>`;
    renderedTab = undefined;
    return;
  }
  const locked = lockedPanel(active);
  if (locked) {
    el.innerHTML = locked;
    renderedTab = undefined;
    return;
  }

  const sameTab = renderedTab === active;
  const pageScroll = window.scrollY;
  const cardScroll = sameTab
    ? [...el.querySelectorAll<HTMLElement>("section.card")].map((card) => [card.scrollLeft, card.scrollTop] as const)
    : [];

  el.innerHTML = tab.render(state);
  tab.mount?.(state, el);
  renderedTab = active;

  if (!sameTab) return;
  const cards = el.querySelectorAll<HTMLElement>("section.card");
  cardScroll.forEach(([left, top], index) => {
    const card = cards[index];
    if (!card) return;
    card.scrollLeft = left;
    card.scrollTop = top;
  });
  // Restored synchronously, before paint, so there is no visible jump.
  window.scrollTo(window.scrollX, pageScroll);
}

function render(): void {
  state = project(run.records, cutoff, { id: run.id, src: run.src, live: run.live, t0: run.t0 });
  renderTabs();
  renderView();
  $("scrubt").textContent = cutoff === Infinity ? "" : fmtTime(cutoff - (run.t0 ?? 0));
}

let queued = false;
function queueRender(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
}

window.addEventListener("hashchange", () => {
  active = readHash();
  render();
});
window.addEventListener("resize", queueRender);

// --- run selection & replay ------------------------------------------------

function refreshPicker(): void {
  const pick = $<HTMLSelectElement>("runpick");
  const current = pick.value;
  pick.innerHTML = [
    ...liveRuns.map(
      (r) => `<option value="live:${esc(r.id)}">● live — ${esc(r.hello?.src)}/${esc(r.hello?.script)} (${esc(r.id)})</option>`,
    ),
    ...storedRuns.map(
      (f) => `<option value="file:${esc(f.file)}">${f.pinned ? "📌 " : ""}${esc(f.file)}</option>`,
    ),
  ].join("");
  if ([...pick.options].some((o) => o.value === current)) pick.value = current;
  // Only an unpinned stored run can be pinned.
  const selected = pick.value;
  const pin = $<HTMLButtonElement>("simpin");
  pin.disabled = !selected.startsWith("file:") || selected.startsWith("file:pinned/");
}

async function loadStored(file: string): Promise<void> {
  const res = await fetch(`/runs/${encodeURIComponent(file)}`);
  const text = await res.text();
  run.records = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);
  run.id = file;
  run.src = run.records[0]?.src ?? null;
  run.live = false;
  run.t0 = run.records[0]?.t ?? null;
  // The slider spans the run's own timeline. `min` must be t0, not 0: game
  // records carry Date.now() timestamps, so a 0-based range puts the entire
  // run inside its last pixel and any drag lands decades before the start.
  const scrub = $<HTMLInputElement>("scrub");
  $("scrubrow").style.display = "flex";
  scrub.min = String(run.t0 ?? 0);
  scrub.max = String(run.records[run.records.length - 1]?.t ?? run.t0 ?? 0);
  scrub.value = scrub.max;
  cutoff = Infinity;
  $("status").textContent = `replay — ${run.records.length} records`;
  render();
}

function attachLive(summary: RunSummaryLike): void {
  run.id = summary.id;
  run.src = summary.hello?.src ?? null;
  run.live = true;
  const seen = new Set<number>();
  run.records = [...(summary.state ?? []), ...(summary.tail ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .filter((r) => (seen.has(r.seq) ? false : (seen.add(r.seq), true)));
  run.t0 = run.records[0]?.t ?? null;
  cutoff = Infinity;
  $("scrubrow").style.display = "none";
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
  stored?: { file: string; size: number; pinned?: boolean }[];
  run?: RunSummaryLike & { id: string };
  records?: LogRecord[];
  busy?: boolean;
  code?: number;
  output?: string;
  syncBusy?: boolean;
}

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/live`);
  ws.onopen = () => {
    $("status").innerHTML = '<span class="live">connected</span>';
  };
  ws.onclose = () => {
    $("status").textContent = "disconnected — retrying…";
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as HubMessage;
    if (msg.type === "snapshot") {
      liveRuns = msg.runs ?? [];
      storedRuns = msg.stored ?? [];
      $<HTMLButtonElement>("sync").disabled = Boolean(msg.syncBusy);
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
      liveRuns.push({ ...msg.run, state: [], tail: [] });
      refreshPicker();
      if (liveRuns.length === 1) {
        $<HTMLSelectElement>("runpick").value = `live:${msg.run.id}`;
        attachLive(liveRuns[0]!);
      }
    } else if (msg.type === "run-ended" && msg.run) {
      liveRuns = liveRuns.filter((r) => r.id !== msg.run!.id);
      if (msg.stored) storedRuns = msg.stored;
      if (run.id === msg.run.id) {
        run.live = false;
        $("status").textContent = "run ended";
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
      $("status").textContent = `sim finished (exit ${msg.code})`;
    } else if (msg.type === "sync-status") {
      $<HTMLButtonElement>("sync").disabled = Boolean(msg.busy);
      if (msg.busy) $("status").textContent = "sync waiting for Bitburner…";
    } else if (msg.type === "sync-finished") {
      $<HTMLButtonElement>("sync").disabled = false;
      const status = $("status");
      status.textContent = msg.code === 0 ? "sync complete" : `sync failed (exit ${msg.code})`;
      status.title = msg.output?.trim() ?? "";
    } else if (msg.type === "records" && run.live && (msg as { run?: string }).run === run.id) {
      run.records.push(...(msg.records ?? []));
      if (run.t0 === null && msg.records?.length) run.t0 = msg.records[0]!.t;
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
  const button = $<HTMLButtonElement>("sync");
  button.disabled = true;
  try {
    const res = await fetch("/sync", { method: "POST" });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) {
      button.disabled = false;
      $("status").textContent = `sync failed: ${body.error ?? res.statusText}`;
    } else {
      $("status").textContent = "sync waiting for Bitburner…";
    }
  } catch (error) {
    button.disabled = false;
    $("status").textContent = `sync failed: ${String(error)}`;
  }
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
    $("status").textContent = `sim error: ${body.error}`;
  } else {
    $("status").textContent = "sim running…";
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
  $("status").textContent = res.ok ? `pinned ${body.pinned} — it will survive the sweep` : `pin failed: ${body.error}`;
});

active = readHash();
render();
connect();

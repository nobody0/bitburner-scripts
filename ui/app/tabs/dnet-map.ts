import { staleness, type ExpiryOpts, type Staleness } from "../../../shared/strategy/dnet/knowledge.ts";
import { modelEntry } from "../../../shared/strategy/dnet/models.ts";
import { esc, fmtNum, fmtRam } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { DarknetKnownHost } from "../../../shared/telemetry/topics/dnet.ts";

/** The darknet, drawn the way the game draws it.
 *
 * The in-game Dark Net screen is a top-down graph: `darkweb` alone at the top,
 * its children in a row below, and so on down, with thin lines for connections
 * and a small bordered box per server carrying an icon, the hostname, `<ip>
 * cha:<n>`, and a status line. Ours showed a sorted table with one row in it.
 * This is the map.
 *
 * ## Why inline SVG, built as a string
 *
 * `morph()` parses markup into a `<template>` and only ever MOVES the parsed
 * nodes into the live tree — it never calls `createElement` — so SVG namespaces
 * survive intact, and `syncAttributes` uses `getAttribute`/`setAttribute`, which
 * are valid on SVG elements. That makes an SVG string a first-class citizen of
 * the existing render loop, with two rules:
 *
 * - **No namespaced attributes.** `xlink:href` would need `setAttributeNS`, so
 *   there is no `<use>`/`<defs>` reuse here; glyphs are literal `<text>`.
 * - **Nothing may read `.className` on these nodes** — on SVG it is an
 *   `SVGAnimatedString`, not a string. `morph` never does.
 *
 * Canvas was the obvious alternative and is wrong for this: `morph` deliberately
 * skips canvas attributes and children, a canvas cannot carry `data-view-key` so
 * selecting a node would need a hit-test listener bound inside the tab (which
 * the architecture forbids), and it loses `<title>` tooltips and text selection.
 * CSS-grid boxes with an SVG edge overlay would need `getBoundingClientRect`
 * after layout, so a `mount()` and a resize hook, and it drifts with font
 * metrics. Fixed geometry computed in TypeScript needs none of that.
 *
 * Every node and edge carries a `data-key`, so a host that changes depth or
 * column is MOVED rather than rebuilt. That is what keeps `:hover` and the
 * native tooltip alive across a 2 Hz re-render, and keeps a 163-host map down to
 * a handful of touched nodes per frame.
 *
 * ## The one place this is our inference, not the game's truth
 *
 * The game lays servers out on a grid of `NET_WIDTH = 8` columns by depth rows,
 * and `DarknetServer.leftOffset` is the column. **`leftOffset` is not exposed to
 * scripts.** `getServerDetails` gives us depth and nothing about the column. So
 * the row is exact and the column is assigned here, by a barycentre sweep that
 * puts a host near its parents. It reads like the game's map and it is not a
 * claim to be the same map.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/ui/dnetStyles.ts      (box and gap sizes, scaled down here)
 *   src/DarkNet/ui/networkCanvas.ts   (the odd-row stagger, darkweb centring)
 *   src/DarkNet/ui/ServerStatusBox.tsx (what a box shows, and its border colour) */

/** Columns the game builds the net on. Upstream `NET_WIDTH`. */
export const NET_WIDTH = 8;

/** Box and pitch. Upstream uses 240x130 boxes with 60/120 gaps; these are the
 * same proportions at a size that fits a panel rather than a full page. */
export const BOX_W = 116;
export const BOX_H = 68;
const COL_GAP = 16;
const ROW_GAP = 36;
/** Left inset. The row labels live in this gutter — at a smaller pad they were
 * drawn over the leftmost box of every row. */
const PAD_X = 54;
const PAD = 12;
export const COL_PITCH = BOX_W + COL_GAP;
export const ROW_PITCH = BOX_H + ROW_GAP;

/** Total width is fixed by the column count, so the viewBox never changes and
 * zoom is two patched attributes rather than a re-layout. */
export const MAP_W = PAD_X + PAD + NET_WIDTH * BOX_W + (NET_WIDTH - 1) * COL_GAP;

export interface Placed {
  host: DarknetKnownHost;
  /** Grid row. `-1` is darkweb's own row; the unplaced row is `rows - 1`. */
  row: number;
  /** 0-based column, or a fractional value for a centred row. */
  slot: number;
  x: number;
  y: number;
}

export interface NetLayout {
  placed: Placed[];
  byHost: Map<string, Placed>;
  /** Row labels, top to bottom, as `[y, label]`. */
  rowLabels: { y: number; label: string }[];
  height: number;
  /** Hosts we could not place by depth, which the caller shows in its own row
   *  rather than dropping. */
  unplaced: number;
}

function centredSlot(): number {
  return (NET_WIDTH - 1) / 2;
}

function xOf(slot: number, row: number): number {
  // Upstream staggers odd rows by half a box, and it is not decoration: without
  // it, a dense row of vertical edges overlaps into an unreadable ladder.
  const stagger = row >= 0 && row % 2 === 1 ? BOX_W / 2 : 0;
  return PAD_X + slot * COL_PITCH + stagger;
}

function yOf(displayRow: number): number {
  return PAD + displayRow * ROW_PITCH;
}

/** Lay the known net out on the game's grid.
 *
 * Deterministic by construction: one downward sweep, no iteration, no
 * randomness, and ties broken by hostname. Identical input gives byte-identical
 * output, which is what stops the map shimmering under a live re-render — and is
 * directly testable, which a force-directed layout would not be.
 *
 * Placement per depth is by BARYCENTRE: a host sits near the average column of
 * the parents that are already placed, so edges stay short and mostly avoid
 * crossing. A host with no placed parent sorts last, since there is nothing to
 * sit near. */
export function layoutNet(hosts: readonly DarknetKnownHost[]): NetLayout {
  const placed: Placed[] = [];
  const byHost = new Map<string, Placed>();
  const rowLabels: { y: number; label: string }[] = [];

  const darkweb = hosts.filter((host) => host.isDarkweb === true || host.hostname === "darkweb");
  const withDepth = hosts.filter((host) => !darkweb.includes(host) && host.depth !== undefined);
  const without = hosts.filter((host) => !darkweb.includes(host) && host.depth === undefined);

  const byDepth = new Map<number, DarknetKnownHost[]>();
  for (const host of withDepth) {
    const depth = host.depth!;
    const bucket = byDepth.get(depth);
    if (bucket) bucket.push(host);
    else byDepth.set(depth, [host]);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);

  let displayRow = 0;
  const place = (host: DarknetKnownHost, row: number, slot: number, atRow: number): void => {
    const entry: Placed = { host, row, slot, x: xOf(slot, row), y: yOf(atRow) };
    placed.push(entry);
    byHost.set(host.hostname, entry);
  };

  // darkweb sits alone and centred above depth 0, exactly as upstream does — its
  // real depth is -1, and its children are depth 0.
  if (darkweb.length > 0) {
    rowLabels.push({ y: yOf(displayRow), label: "darkweb" });
    for (const host of darkweb) place(host, -1, centredSlot(), displayRow);
    displayRow++;
  }

  for (const depth of depths) {
    const bucket = [...byDepth.get(depth)!];
    // Barycentre over already-placed parents. Infinity for a host with no placed
    // parent: it has nothing to sit near, so it goes to the end rather than to
    // an arbitrary column that would imply a relationship we do not know about.
    const bary = new Map<string, number>();
    for (const host of bucket) {
      const slots: number[] = [];
      for (const neighbour of host.neighbours ?? []) {
        const parent = byHost.get(neighbour);
        if (parent) slots.push(parent.slot);
      }
      bary.set(host.hostname, slots.length === 0 ? Infinity : slots.reduce((a, b) => a + b, 0) / slots.length);
    }
    bucket.sort((a, b) => {
      const diff = bary.get(a.hostname)! - bary.get(b.hostname)!;
      if (Number.isFinite(diff) && diff !== 0) return diff;
      if (bary.get(a.hostname) !== bary.get(b.hostname)) return bary.get(a.hostname)! - bary.get(b.hostname)!;
      return a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0;
    });

    // More than NET_WIDTH at one depth is possible while a gone host and a
    // moved one are both still held, so the row wraps rather than dropping the
    // overflow. The map never truncates; that is what the table's limit is for.
    for (let i = 0; i < bucket.length; i += NET_WIDTH) {
      const chunk = bucket.slice(i, i + NET_WIDTH);
      rowLabels.push({
        y: yOf(displayRow),
        label: i === 0 ? `depth ${depth}${bucket.length > NET_WIDTH ? ` (${bucket.length})` : ""}` : "",
      });
      chunk.forEach((host, slot) => place(host, depth, slot, displayRow));
      displayRow++;
    }
  }

  // A host whose depth we never learned, or whose depth fact died with it, still
  // exists and still matters — it is usually the most interesting thing on the
  // map, because it is what we know least about.
  if (without.length > 0) {
    const sorted = [...without].sort((a, b) => (a.hostname < b.hostname ? -1 : 1));
    for (let i = 0; i < sorted.length; i += NET_WIDTH) {
      rowLabels.push({ y: yOf(displayRow), label: i === 0 ? "depth unknown" : "" });
      sorted.slice(i, i + NET_WIDTH).forEach((host, slot) => place(host, Number.NaN, slot, displayRow));
      displayRow++;
    }
  }

  return {
    placed,
    byHost,
    rowLabels,
    height: PAD * 2 + Math.max(1, displayRow) * ROW_PITCH - ROW_GAP,
    unplaced: without.length,
  };
}

/** The type glyph, by model family. All BMP characters that exist in the mono
 * stack — no emoji, which render at inconsistent widths and colour. */
const FAMILY_GLYPH: Record<string, string> = {
  none: "○",
  dictionary: "≡",
  echo: "↺",
  timing: "◷",
  math: "∑",
  oracle: "?",
  packet: "≋",
  lab: "※",
};

const AUTH_LABEL: Record<string, string> = {
  session: "● session",
  authenticated: "[ authenticated ]",
  "auth-required": "[ auth required ]",
  "no-connection": "(no connection)",
  offline: "(offline)",
};

/** How old one published fact is, and what is left of its life.
 *
 * Derived here rather than shipped: the digest carries an observation time per
 * fact and nothing else. It calls the CONTROLLER's own `staleness` rather than
 * repeating the arithmetic, because a panel that could disagree with the
 * decision about what is stale would be worse than one that showed nothing.
 * `staleness` reads only `at`, so the value is a placeholder.
 *
 * Immunity is a property of the HOST, not of a fact: a stationary or
 * stasis-linked server is skipped by every mutation branch upstream, so nothing
 * about it ages. `darkweb` is the one you meet first. */
export function factLife(
  host: DarknetKnownHost,
  key: string,
  now: number,
  expiry: ExpiryOpts,
): Staleness | undefined {
  const at = host.facts[key];
  if (at === undefined) return undefined;
  const immune = host.isStationary === true || host.stasisLinked === true;
  return staleness({ value: undefined, at }, key, now, { ...expiry, immune });
}

/** True when nothing we hold about this host is still believable. Drawn faded,
 * because "we believed this five minutes ago" and "this is true" must not look
 * the same on a net that rewires itself every three seconds. */
export function isStale(host: DarknetKnownHost, now: number, expiry: ExpiryOpts): boolean {
  const keys = Object.keys(host.facts);
  if (keys.length === 0) return false;
  return keys.every((key) => factLife(host, key, now, expiry)?.stale === true);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Everything a box says, as a plain-text tooltip. Colour is never the only
 * channel: every state also has a status line and this. */
function titleOf(host: DarknetKnownHost, options: MapOptions): string {
  const parts = [host.hostname];
  if (host.ip) parts.push(host.ip);
  parts.push(AUTH_LABEL[host.authState ?? "no-connection"] ?? "");
  const entry = modelEntry(host.modelId);
  if (host.modelId) parts.push(`model ${host.modelId}${entry ? ` (${entry.name})` : ""}`);
  if (entry?.blocked !== undefined) parts.push(entry.blocked);
  if (host.maxRam !== undefined) {
    parts.push(`RAM ${fmtRam(host.freeRam ?? 0)} free of ${fmtRam(host.maxRam)}, ${fmtRam(host.blockedRam ?? 0)} blocked`);
  }
  if (host.requiredCharisma !== undefined) parts.push(`charisma ${fmtNum(host.requiredCharisma, 0)}`);
  if (host.goneAt !== undefined) parts.push("gone");
  if (isStale(host, options.now, options.expiry)) parts.push("every fact stale — believed, not confirmed");
  return parts.filter(Boolean).join(" · ");
}

function ramBar(host: DarknetKnownHost, x: number, y: number): string {
  if (host.maxRam === undefined || host.maxRam <= 0) return "";
  const width = BOX_W - 16;
  const blocked = Math.max(0, Math.min(host.blockedRam ?? 0, host.maxRam));
  const free = Math.max(0, Math.min(host.freeRam ?? 0, host.maxRam));
  const used = Math.max(0, host.maxRam - blocked - free);
  const w = (value: number) => Math.max(0, (value / host.maxRam!) * width);
  const freeW = w(free);
  const usedW = w(used);
  const blockedW = w(blocked);
  return (
    `<rect class="ram free" x="${x}" y="${y}" width="${freeW.toFixed(1)}" height="4"></rect>`
    + `<rect class="ram used" x="${(x + freeW).toFixed(1)}" y="${y}" width="${usedW.toFixed(1)}" height="4"></rect>`
    + `<rect class="ram blocked" x="${(x + freeW + usedW).toFixed(1)}" y="${y}" width="${blockedW.toFixed(1)}" height="4"></rect>`
  );
}

function nodeMarkup(entry: Placed, options: MapOptions): string {
  const { selected, query } = options;
  const { host, x, y } = entry;
  const classes = ["node", `auth-${host.authState ?? "no-connection"}`];
  if (host.goneAt !== undefined) classes.push("gone");
  if (isStale(host, options.now, options.expiry)) classes.push("stale");
  if (host.stasisLinked) classes.push("linked");
  if (host.hostname === selected) classes.push("sel");
  if (query) classes.push(matches(host, query) ? "hit" : "dim");

  const glyph = FAMILY_GLYPH[modelEntry(host.modelId)?.family ?? "oracle"] ?? "?";
  const meta = [host.ip ?? "", host.requiredCharisma !== undefined ? `cha:${fmtNum(host.requiredCharisma, 0)}` : ""]
    .filter(Boolean)
    .join(" ");
  const status = AUTH_LABEL[host.authState ?? "no-connection"] ?? "";
  const ram = host.maxRam === undefined
    ? ""
    : `${fmtRam(host.freeRam ?? 0)}/${fmtRam(host.maxRam)}`;

  return (
    // data-view-key is the whole selection mechanism: main.ts's delegated
    // handler resolves `closest()` on SVG elements and SVGElement carries
    // `.dataset`, so no listener is needed and main.ts needs no change.
    `<g class="${classes.join(" ")}" data-key="node:${esc(host.hostname)}"`
    + ` data-view-key="dnet.sel" data-view-value="${esc(host.hostname)}" role="button">`
    + `<title>${esc(titleOf(host, options))}</title>`
    + `<rect class="box" x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="2"></rect>`
    + (host.stasisLinked ? `<rect class="stasis" x="${x}" y="${y}" width="3" height="${BOX_H}"></rect>` : "")
    + (host.isStationary ? `<text class="fixed" x="${x + BOX_W - 6}" y="${y + 14}">#</text>` : "")
    + `<text class="glyph" x="${x + 7}" y="${y + 15}">${esc(glyph)}</text>`
    + `<text class="host" x="${x + 20}" y="${y + 15}">${esc(clip(host.hostname, 14))}</text>`
    + `<text class="meta" x="${x + 7}" y="${y + 29}">${esc(meta)}</text>`
    + `<text class="status" x="${x + 7}" y="${y + 43}">${esc(status)}</text>`
    + ramBar(host, x + 7, y + 49)
    + `<text class="ramtext" x="${x + 7}" y="${y + 63}">${esc(ram)}</text>`
    + `</g>`
  );
}

export function matches(host: DarknetKnownHost, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    host.hostname.toLowerCase().includes(needle)
    || (host.ip ?? "").toLowerCase().includes(needle)
    || (host.modelId ?? "").toLowerCase().includes(needle)
    || (modelEntry(host.modelId)?.name ?? "").toLowerCase().includes(needle)
    || (host.passwordHint ?? "").toLowerCase().includes(needle)
  );
}

/** Edges, routed through the row gutter as three orthogonal segments.
 *
 * Straight diagonals are what the game draws, but the game has a 6000px canvas
 * to draw them on; at panel scale they cross into noise. An orthogonal route
 * through the gutter keeps a dense row readable and needs no curve maths. */
function edgeMarkup(layout: NetLayout, options: MapOptions): string {
  const mode = options.edges;
  if (mode === "none") return "";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const from of layout.placed) {
    for (const name of from.host.neighbours ?? []) {
      const to = layout.byHost.get(name);
      if (!to) continue;
      // One line per pair: adjacency is reported from both ends, and drawing it
      // twice doubles the stroke and makes an ordinary edge look emphasised.
      const key = from.host.hostname < name
        ? `${from.host.hostname}>${name}`
        : `${name}>${from.host.hostname}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const down = to.y > from.y;
      const [a, b] = down ? [from, to] : [to, from];
      const tree = Math.abs(a.row - b.row) === 1 && a.y !== b.y;
      if (mode === "tree" && !tree) continue;

      const x1 = a.x + BOX_W / 2;
      const y1 = a.y + BOX_H;
      const x2 = b.x + BOX_W / 2;
      const y2 = b.y;
      const mid = a.y === b.y ? a.y + BOX_H + ROW_GAP / 2 : y1 + (y2 - y1) / 2;
      const path = a.y === b.y
        // Same row: dip into the gutter below rather than drawing through the
        // boxes between them.
        ? `M ${x1} ${y1} V ${mid} H ${x2} V ${y1}`
        : `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}`;
      const classes = ["edge", tree ? "tree" : a.row === b.row ? "lateral" : "back"];
      const edgeStale = (host: DarknetKnownHost) =>
        factLife(host, "neighbours", options.now, options.expiry)?.stale === true;
      if (edgeStale(a.host) || edgeStale(b.host)) classes.push("stale");
      parts.push(`<path class="${classes.join(" ")}" data-key="edge:${esc(key)}" d="${path}"></path>`);
    }
  }
  return parts.join("");
}

/** The legend, built from the same tables that drive the glyphs and the borders
 * so the two can never drift apart. */
export function netLegend(): string {
  const swatch = (cls: string, label: string) =>
    `<span class="netkey"><span class="sw ${cls}"></span>${esc(label)}</span>`;
  const glyphs = Object.entries(FAMILY_GLYPH)
    .map(([family, glyph]) => `<span class="netkey"><span class="gl">${esc(glyph)}</span>${esc(family)}</span>`)
    .join("");
  return (
    `<div class="netlegend">`
    + swatch("auth-session", "session")
    + swatch("auth-authenticated", "cracked")
    + swatch("auth-auth-required", "auth required")
    + swatch("auth-no-connection", "no connection")
    + swatch("gone", "gone")
    + swatch("linked", "stasis")
    + swatch("stale", "faded = believed, not confirmed")
    + `</div><div class="netlegend">${glyphs}</div>`
  );
}

export interface MapOptions {
  selected: string;
  query: string;
  zoom: number;
  edges: string;
  /** The digest's own clock, which every age on this page is measured against. */
  now: number;
  expiry: ExpiryOpts;
}

/** The whole map as one SVG string. */
export function netMap(hosts: readonly DarknetKnownHost[], options: MapOptions): string {
  const layout = layoutNet(hosts);
  const scale = options.zoom / 100;
  const labels = layout.rowLabels
    .filter((row) => row.label.length > 0)
    .map((row) => `<text class="rowlabel" x="2" y="${row.y + 12}">${esc(row.label)}</text>`)
    .join("");

  return (
    `<div class="netmap-scroll zoom-${options.zoom}">`
    // viewBox is CONSTANT and only width/height change, so zoom is two patched
    // attributes and SVG scales the text and strokes for free.
    + `<svg class="netmap" role="img" aria-label="darknet map, ${hosts.length} hosts"`
    + ` viewBox="0 0 ${MAP_W} ${layout.height}"`
    + ` width="${Math.round(MAP_W * scale)}" height="${Math.round(layout.height * scale)}">`
    + edgeMarkup(layout, options)
    + layout.placed.map((entry) => nodeMarkup(entry, options)).join("")
    + labels
    + `</svg></div>`
  );
}

/** Read the map's view controls. Kept beside the renderer so the keys are
 * declared once. */
export function mapOptions(now: number, expiry: ExpiryOpts): MapOptions {
  return {
    now,
    expiry,
    selected: view("dnet.sel"),
    query: view("dnet.q").trim(),
    zoom: Number(view("dnet.zoom", "100")) || 100,
    edges: view("dnet.edges", "tree"),
  };
}

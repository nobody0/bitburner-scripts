import { expiryMs, fieldGroup, type ExpiryOpts, type Staleness } from "../../../shared/strategy/dnet/host.ts";
import { modelEntry } from "../../../shared/strategy/dnet/models.ts";
import { TASK_KINDS, type TaskKind } from "../../../shared/strategy/dnet/jobs.ts";
import {
  isLabyrinth,
  isOnAirGap,
  labStage,
  netDepthFromLabs,
  MAX_NET_DEPTH as LIMIT,
  NET_WIDTH as WIDTH,
} from "../../../shared/strategy/dnet/rates.ts";
import { esc, fmtNum, fmtRam, fmtRamExact } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import { dnetRamGb, type DarknetKnownHost } from "../../../shared/telemetry/topics/dnet.ts";

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
 * scripts** — `getServerDetails` gives us depth and nothing about the column. So
 * the ROW is exact and the COLUMN is reconstructed, in `layoutNet` below.
 *
 * The reconstruction is not a guess dressed up as one: a same-depth edge is a
 * hard constraint the game hands us for free, because `getNeighborsOnRow` can
 * only ever return the two cells beside a host. What it cannot pin, it leaves
 * loose rather than inventing. It reads like the game's map; it is not a claim
 * to BE the game's map.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/ui/dnetStyles.ts      (box and gap sizes, scaled down here)
 *   src/DarkNet/ui/networkCanvas.ts   (the odd-row stagger, darkweb centring)
 *   src/DarkNet/ui/ServerStatusBox.tsx (what a box shows, and its border colour)
 *   src/DarkNet/utils/darknetNetworkUtils.ts (the adjacency rules columns come from) */

/** Columns the game builds the net on, and the deepest row that can exist.
 * Re-exported from the shared table so the map, the sim and the strategy cannot
 * disagree about how big the board is. */
export { NET_WIDTH, MAX_NET_DEPTH } from "../../../shared/strategy/dnet/rates.ts";

export interface LayoutOptions {
  /** The net's true depth, when something knows it. `getNetDepth()` is the
   *  current labyrinth's depth, so a single lab sighting pins it exactly; the
   *  layout falls back to one past the deepest host it can see, and says which
   *  it did via `netDepthGuessed`. */
  netDepth?: number;
  /** Tie-break rank for a lateral claim, lower being more believable. Used only
   *  when two claims cannot both be true. Injected rather than computed here so
   *  the layout stays a pure function of its arguments and the staleness rule
   *  lives in one place.
   *
   *  Takes the two hostnames rather than a joined key: darknet hostnames are
   *  generated from a connector set of `. - _ ; : :: $ ^ % @ &` and can carry a
   *  `/` too, so picking any separator to split back out on is a trap waiting
   *  for the day the generator gains one more. */
  lateralRank?: (a: string, b: string) => number;
  /** How much we doubt a host's POSITION, lower being more believable. Only ever
   *  consulted when a depth holds more hosts than the grid has cells, to decide
   *  which of them get the real row. Same reason as above for injecting it. */
  positionDoubt?: (hostname: string) => number;
}

/** Box and pitch. Upstream uses 240x130 boxes with 60/120 gaps — ratios of 0.25
 * horizontal and 0.92 vertical. These are those ratios at a size that fits a
 * panel rather than a full page. The row gutter is not slack: it is the channel
 * the orthogonal edge routing runs through, and tightening it is what made a
 * dense row unreadable the first time round. */
export const BOX_W = 116;
export const BOX_H = 82;
const COL_GAP = 29;
const ROW_GAP = 63;
/** Left inset. The row labels live in this gutter — at a smaller pad they were
 * drawn over the leftmost box of every row. */
const PAD_X = 54;
const PAD = 12;
export const COL_PITCH = BOX_W + COL_GAP;
export const ROW_PITCH = BOX_H + ROW_GAP;

const JOB_VISUALS: Readonly<Record<TaskKind, { label: string; className: string }>> = {
  walk: { label: "walk", className: "job-walk" },
  relaunchProbe: { label: "repair probe", className: "job-relaunch-probe" },
  plant: { label: "plant", className: "job-plant" },
  inventory: { label: "inventory", className: "job-inventory" },
  cache: { label: "cache", className: "job-cache" },
  pin: { label: "pin", className: "job-pin" },
  storm: { label: "storm", className: "job-storm" },
  attempt: { label: "attempt", className: "job-attempt" },
  bleed: { label: "bleed", className: "job-bleed" },
  reclaim: { label: "reclaim", className: "job-reclaim" },
  induce: { label: "induce", className: "job-induce" },
  phish: { label: "phish", className: "job-phish" },
  promote: { label: "promote", className: "job-promote" },
};

function jobVisual(kind: TaskKind | undefined): { label: string; className: string } {
  return kind === undefined ? { label: "ready", className: "job-ready" } : JOB_VISUALS[kind];
}

/** Total width is fixed by the column count, so the viewBox never changes and
 * zoom is two patched attributes rather than a re-layout.
 *
 * The trailing half-box is the odd-row STAGGER. Without it every odd row's
 * column 7 hung past the viewBox and was silently clipped. */
export const MAP_W = PAD_X + PAD + WIDTH * BOX_W + (WIDTH - 1) * COL_GAP + BOX_W / 2;

/** What a display row is showing, which is not the same question as what depth
 * it is. An empty grid row and an air gap look alike and mean opposite things,
 * and neither is `floor` — the marker for "the net may go deeper than the rows
 * above, we have simply never been told where it ends". */
export type RowKind = "darkweb" | "depth" | "airgap" | "labyrinth" | "floor" | "unknown";

export interface Placed {
  host: DarknetKnownHost;
  /** The GAME's row. `-1` is darkweb, `0..netDepth-1` is the grid, `netDepth` is
   *  the labyrinth, and `NaN` is a host we cannot place. Overflow chunks share
   *  their depth's value, so stagger and edge classification are shared. */
  row: number;
  /** Column, `0..NET_WIDTH-1`, or fractional on a centred row. Our inference,
   *  not the game's truth — see the note at the top of this file. */
  slot: number;
  /** Index into the row plan. Distinct from `row` only for overflow chunks. */
  displayRow: number;
  kind: RowKind;
  x: number;
  y: number;
}

export interface RowLabel {
  y: number;
  label: string;
  kind: RowKind;
  depth?: number;
}

export interface NetLayout {
  placed: Placed[];
  byHost: Map<string, Placed>;
  rowLabels: RowLabel[];
  height: number;
  /** Hosts we could not place by depth, drawn in their own row rather than
   *  dropped. */
  unplaced: number;
  /** Same-depth adjacency claims we hold and could NOT honour, by canonical
   *  edge key. A lateral edge means `|Δcolumn| == 1` in the live game with no
   *  exceptions, so one of these is always our own knowledge contradicting
   *  itself — which is worth drawing, not swallowing. */
  brokenLaterals: Set<string>;
  /** The grid we believe exists, whether or not we have seen into it. */
  netDepth: number;
  /** True when `netDepth` is a floor derived from what we have seen rather than
   *  read off the labyrinth. */
  netDepthGuessed: boolean;
}

function centredSlot(): number {
  return (WIDTH - 1) / 2;
}

/** Upstream: `y >= 0 && y < getNetDepth() && y % 2`. The bottom row is NOT
 * staggered, and neither are darkweb, the labyrinth or the unplaced row. */
function staggerOf(row: number, netDepth: number): number {
  return row >= 0 && row < netDepth && row % 2 === 1 ? BOX_W / 2 : 0;
}

function xOf(slot: number, row: number, netDepth: number): number {
  return PAD_X + slot * COL_PITCH + staggerOf(row, netDepth);
}

function yOf(displayRow: number): number {
  return PAD + displayRow * ROW_PITCH;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}>${b}` : `${b}>${a}`;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lexicographic order over two equal-length hostname lists.
 *
 * Element by element rather than by joining on a separator: darknet hostnames
 * are generated to look like junk and contain most of the punctuation you might
 * pick as one — `hydro;hyper::anonymous;flame` is a real host — so any separator
 * could also appear inside a name and reorder two chains that differ elsewhere. */
function byList(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < a.length; index++) {
    const order = byName(a[index]!, b[index]!);
    if (order !== 0) return order;
  }
  return 0;
}

/** A run of hosts known to occupy consecutive columns, in order. */
interface Chain {
  members: string[];
  depth: number;
}

/** Split one depth's hosts into chains of column-adjacent hosts.
 *
 * Every accepted edge is a claim that two hosts sit in neighbouring cells, so a
 * chain of k hosts pins k consecutive columns and leaves only its offset and its
 * reflection free. One deterministic sweep decides which claims survive, and it
 * collapses degree repair, cycle breaking and over-length splitting into a
 * single accept-or-demote rule:
 *
 * - a host already holding two lateral edges has no free side left;
 * - an edge closing a cycle cannot be drawn on a line;
 * - a chain longer than the board is wider cannot be seated.
 *
 * Degree <= 2, acyclic and size <= NET_WIDTH together mean every component is a
 * path, by construction rather than by a repair pass. Demoted edges are returned
 * so the renderer can draw them as contradictions. */
function chainsOf(
  names: readonly string[],
  depth: number,
  lateral: ReadonlyMap<string, string[]>,
  freshness: (a: string, b: string) => number,
  broken: Set<string>,
): Chain[] {
  const candidates: { key: string; a: string; b: string; rank: number }[] = [];
  const seen = new Set<string>();
  for (const a of names) {
    for (const b of lateral.get(a) ?? []) {
      const key = edgeKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      // Mutual claims first, then fresher ones: when two claims cannot both be
      // true, the one more agents still vouch for is the better bet.
      const mutual = (lateral.get(b) ?? []).includes(a) ? 0 : 1;
      candidates.push({ key, a: a < b ? a : b, b: a < b ? b : a, rank: mutual * 2 + freshness(a, b) });
    }
  }
  candidates.sort((x, y) => x.rank - y.rank || byName(x.key, y.key));

  const parent = new Map<string, string>(names.map((name) => [name, name]));
  const size = new Map<string, number>(names.map((name) => [name, 1]));
  const degree = new Map<string, number>(names.map((name) => [name, 0]));
  const find = (name: string): string => {
    let node = name;
    while (parent.get(node) !== node) {
      parent.set(node, parent.get(parent.get(node)!)!);
      node = parent.get(node)!;
    }
    return node;
  };
  const links = new Map<string, string[]>(names.map((name) => [name, []]));

  for (const edge of candidates) {
    const rootA = find(edge.a);
    const rootB = find(edge.b);
    if (degree.get(edge.a)! >= 2 || degree.get(edge.b)! >= 2 || rootA === rootB
      || size.get(rootA)! + size.get(rootB)! > WIDTH) {
      broken.add(edge.key);
      continue;
    }
    parent.set(rootA, rootB);
    size.set(rootB, size.get(rootA)! + size.get(rootB)!);
    degree.set(edge.a, degree.get(edge.a)! + 1);
    degree.set(edge.b, degree.get(edge.b)! + 1);
    links.get(edge.a)!.push(edge.b);
    links.get(edge.b)!.push(edge.a);
  }

  // Walk each component from an endpoint. Every component is a path now, so an
  // endpoint is any member of degree < 2, and a singleton is its own.
  const chains: Chain[] = [];
  const visited = new Set<string>();
  for (const start of [...names].sort(byName)) {
    if (visited.has(start) || degree.get(start)! >= 2) continue;
    const members: string[] = [];
    let current: string | undefined = start;
    let previous: string | undefined;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      members.push(current);
      const next: string | undefined = (links.get(current) ?? []).find((name) => name !== previous);
      previous = current;
      current = next;
    }
    // Canonical orientation, so an unanchored chain is still deterministic.
    const reversed = [...members].reverse();
    chains.push({ members: byList(members, reversed) <= 0 ? members : reversed, depth });
  }
  return chains;
}

/** Where a chain wants to sit, choosing its reflection, and REVERSING it when
 * the mirrored fit is better.
 *
 * A chain of k hosts pins k consecutive columns; only its offset and its
 * direction are free. Both are fixed here together, because they are one
 * decision: the offset that best fits the anchors depends on which way round
 * the chain is. Returns NaN when nothing in the chain is anchored yet. */
function orientChain(chain: Chain, anchorOf: (hostname: string) => number): number {
  const anchors = chain.members.map(anchorOf);
  if (!anchors.some((value) => Number.isFinite(value))) return Number.NaN;
  const last = chain.members.length - 1;
  const seatOf = (base: number, index: number, reverse: boolean) => base + (reverse ? last - index : index);
  const offsetOf = (reverse: boolean) => {
    const offsets = anchors
      .map((value, index) => value - (reverse ? last - index : index))
      .filter((value) => Number.isFinite(value));
    return offsets.reduce((a, b) => a + b, 0) / offsets.length;
  };
  const fitOf = (base: number, reverse: boolean) =>
    anchors.reduce(
      (sum, value, index) => Number.isFinite(value) ? sum + (value - seatOf(base, index, reverse)) ** 2 : sum,
      0,
    );

  const forward = offsetOf(false);
  const backward = offsetOf(true);
  // Strictly better only: an exact tie keeps the canonical orientation, so an
  // unanchored-but-symmetric chain does not flip between frames.
  if (fitOf(backward, true) < fitOf(forward, false)) {
    chain.members.reverse();
    return backward;
  }
  return forward;
}

/** Seat one depth's chains into columns, leaving HOLES where the evidence
 * implies them.
 *
 * This is the whole fix. The previous version sorted by barycentre and then
 * assigned `slot = array index`, which packed every row flush against column 0 —
 * so a two-host row whose parents sat at columns 6 and 7 landed at 0 and 1, and
 * no two rows ever lined up. Ordering was never the bug.
 *
 * The right-margin reservation (`hi`) is what makes a single greedy pass
 * complete whenever the chains fit at all. Plain first-fit is not: anchored
 * singletons at 0, 2, 4 and 6 leave {1,3,5,7}, which has no adjacent pair for a
 * two-host chain even though six of eight columns are free. */
function seatChains(
  chains: readonly Chain[],
  origin: (chain: Chain) => number,
  trust: (chain: Chain) => number,
): Map<string, number>[] {
  const bySeat = (a: Chain, b: Chain): number => {
    const oa = origin(a);
    const ob = origin(b);
    const knownA = Number.isFinite(oa) ? 0 : 1;
    const knownB = Number.isFinite(ob) ? 0 : 1;
    if (knownA !== knownB) return knownA - knownB;
    if (knownA === 0 && oa !== ob) return oa - ob;
    if (a.members.length !== b.members.length) return b.members.length - a.members.length;
    return byName(a.members[0]!, b.members[0]!);
  };

  // Chunked only when we hold more hosts at a depth than the board can seat,
  // which the LIVE GAME CANNOT PRODUCE — `Network[depth]` has exactly NET_WIDTH
  // cells. It means we are believing a host and its ghost at once, so the first
  // chunk is filled with the hosts we believe MOST and the doubt sinks to the
  // rows below. Nothing is dropped; the row label says what happened instead.
  const ordered = [...chains].sort((a, b) => trust(a) - trust(b) || bySeat(a, b));
  const chunks: Chain[][] = [];
  let current: Chain[] = [];
  let held = 0;
  for (const chain of ordered) {
    if (held + chain.members.length > WIDTH && current.length > 0) {
      chunks.push(current);
      current = [];
      held = 0;
    }
    current.push(chain);
    held += chain.members.length;
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((unsorted) => {
    // Within a row, position is what orders them again.
    const chunk = [...unsorted].sort(bySeat);
    const seats = new Map<string, number>();
    let next = 0;
    let remaining = chunk.reduce((sum, chain) => sum + chain.members.length, 0);
    for (const chain of chunk) {
      const length = chain.members.length;
      remaining -= length;
      const lo = next;
      const hi = Math.max(lo, WIDTH - length - remaining);
      const wanted = origin(chain);
      // An unanchored chain takes the leftmost seat that still leaves room,
      // rather than the centre: centring would assert a relationship to the rows
      // above and below that we have no evidence for.
      const at = Number.isFinite(wanted) ? Math.min(Math.max(Math.round(wanted), lo), hi) : lo;
      chain.members.forEach((name, index) => seats.set(name, at + index));
      next = at + length;
    }
    return seats;
  });
}

/** Lay the known net out on the game's grid.
 *
 * Deterministic by construction: a fixed number of passes, no randomness, and
 * ties broken by hostname. Identical input gives byte-identical output, which is
 * what stops the map shimmering under a live re-render — and is directly
 * testable, which a force-directed layout would not be.
 *
 * ## What the evidence actually supports
 *
 * A SAME-DEPTH edge is hard evidence: `getNeighborsOnRow(x, y)` returns only
 * `Network[x][y-1]` and `Network[x][y+1]`, and both connection passes route
 * through it, so a lateral edge means `|Δcolumn| == 1` exactly. Its ABSENCE
 * means nothing at all — each pair is rolled at about even odds.
 *
 * A VERTICAL edge is no evidence: `addRandomConnections` rolls it against the
 * WHOLE adjacent row, calling `getServersOnRowAbove/Below` without their `close`
 * argument, so a depth-4 host can legitimately be wired to the depth-3 host at
 * the far end of the board. It is a preference, and treating it as anything
 * firmer would produce a confidently wrong map.
 *
 * darkweb and the labyrinth are excluded from every barycentre. Both are pinned
 * at the centre column and both are adjacent to their entire row — darkweb to
 * every depth-0 host, the labyrinth to every host on the deepest row — so
 * including them injects a constant that flattens the row they anchor. Depth 0
 * would collapse to a single barycentre and fall back to hostname order, which
 * is precisely the behaviour this rewrite exists to remove. */
export function layoutNet(hosts: readonly DarknetKnownHost[], opts: LayoutOptions = {}): NetLayout {
  // Four kinds, decided once. The two pinned kinds are recognised by identity
  // rather than by depth, because BOTH report a depth of -1 and so does an
  // offline host — `getDepth` returns -1 when the lookup fails.
  const darkweb: DarknetKnownHost[] = [];
  const labs: DarknetKnownHost[] = [];
  const grid: DarknetKnownHost[] = [];
  const unknown: DarknetKnownHost[] = [];
  for (const host of hosts) {
    if (host.isDarkweb === true || host.hostname === "darkweb") darkweb.push(host);
    else if (isLabyrinth(host.hostname, host.modelId)) labs.push(host);
    // A depth of -1 on an ordinary host is not a position, so it must not sort
    // above the root of the net.
    else if (host.depth !== undefined && host.depth >= 0) grid.push(host);
    else unknown.push(host);
  }

  // The labyrinth's own depth field is -1, but WHICH labyrinth it is pins the
  // net's depth exactly — that is what `getNetDepth()` returns. Failing both
  // that and a caller-supplied value, one past the deepest host we hold is a
  // floor rather than a fact, and `netDepthGuessed` says so.
  const declared = opts.netDepth ?? netDepthFromLabs(labs.map((host) => host.hostname));
  const observed = grid.reduce((deepest, host) => Math.max(deepest, host.depth!), -1);
  const netDepth = Math.min(LIMIT, Math.max(1, observed + 1, declared ?? 0));
  const netDepthGuessed = declared === undefined;

  const depthOf = new Map<string, number>();
  const gridByName = new Map<string, DarknetKnownHost>();
  for (const host of grid) {
    depthOf.set(host.hostname, host.depth!);
    gridByName.set(host.hostname, host);
  }

  const brokenLaterals = new Set<string>();
  const byDepth = new Map<number, DarknetKnownHost[]>();
  for (const host of grid) {
    const bucket = byDepth.get(host.depth!);
    if (bucket) bucket.push(host);
    else byDepth.set(host.depth!, [host]);
  }
  for (const bucket of byDepth.values()) bucket.sort((a, b) => byName(a.hostname, b.hostname));

  // Lateral adjacency, symmetrised: a claim from either end is a claim, because
  // whichever agent saw it saw it.
  const lateral = new Map<string, string[]>();
  const addLateral = (a: string, b: string) => {
    const list = lateral.get(a);
    if (list) {
      if (!list.includes(b)) list.push(b);
    } else lateral.set(a, [b]);
  };
  for (const host of grid) {
    for (const name of host.neighbours ?? []) {
      if (depthOf.get(name) !== host.depth) continue;
      addLateral(host.hostname, name);
      addLateral(name, host.hostname);
    }
  }
  for (const list of lateral.values()) list.sort(byName);

  const freshness = opts.lateralRank ?? (() => 0);
  const doubt = opts.positionDoubt ?? (() => 0);
  const chainsByDepth = new Map<number, Chain[]>();
  for (const [depth, bucket] of byDepth) {
    chainsByDepth.set(
      depth,
      chainsOf(bucket.map((host) => host.hostname), depth, lateral, freshness, brokenLaterals),
    );
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const column = new Map<string, number>();
  const chunksByDepth = new Map<number, Map<string, number>[]>();

  /** Mean column of a host's vertical neighbours, over the rows this pass is
   * allowed to read. NaN when none of them is seated yet. */
  const anchor = (name: string, depth: number, up: boolean, down: boolean): number => {
    let total = 0;
    let count = 0;
    for (const other of gridByName.get(name)?.neighbours ?? []) {
      const otherDepth = depthOf.get(other);
      if (otherDepth === undefined) continue;
      if (otherDepth === depth - 1 && !up) continue;
      if (otherDepth === depth + 1 && !down) continue;
      if (Math.abs(otherDepth - depth) !== 1) continue;
      const seat = column.get(other);
      if (seat === undefined) continue;
      total += seat;
      count++;
    }
    return count === 0 ? Number.NaN : total / count;
  };

  const solve = (order: readonly number[], up: boolean, down: boolean): void => {
    for (const depth of order) {
      const chains = chainsByDepth.get(depth)!;
      // Resolved ONCE per chain, here, before anything sorts. `orientChain`
      // reverses the chain it picks a reflection for, and calling it from inside
      // a comparator would reverse it an unpredictable number of times and make
      // the layout depend on the sort's internal call order.
      const origins = new Map<Chain, number>();
      for (const chain of chains) {
        origins.set(chain, orientChain(chain, (name) => anchor(name, depth, up, down)));
      }
      const originOf = (chain: Chain): number => origins.get(chain) ?? Number.NaN;
      // Least-doubted chain first, so an overcrowded depth puts its best guesses
      // on the grid and its ghosts on the rows below.
      const trustOf = (chain: Chain): number =>
        chain.members.reduce((worst, name) => Math.max(worst, doubt(name)), 0);
      const chunks = seatChains(chains, originOf, trustOf);
      chunksByDepth.set(depth, chunks);
      for (const chunk of chunks) for (const [name, seat] of chunk) column.set(name, seat);
    }
  };

  // Down, then up, then down. Three fixed passes rather than a convergence loop:
  // unbounded iteration makes the cost depend on the data and can two-cycle
  // between equally good layouts on inputs one stale fact apart. The upward pass
  // earns its place because depth 0 has NO upward anchor once darkweb is
  // excluded, so without it row 0 — and transitively everything below — falls
  // back to hostname order.
  const descending = [...depths].reverse();
  solve(depths, true, false);
  solve(descending, false, true);
  solve(depths, true, true);

  const placed: Placed[] = [];
  const byHost = new Map<string, Placed>();
  const rowLabels: RowLabel[] = [];
  let displayRow = 0;

  const place = (host: DarknetKnownHost, row: number, slot: number, kind: RowKind): void => {
    const entry: Placed = {
      host,
      row,
      slot,
      displayRow,
      kind,
      x: xOf(slot, row, netDepth),
      y: yOf(displayRow),
    };
    placed.push(entry);
    byHost.set(host.hostname, entry);
  };
  const label = (text: string, kind: RowKind, depth?: number): void => {
    rowLabels.push({ y: yOf(displayRow), label: text, kind, ...(depth !== undefined ? { depth } : {}) });
  };

  if (darkweb.length > 0) {
    label("darkweb", "darkweb");
    for (const host of darkweb) place(host, -1, centredSlot(), "darkweb");
    displayRow++;
  }

  // EVERY depth, not just the ones we have seen into. A row we know nothing
  // about is the most important thing on an explorer's map, and collapsing it
  // makes a net we have barely touched look fully surveyed.
  for (let depth = 0; depth < netDepth; depth++) {
    const bucket = byDepth.get(depth) ?? [];
    const gap = isOnAirGap(depth);
    if (bucket.length === 0) {
      label(gap ? `depth ${depth} · air gap` : `depth ${depth}`, gap ? "airgap" : "depth", depth);
      displayRow++;
      continue;
    }
    const chunks = chunksByDepth.get(depth) ?? [];
    const total = bucket.length;
    chunks.forEach((chunk, index) => {
      const suffix = gap
        // A host on an air gap is either a game change or a hole in our model of
        // it, and both are worth hearing about rather than drawing quietly.
        ? ` · air gap (${total}!?)`
        : total > WIDTH
          // More than the board is wide cannot be true at once. Say the number.
          ? ` (${total} held, ${WIDTH} fit)`
          : "";
      label(index === 0 ? `depth ${depth}${suffix}` : "", gap ? "airgap" : "depth", depth);
      for (const [name, seat] of [...chunk].sort((a, b) => a[1] - b[1])) {
        const host = gridByName.get(name);
        if (host) place(host, depth, seat, gap ? "airgap" : "depth");
      }
      displayRow++;
    });
  }

  // A floor drawn as an extent is the "fully surveyed" lie the every-depth loop
  // above exists to prevent, one level up: with no labyrinth sighting `netDepth`
  // is only one past the deepest host we hold, so the bottom grid row IS the
  // deepest thing we have seen and there is not even an empty row past it.
  // `netDepthGuessed` said so all along and nothing drew it.
  //
  // Emitted here rather than in `netMap` so `height`, the row keys and the
  // gutter all follow from the same `displayRow` counter — a row drawn at
  // `yOf(displayRow)` after the layout returned sits past the viewBox and is
  // silently clipped, which is the bug the `MAP_W` stagger note records.
  //
  // Two conditions, because either one would make the hedge a false claim: a
  // drawn labyrinth already marks the bottom (`isLabyrinth` also matches on the
  // model id, so an unlisted lab host puts a lab row below us while leaving
  // `declared` undefined), and at `LIMIT` there is no deeper for the net to go.
  if (netDepthGuessed && labs.length === 0 && netDepth < LIMIT) {
    label(`depth ≥ ${netDepth} · no labyrinth sighted, so this is a floor`, "floor");
    displayRow++;
  }

  // The goal, pinned to the bottom where upstream draws it. Its own reported
  // depth is -1 for all eight of them, so depth is exactly the wrong thing to
  // sort it by; charisma is the ladder's real order.
  if (labs.length > 0) {
    const ordered = [...labs].sort((a, b) =>
      (labStage(a.hostname)?.cha ?? 0) - (labStage(b.hostname)?.cha ?? 0) || byName(a.hostname, b.hostname)
    );
    label("the labyrinth", "labyrinth");
    ordered.forEach((host, index) =>
      place(host, netDepth, centredSlot() + index - (ordered.length - 1) / 2, "labyrinth")
    );
    displayRow++;
  }

  if (unknown.length > 0) {
    const sorted = [...unknown].sort((a, b) => byName(a.hostname, b.hostname));
    for (let i = 0; i < sorted.length; i += WIDTH) {
      label(i === 0 ? "depth unknown" : "", "unknown");
      sorted.slice(i, i + WIDTH).forEach((host, slot) => place(host, Number.NaN, slot, "unknown"));
      displayRow++;
    }
  }

  return {
    placed,
    byHost,
    rowLabels,
    height: PAD * 2 + Math.max(1, displayRow) * ROW_PITCH - ROW_GAP,
    unplaced: unknown.length,
    brokenLaterals,
    netDepth,
    netDepthGuessed,
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

/** Every auth state, in the words the map and the table both use.
 *
 * Keyed by the UNION rather than by `string`, and exported, because this was
 * enumerated twice — once here and once inline in the servers table — and the
 * second copy had drifted. A total record fails the build if the union grows
 * and this does not. */
export const AUTH_LABEL: Record<NonNullable<DarknetKnownHost["authState"]>, string> = {
  session: "● session",
  authenticated: "[ authenticated ]",
  "auth-required": "[ auth required ]",
  "no-connection": "(no connection)",
};

/** How old one published fact is, and what is left of its life.
 *
 * Derived here rather than shipped: the digest carries an observation time per
 * fact and nothing else. It calls the CONTROLLER's own `staleness` rather than
 * repeating the arithmetic, because a panel that could disagree with the
 * decision about what is stale would be worse than one that showed nothing.
 * `staleness` reads only `at`, so the value is a placeholder.
 *
 * Nothing ages any more: a fact is perishable when a mutation can invalidate
 * it, and it is stale exactly when a mutation HAS — the dirty bit, and nothing
 * about the clock. `expiresInMs` is therefore always Infinity; the age is kept
 * because the tooltip still says how long ago we looked. */
export function factLife(
  host: DarknetKnownHost,
  key: string,
  now: number,
  _expiry: ExpiryOpts,
): Staleness | undefined {
  const at = host.facts[key];
  if (at === undefined) return undefined;
  const group = fieldGroup(key);
  if (group === undefined) return undefined;
  return {
    ageMs: Math.max(0, now - at),
    expiresInMs: Infinity,
    stale: group !== "identity" && host.dirty?.[group] === true,
  };
}

/** True when nothing PERISHABLE we hold about this host is still believable.
 * Drawn faded, because "we believed this before the last mutation" and "this is
 * true" must not look the same.
 *
 * Only the facts a mutation can invalidate get a vote. Identity fields cannot
 * change while the host lives, so a host holding only those has nothing to
 * disbelieve and is not faded — the same answer as a host holding no facts at
 * all. This used to be `every` over ALL facts including identity, which no host
 * on the wire could satisfy, so the fade was unreachable and every box on the
 * map read confirmed. */
export function isStale(host: DarknetKnownHost, _now: number, _expiry: ExpiryOpts): boolean {
  const perishable = Object.keys(host.facts)
    .map((key) => fieldGroup(key))
    .filter((group): group is Exclude<ReturnType<typeof fieldGroup>, "identity" | undefined> =>
      group !== undefined && group !== "identity");
  if (perishable.length === 0) return false;
  return perishable.every((group) => host.dirty?.[group] === true);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Everything a box says, as a plain-text tooltip. Colour is never the only
 * channel: every state also has a status line and this. */
function titleOf(host: DarknetKnownHost, options: MapOptions): string {
  const parts = [host.hostname];
  parts.push(AUTH_LABEL[host.authState ?? "no-connection"] ?? "");
  const entry = modelEntry(host.modelId);
  if (host.modelId) parts.push(`model ${host.modelId}${entry ? ` (${entry.name})` : ""}`);
  if (entry?.blocked !== undefined) parts.push(entry.blocked);
  const ram = ramBuckets(host);
  if (ram) {
    parts.push(
      ram.used === undefined || ram.unused === undefined
        ? `RAM ${fmtRam(ram.total)} total, ${fmtRam(ram.blocked)} blocked`
        : `RAM ${fmtRam(ram.total)} total, ${fmtRam(ram.blocked)} blocked, ${fmtRam(ram.used)} used, ${fmtRam(ram.unused)} unused`,
    );
  }
  if (host.requiredCharisma !== undefined) parts.push(`charisma ${fmtNum(host.requiredCharisma, 0)}`);
  if (host.agent) {
    const visual = jobVisual(host.agent.active);
    const targets = host.agent.targets;
    parts.push(
      host.agent.alive
        ? `resident standing here${host.agent.active ? `, running ${visual.label}` : ", ready"}${
          host.agent.pending ? `, ${host.agent.pending} queued` : ""
        }`
        : "resident lost",
    );
    if (targets.length > 0) parts.push(`targets ${targets.join(", ")}`);
    const r = host.agent.ram;
    parts.push(
      `dnet RAM ${fmtRamExact(dnetRamGb(r))} total, ${fmtRamExact(r.jobGb)} job, ${fmtRamExact(r.proberGb)} prober, ${fmtRamExact(r.controllerGb)} controller`,
    );
  }
  const why = host.agent === undefined ? options.why?.[host.hostname] : undefined;
  if (why !== undefined) parts.push(`not planted — ${why}`);
  if (isStale(host, options.now, options.expiry)) {
    parts.push("stale — one or more observations are no longer confirmed");
  }
  return parts.filter(Boolean).join(" · ");
}

export interface RamBuckets {
  total: number;
  blocked: number;
  used?: number;
  unused?: number;
}

/** Keep durable capacity distinct from a volatile runtime-occupancy sample. */
export function ramBuckets(host: DarknetKnownHost): RamBuckets | undefined {
  if (host.ram !== undefined) {
    const total = Math.max(0, host.ram.total);
    const blocked = Math.max(0, Math.min(host.ram.blocked, total));
    const used = Math.max(0, Math.min(host.ram.used, total - blocked));
    return { total, blocked, used, unused: Math.max(0, total - blocked - used) };
  }
  if (host.maxRam === undefined) return undefined;
  const total = Math.max(0, host.maxRam);
  const blocked = Math.max(0, Math.min(host.blockedRam ?? 0, total));
  return { total, blocked };
}

function compactRam(gb: number): string {
  if (gb >= 1e6) return `${(gb / 1e6).toFixed(1)}P`;
  if (gb >= 1e3) return `${(gb / 1e3).toFixed(1)}T`;
  return gb.toFixed(gb < 10 && !Number.isInteger(gb) ? 2 : 0).replace(/\.0+$/, '');
}

function ramBar(host: DarknetKnownHost, x: number, y: number): string {
  const ram = ramBuckets(host);
  if (!ram || ram.total <= 0) return "";
  const width = BOX_W - 16;
  const w = (value: number) => Math.max(0, (value / ram.total) * width);
  if (ram.used === undefined || ram.unused === undefined) {
    const availableW = w(Math.max(0, ram.total - ram.blocked));
    return (
      `<rect class="ram unknown ram-unknown" x="${x}" y="${y}" width="${availableW.toFixed(1)}" height="4"></rect>`
      + `<rect class="ram blocked ram-blocked" x="${(x + availableW).toFixed(1)}" y="${y}" width="${w(ram.blocked).toFixed(1)}" height="4"></rect>`
    );
  }
  const usedW = w(ram.used ?? 0);
  const unusedW = w(ram.unused ?? Math.max(0, ram.total - ram.blocked));
  const blockedW = w(ram.blocked);
  return (
    `<rect class="ram used ram-used" x="${x}" y="${y}" width="${usedW.toFixed(1)}" height="4"></rect>`
    + `<rect class="ram unused ram-unused" x="${(x + usedW).toFixed(1)}" y="${y}" width="${unusedW.toFixed(1)}" height="4"></rect>`
    + `<rect class="ram blocked ram-blocked" x="${(x + usedW + unusedW).toFixed(1)}" y="${y}" width="${blockedW.toFixed(1)}" height="4"></rect>`
  );
}

interface RenderOptions extends MapOptions {
  focusNeighbours?: ReadonlySet<string>;
}

function nodeMarkup(entry: Placed, options: RenderOptions): string {
  const { selected, query } = options;
  const { host, x, y } = entry;
  const classes = ["node", `auth-${host.authState ?? "no-connection"}`];
  if (isStale(host, options.now, options.expiry)) classes.push("stale");
  if (host.hostname === selected) classes.push("sel");
  if (options.focusNeighbours?.has(host.hostname)) classes.push("neighbour");
  if (options.focusNeighbours !== undefined
    && host.hostname !== options.focus
    && !options.focusNeighbours.has(host.hostname)) classes.push("unrelated");
  if (query) classes.push(matches(host, query) ? "hit" : "dim");

  const glyph = FAMILY_GLYPH[modelEntry(host.modelId)?.family ?? "oracle"] ?? "?";
  const meta = host.requiredCharisma !== undefined ? `cha:${fmtNum(host.requiredCharisma, 0)}` : "";
  const status = AUTH_LABEL[host.authState ?? "no-connection"] ?? "";
  const buckets = ramBuckets(host);
  const ram = buckets === undefined
    ? ""
    : buckets.used === undefined || buckets.unused === undefined
      ? `T/B ${compactRam(buckets.total)}/${compactRam(buckets.blocked)}`
      : `T/B/U/- ${compactRam(buckets.total)}/${compactRam(buckets.blocked)}/${compactRam(buckets.used)}/${compactRam(buckets.unused)}`;
  const visual = jobVisual(host.agent?.active);
  const jobRam = host.agent?.ram.jobGb;
  const jobText = host.agent === undefined
    ? ""
    : !host.agent.alive
      ? "lost"
      : `${visual.label}${jobRam !== undefined ? ` · ${compactRam(jobRam)}G` : ""}`;

  return (
    // data-view-key is the whole selection mechanism: main.ts's delegated
    // handler resolves `closest()` on SVG elements and SVGElement carries
    // `.dataset`, so no listener is needed and main.ts needs no change.
    //
    // And no ARIA role on the group. It used to carry `role="button"`, which
    // promised a keyboard affordance the map does not have: main.ts delegates
    // click and nothing else, and there is no tabindex, so the role advertised
    // something no key could reach. The accessible route to selection is the
    // real button in the servers table's host column; the SVG stays a picture
    // (`role="img"` on the svg) with that table as its equivalent.
    `<g class="${classes.join(" ")}" data-key="node:${esc(host.hostname)}"`
    + ` data-view-key="dnet.sel" data-view-value="${esc(host.hostname)}">`
    + `<title>${esc(titleOf(host, options))}</title>`
    + `<rect class="box" x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="2"></rect>`
    + (host.stasisLinked ? `<rect class="stasis" x="${x}" y="${y}" width="3" height="${BOX_H}"></rect>` : "")
    + (host.isStationary ? `<text class="fixed" x="${x + BOX_W - 6}" y="${y + 14}">#</text>` : "")
    // Where our residents are standing — the core exploration question. A solid
    // dot is a live one; a hollow dot marks where one died, which is the map's
    // own read on WHERE the mutation clock is killing them.
    + (host.agent
      ? `<circle class="agentdot ${visual.className}${host.agent.alive ? "" : " dead"}"`
        + ` cx="${x + 9}" cy="${y + 75}" r="3"></circle>`
        + `<text class="jobtext ${visual.className}${host.agent.alive ? "" : " dead"}"`
        + ` x="${x + 16}" y="${y + 78}">${esc(jobText)}</text>`
      : "")
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
    || (host.modelId ?? "").toLowerCase().includes(needle)
    || (modelEntry(host.modelId)?.name ?? "").toLowerCase().includes(needle)
    || (host.passwordHint ?? "").toLowerCase().includes(needle)
  );
}

/** Curved topology routes with stable, distributed node ports. Spreading each
 * host's endpoints keeps dense views legible instead of merging every link at
 * the node centre. */
type PortSide = "top" | "right" | "bottom" | "left";
interface Port { x: number; y: number; nx: number; ny: number }
interface TopologyEdge { key: string; a: Placed; b: Placed; classes: string[] }

function sideTowards(from: Placed, to: Placed): PortSide {
  const dx = (to.x + BOX_W / 2) - (from.x + BOX_W / 2);
  const dy = (to.y + BOX_H / 2) - (from.y + BOX_H / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function portAt(entry: Placed, side: PortSide, fraction: number): Port {
  switch (side) {
    case "top": return { x: entry.x + BOX_W * fraction, y: entry.y, nx: 0, ny: -1 };
    case "right": return { x: entry.x + BOX_W, y: entry.y + BOX_H * fraction, nx: 1, ny: 0 };
    case "bottom": return { x: entry.x + BOX_W * fraction, y: entry.y + BOX_H, nx: 0, ny: 1 };
    case "left": return { x: entry.x, y: entry.y + BOX_H * fraction, nx: -1, ny: 0 };
  }
}

function curveBetween(a: Port, b: Port): string {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.min(72, Math.max(18, distance * 0.32));
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C `
    + `${(a.x + a.nx * reach).toFixed(1)} ${(a.y + a.ny * reach).toFixed(1)}, `
    + `${(b.x + b.nx * reach).toFixed(1)} ${(b.y + b.ny * reach).toFixed(1)}, `
    + `${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

function topologyEdges(layout: NetLayout, options: MapOptions): TopologyEdge[] {
  const focus = options.focus;
  const seen = new Set<string>();
  const edges: TopologyEdge[] = [];
  for (const from of layout.placed) {
    for (const name of from.host.neighbours ?? []) {
      const to = layout.byHost.get(name);
      if (!to) continue;
      const key = edgeKey(from.host.hostname, name);
      if (seen.has(key)) continue;
      seen.add(key);
      const sameRow = from.row === to.row && Number.isFinite(from.row);
      const broken = layout.brokenLaterals.has(key);
      const tree = Math.abs(from.row - to.row) === 1 && from.y !== to.y;
      if (!broken && (options.edges === "none" || (options.edges === "tree" && !(tree || sameRow)))) continue;
      const classes = ["edge", tree ? "tree" : sameRow ? "lateral" : "back"];
      if (broken) classes.push("broken");
      const edgeStale = (host: DarknetKnownHost) =>
        factLife(host, "neighbours", options.now, options.expiry)?.stale === true;
      if (edgeStale(from.host) || edgeStale(to.host)) classes.push("stale");
      if (focus) {
        if (from.host.hostname === focus || to.host.hostname === focus) classes.push("focused");
        else classes.push("context");
      }
      edges.push({ key, a: from, b: to, classes });
    }
  }
  return edges.sort((a, b) => byName(a.key, b.key));
}

/** Distinct deterministic ports stop several links from becoming one line at a
 * node boundary. The opposite endpoint orders the ports, so input order cannot
 * make the map shimmer. */
function topologyPorts(edges: readonly TopologyEdge[]): Map<string, Port> {
  const groups = new Map<string, { edge: TopologyEdge; here: Placed; other: Placed }[]>();
  for (const edge of edges) {
    for (const [here, other] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {
      const side = sideTowards(here, other);
      const group = `${here.host.hostname}\0${side}`;
      const entries = groups.get(group) ?? [];
      entries.push({ edge, here, other });
      groups.set(group, entries);
    }
  }
  const ports = new Map<string, Port>();
  for (const entries of groups.values()) {
    entries.sort((a, b) => byName(a.other.host.hostname, b.other.host.hostname));
    entries.forEach(({ edge, here, other }, index) => {
      ports.set(`${edge.key}\0${here.host.hostname}`, portAt(here, sideTowards(here, other), (index + 1) / (entries.length + 1)));
    });
  }
  return ports;
}

function edgeMarkup(layout: NetLayout, options: MapOptions): string {
  const edges = topologyEdges(layout, options);
  const ports = topologyPorts(edges);
  return edges.map((edge) => {
    const a = ports.get(`${edge.key}\0${edge.a.host.hostname}`)!;
    const b = ports.get(`${edge.key}\0${edge.b.host.hostname}`)!;
    return `<path class="${edge.classes.join(" ")}" data-key="edge:${esc(edge.key)}" d="${curveBetween(a, b)}">`
      + `<title>${esc(`${edge.a.host.hostname} ↔ ${edge.b.host.hostname}`)}</title></path>`;
  }).join("");
}

function arrowPoints(tip: Port): string {
  const bx = tip.x + tip.nx * 7;
  const by = tip.y + tip.ny * 7;
  const px = -tip.ny * 3.5;
  const py = tip.nx * 3.5;
  return `${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${(bx + px).toFixed(1)},${(by + py).toFixed(1)} ${(bx - px).toFixed(1)},${(by - py).toFixed(1)}`;
}

function workEdgeMarkup(layout: NetLayout, options: MapOptions): string {
  const mode = options.jobs;
  if (mode === "none") return "";
  const parts: string[] = [];
  for (const source of layout.placed) {
    const agent = source.host.agent;
    if (!agent?.alive || !agent.active || agent.targets.length === 0) continue;
    if (mode === "selected" && source.host.hostname !== options.selected) continue;
    const visual = jobVisual(agent.active);
    for (const targetName of [...new Set(agent.targets)].sort(byName)) {
      const target = layout.byHost.get(targetName);
      if (!target) continue;
      const key = `job:${source.host.hostname}>${targetName}:${agent.active}`;
      const title = `${visual.label}: ${source.host.hostname} → ${targetName}`
        + ` · ${fmtRamExact(agent.ram.jobGb)} job RAM`;
      if (targetName === source.host.hostname) {
        const right = source.x + BOX_W;
        const startY = source.y + BOX_H * 0.32;
        const end = { x: right, y: source.y + BOX_H * 0.68, nx: 1, ny: 0 };
        const d = `M ${right} ${startY.toFixed(1)} C ${right + 15} ${startY.toFixed(1)}, ${right + 15} ${end.y.toFixed(1)}, ${right + 7} ${end.y.toFixed(1)}`;
        parts.push(`<g class="jobroute ${visual.className}" data-key="${esc(key)}"><title>${esc(title)}</title>`
          + `<path class="jobedge ${visual.className}" d="${d}"></path>`
          + `<polygon class="jobarrow ${visual.className}" points="${arrowPoints(end)}"></polygon></g>`);
        continue;
      }
      const a = portAt(source, sideTowards(source, target), 0.5);
      const tip = portAt(target, sideTowards(target, source), 0.5);
      const end = { ...tip, x: tip.x + tip.nx * 7, y: tip.y + tip.ny * 7 };
      parts.push(`<g class="jobroute ${visual.className}" data-key="${esc(key)}"><title>${esc(title)}</title>`
        + `<path class="jobedge ${visual.className}" d="${curveBetween(a, end)}"></path>`
        + `<polygon class="jobarrow ${visual.className}" points="${arrowPoints(tip)}"></polygon></g>`);
    }
  }
  return parts.join("");
}

/** The legend, built from the same tables that drive the glyphs and the borders
 * so the two can never drift apart. */
export function netLegend(): string {
  const swatch = (cls: string, label: string) =>
    `<span class="netkey"><span class="sw ${cls}"></span>${esc(label)}</span>`;
  const line = (cls: string, label: string) =>
    `<span class="netkey"><span class="ln ${cls}"></span>${esc(label)}</span>`;
  const glyphs = Object.entries(FAMILY_GLYPH)
    .map(([family, glyph]) => `<span class="netkey"><span class="gl">${esc(glyph)}</span>${esc(family)}</span>`)
    .join("");
  const jobs = TASK_KINDS
    .map((kind) => `<span class="netkey"><span class="jobkey ${JOB_VISUALS[kind].className}">●</span>${esc(JOB_VISUALS[kind].label)}</span>`)
    .join("");
  return (
    `<div class="netlegend">`
    + swatch("auth-session", "session")
    + swatch("auth-authenticated", "cracked")
    + swatch("auth-auth-required", "auth required")
    + swatch("auth-no-connection", "no connection")
    // `stasis`, not `linked`: the node draws a left bar (`<rect class="stasis">`)
    // and never carried a `linked` class that anything styled, so the swatch was
    // describing a class the map does not render.
    + swatch("stasis", "stasis")
    // "perishable", not "every fact": identity facts never expire, so the fade
    // is a statement about position, topology and RAM going unconfirmed. Same
    // word as the servers table's chip, deliberately — the table and the map
    // must not describe two different conditions.
    + swatch("stale", "faded = stale: perishable facts expired")
    + `</div>`
    + `<div class="netlegend">`
    + swatch("ram-used", "RAM: used by our scripts")
    + swatch("ram-unused", "RAM: unused")
    + swatch("ram-blocked", "RAM: owner-blocked")
    + swatch("ram-unknown", "RAM: occupancy not sampled")
    + `</div>`
    // The edge vocabulary, which had no key at all — including the one edge that
    // means our own knowledge is wrong.
    + `<div class="netlegend">`
    + line("tree", "parent link")
    + line("lateral", "same row, adjacent columns")
    + line("back", "longer link")
    + line("broken", "contradiction — cannot both be true")
    + `<span class="netkey"><span class="gl">#</span>never moves</span>`
    + `<span class="netkey"><span class="gl agentkey">●</span>resident standing here (hollow = lost)</span>`
    + `</div><div class="netlegend">${glyphs}</div>`
    + `<div class="netlegend">${jobs}</div>`
  );
}

export interface MapOptions {
  selected: string;
  /** Explicit operator selection used for topology focus. Empty means the
   * stable fallback selection must not dim the whole map. */
  focus: string;
  query: string;
  zoom: number;
  edges: string;
  jobs: string;
  /** The digest's own clock, which every age on this page is measured against. */
  now: number;
  expiry: ExpiryOpts;
  /** The net's true depth when the topic knows it, so the map can draw the rows
   *  we have never reached as well as the ones we have. */
  netDepth?: number;
  /** Why each still-empty host was not planted, by hostname, straight from the
   *  spread planner. The rollup below the map counts reasons; this answers the
   *  question you actually have while looking at a green box with no scripts
   *  in it. */
  why?: Record<string, string>;
}

/** The row gutter: one label per display row, plus a rule across the rows that
 * hold nothing.
 *
 * An empty grid row and an air gap are drawn differently on purpose. One says
 * "we have never looked here", the other says "nothing can be here" — and on an
 * explorer's map those are the two most different statements there are.
 *
 * Keyed, like everything else: forty labels re-emitted at 2 Hz is exactly what
 * `morph`'s keys exist to avoid. */
function rowMarkup(layout: NetLayout): string {
  const occupied = new Set(layout.placed.map((entry) => entry.displayRow));
  // An overflowing depth produces several rows that share a depth, so the depth
  // alone is not a key. The ordinal is the chunk number, which is as stable as
  // the depth is and keeps morph moving these rather than rebuilding them.
  const seen = new Map<string, number>();
  return layout.rowLabels
    .map((row, index) => {
      const base = `row:${row.kind}:${row.depth ?? index}`;
      const ordinal = seen.get(base) ?? 0;
      seen.set(base, ordinal + 1);
      const key = ordinal === 0 ? base : `${base}:${ordinal}`;
      const empty = !occupied.has(index);
      const label = row.label.length === 0
        ? ""
        : `<text class="rowlabel ${row.kind}" x="2" y="${row.y + 12}">${esc(row.label)}</text>`;
      // A rule only where there is nothing to draw, so it reads as the absence
      // it marks rather than as decoration behind the boxes.
      const rule = empty
        ? `<line class="rowrule ${row.kind}" data-key="${esc(key)}:rule"`
          + ` x1="${PAD_X}" y1="${row.y + BOX_H / 2}" x2="${MAP_W - PAD}" y2="${row.y + BOX_H / 2}"></line>`
        : "";
      return `<g class="rowmark" data-key="${esc(key)}">${rule}${label}</g>`;
    })
    .join("");
}

/** The whole map as one SVG string. */
export function netMap(hosts: readonly DarknetKnownHost[], options: MapOptions): string {
  const known = new Map(hosts.map((host) => [host.hostname, host]));
  const layout = layoutNet(hosts, {
    ...(options.netDepth !== undefined ? { netDepth: options.netDepth } : {}),
    lateralRank: (a, b) => {
      // Fresher claims win when two cannot both be true. Both ends are consulted
      // because either agent's sighting is a sighting.
      const stale = (name: string) => {
        const host = known.get(name);
        return host && factLife(host, "neighbours", options.now, options.expiry)?.stale === true ? 1 : 0;
      };
      return stale(a) + stale(b);
    },
    positionDoubt: (hostname) => {
      const host = known.get(hostname);
      if (!host) return 3;
      // A host whose depth we no longer believe sinks below a confirmed one;
      // one we have never placed sinks below both.
      const life = factLife(host, "depth", options.now, options.expiry);
      if (life === undefined) return 2;
      return life.stale ? 1 : 0;
    },
  });
  const scale = options.zoom / 100;
  const focusNeighbours = options.focus ? new Set<string>() : undefined;
  if (focusNeighbours !== undefined) {
    for (const host of hosts) {
      if (host.hostname === options.focus) {
        for (const name of host.neighbours ?? []) if (layout.byHost.has(name)) focusNeighbours.add(name);
      } else if (host.neighbours?.includes(options.focus)) {
        focusNeighbours.add(host.hostname);
      }
    }
  }
  const renderOptions: RenderOptions = focusNeighbours === undefined
    ? options
    : { ...options, focusNeighbours };

  return (
    `<div class="netmap-scroll zoom-${options.zoom}">`
    // viewBox is CONSTANT and only width/height change, so zoom is two patched
    // attributes and SVG scales the text and strokes for free.
    + `<svg class="netmap" role="img"`
    // "at least N" when the depth is a floor: the one-sentence label is the whole
    // map for a screen reader, so it must not be the one place that states an
    // inference as a fact.
    + ` aria-label="darknet map, ${hosts.length} hosts over ${
      layout.netDepthGuessed ? `at least ${layout.netDepth}` : layout.netDepth
    } depths"`
    + ` viewBox="0 0 ${MAP_W} ${layout.height}"`
    + ` width="${Math.round(MAP_W * scale)}" height="${Math.round(layout.height * scale)}">`
    + rowMarkup(layout)
    + edgeMarkup(layout, renderOptions)
    + workEdgeMarkup(layout, renderOptions)
    + layout.placed.map((entry) => nodeMarkup(entry, renderOptions)).join("")
    + `</svg></div>`
  );
}

/** Read the map's view controls. Kept beside the renderer so the keys are
 * declared once. */
export function mapOptions(
  now: number,
  expiry: ExpiryOpts,
  netDepth?: number,
  why?: Record<string, string>,
): MapOptions {
  return {
    now,
    expiry,
    ...(netDepth !== undefined ? { netDepth } : {}),
    ...(why !== undefined ? { why } : {}),
    selected: view("dnet.sel"),
    focus: view("dnet.sel"),
    query: view("dnet.q").trim(),
    zoom: Number(view("dnet.zoom", "100")) || 100,
    // Laterals are the layout's only hard evidence now, so hiding them by
    // default made a correctly-constrained row look arbitrary. "tree" keeps
    // parent links AND laterals; only the long back edges are dropped.
    edges: view("dnet.edges", "tree"),
    jobs: view("dnet.jobs", "all"),
  };
}

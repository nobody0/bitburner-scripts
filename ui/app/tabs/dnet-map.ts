import { staleness, type ExpiryOpts, type Staleness } from "../../../shared/strategy/dnet/knowledge.ts";
import { modelEntry } from "../../../shared/strategy/dnet/models.ts";
import {
  isLabyrinth,
  isOnAirGap,
  labStage,
  netDepthFromLabs,
  MAX_NET_DEPTH as LIMIT,
  NET_WIDTH as WIDTH,
} from "../../../shared/strategy/dnet/rates.ts";
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
export const BOX_H = 68;
const COL_GAP = 29;
const ROW_GAP = 63;
/** Left inset. The row labels live in this gutter — at a smaller pad they were
 * drawn over the leftmost box of every row. */
const PAD_X = 54;
const PAD = 12;
export const COL_PITCH = BOX_W + COL_GAP;
export const ROW_PITCH = BOX_H + ROW_GAP;

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
 * second copy was missing `offline`. A total record fails the build if the union
 * grows and this does not, which is the only version of this that stays true. */
export const AUTH_LABEL: Record<NonNullable<DarknetKnownHost["authState"]>, string> = {
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

/** True when nothing PERISHABLE we hold about this host is still believable.
 * Drawn faded, because "we believed this five minutes ago" and "this is true"
 * must not look the same on a net that rewires itself every few seconds.
 *
 * Only the facts that CAN expire get a vote, and this used to be `every` over
 * ALL of them — which no host on the wire could ever satisfy. `describeHost`
 * sends the identity fields (modelId, difficulty, maxRam, the password shape)
 * alongside depth and RAM on every report, `expiryMs("identity")` is `Infinity`,
 * so one never-expiring fact per host held the fade off permanently: the node
 * opacity, this tooltip line, the legend swatch, the servers-table chip and the
 * `stale` filter were all unreachable, and every box on the map read confirmed.
 *
 * The test is "cannot expire" rather than a list of fact classes on purpose.
 * `position` is also eternal on a stationary or stasis-linked host, and `expiryMs`
 * is where that rule lives; a class list here would re-state it and then drift
 * from it. A host holding only eternal facts has nothing to disbelieve, so it is
 * not faded — the same answer as a host holding no facts at all. */
export function isStale(host: DarknetKnownHost, now: number, expiry: ExpiryOpts): boolean {
  const keys = Object.keys(host.facts);
  if (keys.length === 0) return false;
  const perishable = keys
    .map((key) => factLife(host, key, now, expiry))
    .filter((life) => life !== undefined && life.expiresInMs !== Infinity);
  if (perishable.length === 0) return false;
  return perishable.every((life) => life?.stale === true);
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
    parts.push(`RAM ${fmtRam(ram.ours)} ours, ${fmtRam(ram.free)} free, ${fmtRam(ram.blocked)} blocked of ${fmtRam(ram.max)}`);
  }
  if (host.requiredCharisma !== undefined) parts.push(`charisma ${fmtNum(host.requiredCharisma, 0)}`);
  if (host.agent) {
    parts.push(
      host.agent.alive
        ? `resident standing here${host.agent.active ? `, running ${host.agent.active}` : ""}${
          host.agent.pending ? `, ${host.agent.pending} queued` : ""
        }`
        : "resident lost",
    );
  }
  if (host.goneAt !== undefined) parts.push("gone");
  if (isStale(host, options.now, options.expiry)) {
    parts.push("stale — position and topology believed, not confirmed");
  }
  return parts.filter(Boolean).join(" · ");
}

export interface RamBuckets {
  max: number;
  ours: number;
  free: number;
  blocked: number;
}

/** Split capacity into the three buckets the player can act on. The game's
 * raw usedRam includes owner-blocked RAM, so deriving ours from the centrally
 * normalised freeRam is the only representation that does not double-count. */
export function ramBuckets(host: DarknetKnownHost): RamBuckets | undefined {
  if (host.maxRam === undefined) return undefined;
  const max = Math.max(0, host.maxRam);
  const blocked = Math.max(0, Math.min(host.blockedRam ?? 0, max));
  const free = Math.max(0, Math.min(host.freeRam ?? 0, max - blocked));
  return { max, ours: Math.max(0, max - blocked - free), free, blocked };
}

function compactRam(gb: number): string {
  if (gb >= 1e6) return `${(gb / 1e6).toFixed(1)}P`;
  if (gb >= 1e3) return `${(gb / 1e3).toFixed(1)}T`;
  return gb.toFixed(gb < 10 && !Number.isInteger(gb) ? 2 : 0).replace(/\.0+$/, '');
}

function ramBar(host: DarknetKnownHost, x: number, y: number): string {
  const ram = ramBuckets(host);
  if (!ram || ram.max <= 0) return "";
  const width = BOX_W - 16;
  const w = (value: number) => Math.max(0, (value / ram.max) * width);
  const oursW = w(ram.ours);
  const freeW = w(ram.free);
  const blockedW = w(ram.blocked);
  return (
    `<rect class="ram ours ram-ours" x="${x}" y="${y}" width="${oursW.toFixed(1)}" height="4"></rect>`
    + `<rect class="ram free ram-free" x="${(x + oursW).toFixed(1)}" y="${y}" width="${freeW.toFixed(1)}" height="4"></rect>`
    + `<rect class="ram blocked ram-blocked" x="${(x + oursW + freeW).toFixed(1)}" y="${y}" width="${blockedW.toFixed(1)}" height="4"></rect>`
  );
}

function nodeMarkup(entry: Placed, options: MapOptions): string {
  const { selected, query } = options;
  const { host, x, y } = entry;
  const classes = ["node", `auth-${host.authState ?? "no-connection"}`];
  if (host.goneAt !== undefined) classes.push("gone");
  if (isStale(host, options.now, options.expiry)) classes.push("stale");
  if (host.hostname === selected) classes.push("sel");
  if (query) classes.push(matches(host, query) ? "hit" : "dim");

  const glyph = FAMILY_GLYPH[modelEntry(host.modelId)?.family ?? "oracle"] ?? "?";
  const meta = host.requiredCharisma !== undefined ? `cha:${fmtNum(host.requiredCharisma, 0)}` : "";
  const status = AUTH_LABEL[host.authState ?? "no-connection"] ?? "";
  const buckets = ramBuckets(host);
  const ram = buckets === undefined
    ? ""
    : `O/F/B ${compactRam(buckets.ours)}/${compactRam(buckets.free)}/${compactRam(buckets.blocked)}`;

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
      ? `<circle class="agentdot${host.agent.alive ? "" : " dead"}"`
        + ` cx="${x + BOX_W - 9}" cy="${y + BOX_H - 9}" r="3"></circle>`
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

/** Edges.
 *
 * A LATERAL edge is now the layout's only hard evidence, and once the two hosts
 * are seated in neighbouring columns it draws as what it is: a short straight
 * link across the gap between them. It used to dip into the row gutter along
 * with everything else, which was the right call when the two ends could be
 * anywhere on the row and is the wrong one now.
 *
 * Everything else routes orthogonally through the gutter. Straight diagonals are
 * what the game draws, but the game has a 6000px canvas to draw them on; at
 * panel scale they cross into noise. */
function edgeMarkup(layout: NetLayout, options: MapOptions): string {
  const mode = options.edges;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const from of layout.placed) {
    for (const name of from.host.neighbours ?? []) {
      const to = layout.byHost.get(name);
      if (!to) continue;
      // One line per pair: adjacency is reported from both ends, and drawing it
      // twice doubles the stroke and makes an ordinary edge look emphasised.
      const key = edgeKey(from.host.hostname, name);
      if (seen.has(key)) continue;
      seen.add(key);

      const sameRow = from.row === to.row && Number.isFinite(from.row);
      const broken = layout.brokenLaterals.has(key);
      const tree = Math.abs(from.row - to.row) === 1 && from.y !== to.y;
      // A demoted lateral is drawn WHATEVER the mode says. It is the one edge
      // that explains why a row looks the way it does — our own knowledge
      // contradicting itself — and hiding it leaves the reader with an odd
      // layout and no reason for it.
      if (!broken) {
        if (mode === "none") continue;
        if (mode === "tree" && !(tree || sameRow)) continue;
      }

      const down = to.y > from.y;
      const [a, b] = down ? [from, to] : [to, from];
      const classes = ["edge", tree ? "tree" : sameRow ? "lateral" : "back"];
      if (broken) classes.push("broken");
      const edgeStale = (host: DarknetKnownHost) =>
        factLife(host, "neighbours", options.now, options.expiry)?.stale === true;
      if (edgeStale(a.host) || edgeStale(b.host)) classes.push("stale");

      let path: string;
      if (a.y === b.y && Math.abs(a.slot - b.slot) === 1 && !broken) {
        // Seated side by side, so the link is the gap itself: straight across at
        // mid-height, between the two facing edges.
        const [left, right] = a.x < b.x ? [a, b] : [b, a];
        const mid = a.y + BOX_H / 2;
        path = `M ${left.x + BOX_W} ${mid} H ${right.x}`;
      } else {
        const x1 = a.x + BOX_W / 2;
        const y1 = a.y + BOX_H;
        const x2 = b.x + BOX_W / 2;
        const y2 = b.y;
        // Same row but NOT adjacent: dip into the gutter below rather than
        // drawing through every box between them.
        const mid = a.y === b.y ? a.y + BOX_H + ROW_GAP / 2 : y1 + (y2 - y1) / 2;
        path = a.y === b.y
          ? `M ${x1} ${y1} V ${mid} H ${x2} V ${y1}`
          : `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}`;
      }
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
  const line = (cls: string, label: string) =>
    `<span class="netkey"><span class="ln ${cls}"></span>${esc(label)}</span>`;
  const glyphs = Object.entries(FAMILY_GLYPH)
    .map(([family, glyph]) => `<span class="netkey"><span class="gl">${esc(glyph)}</span>${esc(family)}</span>`)
    .join("");
  return (
    `<div class="netlegend">`
    + swatch("auth-session", "session")
    + swatch("auth-authenticated", "cracked")
    + swatch("auth-auth-required", "auth required")
    + swatch("auth-no-connection", "no connection")
    + swatch("auth-offline", "offline")
    + swatch("gone", "gone")
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
    + swatch("ram-ours", "RAM: ours")
    + swatch("ram-free", "RAM: free")
    + swatch("ram-blocked", "RAM: owner-blocked")
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
  /** The net's true depth when the topic knows it, so the map can draw the rows
   *  we have never reached as well as the ones we have. */
  netDepth?: number;
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
      // A host we have watched die is the first thing to sink; then one whose
      // depth we no longer believe; then one we have no depth for at all.
      if (host.goneAt !== undefined) return 3;
      const life = factLife(host, "depth", options.now, options.expiry);
      if (life === undefined) return 2;
      return life.stale ? 1 : 0;
    },
  });
  const scale = options.zoom / 100;

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
    + edgeMarkup(layout, options)
    + layout.placed.map((entry) => nodeMarkup(entry, options)).join("")
    + `</svg></div>`
  );
}

/** Read the map's view controls. Kept beside the renderer so the keys are
 * declared once. */
export function mapOptions(now: number, expiry: ExpiryOpts, netDepth?: number): MapOptions {
  return {
    now,
    expiry,
    ...(netDepth !== undefined ? { netDepth } : {}),
    selected: view("dnet.sel"),
    query: view("dnet.q").trim(),
    zoom: Number(view("dnet.zoom", "100")) || 100,
    // Laterals are the layout's only hard evidence now, so hiding them by
    // default made a correctly-constrained row look arbitrary. "tree" keeps
    // parent links AND laterals; only the long back edges are dropped.
    edges: view("dnet.edges", "tree"),
  };
}

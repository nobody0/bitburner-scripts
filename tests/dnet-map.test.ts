import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AUTH_LABEL, BOX_H, BOX_W, COL_PITCH, MAP_W, NET_WIDTH, isStale, layoutNet, matches, netLegend, netMap, ramBuckets } from "../ui/app/tabs/dnet-map.ts";
import { TABS } from "../ui/app/tabs/index.ts";
import { emptyState } from "../ui/app/project.ts";
import { setView } from "../ui/app/lib/viewstate.ts";
import type { DarknetKnownHost } from "../shared/telemetry/topics/dnet.ts";

/** The net map is a pure string builder over a pure layout, which is the whole
 * reason it can be tested at all — and the reason it was built that way rather
 * than on a canvas.
 *
 * The property that matters most is DETERMINISM. The viewer re-renders twice a
 * second; a layout that reshuffled on equal input would make the map shimmer,
 * and a shimmering map is one nobody reads. */

function host(over: Partial<DarknetKnownHost> & { hostname: string }): DarknetKnownHost {
  return { lastSeenAt: 0, facts: {}, ...over };
}

// The map derives every age itself now, so it needs the digest's clock. The
// layout fixtures below carry no facts at all, so staleness never enters these
// tests — `host()` defaults `facts` to `{}` and `isStale` reads that as "nothing
// to disbelieve".
const NOW = 1_000;
const OPTIONS = { selected: "", focus: "", query: "", zoom: 60, edges: "tree", jobs: "all", now: NOW, expiry: {} };

beforeAll(() => GlobalRegistrator.register());
afterAll(() => { void GlobalRegistrator.unregister(); });

function parseMap(markup: string): SVGElement {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.querySelector("svg.netmap")!;
}

describe("layout puts the net on the game's grid", () => {
  test("darkweb gets its own row above depth 0, centred", () => {
    // Its real depth is -1 and its children are depth 0, so it is not part of
    // the grid proper — upstream centres it over the whole width.
    const layout = layoutNet([
      host({ hostname: "darkweb", isDarkweb: true, depth: -1 }),
      host({ hostname: "dn-a", depth: 0, neighbours: ["darkweb"] }),
    ]);
    const dw = layout.byHost.get("darkweb")!;
    const child = layout.byHost.get("dn-a")!;
    expect(dw.row).toBe(-1);
    expect(dw.slot).toBe((NET_WIDTH - 1) / 2);
    expect(child.y).toBeGreaterThan(dw.y);
    expect(layout.rowLabels[0]!.label).toBe("darkweb");
  });

  test("a host sits UNDER the parent it hangs off, not at the left margin", () => {
    // THE HEADLINE TEST of the placement rewrite, and it used to assert the
    // opposite of its own comment: an only child of `p3` landed at column 0,
    // because the old layout sorted by barycentre and then assigned
    // `slot = array index`, packing every row flush against the left margin.
    // Ordering was never the bug. Packing was.
    const parents = Array.from({ length: 4 }, (_, i) => host({ hostname: `p${i}`, depth: 0 }));
    const layout = layoutNet([
      ...parents,
      host({ hostname: "child", depth: 1, neighbours: ["p3"] }),
    ]);
    expect(layout.byHost.get("child")!.slot).toBe(layout.byHost.get("p3")!.slot);
    // ...and with two parents it lands between them rather than at an edge.
    const two = layoutNet([
      ...parents,
      host({ hostname: "a", depth: 1, neighbours: ["p0"] }),
      host({ hostname: "b", depth: 1, neighbours: ["p3"] }),
    ]);
    expect(two.byHost.get("a")!.slot).toBeLessThan(two.byHost.get("b")!.slot);
  });

  test("holes are preserved: a sparse row keeps its parents' columns", () => {
    // The shape of the net IS the holes. `DarknetState.Network[depth][col]` is a
    // sparse array, and the in-game map shows rows like 0,1,2,·,4,5,6,7 with a
    // gap in the middle. A layout that packs left destroys exactly the thing the
    // map exists to show.
    const parents = Array.from({ length: 8 }, (_, i) => host({ hostname: `p${i}`, depth: 0 }));
    const layout = layoutNet([
      ...parents,
      host({ hostname: "x", depth: 1, neighbours: ["p6"] }),
      host({ hostname: "y", depth: 1, neighbours: ["p7"] }),
    ]);
    expect(layout.byHost.get("x")!.slot).toBe(6);
    expect(layout.byHost.get("y")!.slot).toBe(7);
  });

  test("a lateral edge pins two hosts to neighbouring columns", () => {
    // The ONE hard constraint the game hands us. `getNeighborsOnRow(x, y)`
    // returns only Network[x][y-1] and Network[x][y+1], and every connection
    // pass routes through it, so a same-depth edge means |Δcolumn| == 1 exactly.
    const layout = layoutNet([
      host({ hostname: "a", depth: 0, neighbours: ["b"] }),
      host({ hostname: "b", depth: 0, neighbours: ["a"] }),
    ]);
    expect(Math.abs(layout.byHost.get("a")!.slot - layout.byHost.get("b")!.slot)).toBe(1);
  });

  test("a lateral claim from one end only is still honoured", () => {
    // Adjacency comes back from whichever agent happened to stand there, so a
    // one-sided report is a report.
    const layout = layoutNet([
      host({ hostname: "a", depth: 0, neighbours: ["b"] }),
      host({ hostname: "b", depth: 0 }),
    ]);
    expect(Math.abs(layout.byHost.get("a")!.slot - layout.byHost.get("b")!.slot)).toBe(1);
  });

  test("a lateral chain lands under its parents and reflects to fit them", () => {
    const parents = Array.from({ length: 8 }, (_, i) => host({ hostname: `p${i}`, depth: 0 }));
    const layout = layoutNet([
      ...parents,
      host({ hostname: "a", depth: 1, neighbours: ["b", "p7"] }),
      host({ hostname: "b", depth: 1, neighbours: ["a", "c", "p6"] }),
      host({ hostname: "c", depth: 1, neighbours: ["b", "p5"] }),
    ]);
    const seats = ["a", "b", "c"].map((name) => layout.byHost.get(name)!.slot);
    // Consecutive, and seated where their parents are rather than at 0,1,2.
    expect([...seats].sort((x, y) => x - y)).toEqual([5, 6, 7]);
    // ...and reflected, so `a` (whose parent is p7) is to the RIGHT of `c`.
    expect(seats[0]).toBeGreaterThan(seats[2]!);
  });

  test("a contradictory lateral claim degrades instead of throwing, and is reported", () => {
    // Three lateral neighbours cannot all be true — a cell has two sides. In the
    // live game this is impossible, so seeing it means our own knowledge is
    // stale, which is worth surfacing rather than swallowing.
    const layout = layoutNet([
      host({ hostname: "hub", depth: 0, neighbours: ["n1", "n2", "n3"] }),
      host({ hostname: "n1", depth: 0, neighbours: ["hub"] }),
      host({ hostname: "n2", depth: 0, neighbours: ["hub"] }),
      host({ hostname: "n3", depth: 0, neighbours: ["hub"] }),
    ]);
    const seats = ["hub", "n1", "n2", "n3"].map((name) => layout.byHost.get(name)!.slot);
    expect(new Set(seats).size).toBe(4);
    expect(layout.brokenLaterals.size).toBe(1);
  });

  test("a lateral cycle degrades to a chain with everyone placed", () => {
    const layout = layoutNet([
      host({ hostname: "a", depth: 0, neighbours: ["b", "c"] }),
      host({ hostname: "b", depth: 0, neighbours: ["a", "c"] }),
      host({ hostname: "c", depth: 0, neighbours: ["a", "b"] }),
    ]);
    const seats = ["a", "b", "c"].map((name) => layout.byHost.get(name)!.slot);
    expect(new Set(seats).size).toBe(3);
    expect(layout.brokenLaterals.size).toBe(1);
  });

  test("a chain longer than the board splits rather than overflowing it", () => {
    // Nine hosts cannot sit in eight columns however good the evidence looks.
    const names = Array.from({ length: 9 }, (_, i) => `c${i}`);
    const layout = layoutNet(names.map((name, i) =>
      host({
        hostname: name,
        depth: 0,
        neighbours: [names[i - 1], names[i + 1]].filter((n): n is string => n !== undefined),
      })
    ));
    expect(layout.placed).toHaveLength(9);
    for (const entry of layout.placed) {
      expect(entry.slot).toBeGreaterThanOrEqual(0);
      expect(entry.slot).toBeLessThan(NET_WIDTH);
    }
    expect(layout.brokenLaterals.size).toBeGreaterThan(0);
  });

  test("every column on a row is distinct and on the board", () => {
    // The invariant that makes the map a grid rather than a pile.
    const hosts = [
      host({ hostname: "darkweb", isDarkweb: true, depth: -1 }),
      ...Array.from({ length: 7 }, (_, i) => host({ hostname: `a${i}`, depth: 0, neighbours: ["darkweb"] })),
      ...Array.from({ length: 6 }, (_, i) =>
        host({ hostname: `b${i}`, depth: 1, neighbours: [`a${i}`, `b${i + 1}`] })),
      ...Array.from({ length: 5 }, (_, i) => host({ hostname: `c${i}`, depth: 2, neighbours: [`b${i}`] })),
    ];
    const layout = layoutNet(hosts);
    const perRow = new Map<number, number[]>();
    for (const entry of layout.placed) {
      if (entry.kind !== "depth") continue;
      const seats = perRow.get(entry.displayRow) ?? [];
      seats.push(entry.slot);
      perRow.set(entry.displayRow, seats);
    }
    expect(perRow.size).toBeGreaterThan(0);
    for (const seats of perRow.values()) {
      expect(new Set(seats).size).toBe(seats.length);
      for (const seat of seats) {
        expect(seat).toBeGreaterThanOrEqual(0);
        expect(seat).toBeLessThan(NET_WIDTH);
      }
    }
  });

  test("a host with no placed parent sorts last rather than to a made-up column", () => {
    // Putting it anywhere in particular would imply a relationship we do not
    // have evidence for.
    const layout = layoutNet([
      host({ hostname: "root", depth: 0 }),
      host({ hostname: "orphan", depth: 1 }),
      host({ hostname: "attached", depth: 1, neighbours: ["root"] }),
    ]);
    expect(layout.byHost.get("attached")!.slot).toBeLessThan(layout.byHost.get("orphan")!.slot);
  });

  test("more than eight at one depth wraps into a sub-row and says so", () => {
    // The game's grid is 8 wide, but we can legitimately hold more than 8 at a
    // depth while a moved host and its old record are both still believed. The
    // map never drops one; a table is where a limit belongs.
    const hosts = Array.from({ length: 11 }, (_, i) => host({ hostname: `dn-${i}`, depth: 2 }));
    const layout = layoutNet(hosts);
    expect(layout.placed).toHaveLength(11);
    expect(layout.placed.every((entry) => entry.slot < NET_WIDTH)).toBe(true);
    // The label now says what the contradiction IS, rather than just the count:
    // the game cannot hold eleven hosts at one depth, so we are believing a
    // moved host and its ghost at the same time.
    expect(layout.rowLabels.some((row) => row.label === "depth 2 (11 held, 8 fit)")).toBe(true);
    // The overflow really is on a second row, not stacked on the first.
    const ys = new Set(layout.placed.map((entry) => entry.y));
    expect(ys.size).toBe(2);
    // Both chunks belong to the same GAME row, which is what keeps their stagger
    // and their edge classification consistent.
    expect(new Set(layout.placed.map((entry) => entry.row))).toEqual(new Set([2]));
  });

  test("an overcrowded depth puts its best guesses on the grid and its ghosts below", () => {
    // A depth holding more than NET_WIDTH hosts is impossible in the live game —
    // Network[depth] has exactly eight cells — so it means we are believing a
    // host and its ghost at the same time. Which eight get the real row is then
    // a real decision, and the answer is the ones we doubt least.
    const hosts = [
      ...Array.from({ length: 8 }, (_, i) => host({ hostname: `live-${i}`, depth: 0 })),
      ...Array.from({ length: 3 }, (_, i) => host({ hostname: `ghost-${i}`, depth: 0, goneAt: 1 })),
    ];
    const layout = layoutNet(hosts, {
      positionDoubt: (name) => (name.startsWith("ghost") ? 3 : 0),
    });
    const firstRow = Math.min(...layout.placed.map((entry) => entry.displayRow));
    const onGrid = layout.placed.filter((entry) => entry.displayRow === firstRow).map((e) => e.host.hostname);
    expect(onGrid).toHaveLength(8);
    expect(onGrid.every((name) => name.startsWith("live"))).toBe(true);
    // And nothing is dropped.
    expect(layout.placed).toHaveLength(11);
  });

  test("odd grid rows are staggered; the pinned rows never are", () => {
    // Not decoration: without it a dense column of vertical edges collapses into
    // an unreadable ladder. Upstream's condition is
    // `y >= 0 && y < getNetDepth() && y % 2`, and the middle clause — which we
    // used to drop — is there to exempt the LABYRINTH, which sits at
    // getNetDepth() + 0.5 rather than on the grid. Every odd grid row, bottom
    // one included, is staggered.
    const layout = layoutNet([
      host({ hostname: "even", depth: 0 }),
      host({ hostname: "odd", depth: 1 }),
      host({ hostname: "cru3l_l4byr1nth", depth: -1, modelId: "(The Labyrinth)" }),
    ]);
    const even = layout.byHost.get("even")!;
    expect(layout.byHost.get("odd")!.x).toBeGreaterThan(even.x);

    // th3_l4byr1nth pins netDepth to 7, so the lab lands on row 7 — ODD, and it
    // would pick up a half-box stagger if the `< netDepth` clause were missing.
    const oddLab = layoutNet([
      host({ hostname: "flat", depth: 0 }),
      host({ hostname: "th3_l4byr1nth", depth: -1, modelId: "(The Labyrinth)" }),
    ]);
    expect(oddLab.netDepth).toBe(7);
    const lab = oddLab.byHost.get("th3_l4byr1nth")!;
    expect(lab.row).toBe(7);
    // Row 0 slot 0 is never staggered, so its x IS the left inset. An
    // unstaggered lab is exactly that plus its own slot; a staggered one would
    // be half a box further right.
    const inset = oddLab.byHost.get("flat")!.x;
    expect(lab.x).toBe(inset + lab.slot * COL_PITCH);
  });

  test("every depth gets a row, including ones we have never seen into", () => {
    // An explorer's map has to show the shape of the unknown. Rendering only the
    // depths we hold a host for makes a net we have barely touched look fully
    // surveyed — which is how the panel came to show three rows for a net that
    // has seven.
    const layout = layoutNet([host({ hostname: "a", depth: 0 })], { netDepth: 7 });
    for (let depth = 0; depth < 7; depth++) {
      expect(layout.rowLabels.some((row) => row.depth === depth)).toBe(true);
    }
    expect(layout.netDepth).toBe(7);
    expect(layout.netDepthGuessed).toBe(false);
  });

  test("with no labyrinth sighted the bottom is drawn as a floor, not as the end", () => {
    // `netDepthGuessed` was computed, documented and never drawn. Absent a lab
    // sighting `netDepth` is one past the deepest host we hold, so the last grid
    // row IS the deepest thing we have seen — and with no marker below it the map
    // of a net we have barely entered read as a fully surveyed one.
    const layout = layoutNet([host({ hostname: "a", depth: 0 }), host({ hostname: "b", depth: 2 })]);
    expect(layout.netDepth).toBe(3);
    expect(layout.netDepthGuessed).toBe(true);
    const floor = layout.rowLabels.find((row) => row.kind === "floor")!;
    expect(floor.label).toContain("depth ≥ 3");
    // Below every drawn depth row, and inside the viewBox: emitted from `netMap`
    // instead of from the layout it would sit past `height` and be clipped away.
    const deepest = Math.max(...layout.rowLabels.filter((row) => row.kind === "depth").map((row) => row.y));
    expect(floor.y).toBeGreaterThan(deepest);
    expect(layout.height).toBeGreaterThan(floor.y + BOX_H);
    // ...and the map's one-sentence accessible name hedges with it.
    expect(netMap([host({ hostname: "a", depth: 0 })], OPTIONS)).toContain("over at least 1 depths");
  });

  test("a depth we have actually been told is stated, not hedged", () => {
    // The hedge has to be exact both ways: a declared depth, and a drawn
    // labyrinth (which pins the bottom even when the lab is recognised by model
    // rather than by hostname, so `netDepthGuessed` can still be true), both mean
    // there is nothing below to claim.
    const declared = layoutNet([host({ hostname: "a", depth: 0 })], { netDepth: 7 });
    expect(declared.rowLabels.some((row) => row.kind === "floor")).toBe(false);
    expect(netMap([host({ hostname: "a", depth: 0 })], { ...OPTIONS, netDepth: 7 }))
      .toContain("over 7 depths");
    const withLab = layoutNet([
      host({ hostname: "a", depth: 0 }),
      host({ hostname: "renamed_lab", depth: -1, modelId: "(The Labyrinth)" }),
    ]);
    expect(withLab.netDepthGuessed).toBe(true);
    expect(withLab.rowLabels.some((row) => row.kind === "floor")).toBe(false);
  });

  test("air-gap depths are labelled as structurally empty, not as unexplored", () => {
    // `isOnAirGap(x) = !!x && !(x % 8)`, and `getAllOpenPositions` skips them, so
    // depths 8/16/24/32 hold nothing by construction. Since vertical wiring only
    // reaches depth +- 1, that means depth 7 and depth 9 are never adjacent —
    // the net is genuinely segmented, and "empty because nothing can be here"
    // must not read the same as "empty because we have not looked".
    const layout = layoutNet([host({ hostname: "a", depth: 0 })], { netDepth: 12 });
    const gap = layout.rowLabels.find((row) => row.depth === 8)!;
    expect(gap.kind).toBe("airgap");
    expect(gap.label).toContain("air gap");
    expect(layout.rowLabels.find((row) => row.depth === 7)!.kind).toBe("depth");
  });

  test("a host reported on an air gap is still placed, and the row says so", () => {
    // Either the game changed or our model of it has a hole. Both are worth
    // hearing about; neither is worth dropping a host over.
    const layout = layoutNet([host({ hostname: "impossible", depth: 8 })], { netDepth: 12 });
    expect(layout.byHost.has("impossible")).toBe(true);
    expect(layout.rowLabels.find((row) => row.depth === 8)!.label).toContain("!?");
  });

  test("the labyrinth is pinned to the BOTTOM, not sorted to the top", () => {
    // Every lab server reports `depth: -1` — `addLabyrinth` sets it literally for
    // all eight at once — so sorting by depth put the goal of the whole feature
    // above the root of the net. Upstream pins it at getNetDepth() + 0.5.
    const layout = layoutNet([
      host({ hostname: "darkweb", isDarkweb: true, depth: -1 }),
      host({ hostname: "a", depth: 0 }),
      host({ hostname: "th3_l4byr1nth", depth: -1, modelId: "(The Labyrinth)" }),
    ]);
    const lab = layout.byHost.get("th3_l4byr1nth")!;
    expect(lab.y).toBeGreaterThan(layout.byHost.get("a")!.y);
    expect(lab.kind).toBe("labyrinth");
    // Seeing WHICH labyrinth pins the whole net's depth exactly, since
    // getNetDepth() is that lab's depth.
    expect(layout.netDepth).toBe(7);
    expect(layout.netDepthGuessed).toBe(false);
  });

  test("two labyrinths sit side by side in ladder order", () => {
    const layout = layoutNet([
      host({ hostname: "cru3l_l4byr1nth", depth: -1, modelId: "(The Labyrinth)" }),
      host({ hostname: "th3_l4byr1nth", depth: -1, modelId: "(The Labyrinth)" }),
    ]);
    // th3 gates on 300 charisma, cru3l on 600, so th3 is to the left.
    expect(layout.byHost.get("th3_l4byr1nth")!.slot)
      .toBeLessThan(layout.byHost.get("cru3l_l4byr1nth")!.slot);
  });

  test("no box is ever clipped by the viewBox, stagger included", () => {
    // MAP_W used to ignore the half-box odd-row stagger, so column 7 of every
    // odd row hung past the edge and was silently cut off.
    const hosts = Array.from({ length: 8 }, (_, i) => host({ hostname: `s${i}`, depth: 1 }));
    const layout = layoutNet(hosts, { netDepth: 4 });
    for (const entry of layout.placed) expect(entry.x + BOX_W).toBeLessThanOrEqual(MAP_W);
  });

  test("a host with no known depth is placed, not dropped", () => {
    // It is usually the most interesting thing on the map, because it is what we
    // know least about.
    const layout = layoutNet([host({ hostname: "known", depth: 0 }), host({ hostname: "rumour" })]);
    expect(layout.unplaced).toBe(1);
    expect(layout.byHost.has("rumour")).toBe(true);
    expect(layout.rowLabels.some((row) => row.label === "depth unknown")).toBe(true);
  });

  test("identical input gives byte-identical output", () => {
    // The anti-shimmer property, stated as a test rather than as a hope.
    const hosts = [
      host({ hostname: "darkweb", isDarkweb: true, depth: -1 }),
      host({ hostname: "b", depth: 0, neighbours: ["darkweb"] }),
      host({ hostname: "a", depth: 0, neighbours: ["darkweb"] }),
      host({ hostname: "c", depth: 1, neighbours: ["a", "b"] }),
    ];
    expect(netMap(hosts, OPTIONS)).toBe(netMap(hosts, OPTIONS));
    // ...and it does not depend on the order the hosts arrived in.
    expect(netMap([...hosts].reverse(), OPTIONS)).toBe(netMap(hosts, OPTIONS));
  });
});

describe("the rendered SVG", () => {
  const hosts = [
    host({
      hostname: "darkweb", isDarkweb: true, depth: -1, authState: "session", maxRam: 16, usableRam: 16,
      ram: { at: NOW, total: 16, blocked: 0, used: 3.6 },
    }),
    host({
      hostname: "dn-1",
      depth: 0,
      neighbours: ["darkweb"],
      requiredCharisma: 120,
      modelId: "2G_cellular",
      maxRam: 16,
      blockedRam: 4,
      usableRam: 12,
      ram: { at: NOW, total: 16, blocked: 4, used: 5 },
      authState: "auth-required",
    }),
  ];

  test("shows total, blocked, used, and unused RAM", () => {
    const ram = { at: NOW, total: 16, blocked: 4, used: 5 };
    const split = ramBuckets(host({ hostname: "dn-ram", maxRam: 16, blockedRam: 4, ram }));
    expect(split).toEqual({ total: 16, blocked: 4, used: 5, unused: 7 });

    const html = netMap([
      host({ hostname: "dn-ram", depth: 0, maxRam: 16, blockedRam: 4, ram }),
    ], OPTIONS);
    expect(html).toContain("T/B/U/- 16/4/5/7");
    expect(html).toContain("RAM 16GB total, 4.00GB blocked, 5.00GB used, 7.00GB unused");
  });

  test("does not call unsampled capacity unused", () => {
    const hostWithoutRuntime = host({ hostname: "dn-old", depth: 0, maxRam: 16, blockedRam: 4 });
    expect(ramBuckets(hostWithoutRuntime)).toEqual({ total: 16, blocked: 4 });
    expect(netMap([hostWithoutRuntime], OPTIONS)).toContain('class="ram unknown ram-unknown"');
  });

  test("every host is drawn exactly once, with a stable key", () => {
    const map = parseMap(netMap(hosts, OPTIONS));
    expect(map.getAttribute("role")).toBe("img");
    expect(map.querySelectorAll('[data-key^="node:"]')).toHaveLength(2);
    // The key is what lets morph MOVE a node whose depth changed instead of
    // rebuilding it, which is what keeps hover and the native tooltip alive.
    expect(map.querySelector('[data-key="node:dn-1"]')).not.toBeNull();
    expect(map.querySelector('[data-key="edge:darkweb>dn-1"]')).not.toBeNull();
  });

  test("every data-key in the map is unique, including the row gutter", () => {
    // morph keys siblings to decide MOVE versus rebuild, so a duplicate key is
    // not cosmetic — it makes two nodes fight over one slot. The row gutter is
    // where this bit: an overflowing depth emits several rows that all share a
    // depth, so the depth alone was not a key.
    const crowded = [
      host({ hostname: "darkweb", isDarkweb: true, depth: -1 }),
      ...Array.from({ length: 11 }, (_, i) => host({ hostname: `dn-${i}`, depth: 0 })),
      ...Array.from({ length: 3 }, (_, i) => host({ hostname: `deep-${i}`, depth: 2 })),
      host({ hostname: "th3_l4byr1nth", depth: -1, modelId: "(The Labyrinth)" }),
      host({ hostname: "rumour" }),
    ];
    const map = parseMap(netMap(crowded, { ...OPTIONS, edges: "all" }));
    const keys = [...map.querySelectorAll("[data-key]")].map((element) => element.getAttribute("data-key")!);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("selection is declarative, so main.ts needs no change", () => {
    // The delegated handler in main.ts resolves closest() on SVG elements and
    // SVGElement carries .dataset, so a data attribute is the whole mechanism.
    const map = parseMap(netMap(hosts, OPTIONS));
    expect(map.querySelector('[data-view-key="dnet.sel"][data-view-value="dn-1"]')).not.toBeNull();
    const selected = parseMap(netMap(hosts, { ...OPTIONS, selected: "dn-1" }));
    expect(selected.querySelector('[data-key="node:dn-1"]')?.classList.contains("sel")).toBe(true);
  });

  test("a box carries what the in-game box carries, plus the RAM", () => {
    const map = parseMap(netMap(hosts, OPTIONS));
    const node = map.querySelector('[data-key="node:dn-1"]')!;
    expect(node.textContent).toContain("dn-1");
    expect(node.textContent).toContain("cha:120");
    expect(node.textContent).toContain("[ auth required ]");
    // The in-game box only hints at blocked RAM with a lock icon; we show the
    // split, because it is what decides whether an agent fits at all.
    expect(node.querySelector(".ram.used")).not.toBeNull();
    expect(node.querySelector(".ram.unused")).not.toBeNull();
    expect(node.querySelector(".ram.blocked")).not.toBeNull();
    expect(node.textContent).toContain("T/B/U/- 16/4/5/7");
  });

  test("zoom changes the width attribute and never the viewBox", () => {
    // That is what makes zoom two patched attributes rather than a re-layout.
    const small = netMap(hosts, { ...OPTIONS, zoom: 40 });
    const large = netMap(hosts, { ...OPTIONS, zoom: 100 });
    const viewBox = /viewBox="([^"]+)"/;
    expect(small.match(viewBox)![1]).toBe(large.match(viewBox)![1]);
    expect(small).not.toBe(large);
    // At 100% the pixel width IS the viewBox width, which is what makes the
    // scale factor a pure attribute change.
    expect(large).toContain(`width="${MAP_W}"`);
  });

  test("search highlights and dims, and never removes", () => {
    const html = netMap(hosts, { ...OPTIONS, query: "dn-1" });
    expect(html).toContain("hit");
    expect(html).toContain("dim");
    // The shape of the net is the thing you came to look at.
    expect(html.split('data-key="node:').length - 1).toBe(2);
  });

  test("edge modes drop links without dropping hosts", () => {
    const hidden = parseMap(netMap(hosts, { ...OPTIONS, edges: "none" }));
    const shown = parseMap(netMap(hosts, { ...OPTIONS, edges: "all" }));
    expect(hidden.querySelector('[data-key^="edge:"]')).toBeNull();
    expect(shown.querySelector('[data-key^="edge:"]')).not.toBeNull();
    expect(hidden.querySelectorAll('[data-key^="node:"]')).toHaveLength(2);
  });

  test("an edge reported from both ends is drawn once", () => {
    // Adjacency comes back from whichever agent saw it, so both halves usually
    // arrive. Drawing it twice doubles the stroke and makes an ordinary link
    // look emphasised.
    const mutual = [
      host({ hostname: "a", depth: 0, neighbours: ["b"] }),
      host({ hostname: "b", depth: 1, neighbours: ["a"] }),
    ];
    expect(parseMap(netMap(mutual, { ...OPTIONS, edges: "all" })).querySelectorAll('[data-key^="edge:"]')).toHaveLength(1);
  });

  test("active jobs render a coloured badge and directional target routes", () => {
    const working = [
      host({
        hostname: "source", depth: 0, neighbours: ["target"],
        agent: {
          role: "resident", lastBeatAt: NOW, alive: true, active: "plant",
          targets: ["source", "target"],
          ram: { jobGb: 8, proberGb: 3.15, controllerGb: 0 },
        },
      }),
      host({ hostname: "target", depth: 1, neighbours: ["source"] }),
    ];
    const map = parseMap(netMap(working, { ...OPTIONS, jobs: "all" }));
    const source = map.querySelector('[data-key="node:source"]')!;
    expect(source.querySelector(".agentdot.job-plant")).not.toBeNull();
    expect(source.textContent).toContain("plant · 8G");
    expect(map.querySelector('[data-key="job:source>source:plant"] .jobarrow.job-plant')).not.toBeNull();
    expect(map.querySelector('[data-key="job:source>target:plant"] .jobarrow.job-plant')).not.toBeNull();

    const selected = parseMap(netMap(working, { ...OPTIONS, selected: "target", jobs: "selected" }));
    expect(selected.querySelector('[data-key^="job:"]')).toBeNull();
    const hidden = parseMap(netMap(working, { ...OPTIONS, jobs: "none", edges: "all" }));
    expect(hidden.querySelector('[data-key^="job:"]')).toBeNull();
    expect(hidden.querySelector('[data-key^="edge:"]')).not.toBeNull();
  });

  test("topology uses distinct ports and selection focuses its local links", () => {
    const connected = [
      host({ hostname: "hub", depth: 0, neighbours: ["a", "b", "c"] }),
      host({ hostname: "a", depth: 1, neighbours: ["hub"] }),
      host({ hostname: "b", depth: 1, neighbours: ["hub"] }),
      host({ hostname: "c", depth: 2, neighbours: ["hub"] }),
      host({ hostname: "else", depth: 2, neighbours: ["c"] }),
    ];
    const map = parseMap(netMap(connected, { ...OPTIONS, selected: "hub", focus: "hub", edges: "all" }));
    const incident = [...map.querySelectorAll("path.edge.focused")];
    expect(incident).toHaveLength(3);
    expect(map.querySelector("path.edge.context")).not.toBeNull();
    const starts = incident.map((path) => path.getAttribute("d")!.match(/^M ([^ ]+ [^ ]+)/)![1]);
    expect(new Set(starts).size).toBe(starts.length);
    expect(map.querySelector('[data-key="node:a"]')?.classList.contains("neighbour")).toBe(true);
    expect(map.querySelector('[data-key="node:else"]')?.classList.contains("unrelated")).toBe(true);
  });

  test("hostile text is escaped in both the box and its tooltip", () => {
    const nasty = [host({ hostname: "<script>x</script>&", depth: 0, passwordHint: "a & b" })];
    const map = parseMap(netMap(nasty, OPTIONS));
    expect(map.querySelector("script")).toBeNull();
    expect(map.textContent).toContain("<script>x</script>&");
  });

  test("matches searches the fields an operator would actually type", () => {
    const h = hosts[1]!;
    expect(matches(h, "DN-1")).toBe(true);
    expect(matches(h, "2g_cell")).toBe(true);
    expect(matches(h, "nothing")).toBe(false);
  });
});

describe("the panel at the scale the game actually reaches", () => {
  test("a 163-host, depth-36 net renders each host once and does not shimmer", () => {
    // The deepest labyrinth builds roughly this: 36 rows at NET_WIDTH x density.
    const big: DarknetKnownHost[] = [host({ hostname: "darkweb", isDarkweb: true, depth: -1 })];
    for (let depth = 0; depth < 36; depth++) {
      for (let i = 0; i < 5; i++) {
        big.push(host({
          hostname: `dn-${depth}-${i}`,
          depth,
          neighbours: depth === 0 ? ["darkweb"] : [`dn-${depth - 1}-${i}`],
          maxRam: 16,
          usableRam: 8,
        }));
      }
    }
    const html = netMap(big, OPTIONS);
    expect(html.split('data-key="node:').length - 1).toBe(big.length);
    expect(netMap(big, OPTIONS)).toBe(html);
  });

  test("the tab renders the whole net from the published fold", () => {
    const state = emptyState();
    state.topics.dnet = {
      maxDepth: 1,
      stasisLinkLimit: 1,
      stasisLinked: [],
      instability: { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0 },
      knowledge: {
        at: 1_000,
        generation: "15:0",
        gone: 0,
        agents: { live: 1, seenEver: 3, lostSinceBoot: 2 },
        hosts: [
          {
            hostname: "darkweb",
            isDarkweb: true,
            depth: -1,
            lastSeenAt: 1_000,
            facts: {},
            authState: "session",
          },
          {
            hostname: "dn-1",
            depth: 0,
            lastSeenAt: 900,
            neighbours: ["darkweb"],
            modelId: "DeepGreen",
            maxRam: 32,
            blockedRam: 16,
            usableRam: 16,
            authState: "auth-required",
            // One timestamp per fact. The panel works out the rest.
            facts: { depth: 900, modelId: 900 },
          },
        ],
      },
    };
    setView("dnet.sel", "dn-1");
    const html = TABS.dnet.render(state);
    // The map is there, with both hosts on it...
    expect(html).toContain("<svg");
    expect(html.split('data-key="node:').length - 1).toBe(2);
    // ...the detail card describes the current registry entry, looked up by id.
    expect(html).toContain("implemented");
    expect(html).toContain("MastermindHint");
    // The oracle grammar is still described, because that is what a reader needs
    // to check the solver against.
    expect(html).toContain("Mastermind oracle");
    // ...an identity fact says it never expires, rather than showing 0ms left...
    expect(html).toContain("never expires");
    // ...and agent mortality is on screen, which it never has been before.
    expect(html).toContain("2 lost");
    setView("dnet.sel", "");
  });
});

describe("the key describes the map, and not something near it", () => {
  /** Every host state the map can draw, one host each, so the markup below
   *  contains every class the map is capable of emitting. */
  const EVERY_STATE: DarknetKnownHost[] = [
    host({
      hostname: "dn-session", depth: 0, authState: "session", maxRam: 16, usableRam: 12, blockedRam: 4,
      ram: { at: NOW, total: 16, blocked: 4, used: 5 },
    }),
    host({ hostname: "dn-auth", depth: 0, authState: "authenticated" }),
    host({ hostname: "dn-locked", depth: 0, authState: "auth-required" }),
    host({ hostname: "dn-unreached", depth: 1, authState: "no-connection" }),
    host({ hostname: "dn-offline", depth: 1, authState: "offline" }),
    host({ hostname: "dn-gone", depth: 1, goneAt: NOW }),
    host({ hostname: "dn-pinned", depth: 2, stasisLinked: true }),
    // A host the publisher can actually emit: `describeHost` sends the identity
    // fields with every report, so the old `facts: { depth: 1 }` fixture was a
    // shape no digest produces — and it was the only thing keeping this test
    // green while the fade was broken for every real host.
    host({
      hostname: "dn-stale",
      depth: 2,
      modelId: "(Dictionary)",
      maxRam: 8,
      facts: { modelId: 1, maxRam: 1, requiredCharisma: 1, depth: 1, neighbours: 1 },
      // A mutation dirtied everything perishable and no refresh has landed yet.
      dirty: { position: true, topology: true, ram: true, files: true },
    }),
  ];

  test("every legend swatch names a class the map actually renders", () => {
    // The guard for a real defect: the key carried a `linked` swatch for years
    // while the node drew stasis as a `<rect class="stasis">` and never took a
    // `linked` class at all. Nothing was visibly wrong — the two happened to
    // share a colour — so only a structural check catches the next one.
    const markup = netMap(EVERY_STATE, { ...OPTIONS, now: NOW + 10 * 60 * 1000 });
    const rendered = new Set(
      [...markup.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)),
    );
    const swatches = [...netLegend().matchAll(/class="sw ([^"]+)"/g)].map((m) => m[1]!);

    expect(swatches.length).toBeGreaterThan(4);
    for (const swatch of swatches) {
      expect(rendered.has(swatch), `the key shows "${swatch}" and no node renders it`).toBe(true);
    }
  });

  test("every auth state the union allows gets its own class", () => {
    // AUTH_LABEL is typed as a TOTAL record over the union, so this asserts the
    // map keeps a distinct visual for each rather than collapsing two.
    const markup = netMap(EVERY_STATE, OPTIONS);
    for (const state of Object.keys(AUTH_LABEL)) {
      expect(markup, `no node carries auth-${state}`).toContain(`auth-${state}`);
    }
  });
});

describe("the fade is keyed on the facts that can actually go stale", () => {
  const OLD = NOW + 60 * 60 * 1000;

  test("a host whose position and topology were dirtied by a mutation is stale, identity and all", () => {
    // THE defect this replaced: `isStale` was `every` over ALL of `host.facts`,
    // and identity never expires, so a single modelId — which every report
    // carries — held the fade off forever.
    const drifted = host({
      hostname: "dn-drifted",
      depth: 3,
      modelId: "(Dictionary)",
      facts: { modelId: 1, passwordLength: 1, depth: 1, neighbours: 1 },
      dirty: { position: true, topology: true },
    });
    expect(isStale(drifted, OLD, {})).toBe(true);
    // Age alone is not staleness: the same host an hour on, with the mutation
    // refresh landed, has nothing to disbelieve.
    expect(isStale(host({ ...drifted, dirty: {} }), OLD, {})).toBe(false);
    // And one perishable group still believed is enough to hold the fade off.
    expect(isStale(host({ ...drifted, dirty: { position: true } }), OLD, {})).toBe(false);
  });

  test("nothing that cannot expire is counted as expired", () => {
    // A stationary host's position is eternal for a REASON — every mutation
    // branch skips it — so an old `depth` on one is not a stale reading, and the
    // test is "cannot expire" rather than a hardcoded list of fact classes.
    const pinned = host({
      hostname: "darkweb",
      depth: -1,
      isStationary: true,
      facts: { modelId: 1, isStationary: 1, depth: 1 },
    });
    expect(isStale(pinned, OLD, {})).toBe(false);
    // Identity only — the state a webstorm leaves behind — has nothing
    // perishable in it either, and a host with no facts at all is unchanged.
    expect(isStale(host({ hostname: "dn-wiped", facts: { modelId: 1 } }), OLD, {})).toBe(false);
    expect(isStale(host({ hostname: "dn-blank" }), OLD, {})).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { MAP_W, NET_WIDTH, layoutNet, matches, netMap } from "../ui/app/tabs/dnet-map.ts";
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

const OPTIONS = { selected: "", query: "", zoom: 60, edges: "tree" };

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

  test("a host sits near the parent it hangs off", () => {
    // Barycentre placement: an only child inherits its parent's column, which is
    // what keeps edges short and mostly non-crossing without an iterative solve.
    const parents = Array.from({ length: 4 }, (_, i) => host({ hostname: `p${i}`, depth: 0 }));
    const layout = layoutNet([
      ...parents,
      host({ hostname: "child", depth: 1, neighbours: ["p3"] }),
    ]);
    expect(layout.byHost.get("child")!.slot).toBe(0);
    // ...and with two parents it lands between them rather than at an edge.
    const two = layoutNet([
      ...parents,
      host({ hostname: "a", depth: 1, neighbours: ["p0"] }),
      host({ hostname: "b", depth: 1, neighbours: ["p3"] }),
    ]);
    expect(two.byHost.get("a")!.slot).toBeLessThan(two.byHost.get("b")!.slot);
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
    expect(layout.rowLabels.some((row) => row.label === "depth 2 (11)")).toBe(true);
    // The overflow really is on a second row, not stacked on the first.
    const ys = new Set(layout.placed.map((entry) => entry.y));
    expect(ys.size).toBe(2);
  });

  test("odd rows are staggered, as upstream does", () => {
    // Not decoration: without it a dense column of vertical edges collapses into
    // an unreadable ladder.
    const layout = layoutNet([
      host({ hostname: "even", depth: 0 }),
      host({ hostname: "odd", depth: 1 }),
    ]);
    expect(layout.byHost.get("odd")!.x).toBeGreaterThan(layout.byHost.get("even")!.x);
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
    host({ hostname: "darkweb", isDarkweb: true, depth: -1, authState: "session", maxRam: 16, freeRam: 16 }),
    host({
      hostname: "dn-1",
      depth: 0,
      neighbours: ["darkweb"],
      ip: "10.0.0.7",
      requiredCharisma: 120,
      modelId: "2G_cellular",
      modelFamily: "timing",
      maxRam: 16,
      blockedRam: 4,
      freeRam: 12,
      authState: "auth-required",
    }),
  ];

  test("every host is drawn exactly once, with a stable key", () => {
    const html = netMap(hosts, OPTIONS);
    expect(html).toContain("<svg");
    expect(html.split('data-key="node:').length - 1).toBe(2);
    // The key is what lets morph MOVE a node whose depth changed instead of
    // rebuilding it, which is what keeps hover and the native tooltip alive.
    expect(html).toContain('data-key="node:dn-1"');
    expect(html).toContain('data-key="edge:darkweb&gt;dn-1"');
  });

  test("selection is declarative, so main.ts needs no change", () => {
    // The delegated handler in main.ts resolves closest() on SVG elements and
    // SVGElement carries .dataset, so a data attribute is the whole mechanism.
    const html = netMap(hosts, OPTIONS);
    expect(html).toContain('data-view-key="dnet.sel" data-view-value="dn-1"');
    expect(netMap(hosts, { ...OPTIONS, selected: "dn-1" })).toContain("node auth-auth-required sel");
  });

  test("a box carries what the in-game box carries, plus the RAM", () => {
    const html = netMap(hosts, OPTIONS);
    expect(html).toContain("dn-1");
    expect(html).toContain("10.0.0.7 cha:120");
    expect(html).toContain("[ auth required ]");
    // The in-game box only hints at blocked RAM with a lock icon; we show the
    // split, because it is what decides whether an agent fits at all.
    expect(html).toContain('class="ram free"');
    expect(html).toContain('class="ram blocked"');
    expect(html).toContain("12GB/16GB");
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
    expect(netMap(hosts, { ...OPTIONS, edges: "none" })).not.toContain('data-key="edge:');
    expect(netMap(hosts, { ...OPTIONS, edges: "all" })).toContain('data-key="edge:');
    expect(netMap(hosts, { ...OPTIONS, edges: "none" }).split('data-key="node:').length - 1).toBe(2);
  });

  test("an edge reported from both ends is drawn once", () => {
    // Adjacency comes back from whichever agent saw it, so both halves usually
    // arrive. Drawing it twice doubles the stroke and makes an ordinary link
    // look emphasised.
    const mutual = [
      host({ hostname: "a", depth: 0, neighbours: ["b"] }),
      host({ hostname: "b", depth: 1, neighbours: ["a"] }),
    ];
    expect(netMap(mutual, { ...OPTIONS, edges: "all" }).split('data-key="edge:').length - 1).toBe(1);
  });

  test("hostile text is escaped in both the box and its tooltip", () => {
    const nasty = [host({ hostname: "<script>x</script>&", depth: 0, passwordHint: "a & b" })];
    const html = netMap(nasty, OPTIONS);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("matches searches the fields an operator would actually type", () => {
    const h = hosts[1]!;
    expect(matches(h, "DN-1")).toBe(true);
    expect(matches(h, "10.0.0")).toBe(true);
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
          freeRam: 8,
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
      reachable: 1,
      maxDepth: 1,
      stasisLinkLimit: 1,
      stasisLinked: [],
      instability: { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0 },
      servers: [],
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
            modelName: "MastermindHint",
            modelFamily: "oracle",
            modelOracle: "`data` is `<exact>,<misplaced>`",
            modelBlocked: "mastermind solver not written",
            maxRam: 32,
            blockedRam: 16,
            freeRam: 16,
            authState: "auth-required",
            facts: {
              depth: { at: 900, from: "agent", via: "darkweb", ageMs: 100, expiresInMs: 5_000, stale: false, class: "position" },
              modelId: { at: 900, from: "agent", via: "darkweb", ageMs: 100, expiresInMs: null, stale: false, class: "identity" },
            },
          },
        ],
      },
    };
    setView("dnet.sel", "dn-1");
    const html = TABS.dnet.render(state);
    // The map is there, with both hosts on it...
    expect(html).toContain("<svg");
    expect(html.split('data-key="node:').length - 1).toBe(2);
    // ...the detail card explains WHY the host is untouched rather than leaving
    // a blank where a reason belongs...
    expect(html).toContain("mastermind solver not written");
    expect(html).toContain("MastermindHint");
    // ...each fact says how old it is and who saw it...
    expect(html).toContain("agent via darkweb");
    // ...an identity fact says it never expires, rather than showing 0ms left...
    expect(html).toContain("never expires");
    // ...and agent mortality is on screen, which it never has been before.
    expect(html).toContain("2 lost");
    setView("dnet.sel", "");
  });
});

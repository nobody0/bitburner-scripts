import { describe, expect, test } from "bun:test";
import { DarknetSystem } from "../features/dnet.ts";
import { mulberry32 } from "../core/rng.ts";
import { ProcessTable } from "../ns/process.ts";
import { SimWorld } from "../world.ts";
import { mockServer } from "../core/mocks.ts";
import type { SimServer } from "../core/effects.ts";

/** The darknet's GEOMETRY, which is load-bearing for anything that tries to
 * reconstruct a column it is never told.
 *
 * `DarknetServer.leftOffset` is not exposed to scripts, so `ui/`'s map has to
 * infer it, and the only hard evidence available is the asymmetry these tests
 * pin: a same-depth edge can exist only between cells one column apart, while a
 * vertical edge is rolled against the entire adjacent row and therefore says
 * nothing about the column. If the sim ever mints a same-depth edge at
 * |Δcolumn| != 1, every map validated against it is validated against a net the
 * game cannot produce.
 *
 * Source: ../bitburner-src @ 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/utils/darknetNetworkUtils.ts (getNeighborsOnRow, getAllOpenPositions)
 *   src/DarkNet/controllers/NetworkGenerator.ts (addRandomConnections) */

const NET_WIDTH = 8;

function system(seed: number): { dnet: DarknetSystem; network: Map<string, string[]> } {
  const world = new SimWorld({ seed, bitnode: 15, network: [] });
  const servers = world.servers;
  const darkweb = mockServer({ hostname: "darkweb", maxRam: 16, hasAdminRights: true }) as SimServer;
  darkweb.simKind = "DarknetServer";
  servers.set("darkweb", darkweb);
  const network = new Map<string, string[]>([["home", ["darkweb"]], ["darkweb", ["home"]]]);
  const dnet = new DarknetSystem({
    servers,
    network,
    processes: new ProcessTable(servers, world.clock),
    generate: mulberry32(seed),
    random: mulberry32(seed + 1),
    bitNode: 15,
    fullAccess: () => true,
    hasProgram: () => true,
    installedAugmentations: () => new Set<string>(),
    allowRedPill: () => true,
    world,
    player: world.player,
    homeFiles: () => new Set<string>(),
    darknetMoneyMultiplier: () => 1,
  });
  dnet.populate();
  return { dnet, network };
}

/** Every invariant, checked together, so a failure names the one that broke. */
function check(dnet: DarknetSystem, network: Map<string, string[]>): void {
  const live = [...dnet.hosts.values()].filter((host) => host.online && !host.isStationary);
  const cells = new Map<string, string>();

  for (const host of live) {
    expect(host.leftOffset).toBeGreaterThanOrEqual(0);
    expect(host.leftOffset).toBeLessThan(NET_WIDTH);
    expect(host.depth).toBeGreaterThanOrEqual(0);
    // Air-gap rows hold nothing. This is what makes depth 7 and depth 9
    // non-adjacent, since the vertical wiring only ever looks at depth +- 1.
    expect(host.depth % 8 === 0 && host.depth > 0).toBe(false);

    const cell = `${host.depth}:${host.leftOffset}`;
    // One host per cell: upstream raises an exceptionAlert for a collision,
    // because Network[x][y] can only hold one.
    expect(cells.get(cell)).toBeUndefined();
    cells.set(cell, host.hostname);
  }

  const at = new Map(live.map((host) => [host.hostname, host]));
  for (const host of live) {
    for (const name of network.get(host.hostname) ?? []) {
      const other = at.get(name);
      // darkweb and the labyrinth are pinned and adjacent to a whole row, so
      // they carry no column claim and are skipped here by construction.
      if (!other) continue;
      const dDepth = Math.abs(other.depth - host.depth);
      expect(dDepth).toBeLessThanOrEqual(1);
      if (dDepth === 0) {
        // THE INVARIANT THE MAP INFERS FROM.
        expect(Math.abs(other.leftOffset - host.leftOffset)).toBe(1);
      }
    }
  }
}

describe("the darknet grid", () => {
  test("a freshly populated net seats every host in its own legal cell", () => {
    const { dnet, network } = system(1);
    check(dnet, network);
    const live = [...dnet.hosts.values()].filter((host) => host.online && !host.isStationary);
    expect(live.length).toBeGreaterThan(0);
  });

  test("no depth ever holds more than the grid is wide", () => {
    const { dnet } = system(2);
    const perDepth = new Map<number, number>();
    for (const host of dnet.hosts.values()) {
      if (!host.online || host.isStationary) continue;
      perDepth.set(host.depth, (perDepth.get(host.depth) ?? 0) + 1);
    }
    expect(perDepth.size).toBeGreaterThan(0);
    for (const [, count] of perDepth) expect(count).toBeLessThanOrEqual(NET_WIDTH);
  });

  // `darknetProcess` takes CYCLES, and one mutation is 150/netDepth of them —
  // about 21 at the first labyrinth's depth 7. So 300 cycles is roughly 14
  // mutations, and the round counts below are chosen against that rather than
  // against a wall-clock guess.
  const CYCLES_PER_ROUND = 300;

  test("the invariants survive heavy mutation, which is when placement goes wrong", () => {
    // Several seeds, because a single stream can miss a branch entirely — the
    // move and balance paths are the ones that re-seat hosts, and they are
    // exactly where a collision or an illegal lateral would appear.
    for (const seed of [3, 11, 29, 47]) {
      const { dnet, network } = system(seed);
      for (let i = 0; i < 40; i++) dnet.darknetProcess(CYCLES_PER_ROUND);
      check(dnet, network);
    }
  });

  test("a same-depth edge is always between neighbouring columns, over many mutations", () => {
    const { dnet, network } = system(7);
    let lateral = 0;
    for (let round = 0; round < 40; round++) {
      dnet.darknetProcess(CYCLES_PER_ROUND);
      const live = new Map(
        [...dnet.hosts.values()].filter((host) => host.online && !host.isStationary).map((h) => [h.hostname, h]),
      );
      for (const host of live.values()) {
        for (const name of network.get(host.hostname) ?? []) {
          const other = live.get(name);
          if (!other || other.depth !== host.depth) continue;
          lateral++;
          expect(Math.abs(other.leftOffset - host.leftOffset)).toBe(1);
        }
      }
    }
    // The assertion above is vacuous if the net never produces a lateral edge,
    // which is exactly the failure mode a "no illegal edges" test hides.
    expect(lateral).toBeGreaterThan(0);
  });
});

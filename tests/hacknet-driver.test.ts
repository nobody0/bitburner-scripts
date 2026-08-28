import { describe, expect, test } from "bun:test";
import { buildView, hacknetBasis, upgradeValue, type HacknetBasis } from "../game/lib/features/hacknet.ts";
import type { ClaimContext } from "../game/lib/features/index.ts";
import type { GameState } from "../game/lib/state.ts";
import type { HacknetNodeDigest, HacknetState } from "../shared/telemetry/topics/hacknet.ts";

/** The driver half of hacknet: turning the observed topic into the view the
 * pure scheduler ranks. These are the joints where the ROI model meets real
 * telemetry, and every one of them can be reached with a partial topic. */

type Ctx = Parameters<typeof hacknetBasis>[0];

function ctxOf(hacknet: Partial<HacknetState> | undefined, over: Record<string, unknown> = {}): Ctx {
  return {
    state: { topics: { hacknet, ...(over.topics as object ?? {}) } } as unknown as GameState,
    caps: {
      bitNode: (over.bitNode as number) ?? 1,
      sourceFiles: (over.sourceFiles as Record<string, number>) ?? {},
      restrictions: {},
    } as unknown as ClaimContext["caps"],
    board: { open: [] } as unknown as ClaimContext["board"],
    horizons: {
      node: { state: "estimated", remainingSec: 28_800 },
      install: { state: "estimated", remainingSec: 28_800 },
    } as unknown as ClaimContext["horizons"],
  };
}

const node = (over: Partial<HacknetNodeDigest> = {}): HacknetNodeDigest => ({
  name: "hacknet-node-0",
  level: 10,
  ram: 8,
  cores: 2,
  production: 4,
  totalProduction: 100,
  timeOnline: 60,
  ...over,
});

describe("the decision basis", () => {
  test("plain nodes value production in dollars directly", () => {
    const basis = hacknetBasis(ctxOf({ nodes: [node()] } as Partial<HacknetState>));
    expect(basis?.hashMode).toBe(false);
    expect(basis?.hashDollarValue).toBe(1);
  });

  test("hash mode without an observed sale quote REFUSES to decide", () => {
    // Valuing a hash at zero here would rank every upgrade at zero production
    // and publish a considered-looking hold that is really a frozen feature.
    const bn9 = { bitNode: 9 };
    expect(hacknetBasis(ctxOf({ nodes: [node()], servers: true } as Partial<HacknetState>, bn9))).toBeUndefined();
    const quoted = hacknetBasis(ctxOf(
      { nodes: [node()], servers: true, hashes: { current: 0, capacity: 64, sellForMoneyCost: 4 } } as Partial<HacknetState>,
      bn9,
    ));
    expect(quoted?.hashMode).toBe(true);
    expect(quoted?.hashDollarValue).toBe(250_000);
  });
});

describe("valuing one upgrade", () => {
  const hashBasis: HacknetBasis = {
    hashMode: true,
    hashDollarValue: 250_000,
    fleetUtilization: 0,
    fleetDemanded: false,
  };

  test("cache adds hash capacity, never production", () => {
    expect(upgradeValue(node({ cache: 1, hashCapacity: 64 }), "cache", hashBasis, 0).value).toBe(0);
  });

  test("server RAM is valued as the BETTER of idle hashes and occupied fleet RAM", () => {
    const server = node({ ram: 16, ramUsed: 4, production: 0.02 });
    // No farm demand at all: filling the RAM earns nothing, so idle wins.
    const idle = upgradeValue(server, "ram", hashBasis, 0);
    expect(idle.ramBasis).toBe("idle");
    // A farm that pays well per GB outbids the hashes the busy RAM gives up.
    const occupied = upgradeValue(server, "ram", hashBasis, 1_000);
    expect(occupied.ramBasis).toBe("occupied");
    expect(occupied.value).toBeGreaterThan(idle.value);
  });

  test("the valuation is monotone in farm value — no threshold cliff", () => {
    // Increasing farm value must not reduce the value of the same upgrade.
    const server = node({ ram: 16, ramUsed: 4, production: 0.02 });
    const rates = [0, 1, 10, 100, 1_000, 10_000];
    const values = rates.map((rate) => upgradeValue(server, "ram", hashBasis, rate).value);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
  });
});

describe("building the view from a real topic", () => {
  const basis: HacknetBasis = { hashMode: false, hashDollarValue: 1, fleetUtilization: 0, fleetDemanded: false };

  test("a fresh node is worth buying even with no BitNode row observed", () => {
    // Missing observed production on a fresh node uses the modeled rate, not zero.
    const view = buildView(
      ctxOf({ nodes: [], purchaseNodeCost: 1_000, maxNumNodes: 30 } as Partial<HacknetState>, { bitNode: 999 }),
      1e9,
      basis,
      undefined,
    );
    expect(view?.newNodeProduction).toBeGreaterThan(0);
  });

  test("a topic holding prices but no nodes yet cannot be valued", () => {
    // `nextUpgrades` arrives from a PARTIAL emission and can land first.
    const view = buildView(
      ctxOf({ nextUpgrades: [{ kind: "level", node: 0, cost: 1_000 }] } as Partial<HacknetState>),
      1e9,
      basis,
      undefined,
    );
    expect(view).toBeUndefined();
  });

  test("a quote for a node that is not in the list is dropped, not valued at zero", () => {
    const view = buildView(
      ctxOf({
        nodes: [node()],
        nextUpgrades: [{ kind: "level", node: 0, cost: 1_000 }, { kind: "level", node: 7, cost: 1_000 }],
      } as Partial<HacknetState>),
      1e9,
      basis,
      undefined,
    );
    expect(view?.upgrades).toHaveLength(1);
    expect(view?.upgrades[0]!.deltaProduction).toBeGreaterThan(0);
  });
});

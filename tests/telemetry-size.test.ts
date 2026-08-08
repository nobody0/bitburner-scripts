import { describe, expect, test } from "bun:test";
import type { NS, Server } from "@ns";
import { DODGED_PROBES, isStepped, type SingleStepProbe } from "../game/lib/probes/index.ts";
import type { SideState } from "../shared/telemetry/topics/side.ts";

/** Mirrors CONTRACT_LIMIT in game/lib/probes/dodged.ts, which cannot be
 * exported from a shared/telemetry module without linking that module into
 * `--perf` builds (tests/build-perf.test.ts). */
const CONTRACT_LIMIT = 100;

/** State records are last-write-wins and rare, which makes it tempting to put
 * a whole subsystem in one. That is exactly what went wrong: the `side` topic
 * dumped every .cct on the network, so a long-lived save produced a 1.66 MB
 * record, 88 MB across a single run, and a viewer snapshot large enough to
 * stall the browser before its first paint.
 *
 * "DIGESTS, NOT DUMPS" (shared/telemetry/state-map.ts) is the rule; this file
 * is what makes it fail loudly instead of rotting. A topic that outgrows the
 * budget should be given a cap and a total, not a bigger budget. */

/** Per-record ceiling. Generous — the largest healthy topic is well under it —
 * but three orders of magnitude below what an unbounded dump reaches. */
const MAX_RECORD_BYTES = 64_000;

function singleStep(id: string): SingleStepProbe {
  const probe = DODGED_PROBES.find((p) => p.id === id);
  if (!probe || isStepped(probe)) throw new Error(`no single-step probe ${id}`);
  return probe;
}

/** Enough of an ns for the contract probe: every host holds `perHost` files,
 * alternating between a type we can solve and one we cannot. */
function contractNs(hosts: string[], perHost: number): NS {
  return {
    ls: (host: string, ext: string) =>
      ext === ".cct" ? Array.from({ length: perHost }, (_, i) => `contract-${host}-${i}.cct`) : [],
    codingcontract: {
      getContractType: (file: string) =>
        Number(file.slice(file.lastIndexOf("-") + 1, -4)) % 2 === 0
          ? "Find Largest Prime Factor"
          : "Not A Real Contract Type",
      getNumTriesRemaining: (file: string) => (Number(file.slice(file.lastIndexOf("-") + 1, -4)) % 10) + 1,
    },
  } as unknown as NS;
}

describe("telemetry record size", () => {
  test("the contract probe partitions rather than dumping the network", () => {
    const hosts = Array.from({ length: 60 }, (_, i) => `host-${i}`);
    const servers = Object.fromEntries(hosts.map((h) => [h, { hostname: h } as Server]));
    const emissions = singleStep("side.contracts").run(contractNs(hosts, 200), {
      servers,
      player: {} as never,
      caps: {} as never,
    });
    expect(emissions).toBeInstanceOf(Array);
    const data = (emissions as { key: string; data: SideState }[])[0]!.data;

    // 12,000 contracts on the network, half of them unsolvable.
    expect(data.contractTotal).toBe(12_000);
    expect(data.solvableTotal).toBe(6_000);
    expect(data.unsolvableTotal).toBe(6_000);
    // ...and the record carries a bounded window plus counts, not the list.
    expect(data.contracts.length).toBe(CONTRACT_LIMIT);
    expect(Object.keys(data.unsolvableByType ?? {})).toEqual(["Not A Real Contract Type"]);
    expect(JSON.stringify(data).length).toBeLessThan(MAX_RECORD_BYTES);
  });

  test("the capped window holds only contracts we can act on, most at risk first", () => {
    const hosts = ["a", "b"];
    const servers = Object.fromEntries(hosts.map((h) => [h, { hostname: h } as Server]));
    const emissions = singleStep("side.contracts").run(contractNs(hosts, 40), {
      servers,
      player: {} as never,
      caps: {} as never,
    });
    const data = (emissions as { key: string; data: SideState }[])[0]!.data;
    // An unsolvable contract in the window would starve the driver, which only
    // ever attempts the head of this list.
    expect(data.contracts.every((c) => c.type === "Find Largest Prime Factor")).toBe(true);
    const tries = data.contracts.map((c) => c.triesRemaining);
    expect(tries).toEqual([...tries].sort((a, b) => a - b));
  });

  test("augmentation offers carry no per-augmentation duplication", () => {
    const probe = DODGED_PROBES.find((p) => p.id === "factions.augs");
    if (!probe || !isStepped(probe)) throw new Error("factions.augs is not a stepped probe");

    // One augmentation offered by four factions — the shape that used to
    // duplicate a multiplier table four times.
    const mults = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`some_long_multiplier_name_${i}`, 1.5]),
    );
    const emissions = probe.finish({
      byFaction: {
        Daedalus: ["The Red Pill", "Shared Aug"],
        Illuminati: ["Shared Aug"],
        NWO: ["Shared Aug"],
        BitRunners: ["Shared Aug"],
      },
      prices: { "The Red Pill": 1e12, "Shared Aug": 5e9 },
      repReq: { "The Red Pill": 2.5e6, "Shared Aug": 1e5 },
      factionRep: { Daedalus: 3e6 },
      prereqs: { "Shared Aug": ["Some Prereq"] },
      mults: { "Shared Aug": mults, "The Red Pill": mults },
    });
    const data = (emissions as { key: string; data: { offers?: unknown[]; augMeta?: Record<string, unknown> } }[])[0]!
      .data;

    expect(data.offers).toHaveLength(5);
    // Five offers, two augmentations: the heavy fields are stored per
    // augmentation, so the pair count no longer multiplies them.
    expect(Object.keys(data.augMeta ?? {}).sort()).toEqual(["Shared Aug", "The Red Pill"]);
    for (const offer of data.offers as Record<string, unknown>[]) {
      expect(offer["mults"]).toBeUndefined();
      expect(offer["prereqs"]).toBeUndefined();
    }
    expect(JSON.stringify(data).length).toBeLessThan(MAX_RECORD_BYTES);
  });
});

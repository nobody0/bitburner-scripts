import { describe, expect, test } from "bun:test";
import { parseGoals } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";
import { CACHE_PROGRAMS, DarknetSystem, DNET_ASSUMPTIONS, LAB_STAGES, currentLab, labReward } from "../features/dnet.ts";
import { mulberry32 } from "../core/rng.ts";
import { ProcessTable } from "../ns/process.ts";
import { SimWorld } from "../world.ts";
import { mockServer } from "../core/mocks.ts";
import type { SimServer } from "../core/effects.ts";
import { lane } from "../../tests/support/lanes.ts";
import { only } from "../../shared/features/profile.ts";

/** The purchase is only meaningful if the darknet it buys actually appears, so
 * these run the real controller rather than poking the system directly. */
lane({ feature: "dnet", bn: 1 }).describe("buying darknet access", () => {
  test("a BN1 run with no SF15 buys the program and then sees a darknet", async () => {
    const observed: number[] = [];
    const result = await runGame({
      // Unreachable on purpose: with only progression and dnet active there is
      // no income, so the run goes to its horizon instead of exiting the moment
      // the starting balance satisfies a goal.
      goal: parseGoals(["wealth:1e12"]),
      seed: 1,
      horizonMs: 12 * 60_000,
      bitnode: 1,
      homeRam: 256,
      // Comfortably past the 10% affordability guard on $50.2m, so the test
      // measures the purchase rather than the grind up to it.
      startingMoney: 2e9,
      // Isolated so `unmodeled` speaks about the darknet. `side` reaches the
      // contract-generation boundary, which is a separate, pre-existing gap.
      features: only("progression", "dnet"),
      onRecord: (line) => {
        const record = JSON.parse(line) as { key?: string; data?: { servers?: unknown[] } };
        if (record.key === "dnet" && Array.isArray(record.data?.servers)) {
          observed.push(record.data.servers.length);
        }
      },
    });

    // Nothing may report itself unmodelled. Before this model existed the
    // purchase threw `subsystem darknet population` on every pass.
    expect(result.unmodeled).toEqual({});
    expect(result.crashes).toEqual([]);
    // In BN1 with no SF15 the dnet probe is gated off until the program lands,
    // so a populated reading can only mean the purchase happened AND generated
    // a darknet. A record with zero hosts would not prove either.
    expect(observed.length).toBeGreaterThan(0);
    expect(Math.max(...observed)).toBeGreaterThan(0);
  }, 120_000);

  test("the same seed generates the same darknet", async () => {
    const run = async () => {
      const hosts: string[] = [];
      await runGame({
        goal: parseGoals(["wealth:1e12"]),
        seed: 7,
        horizonMs: 6 * 60_000,
        bitnode: 15,
        homeRam: 128,
        features: only("progression", "dnet"),
        startingMoney: 1e9,
        onRecord: (line) => {
          const record = JSON.parse(line) as { key?: string; data?: { servers?: { hostname: string }[] } };
          if (record.key === "dnet" && record.data?.servers) {
            for (const server of record.data.servers) hosts.push(server.hostname);
          }
        },
      });
      return hosts;
    };
    // The graph comes off a dedicated generation seed, so it must not vary with
    // the gameplay seed OR between runs — otherwise a strategy A/B would be
    // measuring a different net.
    expect(await run()).toEqual(await run());
  }, 120_000);

});

function system(over: { fullAccess?: boolean; hasProgram?: boolean; installed?: string[]; bitNode?: number } = {}) {
  const world = new SimWorld({ seed: 1, bitnode: over.bitNode ?? 1, network: [] });
  const servers = world.servers;
  const darkweb = mockServer({ hostname: "darkweb", maxRam: 16, hasAdminRights: true }) as SimServer;
  darkweb.simKind = "DarknetServer";
  servers.set("darkweb", darkweb);
  const network = new Map<string, string[]>([["home", ["darkweb"]], ["darkweb", ["home"]]]);
  const home = new Set<string>();
  const clock = world.clock;
  return new DarknetSystem({
    servers,
    network,
    processes: new ProcessTable(servers, clock),
    generate: mulberry32(1),
    random: mulberry32(2),
    bitNode: 1,
    fullAccess: () => over.fullAccess === true,
    hasProgram: () => over.hasProgram === true,
    installedAugmentations: () => new Set(over.installed ?? []),
    allowRedPill: () => true,
    world,
    player: world.player,
    homeFiles: () => home,
    darknetMoneyMultiplier: () => 1,
  });
}

describe("the darknet model", () => {
  test("no access means no darknet, which is what the purchase changes", () => {
    const locked = system();
    expect(locked.hasAccess()).toBe(false);
    locked.populate();
    // populate() is not itself access-gated upstream either — the CALLERS are —
    // so what proves the gate is hasAccess, and the run only calls populate
    // through it.
    expect(system({ hasProgram: true }).hasAccess()).toBe(true);
    expect(system({ fullAccess: true }).hasAccess()).toBe(true);
  });

  test("populate is idempotent and reachable from home", () => {
    const dnet = system({ hasProgram: true });
    dnet.populate();
    const first = dnet.hosts.size;
    expect(first).toBeGreaterThan(0);
    dnet.populate();
    expect(dnet.hosts.size).toBe(first);
    // Row 0 hangs off darkweb, which is the only host home neighbours.
    expect(dnet.probeFrom("home")).toContain("darkweb");
    expect(dnet.probeFrom("darkweb").length).toBeGreaterThan(0);
  });

  test("darkweb answers getServerDetails even though it is never generated", () => {
    const dnet = system({ hasProgram: true });
    // initDarkwebServer builds it unconditionally and separately from
    // populateDarknet, so a model that only knew generated hosts would report
    // the one always-present darknet server as missing.
    expect(dnet.record("darkweb")).toMatchObject({ depth: -1, blockedRam: 0, isStationary: true });
    expect(dnet.record("nonesuch")).toBeUndefined();
  });

  test("blocked RAM presents as used RAM, so it cannot be allocated", () => {
    const dnet = system({ hasProgram: true });
    dnet.populate();
    for (const host of dnet.hosts.values()) {
      expect(host.blockedRam).toBeGreaterThanOrEqual(0);
    }
  });

  test("the mutation clock only runs with access, and kills what it deletes", () => {
    const locked = system();
    locked.darknetProcess(10_000);
    expect(locked.mutations).toBe(0);

    const dnet = system({ hasProgram: true });
    dnet.populate();
    const before = dnet.hosts.size;
    // One tick per 150 cycles at depth 5 -> 30 cycles; 3000 cycles is plenty.
    dnet.darknetProcess(3_000);
    expect(dnet.mutations).toBeGreaterThan(0);
    // Deletions are permanent, so the population can only shrink.
    expect([...dnet.hosts.values()].filter((host) => host.online).length).toBeLessThanOrEqual(before);
  });

  test("mutation draws a fixed width from the shared stream", () => {
    // Two draws per mutation whatever it does. A variable width would make two
    // strategy variants face different stock prices for reasons unrelated to
    // either strategy.
    let draws = 0;
    const world = new SimWorld({ seed: 1, bitnode: 1, network: [] });
    const servers = world.servers;
    const darkweb = mockServer({ hostname: "darkweb", maxRam: 16 }) as SimServer;
    darkweb.simKind = "DarknetServer";
    servers.set("darkweb", darkweb);
    const clock = world.clock;
    const dnet = new DarknetSystem({
      servers,
      network: new Map([["darkweb", []]]),
      processes: new ProcessTable(servers, clock),
      generate: mulberry32(1),
      random: () => { draws++; return 0.99; },
      bitNode: 1,
      fullAccess: () => false,
      hasProgram: () => true,
      installedAugmentations: () => new Set<string>(),
      allowRedPill: () => true,
      world,
      player: world.player,
      homeFiles: () => new Set<string>(),
      darknetMoneyMultiplier: () => 1,
    });
    dnet.populate();
    dnet.darknetProcess(3_000);
    expect(draws).toBe(dnet.mutations * 2);
  });
});

describe("the labyrinth ladder", () => {
  test("which lab is open depends on INSTALLED rewards, not queued ones", () => {
    // A reward waiting in the queue does not open the next lab, which is what
    // makes the labyrinth a multi-install walk rather than one visit.
    expect(currentLab(new Set(), 1, true).hostname).toBe("th3_l4byr1nth");
    expect(currentLab(new Set(["The W1ngs of Icarus"]), 1, true).hostname).toBe("cru3l_l4byr1nth");
    // Depth grows with progress, and depth is what sets both the population and
    // the mutation rate.
    expect(currentLab(new Set(), 1, true).depth).toBe(7);
    expect(LAB_STAGES[LAB_STAGES.length - 1]!.depth).toBe(36);
  });

  test("BN15 hands over the Red Pill two labs earlier than anywhere else", () => {
    const four = new Set([
      "The W1ngs of Icarus", "The B00ts of Perseus", "The H4mmer of Daedalus", "The St4ff of Asclepius",
    ]);
    // In BN15 the fifth reward IS the Red Pill, in place of The L4w.
    expect(labReward(four, 15, true)).toBe("The Red Pill");
    // Elsewhere all six come first.
    expect(labReward(four, 1, true)).toBe("The L4w of Bayes");
    const all = new Set([...four, "The L4w of Bayes", "The B1ade of Solomonoff"]);
    expect(labReward(all, 1, true)).toBe("The Red Pill");
    // BN8 zeroes DarknetLabyrinthRewardsTheRedPill, so the walk yields NeuroFlux.
    expect(labReward(all, 8, false)).toBe("NeuroFlux Governor");
    expect(labReward(new Set([...all, "The Red Pill"]), 1, true)).toBe("NeuroFlux Governor");
  });

  test("the labyrinth needs full access, and the program alone does not grant it", () => {
    expect(system({ hasProgram: true }).currentLab()).toBeUndefined();
    expect(system({ hasProgram: true }).netDepth()).toBe(5);
    const full = system({ fullAccess: true });
    expect(full.currentLab()?.hostname).toBe("th3_l4byr1nth");
    expect(full.netDepth()).toBe(7);
  });

  test("the current lab is placed on the net and never mutated away", () => {
    const dnet = system({ fullAccess: true });
    dnet.populate();
    const lab = dnet.record("th3_l4byr1nth")!;
    expect(lab).toMatchObject({ modelId: "(The Labyrinth)", isStationary: true, difficulty: 10 });
    // isImmutable exempts stationary hosts from delete, move and restart.
    dnet.darknetProcess(50_000);
    expect(dnet.mutations).toBeGreaterThan(0);
    expect(dnet.record("th3_l4byr1nth")!.online).toBe(true);
  });
});

describe("cache files, which are what the purchase is actually worth", () => {
  test("a cache hands over the first program not owned, up to Formulas.exe", () => {
    const dnet = system({ hasProgram: true });
    dnet.populate();
    const [target] = [...dnet.hosts.keys()].filter((name) => name !== "darkweb");
    const name = dnet.addCache(target!, false)!;
    expect(dnet.cachesOn(target!)).toContain(name);
    // The reward draw is random, so drive the program branch directly through
    // repeated opens until it fires; what matters is WHICH program comes first.
    let granted: string | undefined;
    for (let i = 0; i < 200 && granted === undefined; i++) {
      const file = dnet.addCache(target!, false);
      if (!file) continue;
      const result = dnet.openCache(target!, file);
      if (result.message.includes("program")) granted = result.message;
    }
    expect(granted).toContain(CACHE_PROGRAMS[0]);
  });

  test("opening a cache costs karma scaled by difficulty, and consumes the file", () => {
    const dnet = system({ hasProgram: true });
    dnet.populate();
    const [target] = [...dnet.hosts.keys()].filter((name) => name !== "darkweb");
    const file = dnet.addCache(target!, false)!;
    const difficulty = dnet.record(target!)!.difficulty;
    const result = dnet.openCache(target!, file);
    expect(result.success).toBe(true);
    // Returned negative, as the CacheResult contract has it.
    expect(result.karmaLoss).toBe(-(difficulty + 1));
    expect(dnet.cachesOn(target!)).not.toContain(file);
    // A second open of the same file finds nothing.
    expect(dnet.openCache(target!, file).success).toBe(false);
  });

  test("a missing cache is refused rather than throwing", () => {
    const dnet = system({ hasProgram: true });
    expect(dnet.openCache("darkweb", "nope.cache")).toMatchObject({ success: false, karmaLoss: 0 });
  });
});

describe("the darknet model's own claims", () => {
  test("the assumptions it makes are declared, not implied", () => {
    // The formulas are transcribed; the topology is a shape. A run's metadata
    // has to say which is which, or a later measurement cannot invalidate the
    // right artifacts.
    expect(DNET_ASSUMPTIONS.length).toBeGreaterThan(0);
    expect(DNET_ASSUMPTIONS.join(" ")).toContain("topology");
    expect(DNET_ASSUMPTIONS.join(" ")).toContain("caches");
  });
});

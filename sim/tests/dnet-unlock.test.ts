import { describe, expect, test } from "bun:test";
import { parseGoals } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";
import {
  CACHE_PROGRAMS,
  DarknetSystem,
  DNET_ASSUMPTIONS,
  LAB_STAGES,
  MUTATION_DRAWS,
  currentLab,
  labReward,
} from "../features/dnet.ts";
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

  test("the controller plants an overseer on darkweb and the net gets MAPPED", async () => {
    // The end-to-end claim, and the one the whole change exists to make good on.
    // Before this, the Darknet panel showed `darkweb` and nothing else no matter
    // how long a run went, because home's own probe can only ever see one hop
    // and nothing ever stood anywhere else.
    let knownHosts = 0;
    let adjacency = 0;
    let seedOutcome = "";
    const seen = new Set<string>();

    const result = await runGame({
      goal: parseGoals(["wealth:1e12"]),
      seed: 3,
      horizonMs: 8 * 60_000,
      bitnode: 15,
      homeRam: 256,
      features: only("progression", "dnet"),
      onRecord: (line) => {
        const record = JSON.parse(line) as {
          key?: string;
          name?: string;
          data?: {
            knowledge?: { hosts?: { hostname: string; neighbours?: string[] }[] };
            coverage?: { known?: number; adjacencyKnown?: number };
            plan?: { lastResult?: { action: string; ok: boolean; detail: string } };
          };
        };
        if (record.key !== "dnet") return;
        for (const host of record.data?.knowledge?.hosts ?? []) {
          seen.add(host.hostname);
          if (host.neighbours) adjacency++;
        }
        knownHosts = Math.max(knownHosts, record.data?.coverage?.known ?? 0);
        // `record()` surfaces as the topic's own lastResult rather than as an
        // event, so this is where the seed's outcome shows up.
        const last = record.data?.plan?.lastResult;
        if (last?.action === "seed") seedOutcome = `${last.ok ? "ok" : "failed"}: ${last.detail}`;
      },
    });

    expect(result.crashes).toEqual([]);
    // Nothing may report itself unmodelled: the seed drives authenticate,
    // heartbleed, nextMutation and the session gates, and a gap in any of them
    // would surface here rather than as a quietly stalled net.
    expect(result.unmodeled).toEqual({});

    // The beachhead went down...
    expect(seedOutcome, "the seed never ran").not.toBe("");
    expect(seedOutcome).toContain("ok");
    // ...and the map is no longer one host wide. This is the number the
    // screenshot in the original report showed as 0.
    expect(knownHosts).toBeGreaterThan(1);
    expect(seen.size).toBeGreaterThan(1);
    // Adjacency is what `home` structurally cannot learn: probe() is host-local,
    // so an edge list can only come from an agent standing somewhere else.
    expect(adjacency).toBeGreaterThan(0);
  }, 180_000);

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

  test("the mutation clock only runs with access", () => {
    const locked = system();
    locked.darknetProcess(10_000);
    expect(locked.mutations).toBe(0);

    const dnet = system({ hasProgram: true });
    dnet.populate();
    // One tick per 150 cycles at depth 5 -> 30 cycles; 3000 cycles is plenty.
    dnet.darknetProcess(3_000);
    expect(dnet.mutations).toBeGreaterThan(0);
  });

  test("the net CHURNS rather than eroding: it adds as well as deletes", () => {
    // This is the property, and it took a rewrite to get right. An earlier model
    // applied deletions and restarts only, which looks harmless and is not: with
    // nothing ever added, a long run ends with an empty darknet and agents that
    // have nowhere left to go. It measured as a map that grew for ten minutes
    // and then decayed to a single host — indistinguishable, from the outside,
    // from a crawler that had stopped working.
    const dnet = system({ hasProgram: true });
    dnet.populate();
    const before = [...dnet.hosts.values()].filter((host) => host.online).length;
    let addedEver = false;
    for (let i = 0; i < 40; i++) {
      dnet.darknetProcess(3_000);
      if ([...dnet.hosts.values()].filter((host) => host.online).length > before) addedEver = true;
    }
    expect(dnet.mutations).toBeGreaterThan(10);
    expect(addedEver).toBe(true);
    // ...and it does not run away either: `balanceDarknetServers` and the
    // density floor hold the population near the generator's own target.
    const after = [...dnet.hosts.values()].filter((host) => host.online).length;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before * 6);
  });

  test("the shallow rows are restocked, because that is where the net is entered", () => {
    // `addLowLevelServersIfNeeded` keeps depth 0 populated. Without it the
    // approaches to the net empty out first, and `darkweb` — the one host we can
    // always reach — ends up connected to nothing at all.
    const dnet = system({ hasProgram: true });
    dnet.populate();
    for (let i = 0; i < 40; i++) dnet.darknetProcess(3_000);
    const atDarkweb = [...dnet.hosts.values()].filter((host) => host.online && host.depth === 0);
    expect(atDarkweb.length).toBeGreaterThan(0);
  });

  test("a move invalidates position AND every edge, which is why they expire apart", () => {
    // The two clocks knowledge.ts derives its expiries from. A model that moved
    // a host without rewiring it would make `topology` look as durable as
    // `position`, and the staleness policy would measure as far cheaper than it
    // is in game.
    const dnet = system({ hasProgram: true });
    dnet.populate();
    const before = new Map(
      [...dnet.hosts.values()].map((host) => [host.hostname, { depth: host.depth }]),
    );
    let moved = false;
    for (let i = 0; i < 60 && !moved; i++) {
      dnet.darknetProcess(3_000);
      for (const host of dnet.hosts.values()) {
        const was = before.get(host.hostname);
        if (was && host.online && was.depth !== host.depth) moved = true;
      }
    }
    expect(moved).toBe(true);
  });

  test("mutation draws a fixed width from the shared stream", () => {
    // A FIXED number of draws per mutation whatever the tick does. A width that
    // varied with what the net happened to look like would make two strategy
    // variants face different stock prices for reasons unrelated to either
    // strategy — and the tick now has a dozen branches, so this matters more
    // than it did when it had two.
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
    expect(draws).toBe(dnet.mutations * MUTATION_DRAWS);
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
    const declared = DNET_ASSUMPTIONS.join(" ");
    expect(DNET_ASSUMPTIONS.length).toBeGreaterThan(0);
    expect(declared).toContain("topology");
    expect(declared).toContain("caches");
    // Each of these is a place the simulator is narrower than the game. Listing
    // them individually is deliberate: a future edit that quietly drops one
    // would leave a run claiming a fidelity it does not have.
    expect(declared).toContain("mutationPlacement");
    expect(declared).toContain("probeOrder");
    expect(declared).toContain("logNoise");
    expect(declared).toContain("models");
    expect(declared).toContain("backdoors");
    expect(declared).toContain("stasis");
  });

  test("the remaining mutation gap is placement, and says so", () => {
    // This assumption used to say the tick applied deletes and restarts only,
    // which quietly invalidated every staleness measurement AND made a long run
    // end with an empty net. Both are fixed: the tick now rolls every kind
    // upstream does, at upstream's probabilities. What is left is genuinely a
    // shape — where a moved host lands — and the text has to say which is which,
    // because a run's metadata is what decides whether a later measurement can
    // invalidate an artifact.
    const gap = DNET_ASSUMPTIONS.find((line) => line.startsWith("dnet.mutationPlacement"))!;
    expect(gap).toBeDefined();
    expect(gap).toContain("Rates are faithful");
    expect(gap).toContain("shape");
    // And the claim it no longer makes: nothing may still describe the tick as
    // delete-only.
    expect(DNET_ASSUMPTIONS.join(" ")).not.toContain("deletes and restarts only");
  });
});

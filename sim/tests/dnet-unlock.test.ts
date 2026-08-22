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
  promoteStockCharges,
  promoteStockCharismaExp,
  promoteStockWaitMs,
  stockPromotionMult,
} from "../features/dnet.ts";
import { makeDnet } from "../ns/dnet.ts";
import { StockMarketSystem } from "../features/stock.ts";
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
    const mapped: number[] = [];
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
        const record = JSON.parse(line) as {
          key?: string;
          data?: { probed?: unknown[]; knowledge?: { hosts?: unknown[] } };
        };
        if (record.key !== "dnet") return;
        if (Array.isArray(record.data?.probed)) observed.push(record.data.probed.length);
        if (Array.isArray(record.data?.knowledge?.hosts)) mapped.push(record.data.knowledge.hosts.length);
      },
    });

    // Nothing may report itself unmodelled. Before this model existed the
    // purchase threw `subsystem darknet population` on every pass.
    expect(result.unmodeled).toEqual({});
    expect(result.crashes).toEqual([]);
    // In BN1 with no SF15 the dnet probe is gated off until the program lands,
    // so the mere EXISTENCE of a reading is what proves the purchase happened.
    expect(observed.length).toBeGreaterThan(0);
    expect(Math.max(...observed)).toBeGreaterThan(0);
    // That the probe ran does not yet prove a net was GENERATED: `probed`
    // always carries `darkweb`, which `initDarkwebServer` builds unconditionally
    // and independently of `populateDarknet`. What proves generation is the
    // folded map holding more than that one host.
    expect(Math.max(...mapped, 0)).toBeGreaterThan(1);
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
  return darknetWorld(over).dnet;
}

/** The same fixture, with the world it was built against — `promoteStock` reads
 *  and writes the player's charisma, so its tests need both halves. */
function darknetWorld(
  over: { fullAccess?: boolean; hasProgram?: boolean; installed?: string[]; bitNode?: number } = {},
): { world: SimWorld; dnet: DarknetSystem; network: Map<string, string[]> } {
  const world = new SimWorld({ seed: 1, bitnode: over.bitNode ?? 1, network: [] });
  const servers = world.servers;
  const darkweb = mockServer({ hostname: "darkweb", maxRam: 16, hasAdminRights: true }) as SimServer;
  darkweb.simKind = "DarknetServer";
  servers.set("darkweb", darkweb);
  const network = new Map<string, string[]>([["home", ["darkweb"]], ["darkweb", ["home"]]]);
  const home = new Set<string>();
  const clock = world.clock;
  const dnet = new DarknetSystem({
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
  return { world, dnet, network };
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
    //
    // Sampled between CONSECUTIVE snapshots rather than against the state at
    // populate(): one mutation is 150/netDepth cycles — about 30 at the depth-5
    // fallback — so a 3000-cycle call is a hundred mutations, easily long enough
    // for a host to move and then be deleted before anyone looked. Comparing
    // against a fixed baseline measured survival, not movement.
    const { dnet, network } = darknetWorld({ hasProgram: true });
    dnet.populate();
    const snapshot = () =>
      new Map(
        [...dnet.hosts.values()]
          .filter((host) => host.online && !host.isStationary)
          .map((host) => [host.hostname, { depth: host.depth, links: [...(network.get(host.hostname) ?? [])] }]),
      );

    let moves = 0;
    let before = snapshot();
    for (let round = 0; round < 400 && moves === 0; round++) {
      // One mutation is 150/netDepth cycles — 30 at the depth-5 fallback — so
      // this is a handful of mutations per round rather than a hundred.
      dnet.darknetProcess(60);
      const after = snapshot();
      for (const [hostname, was] of before) {
        const now = after.get(hostname);
        if (!now || now.depth === was.depth) continue;
        moves++;
        // THE CLAIM: a move re-wires from scratch, so every edge the host now
        // holds is consistent with its NEW cell. `moveDarknetServer` calls
        // `disconnectServer` before re-seating, which is why `topology` cannot
        // outlive `position` and the two expire on different clocks.
        const host = dnet.hosts.get(hostname)!;
        for (const link of now.links) {
          const other = dnet.hosts.get(link);
          // darkweb and the labyrinth are pinned and adjacent to a whole row.
          if (!other || other.isStationary) continue;
          expect(Math.abs(other.depth - host.depth)).toBeLessThanOrEqual(1);
          if (other.depth === host.depth) {
            expect(Math.abs(other.leftOffset - host.leftOffset)).toBe(1);
          }
        }
      }
      before = after;
    }
    expect(moves).toBeGreaterThan(0);
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
    // A second open of the same file THROWS, which is upstream's own behaviour
    // and materially different from a refusal — see below.
    expect(() => dnet.openCache(target!, file)).toThrow();
  });

  test("a missing cache THROWS, exactly as upstream does", () => {
    // This test used to assert the opposite, and the assertion was wrong rather
    // than the engine: `openCache` raises through `helpers.errorMessage` on both
    // its bad-path and not-found branches (`NetscriptFunctions/Darknet.ts:292-303`).
    // The distinction is not pedantic. A throw KILLS THE CALLING SCRIPT, so a
    // job that opened a cache off a listing that had gone stale under it would
    // cost its host the only resident standing there — and nothing outside the
    // darknet can put one back. Modelling it as a refusal would have made the
    // guard in `game/dnet/jobs.ts` look like belt-and-braces instead of the
    // thing that keeps a host alive.
    const dnet = system({ hasProgram: true });
    expect(() => dnet.openCache("darkweb", "nope.cache")).toThrow("Cache file not found");
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

  test("the remaining mutation gap is entropy, not placement, and says so", () => {
    // This assumption has been narrowed twice, and the text is the record of
    // what a run's measurements may still be invalidated by.
    //
    // It first said the tick applied deletes and restarts only, which quietly
    // invalidated every staleness measurement AND made a long run end with an
    // empty net. Then it said placement was shape — a moved host was wired to
    // plausible neighbours one row away instead of taking a grid cell. That one
    // mattered more than it looked: a same-depth edge can only ever join cells
    // one column apart, so a sim wiring same-depth pairs freely mints edges the
    // game cannot produce, and `ui/`'s map infers columns from exactly those
    // edges. Both are now modelled.
    //
    // What is left is the ENTROPY SOURCE, which is a real divergence and a much
    // smaller one: upstream rolls a fresh random() per candidate pair, and doing
    // that here would make the mutation's draw block variable-width.
    const gap = DNET_ASSUMPTIONS.find((line) => line.startsWith("dnet.mutationPlacement"))!;
    expect(gap).toBeDefined();
    expect(gap).toContain("ENTROPY SOURCE");
    expect(gap).toContain("Same probabilities");
    // The grid is now claimed as reproduced rather than as shape.
    const topology = DNET_ASSUMPTIONS.find((line) => line.startsWith("dnet.topology"))!;
    expect(topology).toContain("leftOffset");
    expect(topology).toContain("air-gap");
    // And the claims it no longer makes.
    const all = DNET_ASSUMPTIONS.join(" ");
    expect(all).not.toContain("deletes and restarts only");
    expect(all).not.toContain("the exact grid is shape");
  });

  test("the password models claim full transcription, and name what is left", () => {
    // The same record, for the half a solver is written against. This entry
    // used to say nineteen of the twenty-four models had an unguessable
    // password — a solver could not be tested at all against that, and the
    // moment it stopped being true the text had to move with it.
    const models = DNET_ASSUMPTIONS.find((line) => line.startsWith("dnet.models"))!;
    expect(models).toContain("All fifteen arms");
    expect(models).toContain("isCloseToCorrectPassword");
    expect(models).toContain("ENTROPY SOURCE");
    expect(DNET_ASSUMPTIONS.join(" ")).not.toContain("correctly-formatted-but-unguessable");
  });

  test("a 408 is reachable now that backdoors are modelled, and the entry says how", () => {
    // This line USED to be `dnet.authTimeout`, declaring a timeout unreachable
    // because `getTimeoutChance()` is exactly 0 with no backdoor path. That was
    // true and is no longer: the chance is `max(min((backdoored - 2) * 0.03,
    // 0.5), 0)`, so the third backdoor makes 408 a real outcome and the
    // resume-across-a-timeout path in `attemptJob` is exercised rather than
    // merely unit-tested. The record moves with the model.
    expect(DNET_ASSUMPTIONS.some((line) => line.startsWith("dnet.authTimeout"))).toBe(false);
    const backdoors = DNET_ASSUMPTIONS.find((line) => line.startsWith("dnet.backdoors"))!;
    expect(backdoors).toBeDefined();
    expect(backdoors).toContain("408");
    // The two halves that make a backdoor a decision rather than a freebie: it
    // taxes every authentication in the net, and it makes its own host churn.
    expect(backdoors).toContain("1.07 ^ surplus");
    expect(backdoors).toContain("restart");
    expect(DNET_ASSUMPTIONS.join(" ")).not.toContain("no backdoor path is modelled");
  });

  test("the maze is claimed as modelled, with the wall rule stated", () => {
    // The one branch a walker cannot recover from getting wrong: a refused move
    // leaves the position unchanged, so a walker that assumed its move landed
    // desyncs from the engine permanently. If the sim ever stops reproducing
    // that, this line is what says the measurement is void.
    const labyrinth = DNET_ASSUMPTIONS.find((line) => line.startsWith("dnet.labyrinth"))!;
    expect(labyrinth).toContain("UNCHANGED");
    expect(labyrinth).toContain("PID");
    expect(DNET_ASSUMPTIONS.join(" ")).not.toContain("a lab is never completed from a script");
  });
});

/** `ns.dnet.promoteStock` — the one darknet call whose payoff is entirely in
 * another feature. It raises a symbol's VOLATILITY and nothing else, and it is
 * a live lever in BN8, where the darknet's own income multipliers are zero but
 * nothing zeroes propaganda.
 *
 * The curve itself is pinned in `sim/tests/stock-market.test.ts` against the
 * vendored price engine; this pins the ns member's gates, its wait, and where
 * the charges land. */
describe("promoting a stock from the darknet", () => {
  function promoter(over: { hasProgram?: boolean; host?: string; threads?: number } = {}) {
    const { world, dnet } = darknetWorld({ bitNode: 8, hasProgram: over.hasProgram !== false });
    // Constructed for its side effect: rolling the market is what registers the
    // 33 symbols `promoteStock` validates against. Note it does NOT need the TIX
    // API — propaganda is spreadable before a script can trade.
    void new StockMarketSystem(world, world.player, mulberry32(3), {
      hasWseAccount: true,
      hasTixApiAccess: true,
    });
    const process = {
      pid: 1,
      filename: "promote.js",
      host: over.host ?? "darkweb",
      args: [],
      threads: over.threads ?? 1,
      temporary: false,
      ramGb: 2,
      atExit: new Map(),
      killed: false,
      onlineMoneyMade: 0,
      onlineExpGained: 0,
      onlineRunningTimeSeconds: 0,
    };
    let waited = 0;
    const ns = makeDnet({
      system: dnet,
      process,
      delay: (ms) => {
        waited = ms;
        world.clock.at(world.clock.now() + ms, () => {});
        return Promise.resolve();
      },
      skills: () => ({
        charisma: world.person.skills.charisma,
        intelligence: world.person.skills.intelligence,
      }),
      nowMs: () => world.clock.now(),
      hasBoots: () => false,
      sf15Level: () => 0,
      servers: world.servers,
      charismaExpMult: () => world.person.mults.charisma_exp,
      gainCharismaExp: (amount) => {
        world.person.exp.charisma = Math.max(0, world.person.exp.charisma + amount);
        world.recalculateSkills();
      },
    }) as { promoteStock: (symbol: string) => Promise<unknown> };
    return { ns, dnet, world, waited: () => waited };
  }

  test("charges land on the symbol, priced by threads and charisma", async () => {
    const { ns, dnet, world, waited } = promoter({ threads: 8 });
    const charisma = world.person.skills.charisma;
    const expBefore = world.person.exp.charisma;

    await expect(ns.promoteStock("ECP")).resolves.toEqual({ success: true, code: 200, message: "Success" });

    expect(waited()).toBe(promoteStockWaitMs(charisma));
    expect(dnet.stockPromotionCharges("ECP")).toBeCloseTo(promoteStockCharges(8, charisma), 9);
    expect(dnet.stockVolatilityMult("ECP")).toBe(stockPromotionMult(dnet.stockPromotionCharges("ECP")));
    // Propaganda is charisma work, and it pays charisma experience for it.
    expect(world.person.exp.charisma - expBefore).toBeCloseTo(
      promoteStockCharismaExp(8, charisma, world.person.mults.charisma_exp),
      9,
    );
    // Untouched symbols stay neutral: this is per-symbol, not market-wide.
    expect(dnet.stockVolatilityMult("MGCP")).toBe(1);
  });

  test("repeated calls accumulate, and the charisma they build compounds", async () => {
    const { ns, dnet, world } = promoter({ threads: 100 });
    await ns.promoteStock("ECP");
    const first = dnet.stockPromotionCharges("ECP");
    const charismaAfterFirst = world.person.skills.charisma;

    await ns.promoteStock("ECP");
    const second = dnet.stockPromotionCharges("ECP") - first;
    // Charges are priced by charisma at the moment they land, and the first
    // call's own XP already raised it — so the second call buys strictly more
    // than the first. Asserting equality here would be asserting that
    // promoteStock does not build charisma, which it does.
    expect(world.person.skills.charisma).toBeGreaterThan(charismaAfterFirst);
    expect(second).toBeGreaterThan(first);
    // Priced by charisma as it stood when the call landed — its OWN experience
    // is granted afterwards and pays for the call after this one.
    expect(second).toBeCloseTo(promoteStockCharges(100, charismaAfterFirst), 9);
    expect(dnet.stockVolatilityMult("ECP")).toBeGreaterThan(1);
  });

  test("it refuses off a darknet server, without access, and on a bad symbol", async () => {
    const offNet = promoter({ host: "home" });
    await expect(offNet.ns.promoteStock("ECP")).rejects.toThrow("can only be used on a darknet server");
    expect(offNet.dnet.stockPromotionCharges("ECP")).toBe(0);

    const noAccess = promoter({ hasProgram: false });
    await expect(noAccess.ns.promoteStock("ECP")).rejects.toThrow("do not have access to the dnet api");

    const fine = promoter();
    await expect(fine.ns.promoteStock("NOPE")).rejects.toThrow("Invalid stock symbol");
  });

  test("the symbol is checked before the wait, so a bad call costs no time", async () => {
    const { ns, waited } = promoter();
    await expect(ns.promoteStock("NOPE")).rejects.toThrow("Invalid stock symbol");
    expect(waited()).toBe(0);
  });

  test("the charges are darknet state, and a prestige clears them", () => {
    // `sim/tests/stock-market.test.ts` pins the curve against the vendored price
    // engine; this pins where the charges LIVE. They die with the portfolio,
    // because upstream's prestigeDarknetState clears stockPromotions on the same
    // boundary at which initStockMarket re-rolls the market.
    const dnet = system({ bitNode: 8 });
    expect(dnet.stockVolatilityMult("ECP")).toBe(1);

    dnet.addStockPromotion("ECP", 1_000);
    expect(dnet.stockPromotionCharges("ECP")).toBe(1_000);
    expect(dnet.stockVolatilityMult("ECP")).toBe(stockPromotionMult(1_000));
    // Untouched symbols stay neutral: this is per-symbol, not market-wide.
    expect(dnet.stockVolatilityMult("MGCP")).toBe(1);

    dnet.scaleStockPromotions(0.4);
    expect(dnet.stockPromotionCharges("ECP")).toBeCloseTo(400, 9);

    dnet.prestige();
    expect(dnet.stockPromotionCharges("ECP")).toBe(0);
    expect(dnet.stockVolatilityMult("ECP")).toBe(1);
  });
});

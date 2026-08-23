import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPREAD_LIMITS,
  candidatesFrom,
  deriveTasks,
  planSpread,
  planStorm,
  type SpreadCandidate,
  type StormContext,
} from "../shared/strategy/dnet/plan.ts";
import { emptyHost, foldReports, type DnetHost, type DnetHosts } from "../shared/strategy/dnet/host.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import { STORM_PHISH_OVERLAP_MS, STORM_QUIET_MS } from "../shared/strategy/dnet/rates.ts";

const NOW = 10_000_000;

function report(hostname: string, facts: Record<string, unknown> = {}): ReportHost {
  return { hostname, at: NOW, present: true, ...facts } as ReportHost;
}
function mapOf(...reports: ReportHost[]): DnetHosts {
  const hosts: DnetHosts = new Map();
  foldReports(hosts, reports, NOW);
  return hosts;
}

// --- planSpread --------------------------------------------------------------

describe("every refusal to spread is named, and the order is deepest first", () => {
  const candidate = (over: Partial<SpreadCandidate> & { host: string }): SpreadCandidate => ({
    from: "dn-1",
    hasCredential: true,
    agentAlive: false,
    freeRam: 16,
    ...over,
  });

  test("gone is never reported as anything else", () => {
    const plan = planSpread([candidate({ host: "dn-2", goneAt: NOW })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.plant).toEqual([]);
    expect(plan.refused[0]?.why).toBe("gone");
  });

  test("no-credential says it is a cracking failure, not a plant failure", () => {
    const plan = planSpread([candidate({ host: "dn-2", hasCredential: false })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.refused[0]?.why).toBe("no-credential");
    expect(plan.refused[0]?.detail).toContain("attempt, not a plant");
  });

  test("unknown RAM never reads as room", () => {
    const plan = planSpread([candidate({ host: "dn-2", freeRam: undefined })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.refused[0]?.why).toBe("unknown-ram");
  });

  test("a cramped blocked host boots the largest local reclaimer that fits", () => {
    const plan = planSpread(
      [candidate({ host: "dn-2", freeRam: 3, blockedRam: 12 })],
      DEFAULT_SPREAD_LIMITS,
      NOW,
    );
    expect(plan.plant).toHaveLength(1);
    expect(plan.plant[0]?.bootstrapReclaim).toBe(true);
    expect(plan.plant[0]?.bootstrapThreads).toBe(1);
  });

  test("nothing is refused for being far away, or for being the third one", () => {
    // The three deleted budgets: no host is ever refused for depth or count.
    const plan = planSpread(
      [
        candidate({ host: "a", depth: 1 }),
        candidate({ host: "b", depth: 30 }),
        candidate({ host: "c", depth: 3 }),
      ],
      DEFAULT_SPREAD_LIMITS,
      NOW,
    );
    expect(plan.plant.map((p) => p.host)).toEqual(["b", "c", "a"]);
    expect(plan.refused).toEqual([]);
  });

  test("a host that keeps restarting cannot absorb every worker", () => {
    const plan = planSpread(
      [candidate({ host: "dn-2", lastPlantAt: NOW - 1_000 })],
      DEFAULT_SPREAD_LIMITS,
      NOW,
    );
    expect(plan.refused[0]?.why).toBe("cooldown");
  });
});

describe("candidatesFrom reads vantages out of the live map", () => {
  test("a credential alone never creates a non-adjacent plant", () => {
    const hosts = mapOf(
      report("stand", { neighbours: ["adj"], maxRam: 16, blockedRam: 0, usedRam: 0 }),
      report("adj", { depth: 2, maxRam: 16, blockedRam: 0, usedRam: 0 }),
      report("far", { depth: 5, maxRam: 16, blockedRam: 0, usedRam: 0 }),
    );
    const out = candidatesFrom(hosts, NOW, {
      standing: new Set(["stand"]),
      vault: new Set(["adj", "far"]),
    });
    expect(out.map((c) => c.host)).toEqual(["adj"]);
    expect(out[0]?.from).toBe("stand");
  });

  test("a fresh backdoor replants from the roomiest resident without adjacency", () => {
    const hosts = mapOf(
      report("small", { neighbours: [], maxRam: 16, blockedRam: 0, usedRam: 12 }),
      report("big", { neighbours: [], maxRam: 64, blockedRam: 0, usedRam: 0 }),
      report("remote", { depth: 9, maxRam: 16, blockedRam: 0, usedRam: 0 }),
    );
    const out = candidatesFrom(hosts, NOW, {
      standing: new Set(["small", "big"]),
      vault: new Set(["remote"]),
      remoteExec: new Set(["remote"]),
      remoteVantages: [{ host: "small", freeGb: 4 }, { host: "big", freeGb: 64 }],
    });
    const remote = out.find((c) => c.host === "remote");
    expect(remote?.remote).toBe(true);
    expect(remote?.from).toBe("big");
  });
});

// --- planStorm ---------------------------------------------------------------

describe("the storm gates, in order", () => {
  const holder = (over: Partial<DnetHost> = {}): DnetHost => ({
    ...emptyHost("dn-5-1", NOW),
    stormSeed: true,
    agentAlive: true,
    blockedRam: 0,
    caches: [],
    ...over,
  });
  const green = (hostOver: Partial<DnetHost> = {}, ctxOver: Partial<StormContext> = {}): [DnetHost[], StormContext] => [
    [holder(hostOver)],
    {
      now: NOW,
      vault: new Set(["dn-5-1"]),
      stasisLinked: new Set(["dn-5-1"]),
      stasisLimit: 2,
      stasisLinkedCount: 2,
      pinsPending: false,
      walkInFlight: false,
      walkerPinned: false,
      labWalked: true,
      lastPhishCacheAt: NOW - 5_000,
      ...ctxOver,
    },
  ];

  test("all gates green admits exactly one fire, on the holder", () => {
    const [hosts, ctx] = green();
    const plan = planStorm(hosts, ctx);
    expect(plan.fire?.host).toBe("dn-5-1");
    expect(plan.fire?.from).toBe("dn-5-1");
    expect(plan.refused).toEqual([]);
  });

  test("storm-in-flight refuses inside the quiet window", () => {
    const [hosts, ctx] = green({}, { lastStormFiredAt: NOW - STORM_QUIET_MS + 1 });
    expect(planStorm(hosts, ctx).refused[0]?.why).toBe("storm-in-flight");
  });

  test("no-seed when nothing live holds one; explicit false does not admit", () => {
    const [, ctx] = green();
    expect(planStorm([holder({ stormSeed: false })], ctx).refused[0]?.why).toBe("no-seed");
  });

  test("seed-unreachable when the holder has no resident", () => {
    const [, ctx] = green();
    expect(planStorm([holder({ agentAlive: false })], ctx).refused[0]?.why).toBe("seed-unreachable");
  });

  test("harvest-incomplete on blocked RAM, unopened caches, no credential, or active harvest", () => {
    const [, ctx] = green();
    expect(planStorm([holder({ blockedRam: 4 })], ctx).refused[0]?.why).toBe("harvest-incomplete");
    expect(planStorm([holder({ caches: ["x.cache"] })], ctx).refused[0]?.why).toBe("harvest-incomplete");
    expect(planStorm([holder()], { ...ctx, vault: new Set() }).refused[0]?.why).toBe("harvest-incomplete");
    expect(planStorm([holder({ busy: new Set(["reclaim"]) })], ctx).refused[0]?.why).toBe("harvest-incomplete");
  });

  test("links-unspent while a slot is free or a pin is pending", () => {
    const [hosts, ctx] = green();
    expect(planStorm(hosts, { ...ctx, stasisLinkedCount: 1 }).refused[0]?.why).toBe("links-unspent");
    expect(planStorm(hosts, { ...ctx, pinsPending: true }).refused[0]?.why).toBe("links-unspent");
  });

  test("walker-unpinned holds a storm mid-walk until the finisher is pinned; a pinned finisher lets it fire", () => {
    const [hosts, ctx] = green();
    expect(planStorm(hosts, { ...ctx, labWalked: false, walkInFlight: true, walkerPinned: false }).refused[0]?.why)
      .toBe("walker-unpinned");
    expect(planStorm(hosts, { ...ctx, labWalked: false, walkInFlight: true, walkerPinned: true }).fire)
      .toBeDefined();
  });

  test("phish-window-open until a .d.cache has just landed", () => {
    const [hosts, ctx] = green();
    expect(planStorm(hosts, { ...ctx, lastPhishCacheAt: undefined }).refused[0]?.why).toBe("phish-window-open");
    expect(planStorm(hosts, { ...ctx, lastPhishCacheAt: NOW - STORM_PHISH_OVERLAP_MS - 1 }).refused[0]?.why)
      .toBe("phish-window-open");
  });

  test("a stasis-linked holder is preferred, then name order", () => {
    const [, ctx] = green();
    const plan = planStorm(
      [
        { ...emptyHost("dn-2-b", NOW), stormSeed: true, agentAlive: true, blockedRam: 0, caches: [] },
        { ...emptyHost("dn-9-a", NOW), stormSeed: true, agentAlive: true, blockedRam: 0, caches: [] },
      ],
      { ...ctx, vault: new Set(["dn-2-b", "dn-9-a"]), stasisLinked: new Set(["dn-9-a"]) },
    );
    expect(plan.fire?.host).toBe("dn-9-a");
  });
});

// --- deriveTasks -------------------------------------------------------------

describe("the queue is derived, so dedup needs no bookkeeping", () => {
  test("a fresh credentialled fact with a solvable model derives an attempt", () => {
    const hosts = mapOf(
      report("dn-0", { neighbours: ["dn-1"], depth: 0 }),
      report("dn-1", { depth: 1, modelId: "FreshInstall_1.0" }),
    );
    const tasks = deriveTasks(hosts, NOW, { agents: new Set(["dn-0"]) });
    const attempt = tasks.find((t) => t.kind === "attempt");
    expect(attempt?.host).toBe("dn-1");
    expect(attempt?.from).toBe("dn-0");
  });

  test("an unreachable host produces no task", () => {
    const hosts = mapOf(report("dn-1", { depth: 1, modelId: "FreshInstall_1.0" }));
    // Nobody is standing anywhere adjacent.
    expect(deriveTasks(hosts, NOW, { agents: new Set() })).toEqual([]);
  });

  test("work a live process is already doing derives no second task", () => {
    const hosts = mapOf(
      report("dn-0", { neighbours: ["dn-1"], depth: 0 }),
      report("dn-1", { depth: 1, modelId: "FreshInstall_1.0" }),
    );
    const inFlight = new Map([["dn-1", [{ from: "dn-0", kind: "attempt" as const }]]]);
    const tasks = deriveTasks(hosts, NOW, { agents: new Set(["dn-0"]), inFlight });
    expect(tasks.some((t) => t.kind === "attempt")).toBe(false);
  });

  test("plants, farm and hold entries are merged and sorted by priority", () => {
    const hosts = mapOf(report("dn-0", { depth: 0 }));
    const tasks = deriveTasks(hosts, NOW, {
      agents: new Set(["dn-0"]),
      plantable: [{ host: "dn-2", from: "dn-0" }],
      farm: [{ kind: "phish", host: "dn-0", threads: 2, reason: "earn" }],
      hold: [{ kind: "pin", host: "dn-0", from: "dn-0", reason: "pin the lab" }],
    });
    // pin (-1600) < plant (-1800)? plant is most urgent of these three.
    const kinds = tasks.map((t) => t.kind);
    expect(kinds.indexOf("plant")).toBeLessThan(kinds.indexOf("pin"));
    expect(kinds.indexOf("pin")).toBeLessThan(kinds.indexOf("phish"));
  });
});

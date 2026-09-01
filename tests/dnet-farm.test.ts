import { describe, expect, test } from "bun:test";
import {
  RECLAIM_CLEAR_BUDGET_MS,
  phishWindowOpen,
  planFarm,
  reclaimForecast,
  RECLAIM_MIN_PER_CALL_GB,
  type FarmHost,
  type FarmInputs,
  type FarmKind,
} from "../shared/strategy/dnet/farm.ts";
import {
  PHISH_CACHE_COOLDOWN_MS,
  phishCacheChance,
  phishCharismaExp,
  phishExpectedRates,
  phishMoney,
  phishMoneyChance,
  phishWaitMs,
  promoteExpectedCharismaExpPerSec,
  ramBlockRemoved,
} from "../shared/strategy/dnet/rates.ts";

/** The farm ladder: what a resident does with a host that has stopped teaching
 * us anything.
 *
 * Two things are worth testing here and they are not the same thing. One is that
 * the LADDER is a ladder — strictly ordered, one rung per host, and the order
 * argued rather than tuned. The other is that every rung it declines says so BY
 * NAME, which is the contract the spread policy had on paper and did not keep: its
 * refusals were computed and thrown away for months, so a planner with nothing
 * left to do was indistinguishable from one that had broken. */

const GB: Record<FarmKind, number> = { cache: 6.55, reclaim: 5.35, phish: 6.35, promote: 6.15 };
const NOW = 5_000_000;

function inputs(over: Partial<FarmInputs> = {}): FarmInputs {
  return {
    now: NOW,
    charisma: 200,
    gbPerThread: GB,
    wantedGb: 6.7,
    ...over,
  };
}

function host(over: Partial<FarmHost> = {}): FarmHost {
  return {
    host: "dn-1",
    depth: 3,
    difficulty: 3,
    blockedRam: 0,
    freeGb: 12,
    caches: [],
    ...over,
  };
}

/** At the default charisma this host fits enough threads for a clamped 100%
 * cache roll, leaving other residents free for isolated earn tests. */
const reserveHost = (over: Partial<FarmHost> = {}): FarmHost => host({
  host: "dn-reserve", depth: 30, difficulty: 10, freeGb: 900, ...over,
});

const kindsOf = (plan: ReturnType<typeof planFarm>): string[] => plan.tasks.map((task) => task.kind);
const reasonsOf = (plan: ReturnType<typeof planFarm>): string[] => plan.refused.map((refusal) => refusal.why);

describe("the ladder is strict, and takes the top rung it can", () => {
  test("a cache outranks a block and a phish, and it is the FILE that decides", () => {
    // A cache is first not because it pays most but because it is the only rung
    // whose payoff can be LOST: the file lives on the host, and a delete takes
    // the host's files with it.
    const plan = planFarm([host({ caches: ["b_222.cache", "a_111.cache"], blockedRam: 4 })], inputs());
    expect(kindsOf(plan)).toEqual(["cache"]);
    // Sorted, so the plan is deterministic and does not move under the panel.
    expect(plan.tasks[0]!.filename).toBe("a_111.cache");
    // ...and nothing else was even considered, because the ladder stops.
    expect(reasonsOf(plan)).toEqual([]);
  });

  test("with no cache, a worthwhile block outranks a phish — and says why not the cache", () => {
    const plan = planFarm([host({ blockedRam: 1 })], inputs());
    expect(kindsOf(plan)).toEqual(["reclaim"]);
    // The refusal it fell THROUGH is half the answer, and it is published.
    expect(reasonsOf(plan)).toEqual(["cache-none"]);
  });

  test("with neither, it phishes — and both skipped rungs are named", () => {
    const plan = planFarm([host()], inputs());
    expect(kindsOf(plan)).toEqual(["phish"]);
    expect(reasonsOf(plan)).toEqual(["cache-none", "reclaim-no-block"]);
  });

  test("an unknown cache listing blocks lower rungs until inventory proves it empty", () => {
    const plan = planFarm([host({ caches: undefined, blockedRam: 4 })], inputs());
    expect(plan.tasks).toEqual([]);
    expect(reasonsOf(plan)).toEqual(["cache-unknown"]);
  });

  test("completed atomic farm work is rederived while the same state remains desirable", () => {
    const snapshot = [host()];
    expect(kindsOf(planFarm(snapshot, inputs()))).toEqual(["phish"]);
    expect(kindsOf(planFarm(snapshot, inputs()))).toEqual(["phish"]);
  });

  test("one rung per host, never two", () => {
    const plan = planFarm(
      [host({ host: "dn-a", caches: ["x.cache"], blockedRam: 8 }), host({ host: "dn-b", blockedRam: 2 })],
      inputs(),
    );
    expect(plan.tasks.filter((t) => t.host === "dn-a")).toHaveLength(1);
    expect(plan.tasks.filter((t) => t.host === "dn-b")).toHaveLength(1);
  });

  test("work already in flight refuses by name rather than stacking a second job", () => {
    const plan = planFarm(
      [host({ caches: ["x.cache"], blockedRam: 4, busy: new Set<FarmKind>(["cache"]) })],
      inputs(),
    );
    // Falls to the next rung, and the reason the top one was skipped survives.
    expect(kindsOf(plan)).toEqual(["reclaim"]);
    expect(reasonsOf(plan)).toEqual(["cache-in-flight"]);
  });
});

describe("the labyrinth cache is the one that waits", () => {
  // `getLabReward` calls `Player.queueAugmentation` directly, and the generic
  // augmentation price multiplier is `1.9 ^ (queued non-SoA)` charged against
  // every purchase made after it — so opening one mid-shopping-trip multiplies
  // the rest of the cycle's bill AND invalidates the drainOrder the factions
  // planner froze underneath it.
  const lab = () => host({ host: "th3_l4byr1nth", isLab: true, caches: ["lab_1.cache"] });

  test("without home's permission it is deferred BY NAME, not silently skipped", () => {
    const plan = planFarm([lab()], inputs());
    expect(kindsOf(plan)).not.toContain("cache");
    expect(reasonsOf(plan)).toContain("cache-lab-deferred");
  });

  test("with permission it is opened like any other", () => {
    const plan = planFarm([lab()], inputs({ openLabCache: true }));
    expect(kindsOf(plan)).toEqual(["cache"]);
  });

  test("an ORDINARY cache is never deferred — holding it risks losing it for nothing", () => {
    // The lab is `isStationary` and therefore outside every pool a mutation
    // draws its victims from, so deferring its cache costs nothing. No other
    // host has that property: its files go when it does.
    const plan = planFarm([host({ caches: ["x.cache"] })], inputs());
    expect(kindsOf(plan)).toEqual(["cache"]);
  });

  test("the lab is never admitted to the cache reserve — its phish can never claim one", () => {
    // `handlePhishingAttack` excludes a labyrinth server from the cache branch
    // outright, so electing the deepest host would hand the window to a host
    // that cannot use it.
    const hosts = [host({ host: "dn-1", depth: 3 }), host({ host: "lab", depth: 30, isLab: true })];
    expect(planFarm(hosts, inputs()).cacheReserve?.hosts).toEqual(["dn-1"]);
  });
});

describe("propaganda is the bottom rung, and usually refused", () => {
  // `promoteStock` raises a symbol's VOLATILITY and never its forecast, so it
  // is symmetric and pays nothing on a symbol we have no view on. And its
  // charges decay 0.4x at every 75-tick market cycle, which makes it a
  // maintenance rate rather than a purchase. Both facts point the same way: it
  // is worth doing only when home has named a symbol, and only with what is
  // left after everything else.

  test("with no symbol it is refused BY NAME rather than skipped", () => {
    // The usual answer. A host that has nothing else to do and no symbol to
    // promote should read as "nothing worth doing here", not as a planner that
    // stopped producing tasks.
    const plan = planFarm([host({ freeGb: 6.2 })], inputs());
    expect(kindsOf(plan)).toEqual([]);
    expect(reasonsOf(plan)).toContain("promote-no-symbol");
  });

  test("it takes the host a phish cannot afford", () => {
    // 6.15 GB against 6.35: the window where propaganda is the only farm call
    // that fits. That is what "bottom rung" buys — a host too cramped for the
    // charisma engine is not a host with nothing to do.
    const plan = planFarm(
      [host({ freeGb: 6.2 })],
      inputs({ promoteSymbols: [{ symbol: "ECP", expectedProfit: 1e6 }] }),
    );
    expect(kindsOf(plan)).toEqual(["promote"]);
    // Candidate rates are priced at the threads that actually fit, so the
    // unaffordable action contributes zero and is never tried first.
    expect(reasonsOf(plan)).not.toContain("phish-no-room");
    expect(plan.tasks[0]!.symbol).toBe("ECP");
  });

  test("a phish still outranks it whenever both fit and the symbol's edge is small", () => {
    const plan = planFarm(
      [host({ freeGb: 12 })],
      inputs({ promoteSymbols: [{ symbol: "ECP", expectedProfit: 1e5 }] }),
    );
    expect(kindsOf(plan)).toEqual(["phish"]);
  });

  test("hosts are spread across the named symbols rather than piled on the first", () => {
    // The charge curve saturates — two exponentials approaching 4x — so the
    // second symbol's first charge is worth more than the first symbol's
    // hundredth.
    const cramped = (name: string) => host({ host: name, freeGb: 6.2 });
    const plan = planFarm(
      [cramped("dn-a"), cramped("dn-b"), cramped("dn-c")],
      inputs({
        promoteSymbols: [
          { symbol: "ECP", expectedProfit: 1e6 },
          { symbol: "MGCP", expectedProfit: 8e5 },
        ],
      }),
    );
    expect(plan.tasks.map((task) => task.symbol)).toEqual(["ECP", "MGCP", "ECP"]);
  });
});

describe("the reclaim rung is priced, not guessed", () => {
  test("a per-call figure that rounds to zero is a stall, and is named as one", () => {
    // `getRamBlockRemoved` passes through `roundToTwo`, so below ~0.005 GB a
    // call frees literally nothing and the grind is an infinite loop that pays
    // only charisma. At difficulty 30 and charisma 1 that is where we are.
    const forecast = reclaimForecast({ difficulty: 30, blockedRam: 16 }, 1);
    expect(forecast!.perCallGb).toBe(0);
    // Room for exactly ONE thread, which is what makes this a stall rather than
    // an under-priced grind: the verdict is reached at the thread count the job
    // would actually run at.
    const plan = planFarm([host({ difficulty: 30, blockedRam: 16, freeGb: 8 })], inputs({ charisma: 1 }));
    expect(reasonsOf(plan)).toContain("reclaim-grind-stalled");
    expect(plan.refused.find((r) => r.why === "reclaim-grind-stalled")!.detail).toContain("1 thread");
    expect(kindsOf(plan)).toEqual(["phish"]);
  });

  test("...and the SAME host is not stalled once it can afford a second thread", () => {
    // `getRamBlockRemoved` is linear in threads, so the stall is a property of
    // (host, charisma, THREADS) and not of the host alone. Pricing the rung at
    // one thread and then running it at what fits would refuse affordable work.
    const cramped = host({ difficulty: 30, blockedRam: 16, freeGb: 12 });
    expect(reclaimForecast(cramped, 1, 2)!.rawPerCallGb).toBeGreaterThan(RECLAIM_MIN_PER_CALL_GB);
    const plan = planFarm([cramped], inputs({ charisma: 1, wantedGb: 20 }));
    expect(kindsOf(plan)).toEqual(["reclaim"]);
    expect(plan.tasks[0]!.threads).toBe(2);
  });

  test("threads are taken from free RAM, unbounded but for the RAM itself", () => {
    // No default ceiling: a resident runs one job at a time, so RAM the grind
    // does not take is idle. A giant with an enormous block spends its whole
    // allocation on the one grind, which is exactly what "one thing per server
    // at max threads" asks for. A caller may still pass an explicit cap.
    const roomy = host({ difficulty: 2, blockedRam: 200, freeGb: 33 });
    expect(planFarm([roomy], inputs({ wantedGb: 100 })).tasks[0]!.threads).toBe(6);
    const huge = host({ difficulty: 2, blockedRam: 200, freeGb: 400 });
    // floor(400 / 5.35) = 74, the whole host.
    expect(planFarm([huge], inputs({ wantedGb: 500 })).tasks[0]!.threads).toBe(74);
    expect(planFarm([huge], inputs({ wantedGb: 500, maxReclaimThreads: 3 })).tasks[0]!.threads).toBe(3);
  });

  test("an unpriceable grind is refused rather than attempted", () => {
    const plan = planFarm([host({ difficulty: undefined, blockedRam: 4 })], inputs());
    expect(reasonsOf(plan)).toContain("reclaim-grind-stalled");
  });

  test("a roomy host with a hopeless block is left alone, with the arithmetic shown", () => {
    // Two ways a grind earns its wall clock: we NEED the RAM, or we can actually
    // clear the block and collect the free `.cache` at the end of it. This host
    // has neither.
    const big = host({ difficulty: 6, blockedRam: 60, freeGb: 40 });
    const forecast = reclaimForecast(big, 200)!;
    expect(forecast.clearMs).toBeGreaterThan(RECLAIM_CLEAR_BUDGET_MS);
    const plan = planFarm([big], inputs());
    expect(kindsOf(plan)).toEqual(["phish"]);
    const refusal = plan.refused.find((r) => r.why === "reclaim-not-needed")!;
    expect(refusal.detail).toContain("60.00GB");
  });

  test("...but the SAME block is ground when the host is cramped", () => {
    // The only difference is how much room is left, which is exactly the term
    // that makes the grind worth its wall clock.
    const plan = planFarm([host({ difficulty: 6, blockedRam: 60, freeGb: 6 })], inputs());
    expect(kindsOf(plan)).toEqual(["reclaim"]);
    expect(plan.tasks[0]!.reason).toContain("cramped");
  });

  test("a block that can be cleared inside the budget is ground for the cache", () => {
    const small = host({ difficulty: 2, blockedRam: 0.5, freeGb: 40 });
    expect(reclaimForecast(small, 200)!.clearMs).toBeLessThan(RECLAIM_CLEAR_BUDGET_MS);
    const plan = planFarm([small], inputs());
    expect(kindsOf(plan)).toEqual(["reclaim"]);
    expect(plan.tasks[0]!.reason).toContain(".cache");
  });

  test("a host too full to run the cure is refused by name, not skipped", () => {
    // The nastiest case out here: the block is what is stopping us from running
    // the job that would remove the block.
    const plan = planFarm([host({ difficulty: 2, blockedRam: 12, freeGb: 4 })], inputs());
    expect(reasonsOf(plan)).toContain("reclaim-no-room");
    expect(plan.refused.find((r) => r.why === "reclaim-no-room")!.detail).toContain("hostage");
    // ...and it cannot phish either, at 6.35 GB a thread.
    expect(plan.tasks).toEqual([]);
    expect(reasonsOf(plan)).toContain("phish-no-room");
  });
});

describe("the continuous phishing reserve", () => {
  const crew = () => [
    host({ host: "dn-shallow", depth: 1, freeGb: 40 }),
    host({ host: "dn-deep", depth: 9, freeGb: 40 }),
    host({ host: "dn-mid", depth: 4, freeGb: 40 }),
  ];

  test("a certain host is the whole reserve, with reward quality breaking ties", () => {
    const plan = planFarm([
      reserveHost({ host: "shallow", difficulty: 3, depth: 20 }),
      reserveHost({ host: "quality", difficulty: 8, depth: 2 }),
    ], inputs());
    expect(plan.cacheReserve).toEqual({
      hosts: ["quality"], targetChance: 1, combinedChance: 1, guaranteed: true,
    });
  });

  test("sub-certain rolls use the smallest highest-probability set that reaches 95%", () => {
    // 680GB fits 107 threads: p=0.8025 at charisma 200. Two calls combine to
    // 96.10%, so the third resident remains outside the reserve.
    const plan = planFarm([
      host({ host: "a", freeGb: 680, difficulty: 1 }),
      host({ host: "b", freeGb: 680, difficulty: 2 }),
      host({ host: "c", freeGb: 680, difficulty: 3 }),
    ], inputs());
    expect(plan.cacheReserve?.hosts).toEqual(["c", "b"]);
    expect(plan.cacheReserve?.combinedChance).toBeCloseTo(1 - 0.1975 ** 2, 12);
    expect(plan.cacheReserve?.targetChance).toBe(0.95);
    expect(plan.cacheReserve?.guaranteed).toBe(false);
  });

  test("an undersized fleet reserves everyone and reports the attainable chance", () => {
    const plan = planFarm(crew(), inputs());
    expect(plan.cacheReserve?.hosts).toEqual(["dn-deep", "dn-mid", "dn-shallow"]);
    expect(plan.cacheReserve?.combinedChance).toBeLessThan(0.95);
    expect(plan.tasks.every((task) => task.kind === "phish" && task.threads === 6)).toBe(true);
  });

  test("the reserve stays phishing while the cache window is shut", () => {
    const shut = planFarm(crew(), inputs({ lastPhishCacheAt: NOW - 1_000 }));
    expect(shut.tasks.every((task) => task.threads === 6)).toBe(true);
    expect(shut.tasks.every((task) => task.reason.includes("window is shut"))).toBe(true);
  });

  test("the window is believed open when we have never seen one land", () => {
    // Never having seen a `.d.cache` reads as OPEN, which is the direction that
    // costs nothing: the call is made either way, and a closed window merely
    // falls through to the money roll.
    expect(phishWindowOpen({ now: NOW })).toBe(true);
    expect(phishWindowOpen({ now: NOW, lastPhishCacheAt: NOW - PHISH_CACHE_COOLDOWN_MS })).toBe(false);
    expect(phishWindowOpen({ now: NOW, lastPhishCacheAt: NOW - PHISH_CACHE_COOLDOWN_MS - 1 })).toBe(true);
  });

  test("threads are bounded by RAM, because ramOverride is charged PER THREAD", () => {
    // 14 GB against a 6.35 GB phish is two threads, not four.
    const cramped = [host({ host: "dn-deep", depth: 9, freeGb: 14 })];
    expect(planFarm(cramped, inputs()).tasks[0]!.threads).toBe(2);
  });

  test("roll size outranks difficulty when reaching the probability floor", () => {
    const plan = planFarm([
      host({ host: "low", difficulty: 3, depth: 20, freeGb: 680 }),
      host({ host: "quality", difficulty: 8, depth: 2, freeGb: 340 }),
      host({ host: "other", difficulty: 7, depth: 3, freeGb: 340 }),
    ], inputs());
    expect(plan.cacheReserve?.hosts[0]).toBe("low");
  });

  test("difficulty never overrides the balanced decision outside the reserve", () => {
    const plan = planFarm([
      reserveHost(),
      host({ host: "low", difficulty: 1, depth: 25, freeGb: 12 }),
    ], inputs({
      promoteSymbols: [{ symbol: "ECP", expectedProfit: 1 }],
    }));
    expect(plan.tasks.find((task) => task.host === "low")?.kind).toBe("phish");
  });

  test("stock-plan startup changes only the residual choice, never the reserve", () => {
    const fleet = [reserveHost(), host({ host: "dn-earner", freeGb: 12 })];
    const startup = planFarm(fleet, inputs({ lastPhishCacheAt: NOW - 1_000 }));
    const configured = planFarm(fleet, inputs({
      lastPhishCacheAt: NOW - 1_000,
      promoteSymbols: [{ symbol: "ECP", expectedProfit: 1e9 }],
    }));
    expect(startup.cacheReserve).toEqual(configured.cacheReserve);
    expect(startup.tasks.find((task) => task.host === "dn-earner")?.kind).toBe("phish");
    expect(configured.tasks.find((task) => task.host === "dn-earner")?.kind).toBe("promote");
  });
});

describe("a cramped block is ground from next door", () => {
  // `memoryReallocation` reaches an authenticated, directly connected
  // neighbour, and the cross-host call is the one that pays the admin-rights
  // check — so the helper path is gated on the target's credential and proved
  // from the HELPER's own fresh adjacency.
  const cramped = () =>
    host({ host: "dn-tight", difficulty: 2, blockedRam: 12, freeGb: 4, hasCredential: true });
  const helper = (over: Partial<FarmHost> = {}) =>
    host({ host: "dn-roomy", freeGb: 40, neighbours: ["dn-tight"], ...over });

  test("an unstaffed target can be reclaimed without an invented cache listing", () => {
    const target = host({
      host: "dn-target",
      blockedRam: 4,
      freeGb: 0,
      caches: undefined,
      reclaimOnly: true,
      hasCredential: true,
    });
    const neighbour = host({
      host: "dn-helper",
      blockedRam: 0,
      freeGb: 12,
      neighbours: ["dn-target"],
    });
    const plan = planFarm([target, neighbour], inputs());
    expect(plan.tasks).toContainEqual(expect.objectContaining({
      kind: "reclaim",
      host: "dn-target",
      from: "dn-helper",
    }));
    expect(plan.refused.some((refusal) => refusal.host === "dn-target" && refusal.why === "cache-unknown")).toBe(false);
  });

  test("a target that cannot afford its own cure is ground remotely by a credentialed neighbour", () => {
    const plan = planFarm([cramped(), helper()], inputs());
    const remote = plan.tasks.find((task) => task.host === "dn-tight")!;
    expect(remote.kind).toBe("reclaim");
    expect(remote.from).toBe("dn-roomy");
    expect(plan.cacheReserve?.hosts ?? []).not.toContain("dn-roomy");
    // Threads come from the HELPER's room: floor(40 / 5.35) = 7.
    expect(remote.threads).toBe(7);
    expect(remote.reason).toContain("dn-roomy");
  });

  test("without the target's password the hostage refusal stands, and says why", () => {
    const plan = planFarm([{ ...cramped(), hasCredential: false }, helper()], inputs());
    expect(plan.tasks.find((task) => task.host === "dn-tight")).toBeUndefined();
    const refusal = plan.refused.find((r) => r.host === "dn-tight" && r.why === "reclaim-no-room")!;
    expect(refusal.detail).toContain("hostage");
    expect(refusal.detail).toContain("password");
  });

  test("a grind already in flight against the target admits no remote double", () => {
    const busyTarget = { ...cramped(), busy: new Set<FarmKind>(["reclaim"]) };
    const plan = planFarm([busyTarget, helper()], inputs());
    expect(plan.tasks.find((task) => task.host === "dn-tight")).toBeUndefined();
    expect(reasonsOf(plan)).toContain("reclaim-in-flight");
  });

  test("the election is deterministic: most free RAM, ties by name", () => {
    const plan = planFarm(
      [cramped(), helper({ host: "dn-b", freeGb: 20 }), helper({ host: "dn-a", freeGb: 40 })],
      inputs(),
    );
    expect(plan.tasks.find((task) => task.host === "dn-tight")!.from).toBe("dn-a");
    const tied = planFarm(
      [cramped(), helper({ host: "dn-b", freeGb: 20 }), helper({ host: "dn-a", freeGb: 20 })],
      inputs(),
    );
    expect(tied.tasks.find((task) => task.host === "dn-tight")!.from).toBe("dn-a");
  });

  test("self wins whenever it affords as many threads — the free case stays the default", () => {
    // Both sides afford two threads, so the free self-hosted case wins.
    const selfSufficient = host({
      host: "dn-tight", difficulty: 2, blockedRam: 12, freeGb: 12, hasCredential: true,
    });
    const plan = planFarm([selfSufficient, helper({ freeGb: 12 })], inputs({ wantedGb: 20 }));
    const grind = plan.tasks.find((task) => task.host === "dn-tight")!;
    expect(grind.from).toBeUndefined();
    expect(grind.threads).toBe(2);
  });

  test("a helper with MORE threads takes over even when self affords a few", () => {
    const plan = planFarm(
      [host({ host: "dn-tight", difficulty: 2, blockedRam: 30, freeGb: 12, hasCredential: true }),
        helper()],
      inputs({ wantedGb: 20 }),
    );
    const grind = plan.tasks.find((task) => task.host === "dn-tight")!;
    expect(grind.from).toBe("dn-roomy");
    expect(grind.threads).toBe(7);
  });
});

describe("the walker candidate is ground from every able vantage", () => {
  test("the production path gangs the candidate without a policy toggle", () => {
    const target = host({
      host: "dn-walker",
      difficulty: 2,
      blockedRam: 12,
      freeGb: 12,
      hasCredential: true,
    });
    const neighbour = host({
      host: "dn-helper",
      freeGb: 40,
      neighbours: ["dn-walker"],
    });
    const plan = planFarm([target, neighbour], inputs({ walkerCandidate: "dn-walker" }));
    const grinders = plan.tasks.filter((task) => task.kind === "reclaim" && task.host === "dn-walker");
    expect(grinders).toHaveLength(2);
    expect(grinders.every((task) => task.gang === true)).toBe(true);
    expect(grinders.map((task) => task.from ?? task.host).sort()).toEqual(["dn-helper", "dn-walker"]);
  });

});

describe("phish and promote compete on expected value", () => {
  // The one place the ladder is an exchange rate: phish's $/ms is priced from
  // the engine's own formulas (weighted 1.5x for the charisma exp every call
  // pays), promote's from home's expectedProfit scaled by PROMOTE_PROFIT_SHARE.
  // At the fixtures' charisma 200 and depth 3 the break-even sits near a ~$26m
  // position, rising with depth — the money term phish has and promote lacks.
  const rich = [{ symbol: "ECP", expectedProfit: 1e9 }];

  test("a big enough edge flips a host to promote even with room for both", () => {
    const plan = planFarm([reserveHost(), host({ host: "dn-earner", freeGb: 12 })], inputs({
      promoteSymbols: rich,
      lastPhishCacheAt: NOW - 1_000,
    }));
    expect(plan.tasks.find((task) => task.host === "dn-earner")?.kind).toBe("promote");
  });

  test("the reserve phishes continuously whatever the arithmetic says", () => {
    const plan = planFarm([host({ freeGb: 30 })], inputs({ promoteSymbols: rich }));
    const task = plan.tasks[0]!;
    expect(task.kind).toBe("phish");
    expect(task.threads).toBe(4);
    expect(task.reason).toContain("cache reserve");
  });

  test("depth is phish's term: the same edge loses to a deep host and wins on a shallow one", () => {
    // $50m: above the shallow break-even (~$26m), below the deep one (~$140m).
    const plan = planFarm(
      [
        reserveHost(),
        host({ host: "dn-shallow", depth: 3, freeGb: 12 }),
        host({ host: "dn-deep", depth: 25, freeGb: 12 }),
      ],
      inputs({
        promoteSymbols: [{ symbol: "ECP", expectedProfit: 5e7 }],
        lastPhishCacheAt: NOW - 1_000,
      }),
    );
    const byHost = new Map(plan.tasks.map((task) => [task.host, task.kind]));
    expect(byHost.get("dn-shallow")).toBe("promote");
    expect(byHost.get("dn-deep")).toBe("phish");
  });

  test("a preferred action already in flight does not queue the loser", () => {
    const plan = planFarm(
      [reserveHost(), host({ host: "dn-earner", freeGb: 12, busy: new Set<FarmKind>(["promote"]) })],
      inputs({ promoteSymbols: rich, lastPhishCacheAt: NOW - 1_000 }),
    );
    expect(plan.tasks.some((task) => task.host === "dn-earner")).toBe(false);
    expect(reasonsOf(plan)).toContain("promote-in-flight");
  });

  test("promotion is priced from the symbol actually assigned to the host", () => {
    const plan = planFarm([
      reserveHost(),
      host({ host: "dn-first", depth: 5, freeGb: 12 }),
      host({ host: "dn-second", depth: 4, freeGb: 12 }),
    ], inputs({
      promoteSymbols: [
        { symbol: "ECP", expectedProfit: 1e9 },
        { symbol: "MGCP", expectedProfit: 1 },
      ],
      lastPhishCacheAt: NOW - 1_000,
      economics: { moneyWorthSec: 300, charismaWorthSec: 0 },
    }));
    expect(plan.tasks.find((task) => task.host === "dn-first")?.kind).toBe("promote");
    expect(plan.tasks.find((task) => task.host === "dn-first")?.symbol).toBe("ECP");
    expect(plan.tasks.find((task) => task.host === "dn-second")?.kind).toBe("phish");
  });

  test("without a priced symbol phishing wins directly", () => {
    // With nothing on promote's side of the scale, phish wins the comparison
    // outright — and an admitted winner means the loser's rung is never
    // reached, so no irrelevant promotion refusal is published.
    const plan = planFarm([host({ freeGb: 12 })], inputs({ lastPhishCacheAt: NOW - 1_000 }));
    expect(kindsOf(plan)).toEqual(["phish"]);
    expect(reasonsOf(plan)).not.toContain("promote-no-symbol");
  });
});

describe("the transcribed formulas", () => {
  test("expected phishing XP follows cache, money, and quarter-rate failure branches", () => {
    const shut = phishExpectedRates({ depth: 4, threads: 2, charisma: 200, cacheWindowOpen: false });
    const open = phishExpectedRates({ depth: 4, threads: 2, charisma: 200, cacheWindowOpen: true });
    const waitSec = phishWaitMs(200) / 1_000;
    const cacheChance = phishCacheChance(2, 200);
    const moneyChance = phishMoneyChance(200);
    const moneyPerSuccess = phishMoney(4, 2, 200);
    expect(shut.moneyPerSec).toBeCloseTo(moneyChance * moneyPerSuccess / waitSec, 12);
    expect(open.moneyPerSec).toBeCloseTo((1 - cacheChance) * moneyChance * moneyPerSuccess / waitSec, 12);
    expect(shut.charismaExpPerSec).toBeCloseTo(
      phishCharismaExp(2) * (0.25 + 0.75 * moneyChance) / waitSec,
      12,
    );
    expect(open.charismaExpPerSec).toBeCloseTo(
      phishCharismaExp(2) * (0.25 + 0.75 * (cacheChance + (1 - cacheChance) * moneyChance)) / waitSec,
      12,
    );
  });

  test("promotion commonly beats phishing for charisma at mature skill", () => {
    const phish = phishExpectedRates({ depth: 4, threads: 1, charisma: 569, cacheWindowOpen: false });
    expect(promoteExpectedCharismaExpPerSec(1, 569)).toBeGreaterThan(phish.charismaExpPerSec);
  });

  test("a live charisma gate can flip the priced action without erasing money", () => {
    const base = {
      promoteSymbols: [{ symbol: "ECP", expectedProfit: 1e4 }],
      lastPhishCacheAt: NOW - 1_000,
      economics: { bestMoneyPerSec: 1_000, bestCharismaExpPerSec: 10, moneyWorthSec: 3_000, charismaWorthSec: 300 },
    } satisfies Partial<FarmInputs>;
    const earner = host({ host: "dn-earner", depth: 20, freeGb: 12 });
    const ungated = planFarm([reserveHost(), earner], inputs(base));
    const gated = planFarm([reserveHost(), earner], inputs({
      ...base,
      economics: { ...base.economics, charismaWorthSec: 300_000 },
    }));
    expect(ungated.tasks.find((task) => task.host === "dn-earner")?.kind).toBe("phish");
    expect(gated.tasks.find((task) => task.host === "dn-earner")?.kind).toBe("promote");
  });

  test("getRamBlockRemoved clamps to the block and rounds to two places", () => {
    // Depth 3, one thread, 200 charisma. Upstream's
    // 0.02 * 2 * 0.92^(d+1) * threads * (1 + cha/100) lands on 0.08596..., and
    // roundToTwo pins it at the value below. Any coefficient drift moves it.
    expect(ramBlockRemoved(3, 99, 1, 200)).toBe(0.09);
    // The last call of a grind frees exactly the remainder, never more.
    expect(ramBlockRemoved(3, 0.01, 1, 200)).toBe(0.01);
    expect(ramBlockRemoved(3, 0, 1, 200)).toBe(0);
  });
});

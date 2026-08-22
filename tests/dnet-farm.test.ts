import { describe, expect, test } from "bun:test";
import { JOB_METHODS, ROUTINE_JOB_KINDS } from "../game/dnet/realm.ts";
import {
  FARM_BATCH_MS,
  RECLAIM_CLEAR_BUDGET_MS,
  batchHasRoom,
  electCacheHunter,
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
  phishWaitMs,
  ramBlockRemoved,
  reclaimWaitMs,
} from "../shared/strategy/dnet/rates.ts";

/** The farm ladder: what a resident does with a host that has stopped teaching
 * us anything.
 *
 * Two things are worth testing here and they are not the same thing. One is that
 * the LADDER is a ladder — strictly ordered, one rung per host, and the order
 * argued rather than tuned. The other is that every rung it declines says so BY
 * NAME, which is the contract `spread.ts` had on paper and did not keep: its
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

  test("one rung per host, never two", () => {
    const plan = planFarm(
      [host({ host: "dn-a", caches: ["x.cache"], blockedRam: 8 }), host({ host: "dn-b", blockedRam: 2 })],
      inputs(),
    );
    expect(plan.tasks.filter((t) => t.host === "dn-a")).toHaveLength(1);
    expect(plan.tasks.filter((t) => t.host === "dn-b")).toHaveLength(1);
  });

  test("a gone host is refused first and nothing else is said about it", () => {
    const plan = planFarm([host({ goneAt: NOW - 1, caches: ["x.cache"], blockedRam: 9 })], inputs());
    expect(plan.tasks).toEqual([]);
    expect(reasonsOf(plan)).toEqual(["gone"]);
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

  test("the lab is never elected cache hunter — its phish can never claim one", () => {
    // `handlePhishingAttack` excludes a labyrinth server from the cache branch
    // outright, so electing the deepest host would hand the window to a host
    // that cannot use it.
    const hosts = [host({ host: "dn-1", depth: 3 }), host({ host: "lab", depth: 30, isLab: true })];
    expect(electCacheHunter(hosts)).toBe("dn-1");
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
    const plan = planFarm([host({ freeGb: 6.2 })], inputs({ promoteSymbols: ["ECP"] }));
    expect(kindsOf(plan)).toEqual(["promote"]);
    expect(reasonsOf(plan)).toContain("phish-no-room");
    expect(plan.tasks[0]!.symbol).toBe("ECP");
  });

  test("a phish still outranks it whenever both fit", () => {
    const plan = planFarm([host({ freeGb: 12 })], inputs({ promoteSymbols: ["ECP"] }));
    expect(kindsOf(plan)).toEqual(["phish"]);
  });

  test("hosts are spread across the named symbols rather than piled on the first", () => {
    // The charge curve saturates — two exponentials approaching 4x — so the
    // second symbol's first charge is worth more than the first symbol's
    // hundredth.
    const cramped = (name: string) => host({ host: name, freeGb: 6.2 });
    const plan = planFarm(
      [cramped("dn-a"), cramped("dn-b"), cramped("dn-c")],
      inputs({ promoteSymbols: ["ECP", "MGCP"] }),
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
    // one thread and then running it at what fits would refuse work that was
    // affordable all along — which is the bug this ordering exists to stop.
    const cramped = host({ difficulty: 30, blockedRam: 16, freeGb: 12 });
    expect(reclaimForecast(cramped, 1, 2)!.rawPerCallGb).toBeGreaterThan(RECLAIM_MIN_PER_CALL_GB);
    const plan = planFarm([cramped], inputs({ charisma: 1, wantedGb: 20 }));
    expect(kindsOf(plan)).toEqual(["reclaim"]);
    expect(plan.tasks[0]!.threads).toBe(2);
  });

  test("threads are taken from free RAM and capped", () => {
    // The cap is not the binding constraint and is not meant to be: RAM runs
    // out first on every host a resident stands on. It is there so a host with
    // an enormous block cannot spend its entire allocation on one grind.
    const roomy = host({ difficulty: 2, blockedRam: 200, freeGb: 33 });
    expect(planFarm([roomy], inputs({ wantedGb: 100 })).tasks[0]!.threads).toBe(6);
    const huge = host({ difficulty: 2, blockedRam: 200, freeGb: 400 });
    expect(planFarm([huge], inputs({ wantedGb: 500 })).tasks[0]!.threads).toBe(8);
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

describe("exactly one host hunts the cache window", () => {
  // There is ONE `.d.cache` every three minutes for the whole net —
  // `lastPhishingCacheTime` lives on DarknetState, not on a server — and the
  // roll that claims it scales with threads. So two hosts rolling at one thread
  // each is strictly worse than one host rolling at two, and spreading threads
  // evenly is the mistake this encodes against.
  const crew = () => [
    host({ host: "dn-shallow", depth: 1, freeGb: 40 }),
    host({ host: "dn-deep", depth: 9, freeGb: 40 }),
    host({ host: "dn-mid", depth: 4, freeGb: 40 }),
  ];

  test("the deepest resident is elected, and depth is also the money term", () => {
    // `0.1 + depth * 0.05`, so the same host is the best one to spend threads on
    // when the window is shut.
    expect(electCacheHunter(crew())).toBe("dn-deep");
  });

  test("the election is deterministic under a tie", () => {
    const tied = [host({ host: "b", depth: 5, freeGb: 10 }), host({ host: "a", depth: 5, freeGb: 10 })];
    expect(electCacheHunter(tied)).toBe("a");
    // ...and free RAM breaks a depth tie before the name does.
    expect(electCacheHunter([...tied, host({ host: "c", depth: 5, freeGb: 99 })])).toBe("c");
  });

  test("only the hunter spends threads, and only while the window is open", () => {
    const open = planFarm(crew(), inputs());
    expect(open.cacheHunter).toBe("dn-deep");
    const byHost = new Map(open.tasks.map((task) => [task.host, task]));
    expect(byHost.get("dn-deep")!.threads).toBeGreaterThan(1);
    expect(byHost.get("dn-mid")!.threads).toBe(1);
    expect(byHost.get("dn-shallow")!.threads).toBe(1);
  });

  test("a shut window drops the hunter back to one thread", () => {
    const shut = planFarm(crew(), inputs({ lastPhishCacheAt: NOW - 1_000 }));
    expect(shut.tasks.every((task) => task.threads === 1)).toBe(true);
    expect(shut.tasks.find((t) => t.host === "dn-deep")!.reason).toContain("window shut");
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
});

describe("a farm job is a bounded batch, not an open-ended loop", () => {
  // Bounded rather than long-lived, so `longLived` — and the beat that has to go
  // with it — ends up with exactly one user, the maze walker. And bounded well
  // under JOB_TIMEOUT_MS, so a host is never held away from a plant for longer
  // than an attempt job would hold it anyway.
  test("the batch checks BEFORE the call, since the wait is known in advance", () => {
    const wait = phishWaitMs(200);
    // Room for the call that would end exactly on the boundary...
    expect(batchHasRoom("phish", 0, FARM_BATCH_MS - wait, 200)).toBe(true);
    // ...and none for the one that would overrun it by a millisecond.
    expect(batchHasRoom("phish", 0, FARM_BATCH_MS - wait + 1, 200)).toBe(false);
  });

  test("each kind is bounded by its OWN wait, which charisma shortens", () => {
    expect(reclaimWaitMs(0)).toBe(8000);
    expect(phishWaitMs(0)).toBe(10000);
    // Both floor at 200 ms however high charisma goes.
    expect(reclaimWaitMs(1e9)).toBe(200);
    expect(phishWaitMs(1e9)).toBe(200);
    // A high-charisma grind therefore fits many more calls in one batch.
    expect(batchHasRoom("reclaim", 0, FARM_BATCH_MS - 300, 1e9)).toBe(true);
    expect(batchHasRoom("reclaim", 0, FARM_BATCH_MS - 300, 0)).toBe(false);
  });
});

describe("the transcribed formulas, against upstream's own arithmetic", () => {
  test("getRamBlockRemoved clamps to the block and rounds to two places", () => {
    // 0.02 * 2 * 0.92^(d+1) * threads * (1 + cha/100), clamped, roundToTwo.
    const raw = 0.02 * 2 * 0.92 ** 4 * 1 * (1 + 200 / 100);
    expect(ramBlockRemoved(3, 99, 1, 200)).toBe(Math.round(raw * 100) / 100);
    // The last call of a grind frees exactly the remainder, never more.
    expect(ramBlockRemoved(3, 0.01, 1, 200)).toBe(0.01);
    expect(ramBlockRemoved(3, 0, 1, 200)).toBe(0);
  });
});

describe("a deliberate one-off does not become the net's RAM target", () => {
  // `planFarm`'s `wantedGb` means "the heaviest thing a host should be able to
  // hold", and the controller computes it from the declared job budgets. Taking
  // the max over EVERY kind silently redefines it the moment a heavy one-off is
  // added — and a stasis pin is heavy: `setStasisLink` alone is 12 GB, more than
  // a shallow darknet host's entire 16.
  //
  // The consequence would be quiet and total: every host in the net reads as
  // cramped, `reclaim-not-needed` never fires again, and the ladder sets the
  // whole net grinding RAM it has no use for. So the set is named rather than
  // inferred, and this is the test that keeps it named.
  test("ROUTINE_JOB_KINDS is exactly the work a resident does as a matter of course", () => {
    expect([...ROUTINE_JOB_KINDS].sort())
      .toEqual(["attempt", "bleed", "cache", "phish", "plant", "reclaim", "survey"]);
    // Every routine kind must actually be declared, or its budget silently
    // reads as 0 and the target collapses.
    for (const kind of ROUTINE_JOB_KINDS) {
      expect(JOB_METHODS[kind], `${kind} is routine but declares no methods`).toBeDefined();
    }
  });

  test("the RAM target ignores kinds outside the routine set", () => {
    // The arithmetic the controller does, with a one-off an order of magnitude
    // heavier than anything routine.
    const budgets: Record<string, number> = {
      survey: 4.0, bleed: 4.2, attempt: 4.6, plant: 7.6,
      cache: 6.0, reclaim: 5.0, phish: 6.0,
      pin: 16.15,
    };
    const target = Math.max(...ROUTINE_JOB_KINDS.map((kind) => budgets[kind] ?? 0));

    expect(target).toBe(7.6);
    expect(target).toBeLessThan(budgets["pin"]!);
    // And the naive version, for contrast — this is the number that would have
    // marked the whole net cramped.
    expect(Math.max(...Object.values(budgets))).toBe(16.15);
  });
});

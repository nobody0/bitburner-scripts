import { describe, expect, test } from "bun:test";
import {
  ATTEMPT_GB,
  assertFreshSpreadNet,
  crackAttemptsFor,
  generateNet,
  PROBER_ARMOURED_SIM_GB,
  PROBER_GB,
  PROBER_STASIS_GB,
  runSpreadCase,
  summarizeSpreadRuns,
} from "../dnet-spread.ts";
import { canPreempt, isSameTurn } from "../../shared/strategy/dnet/jobs.ts";
import { PROBER_GB as PRODUCTION_PROBER_GB } from "../../game/dnet/shared.ts";

/** The reach-the-lab lane's CI mirror: sane bounds on the production strategy
 * over seeded fresh Dnets, plus the pricing and priority facts the arena leans
 * on. The full sweep lives in `tools/dnet-spread-benchmark.ts`
 * (`bun run bench:sim:dnet-spread`). */

const SEEDS = Array.from({ length: 12 }, (_, index) => index + 1);

const shallow = SEEDS.map((seed) => {
  const net = generateNet(seed);
  return { net, run: runSpreadCase(net) };
});
const runs = shallow.map(({ run }) => run);

describe("the reach-the-lab arena", () => {
  test("the production strategy places a startable walker on every seed", () => {
    for (const { net, run } of shallow) {
      expect(run.solved, `${run.caseId} seed run failed: ${run.reason ?? ""}`).toBe(true);
      expect(run.walkerThreads!).toBeGreaterThanOrEqual(2);
      expect(run.walkerTarget).toBe(net.system.currentLab()!.hostname);
      expect(run.walkerFrom).toBeDefined();
      const vantage = net.system.record(run.walkerFrom!);
      expect(vantage?.stasisLinked).toBe(true);
      expect(vantage?.blockedRam).toBe(0);
      // ROOTED is the invariant; a live session is not. Sessions are PID-keyed
      // and `removeExpiredSessions` prunes them as their holders exit, so
      // whether one happens to be open at the final instant depends on which
      // process last touched the host. Admin rights are what actually makes the
      // walker's `exec` legal, and the stasis link keeps it reachable.
      expect(net.world.servers.get(run.walkerFrom!)?.hasAdminRights).toBe(true);
    }
  });

  test("the fixture is a fresh Dnet and starts exactly at the lab charisma gate", () => {
    const net = generateNet(101, { augs: 3 });
    expect(() => assertFreshSpreadNet(net)).not.toThrow();
    expect(net.world.clock.now()).toBe(0);
    expect(net.system.mutations).toBe(0);
    for (const host of net.system.hosts.values()) {
      expect(host.sessions.size).toBe(0);
      expect(host.stasisLinked).toBe(false);
      if (!host.isStationary) expect(net.world.servers.get(host.hostname)?.hasAdminRights).toBe(false);
    }
    const run = runSpreadCase(net, 3 * 60 * 60 * 1000);
    expect(run.startingCharisma).toBe(run.labRequiredCharisma);
    expect(run.labRequiredCharisma).toBe(net.system.currentLab()!.cha);
  }, 30_000);

  test("the road from cold start to walker stays inside sane bounds", () => {
    const summary = summarizeSpreadRuns(runs);
    // First crack within a minute: darkweb's shallow neighbours hold trivially
    // solvable models, and a first crack an hour in would mean the attempt
    // pipeline is broken, not slow.
    expect(summary.meanMsToFirstCrack).toBeLessThan(60_000);
    // The walker startable within half an hour of a cold start, on average.
    expect(summary.meanMsToWalkerStart).toBeLessThan(30 * 60_000);
    expect(summary.meanMsLabToWalkerStart).toBeGreaterThanOrEqual(0);
    expect(summary.meanMsLabToWalkerStart).toBeLessThan(summary.meanMsToWalkerStart);
    // Spreading actually spread: a healthy run stands agents on dozens of
    // hosts, not a handful.
    expect(summary.meanPlantedPeak).toBeGreaterThan(10);
  });

  test("a seed is deterministic: the same world replays to the same run", () => {
    const again = runSpreadCase(generateNet(3));
    const reference = runs[2]!;
    expect(again.msToWalkerStart).toBe(reference.msToWalkerStart!);
    expect(again.crackedCount).toBe(reference.crackedCount);
    expect(again.mutations).toBe(reference.mutations);
  });

  test("crack budgeting refuses what the deployed stack cannot open", () => {
    // A model with neither solver nor dictionary must never be counted
    // crackable — the arena would otherwise credit spread speed the real
    // system cannot achieve.
    expect(crackAttemptsFor({
      modelId: "NoSuchModel",
      password: "hunter2",
      passwordLength: 7,
      passwordFormat: "alphanumeric",
      passwordHint: "",
      data: "",
      difficulty: 5,
    })).toBeUndefined();
  });

  test("the arena's prices come from the game's own table", () => {
    // base 1.6 + probe 0.2 + exec 1.3 + connectToSession 0.05: the reserve
    // every host holds. Priced from `PROBER_CALLS` rather than restated, so the
    // arena cannot model a cheaper fleet than production runs — which it did,
    // at 1.8 GB, for as long as this pin restated the number by hand.
    expect(PROBER_GB).toBe(PRODUCTION_PROBER_GB);
    expect(PROBER_GB).toBe(3.15);
    // The prober is now the BIGGEST fixed cost on a host — bigger than a whole
    // attempt worker — because `exec` (1.3 GB) is most of it. That is the
    // reserve armour is measured against, and it is why armour is a policy
    // rather than a default.
    expect(PROBER_GB).toBeGreaterThan(ATTEMPT_GB);
    expect(PROBER_STASIS_GB).toBeLessThan(PROBER_GB);
    // Armour is exactly `spawn` on top, and nothing else.
    expect(PROBER_ARMOURED_SIM_GB - PROBER_GB).toBeCloseTo(2, 6);
  });
});

describe("the deep world (air gaps, spares, ferry)", () => {
  // 3 augs -> ub3r_l4byr1nth: depth 23, air gaps at rows 8 and 16, stasis
  // limit 3. The world where induce, band conquest, and spare placement are
  // load-bearing at all — rung 0 has none of them.
  const DEEP_CAP_MS = 3 * 60 * 60 * 1000;
  const deep = [1, 2].map((seed) =>
    runSpreadCase(generateNet(seed, { augs: 3 }), DEEP_CAP_MS));

  test("the production strategy conquers a two-gap world inside the cap", () => {
    for (const run of deep) {
      expect(run.solved, `${run.caseId}: ${run.reason ?? ""}`).toBe(true);
      expect(run.caseId).toBe("spread:23");
      // Every band held an agent well before the walker started.
      expect(run.msToAllBandsReached).toBeDefined();
      expect(run.msToAllBandsReached!).toBeLessThanOrEqual(run.msToWalkerStart!);
      expect(run.msToLabSighted!).toBeLessThanOrEqual(run.msToWalkerStart!);
      expect(run.msToLabPinned!).toBeLessThanOrEqual(run.msToWalkerStart!);
      expect(run.startingCharisma).toBe(run.labRequiredCharisma);
      // The finish line must be reached through the deployed mechanics, not a
      // benchmark shortcut that roots, clears, pins, or crosses gaps directly.
      expect(run.plantCalls).toBeGreaterThan(0);
      expect(run.attemptCalls).toBeGreaterThan(0);
      expect(run.reclaimCalls).toBeGreaterThan(0);
      expect(run.cacheCalls).toBeGreaterThan(0);
      expect(run.pinCalls).toBeGreaterThan(0);
      expect(run.induceCalls).toBeGreaterThan(0);
      expect(run.induceWaves).toBeGreaterThan(0);
      expect(run.induceCalls).toBeGreaterThanOrEqual(run.induceWaves);
      expect(run.completedInduceWaves).toBeLessThanOrEqual(run.induceWaves);
      expect(run.induceMoves).toBeLessThanOrEqual(run.completedInduceWaves);
      expect(run.deeperInduceWaves).toBeLessThanOrEqual(run.induceMoves);
      expect(run.usefulInduceWaves).toBeLessThanOrEqual(run.induceMoves);
      expect(run.induceMoves).toBeGreaterThan(0);
      expect(run.occupiedRestarts).toBeGreaterThan(0);
      expect(run.restartImmediatelyVisible + run.restartLost).toBe(run.occupiedRestarts);
      expect(run.restartRecovered + run.restartUnrecovered).toBe(run.occupiedRestarts);
      expect(run.restartLostSameTickReplants).toBeLessThanOrEqual(run.restartLost);
      expect(run.restartLostSameTickReplants).toBeLessThanOrEqual(run.restartImmediateReplants);
      expect(run.hypotheticalRestartReserveGbMs).toBeGreaterThan(0);
    }
  });

  // A whole deep case re-runs inside the test body (~5-8 s), so it gets an
  // explicit budget instead of bun's 5 s default.
  test("a deep seed is deterministic", () => {
    const again = runSpreadCase(generateNet(1, { augs: 3 }), DEEP_CAP_MS);
    expect(again.msToWalkerStart).toBe(deep[0]!.msToWalkerStart!);
    expect(again.induceCalls).toBe(deep[0]!.induceCalls);
    expect(again.crackedCount).toBe(deep[0]!.crackedCount);
  }, 30_000);
});

describe("the instant-job priority invariant", () => {
  // Jobs with no time cost (probe, ls, exec) run ahead of their numeric
  // priority via the same-turn lane — but of the instant kinds only the plant
  // (scp/exec) may cancel lower-priority work. Confirmed intended by the
  // operator; asserted here so a priority.ts edit cannot silently change it.
  test("inventory and relaunchProbe ride the same-turn lane without preempting", () => {
    expect(isSameTurn("inventory")).toBe(true);
    expect(isSameTurn("relaunchProbe")).toBe(true);
    expect(canPreempt("inventory", "phish")).toBe(false);
    expect(canPreempt("relaunchProbe", "phish")).toBe(false);
  });

  test("only the plant preempts among the instant kinds; bleed never does", () => {
    expect(canPreempt("plant", "phish")).toBe(true);
    expect(canPreempt("plant", "induce")).toBe(true);
    expect(canPreempt("bleed", "phish")).toBe(false);
    expect(canPreempt("bleed", "reclaim")).toBe(false);
  });

  test("pin outranks attempt, and attempt still preempts earn work", () => {
    expect(canPreempt("pin", "attempt")).toBe(true);
    expect(canPreempt("attempt", "phish")).toBe(true);
  });
});

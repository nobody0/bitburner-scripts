import { describe, expect, test } from "bun:test";
import { pairedComparison } from "../dnet-bench.ts";
import {
  ATTEMPT_GB,
  crackAttemptsFor,
  generateNet,
  PROBER_GB,
  runSpreadCase,
  SHIPPED_SPREAD,
  summarizeSpreadRuns,
} from "../dnet-spread.ts";
import { canPreempt, isSameTurn } from "../../shared/strategy/dnet/jobs.ts";

/** The reach-the-lab lane's CI mirror: sane bounds on the shipped policy over
 * paired seeds, plus the pricing and priority facts the arena leans on. The
 * full sweep with variants lives in `tools/dnet-spread-benchmark.ts`
 * (`bun run bench:sim:dnet-spread`). */

const SEEDS = Array.from({ length: 12 }, (_, index) => index + 1);

const shipped = SEEDS.map((seed) => runSpreadCase(generateNet(seed), SHIPPED_SPREAD));

describe("the reach-the-lab arena", () => {
  test("the shipped policy reaches a startable walker on every seed", () => {
    for (const run of shipped) {
      expect(run.solved, `${run.caseId} seed run failed: ${run.reason ?? ""}`).toBe(true);
      expect(run.walkerThreads!).toBeGreaterThanOrEqual(2);
    }
  });

  test("the road from cold start to walker stays inside sane bounds", () => {
    const summary = summarizeSpreadRuns(shipped);
    // First crack within a minute: darkweb's shallow neighbours hold trivially
    // solvable models, and a first crack an hour in would mean the attempt
    // pipeline is broken, not slow.
    expect(summary.meanMsToFirstCrack).toBeLessThan(60_000);
    // The walker startable within half an hour of a cold start, on average.
    expect(summary.meanMsToWalkerStart).toBeLessThan(30 * 60_000);
    // Spreading actually spread: a healthy run stands agents on dozens of
    // hosts, not a handful.
    expect(summary.meanPlantedPeak).toBeGreaterThan(10);
  });

  test("a seed is deterministic: the same world replays to the same run", () => {
    const again = runSpreadCase(generateNet(3), SHIPPED_SPREAD);
    const reference = shipped[2]!;
    expect(again.msToWalkerStart).toBe(reference.msToWalkerStart!);
    expect(again.crackedCount).toBe(reference.crackedCount);
    expect(again.mutations).toBe(reference.mutations);
  });

  test("paired comparison plumbing: shipped against itself is all ties", () => {
    const starts = shipped.map((run) => run.msToWalkerStart!);
    const compared = pairedComparison(
      { name: "a", values: starts },
      { name: "b", values: starts },
    );
    expect(compared.tied).toBe(SEEDS.length);
    expect(compared.meanDelta).toBe(0);
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
    // base 1.6 + probe 0.2: the reserve every host holds.
    expect(PROBER_GB).toBe(1.8);
    expect(ATTEMPT_GB).toBeGreaterThan(PROBER_GB);
  });
});

describe("the deep world (air gaps, spares, ferry)", () => {
  // 3 augs -> ub3r_l4byr1nth: depth 23, air gaps at rows 8 and 16, stasis
  // limit 3. The world where induce, band conquest, and spare placement are
  // load-bearing at all — rung 0 has none of them.
  const DEEP_CAP_MS = 3 * 60 * 60 * 1000;
  const deep = [1, 2].map((seed) =>
    runSpreadCase(generateNet(seed, { augs: 3 }), SHIPPED_SPREAD, DEEP_CAP_MS));

  test("the shipped policy conquers a two-gap world inside the cap", () => {
    for (const run of deep) {
      expect(run.solved, `${run.caseId}: ${run.reason ?? ""}`).toBe(true);
      expect(run.caseId).toBe("spread:23");
      // Every band held an agent well before the walker started.
      expect(run.msToAllBandsReached).toBeDefined();
      expect(run.msToAllBandsReached!).toBeLessThanOrEqual(run.msToWalkerStart!);
    }
  });

  // A whole deep case re-runs inside the test body (~5-8 s), so it gets an
  // explicit budget instead of bun's 5 s default.
  test("a deep seed is deterministic", () => {
    const again = runSpreadCase(generateNet(1, { augs: 3 }), SHIPPED_SPREAD, DEEP_CAP_MS);
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

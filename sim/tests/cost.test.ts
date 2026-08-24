import { describe, expect, test } from "bun:test";
import { parseGoals } from "../../shared/goals/presets.ts";
import { assertPromotableSession, type SimSessionManifest } from "../artifacts.ts";
import { Clock, realNowMs } from "../clock.ts";
import { CostMeter, formatReport, pumpGuard, throughputDrift, type CostSample } from "../cost.ts";
import { runGame } from "../game-run.ts";
import { installVirtualTime } from "../realm/timers.ts";
import { findProfile } from "../profiles.ts";

/** A goal that is never reached, so only the budget can stop these runs. */
const UNREACHABLE = ["earn:1e300"];

describe("wall-clock budget", () => {
  test("stops the pump on real time and says so", async () => {
    const before = realNowMs();
    const result = await runGame({
      goal: parseGoals(UNREACHABLE),
      seed: 1,
      // Far beyond what the budget can reach, so a "horizon" stop would be a
      // failure of the budget rather than an alternative outcome.
      horizonMs: 365 * 24 * 60 * 60_000,
      wallBudgetMs: 1_500,
      telemetry: false,
      features: findProfile("bn1-speedrun").features,
    });
    const elapsed = realNowMs() - before;

    expect(result.stoppedBecause).toBe("budget");
    expect(result.reached).toBe(false);
    expect(result.timeToGoalMs).toBe(Infinity);
    // The guard samples every 1024 events, so it overshoots by at most one
    // batch. Generous upper bound: this asserts the budget bounds the run, not
    // that it is precise.
    expect(elapsed).toBeLessThan(60_000);
    // It really did simulate something before stopping.
    expect(result.engineCycles).toBeGreaterThan(0);
  }, 90_000);

  test("a budget-truncated route session cannot be promoted", () => {
    const manifest: SimSessionManifest = {
      version: 2,
      identity: { id: "budget-test", kind: "sim", label: "budget-test", createdAt: 0 },
      seed: 1,
      experiment: { class: "bitnode-route", entrance: { kind: "fresh", bitNode: 1 } },
      scenarioFingerprint: "deadbeef",
      result: { reached: false, timeToGoalMs: Infinity, validity: "valid", stoppedBecause: "budget" },
      artifacts: [],
    };
    // Otherwise identical to a promotable leg: only `reached` differs, which is
    // exactly the guarantee that keeps a profiling run out of route lineage.
    expect(() => assertPromotableSession(manifest)).toThrow("did not reach its goal");
    expect(() => assertPromotableSession({ ...manifest, result: { ...manifest.result!, reached: true } })).not.toThrow();
  });

  test("the guard reports goal, not budget, when the goal wins", () => {
    let done = false;
    const guard = pumpGuard({ goalDone: () => done, wallBudgetMs: 60_000 });
    expect(guard.until()).toBe(false);
    done = true;
    expect(guard.until()).toBe(true);
    expect(guard.stoppedBy()).toBe("goal");
  });
});

describe("cost reporting", () => {
  test("measures real time while the realm is on virtual time", async () => {
    // The trap this whole module exists to avoid: inside an installed realm,
    // `performance.now()` is the virtual clock. A meter built on it would
    // report the run's own game time as its host cost.
    const clock = new Clock();
    const virtual = installVirtualTime(clock);
    try {
      const meter = new CostMeter({
        clock,
        sampleEveryMs: 1,
        engineCycles: () => 0,
        records: () => 0,
      });
      clock.in(60 * 60_000, () => {});
      clock.run(() => false, 60 * 60_000);
      expect(performance.now()).toBe(clock.now());
      const report = meter.finish();
      // One virtual hour advanced; the wall time it took was milliseconds.
      expect(report.virtualMs).toBeGreaterThanOrEqual(60 * 60_000);
      expect(report.wallMs).toBeLessThan(report.virtualMs);
    } finally {
      virtual.restore();
    }
  });

  test("counts Netscript calls by name and does not change the outcome", async () => {
    const profile = findProfile("bn1-progression");
    const run = (cost: boolean) =>
      runGame({
        goal: parseGoals(["installs:1"]),
        seed: 1,
        horizonMs: 2 * 60_000,
        bitnode: profile.bitnode,
        homeRam: profile.homeRam,
        startingMoney: profile.startingMoney,
        features: profile.features,
        ...profile.world,
        telemetry: false,
        cost,
        costSampleEveryMs: 1_000,
        onCostSample: () => {},
      });

    const plain = await run(false);
    const metered = await run(true);

    expect(plain.cost).toBeUndefined();
    expect(metered.cost).toBeDefined();
    // Instrumentation must be invisible to the simulation: same seed, same
    // world, same virtual time to the same install. This is the same contract
    // perf-run.test.ts pins for --perf.
    expect(metered.reached).toBe(plain.reached);
    expect(metered.timeToGoalMs).toBe(plain.timeToGoalMs);
    expect(metered.records).toBe(plain.records);
    expect(metered.engineCycles).toBe(plain.engineCycles);

    const report = metered.cost!;
    expect(report.events).toBeGreaterThan(0);
    expect(report.nsCalls).toBeGreaterThan(0);
    expect(report.calls.length).toBeGreaterThan(0);
    // Descending by count, and the totals agree with the per-name buckets.
    expect(report.calls.map((call) => call.count)).toEqual(
      [...report.calls.map((call) => call.count)].sort((a, b) => b - a),
    );
    expect(report.calls.reduce((sum, call) => sum + call.count, 0)).toBe(report.nsCalls);
    expect(formatReport(report)).toContain("virtual-hours per wall-minute");
  }, 120_000);

  test("samples on real time, not on the virtual clock", () => {
    const clock = new Clock();
    const meter = new CostMeter({
      clock,
      sampleEveryMs: 10_000,
      engineCycles: () => 0,
      records: () => 0,
    });
    // A whole virtual day passes in microseconds of real time. The cadence is
    // real, so this must produce no sample at all — otherwise a fast-forwarding
    // run would drown itself in output and the drift number would be measuring
    // game time against game time.
    clock.in(24 * 60 * 60_000, () => {});
    clock.run(() => false, 24 * 60 * 60_000);
    meter.tick(realNowMs());
    expect(meter.finish().samples).toEqual([]);
  });

  test("emits a formatted line per sample", () => {
    const clock = new Clock();
    const lines: string[] = [];
    // Zero interval: every tick samples, so the cadence itself is not what is
    // under test here — the emission is.
    const meter = new CostMeter({
      clock,
      sampleEveryMs: 0,
      engineCycles: () => 7,
      records: () => 3,
      onSample: (_sample, line) => lines.push(line),
    });
    meter.tick(realNowMs());
    meter.tick(realNowMs());
    const report = meter.finish();
    expect(lines.length).toBe(report.samples.length);
    expect(lines[0]).toContain("vh/min");
    expect(report.samples[0]!.engineCycles).toBe(7);
    expect(report.samples[0]!.records).toBe(3);
  });

  test("throughput drift compares halves, so one noisy interval cannot flip it", () => {
    const sample = (throughput: number): CostSample => ({
      wallMs: 0, virtualMs: 0, events: 0, heap: 0, cancelled: 0,
      engineCycles: 0, records: 0, nsCalls: 0, throughput,
    });
    // Steadily decaying, but with a single fast outlier landing last. Endpoint
    // comparison would call this an improvement; the halves see the decay.
    const decaying = [10, 9, 8, 7, 3, 2, 1, 12].map(sample);
    const drift = throughputDrift(decaying)!;
    expect(drift.pct).toBeLessThan(0);
    expect(drift.decaying).toBe(true);

    expect(throughputDrift([10, 10, 10, 10].map(sample))!.decaying).toBe(false);
    // Too few samples for the halves to be more than single readings.
    expect(throughputDrift([10, 1].map(sample))!.decaying).toBe(false);
    expect(throughputDrift([sample(1)])).toBeUndefined();
  });

  test("counters are disarmed once a run finishes", async () => {
    // Two runs in one process must not pool their counts, and an unmetered run
    // must not accumulate anything at all.
    const meter = new CostMeter({ clock: new Clock(), engineCycles: () => 0, records: () => 0 });
    const first = meter.finish();
    expect(first.nsCalls).toBe(0);
    const second = new CostMeter({ clock: new Clock(), engineCycles: () => 0, records: () => 0 }).finish();
    expect(second.nsCalls).toBe(0);
  });
});

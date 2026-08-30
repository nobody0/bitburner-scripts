import { describe, expect, test } from "bun:test";
import { parseGoals } from "../../shared/goals/presets.ts";
import { assertPromotableSession, type SimSessionManifest } from "../artifacts.ts";
import { Clock, processRssBytes, realNowMs } from "../clock.ts";
import { CostMeter, formatReport, pumpGuard, rssGrowth, throughputDrift, type CostSample } from "../cost.ts";
import { formatHeapCensus, heapCensus } from "../heap-census.ts";
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

/** The guard checks memory once per 1024 events, so every case here calls
 * `until` that many times to reach one check. */
const ONE_CHECK = 0x400;

function pump(guard: { until: () => boolean }, calls = ONE_CHECK): boolean {
  for (let i = 0; i < calls; i++) if (guard.until()) return true;
  return false;
}

describe("memory budget", () => {
  test("stops the pump when RSS stays over the budget", () => {
    let collections = 0;
    const guard = pumpGuard({
      goalDone: () => false,
      memoryBudgetBytes: 1_000,
      // A run genuinely holding more than the budget: collecting frees nothing.
      rssBytes: () => 4_000,
      collect: () => void collections++,
    });
    expect(pump(guard)).toBe(true);
    expect(guard.stoppedBy()).toBe("memory");
    expect(guard.stoppedAtBytes()).toBe(4_000);
    // Collect once, look once, decide. Never a loop.
    expect(collections).toBe(1);
  });

  test("a collection that brings RSS back under the budget keeps the run alive", () => {
    // The case that makes the budget usable at all. `CollectionPacer` only
    // forces a sweep on 512 MB of GROWTH, so a reading over the budget is
    // routinely garbage nothing has swept yet — and a budget that killed runs
    // on uncollected garbage would be a worse instrument than none.
    let collected = false;
    const guard = pumpGuard({
      goalDone: () => false,
      memoryBudgetBytes: 1_000,
      rssBytes: () => (collected ? 400 : 4_000),
      collect: () => void (collected = true),
    });
    expect(pump(guard)).toBe(false);
    expect(guard.stoppedBy()).toBe("goal");
    expect(guard.stoppedAtBytes()).toBe(0);
  });

  test("a run under its budget is never collected or stopped", () => {
    let collections = 0;
    const guard = pumpGuard({
      goalDone: () => false,
      memoryBudgetBytes: 1_000,
      rssBytes: () => 999,
      collect: () => void collections++,
    });
    expect(pump(guard, ONE_CHECK * 4)).toBe(false);
    expect(collections).toBe(0);
  });

  test("the wall budget still wins when both are armed", () => {
    const guard = pumpGuard({
      goalDone: () => false,
      wallBudgetMs: -1,
      memoryBudgetBytes: 1,
      rssBytes: () => 1_000_000,
      collect: () => {},
    });
    expect(pump(guard)).toBe(true);
    expect(guard.stoppedBy()).toBe("budget");
  });

  test("no budget means no RSS probe at all", () => {
    let reads = 0;
    const guard = pumpGuard({
      goalDone: () => false,
      rssBytes: () => {
        reads++;
        return 1e12;
      },
    });
    expect(pump(guard, ONE_CHECK * 4)).toBe(false);
    expect(reads).toBe(0);
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
      engineCycles: 0, records: 0, nsCalls: 0, rssBytes: 0, throughput,
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

  test("every sample carries RSS, and the report carries the peak", () => {
    const clock = new Clock();
    const meter = new CostMeter({ clock, sampleEveryMs: 0, engineCycles: () => 0, records: () => 0 });
    meter.tick(realNowMs());
    meter.tick(realNowMs());
    const report = meter.finish();
    // A real reading, not a placeholder: this process is running, so it is
    // resident. A zero here means the instrument is measuring nothing.
    expect(report.samples[0]!.rssBytes).toBeGreaterThan(0);
    expect(report.rssBytes).toBeGreaterThan(0);
    expect(report.peakRssBytes).toBeGreaterThanOrEqual(
      Math.max(...report.samples.map((sample) => sample.rssBytes)),
    );
    expect(formatReport(report)).toContain("memory: rss");
  });

  test("rss growth is a rate per virtual hour, so a short window cannot cry leak", () => {
    const at = (virtualHours: number, gb: number): CostSample => ({
      wallMs: 0, virtualMs: virtualHours * 3_600_000, events: 0, heap: 0, cancelled: 0,
      engineCycles: 0, records: 0, nsCalls: 0, rssBytes: gb * 1024 ** 3, throughput: 1,
    });
    // 1 GB added over 24 virtual hours: a big process, not a leaking one.
    const flat = rssGrowth([at(0, 1), at(8, 1.3), at(16, 1.7), at(24, 2)])!;
    expect(flat.growing).toBe(false);
    // The measured shape of the defect: 1.2 GB at 12h, 58 GB at 26h.
    const blowup = rssGrowth([at(0, 0.6), at(6, 0.9), at(12, 1.2), at(26, 58)])!;
    expect(blowup.growing).toBe(true);
    // Gigabytes per virtual hour, which is the claim. The exact figure is the
    // estimator's (halved means, so the final 58 GB sample gets one vote and
    // not the whole trend), not the endpoint difference.
    expect(blowup.perVirtualHour).toBeGreaterThan(1024 ** 3);
    // THE REASON THIS IS A SLOPE AND NOT AN ENDPOINT DIFFERENCE: a forced
    // collection landing beside the final sample gives back what it swept, and
    // an endpoint reading would call the run flat on the strength of that one
    // sample. Every sample votes, so one cannot.
    const swept = rssGrowth([at(0, 1), at(6, 8), at(12, 15), at(18, 22), at(24, 1.5)])!;
    expect(swept.growing).toBe(true);
    // The endpoint reading the slope replaces: 0.5 GB over 24 virtual hours.
    expect((swept.lastBytes - swept.firstBytes) / 24).toBeLessThan(256 * 1024 ** 2);
    // Two samples cannot establish a trend, however steep the line between them.
    expect(rssGrowth([at(0, 1), at(1, 40)])!.growing).toBe(false);
    expect(rssGrowth([at(0, 1)])).toBeUndefined();
  });

  test("the heap census splits live JavaScript from what the collector has given up on", () => {
    // The reading that decided the memory diagnosis: a run holding 1.19 GB of
    // RSS had 42.5 MB of live JavaScript in it. Without the split, the only
    // available conclusion is "something leaks", which is wrong.
    const census = heapCensus(5)!;
    expect(census).toBeDefined();
    expect(census.liveBytes).toBeGreaterThan(0);
    expect(census.capacityBytes).toBeGreaterThanOrEqual(census.liveBytes);
    expect(census.objectCount).toBeGreaterThan(0);
    expect(census.types.length).toBeGreaterThan(0);
    expect(census.types.length).toBeLessThanOrEqual(5);
    expect(formatHeapCensus(census)).toContain("capacity=");
    expect(processRssBytes()).toBeGreaterThan(census.liveBytes);
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

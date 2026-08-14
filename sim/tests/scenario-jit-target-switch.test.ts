import { expect, test } from 'bun:test';
import { scenarioDescribe } from './scenario-lane.ts';
import { only } from '../../shared/features/profile.ts';
import { parseGoals } from '../../shared/goals/presets.ts';
import {
  formatJitMetrics,
  formatJitPressure,
  jitMetrics,
  jitPressure,
  runJitScenario,
  type JitSample,
} from './jit-scenario.ts';

/** TARGET SWITCH — the rival starts just below the prep threshold, then
 * becomes the better prepped target after the primary has built a pipeline.
 * A 3,072 GB fixed slab keeps the target set under active pressure: measured
 * minimum demands sum to more than the whole fleet.
 *
 * RECORDED OPTIMUM (update when you beat it, never when you regress):
 *   utilisation (median idle share) : 0.514731
 *   window completion (landed/launched hacks) : 1.000
 *   money/sec over the steady window : $1.108422e3
 *   measured on the 2026-08-13 working tree. Previous values (0.636 /
 *   0.956 / $1.04e3) used a 4,096 GB unpressured slab and are not comparable.
 *
 * Switch diagnostic: at 64.5 s, 13 old-target calls were still in flight
 * and the 30 s income window after the switch retained 0.433885 of
 * the 30 s window before it. Those values are diagnostic guards in addition
 * to the three common benchmarks above.
 *
 * Why completion is separate from utilisation: JIT launches longest-first
 * (weaken, grow, hack), and each landing opens the next launch window. A hack
 * that launches but never lands loses the whole batch profit; its grow and
 * weaken were already paid for. Free-looking RAM may therefore belong to an
 * old-target window that has not opened yet. */
const RECORDED = {
  medianIdleShare: 0.514731,
  windowCompletion: 1.0,
  moneyPerSec: 1.108422e3,
  switchIncomeRetention: 0.433885,
} as const;

const TOLERANCE = {
  idleShare: 0.03,
  windowCompletion: 0.03,
  moneyFraction: 0.05,
  switchIncomeRetention: 0.08,
} as const;

const PRIMARY = {
  hostname: 'switch-primary',
  organizationName: 'scenario',
  hackDifficulty: 2,
  moneyAvailable: 500,
  moneyMax: 500,
  requiredHackingSkill: 1,
  serverGrowth: 200,
  numOpenPortsRequired: 0,
  // A fixed slab supplies the whole run; low target money prevents purchases.
  maxRam: 3_072,
  currentDifficulty: 1,
  currentMoney: 12_500,
} as const;

const RIVAL = {
  hostname: 'switch-rival',
  organizationName: 'scenario',
  hackDifficulty: 2,
  moneyAvailable: 800,
  moneyMax: 800,
  requiredHackingSkill: 1,
  serverGrowth: 200,
  numOpenPortsRequired: 0,
  maxRam: 0,
  currentDifficulty: 1,
  // The simulator derives max money as 25x moneyAvailable: 15k/20k is cold.
  currentMoney: 15_000,
} as const;

function moneyRate(samples: readonly JitSample[], fromMs: number, toMs: number): number {
  const window = samples.filter((sample) => sample.atMs >= fromMs && sample.atMs <= toMs);
  const first = window[0];
  const last = window.at(-1);
  return first && last && last.atMs > first.atMs
    ? (last.earned - first.earned) / ((last.atMs - first.atMs) / 1_000)
    : 0;
}

scenarioDescribe('scenario: JIT target switch', () => {
  test('keeps utilisation, windows, and income across an in-flight retarget', async () => {
    const run = await runJitScenario({
      goal: parseGoals(['earn:1e30']),
      seed: 17,
      horizonMs: 6 * 60_000,
      bitnode: 1,
      homeRam: 256,
      startingMoney: 0,
      person: { skills: { hacking: 250 }, exp: { hacking: 6_250_000 } },
      features: only('hacking', 'progression'),
      network: [PRIMARY, RIVAL],
      topology: {
        home: [PRIMARY.hostname, RIVAL.hostname],
        [PRIMARY.hostname]: ['home'],
        [RIVAL.hostname]: ['home'],
      },
    });
    const metrics = jitMetrics(run.samples, 60_000);
    const pressure = jitPressure(run.samples, 60_000);
    const switched = run.switches.find((event) => event.from === PRIMARY.hostname && event.to === RIVAL.hostname);
    const switchAt = switched?.atMs ?? 0;
    const beforeRate = moneyRate(run.samples, switchAt - 30_000, switchAt);
    const afterRate = moneyRate(run.samples, switchAt, switchAt + 30_000);
    const incomeRetention = beforeRate > 0 ? afterRate / beforeRate : 0;
    const stranded = switched?.before
      ? switched.before.inFlightHack + switched.before.inFlightGrow + switched.before.inFlightWeaken
      : 0;

    console.info(formatJitMetrics('jit-target-switch', metrics));
    console.info(formatJitPressure('jit-target-switch', pressure));
    console.info(
      `[jit-target-switch] switch=${switchAt / 1_000}s stranded=${stranded}`
      + ` income-retention=${incomeRetention.toFixed(6)}`,
    );

    expect(run.result.validity).not.toBe('invalid-for-goal');
    expect(switched).toBeDefined();
    expect(stranded).toBeGreaterThan(0);
    expect(run.infrastructure).toHaveLength(0);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(pressure.summedTargetDemandGb).toBeGreaterThan(pressure.peakUsableGb);

    // Absolute 0.03: 1 Hz sampling can move a few re-planning snapshots across
    // the median without representing a sustained utilisation regression.
    expect(metrics.medianIdleShare).toBeLessThanOrEqual(RECORDED.medianIdleShare + TOLERANCE.idleShare);
    // Absolute 0.03: this six-minute horizon truncates roughly two in-flight
    // hacks, so one boundary launch must not fail an otherwise healthy run.
    expect(metrics.windowCompletion).toBeGreaterThanOrEqual(
      RECORDED.windowCompletion - TOLERANCE.windowCompletion,
    );
    // Relative 5%: payout phase and the retarget re-plan can move a few hacks
    // across either edge of the finite steady window.
    expect(metrics.moneyPerSec).toBeGreaterThanOrEqual(
      RECORDED.moneyPerSec * (1 - TOLERANCE.moneyFraction),
    );
    // Wider because each side is only 30 seconds and contains few payouts.
    expect(incomeRetention).toBeGreaterThanOrEqual(
      RECORDED.switchIncomeRetention - TOLERANCE.switchIncomeRetention,
    );
  }, 120_000);
});

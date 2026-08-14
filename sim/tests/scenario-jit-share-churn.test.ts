import { expect, test } from 'bun:test';
import { scenarioDescribe } from './scenario-lane.ts';
import { only } from '../../shared/features/profile.ts';
import { parseGoals } from '../../shared/goals/presets.ts';
import { formatJitMetrics, formatJitPressure, jitMetrics, jitPressure, runJitScenario } from './jit-scenario.ts';

/** SHARE CHURN — faction reputation and money are both on the critical path,
 * so shareCutover has genuine demand to compare with a measured farm marginal.
 * Skill and experience are consistent, keeping the target demand at 1,322.7 GB
 * against a 446.8 GB peak usable fleet while share repeatedly yields/reclaims.
 *
 * RECORDED OPTIMUM (update when you beat it, never when you regress):
 *   utilisation (median idle share) : 0.00837
 *   window completion (landed/launched hacks) : 1.000
 *   money/sec over the steady window : $1.105482e6
 *   measured on the 2026-08-13 working tree. Previous values (0.315 /
 *   1.000 / $9.32e5) used inconsistent 1e16 experience and measured an
 *   unpressured target; they are not comparable.
 *
 * allocFails=0 and batchesSkipped=1. Measured churn: share ranged from 0 to
 * 656 GB with 276 samples where share fell as farm RAM rose, and 232 where
 * share rose as farm RAM fell. Share can
 * safely lend RAM because it can stop inside its current 10-second slice. A
 * separate target prep cannot: cancelling its long grow/weaken loses progress,
 * so the same free-looking pipeline RAM is unsafe for prep. */
const RECORDED = {
  medianIdleShare: 0.00837,
  windowCompletion: 1.0,
  moneyPerSec: 1.105482e6,
} as const;

const TOLERANCE = {
  idleShare: 0.03,
  windowCompletion: 0.03,
  moneyFraction: 0.05,
} as const;

const TARGET = {
  hostname: 'share-churn-target',
  organizationName: 'scenario',
  hackDifficulty: 3,
  currentDifficulty: 1,
  moneyAvailable: 1e8,
  currentMoney: 2.5e9,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
} as const;

scenarioDescribe('scenario: JIT share churn', () => {
  test('share yields and reclaims RAM without losing farm windows', async () => {
    const run = await runJitScenario({
      goal: parseGoals(['rep:CyberSec:1e12', 'earn:1e30']),
      seed: 7,
      horizonMs: 15 * 60_000,
      bitnode: 4,
      homeRam: 256,
      startingMoney: 1e6,
      person: { skills: { hacking: 1_000 }, exp: { hacking: 100_000_000 } },
      playerState: { factions: ['CyberSec'] },
      factions: { CyberSec: { rep: 0, favor: 0 } },
      features: only('hacking', 'factions', 'career', 'progression'),
      network: [TARGET],
      topology: { home: [TARGET.hostname], [TARGET.hostname]: ['home'] },
    });
    const metrics = jitMetrics(run.samples, 3 * 60_000);
    const pressure = jitPressure(run.samples, 3 * 60_000);
    const shares = run.samples.map((sample) => sample.shareGb);
    const farm = run.samples.map((sample) => sample.farmGb);
    const maxShareGb = Math.max(...shares);
    const maxFleetGb = Math.max(...run.samples.map((sample) => sample.fleetGb));
    const final = run.samples.at(-1)!;
    const yielded = shares.filter(
      (share, index) => index > 0
        && share < shares[index - 1]! - 1e-9
        && farm[index]! > farm[index - 1]! + 1e-9,
    ).length;
    const reclaimed = shares.filter(
      (share, index) => index > 0
        && share > shares[index - 1]! + 1e-9
        && farm[index]! < farm[index - 1]! - 1e-9,
    ).length;

    console.info(formatJitMetrics('jit-share-churn', metrics));
    console.info(formatJitPressure('jit-share-churn', pressure));
    console.info(
      `[jit-share-churn] share=0..${maxShareGb}GB yielded=${yielded}`
      + ` reclaimed=${reclaimed} fleet=${maxFleetGb}GB`
      + ` allocFails=${final.allocFails} batchesSkipped=${final.batchesSkipped}`,
    );

    expect(run.result.validity).not.toBe('invalid-for-goal');
    expect(maxShareGb).toBeGreaterThan(0);
    expect(maxShareGb).toBeLessThan(maxFleetGb);
    expect(yielded).toBeGreaterThan(0);
    expect(reclaimed).toBeGreaterThan(0);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(pressure.summedTargetDemandGb).toBeGreaterThan(pressure.peakUsableGb);

    // Absolute 0.03: share workers end 10-second slices while farm telemetry is
    // sampled at 1 Hz, so a handful of transition samples can cross the median.
    expect(metrics.medianIdleShare).toBeLessThanOrEqual(RECORDED.medianIdleShare + TOLERANCE.idleShare);
    // Absolute 0.03: the horizon can end with two launched hacks still in
    // flight even when every launch window before the boundary was honored.
    expect(metrics.windowCompletion).toBeGreaterThanOrEqual(
      RECORDED.windowCompletion - TOLERANCE.windowCompletion,
    );
    // Relative 5%: share/farm re-planning jitter can move several payouts
    // across either edge of the twelve-minute steady window.
    expect(metrics.moneyPerSec).toBeGreaterThanOrEqual(
      RECORDED.moneyPerSec * (1 - TOLERANCE.moneyFraction),
    );
  }, 120_000);
});

import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { calculateExp } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import {
  formatJitMetrics,
  formatJitPressure,
  jitMetrics,
  jitPressure,
  runJitScenario,
  type JitSample,
} from "./jit-scenario.ts";

/** SKILL JUMP - runGame exposes no supported mid-run person mutation hook, so
 * the closest honest approximation uses an existing unpredictable duration
 * change: a modeled Go win raises hacking_speed while a healthy pipeline has
 * calls in flight. A locked skill-1000 target creates real hacking-level/speed
 * demand, causing Go to choose the relevant reward. No state is edited by the
 * fixture.
 *
 * At the recorded run the multiplier jumped 1.0 -> 1.069013 at 48.95 s with
 * 66 calls in flight. Raw skills.hacking stayed 250: this is explicitly a
 * duration-multiplier jump, not a fabricated career experience award.
 *
 * RECORDED OPTIMUM (update when you beat it, never when you regress):
 *   utilisation (median idle share) : 0.655907
 *   window completion (landed/launched hacks) : 1.000
 *   money/sec over the steady window : $1.626390e7
 *
 * Recovery diagnostic: post-jump completion 1.000, post-jump income
 * $3.905e6/s, final security exactly minimum, and final money exactly maximum.
 * batchesSkipped=1 and the target closes exactly prepared.
 * This scenario is new; earlier unpressured JIT numbers are not comparable. */
const RECORDED = {
  medianIdleShare: 0.655907,
  windowCompletion: 1.0,
  moneyPerSec: 1.626390e7,
} as const;

const PRIMARY = {
  hostname: "skill-jump-primary",
  organizationName: "scenario",
  hackDifficulty: 30,
  moneyAvailable: 1e8,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 8_192,
  currentDifficulty: 10,
  currentMoney: 2.5e9,
} as const;

const SECONDARY = {
  ...PRIMARY,
  hostname: "skill-jump-secondary",
} as const;

const AWARD = {
  hostname: "skill-jump-award",
  organizationName: "scenario",
  hackDifficulty: 20,
  moneyAvailable: 1e12,
  requiredHackingSkill: 1_000,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
  currentDifficulty: 6.67,
  currentMoney: 2.5e13,
} as const;

function sampleAtOrBefore(samples: readonly JitSample[], atMs: number): JitSample | undefined {
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]!;
    if (sample.atMs <= atMs) return sample;
  }
  return undefined;
}

function rate(samples: readonly JitSample[], fromMs: number, toMs: number): number {
  const window = samples.filter((sample) => sample.atMs >= fromMs && sample.atMs <= toMs);
  const first = window[0];
  const last = window.at(-1);
  if (!first || !last || last.atMs <= first.atMs) return 0;
  return (last.earned - first.earned) / ((last.atMs - first.atMs) / 1_000);
}

scenarioDescribe("scenario: JIT mid-batch skill jump", () => {
  test("recovers target state, window completion, and income after durations shift", async () => {
    const steadyFromMs = 2 * 60_000;
    const run = await runJitScenario({
      goal: parseGoals(["earn:1e30"]),
      seed: 41,
      horizonMs: 12 * 60_000,
      bitnode: 4,
      homeRam: 256,
      startingMoney: 0,
      person: {
        skills: { hacking: 249 },
        exp: { hacking: calculateExp(250) - 1 },
      },
      features: only("hacking", "progression", "go"),
      network: [PRIMARY, SECONDARY, AWARD],
      topology: {
        home: [PRIMARY.hostname, SECONDARY.hostname, AWARD.hostname],
        [PRIMARY.hostname]: ["home"],
        [SECONDARY.hostname]: ["home"],
        [AWARD.hostname]: ["home"],
      },
    });
    const metrics = jitMetrics(run.samples, steadyFromMs);
    const pressure = jitPressure(run.samples, steadyFromMs);
    const jumps = run.skills.slice(1).map((sample, index) => {
      const previous = run.skills[index]!;
      return {
        ...sample,
        from: previous.hacking,
        delta: sample.hacking - previous.hacking,
        speedDelta: sample.hackingSpeed - previous.hackingSpeed,
        levelDelta: sample.hackingLevel - previous.hackingLevel,
      };
    });
    const jump = jumps.find((sample) =>
      sample.atMs >= 30_000 && (sample.speedDelta > 0 || sample.levelDelta > 0)
    );
    const before = jump ? sampleAtOrBefore(run.samples, jump.atMs) : undefined;
    const final = run.samples.at(-1);
    const offeredDemandGb = pressure.summedTargetDemandGb * 2;
    const postRate = jump ? rate(run.samples, jump.atMs + 60_000, jump.atMs + 180_000) : 0;
    const postLaunches = before && final ? final.launchedHack - before.launchedHack : 0;
    const postLandings = before && final ? final.landedHack - before.landedHack : 0;
    const postCompletion = postLaunches > 0 ? postLandings / postLaunches : 0;
    const securityGap = final?.security !== undefined && final.minSecurity !== undefined
      ? final.security - final.minSecurity
      : Infinity;
    const moneyShare = final?.money !== undefined && final.moneyMax
      ? final.money / final.moneyMax
      : 0;

    console.info(formatJitMetrics("jit-skill-jump", metrics));
    console.info(formatJitPressure("jit-skill-jump", pressure));
    console.info(
      "[jit-skill-jump] jump=" + (jump?.from ?? 0) + "->" + (jump?.hacking ?? 0)
      + " delta=" + (jump?.delta ?? 0)
      + " speed=" + (jump?.hackingSpeed ?? 1).toFixed(6)
      + " level=" + (jump?.hackingLevel ?? 1).toFixed(6) + " at=" + ((jump?.atMs ?? 0) / 1_000) + "s"
      + " offered-demand=" + offeredDemandGb.toFixed(1) + "GB"
      + " inFlight=" + ((before?.inFlightHack ?? 0) + (before?.inFlightGrow ?? 0)
        + (before?.inFlightWeaken ?? 0))
      + " post-windows=" + postCompletion.toFixed(6)
      + " post-money/sec=$" + postRate.toExponential(6)
      + " final-security-gap=" + securityGap.toFixed(6)
      + " final-money-share=" + moneyShare.toFixed(6)
      + " skipped=" + (final?.batchesSkipped ?? 0),
    );

    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(pressure.demandByTarget.size).toBeGreaterThan(0);
    // PRIMARY and SECONDARY have identical statics and therefore identical
    // pipeline demand; both are prepared and eligible throughout the run.
    expect(offeredDemandGb).toBeGreaterThan(pressure.peakUsableGb);
    expect(jump).toBeDefined();
    expect(run.goGames.some((game) => game.won)).toBe(true);
    expect((jump!.speedDelta > 0 || jump!.levelDelta > 0)).toBe(true);
    expect(before!.launchedHack).toBeGreaterThan(0);
    expect(
      before!.inFlightHack + before!.inFlightGrow + before!.inFlightWeaken,
    ).toBeGreaterThan(0);
    expect(securityGap).toBeLessThanOrEqual(1);
    expect(moneyShare).toBeGreaterThanOrEqual(0.9);
    expect(postLaunches).toBeGreaterThan(0);
    expect(postCompletion).toBeGreaterThanOrEqual(0.8);
    expect(postRate).toBeGreaterThan(0);
    expect(metrics.medianIdleShare).toBeLessThanOrEqual(RECORDED.medianIdleShare + 0.03);
    expect(metrics.windowCompletion).toBeGreaterThanOrEqual(RECORDED.windowCompletion - 0.04);
    expect(metrics.moneyPerSec).toBeGreaterThanOrEqual(RECORDED.moneyPerSec * 0.95);
  }, 120_000);
});

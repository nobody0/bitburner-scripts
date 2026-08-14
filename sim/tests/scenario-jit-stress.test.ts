import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import {
  formatJitMetrics,
  formatJitPressure,
  jitMetrics,
  jitPressure,
  runJitScenario,
} from "./jit-scenario.ts";

/** COMBINED STRESS - target ranking crosses as skill rises, share competes for
 * RAM because faction reputation is genuinely on the goal path, and cloud/home
 * purchases replace and enlarge heap slabs while batches remain in flight.
 *
 * The wide target and its twin have identical solver statics, so the observed
 * wide-target depth is a direct measurement for both. This keeps total offered
 * pipeline demand above fleet capacity throughout the disruption window.
 *
 * RECORDED OPTIMUM (update when you beat it, never when you regress):
 *   utilisation (median idle share) : 0.00113
 *   window completion (landed/launched hacks) : 1.000
 *   money/sec over the steady window : $2.724694e6
 *
 * Contiguity is healthy: allocFails=0, placement misses=0, and
 * batchesSkipped=2.
 * Previous combined-stress numbers were measured against an unpressured
 * two-target fixture whose demand could not absorb its 43 TB fleet. They are
 * not comparable. */
const RECORDED = {
  medianIdleShare: 0.00113,
  windowCompletion: 1.0,
  moneyPerSec: 2.724694e6,
} as const;

const COMPACT = {
  hostname: "stress-compact",
  organizationName: "scenario",
  hackDifficulty: 2,
  moneyAvailable: 1e8,
  requiredHackingSkill: 1,
  serverGrowth: 20,
  numOpenPortsRequired: 0,
  maxRam: 4_096,
  currentDifficulty: 1,
  currentMoney: 2.5e9,
} as const;

const WIDE = {
  hostname: "stress-wide",
  organizationName: "scenario",
  hackDifficulty: 2,
  moneyAvailable: 3.5e8,
  requiredHackingSkill: 200,
  serverGrowth: 500,
  numOpenPortsRequired: 0,
  maxRam: 0,
  currentDifficulty: 1,
  currentMoney: 8.75e9,
} as const;

const WIDE_TWIN = {
  ...WIDE,
  hostname: "stress-wide-twin",
} as const;

scenarioDescribe("scenario: JIT under combined stress", () => {
  test("holds utilisation, windows, and income while target, share, and fleet move", async () => {
    const steadyFromMs = 10 * 60_000;
    const run = await runJitScenario({
      goal: parseGoals(["rep:CyberSec:1e12", "earn:1e30"]),
      seed: 1,
      horizonMs: 30 * 60_000,
      bitnode: 4,
      homeRam: 128,
      startingMoney: 5e7,
      person: { skills: { hacking: 250 }, exp: { hacking: 6_250_000 } },
      playerState: { factions: ["CyberSec"] },
      factions: { CyberSec: { rep: 0, favor: 0 } },
      features: only("hacking", "factions", "career", "progression"),
      network: [COMPACT, WIDE, WIDE_TWIN],
      topology: {
        home: [COMPACT.hostname, WIDE.hostname, WIDE_TWIN.hostname],
        [COMPACT.hostname]: ["home"],
        [WIDE.hostname]: ["home"],
        [WIDE_TWIN.hostname]: ["home"],
      },
    });
    const metrics = jitMetrics(run.samples, steadyFromMs);
    const pressure = jitPressure(run.samples, 60_000);
    const final = run.samples.at(-1)!;
    const switched = run.switches.find((event) =>
      event.from === COMPACT.hostname
      && (event.to === WIDE.hostname || event.to === WIDE_TWIN.hostname)
    );
    const postLaunchInfrastructure = run.infrastructure.filter((event) => event.launchedHack > 0);
    const shares = run.samples.map((sample) => sample.shareGb);
    const farms = run.samples.map((sample) => sample.farmGb);
    const maxShareGb = Math.max(...shares);
    const yielded = shares.filter((share, index) =>
      index > 0 && share < shares[index - 1]! - 1e-9 && farms[index]! > farms[index - 1]! + 1e-9
    ).length;
    const reclaimed = shares.filter((share, index) =>
      index > 0 && share > shares[index - 1]! + 1e-9 && farms[index]! < farms[index - 1]! - 1e-9
    ).length;
    const wideDemand = Math.max(
      pressure.demandByTarget.get(WIDE.hostname) ?? 0,
      pressure.demandByTarget.get(WIDE_TWIN.hostname) ?? 0,
    );
    const offeredDemandGb = pressure.summedTargetDemandGb + wideDemand;
    const starved = run.samples.filter(
      (sample) => sample.atMs >= steadyFromMs && sample.farmGb === 0,
    );

    console.info(formatJitMetrics("jit-stress", metrics));
    console.info(formatJitPressure("jit-stress", pressure));
    console.info(
      "[jit-stress] offered-demand=" + offeredDemandGb.toFixed(1) + "GB"
      + " switch=" + ((switched?.atMs ?? 0) / 1_000) + "s"
      + " share=0.." + maxShareGb + "GB"
      + " yielded=" + yielded + " reclaimed=" + reclaimed
      + " infrastructure=" + run.infrastructure.length
      + " post-launch=" + postLaunchInfrastructure.length
      + " fleet=" + final.fleetGb + "GB"
      + " allocFails=" + final.allocFails
      + " batchesSkipped=" + final.batchesSkipped
      + " missedWindow=" + JSON.stringify(final.missedWindow),
    );

    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(switched).toBeDefined();
    expect(postLaunchInfrastructure.some(
      (event) => event.kind === "buyServer" || event.kind === "upgradeServer",
    )).toBe(true);
    expect(postLaunchInfrastructure.some((event) => event.kind === "upgradeHomeRam")).toBe(true);
    expect(maxShareGb).toBeGreaterThan(0);
    expect(yielded).toBeGreaterThan(0);
    expect(reclaimed).toBeGreaterThan(0);
    expect(starved).toHaveLength(0);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(wideDemand).toBeGreaterThan(0);
    expect(offeredDemandGb).toBeGreaterThan(pressure.peakUsableGb);
    expect(final.allocFails).toBeLessThanOrEqual(1);
    expect(metrics.medianIdleShare).toBeLessThanOrEqual(RECORDED.medianIdleShare + 0.03);
    expect(metrics.windowCompletion).toBeGreaterThanOrEqual(RECORDED.windowCompletion - 0.04);
    expect(metrics.moneyPerSec).toBeGreaterThanOrEqual(RECORDED.moneyPerSec * 0.95);
  }, 180_000);
});

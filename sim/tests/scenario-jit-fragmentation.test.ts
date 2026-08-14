import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { makeHackContext } from "../../shared/formulas.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { staticsFromRolls } from "../../shared/strategy/bounds.ts";
import { solveCycle } from "../../shared/strategy/targeting.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import {
  formatJitMetrics,
  formatJitPressure,
  jitMetrics,
  jitPressure,
  runJitScenario,
} from "./jit-scenario.ts";

/** FRAGMENTATION - two prepared targets have materially different atomic
 * worker shapes. Their score curves cross as real hacking experience raises
 * skill, forcing a switch from an 81.3 GB solved batch to a 1,127.3 GB batch
 * while cloud and home purchases continue changing heap slabs.
 *
 * RECORDED OPTIMUM (update when you beat it, never when you regress):
 *   utilisation (median idle share) : 0.441078
 *   window completion (landed/launched hacks) : 1.000
 *   money/sec over the steady window : $4.465055e6
 *
 * Contiguity is healthy: allocFails=0 and batchesSkipped=2 (both deadline).
 * Measured on the 2026-08-13 working tree. Previous values (0.606 / 0.943 /
 * $3.52e6) came from an unpressured single-target fixture and are not
 * comparable. */
const RECORDED = {
  medianIdleShare: 0.441078,
  windowCompletion: 1.0,
  moneyPerSec: 4.465055e6,
} as const;

const TOLERANCE = {
  idleShare: 0.03,
  windowCompletion: 0.04,
  moneyFraction: 0.05,
} as const;

const PRIMARY = {
  hostname: "fragmentation-compact",
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

const RIVAL = {
  hostname: "fragmentation-wide",
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

function solvedRamPerBatch(
  target: typeof PRIMARY | typeof RIVAL,
  skill: number,
): number {
  const node = getBitNodeMultipliers(4, 1);
  const ctx = makeHackContext({
    skill,
    intelligence: 0,
    mults: {
      hacking_chance: 1,
      hacking_money: 1,
      hacking_speed: 1,
      hacking_exp: 1,
      hacking_grow: 1,
    },
  }, node);
  const statics = staticsFromRolls(
    target.hostname,
    {
      money: target.moneyAvailable,
      sec: target.hackDifficulty,
      skill: target.requiredHackingSkill,
      growth: target.serverGrowth,
    },
    {
      ServerMaxMoney: node.ServerMaxMoney,
      ServerStartingSecurity: node.ServerStartingSecurity,
    },
  );
  return solveCycle(ctx, statics)?.ramPerBatch ?? 0;
}

scenarioDescribe("scenario: JIT fragmentation", () => {
  test("retargets across different worker shapes while fleet slabs change", async () => {
    const steadyFromMs = 5 * 60_000;
    const run = await runJitScenario({
      goal: parseGoals(["earn:1e30"]),
      seed: 23,
      horizonMs: 20 * 60_000,
      bitnode: 4,
      homeRam: 128,
      startingMoney: 5e7,
      person: { skills: { hacking: 250 }, exp: { hacking: 6_250_000 } },
      features: only("hacking", "progression"),
      network: [PRIMARY, RIVAL],
      topology: {
        home: [PRIMARY.hostname, RIVAL.hostname],
        [PRIMARY.hostname]: ["home"],
        [RIVAL.hostname]: ["home"],
      },
    });
    const metrics = jitMetrics(run.samples, steadyFromMs);
    const pressure = jitPressure(run.samples, 60_000);
    const final = run.samples.at(-1)!;
    const switched = run.switches.find(
      (event) => event.from === PRIMARY.hostname && event.to === RIVAL.hostname,
    );
    const postLaunchInfrastructure = run.infrastructure.filter((event) => event.launchedHack > 0);
    const cloudChangedMidPipeline = postLaunchInfrastructure.some(
      (event) => event.kind === "buyServer" || event.kind === "upgradeServer",
    );
    const homeChangedMidPipeline = postLaunchInfrastructure.some(
      (event) => event.kind === "upgradeHomeRam",
    );
    const finalSkill = run.skills.at(-1)?.hacking ?? 250;
    const compactBatchGb = solvedRamPerBatch(PRIMARY, finalSkill);
    const wideBatchGb = solvedRamPerBatch(RIVAL, finalSkill);
    const batchShapeRatio = compactBatchGb > 0 ? wideBatchGb / compactBatchGb : 0;

    console.info(formatJitMetrics("jit-fragmentation", metrics));
    console.info(formatJitPressure("jit-fragmentation", pressure));
    console.info(
      "[jit-fragmentation] switch=" + ((switched?.atMs ?? 0) / 1_000) + "s"
      + " skill=" + finalSkill
      + " batch=" + compactBatchGb.toFixed(1) + "->" + wideBatchGb.toFixed(1)
      + "GB ratio=" + batchShapeRatio.toFixed(3)
      + " infrastructure=" + run.infrastructure.length
      + " post-launch=" + postLaunchInfrastructure.length
      + " fleet=" + final.fleetGb + "GB home=" + final.homeGb + "GB"
      + " allocFails=" + final.allocFails
      + " batchesSkipped=" + final.batchesSkipped
      + " missedWindow=" + JSON.stringify(final.missedWindow),
    );

    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(switched).toBeDefined();
    expect(batchShapeRatio).toBeGreaterThanOrEqual(1.5);
    expect(cloudChangedMidPipeline).toBe(true);
    expect(homeChangedMidPipeline).toBe(true);
    expect(final.fleetGb).toBeGreaterThan(128);
    expect(final.homeGb).toBeGreaterThan(128);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(pressure.demandByTarget.has(PRIMARY.hostname)).toBe(true);
    expect(pressure.demandByTarget.has(RIVAL.hostname)).toBe(true);
    expect(pressure.summedTargetDemandGb).toBeGreaterThan(pressure.peakUsableGb);

    // Atomic placement is the defining invariant. Known-bad counts belong in
    // RECORDED comments, not hidden by widening a performance tolerance.
    expect(final.allocFails).toBeLessThanOrEqual(1);
    expect(final.batchesSkipped).toBeLessThanOrEqual(4);
    expect(metrics.medianIdleShare).toBeLessThanOrEqual(
      RECORDED.medianIdleShare + TOLERANCE.idleShare,
    );
    expect(metrics.windowCompletion).toBeGreaterThanOrEqual(
      RECORDED.windowCompletion - TOLERANCE.windowCompletion,
    );
    expect(metrics.moneyPerSec).toBeGreaterThanOrEqual(
      RECORDED.moneyPerSec * (1 - TOLERANCE.moneyFraction),
    );
  }, 120_000);
});

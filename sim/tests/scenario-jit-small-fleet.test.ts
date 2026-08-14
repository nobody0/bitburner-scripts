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
} from "./jit-scenario.ts";

/** SMALL FLEET - the early BN1 scheduling regime. Unlike the other JIT
 * scenarios, one atomic farm block is a material fraction of the 32 GB home,
 * infrastructure grows through small rungs, and prep plus the dodge arena
 * contend with farm for the same executable slabs. The full share-capable
 * feature set is enabled, but its measured allotment remains zero here—just
 * as it does in BN1 seed 1—so the fixture does not fabricate share pressure.
 *
 * RECORDED OPTIMUM (update when you beat it, never when you regress):
 *   utilisation (median idle share) : 0.533959
 *   window completion (landed/launched hacks) : 0.962406
 *   money/sec over the steady window : $2.651615e5
 *
 * With unconditional commit-time reservation this fixture recorded 0.704102 /
 * 0.993569 / $1.166606e5 and 633 allocation failures. The higher completion
 * was bought by losing 56% of income while prep held first priority. */
const RECORDED = {
  medianIdleShare: 0.533959,
  windowCompletion: 0.962406,
  moneyPerSec: 2.651615e5,
} as const;

const EARNER = {
  hostname: "smallfleet-earner",
  organizationName: "scenario",
  hackDifficulty: 1,
  currentDifficulty: 1,
  moneyAvailable: 200_000,
  currentMoney: 5_000_000,
  requiredHackingSkill: 1,
  serverGrowth: 3_000,
  numOpenPortsRequired: 0,
  maxRam: 0,
} as const;

const RIVAL = {
  hostname: "smallfleet-rival",
  organizationName: "scenario",
  hackDifficulty: 10,
  moneyAvailable: 2_000_000,
  requiredHackingSkill: 1,
  serverGrowth: 5,
  numOpenPortsRequired: 0,
  maxRam: 16,
} as const;

const PREP = {
  hostname: "smallfleet-prep",
  organizationName: "scenario",
  hackDifficulty: 20,
  moneyAvailable: 500_000_000,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 16,
} as const;

scenarioDescribe("scenario: JIT on a small contended fleet", () => {
  test("keeps current farm windows alive while the fleet compounds", async () => {
    const steadyFromMs = 10 * 60_000;
    const run = await runJitScenario({
      goal: parseGoals(["rep:CyberSec:1e12", "earn:1e30"]),
      seed: 1,
      horizonMs: 45 * 60_000,
      bitnode: 1,
      homeRam: 32,
      startingMoney: 1_000_000,
      person: { skills: { hacking: 127 }, exp: { hacking: calculateExp(127) } },
      playerState: { factions: ["CyberSec"], ownedSourceFiles: { "4": 3 } },
      factions: { CyberSec: { rep: 0, favor: 0 } },
      features: only("hacking", "factions", "career", "progression", "go", "hacknet", "stock"),
      network: [EARNER, RIVAL, PREP],
      topology: {
        home: [EARNER.hostname, RIVAL.hostname, PREP.hostname],
        [EARNER.hostname]: ["home"],
        [RIVAL.hostname]: ["home"],
        [PREP.hostname]: ["home"],
      },
    });
    const metrics = jitMetrics(run.samples, steadyFromMs);
    const pressure = jitPressure(run.samples, steadyFromMs);
    const final = run.samples.at(-1)!;
    const positiveFleet = run.samples.map((sample) => sample.fleetGb).filter((gb) => gb > 0);
    const minFleetGb = Math.min(...positiveFleet);
    const peakFleetGb = Math.max(...run.samples.map((sample) => sample.fleetGb));
    const maxShareGb = Math.max(...run.samples.map((sample) => sample.shareGb));
    const maxPrepGb = Math.max(...run.samples.map((sample) => sample.prepGb));
    const maxReserveGb = Math.max(...run.samples.map((sample) => sample.reserveGb));
    const farmAndPrep = run.samples.some((sample) => sample.farmGb > 0 && sample.prepGb > 0);

    console.info(formatJitMetrics("jit-small-fleet", metrics));
    console.info(formatJitPressure("jit-small-fleet", pressure));
    console.info(
      "[jit-small-fleet] home=" + final.homeGb + "GB fleet=" + minFleetGb + ".." + peakFleetGb + "GB"
      + " fleet=" + final.fleetGb + "GB infrastructure=" + run.infrastructure.length
      + " prep-max=" + maxPrepGb + "GB share-max=" + maxShareGb + "GB arena-max=" + maxReserveGb + "GB"
      + " segOrder=" + final.segOrder.join(">")
      + " allocFails=" + final.allocFails + " batchesSkipped=" + final.batchesSkipped
      + " allocFailsByPhase=" + JSON.stringify(final.allocFailsByPhase)
      + " missedWindow=" + JSON.stringify(final.missedWindow),
    );
    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(run.infrastructure.length).toBeGreaterThan(0);
    expect(minFleetGb).toBeLessThanOrEqual(128);
    expect(peakFleetGb).toBeGreaterThan(128);
    expect(maxPrepGb).toBeGreaterThan(0);
    expect(maxShareGb).toBe(0);
    expect(maxReserveGb).toBeGreaterThan(0);
    expect(farmAndPrep).toBe(true);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(final.batchesSkipped).toBeLessThanOrEqual(4);
    expect(metrics.medianIdleShare).toBeLessThanOrEqual(RECORDED.medianIdleShare + 0.03);
    expect(metrics.windowCompletion).toBeGreaterThanOrEqual(RECORDED.windowCompletion - 0.04);
    expect(metrics.moneyPerSec).toBeGreaterThanOrEqual(RECORDED.moneyPerSec * 0.95);
  }, 180_000);
});

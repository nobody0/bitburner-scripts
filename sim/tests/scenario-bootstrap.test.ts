import { expect, test } from "bun:test";
import { lane } from "../../tests/support/lanes.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { DEFAULT_NETWORK } from "../network.ts";
import {
  formatJitMetrics,
  formatJitPressure,
  jitMetrics,
  jitPressure,
  runJitScenario,
} from "./jit-scenario.ts";

/** BOOTSTRAP - the actual BN1 opening used by bn1-speedrun: skill 1, $1,000,
 * an 8 GB home, no purchased servers, and the repository's real early network.
 * Unlike the established-fleet fixtures, this measures whether the controller
 * turns the first few threads into both skill and reinvestable cash promptly.
 *
 * RECORDED OPTIMUM (update when you beat it, never when you regress):
 *   time to $500k earned : 9.216667 min
 *   utilisation (median idle share) : 0.201434
 *   window completion (landed/launched hacks) : 0.888889
 *   money/sec over the measured window : $1.199933e3
 *
 * $500k deliberately isolates the cold opening before the vanilla ten-minute
 * coding-contract generation boundary; later income sources belong to broader
 * route scenarios rather than this fleet-bootstrap measurement.
 */
const RECORDED = {
  timeToMoneyMs: 553_000,
  medianIdleShare: 0.201434,
  windowCompletion: 0.888889,
  moneyPerSec: 1.199933e3,
} as const;

lane({ feature: "hacking", bn: 1 }).describe("scenario: BN1 bootstrap from a cold start", () => {
  test("reaches its first money milestone while building a productive fleet", async () => {
    const steadyFromMs = 2 * 60_000;
    const run = await runJitScenario({
      goal: parseGoals(["earn:5e5"]),
      seed: 1,
      horizonMs: 10 * 60_000 - 200,
      bitnode: 1,
      homeRam: 8,
      startingMoney: 1_000,
      network: DEFAULT_NETWORK,
    });
    const metrics = jitMetrics(run.samples, steadyFromMs);
    const pressure = jitPressure(run.samples, steadyFromMs);
    const final = run.samples.at(-1)!;
    const firstTarget = run.samples.find((sample) => sample.target)?.target;

    console.info(
      `[bootstrap] time-to-$500k=${(run.result.timeToGoalMs / 60_000).toFixed(6)}min`,
    );
    console.info(formatJitMetrics("bootstrap", metrics));
    console.info(formatJitPressure("bootstrap", pressure));
    console.info(
      "[bootstrap] target=" + firstTarget
      + " home=" + final.homeGb + "GB fleet=" + final.fleetGb + "GB"
      + " infrastructure=" + JSON.stringify(run.infrastructure)
      + " allocFails=" + final.allocFails
      + " allocFailsByPhase=" + JSON.stringify(final.allocFailsByPhase)
      + " missedWindow=" + JSON.stringify(final.missedWindow),
    );

    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(run.result.reached).toBe(true);
    expect(firstTarget).toBe("n00dles");
    expect(run.infrastructure.length).toBeGreaterThan(0);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(run.result.timeToGoalMs).toBeLessThanOrEqual(RECORDED.timeToMoneyMs);
    expect(metrics.medianIdleShare).toBeLessThanOrEqual(RECORDED.medianIdleShare + 0.03);
    expect(metrics.windowCompletion).toBeGreaterThanOrEqual(RECORDED.windowCompletion - 0.04);
    expect(metrics.moneyPerSec).toBeGreaterThanOrEqual(RECORDED.moneyPerSec * 0.95);
  }, 180_000);
});

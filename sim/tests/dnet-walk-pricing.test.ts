import { describe, expect, test } from "bun:test";
import { LAB_LADDER, LAB_WALK_ATTEMPTS } from "../../shared/strategy/dnet/rates.ts";
import { labyrinthWalkFallbackSec } from "../../shared/strategy/progression/eta.ts";
import { generateLabCorpus, labAuthenticationMs, plannerRoute, runLabCase } from "../dnet-lab.ts";

/** The route's walk pricing, re-derived from the lane that measured it.
 *
 * `LAB_WALK_ATTEMPTS` (`shared/strategy/dnet/rates.ts`) is a transcription of
 * this arena's own output, and `eta.ts` prices every labyrinth stage with it.
 * `shared/` cannot import `sim/`, so without this the two would drift the
 * moment the deployed route changed — and the route is the one thing here that
 * is meant to keep improving. 12 seeds rather than the benchmark's 64, matching
 * the arena test below: enough to hold the mean inside a tolerance a real
 * improvement would break, without doubling this file's cost. */
describe("the walk-attempt table the route prices with", () => {
  const SEEDS = Array.from({ length: 12 }, (_, index) => index + 1);
  const cases = generateLabCorpus(SEEDS);
  const runs = cases.map((lab) => runLabCase(lab, plannerRoute()));

  test("every rung still solves, at the recorded attempt count", () => {
    for (const stage of LAB_LADDER) {
      const mine = runs.filter((_, index) => cases[index]!.stage.hostname === stage.hostname);
      expect(mine.length, stage.hostname).toBe(SEEDS.length);
      expect(mine.every((run) => run.solved), stage.hostname).toBe(true);
      const mean = mine.reduce((sum, run) => sum + run.attempts, 0) / mine.length;
      const recorded = LAB_WALK_ATTEMPTS[stage.hostname]!;
      expect(recorded, stage.hostname).toBeGreaterThan(0);
      // A third either way. Sampling noise between 12 and 64 seeds lives inside
      // this; a route that got materially better or worse does not, and the
      // table is meant to be re-measured when it does.
      expect(mean, `${stage.hostname} mean=${mean.toFixed(1)} recorded=${recorded}`)
        .toBeGreaterThan(recorded / 1.35);
      expect(mean, `${stage.hostname} mean=${mean.toFixed(1)} recorded=${recorded}`)
        .toBeLessThan(recorded * 1.35);
    }
  });

  test("the ETA's seconds are the lane's own milliseconds", () => {
    // `shared/`'s `authenticateWaitMs` and `sim/`'s `labAuthenticationMs` are
    // two transcriptions of one upstream formula, and the route's stage price
    // multiplies one of them by this table. If they ever disagree, the route
    // is pricing a walk the simulator will not run.
    for (const [index, stage] of LAB_LADDER.entries()) {
      const perAttemptMs = labAuthenticationMs(stage, { charisma: stage.cha });
      const expected = (LAB_WALK_ATTEMPTS[stage.hostname]! * perAttemptMs) / 1_000;
      expect(labyrinthWalkFallbackSec(index), stage.hostname).toBeCloseTo(expected, 6);
    }
  });
});

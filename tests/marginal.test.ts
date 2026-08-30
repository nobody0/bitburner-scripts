import { describe, expect, test } from "bun:test";
import { stepEndgame } from "../shared/strategy/progression/endgame.ts";
import { FALLBACK_DAEDALUS_REP_PER_SEC, noRates } from "../shared/strategy/progression/eta.ts";
import { estimatedForecast, unknownForecast } from "../shared/strategy/progression/forecast.ts";
import {
  growingProgressSecondsPerRelativeRate,
  linearSecondsPerRelativeRate,
  progressionMarginals,
} from "../shared/strategy/progression/marginal.ts";
import { freshEndgameView as view } from "./fixtures/endgame-view.ts";

describe("progression marginal value", () => {
  /** The reputation channel is the one the BN4 route is bound by: on
   * `leg-bn4.1` seed 1 at t=18.68h the `daedalus reputation` leg was 28.68h of
   * a 39.77h route, and the published marginal read
   * `horizon: "future-binding"` with no `atRatePerSec` — the signature of a
   * perturbation that moved nothing. */
  describe("the reputation slope is taken at the rate the route is priced with", () => {
    /** Daedalus not yet worked, so the MEASURED tracker is zero and the ETA
     * prices the leg off the driver's formula projection. */
    const unworked = () => ({
      ...noRates(),
      moneyPerSec: 1_000_000,
      daedalusRepPerSec: 0,
      daedalusRepPerSecProjected: 24,
    });
    const marginalsFor = (rates: ReturnType<typeof unworked>) => {
      const current = view({ augCount: 30, money: 0, hackingSkill: 2_500 });
      return progressionMarginals({
        view: current,
        decision: stepEndgame(current),
        rates,
        selectedRoute: "daedalus",
        install: unknownForecast(0, "route-only", "no install forecast"),
      });
    };

    test("a projected-only rate still produces a perturbed slope, not the floor", () => {
      const marginals = marginalsFor(unworked());
      expect(marginals.reputation.state).toBe("estimated");
      expect(marginals.reputation.secondsPerRelativeRate).toBeGreaterThan(0);
      // `future-binding` is this module's label for "neither perturbation
      // moved, so the coarse all-parts floor was used". Scaling the measured
      // tracker — zero — could only ever produce that.
      expect(marginals.reputation.horizon).not.toBe("future-binding");
    });

    test("it publishes the operating point the slope was taken at", () => {
      // Without this a consumer converting an absolute rep/sec gain into a
      // relative one has no denominator, which is the circular starvation this
      // file already documents having fixed for money.
      expect(marginalsFor(unworked()).reputation.atRatePerSec).toBe(24);
      // Measured beats projected, exactly as eta.ts orders them.
      expect(marginalsFor({ ...unworked(), daedalusRepPerSec: 37 }).reputation.atRatePerSec).toBe(37);
      // Neither: the declared fallback the ETA itself would have priced with.
      const bare = { ...noRates(), moneyPerSec: 1_000_000 };
      expect(marginalsFor(bare as ReturnType<typeof unworked>).reputation.atRatePerSec)
        .toBe(FALLBACK_DAEDALUS_REP_PER_SEC);
    });

    test("a branch flip is capped to a slope, not read as a hundredfold one", () => {
      // `routeEtas` picks the cheaper of grinding the reputation and donating
      // for it. A 1% rate change that flips that branch moves the estimate by
      // the WHOLE branch difference, and dividing a step by delta=0.01
      // multiplies it by a hundred — which is how a channel that is worth
      // roughly its own leg came to out-bid every other use of the work slot,
      // stalling a leg seed outright (bench3 seed 1: hacking 3 for the 7.8h
      // after its last install). The slope may never exceed the linear reading
      // of the same legs.
      const marginals = marginalsFor(unworked());
      const repSec = 2_500_000 / 24; // the gap at the projected rate
      expect(marginals.reputation.secondsPerRelativeRate)
        .toBeLessThanOrEqual(linearSecondsPerRelativeRate(repSec) * 1.01);
    });

    test("a faster projected rate is worth strictly fewer seconds", () => {
      // The property the slope exists to express: the same reputation gap at a
      // higher rate is a shorter leg, so the marginal second is worth less.
      const slow = marginalsFor(unworked()).reputation.secondsPerRelativeRate;
      const fast = marginalsFor({ ...unworked(), daedalusRepPerSecProjected: 240 }).reputation
        .secondsPerRelativeRate;
      expect(fast).toBeLessThan(slow);
    });
  });


  test("falls back to the node when money is not the install bottleneck", () => {
    const current = view({ augCount: 30, money: 0, hackingSkill: 2_500 });
    const install = estimatedForecast(0, "rep-bound", [
      { what: "reputation", resource: "reputation", sec: 1_000, measured: true, mode: "parallel" },
      { what: "money", resource: "money", sec: 100, measured: true, mode: "parallel" },
    ]);
    const marginals = progressionMarginals({
      view: current,
      decision: stepEndgame(current),
      rates: { ...noRates(), moneyPerSec: 1_000_000, daedalusRepPerSec: 50 },
      selectedRoute: "daedalus",
      install,
    });
    expect(marginals.money.state).toBe("estimated");
    expect(marginals.money.horizon).toBe("node");
    expect(marginals.money.secondsPerRelativeRate).toBeGreaterThan(0);
  });

  test("keeps a future-binding slope for a known nonbinding dependency", () => {
    const current = view();
    const install = estimatedForecast(0, "parallel", [
      { what: "reputation", resource: "reputation", sec: 1_000, measured: true, mode: "parallel" },
      { what: "money", resource: "money", sec: 100, measured: true, mode: "parallel" },
    ]);
    const marginals = progressionMarginals({
      view: current,
      decision: stepEndgame(current),
      rates: noRates(),
      install,
    });
    expect(marginals.money).toMatchObject({ state: "estimated", horizon: "future-binding" });
    expect(marginals.money.secondsPerRelativeRate).toBeGreaterThan(0);
  });

  test("re-prices nonlinear cycle curves with a bounded route evaluation", () => {
    const current = view({ augCount: 29, money: 1_000_000, hackingSkill: 100 });
    const rates = {
      ...noRates(),
      cycle: {
        elapsedSec: 120,
        points: [
          { sec: 60, money: 1_000_000, hacking: 50, combat: 1 },
          { sec: 120, money: 4_000_000, hacking: 100, combat: 1 },
        ],
      },
    };
    const marginals = progressionMarginals({
      view: current,
      decision: stepEndgame(current),
      rates,
      selectedRoute: "daedalus",
      install: unknownForecast(0, "none", "no package"),
    });
    // The horizon label may be "node" (perturbation) or "future-binding"
    // (the local-slope floor won); either way the worth is real and positive.
    expect(marginals.money.state).toBe("estimated");
    expect(marginals.money.secondsPerRelativeRate).toBeGreaterThan(0);
  });

  test("a combat-gated route prices its combat rate, and an unrelated one does not", () => {
    // Daedalus accepts hacking 2500 OR all four combat skills at 1500. With the
    // hacking climb far away and combat progressing, the combat branch binds and
    // a faster combat rate genuinely shortens the node — so an augmentation that
    // multiplies combat stats has a measured price instead of a guessed weight.
    const combatBound = view({ augCount: 30, hackingSkill: 1, lowestCombatSkill: 1_400, money: 1e12 });
    const marginals = progressionMarginals({
      view: combatBound,
      decision: stepEndgame(combatBound),
      rates: { ...noRates(), moneyPerSec: 1e9, combatSkillPerSec: 1, hackingSkillPerSec: 1e-6, daedalusRepPerSec: 50 },
      selectedRoute: "daedalus",
      install: unknownForecast(0, "none", "no package"),
    });
    expect(marginals.combat.state).toBe("estimated");
    expect(marginals.combat.secondsPerRelativeRate).toBeGreaterThan(0);
    // Bladeburner is not on this route at all. A measured zero is the answer —
    // never `unknown`, which would put its claims back on the bootstrap rule.
    expect(marginals.bladeburnerRank).toMatchObject({ state: "estimated", secondsPerRelativeRate: 0 });
  });

  test("linear reputation work uses the closed-form gap/rate slope", () => {
    // gap 500 at a 1% relative rate: 500/1.01 seconds, pinned rather than
    // recomputed so a change to the slope shows up as a changed number here.
    expect(linearSecondsPerRelativeRate(500, 0.01)).toBeCloseTo(495.0495, 4);
    expect(growingProgressSecondsPerRelativeRate({
      gap: 1_000,
      initialProgress: 0,
      progressPerSec: 1,
      rateAtProgress: (progress) => 10 + progress * 0.2,
    })).toBeGreaterThan(0);
  });
});

describe("parallel-maximum masking (the invite-gate collapse)", () => {
  test("a skill leg hidden behind a slower money gate keeps its floor worth", () => {
    // Count gate met; the invite needs $100b AND hacking 2500. Money is far
    // slower, so the emitted binding part is the money gate and an
    // infinitesimal hacking perturbation moves nothing — but the climb is
    // real future work, and its linear slope must floor the hacking worth.
    const current = view({ augCount: 30, money: 0, hackingSkill: 100 });
    const marginals = progressionMarginals({
      view: current,
      decision: stepEndgame(current),
      // moneyPerSec prices the money gate at 1e11/1e4 = 1e7s; the hacking
      // climb at 2400 levels / 1/s = 2400s is fully masked behind it.
      rates: { ...noRates(), moneyPerSec: 10_000, hackingSkillPerSec: 1 },
      selectedRoute: "daedalus",
      install: unknownForecast(0, "none", "no install pending"),
    });
    expect(marginals.hacking.state).toBe("estimated");
    expect(marginals.hacking.secondsPerRelativeRate).toBeGreaterThanOrEqual(
      linearSecondsPerRelativeRate(2_000),
    );
  });
});

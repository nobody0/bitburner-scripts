import { describe, expect, test } from "bun:test";
import { stepEndgame } from "../shared/strategy/progression/endgame.ts";
import { noRates } from "../shared/strategy/progression/eta.ts";
import { estimatedForecast, unknownForecast } from "../shared/strategy/progression/forecast.ts";
import {
  growingProgressSecondsPerRelativeRate,
  linearSecondsPerRelativeRate,
  progressionMarginals,
} from "../shared/strategy/progression/marginal.ts";
import { freshEndgameView as view } from "./fixtures/endgame-view.ts";

describe("progression marginal value", () => {
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
    expect(marginals.money).toMatchObject({ state: "estimated", horizon: "node" });
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

  test("every resource is reported, so an unpriced channel is never an absent one", () => {
    const current = view();
    const marginals = progressionMarginals({
      view: current,
      decision: stepEndgame(current),
      rates: noRates(),
      install: unknownForecast(0, "none", "no package"),
    });
    expect(Object.keys(marginals).sort())
      .toEqual(["augmentations", "bladeburnerRank", "combat", "hacking", "money", "reputation"]);
  });

  test("linear reputation work uses the closed-form gap/rate slope", () => {
    expect(linearSecondsPerRelativeRate(500, 0.01)).toBeCloseTo(500 / 1.01, 10);
    expect(growingProgressSecondsPerRelativeRate({
      gap: 1_000,
      initialProgress: 0,
      progressPerSec: 1,
      rateAtProgress: (progress) => 10 + progress * 0.2,
    })).toBeGreaterThan(0);
  });
});

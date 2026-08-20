import { describe, expect, test } from "bun:test";
import { announcedRates } from "../game/lib/income.ts";
import { depthCapGb, farmExperienceRate, farmIncomeRate } from "../shared/strategy/economics.ts";
import type { GameState } from "../game/lib/state.ts";

/** THE BUG THIS PINS, measured on a live BN12 install: with 5,342 hacks
 * launched and 0 landed, the farm's realized EMAs read `$0/s` and `0 exp/s`,
 * so `career` won the work slot for an Algorithms course as "the best hacking
 * experience producer" — against a farm nineteen minutes from being ten times
 * better at it. The committed solution already knew; nobody announced it. */

function state(topics: Record<string, unknown>): GameState {
  return {
    topics, dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
    probeFailures: {}, featureLastRun: {},
  } as unknown as GameState;
}

const rate = (channel: string, s: GameState) => {
  const entry = announcedRates(s).find((a) => a.by === "hacking" && a.channel === channel);
  return entry?.state === "measured" ? entry.perSec : undefined;
};

/** One batch per BATCH_INTERVAL_S over a 40s weaken: a ten-deep pipeline. */
const SOLUTION = { score: 5, experienceScore: 2, ramPerBatch: 100, weakenTimeS: 40 };

describe("the farm's forward rate", () => {
  test("saturates at the depth cap, because RAM past it earns nothing", () => {
    const cap = depthCapGb(SOLUTION);
    expect(farmIncomeRate(SOLUTION, cap / 2)).toBeCloseTo(5 * cap / 2, 9);
    expect(farmIncomeRate(SOLUTION, cap * 10), "extra RAM the pipeline cannot absorb")
      .toBeCloseTo(5 * cap, 9);
    // Experience saturates on the same cap: it is the same batch.
    expect(farmExperienceRate(SOLUTION, cap * 10)).toBeCloseTo(2 * cap, 9);
  });

  test("a solution with no experience score contributes none, rather than guessing", () => {
    expect(farmExperienceRate({ score: 5, ramPerBatch: 100, weakenTimeS: 40 }, 1_000)).toBe(0);
    expect(farmExperienceRate(undefined, 1_000)).toBe(0);
  });

  test("a warming-up farm announces what its batch WILL produce", () => {
    const warmingUp = state({
      fleet: { scriptIncome: [0, 0] },
      farm: { moneyRate: 0, expRate: 0, predicted: { moneyPerSec: 3.25e8, expPerSec: 12_300 } },
    });
    expect(rate("money", warmingUp)).toBe(3.25e8);
    expect(rate("hacking", warmingUp)).toBe(12_300);
  });

  test("the realized rate is a FLOOR, not a competitor", () => {
    // Mid target-switch the EMA still describes the outgoing solution landing
    // while the prediction describes the incoming one. Whichever is larger is
    // the honest answer to "what will this feature produce if left alone" —
    // and it is never less than what it is already producing.
    const switching = state({
      fleet: { scriptIncome: [9e8, 0] },
      farm: { moneyRate: 8e8, expRate: 40_000, predicted: { moneyPerSec: 1e8, expPerSec: 1_000 } },
    });
    expect(rate("money", switching)).toBe(9e8);
    expect(rate("hacking", switching)).toBe(40_000);
  });

  test("no farm at all is UNKNOWN experience, which is not a measured zero", () => {
    // A course must still win the slot on a fresh run with no fleet — the fix
    // for the warm-up case must not become a rule that studying is forbidden.
    const fresh = announcedRates(state({}));
    expect(fresh.find((a) => a.by === "hacking" && a.channel === "hacking")?.state).toBe("unknown");
  });
});

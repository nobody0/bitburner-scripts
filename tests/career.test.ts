import { describe, expect, test } from "bun:test";
import {
  expPerSec,
  karmaPerSec,
  moneyPerSec,
  secondsToKarma,
  successChance,
  type CrimeContext,
  type CrimePerson,
  type CrimeStats,
} from "../shared/strategy/career/crimes.ts";
import { CAREER_KINDS, needValues, stepCareer, type CareerView } from "../shared/strategy/career/decide.ts";
import { PORT_OPENER_PROGRAMS, programCreateTimeMs, preferProgramCreation } from "../shared/strategy/career/programs.ts";
import { postNeeds, type Need } from "../shared/strategy/needs.ts";
import { DEFAULT_PLANNING_HORIZON_SEC } from "../shared/strategy/progression/forecast.ts";

const CTX: CrimeContext = { crimeSuccessRate: 1, crimeMoney: 1 };

function person(skills: Partial<Record<string, number>> = {}): CrimePerson {
  return {
    skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0, ...skills },
    mults: { crime_success: 1, crime_money: 1 },
  };
}

function crime(over: Partial<CrimeStats> = {}): CrimeStats {
  return {
    type: "Mug",
    timeMs: 4_000,
    money: 36_000,
    difficulty: 0.2,
    karma: 0.25,
    kills: 0,
    weights: { strength: 1.5, defense: 0.5, dexterity: 1.5, agility: 0.5 },
    exp: { strength: 3, defense: 3, dexterity: 3, agility: 3 },
    ...over,
  };
}

describe("crime math", () => {
  test("success chance is capped at 1 and scales with the right skills", () => {
    expect(successChance(crime(), person(), CTX)).toBeLessThan(1);
    expect(successChance(crime(), person({ strength: 1e6, dexterity: 1e6 }), CTX)).toBe(1);
    // Hacking does not help a mugging.
    expect(successChance(crime(), person({ hacking: 1e6 }), CTX)).toBeCloseTo(
      successChance(crime(), person(), CTX),
      6,
    );
  });

  test("the game's own chance wins over the transcription when supplied", () => {
    // Not a shortcut: if the transcription ever drifts from the game, the
    // OBSERVED value is the one that is actually true.
    expect(successChance(crime({ chance: 0.42 }), person(), CTX)).toBe(0.42);
    expect(successChance(crime({ chance: 5 }), person(), CTX)).toBe(1);
    expect(successChance(crime({ chance: -1 }), person(), CTX)).toBe(0);
  });

  test("karma is a POSITIVE rate meaning karma falls that fast", () => {
    // The table stores karma positive and the game SUBTRACTS it. Treating it
    // as an addition inverts every karma decision in the game.
    const rate = karmaPerSec(crime({ chance: 1 }), person(), CTX);
    expect(rate).toBeCloseTo(0.25 / 4, 10);
    expect(secondsToKarma(crime({ chance: 1 }), person(), CTX, 0, -45)).toBeCloseTo(45 / rate, 6);
    // Already satisfied costs nothing.
    expect(secondsToKarma(crime({ chance: 1 }), person(), CTX, -50, -45)).toBe(0);
  });

  test("even an impossible crime earns failure karma at one-quarter rate", () => {
    expect(secondsToKarma(crime({ chance: 0 }), person(), CTX, 0, -45)).toBeFinite();
  });

  test("failed crimes grant quarter experience", () => {
    const easy = expPerSec(crime({ chance: 1 }), person(), CTX);
    const hard = expPerSec(crime({ chance: 0.1 }), person(), CTX);
    expect(hard["strength"]).toBeCloseTo(easy["strength"]! * 0.325, 10);
  });

  test("BitNode multipliers flow through money and chance", () => {
    const doubled = moneyPerSec(crime({ chance: 1 }), person(), { crimeSuccessRate: 1, crimeMoney: 2 });
    expect(doubled).toBeCloseTo(moneyPerSec(crime({ chance: 1 }), person(), CTX) * 2, 6);
  });

  test("live getCrimeStats gains are not multiplied a second time", () => {
    const p = person();
    p.mults.crime_money = 3;
    p.mults.strength_exp = 4;
    const observed = crime({ chance: 1, money: 108_000, exp: { strength: 12 }, gainsAreEffective: true });
    expect(moneyPerSec(observed, p, { crimeSuccessRate: 9, crimeMoney: 5, crimeExp: 7 })).toBe(27_000);
    expect(expPerSec(observed, p, { crimeSuccessRate: 9, crimeMoney: 5, crimeExp: 7 }).strength).toBe(3);
  });
});

// --- the needs-board consumer ------------------------------------------------

function view(over: Partial<CareerView> = {}): CareerView {
  return {
    time: 0,
    person: person(),
    crimeContext: CTX,
    crimes: [],
    courses: [],
    karma: 0,
    numPeopleKilled: 0,
    skills: { strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, hacking: 1 },
    city: "Sector-12",
    holdsWorkSlot: true,
    moneyGranted: 0,
    ...over,
  };
}

function need(over: Partial<Need> & Pick<Need, "kind" | "target" | "have">): Need {
  return { by: "factions", weight: 1, urgency: "blocking", ...over };
}

describe("career as the needs-board consumer", () => {
  const shoplift = crime({ type: "Shoplift", timeMs: 2_000, money: 15_000, karma: 0.1, chance: 1, kills: 0 });
  const homicide = crime({ type: "Homicide", timeMs: 3_000, money: 45_000, karma: 3, kills: 1, chance: 1 });

  test("factions asks for KARMA and career picks the crime — it is never told which", () => {
    // The whole point of the board. `factions` posts an outcome; career owns
    // the method. Homicide moves karma 30x faster than Shoplift per second.
    const decision = stepCareer(
      view({ crimes: [shoplift, homicide] }),
      postNeeds([need({ kind: "karma", target: -45, have: 0, weight: 10 })]),
    );
    expect(decision.action.type).toBe("crime");
    expect(decision.action.subject).toBe("Homicide");
    expect(decision.incomeFallback).toBe(false);
  });

  test("a satisfied need stops driving the choice", () => {
    // karma already met -> nothing posted -> income fallback, and Shoplift
    // earns more per second than Homicide ($7.5k/s vs $15k/s... check).
    const decision = stepCareer(
      view({ crimes: [shoplift, homicide] }),
      postNeeds([need({ kind: "karma", target: -45, have: -50, weight: 10 })]),
    );
    expect(decision.incomeFallback).toBe(true);
    // Homicide: 45000/3 = 15000/s. Shoplift: 15000/2 = 7500/s.
    expect(decision.action.subject).toBe("Homicide");
  });

  test("with nothing posted at all it maximises income, not karma", () => {
    const rich = crime({ type: "Heist", timeMs: 10_000, money: 1e6, karma: 0.1, chance: 1 });
    const decision = stepCareer(view({ crimes: [shoplift, homicide, rich] }), postNeeds([]));
    expect(decision.incomeFallback).toBe(true);
    expect(decision.action.subject).toBe("Heist");
  });

  test("the NEARER of two thresholds on one outcome sets the distance left", () => {
    // Clearing the near one unblocks a feature; the far one behind it does not
    // change what career should do. (Their WORTH adds instead — that happens in
    // `channelWorth`, and tests/income.test.ts pins it.)
    const values = needValues(postNeeds([
      need({ by: "factions", kind: "karma", target: -45, have: 0, weight: 1 }),
      need({ by: "gang", kind: "karma", target: -54_000, have: 0, weight: 20 }),
    ]));
    expect(values.get("karma")!.remaining).toBe(45);
  });

  test("kills are a separate outcome from karma", () => {
    const decision = stepCareer(
      view({ crimes: [shoplift, homicide] }),
      postNeeds([need({ kind: "kills", target: 30, have: 0, weight: 10 })]),
    );
    // Only Homicide kills, so only it can serve the need.
    expect(decision.action.subject).toBe("Homicide");
  });

  test("a combat need is gated by the WEAKEST stat", () => {
    // A crime that trains only strength cannot clear a combat threshold whose
    // binding constraint is agility.
    const lopsided = crime({ type: "Lopsided", chance: 1, exp: { strength: 100 } });
    const balanced = crime({ type: "Balanced", chance: 1, exp: { strength: 5, defense: 5, dexterity: 5, agility: 5 } });
    const decision = stepCareer(
      view({ crimes: [lopsided, balanced] }),
      postNeeds([need({ kind: "combatSkills", target: 30, have: 1, weight: 10 })]),
    );
    expect(decision.action.subject).toBe("Balanced");
  });

  test("kinds another feature owns are ignored, not scored at zero", () => {
    expect(CAREER_KINDS).not.toContain("hacknetRam");
    expect(CAREER_KINDS).not.toContain("bladeburnerRank");
    const board = postNeeds([need({ kind: "hacknetRam", target: 8, have: 0, weight: 99 })]);
    expect(needValues(board).size).toBe(0);
  });

  test("without the work slot it idles rather than cancelling someone else's work", () => {
    const decision = stepCareer(
      view({ crimes: [homicide], holdsWorkSlot: false }),
      postNeeds([need({ kind: "karma", target: -45, have: 0, weight: 10 })]),
    );
    expect(decision.action.type).toBe("idle");
  });

  test("the continuation guard stops re-issuing the same crime", () => {
    // commitCrime CANCELS whatever is running, so re-issuing every tick would
    // restart it forever and never bank a single completion.
    const decision = stepCareer(
      view({ crimes: [homicide], currentWork: { kind: "crime", subject: "Homicide" } }),
      postNeeds([need({ kind: "karma", target: -45, have: 0, weight: 10 })]),
    );
    expect(decision.action.type).toBe("idle");
  });

  test("ranking is deterministic under ties", () => {
    const a = crime({ type: "Alpha", chance: 1 });
    const b = crime({ type: "Beta", chance: 1 });
    const forward = stepCareer(view({ crimes: [a, b] }), postNeeds([]));
    const backward = stepCareer(view({ crimes: [b, a] }), postNeeds([]));
    expect(forward.action.subject).toBe(backward.action.subject!);
  });

  test("travel is administrative and may run while another feature holds crime work", () => {
    const decision = stepCareer(
      view({ crimes: [homicide], holdsWorkSlot: false, currentWork: { kind: "crime", subject: "Homicide" } }),
      postNeeds([need({ kind: "city", subject: "Aevum", target: 1, have: 0 })]),
    );
    expect(decision.action).toMatchObject({ type: "travel", subject: "Aevum" });
  });

  test("with nothing priced the slot earns; once a channel is priced it stops earning", () => {
    const early = stepCareer(
      view({
        crimes: [shoplift],
        jobs: { FoodNStuff: "Employee" },
        companies: [{ name: "FoodNStuff", rep: 0, moneyPerSec: 20_000 }],
      }),
      postNeeds([]),
    );
    expect(early.action).toMatchObject({ type: "company", subject: "FoodNStuff" });

    // ...and once the route prices hacking experience, the SAME menu picks the
    // course instead — not because of a phase rule about fresh installs, but
    // because a channel worth 19,000 BN-seconds beats $7,500/sec of crime
    // against a money channel worth 100.
    const later = stepCareer(
      view({
        crimes: [shoplift],
        courses: [{ name: "Algorithms", skill: "hacking", expPerSec: 8, costPerSec: 960, location: "Rothman University" }],
        // A course must be funded for a full training window (30s), not any positive grant.
        moneyGranted: 30_000,
        rates: { best: new Map(), worth: new Map([["hacking", 19_000], ["money", 100]]) },
      }),
      postNeeds([]),
    );
    expect(later.action).toMatchObject({ type: "class", subject: "Algorithms" });
  });

  test("which skill to train follows the route's own marginals, not a named fallback", () => {
    // `defaultSkill` used to name the course a phase rule would study. Whichever
    // channel the route actually values now selects it, and a node where
    // charisma is what binds reaches that answer by itself.
    const courses = [
      { name: "Algorithms", skill: "hacking", expPerSec: 8, costPerSec: 960, location: "Rothman University" },
      { name: "Leadership", skill: "charisma", expPerSec: 8, costPerSec: 960, location: "Rothman University" },
    ];
    const decision = stepCareer(
      view({
        crimes: [shoplift],
        courses,
        moneyGranted: 30_000,
        // Charisma is a priced currency now (the labyrinth marginal), so the
        // worth table keys it by channel rather than by a board need key.
        rates: { best: new Map(), worth: new Map([["hacking", 100], ["charisma", 19_000]]) },
      }),
      postNeeds([]),
    );
    expect(decision.action).toMatchObject({ type: "class", subject: "Leadership" });
  });

  test("gym courses execute as gym work, not university classes", () => {
    const decision = stepCareer(
      view({
        courses: [{ name: "strength", skill: "strength", expPerSec: 10, costPerSec: 2_400, location: "Powerhouse Gym" }],
        moneyGranted: 80_000,
      }),
      postNeeds([need({ kind: "skill", subject: "strength", target: 100, have: 1 })]),
    );
    expect(decision.action).toMatchObject({ type: "gym", subject: "strength", location: "Powerhouse Gym" });
  });

  test("a requested port opener is written as resumable work", () => {
    const decision = stepCareer(
      view({ programs: [{ name: "BruteSSH.exe", timeMs: 600_000, purchaseCost: 500_000 }] }),
      postNeeds([need({ kind: "file", subject: "BruteSSH.exe", target: 1, have: 0 })]),
    );
    expect(decision.action).toMatchObject({ type: "program", subject: "BruteSSH.exe" });
  });

  test("what a need is WORTH decides, not how fast the rate happens to be", () => {
    // A million charisma experience per second is still only ever the best
    // charisma rate — one channel's full worth, no more. The urgency bands used
    // to sort this list lexicographically ahead of the score, which said a
    // blocking need was infinitely more important than a nice one however
    // little of it an option delivered. Worth is a number; urgency is not.
    const decision = stepCareer(
      view({
        courses: [
          { name: "Algorithms", skill: "hacking", expPerSec: 1, costPerSec: 1, location: "Rothman University" },
          { name: "Leadership", skill: "charisma", expPerSec: 1_000_000, costPerSec: 1, location: "Rothman University" },
        ],
        moneyGranted: 100,
      }),
      postNeeds([
        need({ kind: "skill", subject: "hacking", target: 100, have: 0, weight: 5, urgency: "blocking" }),
        need({ kind: "skill", subject: "charisma", target: 1, have: 0, weight: 1, urgency: "nice" }),
      ]),
    );
    expect(decision.action.subject).toBe("Algorithms");
    expect(decision.ranked[0]!.score).toBe(decision.ranked[1]!.score * 5);
  });

  test("a skill gate is priced on the experience rate, against whoever else produces it", () => {
    // NOT on remaining experience. That normalisation divided by a clamped
    // `Math.max(1e-9, …)`, so a multiplier that made a need look already
    // overshot returned a score of 6.3e8 and silently decided every ranking.
    const decision = stepCareer(
      view({
        courses: [{ name: "Algorithms", skill: "hacking", expPerSec: 8, costPerSec: 0, location: "Rothman University" }],
        rates: {
          best: new Map([["hacking", { state: "measured", value: 32 }]]),
          worth: new Map([["hacking", 1_000]]),
        },
      }),
      postNeeds([need({ kind: "skill", subject: "hacking", target: 100, have: 50, weight: 2 })]),
    );
    const contribution = decision.ranked[0]!.contributions[0]!;
    expect(contribution.valueSec).toBeCloseTo((8 / 32) * 1_000, 12);
  });

  test("a satisfied-looking skill gate cannot explode the score", () => {
    // The clamped remainder was the failure: any state where the remaining
    // experience read as zero returned rate/1e-9. There is no remainder in the
    // arithmetic any more, and a rate is bounded by the best rate for the same
    // channel, so a score cannot exceed what the channel is worth.
    const decision = stepCareer(
      view({
        courses: [{ name: "Algorithms", skill: "hacking", expPerSec: 8, costPerSec: 0, location: "Rothman University" }],
        rates: { best: new Map(), worth: new Map([["hacking", 1_000]]) },
      }),
      postNeeds([need({ kind: "skill", subject: "hacking", target: 100, have: 99.999, weight: 2 })]),
    );
    for (const entry of decision.ranked) expect(entry.score).toBeLessThanOrEqual(1_000);
  });

});

/** A write blocks the one work slot for its whole duration and delivers the
 *  file only at the end. What it is worth therefore has to be weighed against
 *  what the slot would otherwise have earned over the same minutes — the
 *  comparison the ranker could not make while a program's own rate was also the
 *  best rate for its own channel, so every write scored the channel in full. */
describe("a program contests the slot on the time it blocks it", () => {
  const opener = need({ kind: "file", subject: "BruteSSH.exe", target: 1, have: 0, weight: 8 });
  const HORIZON = 3_600;
  // 2,400 BN-seconds for the file; a crime worth 2,000 of them per second held.
  const worth = new Map([["file:BruteSSH.exe", 2_400], ["money", 2_000]]);
  const earner = crime({ type: "Heist", timeMs: 1_000, money: 10_000, karma: 0, chance: 1, kills: 0 });
  const rates = { best: new Map([["money", { state: "measured" as const, value: 10_000 }]]), worth };

  function ranked(timeMs: number, over: Partial<CareerView> = {}) {
    return stepCareer(
      view({
        crimes: [earner],
        programs: [{ name: "BruteSSH.exe", timeMs, purchaseCost: 500_000 }],
        planningHorizonSec: HORIZON,
        rates,
        ...over,
      }),
      postNeeds([opener]),
    );
  }

  const scoreOf = (decision: ReturnType<typeof stepCareer>): number =>
    decision.ranked.find((entry) => entry.action.type === "program")!.score;

  test("a slow write loses the slot to a better-paying alternative", () => {
    // Half the remaining run spent writing delivers half the file's worth:
    // 1,200 against a crime that is worth 2,000 for every second it holds.
    const decision = ranked(1_800_000);
    expect(scoreOf(decision)).toBeCloseTo(2_400 * 0.5, 9);
    expect(decision.action.type).not.toBe("program");
  });

  test("a fast write for a genuinely bottlenecking file still wins", () => {
    // Same board, same crime — only the duration changed.
    const decision = ranked(60_000);
    expect(scoreOf(decision)).toBeCloseTo(2_400 * (1 - 60 / HORIZON), 9);
    expect(decision.action).toMatchObject({ type: "program", subject: "BruteSSH.exe" });
  });

  test("a write's score falls linearly with the fraction of the horizon it occupies", () => {
    expect(scoreOf(ranked(600_000)) / scoreOf(ranked(1_200_000)))
      .toBeCloseTo((1 - 600 / HORIZON) / (1 - 1_200 / HORIZON), 9);
  });

  test("a write longer than the planning horizon holds no value and does not take the slot", () => {
    const decision = ranked(14_400_000);
    const program = decision.ranked.find((entry) => entry.action.type === "program")!;
    expect(program.score).toBe(0);
    // Unpriced, not priced-at-zero: a priced zero sorts ahead of every unpriced
    // bid and would hold the slot forever delivering nothing.
    expect(program.value.state).toBe("unpriced");
    expect(decision.action.type).not.toBe("program");
  });

  test("the duration discount survives the self-raise", () => {
    // THE REGRESSION PIN. A program is the only producer of its own `file:`
    // channel and `raiseBest` lifts the field to our own announced rate, so the
    // rate fraction is — correctly — 1. Any attempt to price duration by scaling
    // that rate divides straight back out and this test fails.
    const program = ranked(1_800_000).ranked.find((entry) => entry.action.type === "program")!;
    const channel = program.value.channels.find((entry) => entry.channel === "file:BruteSSH.exe")!;
    expect(channel.bestRate).toBe(channel.ourRate);
    expect(program.score).toBeLessThan(channel.worthSec);
    expect(program.deliveryFraction).toBeCloseTo(0.5, 9);
  });

  test("with no forecast the write is discounted against the default planning horizon", () => {
    const decision = stepCareer(
      view({
        programs: [{ name: "BruteSSH.exe", timeMs: 600_000, purchaseCost: 500_000 }],
        rates,
      }),
      postNeeds([opener]),
    );
    expect(scoreOf(decision)).toBeCloseTo(2_400 * (1 - 600 / DEFAULT_PLANNING_HORIZON_SEC), 9);
  });

  test("a write already half done is charged only the time that is left", () => {
    // The elapsed part is sunk. Charging the full write every pass is not merely
    // pessimistic, it is self-fulfilling: a write that can never start can never
    // accumulate the progress that would let it.
    const half = ranked(1_800_000, {
      currentWork: { kind: "create_program", subject: "BruteSSH.exe", elapsedSec: 900 },
    });
    expect(scoreOf(half)).toBeCloseTo(2_400 * (1 - 900 / HORIZON), 9);
    expect(scoreOf(half)).toBeGreaterThan(scoreOf(ranked(1_800_000)));
  });

  test("a write far enough along beats the crime that outranked it at the start", () => {
    // The same write, the same crime, the same board — only the time already
    // sunk differs. This is what stops a discount from being self-fulfilling.
    const nearlyDone = ranked(1_800_000, {
      currentWork: { kind: "create_program", subject: "BruteSSH.exe", elapsedSec: 1_500 },
    });
    expect(scoreOf(nearlyDone)).toBeCloseTo(2_400 * (1 - 300 / HORIZON), 9);
    // `ranked[0]` is what the slot would run; the emitted action is the
    // in-flight write's own continuation.
    expect(nearlyDone.ranked[0]!.action).toMatchObject({ type: "program", subject: "BruteSSH.exe" });
    expect(nearlyDone.action).toMatchObject({ type: "idle" });
  });

  test("progress on a DIFFERENT program does not discount this one", () => {
    const other = ranked(1_800_000, {
      currentWork: { kind: "create_program", subject: "FTPCrack.exe", elapsedSec: 900 },
    });
    expect(scoreOf(other)).toBeCloseTo(2_400 * 0.5, 9);
  });
});

describe("program creation economics", () => {
  test("matches the v3.0.1 work-rate equation and intelligence-adjusted requirement", () => {
    const brute = PORT_OPENER_PROGRAMS[0]!;
    expect(programCreateTimeMs(brute, 50, 0)).toBe(600_000);
    expect(programCreateTimeMs(brute, 100, 0)).toBe(500_000);
    expect(programCreateTimeMs(brute, 24, 50)).toBe(Infinity);
    expect(programCreateTimeMs(brute, 25, 50)).toBeFinite();
  });

  test("compares player-slot opportunity cost with TOR plus purchase price", () => {
    const brute = PORT_OPENER_PROGRAMS[0]!;
    // 600s write. Unpriced money keeps the historical money-only comparison:
    // 600 * 1000 = $600k < $700k (TOR included) writes; 600 * 2000 = $1.2m
    // against the $500k program alone does not.
    expect(preferProgramCreation(brute, 50, 0, { moneyPerSec: 1_000, valueSec: 0 }, false)).toBe(true);
    expect(preferProgramCreation(brute, 50, 0, { moneyPerSec: 2_000, valueSec: 0 }, true)).toBe(false);
  });

  test("charges the write the career slot's need progress, not only its income", () => {
    const brute = PORT_OPENER_PROGRAMS[0]!;
    // $0.01 of BN-value per dollar: buying is worth 700_000 * 0.01 = 7_000
    // BN-seconds, and the forgone income is 600 * 200 * 0.01 = 1_200.
    const lambda = 0.01;
    const alternative = (valueSec: number) => ({ moneyPerSec: 200, valueSec });
    // Nothing else for the slot to do — writing is still much cheaper.
    expect(preferProgramCreation(brute, 50, 0, alternative(0), false, lambda)).toBe(true);
    // Another bidder would deliver 8_000 BN-seconds over the same window: the
    // money-only comparison could never see it, and it flips the decision.
    // The two estimates of the cost do not ADD — the forgone income is itself
    // a priced channel inside `valueSec` now — so the larger one stands.
    expect(preferProgramCreation(brute, 50, 0, alternative(8_000), false, lambda)).toBe(false);
    // The same board with money priced cheaply (income is abundant) leaves
    // buying expensive in BN-seconds, so the write wins again.
    expect(preferProgramCreation(brute, 50, 0, alternative(8_000), false, 0.02)).toBe(true);
  });

  test("a non-positive money price degrades to the money-only comparison", () => {
    const brute = PORT_OPENER_PROGRAMS[0]!;
    const alternative = { moneyPerSec: 1_000, valueSec: 1e9 };
    expect(preferProgramCreation(brute, 50, 0, alternative, false, 0)).toBe(true);
    expect(preferProgramCreation(brute, 50, 0, alternative, false)).toBe(true);
  });
});

describe("exhaustive oracle — the action set is small enough to prove", () => {
  test("the chosen crime is the exact argmax over the whole action set", () => {
    // 12 crimes is a tiny action space, so ranking them all IS the optimum for
    // a fixed stat vector — this is a proof, not a heuristic check.
    // Karma varies INDEPENDENTLY of duration, so the rates are genuinely
    // distinct and the argmax is unambiguous. (A first draft used
    // `karma = 0.1*(i+1)` with `time = (i+1)s`, which makes every rate exactly
    // 0.1/s — the test then compared floating-point noise.)
    const karma = [0.3, 1.1, 0.05, 2.4, 0.7, 1.9, 0.2, 3.1, 0.9, 1.4, 0.6, 2.0];
    const crimes: CrimeStats[] = Array.from({ length: 12 }, (_, i) =>
      crime({ type: `C${i}`, timeMs: 1_000 * (i + 1), money: 10_000 * (i + 1), karma: karma[i]!, chance: 1 }),
    );
    const board = postNeeds([need({ kind: "karma", target: -100, have: 0, weight: 5 })]);
    const decision = stepCareer(view({ crimes }), board);

    // Brute force: karma/sec is (karma / seconds); the best is the argmax.
    let best = "";
    let bestRate = -Infinity;
    for (const entry of crimes) {
      const rate = karmaPerSec(entry, person(), CTX);
      if (rate > bestRate) {
        bestRate = rate;
        best = entry.type;
      }
    }
    expect(decision.action.subject).toBe(best);
  });

  test("time-to-karma matches the closed-form integral", () => {
    const homicide = crime({ type: "Homicide", timeMs: 3_000, karma: 3, chance: 1 });
    const seconds = secondsToKarma(homicide, person(), CTX, 0, -54_000);
    // 3 karma per 3 s = 1 karma/s, so -54000 takes 54000 s.
    expect(seconds).toBeCloseTo(54_000, 6);
  });
});

// --- the megacorp unlock chain ----------------------------------------------

describe("career serves the company chain", () => {
  const heist = crime({ type: "Heist", timeMs: 600_000, money: 6.878e8, karma: 15, chance: 1 });

  test("a companyRep need at a company we do not work for hires on first", () => {
    const decision = stepCareer(
      view({ crimes: [heist] }),
      postNeeds([need({ kind: "companyRep", subject: "NWO", target: 400_000, have: 0, weight: 6 })]),
    );
    expect(decision.action).toMatchObject({ type: "apply", subject: "NWO" });
  });

  test("a blocking companyRep need at the employer outranks the best crime income", () => {
    const decision = stepCareer(
      view({
        crimes: [heist],
        jobs: { NWO: "Software Engineering Intern" },
        companies: [{ name: "NWO", rep: 1.589e6, estimatedRepPerSec: 40, moneyPerSec: 1_000 }],
      }),
      postNeeds([need({ kind: "companyRep", subject: "NWO", target: 4_000_000, have: 1.589e6, weight: 6 })]),
    );
    expect(decision.action).toMatchObject({ type: "company", subject: "NWO" });
    expect(decision.incomeFallback).toBe(false);
  });

  test("the formula prior prices an unmeasured company instead of the neutral 1 rep/sec", () => {
    const decision = stepCareer(
      view({
        jobs: { NWO: "Software Engineering Intern" },
        companies: [{ name: "NWO", rep: 0, estimatedRepPerSec: 40 }],
      }),
      postNeeds([need({ kind: "companyRep", subject: "NWO", target: 400_000, have: 0, weight: 6 })]),
    );
    const company = decision.ranked.find((entry) => entry.action.type === "company");
    expect(company!.contributions[0]!.perSec).toBe(40);
  });

  test("a jobTitle need routes through the position table, never a dead-end track", () => {
    // The old string heuristic sent Chief Executive Officer to the Software
    // track, which terminates at CTO. The table lookup must pick the title's
    // real track (Business) at an employer whose ladder contains it.
    const decision = stepCareer(
      view({
        jobs: { NWO: "Business Manager" },
        companies: [{ name: "NWO", rep: 1e6 }],
      }),
      postNeeds([need({ kind: "jobTitle", subject: "Chief Executive Officer", target: 1, have: 0, weight: 6 })]),
    );
    expect(decision.action).toMatchObject({ type: "promote", subject: "NWO", field: "Business" });
  });
});

// --- the unrequested write ---------------------------------------------------

/** THE LIVE FAILURE. A BN12 save spent 2h14m writing relaySMTP.exe, re-affirmed
 *  it every five seconds, and resumed it after every reload.
 *
 *  Nothing chose it for a reason. Career offered every creatable opener whether
 *  or not anything had asked for one; with no `file:` need posted, each scored
 *  `unpriced/0`, and ranking fell through to the money tie-break — where a
 *  program's `moneyPerSec` is `-purchaseCost / seconds`, so the longest and
 *  most expensive write ranks FIRST. Every existing case in this file posts the
 *  need, which is exactly why none of them caught it. */
describe("a program nobody asked for", () => {
  const HORIZON = 3_600;
  // The live numbers: intelligence 355 halves relaySMTP's level requirement to
  // 72.5, so hacking 78 makes a 2h14m write eligible; FTPCrack is 28.8 minutes.
  const ftpCrack = { name: "FTPCrack.exe", timeMs: 1_728_000, purchaseCost: 1_500_000 };
  const relaySmtp = { name: "relaySMTP.exe", timeMs: 8_030_000, purchaseCost: 5_000_000 };

  test("is not offered at all", () => {
    const decision = stepCareer(
      view({ programs: [ftpCrack, relaySmtp], planningHorizonSec: HORIZON }),
      postNeeds([]),
    );
    expect(decision.ranked.filter((entry) => entry.action.type === "program")).toEqual([]);
    expect(decision.action.type).not.toBe("program");
  });

  test("does not win the slot by being the most expensive thing on an empty board", () => {
    // The regression itself: before the gate, both wrote as unpriced zeros and
    // -5e6/8030 beat -1.5e6/1728, so the 2h14m option won.
    const decision = stepCareer(
      view({ programs: [ftpCrack, relaySmtp], planningHorizonSec: HORIZON }),
      postNeeds([]),
    );
    expect(decision.action).not.toMatchObject({ subject: "relaySMTP.exe" });
  });

  test("a requested opener is still offered, and is still priced on its duration", () => {
    // The gate must not break the case the mechanism exists for.
    const decision = stepCareer(
      view({ programs: [ftpCrack], planningHorizonSec: HORIZON, rates: {
        best: new Map(),
        worth: new Map([["file:FTPCrack.exe", 2_400]]),
      } }),
      postNeeds([need({ kind: "file", subject: "FTPCrack.exe", target: 1, have: 0, weight: 8 })]),
    );
    expect(decision.action).toMatchObject({ type: "program", subject: "FTPCrack.exe" });
  });

  test("between two equally worthless writes, the shorter one ranks first", () => {
    // Defence in depth for the tie-break itself: with both requested but
    // nothing pricing the channel, occupancy decides — never amortised cost,
    // which rewards length.
    const decision = stepCareer(
      view({ programs: [ftpCrack, relaySmtp], planningHorizonSec: HORIZON }),
      postNeeds([
        need({ kind: "file", subject: "FTPCrack.exe", target: 1, have: 0, weight: 8 }),
        need({ kind: "file", subject: "relaySMTP.exe", target: 1, have: 0, weight: 8 }),
      ]),
    );
    const programs = decision.ranked.filter((entry) => entry.action.type === "program");
    expect(programs.map((entry) => entry.action.subject)).toEqual(["FTPCrack.exe", "relaySMTP.exe"]);
  });
});

// --- giving the slot back ----------------------------------------------------

/** `idle` means "leave the current work alone" — three separate branches emit
 *  it to say exactly that, and career had no other path, so work the planner
 *  had stopped choosing kept running until the game ended it. Across a reload
 *  the game restores `Player.currentWork`, so "never choosing it again" left a
 *  two-hour write running forever. */
describe("work the planner has abandoned", () => {
  const shoplift = crime({ type: "Shoplift", timeMs: 2_000, money: 15_000, karma: 0.1, chance: 1, kills: 0 });

  test("is stopped when nothing on the menu matches it", () => {
    const decision = stepCareer(
      view({
        programs: [{ name: "relaySMTP.exe", timeMs: 8_030_000, purchaseCost: 5_000_000 }],
        currentWork: { kind: "create_program", subject: "relaySMTP.exe" },
      }),
      postNeeds([]),
    );
    expect(decision.action).toMatchObject({ type: "stop", subject: "relaySMTP.exe" });
  });

  test("is stopped even when the menu is empty entirely", () => {
    // The cold-start shape: no crime table yet, no funded course, nothing
    // requested. Previously this returned idle and inherited the work.
    const decision = stepCareer(
      view({ currentWork: { kind: "create_program", subject: "relaySMTP.exe" } }),
      postNeeds([]),
    );
    expect(decision.action.type).toBe("stop");
  });

  test("is not stopped when a slot-using option will replace it anyway", () => {
    // Issuing any work cancels and replaces whatever is running, so stopping
    // first would spend a whole pass achieving nothing.
    const decision = stepCareer(
      view({ crimes: [shoplift], currentWork: { kind: "create_program", subject: "relaySMTP.exe" } }),
      postNeeds([need({ kind: "karma", target: -45, have: 0, weight: 10 })]),
    );
    expect(decision.action).toMatchObject({ type: "crime", subject: "Shoplift" });
  });

  test("is left alone when it is still the best option", () => {
    const decision = stepCareer(
      view({ crimes: [shoplift], currentWork: { kind: "crime", subject: "Shoplift" } }),
      postNeeds([need({ kind: "karma", target: -45, have: 0, weight: 10 })]),
    );
    expect(decision.action.type).not.toBe("stop");
  });

  test("never stops another feature's work", () => {
    // factions holds the slot; cancelling its faction work from here would be
    // the same bug pointed the other way.
    const decision = stepCareer(
      view({ holdsWorkSlot: false, currentWork: { kind: "faction", subject: "CyberSec" } }),
      postNeeds([]),
    );
    expect(decision.action.type).not.toBe("stop");
  });
});

// --- committing before the menu exists ---------------------------------------

/** The crime table arrives from a five-minute priced probe, so the first
 *  decisions of a run are made before any crime is known. An empty menu then reads as "nothing else is
 *  worth doing", which is not what it means. */
describe("a menu that is still filling", () => {
  const opener = need({ kind: "file", subject: "FTPCrack.exe", target: 1, have: 0, weight: 8 });
  const ftpCrack = { name: "FTPCrack.exe", timeMs: 1_728_000, purchaseCost: 1_500_000 };
  const rates = { best: new Map(), worth: new Map([["file:FTPCrack.exe", 2_400]]) };

  test("does not start work that occupies the slot", () => {
    const decision = stepCareer(
      view({ programs: [ftpCrack], planningHorizonSec: 3_600, rates, menuComplete: false }),
      postNeeds([opener]),
    );
    expect(decision.action.type).toBe("idle");
  });

  test("starts the same work once the menu is complete", () => {
    const decision = stepCareer(
      view({ programs: [ftpCrack], planningHorizonSec: 3_600, rates, menuComplete: true }),
      postNeeds([opener]),
    );
    expect(decision.action).toMatchObject({ type: "program", subject: "FTPCrack.exe" });
  });

  test("never interrupts a write already in progress", () => {
    // Holding off is about STARTING a commitment; abandoning one half-written
    // because a probe was late would be the more expensive mistake.
    const decision = stepCareer(
      view({
        programs: [ftpCrack],
        planningHorizonSec: 3_600,
        rates,
        menuComplete: false,
        currentWork: { kind: "create_program", subject: "FTPCrack.exe" },
      }),
      postNeeds([opener]),
    );
    expect(decision.action.type).not.toBe("stop");
  });

  test("continuous work is unaffected — it can be swapped the moment something better lands", () => {
    const shoplift = crime({ type: "Shoplift", timeMs: 2_000, money: 15_000, karma: 0.1, chance: 1, kills: 0 });
    const decision = stepCareer(
      view({ crimes: [shoplift], menuComplete: false }),
      postNeeds([need({ kind: "karma", target: -45, have: 0, weight: 10 })]),
    );
    expect(decision.action).toMatchObject({ type: "crime", subject: "Shoplift" });
  });
});

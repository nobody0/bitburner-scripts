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
  return { by: "factions", weight: 1, urgency: "blocking", why: "test", ...over };
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
    expect(decision.why).toContain("no posted need");
  });

  test("two features wanting the same outcome ADD their weight", () => {
    const board = postNeeds([
      need({ by: "factions", kind: "karma", target: -45, have: 0, weight: 1 }),
      need({ by: "gang", kind: "karma", target: -54_000, have: 0, weight: 20 }),
    ]);
    const values = needValues(board);
    expect(values.get("karma")!.weight).toBe(21);
    // ...and the nearer threshold sets the remaining distance, because
    // clearing it unblocks a feature.
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
    expect(decision.action.why).toContain("holds Player.currentWork");
  });

  test("the continuation guard stops re-issuing the same crime", () => {
    // commitCrime CANCELS whatever is running, so re-issuing every tick would
    // restart it forever and never bank a single completion.
    const decision = stepCareer(
      view({ crimes: [homicide], currentWork: { kind: "crime", subject: "Homicide" } }),
      postNeeds([need({ kind: "karma", target: -45, have: 0, weight: 10 })]),
    );
    expect(decision.action.type).toBe("idle");
    expect(decision.action.why).toContain("already committing");
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

  test("jobs provide the fresh-install income floor until background hacking catches up", () => {
    const early = stepCareer(
      view({
        crimes: [shoplift],
        jobs: { FoodNStuff: "Employee" },
        companies: [{ name: "FoodNStuff", rep: 0, moneyPerSec: 20_000 }],
        externalIncomePerSec: 0,
      }),
      postNeeds([]),
    );
    expect(early.action).toMatchObject({ type: "company", subject: "FoodNStuff" });

    const later = stepCareer(
      view({
        crimes: [shoplift],
        courses: [{ name: "Algorithms", skill: "hacking", expPerSec: 8, costPerSec: 960, location: "Rothman University" }],
        // A course must be funded for a full training window (30s), not any positive grant.
        moneyGranted: 30_000,
        externalIncomePerSec: 25_000,
      }),
      postNeeds([]),
    );
    expect(later.action).toMatchObject({ type: "class", subject: "Algorithms" });
  });

  test("the progression route can replace hacking as the training fallback", () => {
    const decision = stepCareer(
      view({
        crimes: [shoplift],
        courses: [
          { name: "Algorithms", skill: "hacking", expPerSec: 8, costPerSec: 960, location: "Rothman University" },
          { name: "Leadership", skill: "charisma", expPerSec: 8, costPerSec: 960, location: "Rothman University" },
        ],
        moneyGranted: 30_000,
        externalIncomePerSec: 25_000,
        defaultSkill: "charisma",
      }),
      postNeeds([]),
    );
    expect(decision.action).toMatchObject({ type: "class", subject: "Leadership" });
    expect(decision.why).toContain("training charisma");
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

  test("urgency is lexicographic: blocking work beats a larger nice score", () => {
    const decision = stepCareer(
      view({
        courses: [
          { name: "Algorithms", skill: "hacking", expPerSec: 1, costPerSec: 1, location: "Rothman University" },
          { name: "Leadership", skill: "charisma", expPerSec: 1_000_000, costPerSec: 1, location: "Rothman University" },
        ],
        moneyGranted: 100,
      }),
      postNeeds([
        need({ kind: "skill", subject: "hacking", target: 100, have: 0, weight: 1, urgency: "blocking" }),
        need({ kind: "skill", subject: "charisma", target: 1, have: 0, weight: 1, urgency: "nice" }),
      ]),
    );
    expect(decision.action.subject).toBe("Algorithms");
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
    expect(preferProgramCreation(brute, 50, 0, 1_000, false)).toBe(true);
    expect(preferProgramCreation(brute, 50, 0, 2_000, true)).toBe(false);
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

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

  test("an impossible crime reports an infinite time rather than a plausible number", () => {
    expect(secondsToKarma(crime({ chance: 0 }), person(), CTX, 0, -45)).toBe(Infinity);
  });

  test("experience is awarded on SUCCESS only, so a hard crime trains slowly", () => {
    const easy = expPerSec(crime({ chance: 1 }), person(), CTX);
    const hard = expPerSec(crime({ chance: 0.1 }), person(), CTX);
    expect(hard["strength"]).toBeCloseTo(easy["strength"]! * 0.1, 10);
  });

  test("BitNode multipliers flow through money and chance", () => {
    const doubled = moneyPerSec(crime({ chance: 1 }), person(), { crimeSuccessRate: 1, crimeMoney: 2 });
    expect(doubled).toBeCloseTo(moneyPerSec(crime({ chance: 1 }), person(), CTX) * 2, 6);
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

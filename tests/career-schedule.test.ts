import { describe, expect, test } from "bun:test";
import {
  armWorkCompletion,
  consumeWorkCompletion,
  peekWorkCompletion,
  resetWorkCompletion,
} from "../game/lib/work-completion.ts";
import { careerModule, resetCareerState } from "../game/lib/features/career.ts";
import type { ClaimContext } from "../game/lib/features/index.ts";
import type { GameState } from "../game/lib/state.ts";
import { stepCareer, type CareerView } from "../shared/strategy/career/decide.ts";
import type { CrimeContext, CrimePerson, CrimeStats } from "../shared/strategy/career/crimes.ts";
import { careerSchedule, CONTINUOUS_REVIEW_MS, updateActivityRate } from "../shared/strategy/career/schedule.ts";
import { postNeeds, type Need, type NeedUrgency } from "../shared/strategy/needs.ts";

const person: CrimePerson = {
  skills: { hacking: 100, strength: 100, defense: 100, dexterity: 100, agility: 100, charisma: 100, intelligence: 0 },
  mults: { crime_success: 1, crime_money: 1 },
};
const crimeContext: CrimeContext = { crimeSuccessRate: 1, crimeMoney: 1 };
const crime: CrimeStats = {
  type: "Homicide",
  timeMs: 3_000,
  money: 45_000,
  difficulty: 1,
  karma: 3,
  kills: 1,
  weights: {},
  exp: {},
  chance: 1,
};

function view(over: Partial<CareerView> = {}): CareerView {
  return {
    time: 0,
    person,
    crimeContext,
    crimes: [crime],
    courses: [],
    karma: 0,
    numPeopleKilled: 0,
    skills: { ...person.skills },
    city: "Sector-12",
    holdsWorkSlot: true,
    moneyGranted: 0,
    ...over,
  };
}

function need(kind: Need["kind"], subject: string | undefined, urgency: NeedUrgency): Need {
  return {
    by: "factions",
    kind,
    ...(subject ? { subject } : {}),
    target: kind === "karma" ? -45 : 400_000,
    have: 0,
    weight: 10,
    urgency,
    why: "test request",
  };
}

describe("career review scheduling", () => {
  test("continuous work reviews every five seconds, idle reviews immediately", () => {
    expect(careerSchedule({ now: 1_000, lastReviewedAt: 1_000, currentWorkType: "COMPANY", completionPending: false })).toMatchObject({ due: false, mode: "continuous", nextReviewAt: 1_000 + CONTINUOUS_REVIEW_MS });
    expect(careerSchedule({ now: 6_000, lastReviewedAt: 1_000, currentWorkType: "COMPANY", completionPending: false })).toMatchObject({ due: true, reason: "continuous-interval" });
    expect(careerSchedule({ now: 1_001, lastReviewedAt: 1_000, completionPending: false })).toMatchObject({ due: true, reason: "idle" });
  });

  test("progress ignores wall time but wakes on the exact completion event", () => {
    expect(careerSchedule({ now: 1_000_000, lastReviewedAt: 0, currentWorkType: "CRIME", completionPending: false })).toMatchObject({ due: false, mode: "progress" });
    expect(careerSchedule({ now: 1_001, lastReviewedAt: 1_000, currentWorkType: "CRIME", completionPending: true })).toMatchObject({ due: true, reason: "completion" });
  });

  test("the v3 task promise produces one authoritative completion notice", async () => {
    resetWorkCompletion();
    let resolve!: () => void;
    const nextCompletion = new Promise<void>((done) => { resolve = done; });
    armWorkCompletion({ type: "CRIME", crimeType: "Homicide", nextCompletion });
    expect(peekWorkCompletion()).toBeUndefined();
    resolve();
    await Promise.resolve();
    expect(peekWorkCompletion()).toMatchObject({ type: "CRIME", detail: "Homicide" });
    expect(consumeWorkCompletion()).toBeDefined();
    expect(peekWorkCompletion()).toBeUndefined();
  });

  test("unchanged fast samples do not shorten a slower reputation window", () => {
    let sample = updateActivityRate(undefined, 100, 0, true);
    sample = updateActivityRate(sample, 100, 5_000, true);
    sample = updateActivityRate(sample, 100, 10_000, true);
    sample = updateActivityRate(sample, 160, 30_000, true);
    expect(sample.perSec).toBe(2);
    expect(sample.at).toBe(30_000);
  });

  test("a resolved crime keeps an observation claim beside a queued action", async () => {
    resetCareerState();
    let resolve!: () => void;
    const nextCompletion = new Promise<void>((done) => { resolve = done; });
    armWorkCompletion({ type: "CRIME", crimeType: "Heist", nextCompletion });
    resolve();
    await Promise.resolve();

    const state = {
      topics: {
        player: {
          money: 1e9,
          skills: { ...person.skills },
          mults: {},
          jobs: {},
          city: "Sector-12",
        },
        career: {
          karma: 0,
          numPeopleKilled: 0,
          skills: { ...person.skills },
          exp: { ...person.skills },
          city: "Sector-12",
          location: "home",
          entropy: 0,
          totalPlaytime: 0,
          jobs: {},
          companies: {},
          currentWork: { type: "CRIME", detail: "Heist", cyclesWorked: 3_000 },
          crimes: [],
        },
      },
      dirty: new Set(),
      mirrors: {},
      mirrorDirty: new Set(),
      probeFailures: {},
      probeSkips: {},
      featureLastRun: {},
    } as unknown as GameState;
    const board = postNeeds([need("employment", "ECorp", "wanted")]);
    const claims = careerModule.claims!({
      state,
      board,
      now: 1,
      caps: {} as ClaimContext["caps"],
      budgetGb: 100,
      ramPrice: (methods) => methods.length,
    });

    expect(claims.map((claim) => claim.id)).toContain("action:apply");
    expect(claims.map((claim) => claim.id)).toContain("watch:completion");
    resetCareerState();
  });
});

describe("career request queue", () => {
  test("company reputation requests become ranked company work", () => {
    const decision = stepCareer(
      view({ jobs: { ECorp: "Software Engineering Intern" }, companies: [{ name: "ECorp", rep: 0, repPerSec: 12 }] }),
      postNeeds([need("companyRep", "ECorp", "blocking")]),
    );
    expect(decision.action).toMatchObject({ type: "company", subject: "ECorp" });
    expect(decision.workPriority).toBe("blocking");
    expect(decision.ranked[0]!.contributions[0]).toMatchObject({ kind: "companyRep", subject: "ECorp", perSec: 12 });
    expect(decision.serving[0]).toMatchObject({ by: "factions", urgency: "blocking", why: "test request" });
  });

  test("employment requests queue an application before work", () => {
    const decision = stepCareer(view(), postNeeds([need("employment", "Fulcrum Technologies", "wanted")]));
    expect(decision.action).toMatchObject({ type: "apply", subject: "Fulcrum Technologies" });
    expect(decision.workPriority).toBe("wanted");
  });

  test("job-title requests queue a promotion on the best employer track", () => {
    const decision = stepCareer(
      view({
        jobs: { ECorp: "Head of Software", MegaCorp: "Software Engineering Intern" },
        companies: [{ name: "ECorp", rep: 500_000 }, { name: "MegaCorp", rep: 10 }],
      }),
      postNeeds([need("jobTitle", "Chief Technology Officer", "blocking")]),
    );
    expect(decision.action).toMatchObject({ type: "promote", subject: "ECorp", field: "Software" });
    expect(decision.workPriority).toBe("blocking");
  });

  test("a completed crime may switch immediately; an incomplete one may not", () => {
    const board = postNeeds([need("companyRep", "ECorp", "blocking")]);
    const working = view({
      currentWork: { kind: "crime", subject: "Homicide" },
      jobs: { ECorp: "Software Engineering Intern" },
      companies: [{ name: "ECorp", rep: 0, repPerSec: 12 }],
    });
    expect(stepCareer(working, board).action.type).toBe("idle");
    expect(stepCareer({ ...working, allowProgressSwitch: true }, board).action).toMatchObject({ type: "company", subject: "ECorp" });
  });

  test("when the same crime stays best, completion re-arms without restarting it", () => {
    const working = view({ currentWork: { kind: "crime", subject: "Homicide" }, allowProgressSwitch: true });
    expect(stepCareer(working, postNeeds([])).action).toMatchObject({ type: "continue", subject: "Homicide" });
  });
});

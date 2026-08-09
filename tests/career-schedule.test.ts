import { describe, expect, test } from "bun:test";
import {
  armWorkCompletion,
  consumeWorkCompletion,
  peekWorkCompletion,
  resetWorkCompletion,
} from "../game/lib/work-completion.ts";
import { careerModule, resetCareerState } from "../game/lib/features/career.ts";
import { factionsModule } from "../game/lib/features/factions.ts";
import type { ClaimContext } from "../game/lib/features/index.ts";
import type { GameState } from "../game/lib/state.ts";
import { stepCareer, type CareerView } from "../shared/strategy/career/decide.ts";
import type { CrimeContext, CrimePerson, CrimeStats } from "../shared/strategy/career/crimes.ts";
import { careerSchedule, CONTINUOUS_REVIEW_MS, progressLockUntil, updateActivityRate } from "../shared/strategy/career/schedule.ts";
import { PREEMPT_MARGIN, PRIORITY } from "../shared/strategy/arbiter.ts";
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

  test("program creation is resumable and follows the five-second review policy", () => {
    expect(careerSchedule({ now: 6_000, lastReviewedAt: 1_000, currentWorkType: "CREATE_PROGRAM", completionPending: false }))
      .toMatchObject({ due: true, mode: "continuous", reason: "continuous-interval" });
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
    expect(careerModule.driver.wake?.()).toBe(true);
    expect(factionsModule.driver.wake?.()).toBe(true);
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
      horizons: {
        node: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "test", reason: "test" },
        install: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "test", reason: "test" },
      },
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

describe("the slot lock is bounded by the progress it protects", () => {
  // THE BUG, from a live BN12 run: the lock was posted at `career:progress-lock`
  // (100) with `holdUntil: Number.MAX_SAFE_INTEGER` and released only by the
  // completion event. The arbiter refuses pre-emption until `holdUntil` passes, so a
  // completion that never arrived — the watcher failing to arm is enough — held
  // `Player.currentWork` for ever. `factions work:Tetrads` was denied `slot-held`
  // every pass, so "factions has not finished its final purchase and donation sweep"
  // never cleared and the run could not end. Career also re-committed the longest
  // crime available the instant each one finished, so even a working event only
  // opened a window career took straight back.
  const HEIST_MS = 600_000;

  function workClaim(over: {
    type?: string | null;
    detail?: string;
    cyclesWorked?: number;
    observedAt?: number;
    crimes?: { name: string; timeMs: number }[];
    now?: number;
  } = {}) {
    const state = {
      topics: {
        player: { money: 0, skills: {}, mults: {}, jobs: {}, city: "Sector-12" },
        career: {
          karma: 0, numPeopleKilled: 0, skills: {}, exp: {}, city: "Sector-12",
          location: "home", entropy: 0, totalPlaytime: 0, jobs: {}, companies: {},
          currentWork: over.type === null ? null : {
            type: over.type ?? "CRIME",
            detail: over.detail ?? "Heist",
            cyclesWorked: over.cyclesWorked ?? 0,
            observedAt: over.observedAt ?? 0,
          },
          crimes: over.crimes ?? [{ name: "Heist", timeMs: HEIST_MS }],
        },
      },
      dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
      probeFailures: {}, probeSkips: {}, featureLastRun: {},
    } as unknown as GameState;
    const claims = careerModule.claims!({
      state,
      board: postNeeds([]),
      now: over.now ?? 0,
      caps: {} as ClaimContext["caps"],
      budgetGb: 100,
      horizons: {
        node: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
        install: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
      },
      ramPrice: (methods) => methods.length,
    });
    resetCareerState();
    return claims.find((claim) => claim.id === "work")!;
  }

  test("mid-crime it locks, and holdUntil is the moment progress banks", () => {
    // Half done: 1500 cycles x 200ms = 5 minutes of a 10-minute heist.
    const claim = workClaim({ cyclesWorked: 1_500, observedAt: 0, now: 0 });
    expect(claim.priority).toBe(PRIORITY["career:progress-lock"]);
    expect(claim.holdUntil).toBe(HEIST_MS / 2);
    // Never the old unbounded value — that is what wedged the run.
    expect(claim.holdUntil).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  test("PAST the boundary the lock is gone and faction work can win the slot", () => {
    // The heist's time has elapsed. Career drops to its income band, which is
    // deliberately too weak to hold the slot against `factions:work`.
    const claim = workClaim({ cyclesWorked: 0, observedAt: 0, now: HEIST_MS + 1 });
    expect(claim.holdUntil).toBeUndefined();
    expect(claim.priority).toBeLessThan(PRIORITY["factions:work"] - PREEMPT_MARGIN);
  });

  test("an unknown duration yields NO lock, not an unbounded one", () => {
    // Before the crime table is probed we cannot bound the lock. A lock we cannot
    // release is what stalled the run; one lost partial crime is recoverable.
    expect(workClaim({ crimes: [] }).holdUntil, "crime table not probed yet").toBeUndefined();
    expect(workClaim({ detail: "Not In The Table" }).holdUntil, "activity unidentifiable").toBeUndefined();
    // The remaining unknowns are cleaner to state against the pure function than to
    // fake through a topic whose defaults fill them in.
    const base = { mode: "progress" as const, totalMs: 600_000, cyclesWorked: 0, observedAt: 0, completionPending: false, now: 0 };
    expect(progressLockUntil({ ...base, observedAt: undefined }), "no observation timestamp").toBeUndefined();
    expect(progressLockUntil({ ...base, totalMs: undefined }), "no known duration").toBeUndefined();
  });

  test("a banked-progress notice ends the lock immediately", () => {
    // The event stays the authoritative early release; the deadline is only the
    // backstop for when it never arrives.
    const base = { mode: "progress" as const, totalMs: 600_000, cyclesWorked: 0, observedAt: 0, now: 0 };
    expect(progressLockUntil({ ...base, completionPending: false })).toBe(600_000);
    expect(progressLockUntil({ ...base, completionPending: true })).toBeUndefined();
  });

  test("continuous work is never locked — it banks every cycle", () => {
    const claim = workClaim({ type: "COMPANY", detail: "ECorp" });
    expect(claim.holdUntil).toBeUndefined();
    expect(claim.priority).not.toBe(PRIORITY["career:progress-lock"]);
  });

  test("the lock still outranks faction work while progress is genuinely unbanked", () => {
    // The protection has to be real, or a crime gets cancelled at 99% and the whole
    // unit is thrown away.
    const claim = workClaim({ cyclesWorked: 2_999, observedAt: 0, now: 0 });
    expect(claim.priority).toBeGreaterThan(PRIORITY["factions:work"] + PREEMPT_MARGIN);
    expect(claim.holdUntil).toBeGreaterThan(0);
  });
});

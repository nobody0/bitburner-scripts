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
import { PREEMPT_MARGIN, PRIORITY, resolveClaims, type Claim } from "../shared/strategy/arbiter.ts";
import { workRepPerSec } from "../shared/strategy/factions/rep.ts";
import { rateFraction } from "../shared/strategy/income.ts";
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
    // A generic crime completion is intentionally not enough to wake the
    // expensive faction frontier. Factions wakes for its own work or when its
    // last decision was waiting for this slot; the ordinary cadence covers
    // unrelated gate drift.
    expect(factionsModule.driver.wake?.()).toBe(false);
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
    expect(decision.serving[0]).toMatchObject({ by: "factions", urgency: "blocking" });
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
  // A progress lock expires when the current unit completes. The deadline is the
  // backstop when no completion notification arrives.
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
      probeFailures: {}, featureLastRun: {},
    } as unknown as GameState;
    const claims = careerModule.claims!({
      state,
      board: postNeeds([]),
      now: over.now ?? 0,
      caps: {} as ClaimContext["caps"],
      selectedFeatures: new Set(),
      activeFeatures: new Set(),
      horizons: {
        node: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
        install: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
      },
    });
    resetCareerState();
    return claims.find((claim) => claim.id === "work")!;
  }

  test("mid-crime it locks, and holdUntil is the moment progress banks", () => {
    // Half done: 1500 cycles x 200ms = 5 minutes of a 10-minute heist.
    const claim = workClaim({ cyclesWorked: 1_500, observedAt: 0, now: 0 });
    expect(claim.priority).toBe(PRIORITY["career:progress-lock"]);
    expect(claim.holdUntil).toBe(HEIST_MS / 2);
    // A missing completion notification must not make the lock unbounded.
    expect(claim.holdUntil).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  test("a repeating crime locks on progress within its current unit, not cumulative work time", () => {
    // Upstream CrimeWork never resets cyclesWorked; only its private
    // unitCompleted wraps after each completion.
    const lock = progressLockUntil({
      mode: "progress",
      totalMs: 4_000,
      cyclesWorked: 27, // one full 20-cycle crime plus 7 cycles
      observedAt: 10_000,
      repeating: true,
      completionPending: false,
      now: 10_000,
    });
    expect(lock).toBe(12_600);
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

describe("training versus route reputation", () => {
  // Training is worth its rate relative to the best available rate, multiplied
  // by the route value of that channel.
  const HACKING_WORTH = 19_000;

  function algorithms(externalExpPerSec: number): ReturnType<typeof stepCareer> {
    const careerView = view({
      crimes: [],
      courses: [{ name: "Algorithms", skill: "hacking", expPerSec: 10, costPerSec: 0, location: "Rothman University" }],
      rates: {
        best: new Map(externalExpPerSec > 0 ? [["hacking", { state: "measured", value: externalExpPerSec }]] : []),
        worth: new Map([["hacking", HACKING_WORTH]]),
      },
    });
    const board = postNeeds([{
      by: "progression",
      kind: "skill",
      subject: "hacking",
      target: 100,
      have: 1,
      weight: 5,
      urgency: "blocking",
    }]);
    return stepCareer(careerView, board);
  }

  test("a course the fleet out-produces a hundred-thousandfold is worth that fraction", () => {
    const decision = algorithms(1_000_000);
    expect(decision.ranked[0]!.score).toBeCloseTo((10 / 1_000_000) * HACKING_WORTH, 9);
  });

  test("with no background experience the course is the best hacking rate there is", () => {
    // Sole producer: the whole worth of the channel, and the claim says so.
    expect(algorithms(0).ranked[0]!.score).toBeCloseTo(HACKING_WORTH, 9);
  });

  test("the bid decays continuously as the fleet takes over", () => {
    // The fraction is the RELATIVE increase the course buys: ten more
    // experience per second on top of ninety is an eleven percent improvement,
    // and worth eleven percent of what the channel is worth. Matching the fleet
    // exactly is a doubling, which is the full worth and also the cap.
    const alone = algorithms(0).ranked[0]!.score;
    expect(algorithms(10).ranked[0]!.score).toBeCloseTo(alone, 6);
    expect(algorithms(90).ranked[0]!.score).toBeCloseTo(alone * (10 / 90), 6);
    expect(algorithms(1_000_000).ranked[0]!.score).toBeLessThan(alone / 1_000);
  });

  test("a hacking need is priced by the route marginal, never by its posted weight", () => {
    // `skill:hacking` IS a progression currency. Pricing it from the weight as
    // well would count the same progress twice, and the weight is the estimate
    // nobody measured.
    const decision = algorithms(0);
    expect(decision.ranked[0]!.contributions.map((entry) => entry.worthSec)).toEqual([HACKING_WORTH]);
  });
});

describe("factions holds the slot across a breakpoint hand-off", () => {
  // A completed intermediate breakpoint must not release the slot while the
  // joined faction still has unfinished augmentation reputation work.
  function factionClaims(over: {
    rep?: number;
    repTarget?: number;
    offers?: { faction: string; repReq: number; owned?: boolean }[];
    joined?: string[];
    route?: "daedalus" | "gang";
    installWanted?: boolean;
    routeInstallRequired?: boolean;
    blockers?: { faction: string; kind: string; subject?: string }[];
    action?: { type: string; city?: string };
    workTypes?: string[];
    skills?: Record<string, number>;
  } = {}) {
    const rep = over.rep ?? 7_400;
    const state = {
      topics: {
        player: { money: 0, skills: over.skills ?? {}, mults: {}, jobs: {}, city: "Sector-12" },
        factions: {
          joined: over.joined ?? ["The Covenant"],
          standings: [{ name: "The Covenant", rep, favor: 13, joined: true }],
          ...(over.workTypes ? { workTypes: { "The Covenant": over.workTypes } } : {}),
          offers: over.offers ?? [{ faction: "The Covenant", repReq: 50_000, owned: false }],
          plan: {
            context: { route: over.route },
            action: over.action ?? { type: "idle" },
            ...(over.blockers ? { blockers: over.blockers } : {}),
            objective: {
              factions: ["The Covenant"],
              augmentations: [],
              intent: {
                faction: "The Covenant",
                repTarget: over.repTarget ?? 7_340,
                purpose: "augmentations",
              },
            },
          },
        },
        ...(over.installWanted || over.routeInstallRequired
          ? { progression: { plan: {
              ...(over.installWanted ? { installWanted: true } : {}),
              ...(over.routeInstallRequired ? { routeInstallRequired: true } : {}),
            } } }
          : {}),
      },
      dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
      probeFailures: {}, featureLastRun: {},
    } as unknown as GameState;
    const claims = factionsModule.claims!({
      state,
      board: postNeeds([]),
      now: 0,
      caps: {} as ClaimContext["caps"],
      selectedFeatures: new Set(),
      activeFeatures: new Set(),
      horizons: {
        node: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
        install: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
      },
    });
    return claims;
  }

  const slotClaim = (over: Parameters<typeof factionClaims>[0] = {}): Claim | undefined =>
    factionClaims(over).find((claim) => claim.resource === "time" && claim.id.startsWith("work:")) as Claim | undefined;

  const travelFund = (over: Parameters<typeof factionClaims>[0] = {}): Claim | undefined =>
    factionClaims(over).find((claim) => claim.id === "travel-fund") as Claim | undefined;

  test("the breakpoint being MET does not release the slot", () => {
    // rep 7,400 past a 7,340 target: the objective gap is closed, but 50,000 rep of
    // unowned augmentations remain at a joined faction, so the work is not finished.
    expect(slotClaim({ rep: 7_400 })).toBeDefined();
    // Same id as while working, which is what preserves incumbency — a different id
    // would hand the slot over exactly as dropping the claim did.
    expect(slotClaim({ rep: 7_400 })!.id).toBe("work:The Covenant");
  });

  test("still claims while the breakpoint is UNMET, as before", () => {
    expect(slotClaim({ rep: 100 })!.id).toBe("work:The Covenant");
  });

  test("ordinary route work bids the reputation it would earn, rather than a band", () => {
    // `factions:route-work` (91) existed to clear career income's scored
    // ceiling of 80. With both sides priced in BN-seconds there is nothing to
    // clear: reputation work wins exactly when reputation is what the route is
    // short of, and loses when it is not.
    const claim = slotClaim({ rep: 100, route: "daedalus" })!;
    expect(claim.produces).toBeDefined();
    expect(claim.priority).toBe(PRIORITY["factions:work"]);
  });

  test("the claim PREDICTS its reputation instead of remembering a measured one", () => {
    // The claim must price itself before a measured work rate exists. The game
    // formula provides a nonzero prediction for work the faction supports.
    const skills = { hacking: 300, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 200 };
    const claim = slotClaim({ rep: 100, workTypes: ["hacking", "field", "security"], skills })!;
    const person = {
      skills: { ...skills, intelligence: 0 },
      mults: {
        faction_rep: 1, hacking_exp: 1, strength_exp: 1, defense_exp: 1,
        dexterity_exp: 1, agility_exp: 1, charisma_exp: 1,
      },
    } as never;
    const ctx = {
      factionWorkRepGain: 1, factionWorkExpGain: 1, factionPassiveRepGain: 1,
      shareBonus: 1, sf15Level: 0, hasFocusAug: false,
    };
    const expected = Math.max(...(["hacking", "field", "security"] as const)
      .map((type) => workRepPerSec(type, person, 13, ctx, true)));
    expect(claim.produces!["reputation"]).toBeGreaterThan(0);
    expect(claim.produces!["reputation"]).toBeCloseTo(expected, 9);
  });

  test("the predicted bid announces the experience the work also pays", () => {
    // Field and security work pay combat and charisma experience alongside
    // reputation. Announcing reputation alone sent a posted combat gate to crime
    // while the reputation that same second could have earned did not happen.
    const skills = { hacking: 10, strength: 400, defense: 400, dexterity: 400, agility: 400, charisma: 400 };
    const claim = slotClaim({ rep: 100, workTypes: ["field"], skills })!;
    expect(claim.produces!["combat"]).toBeGreaterThan(0);
    expect(claim.produces!["charisma"]).toBeGreaterThan(0);
  });

  test("a faction whose work types have not been probed yet bids nothing it cannot do", () => {
    // Working a type a faction does not offer fails silently forever, so an
    // unreported probe offers NOTHING rather than all three.
    expect(slotClaim({ rep: 100 })!.produces!["reputation"]).toBe(0);
  });

  test("only a mechanically mandatory route install gets hard preemption", () => {
    const economic = slotClaim({ rep: 100, route: "daedalus", installWanted: true })!;
    expect(economic.priority).toBe(PRIORITY["factions:work"]);
    expect(economic.produces, "priced, so it competes on what it earns").toBeDefined();

    // The band is for the window BEFORE the transaction opens: the route
    // mandates this install and the reputation for its package is still being
    // earned. That is the only state in which the claim buys anything — and it
    // is HARD, because "the run cannot end without this" is not a rate.
    const claim = slotClaim({ rep: 100, route: "daedalus", routeInstallRequired: true })!;
    expect(claim.priority).toBe(PRIORITY["factions:install-work"]);
    expect(claim.produces, "mandatory work is not bid for").toBeUndefined();
    // Above the progress lock, so it takes an idle slot ahead of anything —
    // but not by the pre-emption margin, so an unbanked crime still finishes
    // its unit first. Cancelling banked-at-completion work is never free.
    expect(claim.priority).toBeGreaterThan(PRIORITY["career:progress-lock"]);
  });

  test("the pre-install drain releases the slot instead of parking it at the top band", () => {
    // Once progression ALSO wants the install, `stepFactions` refuses to start
    // work at all (both its exceptions are gated on `routeInstallRequired !==
    // true`) and runs the frozen purchase drain, which needs money and RAM
    // rather than player time. Holding the slot there — above even
    // `career:blocking-need` — would lock career out of the karma an install
    // does not wipe, for a feature with nothing to do with the slot.
    expect(
      slotClaim({ rep: 100, route: "daedalus", installWanted: true, routeInstallRequired: true }),
    ).toBeUndefined();
  });

  test("the travel fare is claimed from the BLOCKER, not from an already-published travel", () => {
    // Claims are evaluated before the driver publishes its next action, so the
    // blocker must anticipate the fare needed by that action.
    const cityBlocker = [{ faction: "Tetrads", kind: "city", subject: "Chongqing" }];
    expect(travelFund({ blockers: cityBlocker }), "claimed before the action exists").toBeDefined();
    expect(travelFund({ blockers: cityBlocker })!.amount).toBe(200_000);

    // Still claimed once the action IS published — the two must overlap, or the
    // grant lapses on the very pass that would spend it.
    expect(travelFund({ blockers: cityBlocker, action: { type: "travelTo", city: "Chongqing" } }))
      .toBeDefined();

    // A city requirement that is NOT the faction's only remaining blocker is
    // not travel-imminent: travelling would break something else first.
    expect(travelFund({
      blockers: [
        { faction: "Tetrads", kind: "city", subject: "Chongqing" },
        { faction: "Tetrads", kind: "combatSkills" },
      ],
    })).toBeUndefined();
    expect(travelFund(), "nothing blocked on a city at all").toBeUndefined();
  });

  test("nothing left to work toward DOES release the slot", () => {
    // A claimant with no remaining work must release the slot.
    expect(slotClaim({ offers: [] }), "no offers at all").toBeUndefined();
    expect(
      slotClaim({ offers: [{ faction: "The Covenant", repReq: 50_000, owned: true }] }),
      "every offer already owned",
    ).toBeUndefined();
    expect(
      slotClaim({ offers: [{ faction: "The Covenant", repReq: 1_000, owned: false }] }),
      "reputation already covers everything offered",
    ).toBeUndefined();
    expect(
      slotClaim({ offers: [{ faction: "Daedalus", repReq: 1e9, owned: false }] }),
      "the only rep worth earning is at a faction we have not joined",
    ).toBeUndefined();
  });
});

describe("the work slot is priced in BN-seconds, not banded", () => {
  // A claim announces its rates, and the arbiter prices them against the field
  // using progression's BN-second value for each channel.
  test("fractions are clamped, and nothing announced is not a fraction of nothing", () => {
    expect(rateFraction(500, 1_000)).toBe(0.5);
    expect(rateFraction(2_000, 1_000), "cannot exceed the best").toBe(1);
    // An absent or zero best must not silently promote a claim to the top: a feature
    // with nothing honest to announce scores nothing, rather than 1.
    expect(rateFraction(100, 0)).toBe(0);
    expect(rateFraction(0, 1_000)).toBe(0);
    expect(rateFraction(-5, 1_000)).toBe(0);
    // Being the only announcer correctly yields the whole worth.
    expect(rateFraction(1_000, 1_000)).toBe(1);
  });

  function careerState(over: {
    crimePerSec: number;
    farmPerSec?: number;
    marginals?: Record<string, { state: string; secondsPerRelativeRate: number }>;
  }): GameState {
    return {
      topics: {
        player: { money: 0, skills: {}, mults: {}, jobs: {}, city: "Sector-12" },
        ...(over.farmPerSec !== undefined ? { fleet: { scriptIncome: [over.farmPerSec, 0] } } : {}),
        progression: { sourceFiles: {}, ...(over.marginals ? { plan: { marginals: over.marginals } } : {}) },
        career: {
          karma: 0, numPeopleKilled: 0, skills: {}, exp: {}, city: "Sector-12",
          location: "home", entropy: 0, totalPlaytime: 0, jobs: {}, companies: {},
          currentWork: null,
          crimes: [{
            name: "Heist", timeMs: 1_000, money: over.crimePerSec, difficulty: 1,
            karma: 0, kills: 0, weights: {}, exp: {}, chance: 1, gainsAreEffective: true,
          }],
          plan: { ranked: [{ label: "crime: Heist", score: 1, moneyPerSec: over.crimePerSec, priority: "income", contributions: [] }] },
        },
      },
      dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
      probeFailures: {}, featureLastRun: {},
    } as unknown as GameState;
  }

  function slotClaimFor(state: GameState, needs: Need[] = []): Claim {
    const claims = careerModule.claims!({
      state,
      board: postNeeds(needs),
      now: 0,
      caps: {} as ClaimContext["caps"],
      selectedFeatures: new Set(),
      activeFeatures: new Set(),
      horizons: {
        node: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
        install: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
      },
    });
    resetCareerState();
    return claims.find((claim) => claim.id === "work" && claim.resource === "time")! as Claim;
  }

  const MONEY_WORTH = 1_000;
  const REP_WORTH = 4_000;
  const factionWork: Claim = {
    by: "factions", id: "work:Daedalus", resource: "time", amount: 1, shape: "step",
    pricing: "hard", value: { state: "unknown", reason: "slot" },
    priority: PRIORITY["factions:work"], mode: "spend",
    produces: { reputation: 40 },
  };

  function slotWinner(career: Claim, worth: Map<string, number>): string | undefined {
    return resolveClaims({
      now: 1_000,
      pools: { money: 0 },
      claims: [career, factionWork],
      rates: { best: new Map(), worth },
    }).slot?.by;
  }

  test("career announces the rates its chosen option would produce", () => {
    const claim = slotClaimFor(careerState({ crimePerSec: 1_000 }));
    expect(claim.produces).toMatchObject({ money: 1_000 });
    // The rate announcement makes this comparable with faction work.
    expect(claim.holdUntil).toBeUndefined();
  });

  test("crime takes the slot when money is what the route is short of", () => {
    const state = careerState({
      crimePerSec: 1_000,
      marginals: { money: { state: "estimated", secondsPerRelativeRate: MONEY_WORTH } },
    });
    // Sole earner, and money is worth more than reputation here.
    expect(slotWinner(slotClaimFor(state), new Map([["money", MONEY_WORTH], ["reputation", 100]])))
      .toBe("career");
  });

  test("out-earned by the farm, the same crime loses the slot to reputation work", () => {
    // A small incremental money rate loses when reputation has more route value.
    const state = careerState({ crimePerSec: 1_000, farmPerSec: 4_000_000 });
    const worth = new Map([["money", MONEY_WORTH], ["reputation", REP_WORTH]]);
    expect(slotWinner(slotClaimFor(state), worth)).toBe("factions");
  });

  test("a blocking need career barely serves no longer buys it the slot", () => {
    // Progression posts the Daedalus money gate at weight 5, urgency blocking.
    // Urgency alone does not grant the slot. Here the contribution is worth nothing:
    // the same route's own marginal prices a relative income increase at zero,
    // because the farm clears that gate long before anything else on the route.
    const state = careerState({
      crimePerSec: 1_000,
      farmPerSec: 4_000_000,
      marginals: {
        money: { state: "estimated", secondsPerRelativeRate: 0 },
        reputation: { state: "estimated", secondsPerRelativeRate: REP_WORTH },
      },
    });
    const moneyGate: Need = {
      by: "progression", kind: "money", target: 1e11, have: 1.8e10,
      weight: 5, urgency: "blocking",
    };
    const claim = slotClaimFor(state, [moneyGate]);
    const worth = new Map([["money", 0], ["reputation", REP_WORTH]]);
    expect(slotWinner(claim, worth)).toBe("factions");
  });

  test("a bid that cannot price itself loses, and is never promoted to a lock", () => {
    // Factions re-issues its claim across a pass where the planner took an
    // early exit and computed no work rate. Dropping the claim would release
    // the slot outright (arbiter rule 4); silently becoming a hard claim at
    // band 60 would be worse still — it would outrank every priced bid on the
    // strength of having no number at all.
    const mute: Claim = { ...factionWork, produces: { reputation: 0 } };
    const earner = slotClaimFor(careerState({ crimePerSec: 1_000 }));
    expect(resolveClaims({
      now: 1_000,
      pools: { money: 0 },
      claims: [mute, earner],
      rates: { best: new Map(), worth: new Map() },
    }).slot?.by).toBe("career");
  });

  test("an in-flight crime still cannot be cancelled, whatever reputation is worth", () => {
    // The lock is not an assertion that crime is more valuable; it is that
    // throwing away an unbanked ten-minute unit costs more than the remaining
    // seconds are worth to anyone. It is HARD, so no priced bid outranks it.
    const locked: Claim = {
      by: "career", id: "work", resource: "time", amount: 1, shape: "step",
      pricing: "hard", value: { state: "unknown", reason: "slot" },
      priority: PRIORITY["career:progress-lock"], mode: "spend",
      holdUntil: 600_000,
    };
    expect(slotWinner(locked, new Map([["reputation", 1e9]]))).toBe("career");
  });

  test("before any marginal exists, the slot falls back to money per second", () => {
    // A fresh install has no forecast and therefore no worth for any channel.
    // Dollars and BN-seconds are never mixed; the bootstrap rule is money.
    const state = careerState({ crimePerSec: 1_000 });
    expect(slotWinner(slotClaimFor(state), new Map())).toBe("career");
  });
});

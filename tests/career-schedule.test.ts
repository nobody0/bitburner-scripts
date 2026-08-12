import { describe, expect, test } from "bun:test";
import {
  armWorkCompletion,
  consumeWorkCompletion,
  peekWorkCompletion,
  resetWorkCompletion,
} from "../game/lib/work-completion.ts";
import { careerModule, priorityForDecision, resetCareerState } from "../game/lib/features/career.ts";
import { factionsModule } from "../game/lib/features/factions.ts";
import type { ClaimContext } from "../game/lib/features/index.ts";
import type { GameState } from "../game/lib/state.ts";
import { stepCareer, type CareerView } from "../shared/strategy/career/decide.ts";
import type { CrimeContext, CrimePerson, CrimeStats } from "../shared/strategy/career/crimes.ts";
import { careerSchedule, CONTINUOUS_REVIEW_MS, progressLockUntil, updateActivityRate } from "../shared/strategy/career/schedule.ts";
import { PREEMPT_MARGIN, PRIORITY } from "../shared/strategy/arbiter.ts";
import { rateFraction, slotPriority } from "../shared/strategy/income.ts";
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

describe("Algorithms versus route reputation", () => {
  function routeState(repSec: number): GameState {
    return {
      topics: {
        progression: { plan: { route: "daedalus" } },
        factions: {
          plan: {
            objective: {
              intent: { purpose: "augmentations", repSec },
            },
          },
        },
      },
    } as unknown as GameState;
  }

  function algorithms(externalExpPerSec: number): { decision: ReturnType<typeof stepCareer>; careerView: CareerView } {
    const careerView = view({
      crimes: [],
      courses: [{ name: "Algorithms", skill: "hacking", expPerSec: 10, costPerSec: 0, location: "Rothman University" }],
      exp: { hacking: 0 },
      skillMultipliers: { hacking: 1 },
      externalSkillExpPerSec: { hacking: externalExpPerSec },
    });
    const board = postNeeds([{
      by: "progression",
      kind: "skill",
      subject: "hacking",
      target: 100,
      have: 1,
      weight: 5,
      urgency: "blocking",
      why: "Daedalus invite",
    }]);
    return { decision: stepCareer(careerView, board), careerView };
  }

  test("background XP that closes the skill gate during faction work removes the Algorithms bid", () => {
    const { decision, careerView } = algorithms(1_000_000);
    expect(priorityForDecision(decision, careerView, routeState(1_000))).toBe(0);
  });

  test("without background XP Algorithms retains its blocking priority", () => {
    const { decision, careerView } = algorithms(0);
    const priority = priorityForDecision(decision, careerView, routeState(1_000));
    expect(priority).toBe(PRIORITY["career:blocking-need"]);
    expect(priority).toBeGreaterThan(PRIORITY["factions:route-work"] + PREEMPT_MARGIN);
  });

  test("pre-gate Algorithms bootstrap decays as the hacking fleet replaces its XP", () => {
    const careerView = view({
      crimes: [],
      courses: [{ name: "Algorithms", skill: "hacking", expPerSec: 10, costPerSec: 0, location: "Rothman University" }],
      externalIncomePerSec: 1,
      externalSkillExpPerSec: { hacking: 0 },
    });
    const decision = stepCareer(careerView, postNeeds([]));
    expect(decision).toMatchObject({ action: { subject: "Algorithms" }, incomeFallback: true });
    expect(priorityForDecision(decision, careerView, routeState(1_000)))
      .toBe(PRIORITY["career:blocking-need"]);

    const farmDominates = { ...careerView, externalSkillExpPerSec: { hacking: 90 } };
    expect(priorityForDecision(decision, farmDominates, routeState(1_000)))
      .toBeCloseTo(PRIORITY["career:blocking-need"] * 0.1, 12);
  });

  test("an optional Algorithms need keeps its declared priority", () => {
    const careerView = view({
      crimes: [],
      courses: [{ name: "Algorithms", skill: "hacking", expPerSec: 10, costPerSec: 0, location: "Rothman University" }],
      externalSkillExpPerSec: { hacking: 0 },
    });
    const decision = stepCareer(careerView, postNeeds([{
      by: "progression",
      kind: "skill",
      subject: "hacking",
      target: 100,
      have: 1,
      weight: 1,
      urgency: "wanted",
      why: "optional acceleration",
    }]));

    expect(decision).toMatchObject({ incomeFallback: false, workPriority: "wanted" });
    expect(priorityForDecision(decision, careerView, routeState(1_000)))
      .toBe(PRIORITY["career:wanted-request"]);
  });
});

describe("factions holds the slot across a breakpoint hand-off", () => {
  // THE BUG, measured on a live BN12 run: reaching the objective's reputation
  // breakpoint closed the only gap `nextWorkFaction` looks at, so factions posted no
  // slot claim for one pass. Dropping the claim is how an incumbent RELEASES the slot
  // (arbiter rule 3), and the planner only picks its next breakpoint on its own 30 s
  // cadence — so at EVERY breakpoint the slot came free, `career` filled it with a
  // 10-minute Heist, and faction work waited out the lock. The trace showed 91 s of
  // reputation per 650 s cycle: a 14% duty cycle, turning a 14 h Daedalus grind
  // into ~100 h.
  function slotClaim(over: {
    rep?: number;
    repTarget?: number;
    offers?: { faction: string; repReq: number; owned?: boolean }[];
    joined?: string[];
    route?: "daedalus" | "gang";
    installWanted?: boolean;
    routeInstallRequired?: boolean;
  } = {}) {
    const rep = over.rep ?? 7_400;
    const state = {
      topics: {
        player: { money: 0, skills: {}, mults: {}, jobs: {}, city: "Sector-12" },
        factions: {
          joined: over.joined ?? ["The Covenant"],
          standings: [{ name: "The Covenant", rep, favor: 13, joined: true }],
          offers: over.offers ?? [{ faction: "The Covenant", repReq: 50_000, owned: false }],
          plan: {
            context: { route: over.route },
            action: { type: "idle", why: "breakpoint met" },
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
      probeFailures: {}, probeSkips: {}, featureLastRun: {},
    } as unknown as GameState;
    const claims = factionsModule.claims!({
      state,
      board: postNeeds([]),
      now: 0,
      caps: {} as ClaimContext["caps"],
      budgetGb: 100,
      horizons: {
        node: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
        install: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
      },
      ramPrice: (methods) => methods.length,
    });
    return claims.find((claim) => claim.resource === "time" && claim.id.startsWith("work:"));
  }

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

  test("a selected faction-acquisition route outranks ordinary income after a task boundary", () => {
    const claim = slotClaim({ rep: 100, route: "daedalus" })!;
    expect(claim.priority).toBe(PRIORITY["factions:route-work"]);
    expect(claim.priority).toBeGreaterThan(80 + PREEMPT_MARGIN);
    expect(PRIORITY["career:blocking-need"]).toBeGreaterThan(claim.priority + PREEMPT_MARGIN);
  });

  test("only a mechanically mandatory route install gets hard preemption", () => {
    const economic = slotClaim({ rep: 100, route: "daedalus", installWanted: true })!;
    expect(economic.priority).toBe(PRIORITY["factions:route-work"]);

    const claim = slotClaim({ rep: 100, route: "daedalus", installWanted: true, routeInstallRequired: true })!;
    expect(claim.priority).toBe(PRIORITY["factions:install-work"]);
    expect(claim.priority).toBeGreaterThan(PRIORITY["career:blocking-need"] + PREEMPT_MARGIN);
  });

  test("nothing left to work toward DOES release the slot", () => {
    // Otherwise factions would sit on the slot doing nothing and career could never
    // earn again — the mirror image of the bug.
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

describe("the work slot is scored on what it yields", () => {
  // A fixed `career:income` said the same thing whether crime out-earned the hacking
  // farm tenfold or was a rounding error beside it, so the exclusive slot could not
  // be allocated on merit. Priority is now `repFraction * 60 + moneyFraction * 80`,
  // each fraction measured against the best rate anyone announced.
  test("the spans reproduce the worked examples", () => {
    // Best reputation, no salary — what `factions:work` was as a constant.
    expect(slotPriority({ repFraction: 1 })).toBe(60);
    // Best money, no reputation. ABOVE reputation work on purpose: our best earner
    // takes the slot from rep work, which is a decision about what the run is for.
    expect(slotPriority({ moneyFraction: 1 })).toBe(80);
    // Best for reputation and half the best money — they ADD, because a job paying
    // in both is worth both.
    expect(slotPriority({ repFraction: 1, moneyFraction: 0.5 })).toBe(100);
    expect(slotPriority({ moneyFraction: 1 })).toBeGreaterThan(slotPriority({ repFraction: 1 }));
  });

  test("fractions are clamped, and nothing announced is not a fraction of nothing", () => {
    expect(rateFraction(500, 1_000)).toBe(0.5);
    expect(rateFraction(2_000, 1_000), "cannot exceed the best").toBe(1);
    // An absent or zero best must not silently promote a claim to the top: a feature
    // with nothing honest to announce scores nothing, rather than 1.
    expect(rateFraction(100, 0)).toBe(0);
    expect(rateFraction(0, 1_000)).toBe(0);
    expect(rateFraction(-5, 1_000)).toBe(0);
    // Being the only announcer correctly yields the full span.
    expect(rateFraction(1_000, 1_000)).toBe(1);
  });

  test("career's income claim rises and falls with its share of the best rate", () => {
    function incomeClaim(over: { crimePerSec: number; farmPerSec?: number }) {
      const state = {
        topics: {
          player: { money: 0, skills: {}, mults: {}, jobs: {}, city: "Sector-12" },
          ...(over.farmPerSec !== undefined ? { fleet: { scriptIncome: [over.farmPerSec, 0] } } : {}),
          career: {
            karma: 0, numPeopleKilled: 0, skills: {}, exp: {}, city: "Sector-12",
            location: "home", entropy: 0, totalPlaytime: 0, jobs: {}, companies: {},
            currentWork: null,
            crimes: [],
            plan: { ranked: [{ label: "crime: Heist", score: 1, moneyPerSec: over.crimePerSec, priority: "income", contributions: [], why: "" }] },
          },
        },
        dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
        probeFailures: {}, probeSkips: {}, featureLastRun: {},
      } as unknown as GameState;
      const claims = careerModule.claims!({
        state,
        board: postNeeds([]),
        now: 0,
        caps: {} as ClaimContext["caps"],
        budgetGb: 100,
        horizons: {
          node: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
          install: { state: "unknown", evaluatedAt: 1, nextRecalibrationAt: 2, basis: "t", reason: "t" },
        },
        ramPrice: (methods) => methods.length,
      });
      resetCareerState();
      return claims.find((claim) => claim.id === "work" && claim.resource === "time")!;
    }

    // Sole earner: full span, and it outranks faction work.
    expect(incomeClaim({ crimePerSec: 1_000 }).priority).toBe(80);
    expect(incomeClaim({ crimePerSec: 1_000 }).priority).toBeGreaterThan(slotPriority({ repFraction: 1 }));

    // Out-earned four to one by the farm: a quarter of the span, and now it loses to
    // faction work — which is the behaviour a flat 30 could never express.
    const outclassed = incomeClaim({ crimePerSec: 1_000, farmPerSec: 4_000 });
    expect(outclassed.priority).toBeCloseTo(20, 10);
    expect(outclassed.priority).toBeLessThan(slotPriority({ repFraction: 1 }));

    // Matching the farm splits it evenly.
    expect(incomeClaim({ crimePerSec: 4_000, farmPerSec: 4_000 }).priority).toBe(80);
    expect(incomeClaim({ crimePerSec: 2_000, farmPerSec: 4_000 }).priority).toBeCloseTo(40, 10);
  });
});

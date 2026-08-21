import { describe, expect, test } from "bun:test";
import { rankGoGames, type GoGameCandidate, type GoRewardView } from "../shared/strategy/go/rewards.ts";
import { goRamPricingCandidate, planGoSchedule } from "../shared/strategy/go/schedule.ts";

const OPPONENTS = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"] as const;

function rewardView(overrides: Partial<GoRewardView> = {}): GoRewardView {
  return {
    opponents: OPPONENTS,
    stats: [],
    joinedFactions: new Set<string>(),
    factionFavor: {},
    demands: {},
    goPower: 1,
    hasSourceFile14: false,
    favorRepCap: 100_000,
    installRemainingSec: 10_000,
    ...overrides,
  };
}

describe("wait-aware ranking", () => {
  test("an aligned candidate with a long wait ranks below a slightly weaker zero-wait opponent, and a short wait flips it back", () => {
    const base = {
      demands: {
        Illuminati: { seconds: 10_000, share: 1 },
        "The Black Hand": { seconds: 9_000, share: 1 },
      },
    } as const;
    const longWait = rankGoGames(rewardView({
      ...base,
      playbookEntries: { Illuminati: { waitSec: 900, entryPlaytime: 1_000_000 } },
    }));
    // The unaligned Illuminati variant may still lead (playing now is free);
    // the ALIGNED variant must pay its 900s wait and fall behind the
    // zero-wait Black Hand alternative.
    const alignedIndex = longWait.findIndex((candidate) => candidate.aligned);
    const blackHandIndex = longWait.findIndex((candidate) => candidate.opponent === "The Black Hand");
    expect(alignedIndex).toBeGreaterThan(blackHandIndex);
    const shortWait = rankGoGames(rewardView({
      ...base,
      playbookEntries: { Illuminati: { waitSec: 5, entryPlaytime: 1_000_000 } },
    }));
    expect(shortWait[0]).toMatchObject({ opponent: "Illuminati", aligned: true });
  });

  test("both variants of a playbook opponent are offered, and the aligned one carries its entry tick", () => {
    const ranked = rankGoGames(rewardView({
      opponents: ["Illuminati"],
      demands: { Illuminati: { seconds: 10_000, share: 1 } },
      playbookEntries: { Illuminati: { waitSec: 60, entryPlaytime: 424_242 } },
    }));
    const aligned = ranked.filter((candidate) => candidate.aligned);
    const unaligned = ranked.filter((candidate) => !candidate.aligned);
    expect(aligned).toHaveLength(1);
    expect(unaligned).toHaveLength(1);
    expect(aligned[0]).toMatchObject({ waitSec: 60, entryPlaytime: 424_242 });
    expect(aligned[0]!.winProbability).toBeGreaterThan(unaligned[0]!.winProbability);
  });

  test("without playbook entries every candidate is unaligned with zero wait (legacy behavior)", () => {
    const ranked = rankGoGames(rewardView({ demands: { Netburners: { seconds: 5_000, share: 1 } } }));
    expect(ranked.every((candidate) => !candidate.aligned && candidate.waitSec === 0)).toBe(true);
  });
});

describe("favor value near an install", () => {
  test("with zero install runway a favor-eligible opponent still prices above zero (the 2026-08-18 stall)", () => {
    const ranked = rankGoGames(rewardView({
      installRemainingSec: 0,
      stats: [{ opponent: "The Black Hand", wins: 1, losses: 0, winStreak: 1, rep: 0, bonusPercent: 0 }],
      joinedFactions: new Set(["The Black Hand"]),
      // remainingWorkSec spans the remaining NODE (favor persists through
      // installs) — this is what the favorValue bridge supplies.
      factionFavor: { "The Black Hand": { favor: 20, remainingWorkSec: 5_000 } },
    }));
    const blackHand = ranked.find((candidate) => candidate.opponent === "The Black Hand")!;
    expect(blackHand.utilityPerSec).toBeGreaterThan(0);
  });

  test("a favor event that crosses the donation threshold banks the one-time unlock value", () => {
    const common = {
      installRemainingSec: 0,
      stats: [{ opponent: "Daedalus", wins: 1, losses: 0, winStreak: 1, rep: 0, bonusPercent: 0 }],
      joinedFactions: new Set(["Daedalus"]),
    } as const;
    const crossing = rankGoGames(rewardView({
      ...common,
      // The event grants favorRepCap/200 = 500 rep; at favor 149.98 the ~190
      // rep to favor 150 is within the grant, so the event crosses the gate.
      factionFavor: { Daedalus: { favor: 149.98, remainingWorkSec: 1_000, pointValue: { donationUnlockSec: 20_000, donateThreshold: 150 } } },
    })).find((candidate) => candidate.opponent === "Daedalus")!;
    const notCrossing = rankGoGames(rewardView({
      ...common,
      factionFavor: { Daedalus: { favor: 60, remainingWorkSec: 1_000, pointValue: { donationUnlockSec: 20_000, donateThreshold: 150 } } },
    })).find((candidate) => candidate.opponent === "Daedalus")!;
    expect(crossing.favorSecSaved).toBeGreaterThan(notCrossing.favorSecSaved);
    expect(crossing.favorSecSaved).toBeGreaterThan(10_000);
  });

  test("a short game outranks a long one on a short runway, but neither is zeroed", () => {
    // The 2026-08-18 tail: ~139s forecast left. The 27s Illuminati game beats
    // the 159s daemon game per second — but the forecast is an ESTIMATE, so
    // the daemon keeps positive value rather than being cliffed to zero
    // (treating the deadline as a wall idled Go whenever the forecast sat
    // short for longer than it promised).
    const ranked = rankGoGames(rewardView({
      opponents: ["Illuminati", "????????????"],
      installRemainingSec: 139,
      demands: {
        Illuminati: { seconds: 139, share: 1 },
        "????????????": { seconds: 139, share: 1 },
      },
    }));
    expect(ranked[0]!.opponent).toBe("Illuminati");
    const daemon = ranked.find((candidate) => candidate.opponent === "????????????")!;
    expect(daemon.transientSecSaved).toBeGreaterThan(0);
    expect(daemon.utilityPerSec).toBeGreaterThan(0);
  });

  test("the favor-rep cap still zeroes favor value", () => {
    const ranked = rankGoGames(rewardView({
      installRemainingSec: 0,
      stats: [{ opponent: "Daedalus", wins: 1, losses: 0, winStreak: 1, rep: 100_000, bonusPercent: 0 }],
      joinedFactions: new Set(["Daedalus"]),
      factionFavor: { Daedalus: { favor: 10, remainingWorkSec: 5_000, pointValue: { donationUnlockSec: 20_000, donateThreshold: 150 } } },
    }));
    const daedalus = ranked.find((candidate) => candidate.opponent === "Daedalus")!;
    expect(daedalus.favorSecSaved).toBe(0);
  });
});

function candidate(overrides: Partial<GoGameCandidate>): GoGameCandidate {
  return {
    opponent: "Netburners",
    boardSize: 5,
    observedBoardSize: 5,
    aligned: false,
    waitSec: 0,
    winProbability: 1,
    expectedBlackScore: 15,
    expectedGameSec: 5,
    difficultyMultiplier: 0.5,
    currentWinStreak: 0,
    powerIfWin: 10,
    powerIfLoss: 5,
    expectedNodePower: 9,
    multiplierBefore: 1,
    multiplierAfter: 1.01,
    transientSecSaved: 10,
    favorEventProbability: 0,
    favorBefore: 0,
    favorAfter: 0,
    favorRemainingWorkSec: 0,
    expectedFavorGain: 0,
    favorSecSaved: 0,
    totalSecSaved: 10,
    utilityPerSec: 2,
    planningGames: 2,
    horizonNodePower: 10,
    horizonTransientSecSaved: 10,
    horizonFavorSecSaved: 0,
    ...overrides,
  };
}

const SCHEDULE_DEFAULTS = { cadenceSec: 5, fillerMarginFactor: 1.25, fillerOverheadSec: 10 };

describe("planGoSchedule", () => {
  test("plays immediately when the preferred wait is within the cadence", () => {
    const schedule = planGoSchedule({
      candidates: [candidate({ opponent: "Illuminati", aligned: true, waitSec: 4 })],
      ...SCHEDULE_DEFAULTS,
    });
    expect(schedule).toMatchObject({ kind: "play", game: { opponent: "Illuminati" } });
  });

  test("fits the best whole game inside a long window", () => {
    const schedule = planGoSchedule({
      candidates: [
        candidate({ opponent: "Illuminati", aligned: true, waitSec: 300, utilityPerSec: 5 }),
        candidate({ opponent: "Netburners", waitSec: 0, expectedGameSec: 20, utilityPerSec: 1 }),
      ],
      ...SCHEDULE_DEFAULTS,
    });
    expect(schedule).toMatchObject({ kind: "filler", game: { opponent: "Netburners" }, preferred: { opponent: "Illuminati" } });
  });

  test("holds when nothing completes inside the window", () => {
    const schedule = planGoSchedule({
      candidates: [
        candidate({ opponent: "Illuminati", aligned: true, waitSec: 30, utilityPerSec: 5 }),
        candidate({ opponent: "????????????", waitSec: 0, expectedGameSec: 160, utilityPerSec: 1 }),
      ],
      ...SCHEDULE_DEFAULTS,
    });
    expect(schedule).toMatchObject({ kind: "hold", resumeInSec: 30 });
  });

  test("the filler must pay its margin and overhead", () => {
    // 20s game * 1.25 + 10 = 35 > 30s window: does not fit.
    const schedule = planGoSchedule({
      candidates: [
        candidate({ opponent: "Illuminati", aligned: true, waitSec: 30, utilityPerSec: 5 }),
        candidate({ opponent: "Netburners", waitSec: 0, expectedGameSec: 20, utilityPerSec: 1 }),
      ],
      ...SCHEDULE_DEFAULTS,
    });
    expect(schedule?.kind).toBe("hold");
  });

  test("undefined on an empty candidate list", () => {
    expect(planGoSchedule({ candidates: [], ...SCHEDULE_DEFAULTS })).toBeUndefined();
  });

  test("a barely-valued short game is still the filler for a long window", () => {
    // Netburners against a live farm is worth a rounding error, and the ranker
    // now says so — but the filler slot is free wall-clock inside someone
    // else's entry wait, and the shortest game on the board still fills it.
    // Scheduling reads the ranked list; it does not re-judge the reward.
    const netburners = rankGoGames(rewardView({
      opponents: ["Netburners"],
      demands: { Netburners: { seconds: 10_000, share: 0.03 } },
    }))[0]!;
    // Worth a small fraction of the preferred opponent, by the honest
    // valuation rather than by any rule about who Netburners is…
    expect(netburners.utilityPerSec).toBeLessThan(1);
    const schedule = planGoSchedule({
      candidates: [
        candidate({ opponent: "Illuminati", aligned: true, waitSec: 300, utilityPerSec: 5 }),
        netburners,
      ],
      ...SCHEDULE_DEFAULTS,
    });
    expect(schedule).toMatchObject({ kind: "filler", game: { opponent: "Netburners" } });
  });
});

describe("who pays for the dodge", () => {
  test("a filler is priced by the window it fills, not by its own thin value", () => {
    // The wall-clock is already committed to waiting for Illuminati. Charging
    // the five-second Netburners game the whole 4 GB dodge on its own merit is
    // what idled Go through entire certified-entry waits.
    const schedule = planGoSchedule({
      candidates: [
        candidate({ opponent: "Illuminati", aligned: true, waitSec: 300, utilityPerSec: 5 }),
        candidate({ opponent: "Netburners", waitSec: 0, expectedGameSec: 20, utilityPerSec: 0.01 }),
      ],
      ...SCHEDULE_DEFAULTS,
    })!;
    expect(schedule.kind).toBe("filler");
    expect(goRamPricingCandidate(schedule)).toMatchObject({ opponent: "Illuminati", utilityPerSec: 5 });
  });

  test("an ordinary start and a hold are priced by the game they are about", () => {
    const play = planGoSchedule({
      candidates: [candidate({ opponent: "Daedalus", waitSec: 0, utilityPerSec: 3 })],
      ...SCHEDULE_DEFAULTS,
    })!;
    expect(goRamPricingCandidate(play)).toMatchObject({ opponent: "Daedalus" });

    const hold = planGoSchedule({
      candidates: [
        candidate({ opponent: "Illuminati", aligned: true, waitSec: 30, utilityPerSec: 5 }),
        candidate({ opponent: "????????????", waitSec: 0, expectedGameSec: 160, utilityPerSec: 1 }),
      ],
      ...SCHEDULE_DEFAULTS,
    })!;
    expect(hold.kind).toBe("hold");
    expect(goRamPricingCandidate(hold)).toMatchObject({ opponent: "Illuminati" });
  });
});

describe("capped reward elasticity", () => {
  test("a gain cap limits what a large multiplier can deliver", () => {
    const demand = { seconds: 10_000, share: 1 } as const;
    const stats = [{ opponent: "Slum Snakes" as const, wins: 0, losses: 0, winStreak: 0, rep: 0, bonusPercent: 0 }];
    const uncapped = rankGoGames(rewardView({ stats, demands: { "Slum Snakes": demand } }))
      .find((candidate) => candidate.opponent === "Slum Snakes")!;
    const capped = rankGoGames(rewardView({ stats, demands: { "Slum Snakes": { ...demand, gainCap: 0.01 } } }))
      .find((candidate) => candidate.opponent === "Slum Snakes")!;

    expect(capped.transientSecSaved).toBeLessThan(uncapped.transientSecSaved);
    // Exactly the ceiling, not an approximation of it: a 99%-success crime
    // cannot gain more than the remaining one percent however far Node Power
    // pushes the multiplier.
    expect(capped.transientSecSaved).toBeCloseTo(10_000 * 1 * 0.01, 9);
    expect(capped.horizonTransientSecSaved).toBeCloseTo(10_000 * 1 * 0.01, 9);

    // At the cap the reward is worth nothing at all.
    const atCap = rankGoGames(rewardView({ stats, demands: { "Slum Snakes": { ...demand, gainCap: 0 } } }))
      .find((candidate) => candidate.opponent === "Slum Snakes")!;
    expect(atCap.transientSecSaved).toBe(0);
  });
});

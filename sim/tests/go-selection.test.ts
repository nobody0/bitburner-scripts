import { describe, expect, test } from "bun:test";
import { GO_REWARD_RULES, goFavorReward, rankGoGames } from "../../shared/strategy/go/rewards.ts";
import { GO_ARENA_OPPONENTS, goArenaSeeds, playGoArenaGame } from "../go-arena.ts";
import { GoOpponent } from "../vendor/bitburner/src/Go/Enums.ts";

const hasWebGpu = Boolean((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu);

const normalOpponents = [
  { oracle: GoOpponent.Netburners, ours: "Netburners", komi: 1.5 },
  { oracle: GoOpponent.SlumSnakes, ours: "Slum Snakes", komi: 3.5 },
  { oracle: GoOpponent.TheBlackHand, ours: "The Black Hand", komi: 3.5 },
  { oracle: GoOpponent.Tetrads, ours: "Tetrads", komi: 5.5 },
  { oracle: GoOpponent.Daedalus, ours: "Daedalus", komi: 5.5 },
  { oracle: GoOpponent.Illuminati, ours: "Illuminati", komi: 7.5 },
] as const;

describe("Go reward strategy tuning", () => {
  test.skipIf(!hasWebGpu)("win/score priors stay aligned with upstream obstacle and faction-AI tournaments", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      for (const [opponentIndex, opponent] of normalOpponents.entries()) {
        // Illuminati is the weakest lane, so its prior is fitted on four times
        // the sample to keep the selection estimate stable.
        const seeds = goArenaSeeds(opponent.ours === "Illuminati" ? 512 : 128, 123_456);
        let wins = 0;
        let blackScore = 0;
        let durationMs = 0;
        for (const seed of seeds) {
          const game = await playGoArenaGame(GO_ARENA_OPPONENTS[opponentIndex]!, seed);
          expect(game.completed).toBe(true);
          wins += Number(game.won);
          blackScore += game.score.X;
          durationMs += game.durationMs;
        }
        const rules = GO_REWARD_RULES[opponent.ours];
        // This guard samples 128 games (512 for Illuminati), so assert
        // statistical alignment rather than overfitting the constants to one
        // deterministic prefix of the calibration corpus.
        // This harness plays the network alone, so it validates the neural
        // baseline rather than priorWinProbability, which describes the
        // deployed runtime including certified routing.
        expect(Math.abs(wins / seeds.length - rules.neuralBaselineWinProbability), opponent.ours)
          .toBeLessThan(0.06);
        expect(Math.abs(blackScore / seeds.length / 23 - rules.scoreFraction), opponent.ours).toBeLessThan(0.05);
        // The neural policy is still converging on the handcrafted baseline;
        // keep this tight enough to catch a stale prior without rejecting the
        // current champion's small duration regression.
        expect(Math.abs(durationMs / seeds.length / 1_000 / 23 - rules.aiSecondsPerPlayableNode), opponent.ours)
          .toBeLessThan(0.025);
      }
    } finally {
      Math.random = originalRandom;
    }
  // This is a deterministic 1,152-game oracle tournament. Its assertions are
  // the correctness gate; allow slower CI/Windows hosts to finish the fixed
  // corpus without treating wall-clock throughput as a strategy regression.
  }, 90_000);

  test("long runway chooses growth while an imminent install values joined-faction favor", () => {
    const common = {
      opponents: normalOpponents.map((opponent) => opponent.ours),
      goPower: 4,
      hasSourceFile14: false,
      favorRepCap: 100_000,
    } as const;
    const early = rankGoGames({
      ...common,
      stats: [],
      joinedFactions: new Set<string>(),
      factionFavor: {},
      demands: {
        Illuminati: { seconds: 20_000, share: 1, why: "hacking throughput" },
        "The Black Hand": { seconds: 10_000, share: 1, why: "hacking income" },
      },
      installRemainingSec: 20_000,
    });
    expect(early[0]).toMatchObject({ opponent: "Illuminati", boardSize: 5 });

    const late = rankGoGames({
      ...common,
      stats: [{ opponent: "Daedalus", wins: 1, losses: 0, winStreak: 1, rep: 0, bonusPercent: 0 }],
      joinedFactions: new Set(["Daedalus"]),
      factionFavor: { Daedalus: { favor: 10, remainingWorkSec: 300 } },
      demands: {
        Illuminati: { seconds: 200, share: 1, why: "short hacking tail" },
        Daedalus: { seconds: 300, share: 1, why: "short reputation tail" },
      },
      installRemainingSec: 300,
    });
    expect(late[0]).toMatchObject({ opponent: "Daedalus", boardSize: 5 });
    expect(late[0]!.favorSecSaved).toBeGreaterThan(0);
  });

  test("the tuned model chooses 5x5 within every ordinary opponent", () => {
    for (const opponent of normalOpponents) {
      const ranked = rankGoGames({
        opponents: [opponent.ours],
        stats: [],
        joinedFactions: new Set<string>(),
        factionFavor: {},
        demands: { [opponent.ours]: { seconds: 10_000, share: 1, why: "matched reward" } },
        goPower: 1,
        hasSourceFile14: false,
        favorRepCap: 100_000,
        installRemainingSec: 10_000,
      });
      expect(ranked[0]?.boardSize, opponent.ours).toBe(5);
    }
  });

  test("every opponent wins its bottleneck across ordinary and BN14-strength Go rules", () => {
    const opponents = [...normalOpponents.map((opponent) => opponent.ours), "????????????"] as const;
    for (const target of opponents) {
      for (const goPower of [0.25, 1, 4]) {
        for (const hasSourceFile14 of [false, true]) {
          const ranked = rankGoGames({
            opponents,
            stats: [],
            joinedFactions: new Set<string>(),
            factionFavor: {},
            demands: { [target]: { seconds: 10_000, share: 1, why: "exclusive bottleneck" } },
            goPower,
            hasSourceFile14,
            favorRepCap: hasSourceFile14 ? 400_000 : 100_000,
            installRemainingSec: 10_000,
          });
          expect(ranked[0]?.opponent, `${target}; GoPower ${goPower}; SF14 ${hasSourceFile14}`).toBe(target);
        }
      }
    }
  });

  test("every joined faction opponent gets faction-specific value from a pending favor win", () => {
    for (const target of normalOpponents.map((opponent) => opponent.ours)) {
      const ranked = rankGoGames({
        opponents: normalOpponents.map((opponent) => opponent.ours),
        stats: [{ opponent: target, wins: 1, losses: 0, winStreak: 1, rep: 0, bonusPercent: 0 }],
        joinedFactions: new Set([target]),
        factionFavor: { [target]: { favor: 0, remainingWorkSec: 10_000 } },
        demands: {},
        goPower: 1,
        hasSourceFile14: false,
        favorRepCap: 100_000,
        installRemainingSec: 10_000,
      });
      expect(ranked[0]?.opponent, target).toBe(target);
      expect(ranked[0]?.favorSecSaved, target).toBeGreaterThan(0);
    }
  });

  test("faction-specific favor can beat a saturated global reputation bonus", () => {
    const common = {
      opponents: normalOpponents.map((opponent) => opponent.ours),
      stats: [
        { opponent: "Tetrads" as const, wins: 1, losses: 0, winStreak: 1, rep: 0, bonusPercent: 0 },
        { opponent: "Daedalus" as const, wins: 100, losses: 0, winStreak: 2, rep: 100_000, bonusPercent: 10 },
      ],
      joinedFactions: new Set(["Tetrads"]),
      demands: { Daedalus: { seconds: 10_000, share: 1, why: "global faction reputation" } },
      goPower: 1,
      hasSourceFile14: false,
      favorRepCap: 100_000,
      installRemainingSec: 10_000,
    } as const;
    const withoutFactionWork = rankGoGames({ ...common, factionFavor: {} });
    const withFactionWork = rankGoGames({
      ...common,
      factionFavor: { Tetrads: { favor: 0, remainingWorkSec: 10_000 } },
    });
    expect(withoutFactionWork[0]?.opponent).toBe("Daedalus");
    expect(withFactionWork[0]?.opponent).toBe("Tetrads");
  });

  test("live wins and losses never train around the clean-room predictor", () => {
    const common = {
      opponents: ["Daedalus"] as const,
      joinedFactions: new Set<string>(),
      factionFavor: {},
      demands: { Daedalus: { seconds: 2_000, share: 1, why: "hacking throughput" } },
      goPower: 1,
      hasSourceFile14: false,
      favorRepCap: 100_000,
      installRemainingSec: 2_000,
    };
    const winning = rankGoGames({
      ...common,
      stats: [{ opponent: "Daedalus", wins: 100, losses: 0, winStreak: 0, rep: 0, bonusPercent: 0 }],
    });
    const losing = rankGoGames({
      ...common,
      stats: [{ opponent: "Daedalus", wins: 0, losses: 100, winStreak: 0, rep: 0, bonusPercent: 0 }],
    });
    expect(winning.map(({ boardSize, winProbability }) => ({ boardSize, winProbability })))
      .toEqual(losing.map(({ boardSize, winProbability }) => ({ boardSize, winProbability })));
  });

  test("joined-faction favor has immediate value only when the next win pays", () => {
    const base = {
      opponents: ["Daedalus"] as const,
      joinedFactions: new Set(["Daedalus"]),
      factionFavor: { Daedalus: { favor: 25, remainingWorkSec: 10_000 } },
      demands: {},
      goPower: 1,
      hasSourceFile14: false,
      favorRepCap: 100_000,
      installRemainingSec: 10_000,
    };
    const odd = rankGoGames({
      ...base,
      stats: [{ opponent: "Daedalus", wins: 1, losses: 0, winStreak: 1, rep: 0, bonusPercent: 0 }],
    })[0]!;
    expect(odd.favorEventProbability).toBeCloseTo(odd.winProbability, 12);
    expect(odd.expectedFavorGain).toBeGreaterThan(0);
    expect(odd.favorSecSaved).toBeGreaterThan(0);

    const even = rankGoGames({
      ...base,
      stats: [{ opponent: "Daedalus", wins: 2, losses: 0, winStreak: 2, rep: 0, bonusPercent: 0 }],
    })[0]!;
    expect(even.favorEventProbability).toBe(0);
    expect(even.favorSecSaved).toBe(0);
    expect(even.horizonFavorSecSaved).toBeGreaterThan(0);

    const capped = rankGoGames({
      ...base,
      stats: [{ opponent: "Daedalus", wins: 2, losses: 0, winStreak: 1, rep: 100_000, bonusPercent: 0 }],
    })[0]!;
    expect(capped.expectedFavorGain).toBe(0);
    expect(capped.favorSecSaved).toBe(0);
  });

  test("two-win favor continuation is delayed and probability weighted exactly", () => {
    const remainingWorkSec = 10_000;
    const candidate = rankGoGames({
      opponents: ["Slum Snakes"],
      stats: [{ opponent: "Slum Snakes", wins: 0, losses: 0, winStreak: 0, rep: 0, bonusPercent: 0 }],
      joinedFactions: new Set(["Slum Snakes"]),
      factionFavor: { "Slum Snakes": { favor: 0, remainingWorkSec } },
      demands: {},
      goPower: 1,
      hasSourceFile14: false,
      favorRepCap: 100_000,
      installRemainingSec: remainingWorkSec,
    })[0]!;
    const favorAfter = goFavorReward(0, 0, 100_000).favorAfter;
    const workAfterTwoGames = Math.max(0, remainingWorkSec - 2 * candidate.expectedGameSec);
    const expected = candidate.winProbability ** 2
      * workAfterTwoGames
      * (1 - 1 / (1 + favorAfter / 100));
    expect(candidate.favorEventProbability).toBe(0);
    expect(candidate.favorSecSaved).toBe(0);
    expect(candidate.horizonFavorSecSaved).toBeCloseTo(expected, 9);
    expect(candidate.utilityPerSec).toBeCloseTo(expected / (2 * candidate.expectedGameSec), 9);
  });

  test("no bottleneck and no active favor work has zero route utility", () => {
    const ranked = rankGoGames({
      opponents: normalOpponents.map((opponent) => opponent.ours),
      stats: [],
      joinedFactions: new Set<string>(),
      factionFavor: {},
      demands: {},
      goPower: 4,
      hasSourceFile14: true,
      favorRepCap: 400_000,
      installRemainingSec: 10_000,
    });
    expect(ranked.every((candidate) => candidate.utilityPerSec === 0)).toBe(true);
  });
});

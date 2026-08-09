import { describe, expect, test } from "bun:test";
import { GO_REWARD_RULES, rankGoGames } from "../../shared/strategy/go/rewards.ts";
import { productionPolicy, simulateGoGameAsync } from "../features/go.ts";
import { oracleInitialBoard, oracleWhitePolicy } from "../features/go-oracle.ts";
import { GoOpponent } from "../vendor/bitburner/src/Go/Enums.ts";

const normalOpponents = [
  { oracle: GoOpponent.Netburners, ours: "Netburners", komi: 1.5 },
  { oracle: GoOpponent.SlumSnakes, ours: "Slum Snakes", komi: 3.5 },
  { oracle: GoOpponent.TheBlackHand, ours: "The Black Hand", komi: 3.5 },
  { oracle: GoOpponent.Tetrads, ours: "Tetrads", komi: 5.5 },
  { oracle: GoOpponent.Daedalus, ours: "Daedalus", komi: 5.5 },
  { oracle: GoOpponent.Illuminati, ours: "Illuminati", komi: 7.5 },
] as const;

describe("Go reward strategy tuning", () => {
  test("win/score priors stay aligned with upstream obstacle and faction-AI tournaments", async () => {
    const seeds = Array.from({ length: 24 }, (_, index) => 1_000 + index * 4_000);
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      for (const opponent of normalOpponents) {
      let wins = 0;
      let blackScore = 0;
      for (const seed of seeds) {
        const seedAtTurn = (turn: number) => seed + Math.floor(turn / 2) * 401;
        const game = await simulateGoGameAsync(
          productionPolicy({ opponent: opponent.ours, seedAtTurn }),
          oracleWhitePolicy(opponent.oracle, seedAtTurn),
          {
            size: 5,
            komi: opponent.komi,
            maxTurns: 100,
            initialBoard: oracleInitialBoard(5, opponent.oracle, seed),
          },
        );
        expect(game.completed).toBe(true);
        wins += Number(game.winner === "X");
        blackScore += game.score.X;
      }
      const rules = GO_REWARD_RULES[opponent.ours];
        expect(Math.abs(wins / seeds.length - rules.priorWinProbability), opponent.ours).toBeLessThan(0.03);
        expect(Math.abs(blackScore / seeds.length / 23 - rules.scoreFraction), opponent.ours).toBeLessThan(0.015);
      }
    } finally {
      Math.random = originalRandom;
    }
  }, 40_000);

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

  test("joined-faction favor has persistent value, exact streak odds, and an enforced cap", () => {
    const base = {
      opponents: ["Daedalus"] as const,
      joinedFactions: new Set(["Daedalus"]),
      factionFavor: { Daedalus: { favor: 25, remainingWorkSec: 0 } },
      demands: {},
      goPower: 1,
      hasSourceFile14: false,
      favorRepCap: 100_000,
    };
    const odd = rankGoGames({
      ...base,
      stats: [{ opponent: "Daedalus", wins: 1, losses: 0, winStreak: 1, rep: 0, bonusPercent: 0 }],
    })[0]!;
    expect(odd.favorEventProbability).toBeCloseTo(odd.winProbability, 12);
    expect(odd.expectedFavorGain).toBeGreaterThan(0);

    const even = rankGoGames({
      ...base,
      stats: [{ opponent: "Daedalus", wins: 2, losses: 0, winStreak: 2, rep: 0, bonusPercent: 0 }],
    })[0]!;
    expect(even.favorEventProbability).toBeCloseTo(even.winProbability ** 2, 12);

    const capped = rankGoGames({
      ...base,
      stats: [{ opponent: "Daedalus", wins: 2, losses: 0, winStreak: 1, rep: 100_000, bonusPercent: 0 }],
    })[0]!;
    expect(capped.expectedFavorGain).toBe(0);
    expect(capped.favorSecSaved).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import {
  oneSidedSignTest,
  pairedLower95,
  pairedPromotionEvidence,
  pairedRatioLower95,
  type PromotionGameMetric,
} from "../tools/go-promotion-statistics.ts";

function game(index: number, overrides: Partial<PromotionGameMetric> = {}): PromotionGameMetric {
  return {
    opponent: "????????????",
    seed: index * 200,
    handicapSeed: 10_000 + index,
    defenseSeed: 20_000 + index,
    completed: true,
    won: false,
    power: 5,
    turns: 10,
    blackScore: 10,
    whiteScore: 20,
    ...overrides,
  };
}

describe("paired Go promotion evidence", () => {
  test("the exact sign test counts only same-seed win flips", () => {
    expect(oneSidedSignTest(0, 0)).toBe(1);
    expect(oneSidedSignTest(5, 0)).toBeCloseTo(1 / 32, 12);
    expect(oneSidedSignTest(3, 2)).toBeCloseTo(0.5, 12);
    expect(oneSidedSignTest(2, 3)).toBe(1);
  });

  test("the paired lower bound rejects noisy means", () => {
    expect(pairedLower95([0.1, 0.1, 0.1, 0.1])).toBeCloseTo(0.1, 12);
    expect(pairedLower95([1, -1, 1, -1])).toBeLessThan(0);
    expect(pairedLower95([0.1])).toBe(Number.NEGATIVE_INFINITY);
  });

  test("the paired ratio bound uses total reward per total turn", () => {
    const incumbent = [
      { numerator: 10, denominator: 10 },
      { numerator: 90, denominator: 90 },
    ];
    const candidate = [
      { numerator: 12, denominator: 10 },
      { numerator: 108, denominator: 90 },
    ];
    const result = pairedRatioLower95(candidate, incumbent);
    expect(result.difference).toBeCloseTo(0.2, 12);
    expect(result.lower95).toBeCloseTo(0.2, 12);
    expect(pairedRatioLower95(candidate.slice(0, 1), incumbent.slice(0, 1)).lower95)
      .toBe(Number.NEGATIVE_INFINITY);
  });

  test("pairing is by opponent and all three seeds, not array position", () => {
    const incumbent = [game(1), game(2)];
    const candidate = [game(2), game(1)];
    expect(pairedPromotionEvidence("daemon19", candidate, incumbent).games).toBe(2);
    expect(() => pairedPromotionEvidence("daemon19", [game(1), game(3)], incumbent))
      .toThrow("no exact incumbent pair");
    expect(() => pairedPromotionEvidence("daemon19", [game(1, { completed: false }), game(2)], incumbent))
      .toThrow("incomplete game");
  });

  test("the apply minimum is per opponent and cannot be replaced by a lucky tiny screen", () => {
    const incumbent = Array.from({ length: 511 }, (_, index) => game(index));
    const candidate = incumbent.map((value) => ({ ...value, power: 6, blackScore: 12 }));
    const evidence = pairedPromotionEvidence("daemon19", candidate, incumbent);
    expect(evidence.criterion).toBe("powerPerTurn");
    expect(evidence.minimumSampleMet).toBe(false);
    expect(evidence.promotionGatePassed).toBe(false);
  });

  test("a promotion-size exact win tie uses total Power per total turn", () => {
    const incumbent = Array.from({ length: 512 }, (_, index) => game(index));
    const candidate = incumbent.map((value) => ({ ...value, power: 6, blackScore: 12 }));
    const evidence = pairedPromotionEvidence("daemon19", candidate, incumbent);
    expect(evidence.minimumSampleMet).toBe(true);
    expect(evidence.powerPerTurnDelta).toBeCloseTo(0.1, 12);
    expect(evidence.criterion).toBe("powerPerTurn");
    expect(evidence.promotionGatePassed).toBe(true);
  });

  test("more wins still require the exact paired sign test", () => {
    const incumbent = Array.from({ length: 512 }, (_, index) => game(index));
    const fourFlips = incumbent.map((value, index) => ({ ...value, won: index < 4 }));
    const fiveFlips = incumbent.map((value, index) => ({ ...value, won: index < 5 }));
    expect(pairedPromotionEvidence("daemon19", fourFlips, incumbent)).toMatchObject({
      oneSidedWinPValue: 0.0625,
      criterion: "none",
      promotionGatePassed: false,
    });
    const passing = pairedPromotionEvidence("daemon19", fiveFlips, incumbent);
    expect(passing).toMatchObject({
      criterion: "wins",
      promotionGatePassed: true,
    });
    expect(passing.oneSidedWinPValue).toBeCloseTo(0.03125, 12);
  });

  test("small5 cannot hide an undersampled opponent in the pooled total", () => {
    const opponents = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"];
    const counts = [2_048, 2_047, 2_049, 2_048, 2_048, 2_048];
    const incumbent = opponents.flatMap((opponent, opponentIndex) =>
      Array.from({ length: counts[opponentIndex]! }, (_, index) => game(index, {
        opponent,
        handicapSeed: opponentIndex * 100_000 + index,
        defenseSeed: opponentIndex * 100_000 + 50_000 + index,
      })));
    const candidate = incumbent.map((value) => ({ ...value, power: 6, blackScore: 12 }));
    const evidence = pairedPromotionEvidence("small5", candidate, incumbent);
    expect(evidence.games).toBe(12_288);
    expect(evidence.gamesPerOpponent["Slum Snakes"]).toBe(2_047);
    expect(evidence.minimumSampleMet).toBe(false);
    expect(evidence.promotionGatePassed).toBe(false);
  });

  test("fewer turns are positive only after an exact Power-per-turn tie", () => {
    const incumbent = Array.from({ length: 512 }, (_, index) => game(index, { power: 10, turns: 10 }));
    const candidate = incumbent.map((value) => ({ ...value, power: 9, turns: 9 }));
    const evidence = pairedPromotionEvidence("daemon19", candidate, incumbent);
    expect(evidence.powerPerTurnDelta).toBe(0);
    expect(evidence.fewerTurnsLower95).toBe(1);
    expect(evidence.criterion).toBe("fewerTurns");
    expect(evidence.promotionGatePassed).toBe(true);
  });

  test("matched-loss margin progress is diagnostic and cannot promote", () => {
    const incumbent = Array.from({ length: 512 }, (_, index) => game(index));
    const candidate = incumbent.map((value) => ({
      ...value,
      power: 4.5,
      blackScore: 9,
      whiteScore: 18,
      turns: 12,
    }));
    const evidence = pairedPromotionEvidence("daemon19", candidate, incumbent);
    expect(evidence.lossFloor.candidateCloser).toBe(512);
    expect(evidence.criterion).toBe("none");
    expect(evidence.promotionGatePassed).toBe(false);
  });
});

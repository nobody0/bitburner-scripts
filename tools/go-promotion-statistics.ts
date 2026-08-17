/** Paired evidence helpers for deterministic same-seed Go arenas. */

export type PromotionProfile = "small5" | "daemon19";

export interface PromotionGameMetric {
  opponent: string;
  seed: number;
  handicapSeed: number;
  defenseSeed: number | null;
  completed: boolean;
  won: boolean;
  /** Unscaled Black score, halved on a loss. */
  power: number;
  /** Total Black + White turns. */
  turns: number;
  blackScore: number;
  whiteScore: number;
}

export const MINIMUM_PROMOTION_GAMES_PER_OPPONENT: Readonly<Record<PromotionProfile, number>> = {
  small5: 2_048,
  daemon19: 512,
};

const EXPECTED_OPPONENTS: Readonly<Record<PromotionProfile, readonly string[]>> = {
  small5: ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"],
  daemon19: ["????????????"],
};

export interface PairedLossDiagnostics {
  /** Cases where both models lost; never a promotion criterion. */
  matchedLosses: number;
  candidateCloser: number;
  incumbentCloser: number;
  equalMargin: number;
  closerMarginSignPValue: number;
  meanScoreMarginDelta: number;
  scoreMarginLower95: number;
  powerPerTurnDelta: number;
  powerPerTurnLower95: number;
  fewerTurnsLower95: number;
}

export interface PairedOpponentEvidence {
  opponent: string;
  games: number;
  candidateWins: number;
  incumbentWins: number;
  favorableWinFlips: number;
  unfavorableWinFlips: number;
  oneSidedWinPValue: number;
  powerPerTurnDelta: number;
  powerPerTurnLower95: number;
  fewerTurnsLower95: number;
  lossFloor: PairedLossDiagnostics;
}

export interface PairedPromotionEvidence {
  games: number;
  gamesPerOpponent: Record<string, number>;
  minimumGamesPerOpponent: number;
  minimumSampleMet: boolean;
  candidateWins: number;
  incumbentWins: number;
  winDelta: number;
  favorableWinFlips: number;
  unfavorableWinFlips: number;
  oneSidedWinPValue: number;
  powerPerTurnDelta: number;
  powerPerTurnLower95: number;
  meanTurnsDelta: number;
  fewerTurnsLower95: number;
  /** True only when the sample minimum and the lexicographic evidence pass. */
  promotionGatePassed: boolean;
  criterion: "wins" | "powerPerTurn" | "fewerTurns" | "none";
  opponents: PairedOpponentEvidence[];
  /** Diagnostic only. It is deliberately excluded from promotionGatePassed. */
  lossFloor: PairedLossDiagnostics;
}

export function oneSidedSignTest(favorable: number, unfavorable: number): number {
  const discordant = favorable + unfavorable;
  if (!discordant || favorable <= unfavorable) return 1;
  let logProbability = -discordant * Math.log(2);
  for (let index = 1; index <= favorable; index++) {
    logProbability += Math.log(discordant - index + 1) - Math.log(index);
  }
  let maximum = logProbability;
  const terms = [logProbability];
  for (let wins = favorable + 1; wins <= discordant; wins++) {
    logProbability += Math.log(discordant - wins + 1) - Math.log(wins);
    terms.push(logProbability);
    maximum = Math.max(maximum, logProbability);
  }
  return Math.min(1, Math.exp(maximum)
    * terms.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
}

export function pairedLower95(values: number[]): number {
  if (values.length < 2) return Number.NEGATIVE_INFINITY;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / (values.length - 1);
  return mean - 1.96 * Math.sqrt(variance / values.length);
}

export function pairedRatioLower95(
  candidate: readonly { numerator: number; denominator: number }[],
  incumbent: readonly { numerator: number; denominator: number }[],
): { difference: number; lower95: number } {
  if (candidate.length !== incumbent.length || candidate.length < 2) {
    return { difference: Number.NaN, lower95: Number.NEGATIVE_INFINITY };
  }
  const totals = (values: readonly { numerator: number; denominator: number }[]) =>
    values.reduce((sum, value) => ({
      numerator: sum.numerator + value.numerator,
      denominator: sum.denominator + value.denominator,
    }), { numerator: 0, denominator: 0 });
  const candidateTotal = totals(candidate);
  const incumbentTotal = totals(incumbent);
  if (candidateTotal.denominator <= 0 || incumbentTotal.denominator <= 0) {
    return { difference: Number.NaN, lower95: Number.NEGATIVE_INFINITY };
  }
  const candidateRate = candidateTotal.numerator / candidateTotal.denominator;
  const incumbentRate = incumbentTotal.numerator / incumbentTotal.denominator;
  const candidateMeanDenominator = candidateTotal.denominator / candidate.length;
  const incumbentMeanDenominator = incumbentTotal.denominator / incumbent.length;
  const influences = candidate.map((value, index) => {
    const reference = incumbent[index]!;
    return (value.numerator - candidateRate * value.denominator)
      / candidateMeanDenominator
      - (reference.numerator - incumbentRate * reference.denominator)
      / incumbentMeanDenominator;
  });
  const influenceMean = influences.reduce((sum, value) => sum + value, 0) / influences.length;
  const variance = influences.reduce((sum, value) => sum + (value - influenceMean) ** 2, 0)
    / (influences.length - 1);
  const difference = candidateRate - incumbentRate;
  return {
    difference,
    lower95: difference - 1.96 * Math.sqrt(variance / influences.length),
  };
}

function gameKey(game: PromotionGameMetric): string {
  return JSON.stringify([
    game.opponent,
    game.seed,
    game.handicapSeed,
    game.defenseSeed,
  ]);
}

function pairGames(
  candidate: readonly PromotionGameMetric[],
  incumbent: readonly PromotionGameMetric[],
): { candidate: PromotionGameMetric; incumbent: PromotionGameMetric }[] {
  if (candidate.length !== incumbent.length) {
    throw new Error(`paired arenas have different game counts: ${candidate.length} and ${incumbent.length}`);
  }
  const index = new Map<string, PromotionGameMetric>();
  for (const game of incumbent) {
    const key = gameKey(game);
    if (index.has(key)) throw new Error(`incumbent arena contains duplicate game identity ${key}`);
    if (!game.completed) throw new Error(`incumbent arena contains incomplete game ${key}`);
    index.set(key, game);
  }
  const seen = new Set<string>();
  const pairs = candidate.map((game) => {
    const key = gameKey(game);
    if (seen.has(key)) throw new Error(`candidate arena contains duplicate game identity ${key}`);
    if (!game.completed) throw new Error(`candidate arena contains incomplete game ${key}`);
    seen.add(key);
    const reference = index.get(key);
    if (!reference) throw new Error(`candidate arena game has no exact incumbent pair ${key}`);
    return { candidate: game, incumbent: reference };
  });
  if (seen.size !== index.size) throw new Error("incumbent arena contains an unpaired game");
  return pairs;
}

function lossDiagnostics(
  pairs: readonly { candidate: PromotionGameMetric; incumbent: PromotionGameMetric }[],
): PairedLossDiagnostics {
  const losses = pairs.filter((pair) => !pair.candidate.won && !pair.incumbent.won);
  let candidateCloser = 0;
  let incumbentCloser = 0;
  let equalMargin = 0;
  const marginDifferences = losses.map((pair) => {
    const candidateMargin = pair.candidate.blackScore - pair.candidate.whiteScore;
    const incumbentMargin = pair.incumbent.blackScore - pair.incumbent.whiteScore;
    if (candidateMargin > incumbentMargin) candidateCloser++;
    else if (candidateMargin < incumbentMargin) incumbentCloser++;
    else equalMargin++;
    return candidateMargin - incumbentMargin;
  });
  const power = pairedRatioLower95(
    losses.map((pair) => ({ numerator: pair.candidate.power, denominator: pair.candidate.turns })),
    losses.map((pair) => ({ numerator: pair.incumbent.power, denominator: pair.incumbent.turns })),
  );
  return {
    matchedLosses: losses.length,
    candidateCloser,
    incumbentCloser,
    equalMargin,
    closerMarginSignPValue: oneSidedSignTest(candidateCloser, incumbentCloser),
    meanScoreMarginDelta: marginDifferences.length
      ? marginDifferences.reduce((sum, value) => sum + value, 0) / marginDifferences.length
      : Number.NaN,
    scoreMarginLower95: pairedLower95(marginDifferences),
    powerPerTurnDelta: power.difference,
    powerPerTurnLower95: power.lower95,
    fewerTurnsLower95: pairedLower95(losses.map((pair) =>
      pair.incumbent.turns - pair.candidate.turns)),
  };
}

function summarizePairs(
  opponent: string,
  pairs: readonly { candidate: PromotionGameMetric; incumbent: PromotionGameMetric }[],
): PairedOpponentEvidence {
  const favorable = pairs.filter((pair) => pair.candidate.won && !pair.incumbent.won).length;
  const unfavorable = pairs.filter((pair) => !pair.candidate.won && pair.incumbent.won).length;
  const power = pairedRatioLower95(
    pairs.map((pair) => ({ numerator: pair.candidate.power, denominator: pair.candidate.turns })),
    pairs.map((pair) => ({ numerator: pair.incumbent.power, denominator: pair.incumbent.turns })),
  );
  return {
    opponent,
    games: pairs.length,
    candidateWins: pairs.filter((pair) => pair.candidate.won).length,
    incumbentWins: pairs.filter((pair) => pair.incumbent.won).length,
    favorableWinFlips: favorable,
    unfavorableWinFlips: unfavorable,
    oneSidedWinPValue: oneSidedSignTest(favorable, unfavorable),
    powerPerTurnDelta: power.difference,
    powerPerTurnLower95: power.lower95,
    fewerTurnsLower95: pairedLower95(pairs.map((pair) =>
      pair.incumbent.turns - pair.candidate.turns)),
    lossFloor: lossDiagnostics(pairs),
  };
}

/** Evaluate the real lexicographic objective. Score-margin progress on matched
 * losses is returned separately and can never make this verdict pass. */
export function pairedPromotionEvidence(
  profile: PromotionProfile,
  candidate: readonly PromotionGameMetric[],
  incumbent: readonly PromotionGameMetric[],
): PairedPromotionEvidence {
  const pairs = pairGames(candidate, incumbent);
  const expected = EXPECTED_OPPONENTS[profile];
  const unexpected = [...new Set(pairs.map((pair) => pair.candidate.opponent))]
    .filter((opponent) => !expected.includes(opponent));
  if (unexpected.length) throw new Error(`arena contains unexpected opponent(s): ${unexpected.join(", ")}`);
  const gamesPerOpponent = Object.fromEntries(expected.map((opponent) => [
    opponent,
    pairs.filter((pair) => pair.candidate.opponent === opponent).length,
  ]));
  const minimumGamesPerOpponent = MINIMUM_PROMOTION_GAMES_PER_OPPONENT[profile];
  const minimumSampleMet = expected.every((opponent) =>
    gamesPerOpponent[opponent] === gamesPerOpponent[expected[0]!]
    && gamesPerOpponent[opponent]! >= minimumGamesPerOpponent);
  const candidateWins = pairs.filter((pair) => pair.candidate.won).length;
  const incumbentWins = pairs.filter((pair) => pair.incumbent.won).length;
  const favorable = pairs.filter((pair) => pair.candidate.won && !pair.incumbent.won).length;
  const unfavorable = pairs.filter((pair) => !pair.candidate.won && pair.incumbent.won).length;
  const winPValue = oneSidedSignTest(favorable, unfavorable);
  const power = pairedRatioLower95(
    pairs.map((pair) => ({ numerator: pair.candidate.power, denominator: pair.candidate.turns })),
    pairs.map((pair) => ({ numerator: pair.incumbent.power, denominator: pair.incumbent.turns })),
  );
  const meanTurnsDelta = pairs.length
    ? pairs.reduce((sum, pair) => sum + pair.candidate.turns - pair.incumbent.turns, 0) / pairs.length
    : Number.NaN;
  const fewerTurnsLower95 = pairedLower95(pairs.map((pair) =>
    pair.incumbent.turns - pair.candidate.turns));

  let criterion: PairedPromotionEvidence["criterion"] = "none";
  if (candidateWins > incumbentWins && winPValue <= 0.05) criterion = "wins";
  else if (candidateWins === incumbentWins && power.difference > 0 && power.lower95 > 0) {
    criterion = "powerPerTurn";
  } else if (candidateWins === incumbentWins && power.difference === 0 && fewerTurnsLower95 > 0) {
    criterion = "fewerTurns";
  }

  return {
    games: pairs.length,
    gamesPerOpponent,
    minimumGamesPerOpponent,
    minimumSampleMet,
    candidateWins,
    incumbentWins,
    winDelta: candidateWins - incumbentWins,
    favorableWinFlips: favorable,
    unfavorableWinFlips: unfavorable,
    oneSidedWinPValue: winPValue,
    powerPerTurnDelta: power.difference,
    powerPerTurnLower95: power.lower95,
    meanTurnsDelta,
    fewerTurnsLower95,
    promotionGatePassed: minimumSampleMet && criterion !== "none",
    criterion,
    opponents: expected.map((opponent) => summarizePairs(
      opponent,
      pairs.filter((pair) => pair.candidate.opponent === opponent),
    )),
    lossFloor: lossDiagnostics(pairs),
  };
}

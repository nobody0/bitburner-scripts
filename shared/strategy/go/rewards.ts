import type {
  GoFactionOpponent,
  GoObservedBoardSize,
  GoOpponentStat,
  GoRewardOpponent,
  GoSelectableBoardSize,
} from "./decide.ts";
import { addRepToFavor } from "../factions/rep.ts";

/** Two games cover the every-second-win favor cadence. Longer policy horizons
 * performed worse on held-out BN1 seeds. */
export const GO_PLANNING_GAMES_MAX = 2;

/** `bonusPower` and `komi` are v3.0.1 game data; the remaining fields are
 * simulator-fitted policy estimates as noted below.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/Constants.ts */
export const GO_REWARD_RULES: Readonly<Record<GoRewardOpponent, {
  bonusPower: number;
  komi: number;
  priorWinProbability: number;
  scoreFraction: number;
  aiSecondsPerPlayableNode: number;
}>> = {
  // Win/score priors are fitted by sim/tests/go-selection.test.ts against
  // upstream obstacles and faction AI. Runtime records never tune the policy:
  // they are outcomes, not an excuse to learn around an incomplete predictor.
  Netburners: { bonusPower: 1.3, komi: 1.5, priorWinProbability: 0.996, scoreFraction: 0.819, aiSecondsPerPlayableNode: 0.1923 },
  "Slum Snakes": { bonusPower: 1.2, komi: 3.5, priorWinProbability: 0.954, scoreFraction: 0.798, aiSecondsPerPlayableNode: 0.2845 },
  "The Black Hand": { bonusPower: 0.9, komi: 3.5, priorWinProbability: 0.922, scoreFraction: 0.719, aiSecondsPerPlayableNode: 0.3671 },
  Tetrads: { bonusPower: 0.7, komi: 5.5, priorWinProbability: 0.771, scoreFraction: 0.659, aiSecondsPerPlayableNode: 0.4147 },
  Daedalus: { bonusPower: 1.1, komi: 5.5, priorWinProbability: 0.838, scoreFraction: 0.676, aiSecondsPerPlayableNode: 0.3521 },
  Illuminati: { bonusPower: 0.7, komi: 7.5, priorWinProbability: 0.696, scoreFraction: 0.695, aiSecondsPerPlayableNode: 0.4055 },
  // 64-game exact-reply arena: 44/64 wins, 146.92 points and 127.12 s per
  // game. These are simulator priors; live W/L never tunes the policy.
  "????????????": { bonusPower: 2, komi: 9.5, priorWinProbability: 0.688, scoreFraction: 0.55, aiSecondsPerPlayableNode: 0.4761 },
};

/** End-to-end route estimates are deliberately separate from the descriptive
 * arena measurements above. Refitting selection to one 128-seed phase changed
 * a fixed BN1 route from 3,964.0 s to 4,355.3 s; even the final 1,024-game
 * measurements produced 3,993.3 s. These simulator-derived estimates retain
 * the independently validated route; live W/L influences neither table. */
const GO_SELECTION_PROFILE: Readonly<Record<GoRewardOpponent, {
  priorWinProbability: number;
  scoreFraction: number;
  aiSecondsPerPlayableNode: number;
}>> = {
  Netburners: { priorWinProbability: 1, scoreFraction: 0.844, aiSecondsPerPlayableNode: 0.1976 },
  "Slum Snakes": { priorWinProbability: 0.922, scoreFraction: 0.784, aiSecondsPerPlayableNode: 0.2940 },
  "The Black Hand": { priorWinProbability: 0.977, scoreFraction: 0.765, aiSecondsPerPlayableNode: 0.3697 },
  Tetrads: { priorWinProbability: 0.703, scoreFraction: 0.643, aiSecondsPerPlayableNode: 0.4309 },
  Daedalus: { priorWinProbability: 0.836, scoreFraction: 0.67, aiSecondsPerPlayableNode: 0.3681 },
  Illuminati: { priorWinProbability: 0.684, scoreFraction: 0.696, aiSecondsPerPlayableNode: 0.4051 },
  "????????????": { priorWinProbability: 0.688, scoreFraction: 0.55, aiSecondsPerPlayableNode: 0.4761 },
};

export interface GoEtaDemand {
  /** Remaining ETA component affected by this multiplier. */
  seconds: number;
  /** Fraction of that component actually supplied by the affected subsystem. */
  share: number;
  why: string;
}

export interface GoRewardView {
  opponents: readonly GoRewardOpponent[];
  stats: readonly GoOpponentStat[];
  joinedFactions: ReadonlySet<string>;
  /** Current favor and faction-work time that this persistent favor increase
   * can accelerate. Entries exist only for joined Go factions. */
  factionFavor: Partial<Record<GoFactionOpponent, { favor: number; remainingWorkSec: number }>>;
  demands: Partial<Record<GoRewardOpponent, GoEtaDemand>>;
  goPower: number;
  hasSourceFile14: boolean;
  favorRepCap: number;
  installRemainingSec: number;
}

export interface GoGameCandidate {
  opponent: GoRewardOpponent;
  /** Argument supplied to resetBoardState. The secret opponent ignores it. */
  boardSize: GoSelectableBoardSize;
  /** Board actually produced by the game. */
  observedBoardSize: GoSelectableBoardSize | 19;
  winProbability: number;
  expectedBlackScore: number;
  expectedGameSec: number;
  difficultyMultiplier: number;
  currentWinStreak: number;
  powerIfWin: number;
  powerIfLoss: number;
  expectedNodePower: number;
  multiplierBefore: number;
  multiplierAfter: number;
  transientDemand?: GoEtaDemand;
  transientSecSaved: number;
  favorEventProbability: number;
  favorBefore: number;
  favorAfter: number;
  favorRemainingWorkSec: number;
  /** Expected persistent favor points gained by this game. A two-win route is
   * represented in the bounded continuation fields instead. */
  expectedFavorGain: number;
  /** Faction-work seconds this game's possible favor event is expected to
   * save after the game settles. */
  favorSecSaved: number;
  totalSecSaved: number;
  utilityPerSec: number;
  /** Finite-horizon continuation used for selection, assuming we keep playing
   * this opponent until the install horizon or the bounded exact tree. */
  planningGames: number;
  horizonNodePower: number;
  horizonTransientSecSaved: number;
  horizonFavorSecSaved: number;
  why: string;
}

export function goDifficultyMultiplier(opponent: GoRewardOpponent, boardSize: number): number {
  if (opponent === "Illuminati" && boardSize === 5) return 8;
  return (GO_REWARD_RULES[opponent].komi + 0.5) * 0.25;
}

export function goStreakMultiplier(winStreak: number, previousWinStreak: number): number {
  if (winStreak < 0) return 0.5;
  if (previousWinStreak < 0 && winStreak > 0) return 1 + 0.5 * Math.min(-previousWinStreak, 8);
  return 1 + 0.25 * Math.min(winStreak, 8);
}

export function nextGoStreak(current: number, won: boolean): { current: number; previous: number } {
  if (won) return { previous: current, current: current < 0 ? 1 : current + 1 };
  return { previous: current, current: current >= 0 ? -1 : current - 1 };
}

export function goEffectMultiplier(
  nodePower: number,
  opponent: GoRewardOpponent,
  goPower: number,
  hasSourceFile14: boolean,
): number {
  const sourceFileBonus = hasSourceFile14 ? 2 : 1;
  const n = Math.max(0, nodePower) + 1;
  return 1 + Math.log(n) * Math.pow(n, 0.3) * 0.002
    * GO_REWARD_RULES[opponent].bonusPower * goPower * sourceFileBonus;
}

export function goFavorRepCap(sourceFile14Level: number): number {
  if (sourceFile14Level <= 0) return 100_000;
  if (sourceFile14Level === 1) return 200_000;
  if (sourceFile14Level === 2) return 300_000;
  return 400_000;
}

/** The API exposes only bonusPercent. The effect curve is monotonic, so raw
 * Node Power can be recovered without hidden state. */
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/effects/effect.ts
export function inferGoNodePower(
  bonusPercent: number,
  opponent: GoRewardOpponent,
  goPower: number,
  hasSourceFile14: boolean,
): number {
  const target = 1 + Math.max(0, bonusPercent) / 100;
  if (target <= 1) return 0;
  let lo = 0;
  let hi = 1;
  while (goEffectMultiplier(hi, opponent, goPower, hasSourceFile14) < target && hi < Number.MAX_SAFE_INTEGER / 2) {
    hi *= 2;
  }
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (goEffectMultiplier(mid, opponent, goPower, hasSourceFile14) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function simulatedWinProbability(opponent: GoRewardOpponent, size: number): number {
  const prior = GO_SELECTION_PROFILE[opponent].priorWinProbability;
  // Fixed komi becomes less important as area grows. These deltas are offline
  // simulator policy, never adapted from the live save's W/L record.
  const sizeShift = size <= 5 ? 0 : size <= 7 ? 0.04 : size <= 9 ? 0.07 : 0.1;
  return clamp01(prior + sizeShift);
}

function expectedPerformance(
  opponent: GoRewardOpponent,
  requestedSize: GoSelectableBoardSize,
  probability: number,
): { size: GoObservedBoardSize; expectedBlackScore: number; expectedGameSec: number } {
  const size: GoObservedBoardSize = opponent === "????????????" ? 19 : requestedSize;
  // The fixed BitVerse board has exactly 267 playable intersections; the
  // requested size is ignored for this opponent.
  const playable = size === 19 ? 267 : size * size * 0.92;
  const profile = GO_SELECTION_PROFILE[opponent];
  const expectedBlackScore = playable * clamp01(profile.scoreFraction + (probability - profile.priorWinProbability) * 0.25);
  // The arena measures exact upstream AI waits. A successful turn chains in a
  // microtask after that response; there is no controller-cadence tax between
  // black moves (only an observed seed-boundary crossing may pay 10 ms).
  const expectedGameSec = playable * profile.aiSecondsPerPlayableNode;
  return { size, expectedBlackScore, expectedGameSec };
}

function isFactionOpponent(opponent: GoRewardOpponent): opponent is GoFactionOpponent {
  return opponent !== "????????????";
}

function immediateFavorProbability(streak: number, winProbability: number): number {
  // Favor is awarded only after completing an even positive win streak. From
  // an odd streak this game can pay; from every other state it cannot. The
  // exact continuation tree below prices the two-win route without pretending
  // its reward arrives one game early.
  return streak > 0 && streak % 2 === 1 ? winProbability : 0;
}

interface HorizonState {
  probability: number;
  streak: number;
  power: number;
  favor: number;
  rep: number;
  /** Remaining faction reputation work in seconds at the initial favor rate. */
  favorWork: number;
}

function goHorizon(
  view: GoRewardView,
  opponent: GoRewardOpponent,
  performance: { expectedBlackScore: number; expectedGameSec: number },
  probability: number,
  stat: GoOpponentStat | undefined,
  difficulty: number,
  favorEligible: boolean,
  initialFavor: number,
): {
  games: number;
  nodePower: number;
  transientSecSaved: number;
  favorSecSaved: number;
} {
  const horizonSec = Math.max(performance.expectedGameSec, view.installRemainingSec);
  const games = Math.max(
    1,
    Math.min(GO_PLANNING_GAMES_MAX, Math.floor(horizonSec / performance.expectedGameSec)),
  );
  const initialPower = inferGoNodePower(stat?.bonusPercent ?? 0, opponent, view.goPower, view.hasSourceFile14);
  const faction = isFactionOpponent(opponent) ? view.factionFavor[opponent] : undefined;
  let states: HorizonState[] = [{
    probability: 1,
    streak: stat?.winStreak ?? 0,
    power: initialPower,
    favor: initialFavor,
    rep: stat?.rep ?? 0,
    favorWork: Math.max(0, faction?.remainingWorkSec ?? 0),
  }];
  const initialFavorRate = 1 + initialFavor / 100;
  for (let game = 0; game < games; game++) {
    const next: HorizonState[] = [];
    for (const state of states) {
      for (const won of [true, false]) {
        const branchProbability = state.probability * (won ? probability : 1 - probability);
        if (branchProbability === 0) continue;
        const streak = nextGoStreak(state.streak, won);
        const power = state.power + performance.expectedBlackScore * difficulty
          * goStreakMultiplier(streak.current, streak.previous);
        let favor = state.favor;
        let rep = state.rep;
        // Go and faction work run concurrently. Work completed before the game
        // settles uses the old favor; only the remaining farm benefits from a
        // favor reward earned at the end of this game.
        const favorRate = 1 + favor / 100;
        const favorWork = Math.max(
          0,
          state.favorWork - performance.expectedGameSec * favorRate / initialFavorRate,
        );
        if (won && favorEligible && streak.current > 0 && streak.current % 2 === 0 && rep < view.favorRepCap) {
          const reward = goFavorReward(favor, rep, view.favorRepCap);
          favor = reward.favorAfter;
          rep += reward.repGranted;
        }
        next.push({ probability: branchProbability, streak: streak.current, power, favor, rep, favorWork });
      }
    }
    states = next;
  }
  const expectedPower = states.reduce((sum, state) => sum + state.probability * state.power, 0);
  const expectedMultiplier = states.reduce((sum, state) => sum + state.probability
    * goEffectMultiplier(state.power, opponent, view.goPower, view.hasSourceFile14), 0);
  const multiplierBefore = 1 + Math.max(0, stat?.bonusPercent ?? 0) / 100;
  const demand = view.demands[opponent];
  const runway = Math.min(Math.max(0, demand?.seconds ?? 0), horizonSec);
  const transientSecSaved = demand
    ? runway * clamp01(demand.share) * Math.max(0, 1 - multiplierBefore / expectedMultiplier)
    : 0;
  const baselineFavorWork = Math.max(0, (faction?.remainingWorkSec ?? 0) - games * performance.expectedGameSec);
  const expectedFavorWork = states.reduce((sum, state) => {
    const relativeRate = (1 + state.favor / 100) / initialFavorRate;
    return sum + state.probability * state.favorWork / relativeRate;
  }, 0);
  const favorSecSaved = favorEligible ? Math.max(0, baselineFavorWork - expectedFavorWork) : 0;
  return {
    games,
    nodePower: Math.max(0, expectedPower - initialPower),
    transientSecSaved,
    favorSecSaved,
  };
}

/** Exact v3.0.1 conversion performed when a joined-faction opponent reaches
 * an even positive streak. `earnedRep` is the Go-specific cap counter, not
 * ordinary faction reputation. */
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/effects/effect.ts
export function goFavorReward(favor: number, earnedRep: number, maxRep: number): {
  repGranted: number;
  favorAfter: number;
  favorGain: number;
} {
  if (earnedRep >= maxRep) return { repGranted: 0, favorAfter: favor, favorGain: 0 };
  const repGranted = maxRep / 200;
  const favorAfter = addRepToFavor(favor, repGranted);
  return { repGranted, favorAfter, favorGain: Math.max(0, favorAfter - favor) };
}

export function rankGoGames(view: GoRewardView): GoGameCandidate[] {
  const stats = new Map(view.stats.map((stat) => [stat.opponent, stat]));
  const candidates: GoGameCandidate[] = [];
  for (const opponent of view.opponents) {
    // The upstream-AI policy tournament currently validates 5x5. Larger
    // ordinary boards cost substantially longer to finish and to plan, with
    // no measured win-rate evidence that compensates for the slower streak.
    // The secret opponent ignores this argument and still produces 19x19.
    const sizes: readonly GoSelectableBoardSize[] = [5];
    const stat = stats.get(opponent);
    for (const boardSize of sizes) {
      const winProbability = simulatedWinProbability(opponent, boardSize);
      const performance = expectedPerformance(opponent, boardSize, winProbability);
      const difficulty = goDifficultyMultiplier(opponent, performance.size);
      const currentStreak = stat?.winStreak ?? 0;
      const winStreak = nextGoStreak(currentStreak, true);
      const lossStreak = nextGoStreak(currentStreak, false);
      const powerIfWin = performance.expectedBlackScore * difficulty
        * goStreakMultiplier(winStreak.current, winStreak.previous);
      const powerIfLoss = performance.expectedBlackScore * difficulty
        * goStreakMultiplier(lossStreak.current, lossStreak.previous);
      const expectedNodePower = winProbability * powerIfWin + (1 - winProbability) * powerIfLoss;
      const multiplierBefore = 1 + Math.max(0, stat?.bonusPercent ?? 0) / 100;
      const currentPower = inferGoNodePower(
        stat?.bonusPercent ?? 0,
        opponent,
        view.goPower,
        view.hasSourceFile14,
      );
      const afterWin = goEffectMultiplier(currentPower + powerIfWin, opponent, view.goPower, view.hasSourceFile14);
      const afterLoss = goEffectMultiplier(currentPower + powerIfLoss, opponent, view.goPower, view.hasSourceFile14);
      const multiplierAfter = winProbability * afterWin + (1 - winProbability) * afterLoss;
      const demand = view.demands[opponent];
      const runway = Math.min(Math.max(0, demand?.seconds ?? 0), view.installRemainingSec);
      const transientSecSaved = demand
        ? runway * clamp01(demand.share) * Math.max(0, 1 - multiplierBefore / multiplierAfter)
        : 0;
      const faction = isFactionOpponent(opponent) ? view.factionFavor[opponent] : undefined;
      const favorEligible = isFactionOpponent(opponent)
        && view.joinedFactions.has(opponent)
        && faction !== undefined
        && (stat?.rep ?? 0) < view.favorRepCap;
      const favorEventProbability = favorEligible ? immediateFavorProbability(currentStreak, winProbability) : 0;
      const favorReward = favorEligible
        ? goFavorReward(faction.favor, stat?.rep ?? 0, view.favorRepCap)
        : { repGranted: 0, favorAfter: faction?.favor ?? 0, favorGain: 0 };
      const expectedFavorGain = favorEventProbability * favorReward.favorGain;
      const rateBefore = 1 + (faction?.favor ?? 0) / 100;
      const rateAfter = 1 + favorReward.favorAfter / 100;
      const favorSecSaved = favorEligible
        ? favorEventProbability
          * Math.max(0, faction.remainingWorkSec - performance.expectedGameSec)
          * Math.max(0, 1 - rateBefore / rateAfter)
        : 0;
      const totalSecSaved = transientSecSaved + favorSecSaved;
      const horizon = goHorizon(
        view,
        opponent,
        performance,
        winProbability,
        stat,
        difficulty,
        favorEligible,
        faction?.favor ?? 0,
      );
      // Receding-horizon control commits only the next game. Price that game's
      // exact marginal return at full weight, then add (without double-counting
      // it) the average continuation value of preserving/building the streak.
      const continuationSaved = Math.max(
        0,
        horizon.transientSecSaved + horizon.favorSecSaved - totalSecSaved,
      );
      const utilityPerSec = totalSecSaved / performance.expectedGameSec
        + continuationSaved / (horizon.games * performance.expectedGameSec);
      candidates.push({
        opponent,
        boardSize,
        observedBoardSize: performance.size,
        winProbability,
        expectedBlackScore: performance.expectedBlackScore,
        expectedGameSec: performance.expectedGameSec,
        difficultyMultiplier: difficulty,
        currentWinStreak: currentStreak,
        powerIfWin,
        powerIfLoss,
        expectedNodePower,
        multiplierBefore,
        multiplierAfter,
        ...(demand ? { transientDemand: demand } : {}),
        transientSecSaved,
        favorEventProbability,
        favorBefore: faction?.favor ?? 0,
        favorAfter: favorReward.favorAfter,
        favorRemainingWorkSec: faction?.remainingWorkSec ?? 0,
        expectedFavorGain,
        favorSecSaved,
        totalSecSaved,
        utilityPerSec,
        planningGames: horizon.games,
        horizonNodePower: horizon.nodePower,
        horizonTransientSecSaved: horizon.transientSecSaved,
        horizonFavorSecSaved: horizon.favorSecSaved,
        why: `${demand?.why ?? "no transient ETA component"}; ${favorEligible ? `${favorReward.repGranted} rep converted to favor on each even winning streak` : "no favor event value"}; exact ${horizon.games}-game streak tree`,
      });
    }
  }
  return candidates.sort((a, b) =>
    b.utilityPerSec - a.utilityPerSec
    || b.totalSecSaved - a.totalSecSaved
    || b.expectedFavorGain - a.expectedFavorGain
    || b.expectedNodePower / b.expectedGameSec - a.expectedNodePower / a.expectedGameSec
    || a.opponent.localeCompare(b.opponent)
    || a.boardSize - b.boardSize
  );
}

import {
  goObservedBoardSizeFor,
  type GoFactionOpponent,
  type GoObservedBoardSize,
  type GoOpponentStat,
  type GoRewardOpponent,
  type GoSelectableBoardSize,
} from "./rules.ts";
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
  /** What the deployed runtime wins, which is what a value estimate needs.
   * For the three opponents the controller routes to a certified start
   * (GO_PLAYBOOK_OPPONENTS) that is the certified line's rate, because a route
   * exists from every phase and every wait fits the cap; for the rest it is
   * the network's own rate with mid-game playbook lookups. */
  priorWinProbability: number;
  /** The same measurement with the playbook disabled. Not used for value: it
   * exists so a regression in the network alone stays visible behind a
   * playbook that would otherwise mask it. */
  neuralBaselineWinProbability: number;
  scoreFraction: number;
  aiSecondsPerPlayableNode: number;
}>> = {
  // Runtime records never tune the policy: they are outcomes, not an excuse to
  // learn around an incomplete predictor.
  //
  // Win probabilities refit 2026-08-18 from one 3,072-game combined arena
  // (512 per opponent, start phase 118301, stride 41213, defense seed
  // 20260819) against the deployed runtime. The previous values predated the
  // playbook entirely and priced Illuminati at a coin flip while the shipped
  // runtime wins 98.6% of its games, so the controller was systematically
  // avoiding the opponent its certified lines had made safest.
  //
  // scoreFraction and aiSecondsPerPlayableNode remain the 2026-08-14 fit (tie
  // roll 0.5, seed start 123456, 128 games per opponent and 512 for
  // Illuminati), divided by the 5x5 arena's 23 expected playable
  // intersections. They are conservative for a stronger policy, and refitting
  // them needs per-game scores and durations the combined arena does not yet
  // record.
  Netburners: { bonusPower: 1.3, komi: 1.5, priorWinProbability: 1.0, neuralBaselineWinProbability: 0.998047, scoreFraction: 0.673573, aiSecondsPerPlayableNode: 0.200815 },
  "Slum Snakes": { bonusPower: 1.2, komi: 3.5, priorWinProbability: 1.0, neuralBaselineWinProbability: 0.998047, scoreFraction: 0.688179, aiSecondsPerPlayableNode: 0.296807 },
  "The Black Hand": { bonusPower: 0.9, komi: 3.5, priorWinProbability: 0.990234, neuralBaselineWinProbability: 0.990234, scoreFraction: 0.649796, aiSecondsPerPlayableNode: 0.394022 },
  Tetrads: { bonusPower: 0.7, komi: 5.5, priorWinProbability: 1.0, neuralBaselineWinProbability: 0.951172, scoreFraction: 0.582201, aiSecondsPerPlayableNode: 0.507405 },
  Daedalus: { bonusPower: 1.1, komi: 5.5, priorWinProbability: 1.0, neuralBaselineWinProbability: 0.957031, scoreFraction: 0.598166, aiSecondsPerPlayableNode: 0.407065 },
  Illuminati: { bonusPower: 0.7, komi: 7.5, priorWinProbability: 0.986328, neuralBaselineWinProbability: 0.710938, scoreFraction: 0.389946, aiSecondsPerPlayableNode: 0.588043 },
  // The daemon win prior pools the promoted checkpoint's two independent
  // 128-game gates (12 + 21 wins). Score and duration come from the much more
  // expensive four-game deployed TypeScript arena sample.
  // The daemon has no playbook, so both numbers are the same measurement:
  // 264/304 pooled over the strip-derivative install arena and two seed-wait
  // control arms, 2026-08-17/18. The old 0.129 came from two 128-game gates of
  // a superseded checkpoint.
  "????????????": { bonusPower: 2, komi: 9.5, priorWinProbability: 0.868421, neuralBaselineWinProbability: 0.868421, scoreFraction: 0.408, aiSecondsPerPlayableNode: 0.596 },
};

export interface GoEtaDemand {
  /** Remaining ETA component affected by this multiplier. UNSHARED: the
   * consumer clips this against the install horizon and only THEN applies
   * `share`, which is what stops accumulated evidence from crediting a small
   * producer with the whole runway. */
  seconds: number;
  /** Fraction of that component actually supplied by the affected subsystem. */
  share: number;
  /** Ceiling on the relative saving this reward can deliver however large the
   * multiplier grows, in the same units as `1 - before/after`. Exact rather
   * than an approximation where it is set: crime money is proportional to
   * `min(1, chance * multiplier)`, so at chance c the saving can never exceed
   * `1 - c` — a +5% success multiplier on a 99%-success crime buys +1.01%
   * money, not +5%, and buys exactly nothing at chance 1. Absent = the reward
   * lifts something with no ceiling in reach. */
  gainCap?: number;
}

/** The relative saving one game's multiplier growth actually delivers.
 * ONE implementation for the immediate game and the horizon tree: they priced
 * the identical quantity, and a cap applied to only one of them would rank
 * candidates on a saving the continuation then contradicts. */
function demandGain(demand: GoEtaDemand, before: number, after: number): number {
  return Math.min(Math.max(0, 1 - before / after), Math.max(0, demand.gainCap ?? 1));
}

export interface GoRewardView {
  opponents: readonly GoRewardOpponent[];
  stats: readonly GoOpponentStat[];
  joinedFactions: ReadonlySet<string>;
  /** Current favor and faction-work time that this persistent favor increase
   * can accelerate. Entries exist only for joined Go factions.
   * `remainingWorkSec` spans the remaining NODE (favor persists through
   * installs). `pointValue` adds the one-time donation-gate value: seconds
   * saved if favor crosses `donateThreshold`, from the factions layer's
   * favorValue model. */
  factionFavor: Partial<Record<GoFactionOpponent, {
    favor: number;
    remainingWorkSec: number;
    pointValue?: { donationUnlockSec: number; donateThreshold: number };
  }>>;
  demands: Partial<Record<GoRewardOpponent, GoEtaDemand>>;
  goPower: number;
  hasSourceFile14: boolean;
  favorRepCap: number;
  installRemainingSec: number;
  /** Certified playbook entry windows measured by the driver at planning
   * time (worker `playbookRoute`). Present only for opponents whose aligned
   * start is worth offering: within the per-opponent wait cap, phase clock
   * anchored, and cheats locked (certified lines are unreachable in cheat
   * games). Absent entry ⇒ the opponent plays unaligned only. */
  playbookEntries?: Partial<Record<GoRewardOpponent, { waitSec: number; entryPlaytime: number }>>;
}

export interface GoGameCandidate {
  opponent: GoRewardOpponent;
  /** Argument supplied to resetBoardState. The secret opponent ignores it. */
  boardSize: GoSelectableBoardSize;
  /** Board actually produced by the game. */
  observedBoardSize: GoSelectableBoardSize | 19;
  /** True for the phase-aligned certified-playbook variant of an opponent;
   * such a candidate pays `waitSec` before its game and wins at the routed
   * probability. The unaligned variant of the same opponent starts now. */
  aligned: boolean;
  /** Seconds until the certified entry phase (0 for unaligned candidates). */
  waitSec: number;
  /** Engine playtime of the certified entry tick, passed through so the
   * driver can commit the aligned start without a second route lookup. */
  entryPlaytime?: number;
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

function nextGoStreak(current: number, won: boolean): { current: number; previous: number } {
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

function simulatedWinProbability(opponent: GoRewardOpponent, size: number, prior: number): number {
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
  const size: GoObservedBoardSize = goObservedBoardSizeFor(opponent, requestedSize);
  // The fixed BitVerse board has exactly 267 playable intersections; the
  // requested size is ignored for this opponent.
  const playable = size === 19 ? 267 : size * size * 0.92;
  const profile = GO_REWARD_RULES[opponent];
  const expectedBlackScore = playable * clamp01(profile.scoreFraction + (probability - profile.priorWinProbability) * 0.25);
  // The arena measures exact upstream AI waits. Successful turns chain without
  // adding the controller's ordinary feature cadence between black moves.
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
  /** One-time donation-gate seconds banked when favor crossed the threshold
   * on this branch. */
  unlockSaved: number;
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
  /** Seconds spent waiting for the certified entry phase before game one. */
  waitSec: number,
): {
  games: number;
  nodePower: number;
  transientSecSaved: number;
  favorSecSaved: number;
} {
  const firstGameSec = waitSec + performance.expectedGameSec;
  const horizonSec = Math.max(firstGameSec, view.installRemainingSec);
  const games = Math.max(
    1,
    Math.min(GO_PLANNING_GAMES_MAX, Math.floor((horizonSec - waitSec) / performance.expectedGameSec)),
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
    unlockSaved: 0,
  }];
  const initialFavorRate = 1 + initialFavor / 100;
  for (let game = 0; game < games; game++) {
    // The first game settles only after the alignment wait; faction work
    // farms through the wait at the old favor rate.
    const gameElapsedSec = (game === 0 ? waitSec : 0) + performance.expectedGameSec;
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
          state.favorWork - gameElapsedSec * favorRate / initialFavorRate,
        );
        let unlockSaved = state.unlockSaved;
        if (won && favorEligible && streak.current > 0 && streak.current % 2 === 0 && rep < view.favorRepCap) {
          const reward = goFavorReward(favor, rep, view.favorRepCap);
          const threshold = faction?.pointValue?.donateThreshold;
          if (threshold !== undefined && favor < threshold && reward.favorAfter >= threshold) {
            unlockSaved += faction?.pointValue?.donationUnlockSec ?? 0;
          }
          favor = reward.favorAfter;
          rep += reward.repGranted;
        }
        next.push({ probability: branchProbability, streak: streak.current, power, favor, rep, favorWork, unlockSaved });
      }
    }
    states = next;
  }
  const expectedPower = states.reduce((sum, state) => sum + state.probability * state.power, 0);
  const expectedMultiplier = states.reduce((sum, state) => sum + state.probability
    * goEffectMultiplier(state.power, opponent, view.goPower, view.hasSourceFile14), 0);
  const multiplierBefore = 1 + Math.max(0, stat?.bonusPercent ?? 0) / 100;
  const demand = view.demands[opponent];
  // Bounded by the horizon minus the wait only — see the runway comment in
  // rankGoGames: the deadline is a recalibrating estimate, not a wall.
  const runway = Math.min(Math.max(0, demand?.seconds ?? 0), Math.max(0, horizonSec - waitSec));
  const transientSecSaved = demand
    ? runway * clamp01(demand.share) * demandGain(demand, multiplierBefore, expectedMultiplier)
    : 0;
  const baselineFavorWork = Math.max(0, (faction?.remainingWorkSec ?? 0) - waitSec - games * performance.expectedGameSec);
  const expectedFavorWork = states.reduce((sum, state) => {
    const relativeRate = (1 + state.favor / 100) / initialFavorRate;
    return sum + state.probability * state.favorWork / relativeRate;
  }, 0);
  const expectedUnlockSaved = states.reduce((sum, state) => sum + state.probability * state.unlockSaved, 0);
  const favorSecSaved = favorEligible
    ? Math.max(0, baselineFavorWork - expectedFavorWork) + expectedUnlockSaved
    : 0;
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
      // An opponent with a certified entry window is offered TWICE: the
      // aligned variant pays its wait and wins at the routed probability; the
      // unaligned variant starts now at the neural prior. Pricing the wait
      // inside utilityPerSec is what lets a slightly weaker opponent that is
      // available immediately beat a stronger one behind a long window.
      //
      // An entry exists only for the opponents the controller routes, and for
      // exactly those `priorWinProbability` IS the certified line's rate — so
      // the aligned variant takes it and the unaligned variant falls back to
      // the playbook-disabled network rate. For every other opponent the prior
      // already describes the only way it is ever played.
      const entry = boardSize === 5 ? view.playbookEntries?.[opponent] : undefined;
      const rules = GO_REWARD_RULES[opponent];
      const unroutedPrior = entry !== undefined
        ? rules.neuralBaselineWinProbability
        : rules.priorWinProbability;
      const variants: { aligned: boolean; waitSec: number; entryPlaytime?: number; winProbability: number }[] = [
        { aligned: false, waitSec: 0, winProbability: simulatedWinProbability(opponent, boardSize, unroutedPrior) },
      ];
      if (entry !== undefined) {
        variants.push({
          aligned: true,
          waitSec: Math.max(0, entry.waitSec),
          entryPlaytime: entry.entryPlaytime,
          winProbability: clamp01(rules.priorWinProbability),
        });
      }
      for (const variant of variants) {
      const winProbability = variant.winProbability;
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
      // The runway is bounded by the remaining install/node forecast MINUS the
      // alignment wait, and deliberately NOT minus the game's own duration:
      // the deadline is an estimate that recalibrates (often optimistic near
      // the end), and treating it as a hard wall zeroed every candidate and
      // idled Go for as long as the forecast stayed short. Long games still
      // lose fairly — utilityPerSec divides by their full duration.
      const runway = Math.min(
        Math.max(0, demand?.seconds ?? 0),
        Math.max(0, view.installRemainingSec - variant.waitSec),
      );
      const transientSecSaved = demand
        ? runway * clamp01(demand.share) * demandGain(demand, multiplierBefore, multiplierAfter)
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
      const firstGameSec = variant.waitSec + performance.expectedGameSec;
      // One-time donation-gate value when this game's possible favor event
      // pushes the faction across the donation threshold.
      const crossingSaved = favorEligible
        && faction.pointValue !== undefined
        && faction.favor < faction.pointValue.donateThreshold
        && favorReward.favorAfter >= faction.pointValue.donateThreshold
        ? faction.pointValue.donationUnlockSec
        : 0;
      const favorSecSaved = favorEligible
        ? favorEventProbability
          * (Math.max(0, faction.remainingWorkSec - firstGameSec)
            * Math.max(0, 1 - rateBefore / rateAfter)
            + crossingSaved)
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
        variant.waitSec,
      );
      // Rank by the AVERAGE saving rate over the candidate's whole planning
      // tree, not the first game's instantaneous rate. Power per second is
      // roughly board-size-invariant (score and duration both scale with
      // area), but the effect curve is logarithmic — so a short game's
      // first-game rate cannot be sustained by chaining, and pricing it as if
      // it could made six diminishing 27s games look ~6x better than one
      // thick 159s game that actually delivers its saving. The tree already
      // contains each candidate's own diminishing tail; dividing by the full
      // tree duration (wait charged once) compares them honestly.
      const continuationSaved = Math.max(
        0,
        horizon.transientSecSaved + horizon.favorSecSaved - totalSecSaved,
      );
      const utilityPerSec = (totalSecSaved + continuationSaved)
        / (variant.waitSec + horizon.games * performance.expectedGameSec);
      candidates.push({
        opponent,
        boardSize,
        observedBoardSize: performance.size,
        aligned: variant.aligned,
        waitSec: variant.waitSec,
        ...(variant.entryPlaytime !== undefined ? { entryPlaytime: variant.entryPlaytime } : {}),
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
      });
      }
    }
  }
  return candidates.sort((a, b) =>
    b.utilityPerSec - a.utilityPerSec
    || b.totalSecSaved - a.totalSecSaved
    || b.expectedFavorGain - a.expectedFavorGain
    || b.expectedNodePower / b.expectedGameSec - a.expectedNodePower / a.expectedGameSec
    || a.waitSec - b.waitSec
    || Number(b.aligned) - Number(a.aligned)
    || a.opponent.localeCompare(b.opponent)
    || a.boardSize - b.boardSize
  );
}

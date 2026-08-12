import type { GoRewardOpponent } from "./decide.ts";

// Frozen compatibility subset used by decide.ts. These functions are copied
// from shared/strategy/go/rewards.ts at the snapshot recorded in SOURCE.md.
// They describe the old teacher's internal heuristic only; learner targets do
// not contain streak state.
const KOMI: Readonly<Record<GoRewardOpponent, number>> = {
  Netburners: 1.5,
  "Slum Snakes": 3.5,
  "The Black Hand": 3.5,
  Tetrads: 5.5,
  Daedalus: 5.5,
  Illuminati: 7.5,
  "????????????": 9.5,
};

export function goDifficultyMultiplier(opponent: GoRewardOpponent, boardSize: number): number {
  if (opponent === "Illuminati" && boardSize === 5) return 8;
  return (KOMI[opponent] + 0.5) * 0.25;
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

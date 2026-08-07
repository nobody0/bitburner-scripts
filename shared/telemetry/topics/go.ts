/** Go (IPvGO) feature — BN14's theme. Problem: a board game. Maximise
 * territory captured per game against each faction opponent, since win streaks
 * grant escalating stat/hacking bonuses. The most self-contained feature in
 * the game: a pure adversarial search with no coupling to anything else. */

export interface GoOpponentStats {
  opponent: string;
  wins: number;
  losses: number;
  winStreak: number;
  highestWinStreak: number;
  rep: number;
  bonusPercent: number;
  bonusDescription: string;
}

export interface GoState {
  /** "gameOver" | "waitingOnAI" | "inProgress" plus the board metadata. */
  status: string;
  currentPlayer: string;
  opponent: string;
  boardSize?: number;
  /** Row strings exactly as ns.go.getBoardState returns them. Small: at most
   * 19 strings of 19 chars. */
  board?: string[];
  whiteScore?: number;
  blackScore?: number;
  moveCount?: number;
  /** Controlled empty territory per colour, from ns.go.analysis. */
  territory?: { black: number; white: number };
  stats: GoOpponentStats[];
}

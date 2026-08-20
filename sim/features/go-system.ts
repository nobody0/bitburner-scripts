import type { Play, BoardState, SimpleOpponentStats } from "../vendor/bitburner/src/Go/Types.ts";
import type { SimWorld } from "../world.ts";
import type { FactionSystem } from "./factions.ts";
import { GoColor, GoOpponent, GoPlayType } from "../vendor/bitburner/src/Go/Enums.ts";
import { getMove } from "../vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import {
  getControlledSpace,
  getPreviousMove,
  simpleBoardFromBoard,
  simpleBoardFromBoardString,
} from "../vendor/bitburner/src/Go/boardAnalysis/boardAnalysis.ts";
import { getScore } from "../vendor/bitburner/src/Go/boardAnalysis/ScoringOracle.ts";
import { getNewBoardState, makeMove, passTurn, updateCaptures } from "../vendor/bitburner/src/Go/boardState/boardState.ts";
import { whrng } from "../../shared/strategy/go/rng.ts";
import { Go, Player as GoPlayer, sleepLog } from "../vendor/bitburner/src/Go/OracleStubs.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import {
  GO_REWARD_RULES,
  goDifficultyMultiplier,
  goEffectMultiplier,
  goFavorRepCap,
  goFavorReward,
  goStreakMultiplier,
} from "../../shared/strategy/go/rewards.ts";
import { GO_EFFECT_FIELDS, type GoRewardOpponent } from "../../shared/strategy/go/rules.ts";

type RewardOpponent = Exclude<GoOpponent, GoOpponent.none>;
export type GoSystemMode = "exact" | "aggregate";

interface SimGoOpponentStats {
  wins: number;
  losses: number;
  nodes: number;
  nodePower: number;
  winStreak: number;
  oldWinStreak: number;
  highestWinStreak: number;
  rep: number;
}

const BONUS_DESCRIPTION: Readonly<Record<RewardOpponent, string>> = {
  [GoOpponent.Netburners]: "increased hacknet production",
  [GoOpponent.SlumSnakes]: "crime success rate",
  [GoOpponent.TheBlackHand]: "hacking money",
  [GoOpponent.Tetrads]: "strength, defense, dexterity, and agility levels",
  [GoOpponent.Daedalus]: "reputation gain",
  [GoOpponent.Illuminati]: "faster hack(), grow(), and weaken()",
  [GoOpponent.w0r1d_d43m0n]: "hacking level",
};

const REWARD_OPPONENTS = Object.values(GoOpponent)
  .filter((opponent): opponent is RewardOpponent => opponent !== GoOpponent.none);

function freshStats(): SimGoOpponentStats {
  return {
    wins: 0,
    losses: 0,
    nodes: 0,
    nodePower: 0,
    winStreak: 0,
    oldWinStreak: 0,
    highestWinStreak: 0,
    rep: 0,
  };
}

function isRewardOpponent(value: string): value is RewardOpponent {
  return REWARD_OPPONENTS.includes(value as RewardOpponent);
}

/** Virtual-time IPvGO lifecycle using the vendored v3.0.1 board and AI. Reward
 * formulas are shared with the deployed strategy and parity-tested upstream. */
export class GoSystem {
  readonly stats = new Map<RewardOpponent, SimGoOpponentStats>();
  storedCycles = 0;

  #world: SimWorld;
  #factions: FactionSystem;
  #state: BoardState;
  #pending: Promise<Play> | undefined;
  #lastResponse: Play = { type: GoPlayType.gameOver, x: null, y: null };
  #settled = false;
  #appliedEffects = new Map<RewardOpponent, number>();
  #random: () => number;
  #mode: GoSystemMode;
  #requestedSize = 7;
  #aggregateScore: { black: number; white: number } | undefined;

  constructor(world: SimWorld, factions: FactionSystem, random: () => number, mode: GoSystemMode = "exact") {
    this.#world = world;
    this.#factions = factions;
    this.#random = random;
    this.#mode = mode;
    // Upstream starts with a plain 7x7 Netburners game.
    this.#state = getNewBoardState(7, GoOpponent.Netburners, false);
    this.#world.onMultipliersReset.push(() => this.reapplyEffectsAfterMultiplierReset());
    this.#activate();
  }

  get boardState(): BoardState {
    return this.#state;
  }

  getBoardState(): string[] {
    this.#activate();
    return [...simpleBoardFromBoard(this.#state.board)];
  }

  getMoveHistory(): string[][] {
    return this.#state.previousBoards.map((board) => [...simpleBoardFromBoardString(board)]);
  }

  getOpponent(): GoOpponent {
    return this.#state.ai;
  }

  getCurrentPlayer(): "White" | "Black" | "None" {
    if (this.#aggregateScore) return "None";
    if (this.#state.previousPlayer === null) return "None";
    return this.#state.previousPlayer === GoColor.black ? "White" : "Black";
  }

  getGameState(): {
    currentPlayer: "White" | "Black" | "None";
    whiteScore: number;
    blackScore: number;
    previousMove: [number, number] | null;
    komi: number;
    bonusCycles: number;
  } {
    this.#activate();
    const score = getScore(this.#state);
    return {
      currentPlayer: this.getCurrentPlayer(),
      whiteScore: this.#aggregateScore?.white ?? score[GoColor.white].sum,
      blackScore: this.#aggregateScore?.black ?? score[GoColor.black].sum,
      previousMove: getPreviousMove(),
      komi: score[GoColor.white].komi,
      bonusCycles: this.storedCycles,
    };
  }

  getStats(): Partial<Record<RewardOpponent, SimpleOpponentStats>> {
    const result: Partial<Record<RewardOpponent, SimpleOpponentStats>> = {};
    for (const [opponent, stats] of this.stats) {
      result[opponent] = {
        wins: stats.wins,
        losses: stats.losses,
        winStreak: stats.winStreak,
        highestWinStreak: stats.highestWinStreak,
        rep: stats.rep,
        bonusPercent: (this.#effect(opponent, stats.nodePower) - 1) * 100,
        bonusDescription: BONUS_DESCRIPTION[opponent],
      };
    }
    return result;
  }

  getControlledEmptyNodes(): string[] {
    const controlled = getControlledSpace(this.#state.board);
    return controlled.map((column, x) => column.reduce((row, owner, y) => {
      if (owner === GoColor.white) return row + "O";
      if (owner === GoColor.black) return row + "X";
      const point = this.#state.board[x]![y];
      if (!point) return row + "#";
      return row + (point.color === GoColor.empty ? "?" : ".");
    }, ""));
  }

  resetBoardState(opponentValue: string, boardSize: number): string[] {
    if (!isRewardOpponent(opponentValue)) throw new Error(`Invalid Go opponent ${opponentValue}`);
    if (![5, 7, 9, 13].includes(boardSize) && opponentValue !== GoOpponent.w0r1d_d43m0n) {
      throw new Error(`Invalid subnet size requested (${boardSize}), size must be 5, 7, 9, or 13`);
    }
    if (
      opponentValue === GoOpponent.w0r1d_d43m0n
      && !this.#world.player.hasAugmentation("The Red Pill", true)
    ) {
      throw new Error(`Invalid opponent requested (${opponentValue}), this opponent has not yet been discovered`);
    }
    if (!this.#settled && this.#state.previousPlayer !== null && this.#state.previousBoards.length) {
      this.#recordLoss(this.#state.ai as RewardOpponent, false);
    }
    GoPlayer.totalPlaytime = this.#world.clock.now();
    const originalRandom = Math.random;
    Math.random = () => this.#random();
    try {
      this.#state = getNewBoardState(boardSize, opponentValue, true);
    } finally {
      Math.random = originalRandom;
    }
    this.#pending = undefined;
    this.#requestedSize = boardSize;
    this.#aggregateScore = undefined;
    this.#lastResponse = { type: GoPlayType.gameOver, x: null, y: null };
    this.#settled = false;
    this.#activate();
    return this.getBoardState();
  }

  makeMove(x: number, y: number): Promise<Play> {
    this.#requireTurn(GoColor.black);
    this.#activate();
    if (!makeMove(this.#state, x, y, GoColor.black)) throw new Error(`Invalid Go move ${x},${y}`);
    return this.#mode === "aggregate" ? this.#startAggregateCompletion() : this.#startOpponentTurn();
  }

  passTurn(): Promise<Play> {
    this.#requireTurn(GoColor.black);
    this.#activate();
    passTurn(this.#state, GoColor.black);
    if (this.#mode === "exact" && this.#state.previousPlayer === null) {
      this.#settleGame();
      this.#lastResponse = { type: GoPlayType.gameOver, x: null, y: null };
      return Promise.resolve(this.#lastResponse);
    }
    return this.#mode === "aggregate" ? this.#startAggregateCompletion() : this.#startOpponentTurn();
  }

  getCheatCount(): number {
    this.#requireCheatAccess();
    return this.#state.cheatCount;
  }

  getCheatSuccessChance(count = this.#state.cheatCount): number {
    this.#requireCheatAccess();
    const sf14 = this.#world.player.sourceFiles["14"] ?? 0;
    const sourceFileBonus = sf14 === 3 ? 0.25 : 0;
    const scalar = (0.7 - 0.02 * count) ** count;
    return Math.max(0, Math.min(1,
      0.6 * scalar * (this.#world.person.mults.crime_success ?? 1) + sourceFileBonus));
  }

  removeRouter(x: number, y: number): Promise<Play> {
    const point = this.#state.board[x]?.[y];
    if (!point || point.color === GoColor.empty) throw new Error(`Invalid cheat router ${x},${y}`);
    return this.#cheat(() => { point.color = GoColor.empty; });
  }

  playTwoMoves(x1: number, y1: number, x2: number, y2: number): Promise<Play> {
    const first = this.#state.board[x1]?.[y1];
    const second = this.#state.board[x2]?.[y2];
    if (!first || !second || first.color !== GoColor.empty || second.color !== GoColor.empty) {
      throw new Error(`Invalid double cheat ${x1},${y1} ${x2},${y2}`);
    }
    return this.#cheat(() => {
      first.color = GoColor.black;
      second.color = GoColor.black;
    });
  }

  repairOfflineNode(x: number, y: number): Promise<Play> {
    if (this.#state.board[x]?.[y]) throw new Error(`Invalid repair cheat ${x},${y}`);
    return this.#cheat(() => {
      this.#state.board[x]![y] = { chain: "", liberties: null, x, y, color: GoColor.empty };
    });
  }

  destroyNode(x: number, y: number): Promise<Play> {
    const point = this.#state.board[x]?.[y];
    if (!point || point.color !== GoColor.empty) throw new Error(`Invalid destroy cheat ${x},${y}`);
    return this.#cheat(() => { this.#state.board[x]![y] = null; });
  }

  opponentNextTurn(): Promise<Play> {
    if (this.#pending) return this.#pending;
    if (this.getCurrentPlayer() === "White") return this.#startOpponentTurn();
    return Promise.resolve(this.#lastResponse);
  }

  /** Reset volatile Go stats while preserving its favor-reward counter. */
  prestigeAugmentation(): void {
    for (const stats of this.stats.values()) {
      stats.wins = 0;
      stats.losses = 0;
      stats.nodes = 0;
      stats.nodePower = 0;
      stats.winStreak = 0;
      stats.oldWinStreak = 0;
      stats.highestWinStreak = 0;
    }
    // Remove the prior Go factor without disturbing augmentation multipliers.
    this.#updateEffects();
  }

  /** Player.applyEntropy rebuilds the base multiplier object before upstream
   * updateGoMults applies the current Go factors. The bookkeeping therefore
   * has no prior factor to divide out at this boundary. */
  reapplyEffectsAfterMultiplierReset(): void {
    this.#appliedEffects.clear();
    this.#updateEffects();
  }

  #requireTurn(colour: GoColor): void {
    if (this.#state.previousPlayer === null) throw new Error("Go game is over");
    if (this.#state.previousPlayer === colour) throw new Error("It is not your Go turn");
  }

  #requireCheatAccess(): void {
    const sf14 = this.#world.player.sourceFiles["14"] ?? 0;
    if (!(sf14 > 1 || (this.#world.bitnode === 14 && sf14 === 1))) {
      throw new Error("The go.cheat API requires Source-File 14.2");
    }
  }

  #cheat(effect: () => void): Promise<Play> {
    this.#requireCheatAccess();
    this.#requireTurn(GoColor.black);
    this.#activate();
    this.#state.passCount = 0;
    const priorCount = this.#state.cheatCount;
    const [success, eject] = whrng(this.#world.clock.now(), 2);
    if (success! <= this.getCheatSuccessChance(priorCount)) {
      effect();
    } else if (priorCount > 0 && eject! < 0.1) {
      this.#state.previousPlayer = null;
      this.#recordLoss(this.#state.ai as RewardOpponent, false);
      this.#lastResponse = { type: GoPlayType.gameOver, x: null, y: null };
      return Promise.resolve(this.#lastResponse);
    } else {
      passTurn(this.#state, GoColor.black, false);
    }
    this.#state.cheatCount++;
    this.#state.previousPlayer = GoColor.black;
    updateCaptures(this.#state.board, GoColor.black, true);
    return this.#startOpponentTurn();
  }

  #activate(): void {
    Go.currentGame = this.#state;
    Go.storedCycles = this.storedCycles;
  }

  #startOpponentTurn(): Promise<Play> {
    if (this.#pending) return this.#pending;
    this.#pending = this.#calculateOpponentTurn().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  #startAggregateCompletion(): Promise<Play> {
    if (this.#pending) return this.#pending;
    this.#pending = this.#completeAggregateGame().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  /** Collapse a complete promoted-policy game to one seeded outcome. The
   * calibration uses the same measured win, score, and upstream-AI wait rates
   * used by opponent selection; only the expensive interior move sequence is
   * omitted. */
  async #completeAggregateGame(): Promise<Play> {
    const opponent = this.#state.ai as RewardOpponent;
    const profile = GO_REWARD_RULES[opponent];
    const sizeShift = this.#requestedSize <= 5
      ? 0
      : this.#requestedSize <= 7
        ? 0.04
        : this.#requestedSize <= 9
          ? 0.07
          : 0.1;
    const winProbability = Math.min(1, profile.priorWinProbability + sizeShift);
    const playable = simpleBoardFromBoard(this.#state.board)
      .reduce((sum, column) => sum + [...column].filter((cell) => cell !== "#").length, 0);
    const scoreFraction = Math.min(
      1,
      profile.scoreFraction + (winProbability - profile.priorWinProbability) * 0.25,
    );
    const expectedBlackScore = playable * scoreFraction;
    const lowScore = Math.floor(expectedBlackScore);
    const blackScore = Math.max(
      1,
      lowScore + Number(this.#random() < expectedBlackScore - lowScore),
    );
    const won = this.#random() < winProbability;
    const whiteScore = won ? Math.max(0.5, blackScore - 0.5) : blackScore + 0.5;
    const durationMs = Math.max(
      1,
      Math.round(playable * profile.aiSecondsPerPlayableNode * 1_000),
    );
    await new Promise<void>((resolve) => void this.#world.clock.in(durationMs, resolve));

    this.#aggregateScore = { black: blackScore, white: whiteScore };
    this.#state.previousPlayer = null;
    this.#settled = true;
    this.#recordGame(opponent, won, blackScore, whiteScore, "aggregate");
    this.#lastResponse = { type: GoPlayType.gameOver, x: null, y: null };
    return this.#lastResponse;
  }

  async #calculateOpponentTurn(): Promise<Play> {
    this.#activate();
    sleepLog.length = 0;
    const dispatchPlaytime = this.#world.clock.now();
    GoPlayer.totalPlaytime = dispatchPlaytime;
    const initialWait = this.storedCycles > 0 ? 0 : 200;
    const seed = dispatchPlaytime + initialWait;
    const originalRandom = Math.random;
    Math.random = () => this.#random();
    let play: Play;
    try {
      play = await getMove(this.#state, GoColor.white, this.#state.ai, true, seed);
    } finally {
      Math.random = originalRandom;
    }
    this.storedCycles = Go.storedCycles;
    let wallMs = sleepLog.reduce((sum, wait) => sum + wait, 0);
    if (play.type === GoPlayType.move) {
      if (this.storedCycles > 0) {
        this.storedCycles -= 2;
        wallMs += 40;
      } else {
        wallMs += 200;
      }
    }
    await new Promise<void>((resolve) => void this.#world.clock.in(wallMs, resolve));

    this.#activate();
    if (play.type === GoPlayType.move) {
      if (!makeMove(this.#state, play.x, play.y, GoColor.white)) {
        throw new Error(`Vendored Go AI returned illegal move ${play.x},${play.y}`);
      }
      this.#lastResponse = { type: GoPlayType.move, x: play.x, y: play.y };
    } else {
      passTurn(this.#state, GoColor.white);
      if (this.#state.previousPlayer === null) {
        this.#settleGame();
        this.#lastResponse = { type: GoPlayType.gameOver, x: null, y: null };
      } else {
        this.#lastResponse = { type: GoPlayType.pass, x: null, y: null };
      }
    }
    return this.#lastResponse;
  }

  #stats(opponent: RewardOpponent): SimGoOpponentStats {
    let stats = this.stats.get(opponent);
    if (!stats) {
      stats = freshStats();
      this.stats.set(opponent, stats);
    }
    return stats;
  }

  #recordLoss(opponent: RewardOpponent, complete: boolean): void {
    const stats = this.#stats(opponent);
    stats.losses++;
    stats.oldWinStreak = stats.winStreak;
    if (stats.winStreak >= 0) stats.winStreak = -1;
    else if (complete) stats.winStreak--;
  }

  #settleGame(): void {
    if (this.#settled || !isRewardOpponent(this.#state.ai)) return;
    this.#settled = true;
    const opponent = this.#state.ai;
    const score = getScore(this.#state);
    const won = score[GoColor.black].sum >= score[GoColor.white].sum;
    this.#recordGame(
      opponent,
      won,
      score[GoColor.black].sum,
      score[GoColor.white].sum,
      "exact",
    );
  }

  #recordGame(
    opponent: RewardOpponent,
    won: boolean,
    blackScore: number,
    whiteScore: number,
    fidelity: GoSystemMode,
  ): void {
    const stats = this.#stats(opponent);
    if (!won) {
      this.#recordLoss(opponent, true);
    } else {
      stats.wins++;
      stats.oldWinStreak = stats.winStreak;
      stats.winStreak = stats.oldWinStreak < 0 ? 1 : stats.winStreak + 1;
      stats.highestWinStreak = Math.max(stats.highestWinStreak, stats.winStreak);
      const faction = this.#factions.get(opponent);
      if (
        faction?.joined
        && stats.winStreak > 0
        && stats.winStreak % 2 === 0
        && stats.rep < goFavorRepCap(this.#world.player.sourceFiles["14"] ?? 0)
      ) {
        const reward = goFavorReward(
          faction.favor,
          stats.rep,
          goFavorRepCap(this.#world.player.sourceFiles["14"] ?? 0),
        );
        faction.favor = reward.favorAfter;
        stats.rep += reward.repGranted;
      }
    }
    stats.nodePower += blackScore
      * goDifficultyMultiplier(opponent as GoRewardOpponent, this.#state.board.length)
      * goStreakMultiplier(stats.winStreak, stats.oldWinStreak);
    stats.nodes += blackScore;
    this.#updateEffects();
    this.#world.emit({
      kind: "event",
      name: "go.game",
      data: {
        opponent,
        fidelity,
        won,
        blackScore,
        whiteScore,
        winStreak: stats.winStreak,
        nodePower: stats.nodePower,
      },
    });
    this.#world.mirrorPlayer();
  }

  #effect(opponent: RewardOpponent, nodePower: number): number {
    return goEffectMultiplier(
      nodePower,
      opponent as GoRewardOpponent,
      currentNodeMults.GoPower,
      (this.#world.player.sourceFiles["14"] ?? 0) > 0,
    );
  }

  #updateEffects(): void {
    const mults = this.#world.person.mults as unknown as Record<string, number>;
    for (const opponent of REWARD_OPPONENTS) {
      const previous = this.#appliedEffects.get(opponent) ?? 1;
      const next = this.#effect(opponent, this.stats.get(opponent)?.nodePower ?? 0);
      for (const field of GO_EFFECT_FIELDS[opponent as GoRewardOpponent]) {
        mults[field] = (mults[field] ?? 1) / previous * next;
      }
      this.#appliedEffects.set(opponent, next);
    }
    this.#world.recalculateSkills();
  }
}

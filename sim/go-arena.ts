/** Standalone IPvGO policy arena.
 *
 * White is always the independently vendored v3.0.1 AI. The arena advances
 * Player.totalPlaytime from the waits actually requested by that oracle, so
 * black forecasts the same 200 ms seed slots used by the live controller.
 */
import {
  prepareGoDecision,
  finalizeGoDecision,
  playMove,
  scoreBoard,
  usesExactGoForecast,
  type GoBoard,
  type GoDecision,
  type GoRewardOpponent,
} from "../shared/strategy/go/decide.ts";
import { alignedAiSeed, GO_ENGINE_CYCLE_MS } from "../shared/strategy/go/rng.ts";
import { oracleInitialBoard } from "./features/go-oracle.ts";
import { GoColor, GoOpponent, GoPlayType } from "./vendor/bitburner/src/Go/Enums.ts";
import { getMove } from "./vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import { getNewBoardStateFromSimpleBoard } from "./vendor/bitburner/src/Go/boardState/boardState.ts";
import { Go, sleepLog } from "./vendor/bitburner/src/Go/OracleStubs.ts";

export interface GoArenaOpponent {
  oracle: GoOpponent;
  name: GoRewardOpponent;
  requestedSize: 5 | 7 | 9 | 13;
  komi: number;
}

export const GO_ARENA_OPPONENTS: readonly GoArenaOpponent[] = [
  { oracle: GoOpponent.Netburners, name: "Netburners", requestedSize: 5, komi: 1.5 },
  { oracle: GoOpponent.SlumSnakes, name: "Slum Snakes", requestedSize: 5, komi: 3.5 },
  { oracle: GoOpponent.TheBlackHand, name: "The Black Hand", requestedSize: 5, komi: 3.5 },
  { oracle: GoOpponent.Tetrads, name: "Tetrads", requestedSize: 5, komi: 5.5 },
  { oracle: GoOpponent.Daedalus, name: "Daedalus", requestedSize: 5, komi: 5.5 },
  { oracle: GoOpponent.Illuminati, name: "Illuminati", requestedSize: 5, komi: 7.5 },
  { oracle: GoOpponent.w0r1d_d43m0n, name: "????????????", requestedSize: 13, komi: 9.5 },
] as const;

/** Engine-tick seeds spread across the WHRNG's 30,000-second period. The tick
 * stride is coprime to 150,000, avoiding the narrow phase classes produced by
 * the old +4,000 ms corpus. */
export function goArenaSeeds(count: number, start = 1_000): number[] {
  const periodTicks = 150_000;
  const strideTicks = 104_729;
  const startTick = Math.floor(start / GO_ENGINE_CYCLE_MS);
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) =>
    ((startTick + index * strideTicks) % periodTicks) * GO_ENGINE_CYCLE_MS);
}

export interface GoArenaGameResult {
  opponent: GoRewardOpponent;
  seed: number;
  tieRoll: number;
  size: number;
  won: boolean;
  completed: boolean;
  turns: number;
  score: { X: number; O: number };
  planningMs: number[];
  trace?: GoArenaTurnTrace[];
}

export interface GoArenaTurnTrace {
  turn: number;
  dispatchPlaytime: number;
  board: string[];
  previousBoards: string[][];
  consecutivePasses: number;
  black: { type: "move"; x: number; y: number } | { type: "pass" };
  policyBook: boolean;
  predicted: { x: number | null; y: number | null; count: number }[];
  white: { type: "move"; x: number; y: number } | { type: "pass" };
  planningMs: number;
}

/** Public position snapshot used by the offline teacher for counterfactual
 * continuation rollouts. No hidden oracle state is carried across: the arena
 * reconstructs the upstream opponent from these same public fields. */
export interface GoArenaInitialState {
  board: GoBoard;
  previousBoards: readonly string[][];
  consecutivePasses: number;
  dispatchPlaytime: number;
}

export interface GoArenaSummary {
  opponent: GoRewardOpponent;
  games: number;
  wins: number;
  losses: number;
  completed: number;
  winRate: number;
  wilsonLower95: number;
  pointDifference: number;
  decisions: number;
  latencyMs: { p50: number; p95: number; p99: number; p999: number; max: number };
  losingSeeds: { seed: number; tieRoll: number; margin: number }[];
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function wilsonLower95(wins: number, games: number): number {
  if (!games) return 0;
  const z = 1.959963984540054;
  const p = wins / games;
  const z2n = z * z / games;
  return (p + z2n / 2 - z * Math.sqrt((p * (1 - p) + z * z / (4 * games)) / games)) / (1 + z2n);
}

function oracleState(
  board: GoBoard,
  history: readonly string[][],
  consecutivePasses: number,
  opponent: GoOpponent,
) {
  // The secret opponent's constructor always creates a fresh BitVerse board.
  // Reconstruct the observed midgame with the behaviorally equivalent
  // Illuminati identity, then restore the secret identity for getMove/komi.
  const reconstruction = opponent === GoOpponent.w0r1d_d43m0n ? GoOpponent.Illuminati : opponent;
  const state = getNewBoardStateFromSimpleBoard(board.rows, undefined, reconstruction, GoColor.black);
  state.previousBoards = history.map((position) => position.join(""));
  state.passCount = consecutivePasses;
  state.ai = opponent;
  Go.currentGame = state;
  return state;
}

export function decideGoArenaBlack(
  board: GoBoard,
  history: readonly string[][],
  opponent: GoRewardOpponent,
  komi: number,
  dispatchPlaytime: number,
  consecutivePasses: number,
  forecastWeight?: number,
  analysisWidth?: number,
  forecastWidth?: number,
  cohesionWeight?: number,
  scoreLeadBonus?: number,
  continuationWidth?: number,
  deepForecastThreshold?: number,
  deepForecastWidth?: number,
  deepRootWidth?: number,
  deepAdaptiveGap?: number,
  policyBook?: boolean,
): GoDecision {
  const view = {
    board,
    currentPlayer: "Black" as const,
    opponent,
    status: "inProgress" as const,
    previousBoards: history,
    komi,
    alignedDispatchPlaytime: dispatchPlaytime,
    consecutivePasses,
    ...(forecastWeight !== undefined ? { forecastWeight } : {}),
    ...(analysisWidth !== undefined ? { analysisWidth } : {}),
    ...(forecastWidth !== undefined ? { forecastWidth } : {}),
    ...(cohesionWeight !== undefined ? { cohesionWeight } : {}),
    ...(scoreLeadBonus !== undefined ? { scoreLeadBonus } : {}),
    ...(continuationWidth !== undefined ? { continuationWidth } : {}),
    ...(deepForecastThreshold !== undefined ? { deepForecastThreshold } : {}),
    ...(deepForecastWidth !== undefined ? { deepForecastWidth } : {}),
    ...(deepRootWidth !== undefined ? { deepRootWidth } : {}),
    ...(deepAdaptiveGap !== undefined ? { deepAdaptiveGap } : {}),
    ...(policyBook !== undefined ? { policyBook } : {}),
  };
  const exactForecast = usesExactGoForecast(view);
  const prepared = prepareGoDecision(view, exactForecast);
  return exactForecast
    ? finalizeGoDecision(prepared, [alignedAiSeed(dispatchPlaytime, 0)])
    : finalizeGoDecision(prepared);
}

export async function playGoArenaGame(
  definition: GoArenaOpponent,
  seed: number,
  tieRoll = 0.5,
  includeTrace = false,
  forecastWeight?: number,
  analysisWidth?: number,
  forecastWidth?: number,
  cohesionWeight?: number,
  scoreLeadBonus?: number,
  continuationWidth?: number,
  deepForecastThreshold?: number,
  deepForecastWidth?: number,
  deepRootWidth?: number,
  deepAdaptiveGap?: number,
  policyBook?: boolean,
  forcedOpening?: readonly [number, number],
  initialBoard?: GoBoard,
  initialState?: GoArenaInitialState,
): Promise<GoArenaGameResult> {
  let board = initialState
    ? { size: initialState.board.size, rows: [...initialState.board.rows] }
    : initialBoard
      ? { size: initialBoard.size, rows: [...initialBoard.rows] }
    : oracleInitialBoard(definition.requestedSize, definition.oracle, seed);
  const history: string[][] = initialState
    ? initialState.previousBoards.map((position) => [...position])
    : [];
  let consecutivePasses = initialState?.consecutivePasses ?? 0;
  let turns = 0;
  let dispatchPlaytime = initialState?.dispatchPlaytime
    ?? Math.floor(seed / GO_ENGINE_CYCLE_MS) * GO_ENGINE_CYCLE_MS;
  const planningMs: number[] = [];
  const trace: GoArenaTurnTrace[] = [];
  const maxTurns = board.size * board.size * 4;
  const originalRandom = Math.random;
  try {
    while (consecutivePasses < 2 && turns < maxTurns) {
      const started = performance.now();
      const inputBoard = [...board.rows];
      const inputHistory = history.map((position) => [...position]);
      const inputDispatchPlaytime = dispatchPlaytime;
      const inputConsecutivePasses = consecutivePasses;
      const decision: GoDecision = turns === 0 && forcedOpening
        ? {
          action: { type: "move", x: forcedOpening[0], y: forcedOpening[1], why: "offline teacher action" },
          ranked: [],
          why: "offline teacher action",
          finalists: 0,
          positionValue: 0,
        }
        : decideGoArenaBlack(
          board,
          history,
          definition.name,
          definition.komi,
          dispatchPlaytime,
          consecutivePasses,
          forecastWeight,
          analysisWidth,
          forecastWidth,
          cohesionWeight,
          scoreLeadBonus,
          continuationWidth,
          deepForecastThreshold,
          deepForecastWidth,
          deepRootWidth,
          deepAdaptiveGap,
          policyBook,
        );
      const elapsed = performance.now() - started;
      planningMs.push(elapsed);
      if (decision.action.type === "move") {
        const played = playMove(
          board,
          decision.action.x,
          decision.action.y,
          "X",
          new Set(history.map((position) => position.join(""))),
        );
        if (!played) throw new Error(`arena black returned illegal ${decision.action.x},${decision.action.y}`);
        history.unshift(board.rows);
        board = played.board;
        consecutivePasses = 0;
      } else if (decision.action.type === "pass") {
        consecutivePasses++;
      } else {
        throw new Error(`arena received non-playing decision ${decision.action.type}`);
      }
      turns++;
      if (consecutivePasses >= 2) break;

      const state = oracleState(board, history, consecutivePasses, definition.oracle);
      const aiSeed = alignedAiSeed(dispatchPlaytime, 0);
      Math.random = () => tieRoll;
      sleepLog.length = 0;
      const white = await getMove(state, GoColor.white, definition.oracle, false, aiSeed);
      const waitMs = sleepLog.reduce((sum, milliseconds) => sum + milliseconds, 0)
        // handleNextTurn performs one final wait before placing a non-pass.
        + (white.type === GoPlayType.move ? GO_ENGINE_CYCLE_MS : 0);
      dispatchPlaytime += Math.floor(waitMs / GO_ENGINE_CYCLE_MS) * GO_ENGINE_CYCLE_MS;
      if (white.type === GoPlayType.move) {
        const played = playMove(
          board,
          white.x,
          white.y,
          "O",
          new Set(history.map((position) => position.join(""))),
        );
        if (!played) throw new Error(`upstream oracle returned illegal ${white.x},${white.y}`);
        history.unshift(board.rows);
        board = played.board;
        consecutivePasses = 0;
      } else {
        consecutivePasses++;
      }
      if (includeTrace) {
        const black = decision.action.type === "move"
          ? { type: "move" as const, x: decision.action.x, y: decision.action.y }
          : { type: "pass" as const };
        trace.push({
          turn: turns - 1,
          dispatchPlaytime: inputDispatchPlaytime,
          board: inputBoard,
          previousBoards: inputHistory,
          consecutivePasses: inputConsecutivePasses,
          black,
          policyBook: decision.why.startsWith("offline teacher policy"),
          predicted: decision.ranked[0]?.predictedReplies ?? [],
          white: white.type === GoPlayType.move
            ? { type: "move", x: white.x, y: white.y }
            : { type: "pass" },
          planningMs: elapsed,
        });
      }
      turns++;
    }
  } finally {
    Math.random = originalRandom;
    sleepLog.length = 0;
  }
  const score = scoreBoard(board, definition.komi);
  return {
    opponent: definition.name,
    seed,
    tieRoll,
    size: board.size,
    won: score.X >= score.O,
    completed: consecutivePasses >= 2,
    turns,
    score,
    planningMs,
    ...(includeTrace ? { trace } : {}),
  };
}

/** Counterfactual teacher entrypoint: force exactly the first black action,
 * then return to the deployed policy for the rest of the continuation. */
export function playGoArenaPosition(
  definition: GoArenaOpponent,
  seed: number,
  tieRoll: number,
  initialState: GoArenaInitialState,
  forcedAction: readonly [number, number],
): Promise<GoArenaGameResult> {
  return playGoArenaGame(
    definition,
    seed,
    tieRoll,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    forcedAction,
    undefined,
    initialState,
  );
}

export function summarizeGoArena(opponent: GoRewardOpponent, games: readonly GoArenaGameResult[]): GoArenaSummary {
  const times = games.flatMap((game) => game.planningMs).sort((a, b) => a - b);
  const wins = games.filter((game) => game.won).length;
  return {
    opponent,
    games: games.length,
    wins,
    losses: games.length - wins,
    completed: games.filter((game) => game.completed).length,
    winRate: games.length ? wins / games.length : 0,
    wilsonLower95: wilsonLower95(wins, games.length),
    pointDifference: games.reduce((sum, game) => sum + game.score.X - game.score.O, 0),
    decisions: times.length,
    latencyMs: {
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      p99: percentile(times, 0.99),
      p999: percentile(times, 0.999),
      max: times.at(-1) ?? 0,
    },
    losingSeeds: games
      .filter((game) => !game.won)
      .map((game) => ({ seed: game.seed, tieRoll: game.tieRoll, margin: game.score.X - game.score.O })),
  };
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const count = Math.max(1, Math.floor(numberFlag("--games", 24)));
  const start = numberFlag("--seed", 1_000);
  const stepIndex = Bun.argv.indexOf("--seed-step");
  const seeds = stepIndex >= 0
    ? Array.from({ length: count }, (_, index) => start + index * Number(Bun.argv[stepIndex + 1] ?? 4_000))
    : goArenaSeeds(count, start);
  const requested = Bun.argv.includes("--all-ties") ? [0, 0.25, 0.5, 0.75, 0.999999] : [0.5];
  const includeTrace = Bun.argv.includes("--trace");
  const forecastWeightIndex = Bun.argv.indexOf("--forecast-weight");
  const forecastWeight = forecastWeightIndex >= 0 ? Number(Bun.argv[forecastWeightIndex + 1]) : undefined;
  const analysisWidthIndex = Bun.argv.indexOf("--analysis-width");
  const analysisWidth = analysisWidthIndex >= 0 ? Number(Bun.argv[analysisWidthIndex + 1]) : undefined;
  const forecastWidthIndex = Bun.argv.indexOf("--forecast-width");
  const forecastWidth = forecastWidthIndex >= 0 ? Number(Bun.argv[forecastWidthIndex + 1]) : undefined;
  const cohesionWeightIndex = Bun.argv.indexOf("--cohesion-weight");
  const cohesionWeight = cohesionWeightIndex >= 0 ? Number(Bun.argv[cohesionWeightIndex + 1]) : undefined;
  const scoreLeadBonusIndex = Bun.argv.indexOf("--score-lead-bonus");
  const scoreLeadBonus = scoreLeadBonusIndex >= 0 ? Number(Bun.argv[scoreLeadBonusIndex + 1]) : undefined;
  const continuationWidthIndex = Bun.argv.indexOf("--continuation-width");
  const continuationWidth = continuationWidthIndex >= 0 ? Number(Bun.argv[continuationWidthIndex + 1]) : undefined;
  const deepForecastThresholdIndex = Bun.argv.indexOf("--deep-forecast-threshold");
  const deepForecastThreshold = deepForecastThresholdIndex >= 0
    ? Number(Bun.argv[deepForecastThresholdIndex + 1])
    : undefined;
  const deepForecastWidthIndex = Bun.argv.indexOf("--deep-forecast-width");
  const deepForecastWidth = deepForecastWidthIndex >= 0 ? Number(Bun.argv[deepForecastWidthIndex + 1]) : undefined;
  const deepRootWidthIndex = Bun.argv.indexOf("--deep-root-width");
  const deepRootWidth = deepRootWidthIndex >= 0 ? Number(Bun.argv[deepRootWidthIndex + 1]) : undefined;
  const deepAdaptiveGapIndex = Bun.argv.indexOf("--deep-adaptive-gap");
  const deepAdaptiveGap = deepAdaptiveGapIndex >= 0 ? Number(Bun.argv[deepAdaptiveGapIndex + 1]) : undefined;
  const policyBook = Bun.argv.includes("--disable-policy-book") || Bun.argv.includes("--disable-opening-book")
    ? false
    : undefined;
  const selected = GO_ARENA_OPPONENTS.filter((opponent) => {
    const index = Bun.argv.indexOf("--opponent");
    if (index < 0) return true;
    const query = (Bun.argv[index + 1] ?? "").toLowerCase();
    if ((query === "secret" || query === "world-daemon") && opponent.name === "????????????") return true;
    return opponent.name.toLowerCase().includes(query);
  });
  const boardSizeIndex = Bun.argv.indexOf("--board-size");
  const boardSize = boardSizeIndex >= 0 ? Number(Bun.argv[boardSizeIndex + 1]) : undefined;
  for (const selectedOpponent of selected) {
    const opponent = boardSize === 5 || boardSize === 7 || boardSize === 9 || boardSize === 13
      ? { ...selectedOpponent, requestedSize: boardSize as 5 | 7 | 9 | 13 }
      : selectedOpponent;
    const games: GoArenaGameResult[] = [];
    for (const seed of seeds) {
      for (const tieRoll of requested) {
        const game = await playGoArenaGame(
          opponent,
          seed,
          tieRoll,
          includeTrace,
          forecastWeight,
          analysisWidth,
          forecastWidth,
          cohesionWeight,
          scoreLeadBonus,
          continuationWidth,
          deepForecastThreshold,
          deepForecastWidth,
          deepRootWidth,
          deepAdaptiveGap,
          policyBook,
        );
        games.push(game);
        if (includeTrace) console.log(JSON.stringify({ type: "game", ...game }));
      }
    }
    console.log(JSON.stringify(summarizeGoArena(opponent.name, games)));
  }
}

if (import.meta.main) await main();

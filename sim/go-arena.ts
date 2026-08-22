/** Standalone IPvGO policy arena.
 *
 * White is always the independently vendored v3.0.1 AI. The arena advances
 * Player.totalPlaytime from the waits actually requested by that oracle, so
 * black forecasts the same 200 ms seed slots used by the live controller.
 * Black is the production neural engine. TypeScript inference requires
 * WebGPU; run this arena through `bun run go:gpu -- --arena` in Chromium.
 */
import {
  applyGoCheat,
  GO_CHEAT_LIMITS_BY_SIZE,
  isGoCheatAction,
  playMove,
  scoreBoard,
  type GoBoard,
  type GoDecision,
  type GoCheatState,
  type GoPlayingAction,
  type GoRewardOpponent,
} from "../shared/strategy/go/rules.ts";
import {
  finalizeNeuralGoDecision,
  type GoSeedWaitV1,
  GO_PROFILE_CANDIDATE_LIMITS,
  goModelProfile,
  GoNeuralEngine,
  prepareNeuralGoDecision,
  type GoValueBackendFactory,
  type GoDeepSearchV1,
  type GoModelArtifactOverrides,
} from "../shared/strategy/go/neural/engine.ts";
import { createRequiredWebGpuGoValueBackend } from "../shared/strategy/go/neural/webgpu.ts";
import { alignedAiSeed, GO_ENGINE_CYCLE_MS } from "../shared/strategy/go/rng.ts";
import { goGameNodePowerGain } from "../shared/strategy/go/rewards.ts";
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

function mixUint32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b) >>> 0;
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function randomFor(seed: number): () => number {
  let state = Math.floor(seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function goArenaDefenseRoll(seed: number): number {
  return randomFor(seed)();
}

/** A second deterministic corpus stream for Bitburner's unseeded handicap
 * placement. `start` is independent of the playtime seed used by WHRNG. */
export function goArenaHandicapSeeds(count: number, start: number): number[] {
  const length = Math.max(0, Math.floor(count));
  const initial = Math.floor(start) >>> 0;
  return Array.from({ length }, (_, index) =>
    mixUint32((initial + Math.imul(index, 0x9e3779b9)) >>> 0));
}

export function goArenaSeedPairs(
  count: number,
  playtimeStart = 1_000,
  handicapStart = mixUint32(Math.floor(playtimeStart) ^ 0xa5a5a5a5),
  defenseStart = mixUint32(Math.floor(playtimeStart) ^ 0x3c6ef372),
): { seed: number; handicapSeed: number; defenseSeed: number }[] {
  const seeds = goArenaSeeds(count, playtimeStart);
  const handicapSeeds = goArenaHandicapSeeds(count, handicapStart);
  const defenseSeeds = goArenaHandicapSeeds(count, defenseStart);
  return seeds.map((seed, index) => ({
    seed,
    handicapSeed: handicapSeeds[index]!,
    defenseSeed: defenseSeeds[index]!,
  }));
}

export type GoArenaProfile = "small5" | "daemon19";

/** The exact fixed corpus used by profile screens and promotion. Keeping the
 * opponent offsets here makes browser play, pair validation, and seed-reuse
 * checks share one definition. */
export function goProfileArenaSeedCases(
  profile: GoArenaProfile,
  gamesPerOpponent: number,
  playtimeStart: number,
  handicapStart: number,
  defenseStart: number,
): { opponent: GoRewardOpponent; cases: ReturnType<typeof goArenaSeedPairs> }[] {
  const selected = GO_ARENA_OPPONENTS.filter((opponent) =>
    profile === "daemon19" ? opponent.name === "????????????" : opponent.requestedSize === 5);
  return selected.map((opponent, opponentIndex) => ({
    opponent: opponent.name,
    cases: goArenaSeedPairs(
      gamesPerOpponent,
      playtimeStart + opponentIndex * 20_003,
      handicapStart + opponentIndex * 104_729,
      defenseStart + opponentIndex * 65_537,
    ),
  }));
}

export interface GoArenaGameResult {
  opponent: GoRewardOpponent;
  seed: number;
  handicapSeed: number;
  defenseSeed: number | null;
  tieRoll: number | null;
  size: number;
  won: boolean;
  completed: boolean;
  turns: number;
  /** Virtual engine time consumed by upstream AI waits (black planning runs
   * synchronously in the arena and is reported separately in planningMs). */
  durationMs: number;
  score: { X: number; O: number };
  planningMs: number[];
  actions: GoPlayingAction["type"][];
  finalists: number[];
  cheatsPlayed: number;
  /** Turns that spent one engine cycle to reach a seed with a winning
   * continuation, after every candidate at the original tick lost. */
  seedWaits: number;
  /** Upstream faction-priority moves rejected by positional superko, which
   * Bitburner advances past without changing the board or counting a pass. */
  whiteNoOps: number;
  planningPhases: { preparationMs: number[]; gpuAndSelectionMs: number[] };
  trace?: GoArenaTurnTrace[];
}

export interface GoArenaTurnTrace {
  turn: number;
  dispatchPlaytime: number;
  board: string[];
  previousBoards: string[][];
  consecutivePasses: number;
  black:
    | { type: "move"; x: number; y: number }
    | { type: "pass" }
    | { type: "cheatTwoMoves"; x1: number; y1: number; x2: number; y2: number }
    | { type: "cheatRemoveRouter" | "cheatDestroyNode" | "cheatRepairNode"; x: number; y: number };
  predicted: { x: number | null; y: number | null; count: number }[];
  white: { type: "move"; x: number; y: number } | { type: "pass" };
  planningMs: number;
}

/** Public position snapshot used for counterfactual continuation rollouts. No
 * hidden oracle state is carried across: the arena reconstructs the upstream
 * opponent from these same public fields. */
export interface GoArenaInitialState {
  board: GoBoard;
  previousBoards: readonly string[][];
  consecutivePasses: number;
  dispatchPlaytime: number;
  cheatCount?: number;
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
  meanBlackScore: number;
  meanDurationMs: number;
  decisions: number;
  meanCheatsPlayed: number;
  /** Node power accrued by the arm, streak threaded across the game sequence
   * in play order. Per-turn and per-second forms are both reported: turn count
   * alone rewards short losses, wall time alone hides slow planning. */
  meanNodePowerGain: number;
  nodePowerPerTurn: number;
  nodePowerPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number; p999: number; max: number };
  losingSeeds: {
    seed: number;
    handicapSeed: number;
    defenseSeed: number | null;
    tieRoll: number | null;
    margin: number;
  }[];
}

export interface GoArenaOptions {
  /** Simulator A/B override for the oversized-board candidate cap. */
  candidateLimit?: number;
  forcedOpening?: readonly [number, number];
  initialBoard?: GoBoard;
  initialState?: GoArenaInitialState;
  /** Independent seed for the game's unseeded initial handicap placement. */
  handicapSeed?: number;
  /** Independent stream for the upstream AI's unseeded defense tie-break.
   * Pass null only for deliberate fixed-roll diagnostics such as --all-ties. */
  defenseSeed?: number | null;
  /** Disabled by default for clean A/B comparisons. `true` enables the SF14.2
   * count-decay schedule; an object exposes latency budgets and an optional
   * fixed success chance for stress tests. */
  cheat?: boolean | {
    enabled: boolean;
    successChance?: number;
    candidateLimit?: number;
    doubleMoveLimit?: number;
  };
}

function arenaCheatConfig(options: GoArenaOptions, boardSize: number): Omit<GoCheatState, "count"> | undefined {
  if (!options.cheat) return undefined;
  const config = options.cheat === true ? { enabled: true } : options.cheat;
  if (!config.enabled) return undefined;
  if (config.successChance !== undefined
    && (!Number.isFinite(config.successChance) || config.successChance < 0 || config.successChance > 1)) {
    throw new Error(`arena cheat successChance must be between 0 and 1, got ${config.successChance}`);
  }
  const candidateLimit = config.candidateLimit ?? GO_CHEAT_LIMITS_BY_SIZE[boardSize]!.candidateLimit;
  const doubleMoveLimit = config.doubleMoveLimit ?? GO_CHEAT_LIMITS_BY_SIZE[boardSize]!.doubleMoveLimit;
  if (!Number.isFinite(candidateLimit) || candidateLimit < 0) {
    throw new Error(`arena cheat candidateLimit must be nonnegative, got ${candidateLimit}`);
  }
  if (!Number.isFinite(doubleMoveLimit) || doubleMoveLimit < 1) {
    throw new Error(`arena cheat doubleMoveLimit must be positive, got ${doubleMoveLimit}`);
  }
  return {
    unlocked: true,
    successByCount: goArenaCheatSuccessTable(config.successChance),
    candidateLimit: Math.floor(candidateLimit),
    doubleMoveLimit: Math.floor(doubleMoveLimit),
  };
}

/** The SF14.2 count-decay success schedule (or a fixed chance for stress
 * tests), shared by both arenas so their curves cannot drift apart. */
export function goArenaCheatSuccessTable(successChance?: number): number[] {
  return Array.from({ length: 1_024 }, (_, cheatCount) => successChance
    ?? Math.max(0, Math.min(1, 0.6 * (0.7 - 0.02 * cheatCount) ** cheatCount)));
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

let arenaEngine = new GoNeuralEngine((weights) => createRequiredWebGpuGoValueBackend(weights));

/** Swap the value backend under the arena for planner-only tests. Production
 * and browser arenas use the required WebGPU factory above. */
/** Arena-wide seed-wait policy; `undefined` resolves the production default,
 * `null` disables it for a baseline arm. */
let arenaSeedWait: GoSeedWaitV1 | null | undefined;

export function configureGoArenaEngine(
  factory: GoValueBackendFactory,
  artifacts: GoModelArtifactOverrides = {},
  deepSearch?: GoDeepSearchV1 | null,
  seedWait?: GoSeedWaitV1 | null,
): void {
  void arenaEngine.dispose();
  arenaEngine = new GoNeuralEngine(factory, artifacts, deepSearch);
  arenaSeedWait = seedWait;
}

async function decideGoArenaBlack(
  board: GoBoard,
  history: readonly string[][],
  opponent: GoRewardOpponent,
  komi: number,
  dispatchPlaytime: number,
  consecutivePasses: number,
  candidateLimit?: number,
  cheat?: GoCheatState,
): Promise<{ decision: GoDecision; preparationMs: number; gpuAndSelectionMs: number }> {
  const started = performance.now();
  const view = {
    board,
    currentPlayer: "Black",
    opponent,
    status: "inProgress",
    previousBoards: history,
    komi,
    consecutivePasses,
    bonusCycles: 0,
    ...(cheat ? { cheat } : {}),
    ...(candidateLimit !== undefined ? { candidateLimit } : {}),
  } as const;
  const prepared = prepareNeuralGoDecision(view);
  const preparedAt = performance.now();
  const seed = alignedAiSeed(dispatchPlaytime, 0);
  // V9 keeps exact opponent preparation lazy, so there is no separate
  // prediction phase to measure: finalization owns reply prediction for the
  // retained finalists and is timed as one phase with the GPU batch.
  const decision = await finalizeNeuralGoDecision(prepared, [seed], arenaEngine, dispatchPlaytime,
    arenaSeedWait === undefined ? undefined : { seedWait: arenaSeedWait });
  const finalizedAt = performance.now();
  return {
    decision,
    preparationMs: preparedAt - started,
    gpuAndSelectionMs: finalizedAt - preparedAt,
  };
}

export async function playGoArenaGame(
  definition: GoArenaOpponent,
  seed: number,
  tieRoll: number | undefined = undefined,
  includeTrace = false,
  options: GoArenaOptions = {},
): Promise<GoArenaGameResult> {
  const { initialState, initialBoard, forcedOpening } = options;
  const handicapSeed = options.handicapSeed
    ?? goArenaHandicapSeeds(1, mixUint32(Math.floor(seed) ^ 0xa5a5a5a5))[0]!;
  const defenseSeed = options.defenseSeed === null
    ? null
    : options.defenseSeed
      ?? goArenaHandicapSeeds(1, mixUint32(Math.floor(seed) ^ 0x3c6ef372))[0]!;
  if (defenseSeed === null && tieRoll === undefined) {
    throw new Error("fixed-roll diagnostics require an explicit tie roll");
  }
  const defenseRandom = defenseSeed === null ? () => tieRoll! : randomFor(defenseSeed);
  let board = initialState
    ? { size: initialState.board.size, rows: [...initialState.board.rows] }
    : initialBoard
      ? { size: initialBoard.size, rows: [...initialBoard.rows] }
    : oracleInitialBoard(definition.requestedSize, definition.oracle, seed, handicapSeed);
  const history: string[][] = initialState
    ? initialState.previousBoards.map((position) => [...position])
    : [];
  let consecutivePasses = initialState?.consecutivePasses ?? 0;
  let cheatCount = initialState?.cheatCount ?? 0;
  let cheatsPlayed = 0;
  let whiteNoOps = 0;
  let turns = 0;
  let seedWaits = 0;
  let dispatchPlaytime = initialState?.dispatchPlaytime
    ?? Math.floor(seed / GO_ENGINE_CYCLE_MS) * GO_ENGINE_CYCLE_MS;
  const startedPlaytime = dispatchPlaytime;
  // Sub-tick wall clock the engine has not yet converted into a tick. Other
  // scripts and Black's own planning consume an uncontrolled 5..90 ms per
  // turn, so the branch-exact reply base can slip one extra tick — exactly
  // the base/base+1 window live play exhibits. White's seed is unaffected:
  // its first wait is a full cycle, so the seed phase stays dispatch + 1.
  // Seeded per game so paired A/B candidate runs see identical timing noise.
  const timingRandom = randomFor(mixUint32(Math.floor(seed) ^ 0x1b873593));
  let subTickOffsetMs = Math.floor(timingRandom() * 50);
  const planningMs: number[] = [];
  const actions: GoPlayingAction["type"][] = [];
  const finalists: number[] = [];
  const planningPhases = { preparationMs: [] as number[], gpuAndSelectionMs: [] as number[] };
  const trace: GoArenaTurnTrace[] = [];
  const cheatConfig = arenaCheatConfig(options, board.size);
  // This is a runaway guard, not a game rule. A valid 5x5 candidate exceeded
  // the former 4*area cap during a large promotion screen, which truncated a
  // real game and made the entire paired corpus unusable. Keep the cap high
  // enough for long legal fights and still fail the arena if play never ends.
  const maxTurns = board.size * board.size * 8;
  const originalRandom = Math.random;
  try {
    while (consecutivePasses < 2 && turns < maxTurns) {
      const started = performance.now();
      const inputBoard = [...board.rows];
      const inputHistory = history.map((position) => [...position]);
      const inputDispatchPlaytime = dispatchPlaytime;
      const inputConsecutivePasses = consecutivePasses;
      let decision: GoDecision;
      if (turns === 0 && forcedOpening) {
        decision = {
          action: { type: "move", x: forcedOpening[0], y: forcedOpening[1] },
          ranked: [],
          finalists: 0,
          positionValue: 0.5,
        };
      } else {
        const planned = await decideGoArenaBlack(
          board,
          history,
          definition.name,
          definition.komi,
          dispatchPlaytime,
          consecutivePasses,
          options.candidateLimit,
          cheatConfig ? { ...cheatConfig, count: cheatCount } : undefined,
        );
        decision = planned.decision;
        finalists.push(decision.finalists);
        planningPhases.preparationMs.push(planned.preparationMs);
        planningPhases.gpuAndSelectionMs.push(planned.gpuAndSelectionMs);
      }
      const elapsed = performance.now() - started;
      planningMs.push(elapsed);
      if (decision.action.type === "resume" || decision.action.type === "newGame") {
        throw new Error(`arena received non-playing decision ${decision.action.type}`);
      }
      // The decision may have been computed for a later tick because every
      // continuation at this one was predicted to lose. Spend that cycle: the
      // action is only correct in the tick it was chosen for, since White's
      // reply is seeded from the dispatch tick.
      if (decision.dispatchOffsetMs) {
        dispatchPlaytime += decision.dispatchOffsetMs;
        seedWaits++;
      }
      actions.push(decision.action.type);
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
      } else if (isGoCheatAction(decision.action)) {
        const cheated = applyGoCheat(board, decision.action);
        if (!cheated) throw new Error(`arena black returned invalid ${decision.action.type}`);
        board = cheated.board;
        consecutivePasses = 0;
        cheatCount++;
        cheatsPlayed++;
      } else if (decision.action.type === "pass") {
        consecutivePasses++;
      }
      turns++;
      if (consecutivePasses >= 2) break;

      const state = oracleState(board, history, consecutivePasses, definition.oracle);
      const aiSeed = alignedAiSeed(dispatchPlaytime, 0);
      Math.random = defenseRandom;
      sleepLog.length = 0;
      const white = await getMove(state, GoColor.white, definition.oracle, false, aiSeed);
      const waitMs = sleepLog.reduce((sum, milliseconds) => sum + milliseconds, 0)
        // handleNextTurn performs one final wait before placing a non-pass.
        + (white.type === GoPlayType.move ? GO_ENGINE_CYCLE_MS : 0);
      const jitterMs = 5 + Math.floor(timingRandom() * 86);
      const advancedMs = subTickOffsetMs + waitMs + jitterMs;
      dispatchPlaytime += Math.floor(advancedMs / GO_ENGINE_CYCLE_MS) * GO_ENGINE_CYCLE_MS;
      subTickOffsetMs = advancedMs % GO_ENGINE_CYCLE_MS;
      if (white.type === GoPlayType.move) {
        const played = playMove(
          board,
          white.x,
          white.y,
          "O",
          new Set(history.map((position) => position.join(""))),
        );
        if (played) {
          history.unshift(board.rows);
          board = played.board;
          consecutivePasses = 0;
        } else {
          // Upstream validates fallback moves but not faction-priority moves, so
          // positional superko can very rarely reject the AI's chosen coordinate.
          // Bitburner logs it and advances to black without changing the board and
          // without counting a pass. `apply_to_position()` and the native arena
          // model that exact no-op; crashing here instead aborted a whole gate.
          whiteNoOps++;
        }
      } else {
        consecutivePasses++;
      }
      if (includeTrace) {
        trace.push({
          turn: turns - 1,
          dispatchPlaytime: inputDispatchPlaytime,
          board: inputBoard,
          previousBoards: inputHistory,
          consecutivePasses: inputConsecutivePasses,
          black: decision.action,
          predicted: decision.forecast ?? [],
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
    handicapSeed,
    defenseSeed,
    tieRoll: defenseSeed === null ? tieRoll! : null,
    size: board.size,
    won: score.X >= score.O,
    completed: consecutivePasses >= 2,
    turns,
    durationMs: dispatchPlaytime - startedPlaytime,
    score,
    planningMs,
    actions,
    finalists,
    cheatsPlayed,
    seedWaits,
    whiteNoOps,
    planningPhases,
    ...(includeTrace ? { trace } : {}),
  };
}

/** Counterfactual entrypoint: force exactly the first black action, then
 * return to the deployed policy for the rest of the continuation. */
export function playGoArenaPosition(
  definition: GoArenaOpponent,
  seed: number,
  tieRoll: number,
  initialState: GoArenaInitialState,
  forcedAction: readonly [number, number],
): Promise<GoArenaGameResult> {
  return playGoArenaGame(definition, seed, tieRoll, false, {
    initialState,
    forcedOpening: forcedAction,
    defenseSeed: null,
  });
}

export function summarizeGoArena(opponent: GoRewardOpponent, games: readonly GoArenaGameResult[]): GoArenaSummary {
  const times = games.flatMap((game) => game.planningMs).sort((a, b) => a - b);
  const wins = games.filter((game) => game.won).length;
  let streak = 0;
  let totalNodePower = 0;
  for (const game of games) {
    const power = goGameNodePowerGain(opponent, game.size, game.score.X, game.won, streak);
    totalNodePower += power.gain;
    streak = power.streakAfter;
  }
  const totalTurns = games.reduce((sum, game) => sum + game.turns, 0);
  const totalDurationMs = games.reduce((sum, game) => sum + game.durationMs, 0);
  return {
    opponent,
    games: games.length,
    wins,
    losses: games.length - wins,
    completed: games.filter((game) => game.completed).length,
    winRate: games.length ? wins / games.length : 0,
    wilsonLower95: wilsonLower95(wins, games.length),
    pointDifference: games.reduce((sum, game) => sum + game.score.X - game.score.O, 0),
    meanBlackScore: games.length ? games.reduce((sum, game) => sum + game.score.X, 0) / games.length : 0,
    meanDurationMs: games.length ? totalDurationMs / games.length : 0,
    decisions: times.length,
    meanCheatsPlayed: games.length ? games.reduce((sum, game) => sum + game.cheatsPlayed, 0) / games.length : 0,
    meanNodePowerGain: games.length ? totalNodePower / games.length : 0,
    nodePowerPerTurn: totalTurns ? totalNodePower / totalTurns : 0,
    nodePowerPerSecond: totalDurationMs ? totalNodePower / (totalDurationMs / 1_000) : 0,
    latencyMs: {
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      p99: percentile(times, 0.99),
      p999: percentile(times, 0.999),
      max: times.at(-1) ?? 0,
    },
    losingSeeds: games
      .filter((game) => !game.won)
      .map((game) => ({
        seed: game.seed,
        handicapSeed: game.handicapSeed,
        defenseSeed: game.defenseSeed,
        tieRoll: game.tieRoll,
        margin: game.score.X - game.score.O,
      })),
  };
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

function coordinateFlag(name: string): readonly [number, number] | undefined {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return undefined;
  const [rawX, rawY] = (Bun.argv[index + 1] ?? "").split(",");
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`${name} must be an x,y coordinate`);
  }
  return [x, y];
}

async function main(): Promise<void> {
  const count = Math.max(1, Math.floor(numberFlag("--games", 24)));
  const start = numberFlag("--seed", 1_000);
  const handicapStart = numberFlag("--handicap-seed", Math.floor(start) ^ 0xa5a5a5a5);
  const defenseStart = numberFlag("--defense-seed", Math.floor(start) ^ 0x3c6ef372);
  const stepIndex = Bun.argv.indexOf("--seed-step");
  const seeds = stepIndex >= 0
    ? Array.from({ length: count }, (_, index) => start + index * Number(Bun.argv[stepIndex + 1] ?? 4_000))
    : goArenaSeeds(count, start);
  const handicapSeeds = goArenaHandicapSeeds(count, handicapStart);
  const defenseSeeds = goArenaHandicapSeeds(count, defenseStart);
  const allTies = Bun.argv.includes("--all-ties");
  const requested: (number | undefined)[] = allTies
    ? [0, 0.25, 0.5, 0.75, 0.999999]
    : [undefined];
  const includeTrace = Bun.argv.includes("--trace");
  const candidateLimitIndex = Bun.argv.indexOf("--candidate-limit");
  const candidateLimit = candidateLimitIndex >= 0 ? Number(Bun.argv[candidateLimitIndex + 1]) : undefined;
  const forcedOpening = coordinateFlag("--opening");
  const cheatEnabled = Bun.argv.includes("--cheat");
  const cheatChance = Bun.argv.includes("--cheat-chance")
    ? numberFlag("--cheat-chance", 1)
    : undefined;
  const cheatCandidateLimit = Bun.argv.includes("--cheat-k")
    ? Math.max(0, Math.floor(numberFlag("--cheat-k", 4)))
    : undefined;
  const cheatDoubleMoveLimit = Bun.argv.includes("--cheat-double-k")
    ? Math.max(1, Math.floor(numberFlag("--cheat-double-k", 2)))
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
    // The secret opponent plays on a 19x19 board regardless of requested size.
    const playedSize = opponent.name === "????????????" ? 19 : opponent.requestedSize;
    console.log(JSON.stringify({ type: "config", opponent: opponent.name,
      candidateLimit: candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS[goModelProfile(playedSize)],
      candidateLimitSource: candidateLimit === undefined ? "profile-default" : "explicit" }));
    const games: GoArenaGameResult[] = [];
    for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
      const seed = seeds[seedIndex]!;
      const handicapSeed = handicapSeeds[seedIndex]!;
      const defenseSeed = defenseSeeds[seedIndex]!;
      for (const tieRoll of requested) {
        const game = await playGoArenaGame(opponent, seed, tieRoll, includeTrace, {
          handicapSeed,
          defenseSeed: allTies ? null : defenseSeed,
          ...(candidateLimit !== undefined ? { candidateLimit } : {}),
          ...(forcedOpening ? { forcedOpening } : {}),
          ...(cheatEnabled ? { cheat: {
            enabled: true,
            ...(cheatChance !== undefined ? { successChance: cheatChance } : {}),
            ...(cheatCandidateLimit !== undefined ? { candidateLimit: cheatCandidateLimit } : {}),
            ...(cheatDoubleMoveLimit !== undefined ? { doubleMoveLimit: cheatDoubleMoveLimit } : {}),
          } } : {}),
        });
        games.push(game);
        if (includeTrace) console.log(JSON.stringify({ type: "game", ...game }));
      }
    }
    console.log(JSON.stringify(summarizeGoArena(opponent.name, games)));
  }
}

// No top-level await: the WebGPU harness bundles this module into an iife.
if (import.meta.main) void main();

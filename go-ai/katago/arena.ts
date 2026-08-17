/** Independent KataGo adviser benchmark arena.
 *
 * This deliberately does not import or modify the native population trainer.
 * KataGo proposes one black move from the public position; the independently
 * vendored Bitburner AI plays white and the IPvGO rules implementation alone
 * determines legality and the terminal result.
 */
import {
  GO_ARENA_OPPONENTS,
  goArenaSeedPairs,
  playGoArenaImmediateReply,
  playGoArenaPolicyGame,
  summarizeGoArena,
  type ForcedBlackAction,
  type GoArenaGameResult,
  type GoArenaInitialState,
  type GoArenaOpponent,
} from "../teacher/arena.ts";
import { oracleInitialBoard } from "../teacher/oracle.ts";
import { playMove, scoreBoard, type GoBoard } from "../teacher/strategy/decide.ts";
import { goDifficultyMultiplier } from "../teacher/strategy/rewards.ts";
import { alignedAiSeed, GO_ENGINE_CYCLE_MS } from "../teacher/strategy/rng.ts";
import { GoColor, GoOpponent, GoPlayType } from "../../sim/vendor/bitburner/src/Go/Enums.ts";
import { getMove } from "../../sim/vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import { getNewBoardStateFromSimpleBoard } from "../../sim/vendor/bitburner/src/Go/boardState/boardState.ts";
import { Go, sleepLog } from "../../sim/vendor/bitburner/src/Go/OracleStubs.ts";
import {
  KATAGO_COMMIT,
  KATAGO_MODELS,
  KATAGO_VERSION,
  KataGoAdvisor,
  type KataGoAdvice,
  type KataGoMove,
} from "./advisor.ts";
import { PredictiveKataGoAdvisor, type PredictiveKataGoAdvice } from "./predictive-advisor.ts";

export interface AdviserGameResult extends GoArenaGameResult {
  advice: KataGoAdvice[];
  offlinePoints: number;
}

function isPredictiveAdvice(
  advice: KataGoAdvice | PredictiveKataGoAdvice,
): advice is PredictiveKataGoAdvice {
  return "predictedWhite" in advice;
}

function summarizeWithPower(
  opponent: GoArenaOpponent,
  games: readonly GoArenaGameResult[],
) {
  const summary = summarizeGoArena(opponent.name, games);
  const difficulty = goDifficultyMultiplier(opponent.name, games[0]?.size ?? opponent.requestedSize);
  const rounds = games.reduce((sum, game) => sum + game.planningMs.length, 0);
  const gamePower = games.reduce((sum, game) => sum + game.score.X * difficulty, 0);
  const trainingPower = games.reduce((sum, game) =>
    sum + game.score.X * difficulty * (game.won ? 1 : 0.5), 0);
  const winningRounds = games.reduce((sum, game) =>
    sum + (game.won ? game.planningMs.length : 0), 0);
  const winningPower = games.reduce((sum, game) =>
    sum + (game.won ? game.score.X * difficulty : 0), 0);
  return {
    ...summary,
    meanRounds: rounds / Math.max(games.length, 1),
    gamePowerPerRound: gamePower / Math.max(rounds, 1),
    trainingPowerPerRound: trainingPower / Math.max(rounds, 1),
    winningPowerPerRound: winningPower / Math.max(winningRounds, 1),
  };
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function oracleState(
  board: GoBoard,
  history: readonly string[][],
  consecutivePasses: number,
  opponent: GoOpponent,
) {
  const reconstruction = opponent === GoOpponent.w0r1d_d43m0n
    ? GoOpponent.Illuminati : opponent;
  const state = getNewBoardStateFromSimpleBoard(board.rows, undefined, reconstruction, GoColor.black);
  state.previousBoards = history.map((position) => position.join(""));
  state.passCount = consecutivePasses;
  state.ai = opponent;
  Go.currentGame = state;
  return state;
}

export async function playAdviserGame(
  adviser: KataGoAdvisor,
  predictive: PredictiveKataGoAdvisor | undefined,
  definition: GoArenaOpponent,
  seed: number,
  handicapSeed: number,
  defenseSeed: number | null,
  tieRoll: number | null,
  visits: number,
  policyVisits: number,
  candidates: number,
  includeTrace: boolean,
  initialState?: GoArenaInitialState,
  forcedOpening?: ForcedBlackAction,
): Promise<AdviserGameResult> {
  let board = initialState
    ? { size: initialState.board.size, rows: [...initialState.board.rows] }
    : oracleInitialBoard(definition.requestedSize, definition.oracle, seed, handicapSeed);
  const offlinePoints = board.rows.reduce((count, column) =>
    count + [...column].filter((cell) => cell === "#").length, 0);
  const history: string[][] = initialState
    ? initialState.previousBoards.map((position) => [...position])
    : [];
  let consecutivePasses = initialState?.consecutivePasses ?? 0;
  let turns = 0;
  let dispatchPlaytime = initialState?.dispatchPlaytime
    ?? Math.floor(seed / GO_ENGINE_CYCLE_MS) * GO_ENGINE_CYCLE_MS;
  const startedPlaytime = dispatchPlaytime;
  const planningMs: number[] = [];
  const advice: KataGoAdvice[] = [];
  const trace: NonNullable<GoArenaGameResult["trace"]> = [];
  const maxTurns = board.size * board.size * 8;
  const originalRandom = Math.random;
  if (defenseSeed === null && tieRoll === null) {
    throw new Error("fixed-roll diagnostics require an explicit tie roll");
  }
  let defenseState = (defenseSeed ?? 0) >>> 0;
  const defenseRandom = defenseSeed === null
    ? () => tieRoll!
    : () => {
      defenseState = (Math.imul(defenseState, 1_664_525) + 1_013_904_223) >>> 0;
      return defenseState / 0x1_0000_0000;
    };
  try {
    while (consecutivePasses < 2 && turns < maxTurns) {
      const turnDefenseRoll = defenseRandom();
      const before = [...board.rows];
      const beforeHistory = history.map((position) => [...position]);
      const beforePasses = consecutivePasses;
      const beforePlaytime = dispatchPlaytime;
      const started = performance.now();
      const selected: KataGoAdvice | PredictiveKataGoAdvice = turns === 0 && forcedOpening
        ? { move: forcedOpening, proposalMoves: [forcedOpening], visits: 0 }
        : predictive
        ? await predictive.advise({
          board,
          previousBoards: history,
          consecutivePasses,
          elapsedRounds: Math.ceil(turns / 2),
          komi: definition.komi,
          policyVisits,
          replyVisits: visits,
          candidates,
          predict: async (candidate) => {
            const prediction = await playGoArenaImmediateReply(
              definition,
              turnDefenseRoll,
              {
                board,
                previousBoards: history,
                consecutivePasses,
                dispatchPlaytime,
              },
              candidate,
            );
            const move: KataGoMove = prediction.white.type === "move"
              ? [prediction.white.x, prediction.white.y]
              : "pass";
            const terminal = candidate === "pass"
              && (consecutivePasses > 0 || move === "pass");
            const score = scoreBoard(prediction.after, definition.komi);
            const forcedWinningEnd = candidate !== "pass" && move === "pass" && score.X >= score.O;
            return {
              move,
              after: prediction.after,
              ...(terminal || forcedWinningEnd ? {
                exactScore: score,
                exactRemainingRounds: terminal ? 1 as const : 2 as const,
              } : {}),
            };
          },
        })
        : await (async (): Promise<KataGoAdvice> => {
          const proposals = await adviser.shortlist(
            board, history, definition.komi, visits,
            Math.max(1, Math.floor(candidates)),
          );
          const best = proposals[0];
          if (!best) throw new Error("KataGo returned an empty adviser shortlist");
          return { ...best, proposalMoves: proposals.map((proposal) => proposal.move) };
        })();
      planningMs.push(performance.now() - started);
      advice.push(selected);

      if (selected.move === "pass") {
        consecutivePasses++;
      } else {
        const played = playMove(
          board, selected.move[0], selected.move[1], "X",
          new Set(history.map((position) => position.join(""))),
        );
        if (!played) {
          throw new Error(`KataGo returned illegal black move ${selected.move} on seed ${seed}`);
        }
        history.unshift(board.rows);
        board = played.board;
        consecutivePasses = 0;
      }
      turns++;
      if (consecutivePasses >= 2) {
        if (includeTrace) {
          trace.push({
            turn: turns - 1,
            dispatchPlaytime: beforePlaytime,
            board: before,
            previousBoards: beforeHistory,
            consecutivePasses: beforePasses,
            black: selected.move === "pass"
              ? { type: "pass" }
              : { type: "move", x: selected.move[0], y: selected.move[1] },
            policyBook: false,
            predicted: [],
            white: { type: "pass" },
            planningMs: planningMs.at(-1)!,
          });
        }
        break;
      }

      const state = oracleState(board, history, consecutivePasses, definition.oracle);
      Math.random = () => turnDefenseRoll;
      sleepLog.length = 0;
      const white = await getMove(
        state, GoColor.white, definition.oracle, false, alignedAiSeed(dispatchPlaytime, 0),
      );
      const waitMs = sleepLog.reduce((sum, milliseconds) => sum + milliseconds, 0)
        + (white.type === GoPlayType.move ? GO_ENGINE_CYCLE_MS : 0);
      if (isPredictiveAdvice(selected)) {
        const actual: KataGoMove = white.type === GoPlayType.move ? [white.x, white.y] : "pass";
        const same = selected.predictedWhite === "pass"
          ? actual === "pass"
          : actual !== "pass"
            && selected.predictedWhite[0] === actual[0]
            && selected.predictedWhite[1] === actual[1];
        if (!same) {
          throw new Error(`predicted ${selected.predictedWhite} but oracle played ${actual} on seed ${seed}`);
        }
      }
      dispatchPlaytime += Math.floor(waitMs / GO_ENGINE_CYCLE_MS) * GO_ENGINE_CYCLE_MS;
      let whiteNoOp = false;
      if (white.type === GoPlayType.move) {
        const played = playMove(
          board, white.x, white.y, "O",
          new Set(history.map((position) => position.join(""))),
        );
        if (played) {
          history.unshift(board.rows);
          board = played.board;
          consecutivePasses = 0;
        } else {
          whiteNoOp = true;
        }
      } else consecutivePasses++;

      if (includeTrace) {
        trace.push({
          turn: turns - 1,
          dispatchPlaytime: beforePlaytime,
          board: before,
          previousBoards: beforeHistory,
          consecutivePasses: beforePasses,
          black: selected.move === "pass"
            ? { type: "pass" }
            : { type: "move", x: selected.move[0], y: selected.move[1] },
          policyBook: false,
          predicted: isPredictiveAdvice(selected)
            ? [selected.predictedWhite === "pass"
              ? { x: null, y: null, count: 1 }
              : { x: selected.predictedWhite[0], y: selected.predictedWhite[1], count: 1 }]
            : [],
          white: white.type === GoPlayType.move
            ? { type: "move", x: white.x, y: white.y, ...(whiteNoOp ? { noOp: true } : {}) }
            : { type: "pass" },
          planningMs: planningMs.at(-1)!,
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
    advice,
    offlinePoints,
    ...(includeTrace ? { trace } : {}),
  };
}

function selectedOpponents(): GoArenaOpponent[] {
  const index = Bun.argv.indexOf("--opponent");
  if (index < 0) return [...GO_ARENA_OPPONENTS];
  const query = (Bun.argv[index + 1] ?? "").toLowerCase();
  return GO_ARENA_OPPONENTS.filter((opponent) =>
    ((query === "secret" || query === "world-daemon") && opponent.name === "????????????")
    || opponent.name.toLowerCase().includes(query));
}

async function main(): Promise<void> {
  const games = Math.max(1, Math.floor(numberFlag("--games", 16)));
  const visits = Math.max(2, Math.floor(numberFlag("--visits", 32)));
  const seedStart = numberFlag("--seed", 31_337_000);
  const handicapSeedStart = numberFlag("--handicap-seed", 1_618_033_988);
  const defenseSeedStart = numberFlag("--defense-seed", 1_013_904_223);
  const defaultBackend = process.platform === "darwin" ? "opencl" : "eigen";
  const binary = stringFlag("--binary", `go-ai/.deps/KataGo/build/ipvgo-${defaultBackend}/katago`);
  const config = stringFlag("--config", "go-ai/katago/config/analysis.cfg");
  const output = stringFlag("--out", "");
  const includeTrace = Bun.argv.includes("--trace");
  const includeControl = !Bun.argv.includes("--no-control");
  const predictiveMode = Bun.argv.includes("--predictive");
  const policyVisits = Math.max(2, Math.floor(numberFlag("--policy-visits", 2)));
  const requestedProfile = stringFlag("--profile", "");
  const allTies = Bun.argv.includes("--all-ties");
  const ties: (number | null)[] = allTies
    ? [0, 0.25, 0.5, 0.75, 0.999999]
    : [null];
  const cases = goArenaSeedPairs(games, seedStart, handicapSeedStart, defenseSeedStart);
  const summaries: unknown[] = [];

  for (const profile of ["small5", "daemon19"] as const) {
    if (requestedProfile && requestedProfile !== profile) continue;
    const opponents = selectedOpponents().filter((opponent) =>
      profile === "daemon19" ? opponent.name === "????????????" : opponent.name !== "????????????");
    if (!opponents.length) continue;
    const model = stringFlag(profile === "small5" ? "--small-model" : "--daemon-model", KATAGO_MODELS[profile].file);
    const adviser = new KataGoAdvisor(binary, model, config);
    const predictive = predictiveMode ? new PredictiveKataGoAdvisor(adviser) : undefined;
    const candidates = Math.max(1, Math.floor(numberFlag(
      "--candidates", profile === "small5" ? 6 : 4,
    )));
    try {
      for (const opponent of opponents) {
        const adviserGames: AdviserGameResult[] = [];
        for (const { seed, handicapSeed, defenseSeed } of cases) for (const tie of ties) {
          const game = await playAdviserGame(
            adviser,
            predictive,
            opponent,
            seed,
            handicapSeed,
            allTies ? null : defenseSeed,
            tie,
            visits,
            policyVisits,
            candidates,
            includeTrace,
          );
          adviserGames.push(game);
          if (includeTrace) console.log(JSON.stringify({ type: "katago-game", ...game }));
        }
        const adviserSummary = summarizeWithPower(opponent, adviserGames);
        // The vendored oracle stores its game in a process-global stub, so
        // parallel control games would cross-contaminate one another.
        const controlGames: GoArenaGameResult[] = [];
        if (includeControl) {
          for (const { seed, handicapSeed, defenseSeed } of cases) for (const tie of ties) {
            controlGames.push(await playGoArenaPolicyGame(
              opponent, seed, tie ?? undefined, false, undefined, handicapSeed,
              allTies ? null : defenseSeed,
            ));
          }
        }
        const controlSummary = includeControl
          ? summarizeWithPower(opponent, controlGames) : undefined;
        const summary = {
          opponent: opponent.name,
          profile,
          visits,
          mode: predictiveMode ? "predictive" : "plain",
          ...(predictiveMode ? { policyVisits, candidates } : {}),
          model,
          [predictiveMode ? "predictiveKatago" : "katago"]: adviserSummary,
          ...(controlSummary ? { handcraftedControl: controlSummary } : {}),
          meanOfflinePoints: adviserGames.reduce((sum, game) => sum + game.offlinePoints, 0)
            / adviserGames.length,
        };
        summaries.push(summary);
        console.log(JSON.stringify(summary));
      }
    } finally {
      await adviser.close();
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    kataGo: { version: KATAGO_VERSION, commit: KATAGO_COMMIT },
    gamesPerOpponent: games * ties.length,
    seedStart,
    visits,
    mode: predictiveMode ? "predictive" : "plain",
    ...(predictiveMode ? { policyVisits } : {}),
    ties,
    summaries,
  };
  if (output) await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) await main();

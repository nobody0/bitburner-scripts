/** Generate honest action-value examples from complete games.
 *
 * For every state on a real teacher trajectory, force each legal black action
 * once, observe the immediate upstream faction response, then finish that
 * complete game with either the frozen teacher or the current learner. The
 * learner receives no RNG seed: each row contains the candidate and the
 * response that seed produced.
 */
import {
  GO_ARENA_OPPONENTS,
  goArenaSeeds,
  decideGoArenaBlack,
  playGoArenaPolicyGame,
  playGoArenaPositionTrace,
  type ArenaBlackPolicy,
  type ForcedBlackAction,
  type GoArenaInitialState,
} from "./arena.ts";
import {
  legalMoves,
  playMove,
  type GoBoard,
} from "./strategy/decide.ts";
import { goDifficultyMultiplier } from "./strategy/rewards.ts";
import { candidateModelPolicyWithCandidates, loadCandidateModel } from "./model.ts";

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function mixedDefinition(game: number, start: number) {
  let state = (Math.imul(game + 1, 1_664_525) + Math.floor(start) + 1_013_904_223) >>> 0;
  const opponentIndex = state % GO_ARENA_OPPONENTS.length;
  const base = GO_ARENA_OPPONENTS[opponentIndex]!;
  state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  const sizes = [5, 7, 9, 13] as const;
  return base.name === "????????????"
    ? base
    : { ...base, requestedSize: sizes[state % sizes.length]! };
}

function small5Definition(game: number, start: number) {
  const state = (Math.imul(game + 1, 1_664_525) + Math.floor(start) + 1_013_904_223) >>> 0;
  return { ...GO_ARENA_OPPONENTS[state % 6]!, requestedSize: 5 as const };
}

function sampledStates(length: number, limit: number): number[] {
  if (limit <= 0 || length <= limit) return Array.from({ length }, (_, index) => index);
  if (limit === 1) return [0];
  return Array.from({ length: limit }, (_, index) => Math.round(index * (length - 1) / (limit - 1)));
}

function sampledActions(
  actions: readonly ForcedBlackAction[],
  selected: { type: "move"; x: number; y: number } | { type: "pass" },
  limit: number,
  salt: number,
): ForcedBlackAction[] {
  if (limit <= 0 || actions.length <= limit) return [...actions];
  const selectedAction: ForcedBlackAction = selected.type === "pass"
    ? "pass" : [selected.x, selected.y];
  const key = (move: ForcedBlackAction) => move === "pass" ? "pass" : `${move[0]},${move[1]}`;
  const mandatory = new Map<string, ForcedBlackAction>([[key(selectedAction), selectedAction], ["pass", "pass"]]);
  const remaining = actions.filter((move) => !mandatory.has(key(move))).sort((a, b) => {
    const hash = (move: ForcedBlackAction) => {
      const [x, y] = moveFields(move);
      return (Math.imul(salt ^ (x + 2) * 65537, 1_664_525) + (y + 2) * 1_013_904_223) >>> 0;
    };
    return hash(a) - hash(b);
  });
  return [...mandatory.values(), ...remaining.slice(0, Math.max(0, limit - mandatory.size))];
}

function exploratoryPolicy(
  base: ArenaBlackPolicy,
  probability: number,
  salt: number,
): ArenaBlackPolicy {
  if (probability <= 0) return base;
  let explored = false;
  return (input) => {
    if (explored) return base(input);
    let state = (Math.imul(salt ^ Math.floor(input.dispatchPlaytime / 200), 1_664_525)
      + 1_013_904_223) >>> 0;
    for (const row of input.board.rows) for (let index = 0; index < row.length; index++) {
      state = (Math.imul(state ^ row.charCodeAt(index), 1_664_525) + 1_013_904_223) >>> 0;
    }
    if (state / 0x1_0000_0000 >= probability) return base(input);
    explored = true;
    const actions: ForcedBlackAction[] = [
      ...legalMoves(input.board, "X", input.previousBoards),
      "pass",
    ];
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const action = actions[state % actions.length]!;
    return {
      action: action === "pass"
        ? { type: "pass", why: "offline learner exploration" }
        : { type: "move", x: action[0], y: action[1], why: "offline learner exploration" },
      ranked: [],
      why: "offline learner exploration",
      finalists: actions.length,
      positionValue: 0,
    };
  };
}

function moveFields(move: ForcedBlackAction): readonly [number, number] {
  return move === "pass" ? [-1, -1] : move;
}

function sameMove(
  move: ForcedBlackAction,
  selected: { type: "move"; x: number; y: number } | { type: "pass" },
): boolean {
  return move === "pass"
    ? selected.type === "pass"
    : selected.type === "move" && move[0] === selected.x && move[1] === selected.y;
}

function resultingBoard(
  state: GoArenaInitialState,
  black: ForcedBlackAction,
  white: { type: "move"; x: number; y: number } | { type: "pass" },
): GoBoard {
  const prior = new Set(state.previousBoards.map((board) => board.join("")));
  let board = state.board;
  if (black !== "pass") {
    const played = playMove(board, black[0], black[1], "X", prior);
    if (!played) throw new Error(`teacher exporter forced illegal move ${black}`);
    prior.add(board.rows.join(""));
    board = played.board;
  }
  if (white.type === "move") {
    const played = playMove(board, white.x, white.y, "O", prior);
    if (!played) throw new Error(`teacher oracle returned illegal move ${white.x},${white.y}`);
    board = played.board;
  }
  return board;
}

async function main(): Promise<void> {
  const games = Math.max(1, Math.floor(numberFlag("--games", 8)));
  const start = numberFlag("--seed", 24301);
  const gameOffset = Math.max(0, Math.floor(numberFlag("--game-offset", 0)));
  const mixed = Bun.argv.includes("--mixed");
  const small5 = Bun.argv.includes("--small5");
  const daemon19 = Bun.argv.includes("--daemon19");
  if (Number(mixed) + Number(small5) + Number(daemon19) > 1) {
    throw new Error("choose only one of --mixed, --small5, or --daemon19");
  }
  const maxCandidates = Math.max(0, Math.floor(numberFlag("--max-candidates", 0)));
  const statesPerGame = Math.max(0, Math.floor(numberFlag("--states-per-game", 0)));
  const variations = Math.max(1, Math.floor(numberFlag("--variations", 1)));
  const exploration = Math.max(0, Math.min(1, numberFlag("--exploration", 0)));
  const learnerContinuations = Bun.argv.includes("--learner-continuations");
  const trajectoryOnly = Bun.argv.includes("--trajectory-only");
  const teacherShortlist = Math.max(0, Math.floor(numberFlag("--teacher-shortlist", 0)));
  const teacherCandidates = Math.max(0, Math.floor(numberFlag("--teacher-candidates", 0)));
  const teacherOverrideMargin = Math.max(0, numberFlag("--teacher-override-margin", 0));
  const query = stringFlag("--opponent", "Illuminati").toLowerCase();
  const output = stringFlag("--out", "go-ai/teacher-illuminati.tsv");
  const modelPath = stringFlag("--model", "");
  const fixedDefinition = GO_ARENA_OPPONENTS.find(({ name }) => name.toLowerCase().includes(query));
  if (!mixed && !small5 && !daemon19 && !fixedDefinition) {
    throw new Error(`unknown teacher opponent ${query}`);
  }
  const loadedModel = modelPath ? await loadCandidateModel(modelPath) : undefined;
  if ((exploration > 0 || learnerContinuations) && !loadedModel) {
    throw new Error("--exploration and --learner-continuations require --model");
  }
  const modelPolicies = new Map<number, ReturnType<typeof candidateModelPolicy>>();
  const writer = Bun.file(output).writer();
  writer.write("# bitburner-go-teacher-v1\n");
  writer.write("# game state candidate opponent size elapsed remaining won power selected bx by wx wy before after\n");
  let states = 0;
  let examples = 0;
  let wins = 0;
  let trajectoryFallbacks = 0;
  let continuationFallbacks = 0;
  let totalTrainingPower = 0;
  let totalRounds = 0;
  const seeds = goArenaSeeds(games + gameOffset, start).slice(gameOffset);
  for (let game = 0; game < games; game++) {
    const globalGame = game + gameOffset;
    const definition = mixed ? mixedDefinition(globalGame, start)
      : small5 ? small5Definition(globalGame, start)
      : daemon19 ? GO_ARENA_OPPONENTS[6]!
      : fixedDefinition!;
    const opponentIndex = GO_ARENA_OPPONENTS.findIndex(({ name }) => name === definition.name);
    let modelPolicy = modelPolicies.get(opponentIndex);
    if (loadedModel && !modelPolicy) {
      modelPolicy = candidateModelPolicyWithCandidates(
        loadedModel,
        opponentIndex,
        teacherShortlist > 0 ? (input) => {
          const decision = decideGoArenaBlack(
            input.board, input.previousBoards, input.opponent, input.komi,
            input.dispatchPlaytime, input.consecutivePasses,
          );
          if (decision.action.type === "pass") return [undefined];
          if (decision.action.type !== "move") throw new Error("teacher shortlist returned non-playing action");
          const ranked = decision.ranked.slice(0, teacherShortlist)
            .map((move) => [move.x, move.y] as const);
          if (!ranked.some(([x, y]) => x === decision.action.x && y === decision.action.y)) {
            ranked.unshift([decision.action.x, decision.action.y]);
          }
          return ranked;
        } : undefined,
        teacherOverrideMargin,
      );
      modelPolicies.set(opponentIndex, modelPolicy);
    }
    const seed = seeds[game]!;
    const trajectoryPolicy = modelPolicy
      ? exploratoryPolicy(modelPolicy, exploration, globalGame ^ Math.floor(start))
      : undefined;
    let baseline = await playGoArenaPolicyGame(
      definition, seed, 0.5, true, trajectoryPolicy,
      (globalGame * 2_654_435_761 + Math.floor(start)) >>> 0,
    );
    if (!baseline.completed && exploration > 0 && modelPolicy) {
      trajectoryFallbacks++;
      baseline = await playGoArenaPolicyGame(
        definition, seed, 0.5, true, modelPolicy,
        (globalGame * 2_654_435_761 + Math.floor(start)) >>> 0,
      );
    }
    if (!baseline.completed && modelPolicy) {
      trajectoryFallbacks++;
      baseline = await playGoArenaPolicyGame(
        definition, seed, 0.5, true, undefined,
        (globalGame * 2_654_435_761 + Math.floor(start)) >>> 0,
      );
    }
    if (!baseline.completed) {
      throw new Error(`teacher trajectory ${globalGame} did not reach two passes`);
    }
    wins += Number(baseline.won);
    totalTrainingPower += baseline.score.X
      * goDifficultyMultiplier(definition.name, baseline.size)
      * (baseline.won ? 1 : 0.5);
    totalRounds += Math.ceil(baseline.turns / 2);
    const trace = baseline.trace ?? [];
    const stateLimit = statesPerGame || (baseline.size === 5 ? 0 : 16);
    const stateIndexes = trajectoryOnly ? [] : sampledStates(trace.length, stateLimit);
    for (const stateIndex of stateIndexes) {
      const turn = trace[stateIndex]!;
      const state: GoArenaInitialState = {
        board: { size: turn.board.length, rows: [...turn.board] },
        previousBoards: turn.previousBoards.map((board) => [...board]),
        consecutivePasses: turn.consecutivePasses,
        dispatchPlaytime: turn.dispatchPlaytime,
      };
      const allActions: ForcedBlackAction[] = teacherCandidates > 0
        ? (() => {
          const decision = decideGoArenaBlack(
            state.board, state.previousBoards, definition.name, definition.komi,
            state.dispatchPlaytime, state.consecutivePasses,
          );
          if (decision.action.type === "pass") return ["pass"];
          if (decision.action.type !== "move") throw new Error("teacher candidates returned non-playing action");
          const moves: ForcedBlackAction[] = decision.ranked.slice(0, teacherCandidates)
            .map((move) => [move.x, move.y] as const);
          if (!moves.some((move) => move !== "pass"
            && move[0] === decision.action.x && move[1] === decision.action.y)) {
            moves.unshift([decision.action.x, decision.action.y]);
          }
          return moves;
        })()
        : [...legalMoves(state.board, "X", state.previousBoards), "pass"];
      const actionLimit = maxCandidates || (baseline.size === 5 ? 0 : 32);
      const actions = sampledActions(allActions, turn.black, actionLimit, globalGame * 4099 + stateIndex);
      for (let candidateIndex = 0; candidateIndex < actions.length; candidateIndex++) {
        const action = actions[candidateIndex]!;
        const continuations = [];
        for (let variation = 0; variation < variations; variation++) {
          const salt = (
            Math.imul(globalGame + 1, 2_654_435_761)
            ^ Math.imul(stateIndex + 1, 2_246_822_519)
            ^ Math.imul(candidateIndex + 1, 3_266_489_917)
            ^ Math.imul(variation + 1, 668_265_263)
          ) >>> 0;
          let continuation = await playGoArenaPositionTrace(
            definition, seed, 0.5, state, action, salt,
            learnerContinuations ? modelPolicy : undefined,
          );
          if (!continuation.completed && learnerContinuations) {
            continuationFallbacks++;
            continuation = await playGoArenaPositionTrace(
              definition, seed, 0.5, state, action, salt,
            );
          }
          continuations.push(continuation);
        }
        if (continuations.some((continuation) => !continuation.completed)) {
          throw new Error(
            `counterfactual game=${globalGame} state=${stateIndex} candidate=${candidateIndex} did not terminate`,
          );
        }
        const immediate = continuations[0]!.trace?.[0];
        const white = immediate?.white ?? { type: "pass" as const };
        const after = resultingBoard(state, action, white);
        const [bx, by] = moveFields(action);
        const [wx, wy] = white.type === "move" ? [white.x, white.y] : [-1, -1];
        const won = continuations.reduce((sum, continuation) => sum + Number(continuation.won), 0)
          / continuations.length;
        const power = continuations.reduce((sum, continuation) => sum
          + continuation.score.X
            * goDifficultyMultiplier(definition.name, continuation.size)
            * (continuation.won ? 1 : 0.5), 0) / continuations.length;
        const remaining = continuations.reduce(
          (sum, continuation) => sum + Math.ceil(continuation.turns / 2), 0,
        ) / continuations.length;
        const selected = sameMove(action, turn.black) ? 1 : 0;
        writer.write([
          globalGame, stateIndex, candidateIndex, opponentIndex, continuations[0]!.size,
          stateIndex, remaining, won,
          power, selected, bx, by, wx, wy, state.board.rows.join(""), after.rows.join(""),
        ].join("\t") + "\n");
        examples++;
      }
      states++;
    }
  }
  await writer.end();
  console.log(JSON.stringify({
    output, games, gameOffset, profile: mixed ? "mixed" : small5 ? "small5"
      : daemon19 ? "daemon19" : "fixed",
    variations, exploration, trajectoryOnly,
    continuations: learnerContinuations ? "learner" : "teacher",
    teacherShortlist,
    teacherCandidates,
    teacherOverrideMargin,
    source: modelPath || "frozen-teacher",
    wins, winRate: wins / games, states, examples,
    totalTrainingPower, totalRounds,
    trainingPowerPerRound: totalTrainingPower / Math.max(totalRounds, 1),
    trajectoryFallbacks, continuationFallbacks,
  }));
}

if (import.meta.main) await main();

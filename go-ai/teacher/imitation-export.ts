/** Fast teacher-policy corpus.
 *
 * Complete games establish real teacher states and terminal labels. At each
 * sampled state every legal black candidate is paired only with its currently
 * knowable immediate faction response. No counterfactual future is rolled out;
 * this file is intended for position-local teacher ranking.
 */
import {
  GO_ARENA_OPPONENTS,
  decideGoArenaBlack,
  goArenaSeeds,
  playGoArenaImmediateReply,
  playGoArenaPolicyGame,
  type ForcedBlackAction,
  type GoArenaInitialState,
} from "./arena.ts";
import { legalMoves } from "./strategy/decide.ts";
import { goDifficultyMultiplier } from "./strategy/rewards.ts";
import { candidateModelPolicy, loadCandidateModel } from "./model.ts";

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function sampledStates(length: number, limit: number): number[] {
  if (limit <= 0 || length <= limit) return Array.from({ length }, (_, index) => index);
  if (limit === 1) return [0];
  return Array.from({ length: limit }, (_, index) =>
    Math.round(index * (length - 1) / (limit - 1)));
}

function sameMove(
  move: ForcedBlackAction,
  selected: { type: "move"; x: number; y: number } | { type: "pass" },
): boolean {
  return move === "pass"
    ? selected.type === "pass"
    : selected.type === "move" && move[0] === selected.x && move[1] === selected.y;
}

function fields(move: ForcedBlackAction): readonly [number, number] {
  return move === "pass" ? [-1, -1] : move;
}

function actionKey(move: ForcedBlackAction): string {
  return move === "pass" ? "pass" : `${move[0]},${move[1]}`;
}

async function main(): Promise<void> {
  const games = Math.max(1, Math.floor(numberFlag("--games", 8)));
  const gameOffset = Math.max(0, Math.floor(numberFlag("--game-offset", 0)));
  const seedStart = numberFlag("--seed", 24301);
  const statesPerGame = Math.max(0, Math.floor(numberFlag("--states-per-game", 16)));
  const daemon19 = Bun.argv.includes("--daemon19");
  const small5 = Bun.argv.includes("--small5");
  if (daemon19 === small5) throw new Error("choose exactly one of --small5 or --daemon19");
  const output = stringFlag("--out", "go-ai/teacher-imitation.tsv");
  const modelPath = stringFlag("--model", "");
  const hardNegatives = Bun.argv.includes("--hard-negatives");
  const teacherTrajectories = Bun.argv.includes("--teacher-trajectories");
  if (hardNegatives && !modelPath) throw new Error("--hard-negatives requires --model");
  if (teacherTrajectories && !modelPath) throw new Error("--teacher-trajectories requires --model");
  const loadedModel = modelPath ? await loadCandidateModel(modelPath) : undefined;
  const writer = Bun.file(output).writer();
  writer.write("# bitburner-go-teacher-v1\n");
  writer.write("# game state candidate opponent size elapsed remaining won power selected bx by wx wy before after\n");
  let wins = 0;
  let states = 0;
  let examples = 0;
  let totalTrainingPower = 0;
  let totalRounds = 0;
  const seeds = goArenaSeeds(games + gameOffset, seedStart).slice(gameOffset);
  for (let game = 0; game < games; game++) {
    const globalGame = game + gameOffset;
    const definition = daemon19
      ? GO_ARENA_OPPONENTS[6]!
      : { ...GO_ARENA_OPPONENTS[(globalGame + Math.floor(seedStart / 200)) % 6]!, requestedSize: 5 as const };
    const opponentIndex = GO_ARENA_OPPONENTS.findIndex(({ name }) => name === definition.name);
    const modelPolicy = loadedModel ? candidateModelPolicy(loadedModel, opponentIndex) : undefined;
    const baseline = await playGoArenaPolicyGame(
      definition,
      seeds[game]!,
      0.5,
      true,
      teacherTrajectories ? undefined : modelPolicy,
      (globalGame * 2_654_435_761 + Math.floor(seedStart)) >>> 0,
    );
    if (!baseline.completed) throw new Error(`teacher trajectory ${globalGame} did not terminate`);
    wins += Number(baseline.won);
    totalTrainingPower += baseline.score.X
      * goDifficultyMultiplier(definition.name, baseline.size)
      * (baseline.won ? 1 : 0.5);
    totalRounds += Math.ceil(baseline.turns / 2);
    const trace = baseline.trace ?? [];
    const terminalPower = baseline.score.X
      * goDifficultyMultiplier(definition.name, baseline.size)
      * (baseline.won ? 1 : 0.5);
    for (const stateIndex of sampledStates(trace.length, statesPerGame)) {
      const turn = trace[stateIndex]!;
      const state: GoArenaInitialState = {
        board: { size: turn.board.length, rows: [...turn.board] },
        previousBoards: turn.previousBoards.map((position) => [...position]),
        consecutivePasses: turn.consecutivePasses,
        dispatchPlaytime: turn.dispatchPlaytime,
      };
      const teacherDecision = decideGoArenaBlack(
        state.board,
        state.previousBoards,
        definition.name,
        definition.komi,
        state.dispatchPlaytime,
        state.consecutivePasses,
      );
      if (teacherDecision.action.type !== "move" && teacherDecision.action.type !== "pass") {
        throw new Error(`teacher returned non-playing action ${teacherDecision.action.type}`);
      }
      const teacherAction: ForcedBlackAction = teacherDecision.action.type === "move"
        ? [teacherDecision.action.x, teacherDecision.action.y] : "pass";
      const learnerDecision = teacherTrajectories && modelPolicy
        ? modelPolicy({
          ...state,
          opponent: definition.name,
          komi: definition.komi,
          elapsedRounds: stateIndex,
        })
        : { action: turn.black };
      if (learnerDecision.action.type !== "move" && learnerDecision.action.type !== "pass") {
        throw new Error(`learner returned non-playing action ${learnerDecision.action.type}`);
      }
      const learnerAction: ForcedBlackAction = learnerDecision.action.type === "move"
        ? [learnerDecision.action.x, learnerDecision.action.y] : "pass";
      const actions: ForcedBlackAction[] = hardNegatives
        ? [...new Map([
          [actionKey(teacherAction), teacherAction],
          [actionKey(learnerAction), learnerAction],
          ["pass", "pass" as const],
        ]).values()]
        : [...legalMoves(state.board, "X", state.previousBoards), "pass"];
      for (let candidateIndex = 0; candidateIndex < actions.length; candidateIndex++) {
        const action = actions[candidateIndex]!;
        const reply = await playGoArenaImmediateReply(definition, 0.5, state, action);
        const [bx, by] = fields(action);
        const [wx, wy] = reply.white.type === "move"
          ? [reply.white.x, reply.white.y] : [-1, -1];
        writer.write([
          globalGame, stateIndex, candidateIndex, opponentIndex, baseline.size, stateIndex,
          Math.max(1, trace.length - stateIndex), Number(baseline.won), terminalPower,
          Number(sameMove(action, teacherDecision.action)), bx, by, wx, wy,
          state.board.rows.join(""), reply.after.rows.join(""),
        ].join("\t") + "\n");
        examples++;
      }
      states++;
    }
  }
  await writer.end();
  console.log(JSON.stringify({
    output, games, gameOffset, profile: daemon19 ? "daemon19" : "small5",
    source: modelPath || "frozen-teacher", hardNegatives, teacherTrajectories,
    wins, winRate: wins / games, states, examples,
    totalTrainingPower, totalRounds,
    trainingPowerPerRound: totalTrainingPower / Math.max(totalRounds, 1),
    trajectoryFallbacks: 0, continuationFallbacks: 0,
  }));
}

if (import.meta.main) await main();

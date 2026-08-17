/** Export real V9 outcome/policy records from the two fixed external teachers.
 *
 * The neural champion route remains owned by gpu/train_v9.py. This exporter
 * restores the other two independent sources that the V9 clean cut
 * accidentally disconnected: KataGo for strong ordinary Go and the frozen
 * handcrafted policy for opponent-specific exploitation. Every target comes
 * from a complete game played by the vendored IPvGO oracle. KataGo estimates
 * are never used as value labels.
 */
import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import {
  GO_ARENA_OPPONENTS,
  goArenaSeedPairs,
  playGoArenaPolicyGame,
  type GoArenaGameResult,
  type GoArenaOpponent,
  type GoArenaTurnTrace,
} from "./arena.ts";
import { legalMoves, playMove, type GoBoard } from "./strategy/decide.ts";
import { alignedAiSeed } from "../teacher/strategy/rng.ts";
import {
  encodeOpponentFutureBehavior,
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
  predictOpponentReplies,
} from "../../shared/strategy/go/opponent.ts";
import {
  KATAGO_COMMIT,
  KATAGO_MODELS,
  KataGoAdvisor,
} from "../katago/advisor.ts";
import { playAdviserGame, type AdviserGameResult } from "../katago/arena.ts";
import {
  PredictiveKataGoAdvisor,
  type PredictiveKataGoAdvice,
} from "../katago/predictive-advisor.ts";

const SCHEMA = "bitburner-go-exhaustive-proposals-v9.5";
const OPPONENT_ORACLE = "bitburner-go-ai-v3.0.1";

type Profile = "small5" | "daemon19";
type Source = "katago" | "handcrafted";

export interface CorpusValue {
  state: string;
  behavior: number[];
  elapsed: number;
  won: number;
  score: number;
  remaining: number;
  weight: number;
  author?: string;
  blackPower?: number;
}

interface SavedRecord {
  schema?: string;
  profile?: string;
  teacherSha256?: string;
  kind?: string;
  episode?: number;
  values?: { won?: number }[];
  generation?: { source?: Source };
  example?: { episode?: number; source?: Source };
}

function stringFlag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function numberFlag(name: string, fallback: number): number {
  const value = Number(stringFlag(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

async function checkpoint(path: string, records: readonly object[]): Promise<void> {
  const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const next = `${path}.next`;
  await Bun.write(next, Bun.gzipSync(new TextEncoder().encode(jsonl)));
  await rename(next, path);
}

async function resumePartial(
  path: string,
  profile: Profile,
  teacherSha256: string,
): Promise<{ records: object[]; episodes: number; kataWins: number; handcraftedWins: number }> {
  if (!await Bun.file(path).exists()) {
    return { records: [], episodes: 0, kataWins: 0, handcraftedWins: 0 };
  }
  const text = new TextDecoder().decode(Bun.gunzipSync(
    new Uint8Array(await Bun.file(path).arrayBuffer()),
  ));
  let records = text.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as SavedRecord);
  if (records.some((record) => record.schema !== SCHEMA
    || record.profile !== profile || record.teacherSha256 !== teacherSha256)) {
    throw new Error(`partial adviser corpus is incompatible: ${path}`);
  }
  // Early actor-ranking checkpoints accidentally used the trace's raw move
  // counter (0,2,4,...) instead of the established Black decision index for
  // post-reply elapsed supervision. Normalize on resume before the next
  // checkpoint rewrites the corpus; all alternatives in one row share it.
  for (const record of records as Array<SavedRecord & {
    example?: { elapsed?: number; candidates?: Array<Array<{ elapsed?: number }>> };
  }>) {
    if (record.kind === "actor-ranking" && record.example?.candidates) {
      const elapsed = Number(record.example.elapsed ?? 0) + 1;
      for (const candidate of record.example.candidates) {
        for (const value of candidate) {
          value.elapsed = elapsed;
        }
      }
    }
  }
  const trajectories = records.filter((record) => record.kind === "trajectory");
  const bySource = (source: Source) => trajectories
    .filter((record) => record.generation?.source === source)
    .sort((a, b) => (a.episode ?? -1) - (b.episode ?? -1));
  const kata = bySource("katago");
  const handcrafted = bySource("handcrafted");
  if (kata.length !== handcrafted.length
    || kata.some((record, index) => record.episode !== index)
    || handcrafted.some((record, index) => record.episode !== index)) {
    throw new Error(`partial adviser corpus does not contain complete contiguous episode pairs: ${path}`);
  }
  const wins = (source: SavedRecord[]) => source.reduce(
    (sum, record) => sum + Number(record.values?.[0]?.won === 1), 0,
  );
  // A completed losing route remains valuable terminal supervision, but it
  // cannot establish that the teacher's played move outranks counterfactual
  // alternatives. Early ranking partials included those unsupported labels.
  // Remove them when resuming so the next atomic checkpoint repairs the file.
  const winningRoutes = new Set(trajectories
    .filter((record) => record.values?.[0]?.won === 1)
    .map((record) => `${record.generation?.source}:${record.episode}`));
  const before = records.length;
  records = records.filter((record) => record.kind !== "actor-ranking"
    || winningRoutes.has(`${record.example?.source ?? record.generation?.source}:${record.example?.episode}`));
  console.log(JSON.stringify({
    resumed: path,
    episodes: kata.length,
    droppedLosingRankings: before - records.length,
  }));
  return {
    records,
    episodes: kata.length,
    kataWins: wins(kata),
    handcraftedWins: wins(handcrafted),
  };
}

function boardHash(board: GoBoard): string {
  return board.rows.join("");
}

function legalIndices(board: GoBoard, history: readonly string[][]): number[] {
  return [
    ...legalMoves(board, "X", history).map(([x, y]) => x * board.size + y),
    board.size * board.size,
  ];
}

export function encodedState(
  board: GoBoard,
  history: readonly string[][],
  passes: number,
  responsePass: boolean,
  responseNoOp = false,
): string {
  const legal = new Uint8Array(board.size * board.size);
  for (const move of legalIndices(board, history)) {
    if (move < legal.length) legal[move] = 1;
  }
  return `${boardHash(board)}|${Array.from(legal).join("")}|${passes}|${Number(responsePass)}|${Number(responseNoOp)}`;
}

function behaviorFor(trace: GoArenaTurnTrace, opponent: GoArenaOpponent): number[] {
  return Array.from(encodeOpponentTurnBehavior(
    opponentTurnBehavior(opponent.name, alignedAiSeed(trace.dispatchPlaytime, 0)),
    trace.board.length === 5 ? opponent.komi : undefined,
  ));
}

export function futureBehaviorFor(size: number, opponent: GoArenaOpponent): number[] {
  return Array.from(encodeOpponentFutureBehavior(
    opponent.name,
    size === 5 ? opponent.komi : undefined,
  ));
}

export function advance(trace: GoArenaTurnTrace): {
  board: GoBoard; history: string[][]; passes: number; responsePass: boolean; responseNoOp: boolean;
} {
  let board: GoBoard = { size: trace.board.length, rows: [...trace.board] };
  const history = trace.previousBoards.map((position) => [...position]);
  let passes = trace.consecutivePasses;
  if (trace.black.type === "pass") {
    passes++;
  } else {
    const played = playMove(
      board, trace.black.x, trace.black.y, "X",
      new Set(history.map((position) => position.join(""))),
    );
    if (!played) throw new Error("external teacher trace contains an illegal Black move");
    history.unshift(board.rows);
    board = played.board;
    passes = 0;
  }
  if (passes >= 2) return { board, history, passes, responsePass: true, responseNoOp: false };
  if (trace.white.type === "pass") {
    passes++;
    return { board, history, passes, responsePass: true, responseNoOp: false };
  }
  if (trace.white.noOp) {
    return { board, history, passes, responsePass: false, responseNoOp: true };
  }
  const played = playMove(
    board, trace.white.x, trace.white.y, "O",
    new Set(history.map((position) => position.join(""))),
  );
  if (!played) throw new Error("external teacher trace contains an illegal White move");
  history.unshift(board.rows);
  return { board: played.board, history, passes: 0, responsePass: false, responseNoOp: false };
}

function sampledIndices(length: number, limit: number): Set<number> {
  if (limit <= 0) return new Set();
  if (length <= limit) return new Set(Array.from({ length }, (_, index) => index));
  if (limit === 1) return new Set([Math.floor((length - 1) / 2)]);
  return new Set(Array.from({ length: limit }, (_, index) =>
    Math.round(index * (length - 1) / (limit - 1))));
}

export function rankingMoves(
  moves: readonly number[],
  preferredMoves: readonly number[],
  selected: number,
  pass: number,
  negativeLimit: number,
): number[] {
  const protectedMoves = new Set(preferredMoves);
  const preferred = preferredMoves.filter((move, index) =>
    move !== selected && moves.includes(move) && preferredMoves.indexOf(move) === index);
  const negatives = moves.filter((move) => move !== selected && !protectedMoves.has(move)
    && move !== pass);
  const sampled: number[] = [];
  const count = Math.min(negativeLimit, negatives.length);
  for (let index = 0; index < count; index++) {
    const at = Math.floor((index + 0.5) * negatives.length / count);
    sampled.push(negatives[Math.min(at, negatives.length - 1)]!);
  }
  if (pass !== selected && !protectedMoves.has(pass)) sampled.push(pass);
  return [selected, ...preferred, ...new Set(sampled)];
}

function moveKey(move: "pass" | readonly [number, number]): string {
  return move === "pass" ? move : `${move[0]},${move[1]}`;
}

function terminalRank(candidate: PredictiveKataGoAdvice["candidates"][number]): number {
  if (!candidate.exactOutcome) return 0;
  return candidate.evaluation.winrate >= 1 ? 1 : -1;
}

export function predictiveWinGroupMoves(
  advice: PredictiveKataGoAdvice,
  size: number,
): number[] {
  const selected = advice.candidates.find((candidate) =>
    moveKey(candidate.move) === moveKey(advice.move));
  if (!selected) throw new Error("predictive advice omitted its selected candidate");
  return advice.candidates.filter((candidate) =>
    candidate.evaluation.winrate === selected.evaluation.winrate
      && terminalRank(candidate) === terminalRank(selected)).map(({ move }) =>
    move === "pass" ? size * size : move[0] * size + move[1]);
}

export function weightedReplyValues(
  board: GoBoard,
  history: readonly string[][],
  passes: number,
  opponent: GoArenaOpponent,
  seed: number,
  behavior: ArrayLike<number>,
  selected: boolean,
  elapsed: number,
): CorpusValue[] {
  const forecast = predictOpponentReplies(
    board, opponent.name, seed, history, passes,
  );
  return forecast.replies.map((reply) => {
    const replyHistory = history.map((position) => [...position]);
    let after = board;
    let replyPasses = passes;
    let responsePass = false;
    let responseNoOp = false;
    if (!reply.move) {
      replyPasses++;
      responsePass = true;
    } else {
      const played = playMove(
        board, reply.move.x, reply.move.y, "O",
        new Set(replyHistory.map((position) => position.join(""))),
      );
      if (played) {
        replyHistory.unshift(board.rows);
        after = played.board;
        replyPasses = 0;
      } else {
        responseNoOp = true;
      }
    }
    return {
      state: encodedState(after, replyHistory, replyPasses, responsePass, responseNoOp),
      behavior: Array.from(behavior),
      elapsed,
      won: Number(selected),
      score: 0,
      remaining: 1,
      weight: reply.probability,
    };
  });
}

function rankingValues(
  opponent: GoArenaOpponent,
  trace: GoArenaTurnTrace,
  behavior: ArrayLike<number>,
  move: number,
  preferred: boolean,
  elapsed: number,
): CorpusValue[] {
  const size = trace.board.length;
  const pass = size * size;
  const candidate = move === pass
    ? "pass" as const
    : [Math.floor(move / size), move % size] as const;
  const initial = {
    board: { size, rows: [...trace.board] },
    previousBoards: trace.previousBoards.map((position) => [...position]),
    consecutivePasses: trace.consecutivePasses,
    dispatchPlaytime: trace.dispatchPlaytime,
  };
  let afterBlack = initial.board;
  const history = initial.previousBoards.map((position) => [...position]);
  let passes = initial.consecutivePasses;
  if (candidate === "pass") {
    passes++;
  } else {
    const played = playMove(
      afterBlack, candidate[0], candidate[1], "X",
      new Set(history.map((position) => position.join(""))),
    );
    if (!played) throw new Error("ranking candidate became illegal");
    history.unshift(afterBlack.rows);
    afterBlack = played.board;
    passes = 0;
  }
  return weightedReplyValues(
    afterBlack,
    history,
    passes,
    opponent,
    alignedAiSeed(trace.dispatchPlaytime, 0),
    behavior,
    preferred,
    elapsed,
  );
}

async function recordsFor(
  profile: Profile,
  teacherSha256: string,
  opponent: GoArenaOpponent,
  episode: number,
  source: Source,
  game: GoArenaGameResult | AdviserGameResult,
  sourceDetails: Record<string, unknown>,
  rankingStatesPerGame: number,
  rankingNegatives: number,
): Promise<object[]> {
  if (!game.completed || !game.trace?.length) {
    throw new Error(`${source} did not complete traced episode ${episode}`);
  }
  const won = Number(game.won);
  const trainingScore = game.score.X * (game.won ? 1 : 0.5);
  const rounds = game.planningMs.length;
  const values: CorpusValue[] = [];
  const records: object[] = [];
  const split = episode % 10 === 0 ? "heldout" : "train";
  const rankingStates = sampledIndices(game.trace.length, rankingStatesPerGame);
  for (let index = 0; index < game.trace.length; index++) {
    const trace = game.trace[index]!;
    const board: GoBoard = { size: trace.board.length, rows: [...trace.board] };
    const behavior = behaviorFor(trace, opponent);
    const futureBehavior = futureBehaviorFor(board.size, opponent);
    const moves = legalIndices(board, trace.previousBoards);
    const action = trace.black.type === "pass"
      ? board.size * board.size
      : trace.black.x * board.size + trace.black.y;
    if (!moves.includes(action)) throw new Error(`${source} selected a non-legal corpus action`);
    const advice = source === "katago" && "advice" in game
      ? game.advice[index]
      : undefined;
    const predictiveAdvice = advice && "candidates" in advice
      ? advice as PredictiveKataGoAdvice
      : undefined;
    const proposalMoves = advice?.proposalMoves;
    const actions = [...new Set((proposalMoves ?? []).map((move) => move === "pass"
      ? board.size * board.size
      : move[0] * board.size + move[1]))];
    if (!actions.includes(action)) actions.unshift(action);
    if (actions.some((candidate) => !moves.includes(candidate))) {
      throw new Error(`${source} returned a non-legal corpus proposal`);
    }
    // A losing route is valuable terminal supervision, but its played actions
    // are not positive policy labels. Imitating them made the fixed teachers
    // explicitly reinforce their failure modes (most visibly on Illuminati).
    // Keep every route below for outcome/value learning and clone only proposal
    // sets produced along an actually winning teacher trajectory.
    if (game.won) records.push({
      schema: SCHEMA,
      kind: "actor",
      profile,
      teacherSha256,
      opponentOracle: OPPONENT_ORACLE,
      split,
      example: {
        episode,
        state: encodedState(board, trace.previousBoards, trace.consecutivePasses, false),
        behavior,
        elapsed: index,
        moves,
        action,
        actions,
        source,
      },
      generation: sourceDetails,
    });
    // The policy head receives the winning teacher's move set above. This
    // separate record teaches the post-exact-reply value head to prefer the
    // teacher continuation over ordinary legal alternatives. Avoid terminal
    // double-pass candidates because deployment scores those from exact rules
    // rather than through the value head.
    // KataGo is authoritative for ordinary Go proposals. It is authoritative
    // for post-reply ordering only when the predictive adviser actually used
    // this opponent's exact reply. The handcrafted route always knows the
    // opponent policy. This keeps non-predictive daemon KataGo out of the
    // exploit/value phase without discarding its strong shortlist labels.
    if (game.won && rankingStates.has(index)
      && (source === "handcrafted" || predictiveAdvice !== undefined)
      && !(action === board.size * board.size && trace.consecutivePasses > 0)) {
      const rankedMoves = rankingMoves(
        moves, actions, action, board.size * board.size, rankingNegatives,
      ).filter((move) => move !== board.size * board.size || trace.consecutivePasses === 0);
      const winGroup = new Set(source === "katago" && predictiveAdvice
        ? predictiveWinGroupMoves(predictiveAdvice, board.size)
        : [action]);
      const candidates: CorpusValue[][] = [];
      for (const move of rankedMoves) {
        candidates.push(rankingValues(
          opponent, trace, futureBehavior, move, winGroup.has(move), index + 1,
        ));
      }
      if (candidates.length > 1) records.push({
        schema: SCHEMA,
        kind: "actor-ranking",
        profile,
        teacherSha256,
        opponentOracle: OPPONENT_ORACLE,
        split,
        example: {
          episode,
          state: encodedState(board, trace.previousBoards, trace.consecutivePasses, false),
          behavior,
          elapsed: index,
          moves: rankedMoves,
          bestMove: action,
          winGroupMoves: rankedMoves.filter((move) => winGroup.has(move)),
          candidates,
          source,
        },
        generation: { source, ...sourceDetails },
      });
    }
    const after = advance(trace);
    values.push({
      state: encodedState(
        after.board, after.history, after.passes, after.responsePass, after.responseNoOp),
      behavior: futureBehavior,
      elapsed: index + 1,
      won,
      score: trainingScore,
      remaining: Math.max(rounds - index, 1),
      weight: 1 / game.trace.length,
    });
  }
  records.push({
    schema: SCHEMA,
    kind: "trajectory",
    profile,
    teacherSha256,
    opponentOracle: OPPONENT_ORACLE,
    split,
    episode,
    values,
    generation: { source, ...sourceDetails },
  });
  return records;
}

async function main(): Promise<void> {
  const profile = stringFlag("--profile") as Profile;
  if (profile !== "small5" && profile !== "daemon19") {
    throw new Error("--profile must be small5 or daemon19");
  }
  const games = Math.max(1, Math.floor(numberFlag("--games", 64)));
  const seedStart = Math.floor(numberFlag("--seed", 81_730_001));
  const handicapSeedStart = Math.floor(numberFlag("--handicap-seed", 3_141_592_653));
  const defenseSeedStart = Math.floor(numberFlag("--defense-seed", 1_013_904_223));
  const visits = Math.max(2, Math.floor(numberFlag("--visits", profile === "small5" ? 2 : 8)));
  const rankingStatesPerGame = Math.max(0, Math.floor(numberFlag(
    "--ranking-states-per-game", profile === "daemon19" ? 24 : 12,
  )));
  const rankingNegatives = Math.max(1, Math.floor(numberFlag("--ranking-negatives", 4)));
  const output = stringFlag("--out");
  if (!output) throw new Error("missing --out");
  if (await Bun.file(output).exists()) throw new Error(`output already exists: ${output}`);
  const partial = `${output}.partial`;
  const champion = stringFlag("--teacher", `go-ai/${profile}-champion.model`);
  const teacherSha256 = await sha256(champion);
  const model = stringFlag(
    "--model", KATAGO_MODELS[profile].file,
  );
  const binary = stringFlag(
    "--binary", "go-ai/.deps/KataGo/build/ipvgo-opencl/katago",
  );
  const config = stringFlag("--config", "go-ai/katago/config/analysis.cfg");
  const modelSha256 = await sha256(model);
  const resumed = await resumePartial(partial, profile, teacherSha256);
  const adviser = new KataGoAdvisor(binary, model, config);
  const predictive = profile === "small5" ? new PredictiveKataGoAdvisor(adviser) : undefined;
  const records: object[] = resumed.records;
  const cases = goArenaSeedPairs(games, seedStart, handicapSeedStart, defenseSeedStart);
  const opponents = GO_ARENA_OPPONENTS.filter((opponent) =>
    profile === "daemon19"
      ? opponent.name === "????????????"
      : opponent.name !== "????????????");
  let episode = resumed.episodes;
  let kataWins = resumed.kataWins;
  let handcraftedWins = resumed.handcraftedWins;
  try {
    const schedule = opponents.flatMap((opponent) =>
      cases.map(({ seed, handicapSeed, defenseSeed }) => ({
        opponent, seed, handicapSeed, defenseSeed,
      })));
    for (const { opponent, seed, handicapSeed, defenseSeed } of schedule.slice(episode)) {
      const environmentId = [profile, opponent.name, seed, handicapSeed, defenseSeed].join(":");
      const commonGeneration = {
        opponent: opponent.name,
        environmentId,
        rankingStatesPerGame,
        rankingNegatives,
      };
      const kata = await playAdviserGame(
        adviser, predictive, opponent, seed, handicapSeed, defenseSeed, null, visits, 2,
        profile === "small5" ? 4 : 4, true,
      );
      const handcrafted = await playGoArenaPolicyGame(
        opponent, seed, undefined, true, undefined, handicapSeed, defenseSeed,
      );
      kataWins += Number(kata.won);
      handcraftedWins += Number(handcrafted.won);
      records.push(...await recordsFor(
        profile, teacherSha256, opponent, episode, "katago", kata,
        { kataGoCommit: KATAGO_COMMIT, modelSha256, visits,
          mode: predictive ? "predictive" : "plain",
          seed, handicapSeed, defenseSeed, ...commonGeneration },
        rankingStatesPerGame, rankingNegatives,
      ));
      records.push(...await recordsFor(
        profile, teacherSha256, opponent, episode, "handcrafted", handcrafted,
        { frozenSource: "go-ai/teacher/SOURCE.md",
          seed, handicapSeed, defenseSeed, ...commonGeneration },
        rankingStatesPerGame, rankingNegatives,
      ));
      episode++;
      if (episode % 8 === 0) {
        await checkpoint(partial, records);
        console.log(JSON.stringify({ episode, kataWins, handcraftedWins }));
      }
    }
  } finally {
    await adviser.close();
  }
  await checkpoint(partial, records);
  await rename(partial, output);
  await unlink(`${partial}.next`).catch(() => undefined);
  console.log(JSON.stringify({
    profile,
    episodes: episode,
    gamesPerSource: episode,
    kataWins,
    handcraftedWins,
    teacherSha256,
    modelSha256,
    rankingStatesPerGame,
    rankingNegatives,
    records: records.length,
    output,
  }));
}

if (import.meta.main) await main();

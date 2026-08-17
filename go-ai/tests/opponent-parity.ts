import {
  legalMoveIndices,
  legalMoves,
  playMove,
  scoreBoard,
  type GoBoard,
} from "../../shared/strategy/go/rules.ts";
import {
  encodeOpponentFutureBehavior,
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
  prepareOpponentPosition,
  predictPreparedOpponentReplies,
  predictOpponentReplies,
  type OpponentReplyForecast,
} from "../../shared/strategy/go/opponent.ts";
import {
  GO_ENGINE_CYCLE_MS,
  alignedAiSeed,
  nextGoTurnTiming,
  normalizeGoPlaytime,
  whrng,
} from "../../shared/strategy/go/rng.ts";
import { predictOpponentReplies as predictTeacherReplies } from "../teacher/strategy/opponent.ts";
import {
  alignedAiSeed as alignedTeacherSeed,
  nextGoTurnTiming as nextTeacherTurnTiming,
  normalizeGoPlaytime as normalizeTeacherPlaytime,
  whrng as teacherWhrng,
} from "../teacher/strategy/rng.ts";
import {
  configureGoArenaEngine,
  GO_ARENA_OPPONENTS,
  goArenaSeeds,
  playGoArenaGame,
} from "../../sim/go-arena.ts";
import { oracleInitialBoard } from "../../sim/features/go-oracle.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";
import { GoColor, GoOpponent, GoPlayType } from "../../sim/vendor/bitburner/src/Go/Enums.ts";
import { getMove } from "../../sim/vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import { getNewBoardStateFromSimpleBoard } from "../../sim/vendor/bitburner/src/Go/boardState/boardState.ts";
import { Go, sleepLog } from "../../sim/vendor/bitburner/src/Go/OracleStubs.ts";
import { WHRNG } from "../../sim/vendor/bitburner/src/Casino/RNG.ts";

interface NativeReply {
  probability: number;
  move?: { x: number; y: number };
  branch: string;
  cycleWaitsAfterSeed: number;
  fixedSleepMsAfterSeed: number;
  noOp: boolean;
}

const nativeOracle = process.env.GO_CPP_ORACLE
  ?? `${import.meta.dir}/../build/release/go_cpp_oracle`;

function nativeForecast(
  board: GoBoard,
  history: readonly string[][],
  passes: number,
  seed: number,
  opponent: string,
): { exact: boolean; replies: NativeReply[] } {
  const command = [
    nativeOracle,
    "reply",
    String(board.size),
    opponent,
    String(seed),
    String(passes),
    board.rows.join(""),
    ...history.map((position) => position.join("")),
  ];
  let result = Bun.spawnSync(command);
  if (result.exitCode === 0 && result.stdout.length === 0) {
    // The reply command always prints a certainty line, so empty stdout with
    // a zero exit is a spawn flake, not a forecast. Retry once, then fail
    // loudly instead of mis-parsing it as an empty exact=false forecast.
    result = Bun.spawnSync(command);
    if (result.exitCode === 0 && result.stdout.length === 0) {
      throw new Error("native oracle produced no output twice for a reply query: "
        + JSON.stringify({
          exitCode: result.exitCode,
          signalCode: result.signalCode ?? null,
          success: result.success,
          stderr: result.stderr.toString().slice(0, 300),
          argvBytes: command.join(" ").length,
          historyEntries: history.length,
          size: board.size,
          seed,
        }));
    }
  }
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const lines = result.stdout.toString().trim().split("\n");
  return {
    exact: lines.shift() === "exact",
    replies: lines.filter(Boolean).map((line) => {
      const [rawProbability, rawMove, branch, rawWaits, rawSleep, rawNoOp] = line.split("\t");
      const [x, y] = rawMove === "pass" ? [] : rawMove!.split(",").map(Number);
      return {
        probability: Number(rawProbability),
        ...(rawMove === "pass" ? {} : { move: { x: x!, y: y! } }),
        branch: branch!,
        cycleWaitsAfterSeed: Number(rawWaits),
        fixedSleepMsAfterSeed: Number(rawSleep),
        noOp: rawNoOp === "no-op",
      };
    }),
  };
}

function replyKey(reply: NativeReply): string {
  return JSON.stringify({
    move: reply.move,
    branch: reply.branch,
    waits: reply.cycleWaitsAfterSeed,
    sleep: reply.fixedSleepMsAfterSeed,
    probability: reply.probability,
    noOp: reply.noOp,
  });
}

function runNative(...args: string[]): string {
  const result = Bun.spawnSync([nativeOracle, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

const FNV_OFFSET = 14_695_981_039_346_656_037n;
const FNV_PRIME = 1_099_511_628_211n;
const U64_MASK = (1n << 64n) - 1n;

function hashByte(hash: bigint, value: number): bigint {
  return ((hash ^ BigInt(value & 0xff)) * FNV_PRIME) & U64_MASK;
}

function hashI64(hash: bigint, value: bigint): bigint {
  const bits = value & U64_MASK;
  for (let shift = 0n; shift < 64n; shift += 8n) {
    hash = hashByte(hash, Number((bits >> shift) & 0xffn));
  }
  return hash;
}

function digestRng(stream: (seed: number, count: number) => number[]): string {
  let hash = FNV_OFFSET;
  for (let tick = 0; tick < 150_000; tick++) {
    for (const value of stream(tick * 200, 4)) {
      hash = hashI64(hash, BigInt(Math.round(value * 1e15)));
    }
  }
  return hash.toString(16).padStart(16, "0");
}

function digestBehavior(): string {
  let hash = FNV_OFFSET;
  for (let tick = 0; tick < 150_000; tick++) {
    for (const { name } of GO_ARENA_OPPONENTS) {
      const behavior = opponentTurnBehavior(name, tick * 200);
      hash = hashByte(hash, Number(behavior.smart));
      for (const rank of behavior.priorityRanks) hash = hashByte(hash, rank);
    }
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizedForecast(
  forecast: OpponentReplyForecast,
  board: GoBoard,
  history: readonly string[][],
): NativeReply[] {
  const hashes = new Set(history.map((position) => position.join("")));
  return forecast.replies.map((reply) => ({
    probability: reply.probability,
    ...(reply.move ? { move: reply.move } : {}),
    branch: reply.branch,
    cycleWaitsAfterSeed: reply.wait.cycleWaitsAfterSeed,
    fixedSleepMsAfterSeed: reply.wait.fixedSleepMsAfterSeed,
    noOp: Boolean(reply.move && !playMove(
      board, reply.move.x, reply.move.y, "O", hashes,
    )),
  }));
}

async function upstreamReply(
  board: GoBoard,
  history: readonly string[][],
  passCount: number,
  opponent: GoOpponent,
  seed: number,
  defenseRoll: number,
): Promise<NativeReply> {
  const reconstruction = opponent === GoOpponent.w0r1d_d43m0n ? GoOpponent.Illuminati : opponent;
  const state = getNewBoardStateFromSimpleBoard(board.rows, undefined, reconstruction, GoColor.black);
  state.previousBoards = history.map((position) => position.join(""));
  state.passCount = passCount;
  state.ai = opponent;
  Go.currentGame = state;
  const originalRandom = Math.random;
  try {
    Math.random = () => defenseRoll;
    sleepLog.length = 0;
    const play = await getMove(state, GoColor.white, opponent, false, seed);
    const afterInitial = sleepLog.slice(1);
    const cycleWaitsAfterSeed = afterInitial.filter((milliseconds) => milliseconds === 200).length
      + Number(play.type === GoPlayType.move);
    const fixedSleepMsAfterSeed = afterInitial
      .filter((milliseconds) => milliseconds !== 200)
      .reduce((sum, milliseconds) => sum + milliseconds, 0);
    const move = play.type === GoPlayType.move ? { x: play.x, y: play.y } : undefined;
    return {
      probability: 1,
      ...(move ? { move } : {}),
      branch: "",
      cycleWaitsAfterSeed,
      fixedSleepMsAfterSeed,
      noOp: Boolean(move && !playMove(
        board, move.x, move.y, "O", new Set(history.map((position) => position.join(""))),
      )),
    };
  } finally {
    Math.random = originalRandom;
    sleepLog.length = 0;
  }
}

async function alwaysPassTarget(
  initialBoard: GoBoard,
  initialHistory: readonly string[][],
  opponent: GoOpponent,
): Promise<{ board: GoBoard; passes: number; score: { X: number; O: number }; turns: number }> {
  let board = { size: initialBoard.size, rows: [...initialBoard.rows] };
  const history = initialHistory.map((position) => [...position]);
  let passes = 0;
  let dispatch = 800;
  let turns = 0;
  while (passes < 2 && turns < board.size * board.size * 4) {
    passes++;
    turns++;
    if (passes >= 2) break;
    const reply = await upstreamReply(
      board, history, passes, opponent, alignedAiSeed(dispatch), 0.5);
    dispatch = nextGoTurnTiming(dispatch, 0, {
      cycleWaitsAfterSeed: reply.cycleWaitsAfterSeed,
      fixedSleepMsAfterSeed: reply.fixedSleepMsAfterSeed,
    }).responsePlaytimeMs;
    if (reply.move) {
      const played = playMove(
        board, reply.move.x, reply.move.y, "O",
        new Set(history.map((position) => position.join(""))),
      );
      if (played) {
        history.unshift(board.rows);
        board = played.board;
        passes = 0;
      }
    } else {
      passes++;
    }
    turns++;
  }
  if (passes < 2) throw new Error("always-pass history collision rollout did not terminate");
  return { board, passes, score: scoreBoard(board, 7.5), turns };
}

let checked = 0;
const sharedRngDigest = digestRng(whrng);
const teacherRngDigest = digestRng(teacherWhrng);
const upstreamRngDigest = digestRng((seed, count) => {
  const rng = new WHRNG(seed);
  return Array.from({ length: count }, () => rng.random());
});
const nativeRngDigest = runNative("rng-digest");
if (sharedRngDigest !== teacherRngDigest
  || sharedRngDigest !== upstreamRngDigest
  || sharedRngDigest !== nativeRngDigest) {
  throw new Error(`full-period WHRNG mismatch: ${JSON.stringify({
    sharedRngDigest, teacherRngDigest, upstreamRngDigest, nativeRngDigest,
  })}`);
}
const sharedBehaviorDigest = digestBehavior();
const nativeBehaviorDigest = runNative("behavior-digest");
if (sharedBehaviorDigest !== nativeBehaviorDigest) {
  throw new Error(`full-period behavior mismatch: ${sharedBehaviorDigest} != ${nativeBehaviorDigest}`);
}
// This gate compares the native and TypeScript opponent implementations. Move
// quality is irrelevant, so use the explicit planner-only double rather than
// requiring Chromium merely to generate deterministic reachable positions.
configureGoArenaEngine((weights) => new StubGoValueBackend(weights));
const ordinary = GO_ARENA_OPPONENTS.filter(({ name }) => name !== "????????????");
// 15,800 exercises an upstream center-break roll of 2. The raw roll is used
// both as a truthy flag and in obstacleTypeCount, so normalizing it to bool in
// C++ changes the generated board.
for (const opponent of ordinary) for (const size of [5, 7, 9, 13] as const) for (const seed of [1_000, 15_800, 73_000, 29_999_800]) {
  const handicapSeed = (seed ^ 0xa5a5a5a5) >>> 0;
  const expected = oracleInitialBoard(size, opponent.oracle, seed, handicapSeed);
  const result = Bun.spawnSync([
    nativeOracle,
    "board",
    String(size),
    opponent.name,
    String(seed),
    String(handicapSeed),
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const [actualSize, actualHash] = result.stdout.toString().trim().split("\t");
  if (Number(actualSize) !== expected.size || actualHash !== expected.rows.join("")) {
    throw new Error(`C++ initial board mismatch for ${opponent.name} ${size} seed ${seed}`);
  }
}
const daemon = GO_ARENA_OPPONENTS.find(({ name }) => name === "????????????")!;
for (const seed of [1_000, 73_000]) {
  const handicapSeed = (seed ^ 0xa5a5a5a5) >>> 0;
  const expected = oracleInitialBoard(13, daemon.oracle, seed, handicapSeed);
  const result = Bun.spawnSync([
    nativeOracle, "board", "13", daemon.name,
    String(seed), String(handicapSeed),
  ]);
  if (result.exitCode !== 0 || result.stdout.toString().trim().split("\t")[1] !== expected.rows.join("")) {
    throw new Error(`C++ BitVerse board mismatch at seed ${seed}`);
  }
}
for (const opponent of GO_ARENA_OPPONENTS) for (const seed of [1_000, 73_000, 29_999_800]) {
  const komi = opponent.name === "????????????" ? undefined
    : opponent.name === "Netburners" ? 1.5
    : opponent.name === "Slum Snakes" || opponent.name === "The Black Hand" ? 3.5
    : opponent.name === "Tetrads" || opponent.name === "Daedalus" ? 5.5 : 7.5;
  const expected = encodeOpponentTurnBehavior(opponentTurnBehavior(opponent.name, seed), komi);
  const native = Bun.spawnSync([
    nativeOracle, "behavior", opponent.name,
    String(seed), komi === undefined ? "-" : String(komi),
  ]);
  if (native.exitCode !== 0) throw new Error(native.stderr.toString());
  const actual = native.stdout.toString().trim().split(",").map(Number);
  if (actual.length !== expected.length
    || actual.some((value, index) => Math.abs(value - expected[index]!) > 1e-7)) {
    throw new Error(`C++ behavior signature mismatch for ${opponent.name} seed ${seed}`);
  }
}
const futureSignatures = new Map<string, string[]>();
for (const opponent of GO_ARENA_OPPONENTS) {
  const komi = opponent.name === "????????????" ? undefined
    : opponent.name === "Netburners" ? 1.5
    : opponent.name === "Slum Snakes" || opponent.name === "The Black Hand" ? 3.5
    : opponent.name === "Tetrads" || opponent.name === "Daedalus" ? 5.5 : 7.5;
  const expected = encodeOpponentFutureBehavior(opponent.name, komi);
  const native = Bun.spawnSync([
    nativeOracle, "future-behavior", opponent.name,
    komi === undefined ? "-" : String(komi),
  ]);
  if (native.exitCode !== 0) throw new Error(native.stderr.toString());
  const actual = native.stdout.toString().trim().split(",").map(Number);
  if (actual.length !== expected.length
    || actual.some((value, index) => Math.abs(value - expected[index]!) > 1e-7)) {
    throw new Error(`C++ future behavior mismatch for ${opponent.name}`);
  }
  if (actual.slice(1, 4).some((value) => value !== -1)) {
    throw new Error(`future behavior did not mark unknown rolls for ${opponent.name}`);
  }
  const key = actual.join(",");
  futureSignatures.set(key, [...(futureSignatures.get(key) ?? []), opponent.name]);
  const exact = encodeOpponentTurnBehavior(
    opponentTurnBehavior(opponent.name, 0), komi);
  if (Array.from(exact).join(",") === key) {
    throw new Error(`exact and future behavior modes collide for ${opponent.name}`);
  }
}
const unsafeFutureIdentityCollisions = [...futureSignatures.values()]
  .filter((opponents) => opponents.length > 1);
if (unsafeFutureIdentityCollisions.length) {
  throw new Error(`future policy collapses opponent identities: ${JSON.stringify(unsafeFutureIdentityCollisions)}`);
}
// Removing raw identity is sound only if two identities that collapse to one
// semantic current-turn signature cannot produce contradictory candidate
// responses. Audit real collisions (notably Illuminati/Daemon and some
// Daedalus phases) on candidate-dependent boards.
const collisionBoards: GoBoard[] = [
  { size: 5, rows: [".....", ".....", ".....", ".....", "....."] },
  { size: 5, rows: ["XX...", "OO...", ".X.O.", ".....", "....."] },
  { size: 5, rows: ["XOX..", "OX...", "..O..", "...X.", "....."] },
];
let behaviorCollisions = 0;
const collisionPrepared = collisionBoards.map((board) => new Map(
  GO_ARENA_OPPONENTS.map(({ name }) => [name, prepareOpponentPosition(board, name)]),
));
const collisionClasses = new Map<string, number>();
for (let tick = 0; tick < 150_000; tick++) {
  const seed = tick * 200;
  const groups = new Map<string, string[]>();
  for (const opponent of GO_ARENA_OPPONENTS) {
    const key = Array.from(encodeOpponentTurnBehavior(
      opponentTurnBehavior(opponent.name, seed))).join(",");
    const names = groups.get(key) ?? [];
    names.push(opponent.name);
    groups.set(key, names);
  }
  for (const names of groups.values()) {
    if (names.length < 2) continue;
    behaviorCollisions++;
    const collisionClass = names.join("|");
    collisionClasses.set(collisionClass, (collisionClasses.get(collisionClass) ?? 0) + 1);
    for (const prepared of collisionPrepared) {
      const replies = names.map((name) => predictPreparedOpponentReplies(prepared.get(name)!, seed));
      const reference = JSON.stringify(replies[0]);
      if (replies.some((reply) => JSON.stringify(reply) !== reference)) {
        throw new Error(`behavior signature collision changes a reply: ${names.join(", ")} seed ${seed}`);
      }
    }
  }
}
if (behaviorCollisions !== 150_000) {
  throw new Error(`expected one safe identity collision per WHRNG phase, got ${behaviorCollisions}`);
}
const scenarios = [
  ...ordinary.flatMap((opponent, opponentIndex) =>
    ([5, 7, 9, 13] as const).map((requestedSize, sizeIndex) => ({
      opponent: { ...opponent, requestedSize },
      seed: goArenaSeeds(1, 73_000 + (opponentIndex * 4 + sizeIndex) * 2_000)[0]!,
    }))),
  { opponent: daemon, seed: goArenaSeeds(1, 117_000)[0]! },
];
const branchCounts = new Map<string, number>();
const waitClasses = new Set<string>();
let historySensitive = 0;
let passReplies = 0;
let noOpReplies = 0;
for (const { opponent, seed } of scenarios) {
  const game = await playGoArenaGame(opponent, seed, 0.5, true);
  const trace = game.trace ?? [];
  for (let turnIndex = 0; turnIndex < trace.length; turnIndex++) {
    const turn = trace[turnIndex]!;
    let board: GoBoard = { size: turn.board.length, rows: [...turn.board] };
    const history = [...turn.previousBoards];
    if (turn.black.type === "move") {
      const played = playMove(
        board,
        turn.black.x,
        turn.black.y,
        "X",
        new Set(history.map((position) => position.join(""))),
      );
      if (!played) throw new Error("arena emitted an illegal black move");
      history.push(board.rows);
      board = played.board;
    }
    const currentSeed = alignedAiSeed(turn.dispatchPlaytime);
    const passCount = turn.black.type === "pass" ? turn.consecutivePasses + 1 : 0;
    const expected = predictOpponentReplies(board, opponent.name, currentSeed, history, passCount);
    const teacher = predictTeacherReplies(board, opponent.name, currentSeed, history, passCount);
    if (JSON.stringify(teacher) !== JSON.stringify(expected)) {
      throw new Error(`teacher/shared reply mismatch at game seed ${seed}, turn ${turn.turn}`);
    }
    if (history.length && JSON.stringify(expected)
      !== JSON.stringify(predictOpponentReplies(board, opponent.name, currentSeed, [], passCount))) {
      historySensitive++;
    }
    const actual = nativeForecast(
      board,
      history,
      passCount,
      currentSeed,
      opponent.name,
    );
    const normalized = normalizedForecast(expected, board, history);
    if (actual.exact !== (expected.certainty === "exact")
      || JSON.stringify(actual.replies.map(replyKey)) !== JSON.stringify(normalized.map(replyKey))) {
      throw new Error(`C++ reply mismatch at game seed ${seed}, turn ${turn.turn}:\n${JSON.stringify({ actual, expected }, null, 2)}`);
    }
    for (const reply of actual.replies) {
      branchCounts.set(reply.branch, (branchCounts.get(reply.branch) ?? 0) + 1);
      waitClasses.add(`${reply.cycleWaitsAfterSeed}|${reply.fixedSleepMsAfterSeed}`);
      if (!reply.move) passReplies++;
      if (reply.noOp) noOpReplies++;
    }
    const actualMove = turn.white.type === "pass" ? undefined : { x: turn.white.x, y: turn.white.y };
    const selectedReplies = actual.replies.filter(
      (reply) => JSON.stringify(reply.move) === JSON.stringify(actualMove));
    if (!selectedReplies.length) {
      throw new Error(`upstream reply absent at game seed ${seed}, turn ${turn.turn}`);
    }
    const nextTurn = trace[turnIndex + 1];
    if (nextTurn && passCount < 2) {
      // The arena now carries a sub-tick offset plus uncontrolled 5..90 ms
      // per-turn jitter, so the observed next dispatch is the branch-exact
      // base plus at most floor((offset + fractional sleeps + jitter)/200)
      // extra ticks: one on 5x5 (pattern sleeps <= 100 ms), up to two on the
      // larger boards where a pattern pass sleeps 10 ms per column.
      const predictedDispatches = new Set(selectedReplies.flatMap((reply) => {
        const base = nextGoTurnTiming(turn.dispatchPlaytime, 0, {
          cycleWaitsAfterSeed: reply.cycleWaitsAfterSeed,
          fixedSleepMsAfterSeed: reply.fixedSleepMsAfterSeed,
        }).responsePlaytimeMs;
        const maxExtra = Math.floor(
          (199 + (Math.max(0, reply.fixedSleepMsAfterSeed) % GO_ENGINE_CYCLE_MS) + 95)
          / GO_ENGINE_CYCLE_MS,
        );
        return Array.from({ length: maxExtra + 1 }, (_, extra) =>
          normalizeGoPlaytime(base + extra * GO_ENGINE_CYCLE_MS));
      }));
      if (!predictedDispatches.has(normalizeGoPlaytime(nextTurn.dispatchPlaytime))) {
        throw new Error(`wait-derived future seed mismatch at game seed ${seed}, turn ${turn.turn}`);
      }
    }
    checked++;
  }
}

const requiredBranches = [
  "capture", "defendCapture", "eyeMove", "surround", "eyeBlock",
  "corner", "pattern", "jump", "growth", "defend", "expansion",
  "random", "pass",
];
const missingBranches = requiredBranches.filter((branch) => !branchCounts.has(branch));
if (missingBranches.length) {
  throw new Error(`reachable corpus missed opponent branches: ${missingBranches.join(", ")}`);
}
if (!historySensitive) throw new Error("reachable corpus never exercised history-sensitive prediction");
if (!passReplies) throw new Error("reachable corpus never exercised White pass handling");

// One original Black board, one exact seed, and every legal Black candidate:
// the reply branch must remain candidate-dependent in all four implementations.
const candidateBoard: GoBoard = {
  size: 5,
  rows: [".#..#", ".....", "....#", ".....", "....."],
};
const candidateSeed = 73_200;
const candidateOpponent = GO_ARENA_OPPONENTS.find(({ name }) => name === "Netburners")!;
const candidateBranches = new Set<string>();
let candidateForecasts = 0;
for (const [x, y] of legalMoves(candidateBoard, "X")) {
  const played = playMove(candidateBoard, x, y, "X");
  if (!played) throw new Error(`candidate fixture produced illegal ${x},${y}`);
  const history = [candidateBoard.rows];
  const shared = predictOpponentReplies(
    played.board, candidateOpponent.name, candidateSeed, history, 0);
  const teacher = predictTeacherReplies(
    played.board, candidateOpponent.name, candidateSeed, history, 0);
  if (JSON.stringify(shared) !== JSON.stringify(teacher)) {
    throw new Error(`candidate-dependent teacher mismatch after ${x},${y}`);
  }
  const native = nativeForecast(
    played.board, history, 0, candidateSeed, candidateOpponent.name);
  const normalized = normalizedForecast(shared, played.board, history);
  if (native.exact !== (shared.certainty === "exact")
    || JSON.stringify(native.replies.map(replyKey)) !== JSON.stringify(normalized.map(replyKey))) {
    throw new Error(`candidate-dependent C++ mismatch after ${x},${y}`);
  }
  const upstream = await upstreamReply(
    played.board, history, 0, candidateOpponent.oracle, candidateSeed, 0.5);
  if (!native.replies.some((reply) =>
    JSON.stringify(reply.move) === JSON.stringify(upstream.move)
    && reply.cycleWaitsAfterSeed === upstream.cycleWaitsAfterSeed
    && reply.fixedSleepMsAfterSeed === upstream.fixedSleepMsAfterSeed
    && reply.noOp === upstream.noOp)) {
    throw new Error(`candidate-dependent upstream mismatch after ${x},${y}`);
  }
  for (const reply of native.replies) candidateBranches.add(reply.branch);
  candidateForecasts++;
}
if (candidateBranches.size < 4) {
  throw new Error(`candidate fixture collapsed to ${[...candidateBranches].join(",")}`);
}

// Upstream's sole unseeded selector is a uniform defense tie. This reachable
// board has four maximum-defense candidates which aggregate 3:1 by response.
const tieBoard: GoBoard = {
  size: 5,
  rows: ["OX..O", ".OX.X", "O..X.", ".OXXO", ".OXX."],
};
const tieSeed = 9_820_200;
const tieOpponent = GO_ARENA_OPPONENTS.find(({ name }) => name === "Slum Snakes")!;
const tieShared = predictOpponentReplies(tieBoard, tieOpponent.name, tieSeed);
const tieTeacher = predictTeacherReplies(tieBoard, tieOpponent.name, tieSeed);
const tieNative = nativeForecast(tieBoard, [], 0, tieSeed, tieOpponent.name);
if (tieShared.certainty !== "unseeded-defense-tie"
  || JSON.stringify(tieShared) !== JSON.stringify(tieTeacher)
  || tieNative.exact
  || JSON.stringify(tieNative.replies.map(replyKey))
    !== JSON.stringify(normalizedForecast(tieShared, tieBoard, []).map(replyKey))) {
  throw new Error("unseeded defense tie differs across implementations");
}
const tieCounts = new Map<string, number>();
for (const roll of [0.125, 0.375, 0.625, 0.875]) {
  const upstream = await upstreamReply(tieBoard, [], 0, tieOpponent.oracle, tieSeed, roll);
  const matching = tieNative.replies.find((reply) =>
    JSON.stringify(reply.move) === JSON.stringify(upstream.move)
    && reply.cycleWaitsAfterSeed === upstream.cycleWaitsAfterSeed
    && reply.fixedSleepMsAfterSeed === upstream.fixedSleepMsAfterSeed);
  if (!matching) throw new Error(`unseeded defense roll ${roll} left forecast support`);
  const key = JSON.stringify(upstream.move);
  tieCounts.set(key, (tieCounts.get(key) ?? 0) + 1);
}
for (const reply of tieNative.replies) {
  if (tieCounts.get(JSON.stringify(reply.move)) !== reply.probability * 4) {
    throw new Error(`unseeded defense weight mismatch for ${JSON.stringify(reply.move)}`);
  }
}

// Priority moves are not superko-filtered upstream. The attempted coordinate
// is observable, but makeMove rejects it: this advances White without a board
// change and is not a pass.
const historyBoard: GoBoard = {
  size: 5,
  // The existing stone prevents upstream's reconstruction helper from
  // treating this midgame as a fresh Illuminati board and adding a handicap.
  rows: [".X...", ".....", ".....", ".....", "....."],
};
const repeatedWhiteBoard = [".X...", ".....", "..O..", ".....", "....."];
const noOpHistory = [repeatedWhiteBoard];
const noOpOpponent = GO_ARENA_OPPONENTS.find(({ name }) => name === "Illuminati")!;
const noOpShared = predictOpponentReplies(historyBoard, noOpOpponent.name, 1_000, noOpHistory, 1);
const noOpTeacher = predictTeacherReplies(historyBoard, noOpOpponent.name, 1_000, noOpHistory, 1);
const noOpNative = nativeForecast(historyBoard, noOpHistory, 1, 1_000, noOpOpponent.name);
const noOpUpstream = await upstreamReply(
  historyBoard, noOpHistory, 1, noOpOpponent.oracle, 1_000, 0.5);
if (JSON.stringify(noOpShared) !== JSON.stringify(noOpTeacher)
  || noOpNative.replies.length !== 1
  || !noOpNative.replies[0]!.noOp
  || !noOpUpstream.noOp
  || noOpNative.replies[0]!.branch !== "corner"
  || JSON.stringify(noOpNative.replies[0]!.move) !== JSON.stringify(noOpUpstream.move)) {
  throw new Error(`positional-superko priority no-op parity failed: ${JSON.stringify({
    noOpShared, noOpTeacher, noOpNative, noOpUpstream,
  })}`);
}
noOpReplies++;

const blockedBoard: GoBoard = {
  size: 5,
  rows: ["#####", "#####", "#####", "#####", "#####"],
};
const passOpponent = GO_ARENA_OPPONENTS.find(({ name }) => name === "Daedalus")!;
const passShared = predictOpponentReplies(blockedBoard, passOpponent.name, 73_000, [], 1);
const passTeacher = predictTeacherReplies(blockedBoard, passOpponent.name, 73_000, [], 1);
const passNative = nativeForecast(blockedBoard, [], 1, 73_000, passOpponent.name);
const passUpstream = await upstreamReply(blockedBoard, [], 1, passOpponent.oracle, 73_000, 0.5);
if (JSON.stringify(passShared) !== JSON.stringify(passTeacher)
  || passNative.replies.length !== 1
  || passNative.replies[0]!.move
  || passUpstream.move
  || passNative.replies[0]!.cycleWaitsAfterSeed !== passUpstream.cycleWaitsAfterSeed) {
  throw new Error("explicit pass parity failed");
}

// Wait traces, not a salt, determine the next observable dispatch phase.
for (const encoded of waitClasses) {
  const [cycleWaitsAfterSeed, fixedSleepMsAfterSeed] = encoded.split("|").map(Number) as [number, number];
  const wait = { cycleWaitsAfterSeed, fixedSleepMsAfterSeed };
  for (const dispatch of [0, 29_999_800, 30_000_400]) {
    const shared = nextGoTurnTiming(dispatch, 0, wait);
    const teacher = nextTeacherTurnTiming(dispatch, 0, wait);
    const [nativeSeed, nativeDispatch] = runNative(
      "timing", String(dispatch), String(cycleWaitsAfterSeed), String(fixedSleepMsAfterSeed),
    ).split("\t").map(Number) as [number, number];
    if (normalizeGoPlaytime(alignedAiSeed(dispatch, 0)) !== nativeSeed
      || normalizeTeacherPlaytime(alignedTeacherSeed(dispatch, 0)) !== nativeSeed
      || normalizeGoPlaytime(shared.responsePlaytimeMs) !== nativeDispatch
      || normalizeTeacherPlaytime(teacher.responsePlaytimeMs) !== nativeDispatch
      || shared.responseWallMs !== teacher.responseWallMs
      || shared.bonusCycles !== teacher.bonusCycles) {
      throw new Error(`wait timing mismatch for ${dispatch}/${encoded}`);
    }
  }
  for (const bonusCycles of [1, 2, 3, 4, 9]) {
    const shared = nextGoTurnTiming(10_000, bonusCycles, wait);
    const teacher = nextTeacherTurnTiming(10_000, bonusCycles, wait);
    if (JSON.stringify(shared) !== JSON.stringify(teacher)) {
      throw new Error(`offline-cycle timing mismatch for ${bonusCycles}/${encoded}`);
    }
  }
}

// Identity encoding is safe, but history omission is not injective. These two
// public states have the same board, Black legal plane, exact/future behavior,
// pass count and elapsed features. White's center priority is legal in one and
// a positional-superko no-op in the other, so proposal/value targets can in
// principle differ even though the network input cannot. Keep this as an
// explicit measured limitation rather than silently calling identity parity a
// proof over histories.
const noHistoryLegal = legalMoveIndices(historyBoard, "X", new Set());
const withHistoryLegal = legalMoveIndices(
  historyBoard, "X", new Set(noOpHistory.map((rows) => rows.join(""))));
if (JSON.stringify(noHistoryLegal) !== JSON.stringify(withHistoryLegal)) {
  throw new Error("history collision fixture unexpectedly differs in the Black legal plane");
}
const legalWhite = noOpShared.replies[0]!.move
  && playMove(historyBoard, noOpShared.replies[0]!.move.x, noOpShared.replies[0]!.move.y, "O");
const repeatedWhite = noOpShared.replies[0]!.move
  && playMove(
    historyBoard, noOpShared.replies[0]!.move.x, noOpShared.replies[0]!.move.y, "O",
    new Set(noOpHistory.map((rows) => rows.join(""))),
  );
if (!legalWhite || repeatedWhite) {
  throw new Error("history collision fixture no longer changes the White outcome");
}
const noHistoryTarget = await alwaysPassTarget(historyBoard, [], noOpOpponent.oracle);
const withHistoryTarget = await alwaysPassTarget(historyBoard, noOpHistory, noOpOpponent.oracle);
if (JSON.stringify(noHistoryTarget.score) === JSON.stringify(withHistoryTarget.score)
  && noHistoryTarget.turns === withHistoryTarget.turns) {
  throw new Error(`history collision no longer produces distinct terminal value targets: ${JSON.stringify({
    noHistoryTarget, withHistoryTarget,
  })}`);
}
const historyInputCollisions = 1;

console.log(JSON.stringify({
  whrng: { phaseTicks: 150_000, draws: 600_000, digest: sharedRngDigest },
  behavior: {
    opponentPhases: 1_050_000,
    digest: sharedBehaviorDigest,
    safeCurrentIdentityCollisions: behaviorCollisions,
    collisionClasses: Object.fromEntries(collisionClasses),
    unsafeFutureIdentityCollisions: 0,
    historyInputCollisions,
    historyCollisionTargets: { noHistory: noHistoryTarget, withHistory: withHistoryTarget },
  },
  replies: {
    scenarios: scenarios.length,
    reachableTurns: checked,
    candidateForecasts,
    candidateBranches: [...candidateBranches].sort(),
    branchCounts: Object.fromEntries([...branchCounts].sort()),
    historySensitive,
    passReplies,
    noOpReplies,
    unseededTieOutcomes: Object.fromEntries(tieCounts),
    waitClasses: [...waitClasses].sort(),
  },
}));

import { playMove, type GoBoard } from "../../shared/strategy/go/rules.ts";
import {
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
  predictOpponentReplies,
} from "../../shared/strategy/go/opponent.ts";
import { alignedAiSeed } from "../../shared/strategy/go/rng.ts";
import {
  configureGoArenaEngine,
  GO_ARENA_OPPONENTS,
  goArenaSeeds,
  playGoArenaGame,
} from "../../sim/go-arena.ts";
import { oracleInitialBoard } from "../../sim/features/go-oracle.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";

interface NativeReply {
  probability: number;
  move?: { x: number; y: number };
  branch: string;
  cycleWaitsAfterSeed: number;
  fixedSleepMsAfterSeed: number;
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
  const result = Bun.spawnSync([
    nativeOracle,
    "reply",
    String(board.size),
    opponent,
    String(seed),
    String(passes),
    board.rows.join(""),
    ...history.map((position) => position.join("")),
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const lines = result.stdout.toString().trim().split("\n");
  return {
    exact: lines.shift() === "exact",
    replies: lines.filter(Boolean).map((line) => {
      const [rawProbability, rawMove, branch, rawWaits, rawSleep] = line.split("\t");
      const [x, y] = rawMove === "pass" ? [] : rawMove!.split(",").map(Number);
      return {
        probability: Number(rawProbability),
        ...(rawMove === "pass" ? {} : { move: { x: x!, y: y! } }),
        branch: branch!,
        cycleWaitsAfterSeed: Number(rawWaits),
        fixedSleepMsAfterSeed: Number(rawSleep),
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
  });
}

let checked = 0;
// This gate compares the native and TypeScript opponent implementations. Move
// quality is irrelevant, so use the explicit planner-only double rather than
// requiring Chromium merely to generate deterministic reachable positions.
configureGoArenaEngine((weights) => new StubGoValueBackend(weights));
const ordinary = GO_ARENA_OPPONENTS.filter(({ name }) => name !== "????????????");
for (const opponent of ordinary) for (const size of [5, 7, 9, 13] as const) for (const seed of [1_000, 73_000, 29_999_800]) {
  const expected = oracleInitialBoard(size, opponent.oracle, seed);
  const result = Bun.spawnSync([
    nativeOracle,
    "board",
    String(size),
    opponent.name,
    String(seed),
    String((seed ^ 0xa5a5a5a5) >>> 0),
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const [actualSize, actualHash] = result.stdout.toString().trim().split("\t");
  if (Number(actualSize) !== expected.size || actualHash !== expected.rows.join("")) {
    throw new Error(`C++ initial board mismatch for ${opponent.name} ${size} seed ${seed}`);
  }
}
const daemon = GO_ARENA_OPPONENTS.find(({ name }) => name === "????????????")!;
for (const seed of [1_000, 73_000]) {
  const expected = oracleInitialBoard(13, daemon.oracle, seed);
  const result = Bun.spawnSync([
    nativeOracle, "board", "13", daemon.name,
    String(seed), String((seed ^ 0xa5a5a5a5) >>> 0),
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
for (const seed of [1_000, 73_000, 29_999_800, 10_200, 10_400]) {
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
    for (const board of collisionBoards) {
      const replies = names.map((name) => predictOpponentReplies(board, name, seed));
      const reference = JSON.stringify(replies[0]);
      if (replies.some((reply) => JSON.stringify(reply) !== reference)) {
        throw new Error(`behavior signature collision changes a reply: ${names.join(", ")} seed ${seed}`);
      }
    }
  }
}
if (!behaviorCollisions) throw new Error("behavior collision audit did not exercise any identity collapse");
const scenarios = [
  ...ordinary.map((opponent, index) => ({ opponent, seed: goArenaSeeds(1, 73_000 + index * 2_000)[0]! })),
  ...([7, 9] as const).map((requestedSize, index) => ({
    opponent: { ...ordinary.find(({ name }) => name === "Illuminati")!, requestedSize },
    seed: goArenaSeeds(1, 91_000 + index * 2_000)[0]!,
  })),
  { opponent: daemon, seed: goArenaSeeds(1, 117_000)[0]! },
];
for (const { opponent, seed } of scenarios) {
  const game = await playGoArenaGame(opponent, seed, 0.5, true);
  for (const turn of game.trace ?? []) {
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
    const expected = predictOpponentReplies(board, opponent.name, currentSeed, history, turn.black.type === "pass" ? turn.consecutivePasses + 1 : 0);
    const actual = nativeForecast(
      board,
      history,
      turn.black.type === "pass" ? turn.consecutivePasses + 1 : 0,
      currentSeed,
      opponent.name,
    );
    const normalized = expected.replies.map((reply) => ({
      probability: reply.probability,
      ...(reply.move ? { move: reply.move } : {}),
      branch: reply.branch,
      cycleWaitsAfterSeed: reply.wait.cycleWaitsAfterSeed,
      fixedSleepMsAfterSeed: reply.wait.fixedSleepMsAfterSeed,
    }));
    if (actual.exact !== (expected.certainty === "exact")
      || JSON.stringify(actual.replies.map(replyKey)) !== JSON.stringify(normalized.map(replyKey))) {
      throw new Error(`C++ reply mismatch at game seed ${seed}, turn ${turn.turn}:\n${JSON.stringify({ actual, expected }, null, 2)}`);
    }
    const actualMove = turn.white.type === "pass" ? undefined : { x: turn.white.x, y: turn.white.y };
    if (!actual.replies.some((reply) => JSON.stringify(reply.move) === JSON.stringify(actualMove))) {
      throw new Error(`upstream reply absent at game seed ${seed}, turn ${turn.turn}`);
    }
    checked++;
  }
}

console.log(`checked ${checked} reachable faction replies across ${scenarios.length} enemy/size scenarios`);

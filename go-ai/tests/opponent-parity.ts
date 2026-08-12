import { playMove, type GoBoard } from "../../shared/strategy/go/rules.ts";
import { predictOpponentReplies } from "../../shared/strategy/go/opponent.ts";
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

function nativeForecast(
  board: GoBoard,
  history: readonly string[][],
  passes: number,
  seed: number,
  opponent: string,
): { exact: boolean; replies: NativeReply[] } {
  const executable = `${import.meta.dir}/../build/release/go_cpp_oracle`;
  const result = Bun.spawnSync([
    executable,
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
    `${import.meta.dir}/../build/release/go_cpp_oracle`,
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
    `${import.meta.dir}/../build/release/go_cpp_oracle`, "board", "13", daemon.name,
    String(seed), String((seed ^ 0xa5a5a5a5) >>> 0),
  ]);
  if (result.exitCode !== 0 || result.stdout.toString().trim().split("\t")[1] !== expected.rows.join("")) {
    throw new Error(`C++ BitVerse board mismatch at seed ${seed}`);
  }
}
const scenarios = [
  ...ordinary.map((opponent, index) => ({ opponent, seed: goArenaSeeds(1, 73_000 + index * 2_000)[0]! })),
  ...([7, 9] as const).map((requestedSize, index) => ({
    opponent: { ...ordinary.find(({ name }) => name === "Illuminati")!, requestedSize },
    seed: goArenaSeeds(1, 91_000 + index * 2_000)[0]!,
  })),
  { opponent: daemon, seed: goArenaSeeds(1, 117_000)[0]! },
];
for (const { opponent, seed } of scenarios) {
  const game = await playGoArenaGame(opponent, seed, 0.5, true, { cooperativePlanning: false });
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

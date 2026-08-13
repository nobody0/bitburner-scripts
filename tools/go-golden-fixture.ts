/** Regenerate tests/fixtures/go-value.json from the exact promoted V9 models.
 *
 * C++ evaluates each full-precision champion while WebGPU evaluates the
 * exported q8 artifact. The browser gate therefore measures the real export
 * and shader error together; no TypeScript CPU model exists. Requires:
 *   cmake --build go-ai/build/release --target go_cpp_oracle
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DAEMON19_GO_MODEL } from "../shared/strategy/go/neural/models/daemon19.ts";
import { SMALL5_GO_MODEL } from "../shared/strategy/go/neural/models/small5.ts";
import { loadGoValueWeights } from "../shared/strategy/go/neural/artifact.ts";
import {
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
} from "../shared/strategy/go/opponent.ts";
import { GO_OPPONENTS } from "../shared/strategy/go/rules.ts";
import { GO_REWARD_RULES } from "../shared/strategy/go/rewards.ts";

const ROOT = join(import.meta.dir, "..");
const ORACLE = join(ROOT, "go-ai", "build", "release", "go_cpp_oracle");

interface FixtureCase {
  profile: "small5" | "daemon19";
  size: number;
  opponentIndex: number;
  board: string;
  winProbability: number;
  terminalScore: number;
  remainingRounds: number;
  legal?: string;
  state?: [number, number, number, number];
  behavior?: number[];
  moveLogits: number[];
}

/** Deterministic board soup. Positions need not be reachable: the value net
 * rates arbitrary result boards, so coverage matters more than legality. */
function syntheticBoard(size: number, seed: number, offline: boolean): string {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  let board = "";
  for (let index = 0; index < size * size; index++) {
    const roll = next();
    board += roll < 0.5 ? "." : roll < 0.72 ? "X" : roll < 0.94 ? "O" : offline ? "#" : ".";
  }
  return board;
}

const small5Model = join(ROOT, "go-ai", "small5-champion.model");
const daemon19Model = join(ROOT, "go-ai", "daemon19-champion.model");

const CASES: { profile: "small5" | "daemon19"; model: string; size: number; opponentIndex: number; board: string }[] = [];

for (let opponent = 0; opponent < 6; opponent++) {
  CASES.push({
    profile: "small5",
    model: small5Model,
    size: 5,
    opponentIndex: opponent,
    board: syntheticBoard(5, 100 + opponent, opponent % 2 === 0),
  });
}
CASES.push({ profile: "small5", model: small5Model, size: 5, opponentIndex: 3, board: ".".repeat(25) });
CASES.push({
  profile: "small5",
  model: small5Model,
  size: 5,
  opponentIndex: 5,
  board: "XXXXXXXXXOOOOO.OOOOX#..OX",
});
for (let index = 0; index < 4; index++) {
  CASES.push({
    profile: "daemon19",
    model: daemon19Model,
    size: 19,
    opponentIndex: 0,
    board: syntheticBoard(19, 500 + index, index % 2 === 0),
  });
}
// Sub-extent boards exercise the offline padding path used when the daemon19
// profile covers interrupted 7x7-13x13 games.
CASES.push({ profile: "daemon19", model: daemon19Model, size: 7, opponentIndex: 0, board: syntheticBoard(7, 900, true) });
CASES.push({ profile: "daemon19", model: daemon19Model, size: 13, opponentIndex: 0, board: syntheticBoard(13, 901, false) });

const results: FixtureCase[] = [];
for (const testCase of CASES) {
    const artifact = testCase.profile === "small5" ? SMALL5_GO_MODEL : DAEMON19_GO_MODEL;
    const weights = loadGoValueWeights(artifact);
    let legal: string | undefined;
    let state: [number, number, number, number] | undefined;
    let behavior: number[] | undefined;
    const command = (() => {
      legal = "";
      for (let x = 0; x < weights.extent; x++) for (let y = 0; y < weights.extent; y++) {
        legal += x < testCase.size && y < testCase.size
          && testCase.board[x * testCase.size + y] === "." ? "1" : "0";
      }
      state = [0.5, 3 / (2 * weights.extent * weights.extent), 1, 0];
      const opponent = testCase.profile === "small5"
        ? GO_OPPONENTS[testCase.opponentIndex]! : "????????????";
      behavior = Array.from(encodeOpponentTurnBehavior(
        opponentTurnBehavior(opponent, 10_200 + testCase.opponentIndex * 200),
        testCase.profile === "small5" ? GO_REWARD_RULES[opponent].komi : undefined,
      ));
      return [
        ORACLE, "value-v9", testCase.model, String(testCase.size), testCase.board,
        legal, ...state.map(String), behavior.join(","),
      ];
    })();
    const process = Bun.spawnSync(command);
    if (process.exitCode !== 0) {
      throw new Error(`go_cpp_oracle failed: ${process.stderr.toString()}`);
    }
    const lines = process.stdout.toString().trim().split("\n");
    const [win, power, rounds] = lines.shift()!.split("\t").map(Number);
    if (win === undefined || power === undefined || rounds === undefined) {
      throw new Error(`unexpected oracle output for ${testCase.board}`);
    }
    const moves: number[] = [];
    for (const [expectedIndex, line] of lines.entries()) {
      const [candidateIndex, move, ...candidateBranches] = line.split("\t").map(Number);
      if (candidateIndex !== expectedIndex || candidateBranches.length !== 13) {
        throw new Error(`unexpected V9 proposal output for ${testCase.profile} candidate ${expectedIndex}`);
      }
      moves.push(move!);
    }
    if (moves.length !== weights.extent * weights.extent + 1) {
      throw new Error(`incomplete V9 proposal output for ${testCase.profile}`);
    }
    results.push({
      profile: testCase.profile,
      size: testCase.size,
      opponentIndex: testCase.opponentIndex,
      board: testCase.board,
      winProbability: win,
      terminalScore: power,
      remainingRounds: rounds,
      ...(legal ? { legal } : {}),
      ...(state ? { state } : {}),
      ...(behavior ? { behavior } : {}),
      moveLogits: moves,
    });
}

const target = join(ROOT, "tests", "fixtures", "go-value.json");
const sha256 = async (path: string) => createHash("sha256")
  .update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
await Bun.write(target, `${JSON.stringify({
  schema: 2,
  champions: {
    small5: await sha256(small5Model),
    daemon19: await sha256(daemon19Model),
  },
  cases: results,
}, null, 2)}\n`);
console.log(`wrote ${results.length} golden predictions to ${target}`);

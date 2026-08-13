/** Regenerate tests/fixtures/go-value.json from the C++ trainer.
 *
 * The fixture pins the deployed TypeScript inference ports to the exact
 * predictions of go-ai's CandidateValueNetwork after the committed runtime
 * artifacts have been decoded. This tests the real storage representation,
 * including its intentional quantization, without replacing the native
 * network with a second TypeScript reference implementation. Requires:
 *   cmake --build go-ai/build/release --target go_cpp_oracle
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON19_GO_MODEL } from "../shared/strategy/go/neural/models/daemon19.ts";
import { SMALL5_GO_MODEL } from "../shared/strategy/go/neural/models/small5.ts";
import { goRuntimeCheckpointText } from "./go-runtime-model.ts";

const ROOT = join(import.meta.dir, "..");
const ORACLE = join(ROOT, "go-ai", "build", "release", "go_cpp_oracle");

interface FixtureCase {
  profile: "small5" | "daemon19";
  size: number;
  opponentIndex: number;
  board: string;
  winProbability: number;
  terminalPower: number;
  remainingRounds: number;
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

const scratch = mkdtempSync(join(tmpdir(), "go-runtime-models-"));

const small5Model = join(scratch, "small5-runtime.model");
const daemon19Model = join(scratch, "daemon19-runtime.model");

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
try {
  await Bun.write(small5Model, goRuntimeCheckpointText(SMALL5_GO_MODEL));
  await Bun.write(daemon19Model, goRuntimeCheckpointText(DAEMON19_GO_MODEL));
  for (const testCase of CASES) {
    const process = Bun.spawnSync([
      ORACLE,
      "value",
      testCase.model,
      String(testCase.size),
      String(testCase.opponentIndex),
      testCase.board,
    ]);
    if (process.exitCode !== 0) {
      throw new Error(`go_cpp_oracle failed: ${process.stderr.toString()}`);
    }
    const [win, power, rounds] = process.stdout.toString().trim().split("\t").map(Number);
    if (win === undefined || power === undefined || rounds === undefined) {
      throw new Error(`unexpected oracle output for ${testCase.board}`);
    }
    results.push({
      profile: testCase.profile,
      size: testCase.size,
      opponentIndex: testCase.opponentIndex,
      board: testCase.board,
      winProbability: win,
      terminalPower: power,
      remainingRounds: rounds,
    });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const target = join(ROOT, "tests", "fixtures", "go-value.json");
await Bun.write(target, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${results.length} golden predictions to ${target}`);

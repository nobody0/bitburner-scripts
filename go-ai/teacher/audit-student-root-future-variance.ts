/** Measure how much one frozen continuation misstates future-unknown value. */
import { createHash } from "node:crypto";
import {
  GO_ARENA_OPPONENTS, playGoArenaContinuationTrace, playGoArenaPositionTrace,
  type ForcedBlackAction, type GoArenaInitialState,
} from "./arena.ts";
import { advance } from "./export-v9-advisers.ts";

const TIE_ROLL = 0.5;
const ENGINE_CYCLE_MS = 200;
const PHASE_STRIDE = 7_919;

interface Position {
  elapsed: number;
  state: GoArenaInitialState;
  environmentId: string;
  seed: number;
  candidates: number[];
  positionContentSha256: string;
}
interface Manifest { schema: string; positions: Position[] }
interface Outcome { won: number; rate: number }

function flag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}
function numberFlag(name: string, fallback: number): number {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function heldout(environmentId: string): boolean {
  return Number.parseInt(sha(environmentId).slice(0, 8), 16) % 10 === 0;
}
function forced(index: number, size: number): ForcedBlackAction {
  return index === size * size ? "pass" : [Math.floor(index / size), index % size];
}
function better(left: Outcome, right: Outcome): number {
  return right.won - left.won || right.rate - left.rate;
}
function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function outcomes(position: Position, move: number, repetitions: number): Promise<Outcome[]> {
  const opponent = GO_ARENA_OPPONENTS[6]!;
  const baseline = await playGoArenaPositionTrace(
    opponent, position.seed, TIE_ROLL, position.state,
    forced(move, position.state.board.size), undefined, null);
  if (!baseline.completed || !baseline.trace?.length) throw new Error("baseline continuation failed");
  const result: Outcome[] = [{
    won: Number(baseline.won),
    rate: baseline.score.X * (baseline.won ? 1 : 0.5)
      / Math.max(position.elapsed + baseline.trace.length, 1),
  }];
  const next = advance(baseline.trace[0]);
  if (next.passes >= 2 || baseline.trace.length === 1) {
    while (result.length < repetitions) result.push(result[0]!);
    return result;
  }
  const nextDispatch = baseline.trace[1]!.dispatchPlaytime;
  for (let repetition = 1; repetition < repetitions; repetition++) {
    const continuation = await playGoArenaContinuationTrace(
      opponent,
      position.seed,
      TIE_ROLL,
      {
        board: next.board,
        previousBoards: next.history,
        consecutivePasses: next.passes,
        dispatchPlaytime: nextDispatch
          + repetition * PHASE_STRIDE * ENGINE_CYCLE_MS,
      },
      undefined,
      null,
    );
    if (!continuation.completed || !continuation.trace) throw new Error("future-phase continuation failed");
    result.push({
      won: Number(continuation.won),
      rate: continuation.score.X * (continuation.won ? 1 : 0.5)
        / Math.max(position.elapsed + 1 + continuation.trace.length, 1),
    });
  }
  return result;
}

async function main(): Promise<void> {
  const manifestPath = flag("--manifest");
  if (!manifestPath) throw new Error("missing --manifest");
  const repetitions = numberFlag("--repetitions", 4);
  const groupLimit = numberFlag("--groups", 4);
  const groupOffset = Number(flag("--group-offset", "0"));
  if (!Number.isSafeInteger(groupOffset) || groupOffset < 0) {
    throw new Error("--group-offset must be a non-negative integer");
  }
  const compressed = new Uint8Array(await Bun.file(manifestPath).arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(compressed))) as Manifest;
  if (manifest.schema !== "bitburner-go-student-root-manifest-v2") throw new Error("expected v2 manifest");
  const positions = manifest.positions.filter((position) => heldout(position.environmentId))
    .slice(groupOffset, groupOffset + groupLimit);
  if (positions.length !== groupLimit) throw new Error(`manifest has only ${positions.length} selected heldout groups`);
  let candidates = 0;
  let unstable = 0;
  let singleBestMatchesExpected = 0;
  let singleBestExpectedWin = 0;
  let expectedBestExpectedWin = 0;
  const groups: Record<string, unknown>[] = [];
  for (const position of positions) {
    const samples: Array<{ move: number; outcomes: Outcome[]; expected: Outcome }> = [];
    for (const move of position.candidates) {
      const values = await outcomes(position, move, repetitions);
      samples.push({ move, outcomes: values, expected: {
        won: mean(values.map((value) => value.won)),
        rate: mean(values.map((value) => value.rate)),
      } });
      candidates++;
      unstable += Number(new Set(values.map((value) => value.won)).size > 1);
    }
    const singleBest = [...samples].sort((left, right) =>
      better(left.outcomes[0]!, right.outcomes[0]!))[0]!;
    const expectedBest = [...samples].sort((left, right) => better(left.expected, right.expected))[0]!;
    singleBestMatchesExpected += Number(singleBest.move === expectedBest.move);
    singleBestExpectedWin += singleBest.expected.won;
    expectedBestExpectedWin += expectedBest.expected.won;
    groups.push({
      positionContentSha256: position.positionContentSha256,
      candidates: samples.length,
      unstableCandidates: samples.filter((sample) =>
        new Set(sample.outcomes.map((value) => value.won)).size > 1).length,
      singleBestMove: singleBest.move,
      expectedBestMove: expectedBest.move,
      singleBestExpectedWin: singleBest.expected.won,
      expectedBestExpectedWin: expectedBest.expected.won,
    });
    console.error(JSON.stringify({ completedGroups: groups.length, groupLimit }));
  }
  console.log(JSON.stringify({
    audit: "bitburner-go-student-root-future-variance-v1",
    manifest: manifestPath,
    groupOffset,
    groups: positions.length,
    repetitions,
    candidates,
    unstableCandidates: unstable,
    unstableCandidateRate: unstable / candidates,
    singleBestMatchesExpected,
    singleBestAgreement: singleBestMatchesExpected / positions.length,
    singleBestMeanExpectedWin: singleBestExpectedWin / positions.length,
    expectedBestMeanExpectedWin: expectedBestExpectedWin / positions.length,
    details: groups,
  }, null, 2));
}

if (import.meta.main) await main();

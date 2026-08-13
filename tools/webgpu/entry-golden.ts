/** Browser-side WGSL shader gate.
 *
 * Runs the deployed WebGPU backend against the same C++ golden fixture that
 * pins the C++ trainer: every case, every opponent head, and
 * all three outputs — win probability, terminal power, and remaining rounds.
 * Adds batch-vs-single consistency, a buffer-capacity growth pass, and
 * shader round-trip latency percentiles at production batch sizes.
 */
import fixture from "../../tests/fixtures/go-value.json";
import { loadGoValueWeights } from "../../shared/strategy/go/neural/artifact.ts";
import {
  decodeGoValue,
  goBoardWords,
  packGoBoard,
  type GoValuePrediction,
} from "../../shared/strategy/go/neural/backend.ts";
import {
  createRequiredWebGpuGoValueBackend,
  WebGpuGoValueBackend,
} from "../../shared/strategy/go/neural/webgpu.ts";
import { SMALL5_GO_MODEL } from "../../shared/strategy/go/neural/models/small5.ts";
import { DAEMON19_GO_MODEL } from "../../shared/strategy/go/neural/models/daemon19.ts";
import type { GoBoard } from "../../shared/strategy/go/rules.ts";
import {
  finalizeNeuralGoDecision,
  GoNeuralEngine,
  prepareNeuralGoDecision,
} from "../../shared/strategy/go/neural/engine.ts";
import { predictPreparedOpponentReplies } from "../../shared/strategy/go/opponent.ts";

interface FixtureCase {
  profile: "small5" | "daemon19";
  size: number;
  opponentIndex: number;
  board: string;
  winProbability: number;
  terminalPower: number;
  remainingRounds: number;
}

interface Deviation {
  winProbability: number;
  terminalPower: number;
  remainingRounds: number;
}

const WIN_TOLERANCE = 2e-3;
const RELATIVE_TOLERANCE = 5e-3;

function boardFromHash(size: number, hash: string): GoBoard {
  const rows: string[] = [];
  for (let x = 0; x < size; x++) rows.push(hash.slice(x * size, (x + 1) * size));
  return { rows, size };
}

function deviation(actual: GoValuePrediction, expected: GoValuePrediction): Deviation {
  return {
    winProbability: Math.abs(actual.winProbability - expected.winProbability),
    terminalPower: Math.abs(actual.terminalPower - expected.terminalPower)
      / Math.max(1, Math.abs(expected.terminalPower)),
    remainingRounds: Math.abs(actual.remainingRounds - expected.remainingRounds)
      / Math.max(1, Math.abs(expected.remainingRounds)),
  };
}

function worst(a: Deviation, b: Deviation): Deviation {
  return {
    winProbability: Math.max(a.winProbability, b.winProbability),
    terminalPower: Math.max(a.terminalPower, b.terminalPower),
    remainingRounds: Math.max(a.remainingRounds, b.remainingRounds),
  };
}

function withinTolerance(measured: Deviation): boolean {
  return measured.winProbability <= WIN_TOLERANCE
    && measured.terminalPower <= RELATIVE_TOLERANCE
    && measured.remainingRounds <= RELATIVE_TOLERANCE;
}

async function evaluateOne(
  backend: WebGpuGoValueBackend,
  board: GoBoard,
  opponentIndex: number,
): Promise<GoValuePrediction> {
  const packed = new Uint32Array(goBoardWords(backend.extent));
  packGoBoard(board, backend.extent, packed, 0);
  const raw = await backend.evaluateBatch({ packed, count: 1, opponentIndex });
  return decodeGoValue(raw, 0);
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarize(samples: number[]): { p50: number; p95: number; max: number } {
  samples.sort((a, b) => a - b);
  return {
    p50: +percentile(samples, 0.5).toFixed(2),
    p95: +percentile(samples, 0.95).toFixed(2),
    max: +samples.at(-1)!.toFixed(2),
  };
}

async function main(): Promise<unknown> {
  const failures: string[] = [];
  const coldStart: Record<string, { decodeMs: number; backendCreateMs: number }> = {};
  const smallDecodeAt = performance.now();
  const smallWeights = loadGoValueWeights(SMALL5_GO_MODEL);
  coldStart.small5 = { decodeMs: performance.now() - smallDecodeAt, backendCreateMs: 0 };
  const smallBackendAt = performance.now();
  const smallGpu = await createRequiredWebGpuGoValueBackend(smallWeights);
  coldStart.small5.backendCreateMs = performance.now() - smallBackendAt;
  const daemonDecodeAt = performance.now();
  const daemonWeights = loadGoValueWeights(DAEMON19_GO_MODEL);
  coldStart.daemon19 = { decodeMs: performance.now() - daemonDecodeAt, backendCreateMs: 0 };
  const daemonBackendAt = performance.now();
  const daemonGpu = await createRequiredWebGpuGoValueBackend(daemonWeights);
  coldStart.daemon19.backendCreateMs = performance.now() - daemonBackendAt;
  const weights = { small5: smallWeights, daemon19: daemonWeights };
  const gpu = { small5: smallGpu, daemon19: daemonGpu };

  // 1. C++ golden vectors through the real shader: all profiles, all heads,
  // all three outputs.
  let goldenDeviation: Deviation = { winProbability: 0, terminalPower: 0, remainingRounds: 0 };
  for (const golden of fixture as FixtureCase[]) {
    const prediction = await evaluateOne(
      gpu[golden.profile],
      boardFromHash(golden.size, golden.board),
      golden.opponentIndex,
    );
    const measured = deviation(prediction, golden);
    goldenDeviation = worst(goldenDeviation, measured);
    if (!withinTolerance(measured)) {
      failures.push(`golden ${golden.profile} head ${golden.opponentIndex} board ${golden.board.slice(0, 12)}…: `
        + `win ${prediction.winProbability} vs ${golden.winProbability}, `
        + `power ${prediction.terminalPower} vs ${golden.terminalPower}, `
        + `rounds ${prediction.remainingRounds} vs ${golden.remainingRounds}`);
    }
  }

  // 2. One dispatch per board must equal a shared batched dispatch exactly:
  // the workgroups are independent, so any difference is an indexing bug.
  const small5Cases = (fixture as FixtureCase[]).filter((golden) => golden.profile === "small5");
  const words5 = goBoardWords(gpu.small5.extent);
  for (const head of [...new Set(small5Cases.map((golden) => golden.opponentIndex))]) {
    const cases = small5Cases.filter((golden) => golden.opponentIndex === head);
    const packed = new Uint32Array(words5 * cases.length);
    cases.forEach((golden, index) =>
      packGoBoard(boardFromHash(golden.size, golden.board), gpu.small5.extent, packed, index * words5));
    const raw = new Float32Array(
      await gpu.small5.evaluateBatch({ packed, count: cases.length, opponentIndex: head }),
    );
    for (const [index, golden] of cases.entries()) {
      const single = await evaluateOne(gpu.small5, boardFromHash(golden.size, golden.board), head);
      const batched = decodeGoValue(raw, index);
      if (batched.winProbability !== single.winProbability
        || batched.terminalPower !== single.terminalPower
        || batched.remainingRounds !== single.remainingRounds) {
        failures.push(`batch/single mismatch at head ${head} board ${index}`);
      }
    }
  }

  // 3. Capacity growth: exceed the initial 512-board buffers in one dispatch.
  const bigCount = 700;
  const template = small5Cases[0]!;
  const reference = await evaluateOne(gpu.small5, boardFromHash(template.size, template.board), template.opponentIndex);
  const bigPacked = new Uint32Array(words5 * bigCount);
  for (let index = 0; index < bigCount; index++) {
    packGoBoard(boardFromHash(template.size, template.board), gpu.small5.extent, bigPacked, index * words5);
  }
  const bigRaw = await gpu.small5.evaluateBatch({ packed: bigPacked, count: bigCount, opponentIndex: template.opponentIndex });
  for (const probe of [0, 511, 512, bigCount - 1]) {
    const grown = decodeGoValue(bigRaw, probe);
    if (grown.winProbability !== reference.winProbability) {
      failures.push(`capacity growth mismatch at board ${probe}`);
    }
  }

  // 4. Shader round-trip latency at production batch sizes: a 5x5 decision is
  // ~28 result boards, a capped BitVerse decision ~400.
  const latency: Record<string, {
    requestToParsed: { p50: number; p95: number; max: number };
    mainThread: { p50: number; p95: number; max: number };
  }> = {};
  for (const [label, backend, count] of [
    ["small5x28", gpu.small5, 28],
    ["daemon19x400", gpu.daemon19, 400],
  ] as const) {
    const words = goBoardWords(backend.extent);
    const packed = new Uint32Array(words * count);
    const board = boardFromHash(
      backend.extent === 5 ? 5 : 19,
      label === "small5x28" ? template.board : (fixture as FixtureCase[]).find((golden) => golden.size === 19)!.board,
    );
    for (let index = 0; index < count; index++) packGoBoard(board, backend.extent, packed, index * words);
    const requestSamples: number[] = [];
    const mainThreadSamples: number[] = [];
    for (let round = 0; round < 60; round++) {
      await backend.evaluateBatch({ packed, count, opponentIndex: 0 });
      requestSamples.push(backend.lastTiming!.requestToParsedMs);
      mainThreadSamples.push(backend.lastTiming!.mainThreadMs);
    }
    requestSamples.sort((a, b) => a - b);
    mainThreadSamples.sort((a, b) => a - b);
    latency[label] = {
      requestToParsed: {
        p50: +percentile(requestSamples, 0.5).toFixed(2),
        p95: +percentile(requestSamples, 0.95).toFixed(2),
        max: +requestSamples.at(-1)!.toFixed(2),
      },
      mainThread: {
        p50: +percentile(mainThreadSamples, 0.5).toFixed(2),
        p95: +percentile(mainThreadSamples, 0.95).toFixed(2),
        max: +mainThreadSamples.at(-1)!.toFixed(2),
      },
    };
  }

  // 5. Benchmark the unsliced production planner by phase. Opponent prediction
  // is invoked explicitly before finalization so its exact cost is visible;
  // finalization then reuses the same memoized option spaces and includes the
  // real GPU dispatch, decoding, and ranking.
  const daemonFixture = (fixture as FixtureCase[]).find((golden) => golden.size === 19)!;
  const daemonBoard = boardFromHash(19, daemonFixture.board);
  const plannerEngine = new GoNeuralEngine(() => gpu.daemon19);
  const candidatePreparationSamples: number[] = [];
  const opponentPredictionSamples: number[] = [];
  const gpuAndSelectionSamples: number[] = [];
  const boardToMoveSamples: number[] = [];
  for (let round = 0; round < 30; round++) {
    const started = performance.now();
    const prepared = prepareNeuralGoDecision({
      board: daemonBoard,
      currentPlayer: "Black",
      status: "inProgress",
      opponent: "????????????",
      previousBoards: [],
      komi: 9.5,
    });
    const preparedAt = performance.now();
    const seed = 1_200 + round * 200;
    for (const candidate of prepared.candidates) {
      if (!candidate.terminal) predictPreparedOpponentReplies(candidate.opponent!, seed);
    }
    const predictedAt = performance.now();
    await finalizeNeuralGoDecision(prepared, [seed], plannerEngine);
    const finalizedAt = performance.now();
    candidatePreparationSamples.push(preparedAt - started);
    opponentPredictionSamples.push(predictedAt - preparedAt);
    gpuAndSelectionSamples.push(finalizedAt - predictedAt);
    boardToMoveSamples.push(performance.now() - started);
  }
  const planning = {
    candidatePreparation: summarize(candidatePreparationSamples),
    opponentPrediction: summarize(opponentPredictionSamples),
    gpuAndSelection: summarize(gpuAndSelectionSamples),
    boardToMove: summarize(boardToMoveSamples),
  };

  const daemonLatency = latency["daemon19x400"]!;
  if (daemonLatency.mainThread.max >= 2) {
    failures.push(`daemon19x400 main-thread work ${daemonLatency.mainThread.max}ms exceeded 2ms`);
  }
  if (daemonLatency.requestToParsed.max >= 30) {
    failures.push(`daemon19x400 request-to-result ${daemonLatency.requestToParsed.max}ms exceeded 30ms`);
  }
  if (planning.opponentPrediction.p95 >= 15) {
    failures.push(`opponent prediction p95 ${planning.opponentPrediction.p95}ms exceeded 15ms`);
  }
  if (planning.boardToMove.p95 >= 50) {
    failures.push(`19x19 board-to-move p95 ${planning.boardToMove.p95}ms exceeded 50ms`);
  }
  for (const [profile, timing] of Object.entries(coldStart)) {
    timing.decodeMs = +timing.decodeMs.toFixed(2);
    timing.backendCreateMs = +timing.backendCreateMs.toFixed(2);
    if (timing.decodeMs >= 10) failures.push(`${profile} artifact decode ${timing.decodeMs}ms exceeded 10ms`);
  }

  gpu.small5.dispose();
  gpu.daemon19.dispose();
  return {
    ok: failures.length === 0,
    goldenCases: (fixture as FixtureCase[]).length,
    maxDeviation: {
      winProbability: +goldenDeviation.winProbability.toExponential(2),
      terminalPowerRelative: +goldenDeviation.terminalPower.toExponential(2),
      remainingRoundsRelative: +goldenDeviation.remainingRounds.toExponential(2),
    },
    latency,
    coldStart,
    planning,
    failures,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __goWebGpuResult: Promise<unknown>;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false,
  failures: [`harness error: ${String(error)}`],
}));
export {};

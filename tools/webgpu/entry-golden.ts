/** Browser-side WGSL shader gate.
 *
 * Runs the deployed WebGPU backend against the same C++ golden fixture that
 * pins the C++ trainer: every case, every opponent head, and
 * all three outputs — win probability, terminal score, and remaining rounds.
 * Adds batch-vs-single consistency, a buffer-capacity growth pass, and
 * shader round-trip latency percentiles at production batch sizes.
 */
import fixture from "../../tests/fixtures/go-value.json";
import { loadGoValueWeights } from "../../shared/strategy/go/neural/artifact.ts";
import {
  decodeGoValue,
  goBoardWords,
  goLegalWords,
  packGoBoard,
  type GoValueBackend,
  type GoValuePrediction,
} from "../../shared/strategy/go/neural/backend.ts";
import {
  createRequiredWebGpuGoValueBackend,
  DEFAULT_GO_WEBGPU_OPTIMIZATIONS,
  type GoWebGpuOptimizationFlags,
} from "../../shared/strategy/go/neural/webgpu.ts";
import { SMALL5_GO_MODEL } from "../../shared/strategy/go/neural/models/small5.ts";
import { DAEMON19_GO_MODEL } from "../../shared/strategy/go/neural/models/daemon19.ts";
import type { GoBoard } from "../../shared/strategy/go/rules.ts";
import {
  finalizeNeuralGoDecision,
  GoNeuralEngine,
  prepareNeuralGoDecision,
} from "../../shared/strategy/go/neural/engine.ts";

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

interface FixtureDocument {
  schema: 2;
  champions: { small5: string; daemon19: string };
  cases: FixtureCase[];
}

interface Deviation {
  winProbability: number;
  terminalScore: number;
  remainingRounds: number;
}

// The deployed artifact is row-wise q8, while the oracle reads the original
// full-precision champion. These bounds admit the measured storage error but
// remain tight enough to detect tensor ordering and shader arithmetic bugs.
const WIN_TOLERANCE = 3e-3;
const RELATIVE_TOLERANCE = 2e-2;

function boardFromHash(size: number, hash: string): GoBoard {
  const rows: string[] = [];
  for (let x = 0; x < size; x++) rows.push(hash.slice(x * size, (x + 1) * size));
  return { rows, size };
}

function deviation(actual: GoValuePrediction, expected: GoValuePrediction): Deviation {
  return {
    winProbability: Math.abs(actual.winProbability - expected.winProbability),
    terminalScore: Math.abs(actual.terminalScore - expected.terminalScore)
      / Math.max(1, Math.abs(expected.terminalScore)),
    remainingRounds: Math.abs(actual.remainingRounds - expected.remainingRounds)
      / Math.max(1, Math.abs(expected.remainingRounds)),
  };
}

function worst(a: Deviation, b: Deviation): Deviation {
  return {
    winProbability: Math.max(a.winProbability, b.winProbability),
    terminalScore: Math.max(a.terminalScore, b.terminalScore),
    remainingRounds: Math.max(a.remainingRounds, b.remainingRounds),
  };
}

function withinTolerance(measured: Deviation): boolean {
  return measured.winProbability <= WIN_TOLERANCE
    && measured.terminalScore <= RELATIVE_TOLERANCE
    && measured.remainingRounds <= RELATIVE_TOLERANCE;
}

async function evaluateOne(
  backend: GoValueBackend,
  board: GoBoard,
  input: FixtureCase,
): Promise<GoValuePrediction> {
  const packed = new Uint32Array(goBoardWords(backend.extent));
  packGoBoard(board, backend.extent, packed, 0);
  const raw = await backend.evaluateBatch({
    packed, count: 1,
    ...v9Fields(backend, [input]),
  });
  return decodeGoValue(raw, 0);
}

async function evaluateProposalOne(
  backend: GoValueBackend,
  board: GoBoard,
  input: FixtureCase,
) {
  const packed = new Uint32Array(goBoardWords(backend.extent));
  packGoBoard(board, backend.extent, packed, 0);
  return backend.evaluateProposal({ packed, count: 1, ...v9Fields(backend, [input]) });
}

function v9Fields(backend: GoValueBackend, inputs: readonly FixtureCase[]): {
  legal: Uint32Array;
  state: Float32Array;
  behavior: Float32Array;
} {
  const count = Math.max(inputs.length, 1);
  const legalWords = goLegalWords(backend.extent);
  const legal = new Uint32Array(legalWords * count);
  const state = new Float32Array(4 * count);
  const behavior = new Float32Array(backend.behaviorFeatures * count);
  for (let row = 0; row < inputs.length; row++) {
    const input = inputs[row]!;
    if (!input.legal || input.state?.length !== 4
      || input.behavior?.length !== backend.behaviorFeatures) {
      throw new Error("V9 golden fixture is missing legal/state/behavior inputs");
    }
    for (let point = 0; point < input.legal.length; point++) {
      if (input.legal[point] === "1") legal[row * legalWords + (point >> 5)]! |= 1 << (point & 31);
    }
    state.set(input.state, row * 4);
    behavior.set(input.behavior, row * backend.behaviorFeatures);
  }
  return { legal, state, behavior };
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
  const overrides = (globalThis as {
    __goWebGpuOptimizations?: Partial<GoWebGpuOptimizationFlags>;
  }).__goWebGpuOptimizations ?? {};
  const optimizations = { ...DEFAULT_GO_WEBGPU_OPTIMIZATIONS, ...overrides };
  const failures: string[] = [];
  const fixtureDocument = fixture as unknown as FixtureDocument;
  const fixtureCases = fixtureDocument.cases;
  if (fixtureDocument.schema !== 2) failures.push("golden fixture is not V9 schema 2");
  if (fixtureDocument.champions.small5 !== SMALL5_GO_MODEL.sourceSha256
    || fixtureDocument.champions.daemon19 !== DAEMON19_GO_MODEL.sourceSha256) {
    failures.push("golden fixture does not identify the exported V9 champions");
  }
  const coldStart: Record<string, { decodeMs: number; backendCreateMs: number }> = {};
  const smallDecodeAt = performance.now();
  const smallWeights = loadGoValueWeights(SMALL5_GO_MODEL);
  coldStart.small5 = { decodeMs: performance.now() - smallDecodeAt, backendCreateMs: 0 };
  const smallBackendAt = performance.now();
  const smallGpu = await createRequiredWebGpuGoValueBackend(smallWeights, optimizations);
  coldStart.small5.backendCreateMs = performance.now() - smallBackendAt;
  const daemonDecodeAt = performance.now();
  const daemonWeights = loadGoValueWeights(DAEMON19_GO_MODEL);
  coldStart.daemon19 = { decodeMs: performance.now() - daemonDecodeAt, backendCreateMs: 0 };
  const daemonBackendAt = performance.now();
  const daemonGpu = await createRequiredWebGpuGoValueBackend(daemonWeights, optimizations);
  coldStart.daemon19.backendCreateMs = performance.now() - daemonBackendAt;
  const gpu = { small5: smallGpu, daemon19: daemonGpu };

  // 1. C++ golden vectors through the real shader: all profiles and all
  // deployed value and proposal outputs. The reference is the promoted full-
  // precision checkpoint; measured deviations include q8 export error.
  let goldenDeviation: Deviation = { winProbability: 0, terminalScore: 0, remainingRounds: 0 };
  let proposalElements = 0;
  let proposalElementsWithinTolerance = 0;
  let proposalMaxAbsoluteError = 0;
  let shortlistSlots = 0;
  let shortlistMatches = 0;
  for (const golden of fixtureCases) {
    const backend = gpu[golden.profile];
    const raw = await evaluateProposalOne(backend, boardFromHash(golden.size, golden.board), golden);
    const prediction = decodeGoValue(raw.value, 0);
    const measured = deviation(prediction, golden);
    goldenDeviation = worst(goldenDeviation, measured);
    if (!withinTolerance(measured)) {
      failures.push(`golden ${golden.profile} head ${golden.opponentIndex} board ${golden.board.slice(0, 12)}…: `
        + `win ${prediction.winProbability} vs ${golden.winProbability}, `
        + `score ${prediction.terminalScore} vs ${golden.terminalScore}, `
        + `rounds ${prediction.remainingRounds} vs ${golden.remainingRounds}`);
    }
    const candidates = backend.extent * backend.extent + 1;
    if (golden.moveLogits.length !== candidates) {
      failures.push(`golden ${golden.profile} proposal dimensions are incomplete`);
      continue;
    }
    for (const [actualValues, expectedValues] of [[raw.moves, golden.moveLogits]] as const) {
      for (let index = 0; index < expectedValues.length; index++) {
        const expected = expectedValues[index]!;
        const error = Math.abs(actualValues[index]! - expected);
        proposalMaxAbsoluteError = Math.max(proposalMaxAbsoluteError, error);
        proposalElements++;
        if (error <= 0.02 + Math.abs(expected) * 0.01) proposalElementsWithinTolerance++;
      }
    }
    const legal = [...golden.legal!].flatMap((value, index) => value === "1" ? [index] : []);
    legal.push(candidates - 1);
    const top = (values: ArrayLike<number>) => [...legal]
      .sort((a, b) => values[b]! - values[a]!).slice(0, Math.min(8, legal.length));
    const expectedTop = top(golden.moveLogits);
    const actualTop = new Set(top(raw.moves));
    shortlistSlots += expectedTop.length;
    shortlistMatches += expectedTop.filter((candidate) => actualTop.has(candidate)).length;
  }
  const proposalAgreement = proposalElementsWithinTolerance / Math.max(1, proposalElements);
  const shortlistAgreement = shortlistMatches / Math.max(1, shortlistSlots);
  if (proposalAgreement < 0.999) {
    failures.push(`full-precision C++/q8 WebGPU proposal agreement ${(proposalAgreement * 100).toFixed(4)}% is below 99.9%`);
  }
  if (shortlistAgreement < 0.99) {
    failures.push(`C++/WebGPU top-8 shortlist agreement ${(shortlistAgreement * 100).toFixed(2)}% is below 99%`);
  }

  // 2. One dispatch per board must equal a shared batched dispatch exactly:
  // the workgroups are independent, so any difference is an indexing bug.
  const small5Cases = fixtureCases.filter((golden) => golden.profile === "small5");
  const words5 = goBoardWords(gpu.small5.extent);
  for (const head of [...new Set(small5Cases.map((golden) => golden.opponentIndex))]) {
    const cases = small5Cases.filter((golden) => golden.opponentIndex === head);
    const packed = new Uint32Array(words5 * cases.length);
    cases.forEach((golden, index) =>
      packGoBoard(boardFromHash(golden.size, golden.board), gpu.small5.extent, packed, index * words5));
    const raw = new Float32Array(
      await gpu.small5.evaluateBatch({ packed, count: cases.length,
        ...v9Fields(gpu.small5, cases) }),
    );
    for (const [index, golden] of cases.entries()) {
      const single = await evaluateOne(
        gpu.small5, boardFromHash(golden.size, golden.board), golden);
      const batched = decodeGoValue(raw, index);
      if (batched.winProbability !== single.winProbability
        || batched.terminalScore !== single.terminalScore
        || batched.remainingRounds !== single.remainingRounds) {
        failures.push(`batch/single mismatch at head ${head} board ${index}`);
      }
    }
  }

  // 3. Capacity growth: force several reallocations past the initial batch
  // capacity in one dispatch and prove the grown buffers still agree.
  const bigCount = 700;
  const template = small5Cases[0]!;
  const reference = await evaluateOne(
    gpu.small5, boardFromHash(template.size, template.board), template);
  const bigPacked = new Uint32Array(words5 * bigCount);
  for (let index = 0; index < bigCount; index++) {
    packGoBoard(boardFromHash(template.size, template.board), gpu.small5.extent, bigPacked, index * words5);
  }
  const bigInputs = Array.from({ length: bigCount }, () => template);
  const bigRaw = await gpu.small5.evaluateBatch({
    packed: bigPacked, count: bigCount,
    ...v9Fields(gpu.small5, bigInputs),
  });
  for (const probe of [0, 511, 512, bigCount - 1]) {
    const grown = decodeGoValue(bigRaw, probe);
    if (grown.winProbability !== reference.winProbability) {
      failures.push(`capacity growth mismatch at board ${probe}`);
    }
  }

  // 4. Shader round-trip latency at production batch sizes: a 5x5 decision is
  // ~28 result boards, and eight BitVerse finalists with up to thirteen
  // response branches (~104 boards). Value-only evaluation must not pay for
  // proposal outputs on these continuation boards.
  const latency: Record<string, {
    requestToParsed: { p50: number; p95: number; max: number };
    mainThread: { p50: number; p95: number; max: number };
  }> = {};
  for (const [label, backend, count] of [
    ["small5x28", gpu.small5, 28],
    ["daemon19x104", gpu.daemon19, 104],
  ] as const) {
    const words = goBoardWords(backend.extent);
    const packed = new Uint32Array(words * count);
    const board = boardFromHash(
      backend.extent === 5 ? 5 : 19,
      label === "small5x28" ? template.board : fixtureCases.find((golden) => golden.size === 19)!.board,
    );
    for (let index = 0; index < count; index++) packGoBoard(board, backend.extent, packed, index * words);
    const requestSamples: number[] = [];
    const mainThreadSamples: number[] = [];
    for (let round = 0; round < 60; round++) {
      await backend.evaluateBatch({ packed, count,
        ...v9Fields(backend, Array.from({ length: count }, () =>
          backend.extent === 5 ? template : fixtureCases.find((golden) => golden.size === 19)!)) });
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

  // 5. Benchmark the production planner. V9 prepares opponent option spaces
  // lazily only after proposal selection, so finalization owns reply
  // prediction and is measured together with the GPU batch.
  const daemonFixture = fixtureCases.find((golden) => golden.size === 19)!;
  const daemonBoard = boardFromHash(19, daemonFixture.board);
  const plannerEngine = new GoNeuralEngine(() => gpu.daemon19);
  const candidatePreparationSamples: number[] = [];
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
    await finalizeNeuralGoDecision(prepared, [seed], plannerEngine);
    const finalizedAt = performance.now();
    candidatePreparationSamples.push(preparedAt - started);
    gpuAndSelectionSamples.push(finalizedAt - preparedAt);
    boardToMoveSamples.push(performance.now() - started);
  }
  const planning = {
    candidatePreparation: summarize(candidatePreparationSamples),
    gpuAndSelection: summarize(gpuAndSelectionSamples),
    boardToMove: summarize(boardToMoveSamples),
  };

  const daemonLatency = latency["daemon19x104"]!;
  if (daemonLatency.mainThread.max >= 2) {
    failures.push(`daemon19x104 main-thread work ${daemonLatency.mainThread.max}ms exceeded 2ms`);
  }
  if (daemonLatency.requestToParsed.p95 >= 80 || daemonLatency.requestToParsed.max >= 120) {
    failures.push(`daemon19x104 request-to-result p95/max `
      + `${daemonLatency.requestToParsed.p95}/${daemonLatency.requestToParsed.max}ms exceeded 80/120ms`);
  }
  if (planning.gpuAndSelection.p95 >= 45) {
    failures.push(`finalization p95 ${planning.gpuAndSelection.p95}ms exceeded 45ms`);
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
    optimizations,
    goldenCases: fixtureCases.length,
    maxDeviation: {
      winProbability: +goldenDeviation.winProbability.toExponential(2),
      terminalScoreRelative: +goldenDeviation.terminalScore.toExponential(2),
      remainingRoundsRelative: +goldenDeviation.remainingRounds.toExponential(2),
    },
    quantization: {
      proposalElementAgreement: +proposalAgreement.toFixed(6),
      proposalMaxAbsoluteError: +proposalMaxAbsoluteError.toExponential(3),
      top8ShortlistAgreement: +shortlistAgreement.toFixed(6),
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

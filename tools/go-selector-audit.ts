/** Differential audit for the complete V9 proposal/reply/value selector. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import fixture from "../tests/fixtures/go-value.json";
import {
  finalizeNeuralGoDecision,
  GO_PROFILE_CANDIDATE_LIMITS,
  GoNeuralEngine,
  prepareNeuralGoDecision,
  selectV9ProposalFinalists,
  type GoModelProfile,
} from "../shared/strategy/go/neural/engine.ts";
import type {
  GoProposalRaw,
  GoValueBackend,
  GoValueBatch,
} from "../shared/strategy/go/neural/backend.ts";
import type { GoAction, GoView } from "../shared/strategy/go/rules.ts";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";

const ROOT = join(import.meta.dir, "..");
const ORACLE = join(ROOT, "go-ai", "build", "release", "go_cpp_oracle");
const PYTHON = join(ROOT, "go-ai", ".venv-gpu", "bin", "python");
const PYTHON_AUDIT = join(ROOT, "go-ai", "gpu", "audit_v9_selector.py");
const models: Record<GoModelProfile, string> = {
  small5: join(ROOT, "go-ai", "small5-champion.model"),
  daemon19: join(ROOT, "go-ai", "daemon19-champion.model"),
};

interface AuditCase {
  name: string;
  view: GoView;
  seeds: number[];
  dispatchPlaytime?: number;
  python: boolean;
}

interface SelectorResult {
  name: string;
  action: string;
  finalists: number;
  finalistMoves?: number[];
  proposalPasses?: number;
  winProbability?: number;
  powerPerRound?: number;
}

interface NativeResult {
  move: number;
  finalists: number[];
  winProbability: number;
  powerPerRound: number;
}

interface PythonResult {
  move: number;
  finalists: number[];
  baseK: number;
  behavior: number[];
  futureBehavior: number[];
  winProbability: number;
  powerPerRound: number;
}

function rows(hash: string, size: number): string[] {
  return Array.from({ length: size }, (_, x) => hash.slice(x * size, (x + 1) * size));
}

function board(hash: string, size: number) {
  return { size, rows: rows(hash, size) };
}

const empty5 = ".".repeat(25);
const smallHistoryBoard = fixture.cases.find((entry) => entry.profile === "small5"
  && entry.opponentIndex === 1 && entry.board !== empty5)!.board;
const daemonBoard = fixture.cases.find((entry) => entry.profile === "daemon19" && entry.size === 19)!.board;
const daemonView: GoView = {
  board: board(daemonBoard, 19), currentPlayer: "Black", status: "inProgress",
  opponent: "????????????", previousBoards: [], consecutivePasses: 0, komi: 9.5,
};
const cases: AuditCase[] = [
  {
    name: "small5-single-seed-deployment-k4-flat-boundary",
    view: {
      board: board(empty5, 5), currentPlayer: "Black", status: "inProgress",
      opponent: "Daedalus", previousBoards: [], consecutivePasses: 0, komi: 5.5,
    },
    seeds: [10_200], python: true,
  },
  {
    name: "small5-history-two-seed-reservation",
    view: {
      board: board(smallHistoryBoard, 5), currentPlayer: "Black", status: "inProgress",
      opponent: "Slum Snakes",
      previousBoards: [rows(empty5, 5), rows(`X${".".repeat(24)}`, 5),
        rows(`${".".repeat(6)}X${".".repeat(18)}`, 5), rows(`${".".repeat(12)}X${".".repeat(12)}`, 5)],
      consecutivePasses: 0, komi: 3.5,
    },
    seeds: [10_200, 10_400], python: false,
  },
  {
    name: "small5-terminal-second-pass",
    view: {
      board: board(`O${".".repeat(24)}`, 5), currentPlayer: "Black", status: "inProgress",
      opponent: "Daedalus", previousBoards: Array.from({ length: 14 }, () => rows(empty5, 5)),
      consecutivePasses: 1, candidateLimit: 8, komi: 5.5,
    },
    seeds: [10_200], python: true,
  },
  { name: "daemon19-single-seed-deployment-k1", view: daemonView, seeds: [1_200], python: true },
  {
    name: "daemon19-single-seed-base8-control",
    view: { ...daemonView, candidateLimit: 8 }, seeds: [1_200], python: true,
  },
  {
    name: "daemon19-single-seed-base16-training-control",
    view: { ...daemonView, candidateLimit: 16 }, seeds: [1_200], python: false,
  },
  {
    name: "daemon19-two-seed-reservation",
    view: daemonView, seeds: [1_200, 1_400], python: false,
  },
  {
    name: "small5-successful-cheat",
    view: {
      board: board(empty5, 5), currentPlayer: "Black", status: "inProgress",
      opponent: "Netburners", previousBoards: [], consecutivePasses: 0, komi: 1.5,
      cheat: { unlocked: true, count: 0, successByCount: [1], candidateLimit: 2, doubleMoveLimit: 1 },
    },
    seeds: [10_200], dispatchPlaytime: 10_000, python: false,
  },
];

function profileOf(view: GoView): GoModelProfile {
  return view.board.size <= 5 ? "small5" : "daemon19";
}

function actionKey(action: GoAction): string {
  if (action.type === "move") return `move:${action.x},${action.y}`;
  if (action.type === "cheatTwoMoves") {
    return `cheatTwoMoves:${action.x1},${action.y1}:${action.x2},${action.y2}`;
  }
  if (action.type === "cheatRemoveRouter" || action.type === "cheatDestroyNode"
    || action.type === "cheatRepairNode") return `${action.type}:${action.x},${action.y}`;
  return action.type;
}

function moveAction(move: number, size: number): string {
  return move === size * size ? "pass" : `move:${Math.floor(move / size)},${move % size}`;
}

function historyArgument(view: GoView): string {
  return view.previousBoards.length ? view.previousBoards.map((value) => value.join("")).join(",") : "-";
}

function checkedSpawn(command: string[], stdin?: string): string {
  const result = stdin === undefined
    ? Bun.spawnSync(command)
    : Bun.spawnSync(command, { stdin: new TextEncoder().encode(stdin) });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function nativeSelect(auditCase: AuditCase): NativeResult | undefined {
  if (auditCase.view.cheat) return undefined;
  const profile = profileOf(auditCase.view);
  const limit = auditCase.view.candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS[profile];
  return JSON.parse(checkedSpawn([
    ORACLE, "select-v9", models[profile], String(auditCase.view.board.size),
    auditCase.view.opponent, auditCase.seeds.join(","),
    String(Math.floor(auditCase.view.previousBoards.length / 2)),
    String(auditCase.view.consecutivePasses ?? 0), auditCase.view.board.rows.join(""),
    historyArgument(auditCase.view), String(limit),
  ])) as NativeResult;
}

function pythonSelect(auditCase: AuditCase): PythonResult | undefined {
  if (!auditCase.python || auditCase.seeds.length !== 1 || auditCase.view.cheat) return undefined;
  const profile = profileOf(auditCase.view);
  return JSON.parse(checkedSpawn([
    PYTHON, PYTHON_AUDIT, "--model", models[profile], "--size", String(auditCase.view.board.size),
    "--opponent", auditCase.view.opponent, "--seed", String(auditCase.seeds[0]),
    "--elapsed", String(Math.floor(auditCase.view.previousBoards.length / 2)),
    "--passes", String(auditCase.view.consecutivePasses ?? 0),
    "--board", auditCase.view.board.rows.join(""), "--history", historyArgument(auditCase.view),
    "--base-k", String(auditCase.view.candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS[profile]),
    "--oracle", ORACLE,
  ])) as PythonResult;
}

function inverseWin(value: number): number {
  return Math.log(value / (1 - value));
}

function inversePositive(value: number): number {
  return Math.log(Math.max(value, Number.MIN_VALUE));
}

class CppCheckpointBackend implements GoValueBackend {
  readonly proposals: GoProposalRaw[] = [];
  readonly proposalStates: number[][] = [];
  readonly proposalBehaviors: number[][] = [];
  readonly valueStates: number[][] = [];
  readonly valueBehaviors: number[][] = [];

  constructor(
    readonly extent: number,
    readonly behaviorFeatures: number,
    readonly model: string,
  ) {}

  private inputRows(batch: GoValueBatch): string[] {
    const words = Math.ceil((this.extent * this.extent) / 16);
    const legalWords = Math.ceil((this.extent * this.extent) / 32);
    return Array.from({ length: batch.count }, (_, row) => {
      let boardHash = "";
      let legal = "";
      for (let point = 0; point < this.extent * this.extent; point++) {
        const packed = batch.packed[row * words + (point >> 4)]!;
        const code = (packed >> ((point & 15) * 2)) & 3;
        boardHash += code === 1 ? "X" : code === 2 ? "O" : code === 3 ? "#" : ".";
        legal += (batch.legal[row * legalWords + (point >> 5)]! & (1 << (point & 31))) ? "1" : "0";
      }
      const state = Array.from(batch.state.slice(row * 4, row * 4 + 4));
      const behavior = Array.from(batch.behavior.slice(
        row * this.behaviorFeatures, (row + 1) * this.behaviorFeatures));
      return [this.extent, boardHash, legal, ...state, behavior.join(",")].join("\t");
    });
  }

  private evaluate(batch: GoValueBatch): Array<{ raw: number[]; moves: number[] }> {
    const output = checkedSpawn(
      [ORACLE, "value-v9-batch", this.model], `${this.inputRows(batch).join("\n")}\n`)
      .trim().split("\n");
    if (output.length !== batch.count) throw new Error("C++ V9 batch row count mismatch");
    return output.map((line) => {
      const [win, score, remaining, moves = ""] = line.split("\t");
      return {
        raw: [inverseWin(Number(win)), inversePositive(Number(score)), inversePositive(Number(remaining))],
        moves: moves ? moves.split(",").map(Number) : [],
      };
    });
  }

  evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    for (let row = 0; row < batch.count; row++) {
      this.valueStates.push(Array.from(batch.state.slice(row * 4, row * 4 + 4)));
      this.valueBehaviors.push(Array.from(batch.behavior.slice(
        row * this.behaviorFeatures, (row + 1) * this.behaviorFeatures)));
    }
    return Promise.resolve(new Float32Array(this.evaluate(batch).flatMap((row) => row.raw)));
  }

  evaluateProposal(batch: GoValueBatch): Promise<GoProposalRaw> {
    for (let row = 0; row < batch.count; row++) {
      this.proposalStates.push(Array.from(batch.state.slice(row * 4, row * 4 + 4)));
      this.proposalBehaviors.push(Array.from(batch.behavior.slice(
        row * this.behaviorFeatures, (row + 1) * this.behaviorFeatures)));
    }
    const evaluated = this.evaluate(batch);
    const result = {
      value: new Float32Array(evaluated.flatMap((row) => row.raw)),
      moves: new Float32Array(evaluated.flatMap((row) => row.moves)),
    };
    this.proposals.push({ value: new Float32Array(result.value), moves: new Float32Array(result.moves) });
    return Promise.resolve(result);
  }

  dispose(): void {}
}

async function fullPrecisionSelect(auditCase: AuditCase): Promise<{
  result: SelectorResult;
  backend: CppCheckpointBackend;
}> {
  const profile = profileOf(auditCase.view);
  const backend = new CppCheckpointBackend(profile === "small5" ? 5 : 19,
    profile === "small5" ? 31 : 30, models[profile]);
  const engine = new GoNeuralEngine(() => backend);
  const prepared = prepareNeuralGoDecision(auditCase.view);
  const decision = await finalizeNeuralGoDecision(
    prepared, auditCase.seeds, engine, auditCase.dispatchPlaytime);
  const action = decision.action;
  const selected = action.type === "move"
    ? decision.ranked.find((move) => move.x === action.x && move.y === action.y)
    : undefined;
  let finalistMoves: number[] | undefined;
  if (!auditCase.view.cheat && backend.proposals[0]) {
    const area = backend.extent * backend.extent;
    const moveIndices = prepared.candidates.map((candidate) => candidate.action.type === "pass"
      ? area : candidate.action.type === "move"
        ? candidate.action.x * backend.extent + candidate.action.y : area);
    const requested = auditCase.view.candidateLimit
      ?? GO_PROFILE_CANDIDATE_LIMITS[profileOf(auditCase.view)];
    const selection = selectV9ProposalFinalists(
      moveIndices, backend.proposals[0].moves, auditCase.seeds.length, area + 1, requested);
    finalistMoves = selection.finalists.map((index) => moveIndices[index]!);
  }
  return {
    result: {
      name: auditCase.name,
      action: actionKey(decision.action),
      finalists: decision.finalists,
      finalistMoves,
      proposalPasses: backend.proposals.length,
      winProbability: selected?.score,
      powerPerRound: selected?.powerPerRound,
    },
    backend,
  };
}

function sameSet(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

// The audit's full-f32 legs must evaluate the deployed weights' own
// full-precision authority: the champion checkpoint normally, or a
// derivative's retained source checkpoint when one is installed. The
// derivative binding must still name the installed champion.
for (const profile of ["small5", "daemon19"] as const) {
  const championHash = createHash("sha256")
    .update(new Uint8Array(await Bun.file(models[profile]).arrayBuffer())).digest("hex");
  const artifact = await Bun.file(join(
    ROOT, "shared", "strategy", "go", "neural", "models", `${profile}.ts`)).text();
  const artifactSource = artifact.match(/sourceSha256:\s*"([0-9a-f]{64})"/)?.[1];
  const binding = artifact.match(/championSha256:\s*"([0-9a-f]{64})"/)?.[1] ?? artifactSource;
  if (binding !== championHash) {
    throw new Error(`selector audit requires the installed ${profile} artifact; `
      + `artifact binds ${binding ?? "no champion hash"}, champion ${championHash}`);
  }
  const sourcePath = artifact.match(/^ {2}source: ("(?:[^"\\]|\\.)*"),$/m)?.[1];
  if (binding !== artifactSource && sourcePath) {
    models[profile] = join(ROOT, JSON.parse(sourcePath) as string);
  }
}
const championHashes = Object.fromEntries(await Promise.all(Object.entries(models).map(async ([profile, path]) => [
  profile,
  createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex"),
]))) as Record<GoModelProfile, string>;

const failures: string[] = [];
const divergences: string[] = [
  "daemon19 training loss/diagnostic recall remains hard K=16; deployment is strict K=1 (GO_PROFILE_CANDIDATE_LIMITS), and K>1 actor authority remains a separately gated research path",
  "Python sidecar actors receive one exact seed, so multi-seed reservation is covered by native C++/TypeScript/WebGPU audit cases rather than Python gameplay",
  "evaluate_v9.py --win-tolerance is a non-deployment analysis variant only when explicitly set above its zero default",
  "successful go.cheat selection exists only in TypeScript/WebGPU and has no legal-Go C++/Python actor equivalent",
];
const rowsOut: Array<{
  name: string;
  native?: NativeResult;
  python?: PythonResult;
  fullF32: SelectorResult;
  proposalExactRolls: number[][];
  valueFutureRolls: number[][];
}> = [];
for (const auditCase of cases) {
  const native = nativeSelect(auditCase);
  const python = pythonSelect(auditCase);
  const { result: fullF32, backend } = await fullPrecisionSelect(auditCase);
  if (native) {
    const expectedAction = moveAction(native.move, auditCase.view.board.size);
    if (fullF32.action !== expectedAction) {
      failures.push(`${auditCase.name}: C++ action ${expectedAction} != TypeScript/full-f32 ${fullF32.action}`);
    }
    if (!sameSet(native.finalists, fullF32.finalistMoves)) {
      failures.push(`${auditCase.name}: C++ and TypeScript/full-f32 finalist sets differ`);
    }
  }
  if (native && python) {
    if (python.move !== native.move) failures.push(`${auditCase.name}: Python and C++ actions differ`);
    if (!sameSet(python.finalists, native.finalists)) {
      failures.push(`${auditCase.name}: Python and C++ finalist sets differ`);
    }
    if (Math.abs(python.winProbability - native.winProbability) > 2e-4
      || Math.abs(python.powerPerRound - native.powerPerRound)
        / Math.max(1, Math.abs(native.powerPerRound)) > 2e-4) {
      failures.push(`${auditCase.name}: Python and C++ selected values/elapsed denominator differ`);
    }
  }
  if (native && fullF32.winProbability !== undefined
    && (Math.abs(fullF32.winProbability - native.winProbability) > 2e-6
      || Math.abs(fullF32.powerPerRound! - native.powerPerRound)
        / Math.max(1, Math.abs(native.powerPerRound)) > 2e-6)) {
    failures.push(`${auditCase.name}: TypeScript and C++ selected values/elapsed denominator differ`);
  }
  const proposalExactRolls = backend.proposalBehaviors
    .slice(0, auditCase.seeds.length).map((value) => value.slice(1, 4));
  if (proposalExactRolls.some((value) => value.some((roll) => roll < 0 || roll > 1))) {
    failures.push(`${auditCase.name}: proposal behavior did not carry exact [0,1] rolls`);
  }
  if (python && backend.proposalBehaviors[0]
    && python.behavior.some((value, index) => Math.abs(value - backend.proposalBehaviors[0]![index]!) > 1e-6)) {
    failures.push(`${auditCase.name}: Python/native and TypeScript proposal behavior differ`);
  }
  // The proposal behavior is validated independently by the native/Python
  // state record; continuation batches must always carry unknown-roll -1s.
  const valueFutureRolls = backend.valueBehaviors.map((value) => value.slice(1, 4));
  if (valueFutureRolls.some((value) => value.some((roll) => roll !== -1))) {
    failures.push(`${auditCase.name}: post-reply value behavior retained a consumed exact roll`);
  }
  const elapsed = Math.floor(auditCase.view.previousBoards.length / 2);
  const denominator = 2 * backend.extent * backend.extent;
  if (backend.proposalStates[0]
    && Math.abs(backend.proposalStates[0][1]! - elapsed / denominator) > 1e-7) {
    failures.push(`${auditCase.name}: proposal elapsed feature uses the wrong denominator`);
  }
  if (backend.valueStates.some((value) =>
    Math.abs(value[1]! - (elapsed + 1) / denominator) > 1e-7)) {
    failures.push(`${auditCase.name}: post-reply elapsed feature is not actor elapsed + 1`);
  }
  rowsOut.push({
    name: auditCase.name, native, python, fullF32,
    proposalExactRolls,
    valueFutureRolls: valueFutureRolls.slice(0, 3),
  });
}

const browser = await runInHeadlessChrome(
  join(ROOT, "tools", "webgpu", "entry-selector-audit.ts"), 300_000,
  { __goSelectorAuditCases: cases.map(({ python: _python, ...auditCase }) => auditCase) });
const browserResult = browser.result as { ok: boolean; results?: SelectorResult[]; failures?: string[] };
if (!browserResult.ok || !browserResult.results) {
  failures.push(...(browserResult.failures ?? ["WebGPU selector audit did not return results"]));
} else {
  for (const measured of browserResult.results) {
    const reference = rowsOut.find((row) => row.name === measured.name)!.fullF32;
    if (measured.action !== reference.action) {
      failures.push(`${measured.name}: q8/f16 WebGPU action ${measured.action} != full-f32 ${reference.action}`);
    }
    if (measured.finalists !== reference.finalists) {
      failures.push(`${measured.name}: q8/f16 WebGPU finalist count differs from full-f32`);
    }
    if (reference.finalistMoves && !sameSet(measured.finalistMoves, reference.finalistMoves)) {
      const deployed = new Set(measured.finalistMoves ?? []);
      const full = new Set(reference.finalistMoves);
      const dropped = reference.finalistMoves.filter((move) => !deployed.has(move));
      const added = [...deployed].filter((move) => !full.has(move));
      divergences.push(`${measured.name}: q8/f16 WebGPU replaced finalists [${dropped}] with [${added}] `
        + `while the selected action remained ${measured.action}`);
    }
  }
}

const deploymentK1 = rowsOut.find((row) => row.name === "daemon19-single-seed-deployment-k1")!;
const base8 = rowsOut.find((row) => row.name === "daemon19-single-seed-base8-control")!;
const k16 = rowsOut.find((row) => row.name === "daemon19-single-seed-base16-training-control")!;
if (!sameSet(base8.fullF32.finalistMoves, k16.fullF32.finalistMoves)) {
  divergences.push(`installed daemon19 checkpoint: base K=8 expanded to ${base8.fullF32.finalists} finalists, `
    + `whereas K=16 expanded to ${k16.fullF32.finalists}; selected action stayed ${base8.fullF32.action}`);
}
if (deploymentK1.fullF32.finalists !== 1) {
  failures.push(`daemon19 deployment K=1 retained ${deploymentK1.fullF32.finalists} finalists; the strict policy-only contract requires exactly one`);
}
const report = {
  ok: failures.length === 0,
  checkpointSha256: championHashes,
  contract: {
    deploymentCandidateLimits: GO_PROFILE_CANDIDATE_LIMITS,
    trainingDiagnosticK: { small5: 8, daemon19: 16 },
    actorAuthorityGate: "profile deployment K plus adaptive boundary expansion above K=1",
    adaptiveBoundaryGap: 0.25,
    pythonSeedModel: "one exact sidecar seed",
    deploymentSeedModel: "one or more rollover candidates with per-seed reservation above K=1",
    cheatCoverage: "TypeScript/full-f32 and q8/f16 WebGPU only; not a legal-Go Python/C++ actor path",
  },
  deploymentK1: {
    finalists: deploymentK1.fullF32.finalists,
    action: deploymentK1.fullF32.action,
  },
  k16VersusBase8: {
    base8Finalists: base8.fullF32.finalists,
    k16Finalists: k16.fullF32.finalists,
    sameAction: base8.fullF32.action === k16.fullF32.action,
    sameFinalistSet: sameSet(base8.fullF32.finalistMoves, k16.fullF32.finalistMoves),
  },
  cases: rowsOut.map((row) => ({
    ...row,
    webgpu: browserResult.results?.find((result) => result.name === row.name),
  })),
  divergences,
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);

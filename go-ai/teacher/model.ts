/** Three-output model loader and candidate policy for the copied arena.
 *
 * The current seed is used only by the outer candidate enumerator to derive
 * the immediate opponent response. It is never inserted into neural inputs.
 */
import type { ArenaBlackInput, ArenaBlackPolicy } from "./arena.ts";
import {
  legalMoves,
  playMove,
  type GoAction,
  type GoBoard,
  type GoDecision,
} from "./strategy/decide.ts";
import {
  predictPreparedOpponentReplies,
  prepareOpponentPosition,
} from "./strategy/opponent.ts";
import { alignedAiSeed } from "./strategy/rng.ts";

interface LoadedModel {
  extent: number;
  hidden: number;
  inputSize: number;
  opponentFeatures: number;
  outputHeads: number;
  localContext: boolean;
  resultBoardOnly: boolean;
  spatialBoard: boolean;
  w1: Float64Array;
  b1: Float64Array;
  w2: Float64Array;
  b2: Float64Array;
  convolution: Float64Array;
  convolutionBias: Float64Array;
}

interface Prediction {
  winProbability: number;
  terminalPower: number;
  remainingTurns: number;
}

interface PreparedPrediction {
  before: GoBoard;
  hiddenBase: Float64Array;
  spatialDense?: Float64Array;
  spatialActivation?: Float64Array;
  spatialCounts?: Int32Array;
  opponentIndex: number;
}

function readVector(tokens: readonly string[], cursor: { value: number }): Float64Array {
  const count = Number(tokens[cursor.value++]);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid model tensor length");
  const result = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const value = Number(tokens[cursor.value++]);
    if (!Number.isFinite(value)) throw new Error("invalid model tensor value");
    result[index] = value;
  }
  return result;
}

export async function loadCandidateModel(path: string): Promise<LoadedModel> {
  const tokens = (await Bun.file(path).text()).trim().split(/\s+/);
  const cursor = { value: 0 };
  const magic = tokens[cursor.value++];
  if (magic !== "bitburner-go-value-v2" && magic !== "bitburner-go-value-v3"
    && magic !== "bitburner-go-value-v4" && magic !== "bitburner-go-value-v5"
    && magic !== "bitburner-go-value-v6" && magic !== "bitburner-go-value-v7") {
    throw new Error("unsupported Go model");
  }
  const extent = Number(tokens[cursor.value++]);
  const hidden = Number(tokens[cursor.value++]);
  const opponentFeatures = magic === "bitburner-go-value-v3" || magic === "bitburner-go-value-v4"
    || magic === "bitburner-go-value-v5"
    || magic === "bitburner-go-value-v6" || magic === "bitburner-go-value-v7"
    ? Number(tokens[cursor.value++]) : 7;
  const outputHeads = magic === "bitburner-go-value-v4" || magic === "bitburner-go-value-v5"
    || magic === "bitburner-go-value-v6" || magic === "bitburner-go-value-v7"
    ? Math.max(opponentFeatures, 1) : 1;
  const localContext = magic === "bitburner-go-value-v5";
  const spatialBoard = magic === "bitburner-go-value-v7";
  const resultBoardOnly = magic === "bitburner-go-value-v6" || spatialBoard;
  const inputSize = spatialBoard ? 8 * 5 * 5 + opponentFeatures
    : (resultBoardOnly ? 3 : 8) * extent * extent
      + (resultBoardOnly ? 0 : 2) + opponentFeatures + (localContext ? 588 : 0);
  const w1 = readVector(tokens, cursor);
  const b1 = readVector(tokens, cursor);
  const w2 = readVector(tokens, cursor);
  const b2 = readVector(tokens, cursor);
  const convolution = spatialBoard ? readVector(tokens, cursor) : new Float64Array();
  const convolutionBias = spatialBoard ? readVector(tokens, cursor) : new Float64Array();
  if (w1.length !== hidden * inputSize || b1.length !== hidden
    || w2.length !== outputHeads * hidden * 3 || b2.length !== outputHeads * 3
    || spatialBoard && (convolution.length !== 8 * 3 * 3 * 3 || convolutionBias.length !== 8)) {
    throw new Error("Go model tensor shape mismatch");
  }
  return { extent, hidden, inputSize, opponentFeatures, outputHeads, localContext,
    resultBoardOnly, spatialBoard, w1, b1, w2, b2, convolution, convolutionBias };
}

function localContextFeatures(
  before: GoBoard,
  candidate: readonly [number, number] | undefined,
  response: readonly [number, number] | undefined,
  after: GoBoard,
): number[] {
  const radius = 3;
  const width = 7;
  const anchorSize = 3 * width * width;
  const result: number[] = [];
  const add = (anchor: number, board: GoBoard, center: readonly [number, number] | undefined) => {
    if (!center) return;
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
      const x = center[0] + dx;
      const y = center[1] + dy;
      const cell = x >= 0 && y >= 0 && x < board.size && y < board.size
        ? board.rows[x]![y]! : "#";
      const channel = cell === "X" ? 0 : cell === "O" ? 1 : cell === "#" ? 2 : -1;
      if (channel >= 0) result.push(anchor * anchorSize + channel * width * width
        + (dx + radius) * width + dy + radius);
    }
  };
  add(0, before, candidate);
  add(1, after, candidate);
  add(2, before, response);
  add(3, after, response);
  return result;
}

function activeFeatures(
  model: LoadedModel,
  before: GoBoard,
  candidate: readonly [number, number] | undefined,
  response: readonly [number, number] | undefined,
  after: GoBoard,
  opponentIndex: number,
): number[] {
  const area = model.extent * model.extent;
  const active: number[] = [];
  const board = (value: GoBoard, planeBase: number) => {
    for (let x = 0; x < model.extent; x++) for (let y = 0; y < model.extent; y++) {
      const cell = x < value.size && y < value.size ? value.rows[x]![y]! : "#";
      const plane = cell === "X" ? planeBase : cell === "O" ? planeBase + 1
        : cell === "#" ? planeBase + 2 : -1;
      if (plane >= 0) active.push(plane * area + x * model.extent + y);
    }
  };
  if (model.resultBoardOnly) board(after, 0);
  else {
    board(before, 0);
    if (candidate) active.push(3 * area + candidate[0] * model.extent + candidate[1]);
    if (response) active.push(4 * area + response[0] * model.extent + response[1]);
    board(after, 5);
  }
  const scalar = (model.resultBoardOnly ? 3 : 8) * area;
  if (!model.resultBoardOnly && !candidate) active.push(scalar);
  if (!model.resultBoardOnly && !response) active.push(scalar + 1);
  if (model.opponentFeatures > 0) {
    if (opponentIndex >= model.opponentFeatures) throw new Error("opponent is outside model profile");
    active.push(scalar + (model.resultBoardOnly ? 0 : 2) + opponentIndex);
  }
  if (model.localContext) {
    const base = scalar + 2 + model.opponentFeatures;
    for (const index of localContextFeatures(before, candidate, response, after)) active.push(base + index);
  }
  return active;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const e = Math.exp(-value);
    return 1 / (1 + e);
  }
  const e = Math.exp(value);
  return e / (1 + e);
}

function positiveOutput(value: number): number {
  const logValue = value > 20 ? value : value < -20 ? Math.exp(value) : Math.log1p(Math.exp(value));
  return Math.expm1(Math.min(logValue, 40));
}

function predict(model: LoadedModel, active: readonly number[], opponentIndex: number): Prediction {
  const hidden = new Float64Array(model.hidden);
  for (let h = 0; h < model.hidden; h++) {
    let value = model.b1[h]!;
    const offset = h * model.inputSize;
    for (const index of active) value += model.w1[offset + index]!;
    hidden[h] = Math.tanh(value);
  }
  const raw = new Float64Array(3);
  const head = model.outputHeads > 1 ? opponentIndex : 0;
  for (let output = 0; output < 3; output++) {
    let value = model.b2[head * 3 + output]!;
    const offset = (head * 3 + output) * model.hidden;
    for (let h = 0; h < model.hidden; h++) value += model.w2[offset + h]! * hidden[h]!;
    raw[output] = value;
  }
  return {
    winProbability: sigmoid(raw[0]!),
    terminalPower: positiveOutput(raw[1]!),
    remainingTurns: positiveOutput(raw[2]!),
  };
}

function spatialEncoding(model: LoadedModel, board: GoBoard, opponentIndex: number) {
  const channels = 8;
  const poolExtent = 5;
  const area = model.extent * model.extent;
  const pooled = new Float64Array(channels * poolExtent * poolExtent + model.opponentFeatures);
  const activation = new Float64Array(channels * area);
  const counts = new Int32Array(poolExtent * poolExtent);
  for (let x = 0; x < model.extent; x++) for (let y = 0; y < model.extent; y++) {
    const poolX = Math.floor(x * poolExtent / model.extent);
    const poolY = Math.floor(y * poolExtent / model.extent);
    const bin = poolX * poolExtent + poolY;
    counts[bin]++;
    for (let channel = 0; channel < channels; channel++) {
      let value = model.convolutionBias[channel]!;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= model.extent || ny >= model.extent) continue;
        const cell = cellAt(board, model.extent, nx, ny);
        const plane = cell === "X" ? 0 : cell === "O" ? 1 : cell === "#" ? 2 : -1;
        if (plane < 0) continue;
        const weight = ((channel * 3 + plane) * 3 + dx + 1) * 3 + dy + 1;
        value += model.convolution[weight]!;
      }
      const activated = Math.tanh(value);
      activation[channel * area + x * model.extent + y] = activated;
      pooled[channel * poolExtent * poolExtent + bin] += activated;
    }
  }
  for (let channel = 0; channel < channels; channel++) {
    for (let bin = 0; bin < counts.length; bin++) {
      pooled[channel * counts.length + bin] /= counts[bin]!;
    }
  }
  if (model.opponentFeatures > 0) {
    if (opponentIndex >= model.opponentFeatures) throw new Error("opponent is outside model profile");
    pooled[channels * poolExtent * poolExtent + opponentIndex] = 1;
  }
  return { pooled, activation, counts };
}

function predictSpatialDense(
  model: LoadedModel,
  pooled: Float64Array,
  opponentIndex: number,
): Prediction {
  const active: number[] = [];
  for (let index = 0; index < pooled.length; index++) if (pooled[index] !== 0) active.push(index);
  const hidden = new Float64Array(model.hidden);
  for (let h = 0; h < model.hidden; h++) {
    let value = model.b1[h]!;
    const offset = h * model.inputSize;
    for (const index of active) value += model.w1[offset + index]! * pooled[index]!;
    hidden[h] = Math.tanh(value);
  }
  const raw = new Float64Array(3);
  const head = model.outputHeads > 1 ? opponentIndex : 0;
  for (let output = 0; output < 3; output++) {
    let value = model.b2[head * 3 + output]!;
    const offset = (head * 3 + output) * model.hidden;
    for (let h = 0; h < model.hidden; h++) value += model.w2[offset + h]! * hidden[h]!;
    raw[output] = value;
  }
  return {
    winProbability: sigmoid(raw[0]!),
    terminalPower: positiveOutput(raw[1]!),
    remainingTurns: positiveOutput(raw[2]!),
  };
}

function predictSpatial(model: LoadedModel, board: GoBoard, opponentIndex: number): Prediction {
  return predictSpatialDense(model, spatialEncoding(model, board, opponentIndex).pooled, opponentIndex);
}

function cellAt(board: GoBoard, extent: number, x: number, y: number): string {
  return x < board.size && y < board.size ? board.rows[x]![y]! : "#";
}

function planeFor(cell: string, blackPlane: number): number {
  return cell === "X" ? blackPlane : cell === "O" ? blackPlane + 1
    : cell === "#" ? blackPlane + 2 : -1;
}

function preparePrediction(
  model: LoadedModel,
  before: GoBoard,
  opponentIndex: number,
): PreparedPrediction {
  const area = model.extent * model.extent;
  const scalar = (model.resultBoardOnly ? 3 : 8) * area;
  const hiddenBase = new Float64Array(model.b1);
  if (model.spatialBoard) {
    const spatial = spatialEncoding(model, before, opponentIndex);
    return { before, hiddenBase, spatialDense: spatial.pooled,
      spatialActivation: spatial.activation, spatialCounts: spatial.counts, opponentIndex };
  }
  for (let h = 0; h < model.hidden; h++) {
    const row = h * model.inputSize;
    let value = hiddenBase[h]!;
    for (let x = 0; x < model.extent; x++) for (let y = 0; y < model.extent; y++) {
      const point = x * model.extent + y;
      const cell = cellAt(before, model.extent, x, y);
      const beforePlane = planeFor(cell, 0);
      const afterPlane = planeFor(cell, 5);
      if (!model.resultBoardOnly && beforePlane >= 0) {
        value += model.w1[row + beforePlane * area + point]!;
      }
      const valuePlane = model.resultBoardOnly ? beforePlane : afterPlane;
      if (valuePlane >= 0) value += model.w1[row + valuePlane * area + point]!;
    }
    if (model.opponentFeatures > 0) {
      if (opponentIndex >= model.opponentFeatures) throw new Error("opponent is outside model profile");
      value += model.w1[row + scalar + (model.resultBoardOnly ? 0 : 2) + opponentIndex]!;
    }
    hiddenBase[h] = value;
  }
  return { before, hiddenBase, opponentIndex };
}

function predictPrepared(
  model: LoadedModel,
  prepared: PreparedPrediction,
  candidate: readonly [number, number] | undefined,
  response: readonly [number, number] | undefined,
  after: GoBoard,
): Prediction {
  if (model.spatialBoard) {
    if (!prepared.spatialDense || !prepared.spatialActivation || !prepared.spatialCounts) {
      throw new Error("missing prepared spatial input");
    }
    const channels = 8;
    const poolExtent = 5;
    const area = model.extent * model.extent;
    const affected = new Uint8Array(area);
    for (let x = 0; x < model.extent; x++) for (let y = 0; y < model.extent; y++) {
      if (cellAt(prepared.before, model.extent, x, y) === cellAt(after, model.extent, x, y)) continue;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const cx = x + dx;
        const cy = y + dy;
        if (cx >= 0 && cy >= 0 && cx < model.extent && cy < model.extent) {
          affected[cx * model.extent + cy] = 1;
        }
      }
    }
    const pooled = new Float64Array(prepared.spatialDense);
    for (let x = 0; x < model.extent; x++) for (let y = 0; y < model.extent; y++) {
      const point = x * model.extent + y;
      if (!affected[point]) continue;
      const poolX = Math.floor(x * poolExtent / model.extent);
      const poolY = Math.floor(y * poolExtent / model.extent);
      const bin = poolX * poolExtent + poolY;
      for (let channel = 0; channel < channels; channel++) {
        let value = model.convolutionBias[channel]!;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= model.extent || ny >= model.extent) continue;
          const cell = cellAt(after, model.extent, nx, ny);
          const plane = cell === "X" ? 0 : cell === "O" ? 1 : cell === "#" ? 2 : -1;
          if (plane < 0) continue;
          const weight = ((channel * 3 + plane) * 3 + dx + 1) * 3 + dy + 1;
          value += model.convolution[weight]!;
        }
        pooled[channel * poolExtent * poolExtent + bin] += (Math.tanh(value)
          - prepared.spatialActivation[channel * area + point]!) / prepared.spatialCounts[bin]!;
      }
    }
    return predictSpatialDense(model, pooled, prepared.opponentIndex);
  }
  const area = model.extent * model.extent;
  const scalar = (model.resultBoardOnly ? 3 : 8) * area;
  const changes: { point: number; oldPlane: number; newPlane: number }[] = [];
  for (let x = 0; x < model.extent; x++) for (let y = 0; y < model.extent; y++) {
    const oldCell = cellAt(prepared.before, model.extent, x, y);
    const newCell = cellAt(after, model.extent, x, y);
    if (oldCell !== newCell) changes.push({
      point: x * model.extent + y,
      oldPlane: planeFor(oldCell, model.resultBoardOnly ? 0 : 5),
      newPlane: planeFor(newCell, model.resultBoardOnly ? 0 : 5),
    });
  }
  const hidden = new Float64Array(model.hidden);
  const context = model.localContext
    ? localContextFeatures(prepared.before, candidate, response, after) : [];
  const contextBase = scalar + 2 + model.opponentFeatures;
  for (let h = 0; h < model.hidden; h++) {
    const row = h * model.inputSize;
    let value = prepared.hiddenBase[h]!;
    if (!model.resultBoardOnly) {
      value += candidate
        ? model.w1[row + 3 * area + candidate[0] * model.extent + candidate[1]]!
        : model.w1[row + scalar]!;
      value += response
        ? model.w1[row + 4 * area + response[0] * model.extent + response[1]]!
        : model.w1[row + scalar + 1]!;
    }
    for (const change of changes) {
      if (change.oldPlane >= 0) value -= model.w1[row + change.oldPlane * area + change.point]!;
      if (change.newPlane >= 0) value += model.w1[row + change.newPlane * area + change.point]!;
    }
    for (const index of context) value += model.w1[row + contextBase + index]!;
    hidden[h] = Math.tanh(value);
  }
  const raw = new Float64Array(3);
  const head = model.outputHeads > 1 ? prepared.opponentIndex : 0;
  for (let output = 0; output < 3; output++) {
    let value = model.b2[head * 3 + output]!;
    const offset = (head * 3 + output) * model.hidden;
    for (let h = 0; h < model.hidden; h++) value += model.w2[offset + h]! * hidden[h]!;
    raw[output] = value;
  }
  return {
    winProbability: sigmoid(raw[0]!),
    terminalPower: positiveOutput(raw[1]!),
    remainingTurns: positiveOutput(raw[2]!),
  };
}

function afterResponse(
  afterBlack: GoBoard,
  response: { x: number; y: number } | undefined,
  history: readonly string[][],
): GoBoard {
  if (!response) return afterBlack;
  const played = playMove(
    afterBlack,
    response.x,
    response.y,
    "O",
    new Set(history.map((board) => board.join(""))),
  );
  if (!played) throw new Error(`model forecast produced illegal reply ${response.x},${response.y}`);
  return played.board;
}

export function candidateModelPolicy(model: LoadedModel, opponentIndex: number): ArenaBlackPolicy {
  return candidateModelPolicyWithCandidates(model, opponentIndex);
}

export function candidateModelPolicyWithCandidates(
  model: LoadedModel,
  opponentIndex: number,
  candidateSource?: (input: ArenaBlackInput) => readonly (readonly [number, number] | undefined)[],
  minimumOverrideWinAdvantage = 0,
): ArenaBlackPolicy {
  return (input: ArenaBlackInput): GoDecision => {
    const candidates: (readonly [number, number] | undefined)[] = [
      ...(candidateSource
        ? candidateSource(input)
        : [...legalMoves(input.board, "X", input.previousBoards), undefined]),
    ];
    const currentSeed = alignedAiSeed(input.dispatchPlaytime, 0);
    const prepared = preparePrediction(model, input.board, opponentIndex);
    let best: { action: GoAction; win: number; utility: number } | undefined;
    let first: { action: GoAction; win: number; utility: number } | undefined;
    for (const candidate of candidates) {
      const oldHistory = new Set(input.previousBoards.map((board) => board.join("")));
      const played = candidate
        ? playMove(input.board, candidate[0], candidate[1], "X", oldHistory)
        : undefined;
      if (candidate && !played) throw new Error(`model enumerated illegal move ${candidate}`);
      const afterBlack = played?.board ?? input.board;
      const responseHistory = candidate
        ? [input.board.rows, ...input.previousBoards]
        : [...input.previousBoards];
      const blackPasses = candidate ? 0 : input.consecutivePasses + 1;
      const replies = blackPasses >= 2
        ? [{ move: undefined, probability: 1 }]
        : predictPreparedOpponentReplies(
          prepareOpponentPosition(afterBlack, input.opponent, responseHistory, blackPasses),
          currentSeed,
        ).replies;
      let win = 0;
      let utility = 0;
      for (const reply of replies) {
        const after = afterResponse(afterBlack, reply.move, responseHistory);
        const value = predictPrepared(
          model, prepared, candidate,
          reply.move ? [reply.move.x, reply.move.y] : undefined,
          after,
        );
        if (Bun.env.GO_AI_VERIFY_PREPARED === "1") {
          const reference = model.spatialBoard ? predictSpatial(model, after, opponentIndex)
            : predict(model, activeFeatures(
              model, input.board, candidate,
              reply.move ? [reply.move.x, reply.move.y] : undefined,
              after, opponentIndex,
            ), opponentIndex);
          for (const [actual, expected] of [
            [value.winProbability, reference.winProbability],
            [value.terminalPower, reference.terminalPower],
            [value.remainingTurns, reference.remainingTurns],
          ]) {
            if (Math.abs(actual - expected) > 1e-9 * Math.max(1, Math.abs(expected))) {
              throw new Error(`prepared model inference drift: ${actual} != ${expected}`);
            }
          }
        }
        win += reply.probability * value.winProbability;
        utility += reply.probability * value.terminalPower
          / Math.max(input.elapsedRounds + value.remainingTurns, 1e-6);
      }
      const action: GoAction = candidate
        ? { type: "move", x: candidate[0], y: candidate[1], why: "three-output neural candidate" }
        : { type: "pass", why: "three-output neural candidate" };
      if (!first) first = { action, win, utility };
      if (!best || win > best.win || win === best.win && utility > best.utility) {
        best = { action, win, utility };
      }
    }
    if (!best) throw new Error("model found no candidate");
    if (first && best !== first
      && best.win < first.win + Math.max(0, minimumOverrideWinAdvantage)) best = first;
    return {
      action: best.action,
      ranked: [],
      why: `three-output neural candidate; win=${best.win}; power/turn=${best.utility}`,
      finalists: candidates.length,
      positionValue: best.utility,
    };
  };
}

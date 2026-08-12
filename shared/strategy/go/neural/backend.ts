/** Backend contract for batched v7 board-value inference.
 *
 * Boards travel to a backend as 2-bit cell codes packed into u32 words, so a
 * worst-case 19x19 batch of ~400 result boards is ~38KB rather than megabytes
 * of float planes. Backends return the raw head pre-activations; the shared
 * decode below applies the sigmoid/softplus contract in float64 once.
 */
import type { GoBoard } from "../rules.ts";
import { GO_VALUE_OUTPUTS } from "./artifact.ts";

/** Packed cell codes. */
const GO_CELL_EMPTY = 0;
const GO_CELL_BLACK = 1;
const GO_CELL_WHITE = 2;
export const GO_CELL_OFFLINE = 3;

export interface GoValueBatch {
  /** 2-bit cell codes, extent-major `x * extent + y`, 16 cells per word,
   * `wordsPerBoard` words per board. */
  packed: Uint32Array;
  count: number;
  /** Head selector and one-hot input; ignored by zero-opponent profiles. */
  opponentIndex: number;
}

export interface GoValuePrediction {
  winProbability: number;
  terminalPower: number;
  remainingRounds: number;
}

export interface GoValueBackend {
  readonly extent: number;
  /** Raw pre-activations, `GO_VALUE_OUTPUTS` per board. The returned view is
   * only valid until the next call; callers must consume it immediately. */
  evaluateBatch(batch: GoValueBatch): Promise<Float32Array>;
  dispose(): void;
}

export function goBoardWords(extent: number): number {
  return Math.ceil((extent * extent) / 16);
}

/** Pack one board at `wordOffset`, padding cells beyond the board as offline
 * exactly like the trainer's feature encoder. */
export function packGoBoard(board: GoBoard, extent: number, packed: Uint32Array, wordOffset: number): void {
  const words = goBoardWords(extent);
  packed.fill(0, wordOffset, wordOffset + words);
  for (let x = 0; x < extent; x++) {
    const column = x < board.size ? board.rows[x]! : "";
    for (let y = 0; y < extent; y++) {
      const cell = y < column.length ? column[y]! : "#";
      const code = cell === "X" ? GO_CELL_BLACK
        : cell === "O" ? GO_CELL_WHITE
        : cell === "#" ? GO_CELL_OFFLINE
        : GO_CELL_EMPTY;
      if (code === GO_CELL_EMPTY) continue;
      const index = x * extent + y;
      packed[wordOffset + (index >> 4)]! |= code << ((index & 15) * 2);
    }
  }
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const e = Math.exp(value);
  return e / (1 + e);
}

function softplus(value: number): number {
  return value > 20 ? value : value < -20 ? Math.exp(value) : Math.log1p(Math.exp(value));
}

/** The trainer's output decode: sigmoid win probability and expm1(softplus)
 * for the two nonnegative regression heads. */
export function decodeGoValue(raw: ArrayLike<number>, board: number): GoValuePrediction {
  const base = board * GO_VALUE_OUTPUTS;
  return {
    winProbability: sigmoid(raw[base]!),
    terminalPower: Math.expm1(Math.min(softplus(raw[base + 1]!), 40)),
    remainingRounds: Math.expm1(Math.min(softplus(raw[base + 2]!), 40)),
  };
}

/** Selection denominator shared with the trainer's promotion metric. */
export function goPowerPerRound(prediction: GoValuePrediction, elapsedRounds: number): number {
  return prediction.terminalPower / Math.max(elapsedRounds + prediction.remainingRounds, 1e-6);
}

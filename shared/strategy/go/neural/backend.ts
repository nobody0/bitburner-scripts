/** Backend contract for batched board-value inference.
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
  /** V9 post-response legal-placement bits, 32 points per word. */
  legal: Uint32Array;
  /** V9 scalars per board: pass count / 2, elapsed fraction,
   * response-pass, response-no-op. */
  state: Float32Array;
  /** V9 behavior signature, `behaviorFeatures` scalars per board. */
  behavior: Float32Array;
  /** Optional precomputed tactical-v1 bit planes, eight planes per board. */
  tactical?: Uint32Array;
}

export interface GoProposalRaw {
  /** Three value pre-activations per board. */
  value: Float32Array;
  /** `extent*extent+1` move logits per board; pass is last. */
  moves: Float32Array;
}

export interface GoValuePrediction {
  winProbability: number;
  /** Loss-penalized raw Black score at the terminal position. */
  terminalScore: number;
  remainingRounds: number;
}

export interface GoValueBackend {
  readonly extent: number;
  readonly behaviorFeatures: number;
  readonly inputChannels?: 8 | 16;
  /** "absent" on a policy-only deployment derivative whose neutral value
   * tensors were stripped at export; such a backend serves proposals only and
   * `evaluateBatch` fails loudly. Undefined means "trained". */
  readonly valuePath?: "trained" | "absent";
  /** Raw pre-activations, `GO_VALUE_OUTPUTS` per board. The returned view is
   * only valid until the next call; callers must consume it immediately. */
  evaluateBatch(batch: GoValueBatch): Promise<Float32Array>;
  evaluateProposal(batch: GoValueBatch): Promise<GoProposalRaw>;
  dispose(): void;
}

export function goBoardWords(extent: number): number {
  return Math.ceil((extent * extent) / 16);
}

export function goLegalWords(extent: number): number {
  return Math.ceil((extent * extent) / 32);
}

const TACTICAL_NEIGHBORS = new Map<number, Int16Array>();
interface TacticalScratch {
  cells: Uint8Array;
  groupAt: Int16Array;
  libertySeen: Int16Array;
  groupColor: Uint8Array;
  groupFirstStone: Int16Array;
  stoneNext: Int16Array;
  groupLiberties: Int16Array;
  groupLastLiberty: Int16Array;
  pending: Int16Array;
  capturedMark: Int32Array;
  libertyMark: Int32Array;
  friendly: Int16Array;
  capturedGroups: Int16Array;
  merged: Int16Array;
}
const TACTICAL_SCRATCH = new Map<number, TacticalScratch>();

/** Pack tactical-v1's eight exact binary planes from the same board/legal
 * tensors consumed by V9. Plane order matches Python and the C++ oracle:
 * Black/White groups at one/two liberties, capture, multi-capture,
 * self-atari, and multi-group connection. */
export function packGoTactical(
  packed: Uint32Array,
  legal: Uint32Array,
  count: number,
  extent: number,
  destination?: Uint32Array,
): Uint32Array {
  const area = extent * extent;
  const boardWords = goBoardWords(extent);
  const planeWords = goLegalWords(extent);
  const required = count * 8 * planeWords;
  const output = destination ?? new Uint32Array(required);
  if (output.length < required) throw new Error("tactical-v1 destination is too small");
  output.fill(0, 0, required);
  let neighbors = TACTICAL_NEIGHBORS.get(extent);
  if (!neighbors) {
    neighbors = new Int16Array(area * 4);
    neighbors.fill(-1);
    for (let point = 0; point < area; point++) {
      const x = Math.floor(point / extent), y = point % extent;
      let adjacent = point * 4;
      if (x > 0) neighbors[adjacent++] = point - extent;
      if (x + 1 < extent) neighbors[adjacent++] = point + extent;
      if (y > 0) neighbors[adjacent++] = point - 1;
      if (y + 1 < extent) neighbors[adjacent] = point + 1;
    }
    TACTICAL_NEIGHBORS.set(extent, neighbors);
  }
  let scratch = TACTICAL_SCRATCH.get(extent);
  if (!scratch) {
    scratch = {
      cells: new Uint8Array(area), groupAt: new Int16Array(area),
      libertySeen: new Int16Array(area), groupColor: new Uint8Array(area),
      groupFirstStone: new Int16Array(area), stoneNext: new Int16Array(area),
      groupLiberties: new Int16Array(area), groupLastLiberty: new Int16Array(area),
      pending: new Int16Array(area), capturedMark: new Int32Array(area),
      libertyMark: new Int32Array(area), friendly: new Int16Array(4),
      capturedGroups: new Int16Array(4), merged: new Int16Array(area),
    };
    TACTICAL_SCRATCH.set(extent, scratch);
  }
  const { cells, groupAt, libertySeen, groupColor, groupFirstStone, stoneNext,
    groupLiberties, groupLastLiberty, pending, capturedMark, libertyMark,
    friendly, capturedGroups, merged } = scratch;
  capturedMark.fill(0);
  libertyMark.fill(0);
  let stamp = 0;
  for (let boardIndex = 0; boardIndex < count; boardIndex++) {
    for (let point = 0; point < area; point++) {
      cells[point] = (packed[boardIndex * boardWords + (point >> 4)]!
        >>> ((point & 15) * 2)) & 3;
    }
    groupAt.fill(-1);
    groupFirstStone.fill(-1);
    stoneNext.fill(-1);
    libertySeen.fill(0);
    let groupCount = 0;
    for (let start = 0; start < area; start++) {
      const color = cells[start]!;
      if ((color !== GO_CELL_BLACK && color !== GO_CELL_WHITE) || groupAt[start]! >= 0) continue;
      const id = groupCount++;
      groupColor[id] = color;
      groupLiberties[id] = 0;
      let pendingCount = 1;
      pending[0] = start;
      groupAt[start] = id;
      while (pendingCount) {
        const point = pending[--pendingCount]!;
        stoneNext[point] = groupFirstStone[id]!;
        groupFirstStone[id] = point;
        for (let edge = point * 4; edge < point * 4 + 4; edge++) {
          const other = neighbors[edge]!;
          if (other < 0) break;
          if (cells[other] === GO_CELL_EMPTY && libertySeen[other] !== id + 1) {
            libertySeen[other] = id + 1;
            groupLiberties[id]++;
            groupLastLiberty[id] = other;
          } else if (cells[other] === color && groupAt[other]! < 0) {
            groupAt[other] = id;
            pending[pendingCount++] = other;
          }
        }
      }
      const libertyCount = groupLiberties[id]!;
      const plane = color === GO_CELL_BLACK && libertyCount === 1 ? 0
        : color === GO_CELL_BLACK && libertyCount === 2 ? 1
        : color === GO_CELL_WHITE && libertyCount === 1 ? 2
        : color === GO_CELL_WHITE && libertyCount === 2 ? 3 : -1;
      if (plane >= 0) for (let stone = groupFirstStone[id]!; stone >= 0; stone = stoneNext[stone]!) {
        const offset = (boardIndex * 8 + plane) * planeWords + (stone >> 5);
        output[offset]! |= 1 << (stone & 31);
      }
    }
    for (let point = 0; point < area; point++) {
      if (((legal[boardIndex * planeWords + (point >> 5)]! >>> (point & 31)) & 1) === 0) continue;
      let friendlyCount = 0, capturedGroupCount = 0;
      for (let edge = point * 4; edge < point * 4 + 4; edge++) {
        const other: number = neighbors[edge]!;
        if (other < 0) break;
        const id = groupAt[other]!;
        if (id < 0) continue;
        if (groupColor[id] === GO_CELL_BLACK) {
          let duplicate = false;
          for (let index = 0; index < friendlyCount; index++) duplicate ||= friendly[index] === id;
          if (!duplicate) friendly[friendlyCount++] = id;
        } else if (groupLiberties[id] === 1 && groupLastLiberty[id] === point
        ) {
          let duplicate = false;
          for (let index = 0; index < capturedGroupCount; index++) {
            duplicate ||= capturedGroups[index] === id;
          }
          if (!duplicate) capturedGroups[capturedGroupCount++] = id;
        }
      }
      ++stamp;
      let captured = 0;
      for (let index = 0; index < capturedGroupCount; index++) {
        const id = capturedGroups[index]!;
        for (let stone = groupFirstStone[id]!; stone >= 0; stone = stoneNext[stone]!) {
          capturedMark[stone] = stamp;
          captured++;
        }
      }
      let mergedCount = 1;
      merged[0] = point;
      for (let index = 0; index < friendlyCount; index++) {
        const id = friendly[index]!;
        for (let stone = groupFirstStone[id]!; stone >= 0; stone = stoneNext[stone]!) {
          merged[mergedCount++] = stone;
        }
      }
      let liberties = 0;
      for (let index = 0; index < mergedCount; index++) {
        const stone = merged[index]!;
        for (let edge = stone * 4; edge < stone * 4 + 4; edge++) {
          const other = neighbors[edge]!;
          if (other < 0) break;
          if (libertyMark[other] !== stamp && (capturedMark[other] === stamp
            || (cells[other] === GO_CELL_EMPTY && other !== point))) {
            libertyMark[other] = stamp;
            liberties++;
          }
        }
      }
      const word = point >> 5, bit = 1 << (point & 31);
      if (captured > 0) output[(boardIndex * 8 + 4) * planeWords + word]! |= bit;
      if (captured >= 2) output[(boardIndex * 8 + 5) * planeWords + word]! |= bit;
      if (liberties === 1) output[(boardIndex * 8 + 6) * planeWords + word]! |= bit;
      if (friendlyCount >= 2) output[(boardIndex * 8 + 7) * planeWords + word]! |= bit;
    }
  }
  return output;
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
    terminalScore: Math.expm1(Math.min(softplus(raw[base + 1]!), 40)),
    remainingRounds: Math.expm1(Math.min(softplus(raw[base + 2]!), 40)),
  };
}

/** Selection denominator shared with the trainer's promotion metric. */
export function goScorePerRound(prediction: GoValuePrediction, elapsedRounds: number): number {
  return prediction.terminalScore / Math.max(elapsedRounds + prediction.remainingRounds, 1e-6);
}

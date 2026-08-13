/** Clean-room model of Bitburner's IPvGO faction AIs.
 *
 * This module deliberately depends only on our public board representation.
 * Differential simulator tests import the pinned game separately and keep this
 * transcription honest without shipping any game implementation.
 * Pinned upstream AI and scoring sources:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/goAI.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/boardAnalysis.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/scoring.ts */
import type { GoBoard, GoRewardOpponent, Stone } from "./rules.ts";
import {
  allEyes,
  analyzeBoard,
  cardinal,
  cellAt,
  disputedMoves,
  disputedTerritory,
  effectiveLiberties,
  evaluateMove,
  eyesByChain,
  legalPoints,
  pointKey,
  weakestNeighborChain,
  type GoAnalysis,
  type GoChain,
  type GoPoint,
} from "./analysis.ts";
import { patternMoves } from "./patterns.ts";
import { whrng } from "./rng.ts";

interface MoveOption {
  point: GoPoint;
  oldLibertyCount?: number;
  newLibertyCount?: number;
  createsLife?: boolean;
}

interface Options {
  capture?: MoveOption;
  defendCapture?: MoveOption;
  eyeMove?: MoveOption;
  eyeBlock?: MoveOption;
  pattern?: MoveOption;
  growth?: MoveOption;
  expansion?: MoveOption;
  jump?: MoveOption;
  defend?: MoveOption;
  surround?: MoveOption;
  corner?: MoveOption;
  random?: MoveOption;
}

export interface OpponentReplyForecast {
  /** Every response possible for this seeded turn, with exact multiplicity for
   * the sole unseeded `Math.random()` defense choice. */
  replies: readonly WeightedOpponentReply[];
  /** The only remaining ambiguity is the game's unseeded defense tie-break. */
  certainty: "exact" | "unseeded-defense-tie";
}

export type OpponentBranch =
  | "capture" | "defendCapture" | "eyeMove" | "surround" | "eyeBlock"
  | "corner" | "pattern" | "jump" | "growth" | "defend" | "expansion"
  | "random" | "pass";

export const GO_OPPONENT_BRANCHES = [
  "capture", "defendCapture", "eyeMove", "surround", "eyeBlock",
  "corner", "pattern", "jump", "growth", "defend", "expansion",
  "random", "pass",
] as const satisfies readonly OpponentBranch[];

export const GO_BEHAVIOR_BASE_FEATURES = 1 + 3
  + GO_OPPONENT_BRANCHES.length * 2;

/** The shared fallback pool is fixed by the upstream AI, not by opponent or
 * seed. Build it once: opponentTurnBehavior() runs per candidate per seed. */
const GO_FALLBACK_ENABLED: readonly number[] = GO_OPPONENT_BRANCHES.map((branch) => Number([
  "growth", "surround", "defend", "expansion", "pattern", "eyeMove", "eyeBlock", "pass",
].includes(branch)));

export interface OpponentTurnBehavior {
  /** Exact for this seed and opponent, never a probability. */
  smart: boolean;
  optionRoll: number;
  factionRoll: number;
  fallbackRoll: number;
  /** Zero means unavailable. Positive values are one-based priority ranks;
   * when a branch has multiple board-dependent guards, its earliest rank is
   * retained and the branch remains enabled. */
  priorityRanks: readonly number[];
  /** Branches in the shared fallback pool. Pass is enabled because it occurs
   * when no legal fallback survives on the candidate-dependent board. */
  fallbackEnabled: readonly number[];
}

function appendIlluminatiPriority(
  result: OpponentBranch[],
  factionRoll: number,
): void {
  result.push("capture", "defendCapture", "eyeMove", "surround", "eyeBlock", "corner", "pattern");
  if (factionRoll > 0.4) result.push("jump");
  // The late <=2-liberty surround is a second candidate-dependent guard for
  // the same semantic branch. Keeping it in the program preserves ranks of
  // any following additions while the vector exposes one branch capability.
  if (factionRoll < 0.6) result.push("surround");
}

/** Everything about the seeded selector that is known before hypothetical
 * Black moves are enumerated. This deliberately does not claim to know the
 * final response branch: branch availability still depends on each resulting
 * board. The representation describes behavior, not faction identity. */
export function opponentTurnBehavior(
  opponent: GoRewardOpponent,
  totalPlaytimeMs: number,
): OpponentTurnBehavior {
  const [smartRoll, optionRoll, factionRoll, fallbackRoll] = whrng(totalPlaytimeMs, 4) as
    [number, number, number, number];
  const smart = opponent === "Netburners" ? false
    : opponent === "Slum Snakes" ? smartRoll < 0.3
    : opponent === "The Black Hand" ? smartRoll < 0.8
    : true;
  const program: OpponentBranch[] = [];
  if (opponent === "Netburners") {
    if (factionRoll < 0.2) appendIlluminatiPriority(program, factionRoll);
    if (factionRoll < 0.4) program.push("expansion");
    if (factionRoll < 0.6) program.push("growth");
    if (factionRoll < 0.75) program.push("random");
  } else if (opponent === "Slum Snakes") {
    program.push("defendCapture");
    if (factionRoll < 0.2) appendIlluminatiPriority(program, factionRoll);
    if (factionRoll < 0.6) program.push("growth");
    if (factionRoll < 0.65) program.push("random");
  } else if (opponent === "The Black Hand") {
    program.push("capture", "surround", "defendCapture", "surround");
    if (factionRoll < 0.3) appendIlluminatiPriority(program, factionRoll);
    if (factionRoll < 0.75) program.push("surround");
    if (factionRoll < 0.8) program.push("random");
  } else if (opponent === "Tetrads") {
    program.push("capture", "defendCapture", "pattern", "surround");
    if (factionRoll < 0.4) appendIlluminatiPriority(program, factionRoll);
  } else if (opponent === "Daedalus") {
    if (factionRoll < 0.9) appendIlluminatiPriority(program, factionRoll);
  } else {
    appendIlluminatiPriority(program, factionRoll);
  }
  const priorityRanks = new Array<number>(GO_OPPONENT_BRANCHES.length).fill(0);
  let rank = 0;
  for (const programmed of program) {
    const branch = GO_OPPONENT_BRANCHES.indexOf(programmed);
    if (branch >= 0 && priorityRanks[branch] === 0) priorityRanks[branch] = ++rank;
  }
  return { smart, optionRoll, factionRoll, fallbackRoll, priorityRanks,
    fallbackEnabled: GO_FALLBACK_ENABLED };
}

/** Dense, stable conditioning vector. Priority ranks are normalized to [0,1]
 * and komi is present only for the multi-opponent small5 profile. */
export function encodeOpponentTurnBehavior(
  behavior: OpponentTurnBehavior,
  komi?: number,
): Float32Array {
  const result = new Float32Array(GO_BEHAVIOR_BASE_FEATURES + (komi === undefined ? 0 : 1));
  result[0] = Number(behavior.smart);
  result.set([behavior.optionRoll, behavior.factionRoll, behavior.fallbackRoll], 1);
  const rankScale = 1 / Math.max(GO_OPPONENT_BRANCHES.length, 1);
  for (let index = 0; index < GO_OPPONENT_BRANCHES.length; index++) {
    result[4 + index] = behavior.priorityRanks[index]! * rankScale;
    result[4 + GO_OPPONENT_BRANCHES.length + index] = behavior.fallbackEnabled[index]!;
  }
  if (komi !== undefined) result[result.length - 1] = komi / 10;
  return result;
}

export interface OpponentWaitTrace {
  /** The seed is constructed after the first waitCycle. These are the later
   * waitCycle calls through the response promise, including piece placement. */
  cycleWaitsAfterSeed: number;
  /** Pattern scans sleep 10 ms per column and do not consume bonus cycles. */
  fixedSleepMsAfterSeed: number;
}

export interface WeightedOpponentReply {
  move: GoPoint | undefined;
  probability: number;
  branch: OpponentBranch;
  wait: OpponentWaitTrace;
}

interface PreparedOptionSpace {
  board: GoBoard;
  available: readonly GoPoint[];
  legal: Set<string>;
  expansions(): readonly MoveOption[];
  growthMoves(): readonly MoveOption[];
  defenses(): readonly MoveOption[];
  surround(): MoveOption | undefined;
  eyes(): readonly MoveOption[];
  eyeBlock(): MoveOption | undefined;
  patterns(): readonly GoPoint[];
  jump(): readonly MoveOption[];
  corner(): MoveOption | undefined;
  contested(): boolean;
  endGame(): boolean;
}

export interface PreparedOpponentPosition {
  opponent: GoRewardOpponent;
  smart?: PreparedOptionSpace;
  reckless?: PreparedOptionSpace;
}

export interface OpponentPredictionCache {
  eyeOutcomes: Map<string, EyeOutcome>;
}

export function createOpponentPredictionCache(): OpponentPredictionCache {
  return { eyeOutcomes: new Map() };
}

/** Recorded with telemetry so upstream drift can be separated from seed misses. */
export const GO_OPPONENT_MODEL = "clean-room-v3.0.1" as const;

const pick = <T>(values: readonly T[], roll: number): T | undefined => values[Math.floor(roll * values.length)];

function memo<T>(compute: () => T): () => T {
  let ready = false;
  let value: T;
  return () => {
    if (!ready) {
      value = compute();
      ready = true;
    }
    return value;
  };
}

function expansionMoves(board: GoBoard, analysis: GoAnalysis, available: readonly GoPoint[]): MoveOption[] {
  const open = available.filter((point) => {
    const neighbors = cardinal(board, point.x, point.y);
    return neighbors.length === 4 && neighbors.every((neighbor) => cellAt(board, neighbor.x, neighbor.y) === ".");
  });
  const points = open.length ? open : disputedMoves(analysis, available, 1);
  return points.map((point) => ({ point, oldLibertyCount: -1, newLibertyCount: -1 }));
}

function libertyGrowthMoves(
  analysis: GoAnalysis,
  player: Stone,
  available: readonly GoPoint[],
): MoveOption[] {
  const size = analysis.board.size;
  const allowed = new Uint8Array(size * size);
  for (const point of available) allowed[point.x * size + point.y] = 1;
  const result: MoveOption[] = [];
  for (const chain of analysis.chains) {
    if (chain.color !== player) continue;
    for (const point of chain.liberties) {
      if (!allowed[point.x * size + point.y]) continue;
      const weakest = weakestNeighborChain(analysis, point.x, point.y, player);
      const move = {
        point,
        oldLibertyCount: weakest?.liberties.length ?? 99,
        newLibertyCount: effectiveLiberties(analysis, point.x, point.y, player).length,
      };
      if (move.newLibertyCount > 1 && move.newLibertyCount >= move.oldLibertyCount) result.push(move);
    }
  }
  return result;
}

function maximumGrowth(moves: readonly MoveOption[], roll: number): MoveOption | undefined {
  const max = Math.max(...moves.map((move) => move.newLibertyCount! - move.oldLibertyCount!));
  return pick(moves.filter((move) => move.newLibertyCount! - move.oldLibertyCount! === max), roll);
}

function defendCandidates(moves: readonly MoveOption[]): MoveOption[] {
  const increases = moves.filter((move) => move.oldLibertyCount! <= 1 && move.newLibertyCount! > move.oldLibertyCount!);
  const max = Math.max(...increases.map((move) => move.newLibertyCount! - move.oldLibertyCount!));
  if (max < 1) return [];
  return increases.filter((move) => move.newLibertyCount! - move.oldLibertyCount! === max);
}

function surroundMove(
  analysis: GoAnalysis,
  player: Stone,
  available: readonly GoPoint[],
  smart: boolean,
): MoveOption | undefined {
  const enemy: Stone = player === "X" ? "O" : "X";
  const size = analysis.board.size;
  const allowed = new Uint8Array(size * size);
  for (const point of available) allowed[point.x * size + point.y] = 1;
  let firstAtari: MoveOption | undefined;
  let firstSurround: MoveOption | undefined;
  // Preserve chain/liberty scan order and category priority without building
  // three temporary arrays. The first capture is globally final.
  for (const chain of analysis.chains) {
    if (chain.color !== enemy) continue;
    for (const point of chain.liberties) {
      if (!allowed[point.x * size + point.y]) continue;
      const newLibertyCount = effectiveLiberties(analysis, point.x, point.y, player).length;
      const weakest = weakestNeighborChain(analysis, point.x, point.y, enemy);
      const oldLibertyCount = weakest?.liberties.length ?? 99;
      if (newLibertyCount <= 2 && oldLibertyCount > 2) continue;
      const move = { point, oldLibertyCount, newLibertyCount: oldLibertyCount - 1 };
      if (oldLibertyCount <= 1) return move;
      if (oldLibertyCount === 2) {
        let oneLibertyGroup = false;
        if (weakest) {
          let firstGroup: number | undefined;
          oneLibertyGroup = true;
          for (const liberty of weakest.liberties) {
            const group = analysis.chainAt[liberty.x * size + liberty.y]?.id ?? -1;
            if (firstGroup === undefined) firstGroup = group;
            else if (group !== firstGroup) {
              oneLibertyGroup = false;
              break;
            }
          }
        }
        if (newLibertyCount >= 2 || oneLibertyGroup && (weakest?.points.length ?? 99) > 3 || !smart) {
          firstAtari ??= move;
        }
      } else if (newLibertyCount >= 2) {
        firstSurround ??= move;
      }
    }
  }
  return firstAtari ?? firstSurround;
}

interface EyeOutcome {
  newLiving: number;
  newEyeCount: number;
}

function eyeOutcome(newEyes: readonly GoChain[][]): EyeOutcome {
  let newLiving = 0;
  let newEyeCount = 0;
  for (const eyes of newEyes) {
    if (eyes.length) newEyeCount++;
    if (eyes.length >= 2) newLiving++;
  }
  return { newLiving, newEyeCount };
}

/** Upstream flattens every qualifying chain's liberty list without
 * deduplicating, and the multiplicity is observable: getEyeBlockingMove only
 * blocks when EXACTLY one life-creating move exists, so a liberty shared by
 * two friendly chains suppresses the block. Keep the duplicates; the callers
 * memoize the expensive per-point analysis instead.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/goAI.ts */
function eyeCandidates(
  board: GoBoard,
  analysis: GoAnalysis,
  player: Stone,
  allowed: Uint8Array,
  livingIds: ReadonlySet<number>,
  maxLiberties: number,
): GoPoint[] {
  const result: GoPoint[] = [];
  const size = board.size;
  for (const chain of analysis.chains) {
    if (chain.color !== player || chain.points.length <= 1
      || chain.liberties.length > maxLiberties || livingIds.has(chain.id)) continue;
    for (const point of chain.liberties) {
      if (!allowed[point.x * size + point.y]) continue;
      let friendlyOrEdge = 0;
      let hasEmpty = false;
      for (let direction = 0; direction < 4; direction++) {
        const nx = point.x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
        const ny = point.y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) {
          friendlyOrEdge++;
          continue;
        }
        const color = board.rows[nx]![ny];
        // `cardinal()` omits both edges and offline nodes before upstream's
        // four-slot count, so both contribute to this missing-neighbor term.
        if (color === "#") {
          friendlyOrEdge++;
          continue;
        }
        if (color === player) friendlyOrEdge++;
        if (color === ".") hasEmpty = true;
      }
      if (friendlyOrEdge >= 2 && hasEmpty) result.push(point);
    }
  }
  return result;
}

function eyeCreationMoves(
  board: GoBoard,
  analysis: GoAnalysis,
  player: Stone,
  available: readonly GoPoint[],
  maxLiberties = 99,
  stopAtFirstLife = false,
  sharedCache?: OpponentPredictionCache,
): MoveOption[] {
  const currentByChain = eyesByChain(analysis, player);
  const currentEyes = [...currentByChain.values()];
  const livingIds = new Set([...currentByChain].filter(([, eyes]) => eyes.length >= 2).map(([id]) => id));
  const currentLiving = livingIds.size;
  const currentEyeCount = currentEyes.filter((eyes) => eyes.length).length;
  const allowed = new Uint8Array(board.size * board.size);
  for (const point of available) allowed[point.x * board.size + point.y] = 1;
  const candidates = eyeCandidates(board, analysis, player, allowed, livingIds, maxLiberties);
  const cache = new Map<number, EyeOutcome>();
  const result: MoveOption[] = [];
  for (const point of candidates) {
    const key = point.x * board.size + point.y;
    let outcome = cache.get(key);
    if (!outcome) {
      const evaluated = evaluateMove(board, point.x, point.y, player, undefined, analysis);
      const sharedKey = sharedCache ? `${player}${evaluated.rows.join("")}` : undefined;
      outcome = sharedKey ? sharedCache!.eyeOutcomes.get(sharedKey) : undefined;
      if (!outcome) {
        outcome = eyeOutcome(allEyes(analyzeBoard(evaluated), player));
        if (sharedKey) sharedCache!.eyeOutcomes.set(sharedKey, outcome);
      }
      cache.set(key, outcome);
    }
    const { newLiving, newEyeCount } = outcome;
    if (newLiving > currentLiving || newEyeCount > currentEyeCount && newLiving === currentLiving) {
      result.push({ point, createsLife: newLiving > currentLiving });
      if (stopAtFirstLife && newLiving > currentLiving) break;
    }
  }
  return result.sort((a, b) => Number(b.createsLife) - Number(a.createsLife));
}

function eyeBlockMove(
  board: GoBoard,
  analysis: GoAnalysis,
  player: Stone,
  available: readonly GoPoint[],
  sharedCache?: OpponentPredictionCache,
): MoveOption | undefined {
  const enemy: Stone = player === "X" ? "O" : "X";
  const enemyMoves = eyeCreationMoves(board, analysis, enemy, available, 5, false, sharedCache);
  const life = enemyMoves.filter((move) => move.createsLife);
  const eye = enemyMoves.filter((move) => !move.createsLife);
  return life.length === 1 ? life[0] : life.length === 0 && eye.length === 1 ? eye[0] : undefined;
}

function cornerMove(board: GoBoard): MoveOption | undefined {
  const edge = board.size - 1;
  const inner = edge - 2;
  const areas: readonly [number, number, number, number, GoPoint][] = [
    [inner, inner, edge, edge, { x: inner, y: inner }],
    [0, inner, 2, edge, { x: 2, y: inner }],
    [0, 0, 2, 2, { x: 2, y: 2 }],
    [inner, 0, edge, 2, { x: inner, y: 2 }],
  ];
  for (const [x1, y1, x2, y2, point] of areas) {
    const cells = [] as string[];
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) {
      const cell = cellAt(board, x, y);
      if (cell !== "#") cells.push(cell);
    }
    if (cells.length >= 7 && cells.every((cell) => cell === ".")) return { point };
  }
  return undefined;
}

function prepareOptionSpace(
  board: GoBoard,
  player: Stone,
  smart: boolean,
  history: readonly string[][],
  passCount: number,
  historyHashes?: ReadonlySet<string>,
  predictionCache?: OpponentPredictionCache,
): PreparedOptionSpace {
  const analysis = analyzeBoard(board);
  // Legality is one of the most expensive option-space passes. Reuse it for
  // both territory filtering and the final fallback validity check.
  const legalMoves = legalPoints(board, player, history, analysis, historyHashes);
  const available = disputedTerritory(board, player, history, smart, analysis, legalMoves);
  const contested = memo(() => disputedMoves(analysis, available).length > 0);
  const endGame = memo(() => passCount > 0 && !contested());
  const expansions = memo(() => expansionMoves(board, analysis, available));
  const growthMoves = memo(() => libertyGrowthMoves(analysis, player, available));
  const defenses = memo(() => defendCandidates(growthMoves()));
  const surround = memo(() => surroundMove(analysis, player, available, smart));
  const eyes = memo(() => endGame() ? [] : eyeCreationMoves(board, analysis, player, available, 99, true, predictionCache));
  const eyeBlock = memo(() => endGame() ? undefined : eyeBlockMove(board, analysis, player, available, predictionCache));
  const patterns = memo(() => endGame() ? [] : patternMoves(board, player, available, smart));
  const jump = memo(() => expansions().filter(({ point }) => ([
      [point.x, point.y + 2], [point.x + 2, point.y], [point.x, point.y - 2], [point.x - 2, point.y],
    ] as const).some(([x, y]) => cellAt(board, x, y) === player)));
  const corner = memo(() => cornerMove(board));
  return {
    board,
    available,
    legal: new Set(legalMoves.map(pointKey)),
    expansions,
    growthMoves,
    defenses,
    surround,
    eyes,
    eyeBlock,
    patterns,
    jump,
    corner,
    contested,
    endGame,
  };
}

function makeOptions(space: PreparedOptionSpace, optionRoll: number, defend: MoveOption | undefined): Options {
  const options = {} as Options;
  Object.defineProperties(options, {
    capture: { enumerable: true, get: () => {
      const move = space.surround();
      return move?.newLibertyCount === 0 ? move : undefined;
    } },
    defendCapture: { enumerable: true, get: () =>
      defend?.oldLibertyCount === 1 && defend.newLibertyCount! > 1 ? defend : undefined },
    eyeMove: { enumerable: true, get: () => space.eyes()[0] },
    eyeBlock: { enumerable: true, get: () => space.eyeBlock() },
    pattern: { enumerable: true, get: () => {
      const moves = space.patterns();
      return moves.length ? { point: pick(moves, optionRoll)! } : undefined;
    } },
    growth: { enumerable: true, get: () => space.endGame() ? undefined : maximumGrowth(space.growthMoves(), optionRoll) },
    expansion: { enumerable: true, get: () => pick(space.expansions(), optionRoll) },
    jump: { enumerable: true, get: () => pick(space.jump(), optionRoll) },
    defend: { enumerable: true, get: () => defend },
    surround: { enumerable: true, get: () => space.surround() },
    corner: { enumerable: true, get: () => space.corner() },
    random: { enumerable: true, get: () => space.contested() && space.available.length
      ? { point: pick(space.available, optionRoll)! }
      : undefined },
  });
  return options;
}

interface TracedChoice { point: GoPoint; branch: OpponentBranch }
interface MutableTrace { cycleWaitsAfterSeed: number; fixedSleepMsAfterSeed: number }

function asyncOption(options: Options, id: "capture" | "defendCapture", trace: MutableTrace): MoveOption | undefined {
  trace.cycleWaitsAfterSeed++;
  return options[id];
}

function patternOption(options: Options, trace: MutableTrace, size: number): MoveOption | undefined {
  trace.fixedSleepMsAfterSeed += size * 10;
  return options.pattern;
}

function illuminati(options: Options, roll: number, trace: MutableTrace, size: number): TracedChoice | undefined {
  if (asyncOption(options, "capture", trace)) {
    return { point: asyncOption(options, "capture", trace)!.point, branch: "capture" };
  }
  if (asyncOption(options, "defendCapture", trace)) {
    return { point: asyncOption(options, "defendCapture", trace)!.point, branch: "defendCapture" };
  }
  if (options.eyeMove) return { point: options.eyeMove.point, branch: "eyeMove" };
  if (options.surround && options.surround.newLibertyCount! <= 1) return { point: options.surround.point, branch: "surround" };
  if (options.eyeBlock) return { point: options.eyeBlock.point, branch: "eyeBlock" };
  if (options.corner) return { point: options.corner.point, branch: "corner" };
  const hasMoves = [options.eyeMove, options.eyeBlock, options.growth, options.defend, options.surround].filter(Boolean).length;
  const pattern = patternOption(options, trace, size);
  if (pattern && (roll > 0.25 || hasMoves === 0)) {
    return { point: patternOption(options, trace, size)!.point, branch: "pattern" };
  }
  if (roll > 0.4 && options.jump) return { point: options.jump.point, branch: "jump" };
  if (roll < 0.6 && options.surround && options.surround.newLibertyCount! <= 2) {
    return { point: options.surround.point, branch: "surround" };
  }
  return undefined;
}

function priority(
  options: Options,
  opponent: GoRewardOpponent,
  roll: number,
  trace: MutableTrace,
  size: number,
): TracedChoice | undefined {
  if (opponent === "Netburners") {
    if (roll < 0.2) return illuminati(options, roll, trace, size);
    if (roll < 0.4 && options.expansion) return { point: options.expansion.point, branch: "expansion" };
    if (roll < 0.6 && options.growth) return { point: options.growth.point, branch: "growth" };
    if (roll < 0.75 && options.random) return { point: options.random.point, branch: "random" };
    return undefined;
  }
  if (opponent === "Slum Snakes") {
    if (asyncOption(options, "defendCapture", trace)) {
      return { point: asyncOption(options, "defendCapture", trace)!.point, branch: "defendCapture" };
    }
    if (roll < 0.2) return illuminati(options, roll, trace, size);
    if (roll < 0.6 && options.growth) return { point: options.growth.point, branch: "growth" };
    if (roll < 0.65 && options.random) return { point: options.random.point, branch: "random" };
    return undefined;
  }
  if (opponent === "The Black Hand") {
    if (asyncOption(options, "capture", trace)) {
      return { point: asyncOption(options, "capture", trace)!.point, branch: "capture" };
    }
    if (options.surround && options.surround.newLibertyCount! <= 1) return { point: options.surround.point, branch: "surround" };
    if (asyncOption(options, "defendCapture", trace)) {
      return { point: asyncOption(options, "defendCapture", trace)!.point, branch: "defendCapture" };
    }
    if (options.surround && options.surround.newLibertyCount! <= 2) return { point: options.surround.point, branch: "surround" };
    if (roll < 0.3) return illuminati(options, roll, trace, size);
    if (roll < 0.75 && options.surround) return { point: options.surround.point, branch: "surround" };
    if (roll < 0.8 && options.random) return { point: options.random.point, branch: "random" };
    return undefined;
  }
  if (opponent === "Tetrads") {
    if (asyncOption(options, "capture", trace)) {
      return { point: asyncOption(options, "capture", trace)!.point, branch: "capture" };
    }
    if (asyncOption(options, "defendCapture", trace)) {
      return { point: asyncOption(options, "defendCapture", trace)!.point, branch: "defendCapture" };
    }
    if (patternOption(options, trace, size)) {
      return { point: patternOption(options, trace, size)!.point, branch: "pattern" };
    }
    if (options.surround && options.surround.newLibertyCount! <= 1) return { point: options.surround.point, branch: "surround" };
    return roll < 0.4 ? illuminati(options, roll, trace, size) : undefined;
  }
  if (opponent === "Daedalus") return roll < 0.9 ? illuminati(options, roll, trace, size) : undefined;
  return illuminati(options, roll, trace, size);
}

function replyFor(
  options: Options,
  opponent: GoRewardOpponent,
  factionRoll: number,
  fallbackRoll: number,
  legal: Set<string>,
  size: number,
): { choice?: TracedChoice; trace: OpponentWaitTrace } {
  const trace: MutableTrace = { cycleWaitsAfterSeed: 0, fixedSleepMsAfterSeed: 0 };
  const first = priority(options, opponent, factionRoll, trace, size);
  if (first) {
    // handleNextTurn waits once more before placing a non-pass AI move.
    trace.cycleWaitsAfterSeed++;
    return { choice: first, trace };
  }
  const fallbacks: (TracedChoice | undefined)[] = [
    options.growth ? { point: options.growth.point, branch: "growth" as const } : undefined,
    options.surround ? { point: options.surround.point, branch: "surround" as const } : undefined,
    options.defend ? { point: options.defend.point, branch: "defend" as const } : undefined,
    options.expansion ? { point: options.expansion.point, branch: "expansion" as const } : undefined,
    patternOption(options, trace, size) ? { point: options.pattern!.point, branch: "pattern" as const } : undefined,
    options.eyeMove ? { point: options.eyeMove.point, branch: "eyeMove" as const } : undefined,
    options.eyeBlock ? { point: options.eyeBlock.point, branch: "eyeBlock" as const } : undefined,
  ];
  const legalFallbacks = fallbacks
    .filter((choice): choice is TracedChoice => choice !== undefined)
    .filter((choice) => legal.has(pointKey(choice.point)));
  const choice = pick(legalFallbacks, fallbackRoll);
  // getMove always waits once after building fallbacks; handleNextTurn waits
  // once more only when it then places a stone.
  trace.cycleWaitsAfterSeed += choice ? 2 : 1;
  return { ...(choice ? { choice } : {}), trace };
}

export function prepareOpponentPosition(
  board: GoBoard,
  opponent: GoRewardOpponent,
  previousBoards: readonly string[][] = [],
  passCount = 0,
  historyHashes?: ReadonlySet<string>,
  predictionCache?: OpponentPredictionCache,
): PreparedOpponentPosition {
  const canBeSmart = opponent !== "Netburners";
  const canBeReckless = opponent === "Netburners" || opponent === "Slum Snakes" || opponent === "The Black Hand";
  return {
    opponent,
    ...(canBeSmart ? { smart: prepareOptionSpace(board, "O", true, previousBoards, passCount, historyHashes, predictionCache) } : {}),
    ...(canBeReckless ? { reckless: prepareOptionSpace(board, "O", false, previousBoards, passCount, historyHashes, predictionCache) } : {}),
  };
}

/** Finish a prepared forecast for one exact seed. The only unseeded choice in
 * the upstream AI is a uniform defense tie-break, whose multiplicity is kept
 * as probability instead of being flattened into a set.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/goAI.ts */
export function predictPreparedOpponentReplies(
  prepared: PreparedOpponentPosition,
  totalPlaytimeMs: number,
): OpponentReplyForecast {
  const { smart, optionRoll, factionRoll, fallbackRoll } = opponentTurnBehavior(
    prepared.opponent, totalPlaytimeMs);
  const space = smart ? prepared.smart : prepared.reckless;
  if (!space) throw new Error(`missing ${smart ? "smart" : "reckless"} ${prepared.opponent} option space`);
  const defenses = space.defenses();
  const branches: readonly (MoveOption | undefined)[] = defenses.length ? defenses : [undefined];
  const probability = 1 / branches.length;
  const weighted = new Map<string, WeightedOpponentReply>();
  for (const defend of branches) {
    const options = makeOptions(space, optionRoll, defend);
    const { choice, trace } = replyFor(
      options,
      prepared.opponent,
      factionRoll,
      fallbackRoll,
      space.legal,
      space.board.size,
    );
    const move = choice?.point;
    const branch = choice?.branch ?? "pass";
    const key = `${move ? pointKey(move) : "pass"}|${branch}|${trace.cycleWaitsAfterSeed}|${trace.fixedSleepMsAfterSeed}`;
    const current = weighted.get(key);
    weighted.set(key, current
      ? { ...current, probability: current.probability + probability }
      : { move, probability, branch, wait: trace });
  }
  const replies = [...weighted.values()];
  const distinctMoves = new Set(replies.map(({ move }) => move ? pointKey(move) : "pass"));
  return {
    replies,
    certainty: distinctMoves.size > 1 ? "unseeded-defense-tie" : "exact",
  };
}

/** Predict the exact seeded faction response. Production uses only this
 * clean-room model; simulator parity tests import upstream independently.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/goAI.ts */
export function predictOpponentReplies(
  board: GoBoard,
  opponent: GoRewardOpponent,
  totalPlaytimeMs: number,
  previousBoards: readonly string[][] = [],
  passCount = 0,
): OpponentReplyForecast {
  return predictPreparedOpponentReplies(
    prepareOpponentPosition(board, opponent, previousBoards, passCount),
    totalPlaytimeMs,
  );
}

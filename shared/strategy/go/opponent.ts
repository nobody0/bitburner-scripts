/** Clean-room model of Bitburner's IPvGO faction AIs.
 *
 * This module deliberately depends only on our public board representation.
 * Differential simulator tests import the pinned game separately and keep this
 * transcription honest without shipping any game implementation.
 * Pinned upstream AI and scoring sources:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/goAI.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/boardAnalysis.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/scoring.ts */
import type { GoBoard, GoRewardOpponent, Stone } from "./decide.ts";
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
  contested: boolean;
  endGame: boolean;
}

export interface PreparedOpponentPosition {
  opponent: GoRewardOpponent;
  smart?: PreparedOptionSpace;
  reckless?: PreparedOptionSpace;
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
  const allowed = new Set(available.map(pointKey));
  return analysis.chains
    .filter((chain) => chain.color === player)
    .flatMap((chain) => chain.liberties)
    .filter((point) => allowed.has(pointKey(point)))
    .map((point) => {
      const weakest = weakestNeighborChain(analysis, point.x, point.y, player);
      return {
        point,
        oldLibertyCount: weakest?.liberties.length ?? 99,
        newLibertyCount: effectiveLiberties(analysis, point.x, point.y, player).length,
      };
    })
    .filter((move) => move.newLibertyCount > 1 && move.newLibertyCount >= move.oldLibertyCount);
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
  const allowed = new Set(available.map(pointKey));
  const liberties = analysis.chains
    .filter((chain) => chain.color === enemy)
    .flatMap((chain) => chain.liberties)
    .filter((point) => allowed.has(pointKey(point)));
  const capture: MoveOption[] = [];
  const atari: MoveOption[] = [];
  const surround: MoveOption[] = [];
  for (const point of liberties) {
    const newLibertyCount = effectiveLiberties(analysis, point.x, point.y, player).length;
    const weakest = weakestNeighborChain(analysis, point.x, point.y, enemy);
    const oldLibertyCount = weakest?.liberties.length ?? 99;
    const weakestLength = weakest?.points.length ?? 99;
    const libertyGroups = new Set((weakest?.liberties ?? [])
      .map((liberty) => analysis.chainAt.get(pointKey(liberty))?.id ?? ""));
    if (newLibertyCount <= 2 && oldLibertyCount > 2) continue;
    const move = { point, oldLibertyCount, newLibertyCount: oldLibertyCount - 1 };
    if (oldLibertyCount <= 1) capture.push(move);
    else if (oldLibertyCount === 2 && (newLibertyCount >= 2 || libertyGroups.size === 1 && weakestLength > 3 || !smart)) {
      atari.push(move);
    } else if (newLibertyCount >= 2) surround.push(move);
  }
  return [...capture, ...atari, ...surround][0];
}

function eyeCreationMoves(
  board: GoBoard,
  analysis: GoAnalysis,
  player: Stone,
  available: readonly GoPoint[],
  maxLiberties = 99,
): MoveOption[] {
  const currentByChain = eyesByChain(analysis, player);
  const currentEyes = [...currentByChain.values()];
  const livingIds = new Set([...currentByChain].filter(([, eyes]) => eyes.length >= 2).map(([id]) => id));
  const currentLiving = livingIds.size;
  const currentEyeCount = currentEyes.filter((eyes) => eyes.length).length;
  const allowed = new Set(available.map(pointKey));
  const candidates = analysis.chains
    .filter((chain) => chain.color === player && chain.points.length > 1)
    .filter((chain) => chain.liberties.length <= maxLiberties && !livingIds.has(chain.id))
    .flatMap((chain) => chain.liberties)
    .filter((point) => allowed.has(pointKey(point)))
    .filter((point) => {
      const neighborhood = cardinal(board, point.x, point.y);
      // Missing cardinal points count as friendly/off-board in the upstream
      // four-slot neighborhood, while offline nodes are present and hostile.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/goAI.ts
      const friendlyOrEdge = 4 - neighborhood.length
        + neighborhood.filter((neighbor) => cellAt(board, neighbor.x, neighbor.y) === player).length;
      return friendlyOrEdge >= 2
        && neighborhood.some((neighbor) => cellAt(board, neighbor.x, neighbor.y) === ".");
    });
  return candidates.reduce<MoveOption[]>((result, point) => {
    const next = analyzeBoard(evaluateMove(board, point.x, point.y, player));
    const newEyes = allEyes(next, player);
    const newLiving = newEyes.filter((eyes) => eyes.length >= 2).length;
    const newEyeCount = newEyes.filter((eyes) => eyes.length).length;
    if (newLiving > currentLiving || newEyeCount > currentEyeCount && newLiving === currentLiving) {
      result.push({ point, createsLife: newLiving > currentLiving });
    }
    return result;
  }, []).sort((a, b) => Number(b.createsLife) - Number(a.createsLife));
}

function eyeBlockMove(
  board: GoBoard,
  analysis: GoAnalysis,
  player: Stone,
  available: readonly GoPoint[],
): MoveOption | undefined {
  const enemy: Stone = player === "X" ? "O" : "X";
  const enemyMoves = eyeCreationMoves(board, analysis, enemy, available, 5);
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
): PreparedOptionSpace {
  const analysis = analyzeBoard(board);
  const available = disputedTerritory(board, player, history, smart);
  const contested = disputedMoves(analysis, available);
  const endGame = contested.length === 0 && passCount > 0;
  const expansions = memo(() => expansionMoves(board, analysis, available));
  const growthMoves = memo(() => libertyGrowthMoves(analysis, player, available));
  const defenses = memo(() => defendCandidates(growthMoves()));
  const surround = memo(() => surroundMove(analysis, player, available, smart));
  const eyes = memo(() => endGame ? [] : eyeCreationMoves(board, analysis, player, available));
  const eyeBlock = memo(() => endGame ? undefined : eyeBlockMove(board, analysis, player, available));
  const patterns = memo(() => endGame ? [] : patternMoves(board, player, available, smart));
  const jump = memo(() => expansions().filter(({ point }) => ([
      [point.x, point.y + 2], [point.x + 2, point.y], [point.x, point.y - 2], [point.x - 2, point.y],
    ] as const).some(([x, y]) => cellAt(board, x, y) === player)));
  const corner = memo(() => cornerMove(board));
  return {
    board,
    available,
    legal: new Set(legalPoints(board, player, history).map(pointKey)),
    expansions,
    growthMoves,
    defenses,
    surround,
    eyes,
    eyeBlock,
    patterns,
    jump,
    corner,
    contested: contested.length > 0,
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
    growth: { enumerable: true, get: () => space.endGame ? undefined : maximumGrowth(space.growthMoves(), optionRoll) },
    expansion: { enumerable: true, get: () => pick(space.expansions(), optionRoll) },
    jump: { enumerable: true, get: () => pick(space.jump(), optionRoll) },
    defend: { enumerable: true, get: () => defend },
    surround: { enumerable: true, get: () => space.surround() },
    corner: { enumerable: true, get: () => space.corner() },
    random: { enumerable: true, get: () => space.contested && space.available.length
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
): PreparedOpponentPosition {
  const canBeSmart = opponent !== "Netburners";
  const canBeReckless = opponent === "Netburners" || opponent === "Slum Snakes" || opponent === "The Black Hand";
  return {
    opponent,
    ...(canBeSmart ? { smart: prepareOptionSpace(board, "O", true, previousBoards, passCount) } : {}),
    ...(canBeReckless ? { reckless: prepareOptionSpace(board, "O", false, previousBoards, passCount) } : {}),
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
  const [smartRoll, optionRoll, factionRoll, fallbackRoll] = whrng(totalPlaytimeMs, 4) as [number, number, number, number];
  const smart = prepared.opponent === "Netburners" ? false
    : prepared.opponent === "Slum Snakes" ? smartRoll < 0.3
    : prepared.opponent === "The Black Hand" ? smartRoll < 0.8
    : true;
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

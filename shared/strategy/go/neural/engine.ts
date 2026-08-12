/** Neural IPvGO decision engine.
 *
 * The exact rules engine and the clean-room faction-reply model stay in
 * TypeScript; the trained v7 value network only ever sees result boards. Per
 * decision the engine enumerates legal candidates plus pass, predicts each
 * candidate's exact seeded faction reply, batches every distinct result board
 * through a GoValueBackend in one pass, and picks the candidate with the best
 * expected win probability (terminal Power per round breaks exact ties),
 * mirroring go-ai's choose_with_network().
 *
 * The two-phase split matches the production driver: preparation is
 * seed-independent and may be spread across event-loop turns; finalization
 * applies one or two concrete WHRNG seeds and is dominated by the async
 * backend batch, so the main thread is never blocked for long.
 */
import {
  predictPreparedOpponentReplies,
  prepareOpponentPositionCooperative,
  type PreparedOpponentPosition,
} from "../opponent.ts";
import {
  boardHash,
  playMove,
  scoreBoard,
  GO_OPPONENTS,
  type GoBoard,
  type GoDecision,
  type GoMove,
  type GoPredictedReply,
  type GoRewardOpponent,
  type GoView,
} from "../rules.ts";
import { loadGoValueWeights, type GoValueWeights } from "./artifact.ts";
import {
  decodeGoValue,
  goBoardWords,
  goPowerPerRound,
  packGoBoard,
  type GoValueBackend,
  type GoValuePrediction,
} from "./backend.ts";
import { SMALL5_GO_MODEL } from "./models/small5.ts";
import { DAEMON19_GO_MODEL } from "./models/daemon19.ts";
import { goDifficultyMultiplier } from "../rewards.ts";

export type GoModelProfile = "small5" | "daemon19";

/** The trainer's Opponent enum order matches GO_OPPONENTS; the secret daemon
 * plays only on the 19x19 profile whose single head ignores the index. */
function goNeuralOpponentIndex(opponent: GoRewardOpponent): number {
  const index = GO_OPPONENTS.indexOf(opponent as (typeof GO_OPPONENTS)[number]);
  return index >= 0 ? index : GO_OPPONENTS.length - 1;
}

export function goModelProfile(boardSize: number): GoModelProfile {
  return boardSize <= 5 ? "small5" : "daemon19";
}

export type GoValueBackendFactory = (
  weights: GoValueWeights,
  profile: GoModelProfile,
) => Promise<GoValueBackend> | GoValueBackend;

/** Owns one lazily created backend per model profile plus reusable packing
 * scratch, so weight uploads happen once per process. */
export class GoNeuralEngine {
  #factory: GoValueBackendFactory;
  #backends = new Map<GoModelProfile, Promise<GoValueBackend>>();
  #packed = new Map<GoModelProfile, Uint32Array>();

  constructor(factory: GoValueBackendFactory) {
    this.#factory = factory;
  }

  backendFor(boardSize: number): Promise<GoValueBackend> {
    const profile = goModelProfile(boardSize);
    let backend = this.#backends.get(profile);
    if (!backend) {
      backend = Promise.resolve(this.#factory(
        loadGoValueWeights(profile === "small5" ? SMALL5_GO_MODEL : DAEMON19_GO_MODEL),
        profile,
      ));
      this.#backends.set(profile, backend);
    }
    return backend;
  }

  packedScratch(profile: GoModelProfile, words: number): Uint32Array {
    const current = this.#packed.get(profile);
    if (current && current.length >= words) return current;
    const grown = new Uint32Array(Math.ceil(words * 1.5));
    this.#packed.set(profile, grown);
    return grown;
  }

  async dispose(): Promise<void> {
    for (const backend of this.#backends.values()) {
      await backend.then((resolved) => resolved.dispose(), () => {});
    }
    this.#backends.clear();
    this.#packed.clear();
  }
}

export interface GoNeuralPreparedCandidate {
  action: { type: "move"; x: number; y: number } | { type: "pass" };
  /** Board after the black action; passes leave the position untouched. */
  board: GoBoard;
  captures: number;
  /** A second consecutive pass ends the game; no reply follows. */
  terminal: boolean;
  opponent?: PreparedOpponentPosition;
}

export interface GoNeuralPrepared {
  view: GoView;
  candidates: readonly GoNeuralPreparedCandidate[];
  /** Positions preceding the current board, for reply superko checks. */
  historyHashes: ReadonlySet<string>;
  /** Rounds already played, for the Power-per-round tie-break denominator.
   * History records placements only, so this is a close approximation of the
   * trainer's round counter rather than an exact replay. */
  elapsedRounds: number;
  immediate?: GoDecision;
}

function immediateDecision(view: GoView): GoDecision | undefined {
  const preferredOpponent = view.nextGame?.opponent ?? view.opponent;
  const boardSize = view.nextGame?.boardSize ?? 5;
  // The game boots into an untouched 7x7 Netburners board. No move means no
  // score, streak, or favor has been invested, so replace a pristine board
  // when the bottleneck model wants a different game rather than spending
  // minutes finishing an irrelevant default. Once either side has moved, the
  // normal finish-what-we-started rule applies.
  const pristineRetarget = view.nextGame !== undefined
    && view.previousBoards.length === 0
    && (view.opponent !== preferredOpponent || view.board.size !== boardSize);
  if (view.status === "gameOver" || view.currentPlayer === "None" || pristineRetarget) {
    return {
      action: {
        type: "newGame",
        opponent: preferredOpponent,
        boardSize,
        why: pristineRetarget
          ? "untouched subnet has no invested reward; start the highest-value game"
          : view.nextGame?.why ?? "completed subnet; start the highest-value reward",
      },
      ranked: [],
      why: `new ${boardSize}x${boardSize} game against ${preferredOpponent}`,
      finalists: 0,
      // Immediate transitions never run the network; a neutral nominal value
      // keeps the field's win-probability scale.
      positionValue: 0.5,
    };
  }
  if (view.currentPlayer !== "Black") {
    return {
      action: { type: "resume", why: "request the pending white move after an interrupted wait" },
      ranked: [],
      why: "resuming opponent turn",
      finalists: 0,
      positionValue: 0.5,
    };
  }
  if ((view.consecutivePasses ?? 0) > 0) {
    const score = scoreBoard(view.board, view.komi ?? 0);
    if (score.X >= score.O) {
      return {
        action: { type: "pass", why: `accept white's pass and win ${score.X}-${score.O}` },
        ranked: [],
        why: "end a won game",
        finalists: 0,
        positionValue: 1,
      };
    }
  }
  return undefined;
}

/** Bound the fully forecast candidate set on oversized boards. The BitVerse
 * board has ~300 legal openings whose reply modeling costs milliseconds each;
 * captures and contact moves always survive, the rest is a cheap local order. */
function goNeuralCandidateLimit(view: Pick<GoView, "board" | "candidateLimit">): number {
  if (view.candidateLimit !== undefined) return Math.max(1, Math.floor(view.candidateLimit));
  return view.board.size >= 19 ? 96 : Number.POSITIVE_INFINITY;
}

interface OrderedCandidate {
  x: number;
  y: number;
  played: { board: GoBoard; captures: number };
  order: number;
}

const nowMs = (): number => (globalThis.performance ?? Date).now();

let cooperativePost: ((resolve: () => void) => void) | undefined;

/** Yield to a fresh browser task without the nested setTimeout clamp. */
export function yieldGoPlanner(): Promise<void> {
  if (!cooperativePost) {
    const Channel = (globalThis as unknown as {
      MessageChannel?: new () => {
        port1: { onmessage: (() => void) | null; unref?: () => void };
        port2: { postMessage(value: number): void; unref?: () => void };
      };
    }).MessageChannel;
    if (!Channel) return new Promise((resolve) => setTimeout(resolve));
    const channel = new Channel();
    const waiters: Array<() => void> = [];
    channel.port1.unref?.();
    channel.port2.unref?.();
    channel.port1.onmessage = () => waiters.shift()?.();
    cooperativePost = (resolve) => {
      waiters.push(resolve);
      channel.port2.postMessage(0);
    };
  }
  return new Promise<void>((resolve) => cooperativePost!(resolve));
}

export interface GoNeuralPrepareOptions {
  /** Cooperative yield between candidates once a slice budget is spent, so
   * large-board preparation never blocks the shared main thread. */
  pause?: () => Promise<void>;
  sliceMs?: number;
  /** Test/profiling hook for every uninterrupted planner slice. */
  onSlice?: (
    phase: "candidatePreparation" | "replyPreparation",
    elapsedMs: number,
    detail?: string,
  ) => void;
}

function sliceCheckpoint(
  options: GoNeuralPrepareOptions,
  phase: "candidatePreparation" | "replyPreparation",
): { checkpoint: (detail?: string) => Promise<void> | undefined; finish: () => void } {
  // Keep substantial headroom below the 2 ms long-task budget. Chromium can
  // spend a few tenths of a millisecond in bookkeeping between checkpoints,
  // so a 0.1 ms work quantum remains bounded even under modest contention.
  const sliceMs = options.sliceMs ?? 0.1;
  let started = nowMs();
  return {
    checkpoint: (detail) => {
      const elapsed = nowMs() - started;
      if (!options.pause || elapsed < sliceMs) return;
      options.onSlice?.(phase, elapsed, detail);
      return options.pause().then(() => {
        started = nowMs();
      });
    },
    finish: () => options.onSlice?.(phase, nowMs() - started),
  };
}

/** Seed-independent half: enumerate candidates and prepare each candidate's
 * faction option space. This is the expensive part of a turn and is fully
 * reusable across the one or two seeds finalization considers. */
export async function prepareNeuralGoDecision(
  view: GoView,
  options: GoNeuralPrepareOptions = {},
): Promise<GoNeuralPrepared> {
  const historyHashes = new Set((view.previousBoards ?? []).map((position) => position.join("")));
  const elapsedRounds = Math.floor((view.previousBoards?.length ?? 0) / 2);
  const immediate = immediateDecision(view);
  if (immediate) return { view, candidates: [], historyHashes, elapsedRounds, immediate };

  const board = view.board;
  let slices = sliceCheckpoint(options, "candidatePreparation");
  const centre = (board.size - 1) / 2;
  const ordered: OrderedCandidate[] = [];
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      const played = playMove(board, x, y, "X", historyHashes);
      if (!played) continue;
      let adjacent = 0;
      for (let direction = 0; direction < 4; direction++) {
        const nx = x + (direction === 0 ? 1 : direction === 1 ? -1 : 0);
        const ny = y + (direction === 2 ? 1 : direction === 3 ? -1 : 0);
        const cell = board.rows[nx]?.[ny];
        if (cell === "X") adjacent += 3;
        else if (cell === "O") adjacent += 2;
        else if (cell === ".") adjacent += 1;
      }
      const centrality = board.size - Math.abs(x - centre) - Math.abs(y - centre);
      ordered.push({ x, y, played, order: played.captures * 1_000 + adjacent * 10 + centrality * 0.02 });
    }
    const pause = slices.checkpoint();
    if (pause) await pause;
  }
  const limit = goNeuralCandidateLimit(view);
  let selected = ordered;
  if (ordered.length > limit) {
    selected = [...ordered]
      .sort((a, b) => b.order - a.order || a.x - b.x || a.y - b.y)
      .slice(0, limit)
      .sort((a, b) => a.x - b.x || a.y - b.y);
  }

  const passCount = view.consecutivePasses ?? 0;
  const forecastHistory = [view.board.rows, ...(view.previousBoards ?? [])];
  const candidates: GoNeuralPreparedCandidate[] = [];
  for (const candidate of selected) {
    candidates.push({
      action: { type: "move", x: candidate.x, y: candidate.y },
      board: candidate.played.board,
      captures: candidate.played.captures,
      terminal: false,
      opponent: await prepareOpponentPositionCooperative(
        candidate.played.board,
        view.opponent,
        forecastHistory,
        0,
        slices.checkpoint,
      ),
    });
    const pause = slices.checkpoint();
    if (pause) await pause;
  }
  const passTerminal = passCount + 1 >= 2;
  candidates.push({
    action: { type: "pass" },
    board: view.board,
    captures: 0,
    terminal: passTerminal,
    ...(passTerminal
      ? {}
      : { opponent: await prepareOpponentPositionCooperative(
        view.board,
        view.opponent,
        view.previousBoards ?? [],
        passCount + 1,
        slices.checkpoint,
      ) }),
  });
  slices.finish();
  return { view, candidates, historyHashes, elapsedRounds };
}

interface CandidateOutcome {
  boardIndex?: number;
  /** Terminal double-pass candidates bypass the network: the exact rules
   * engine scores the finished game, mirroring the trainer's reward. */
  exact?: GoValuePrediction;
  probability: number;
  replyKey: string;
}

function exactTerminalPrediction(view: GoView, board: GoBoard): GoValuePrediction {
  const score = scoreBoard(board, view.komi ?? 0);
  const won = score.X >= score.O;
  const power = score.X * goDifficultyMultiplier(view.opponent, view.board.size) * (won ? 1 : 0.5);
  return { winProbability: won ? 1 : 0, terminalPower: power, remainingRounds: 0 };
}

/** Seed-dependent half. Resolves each candidate's weighted replies for the
 * given seeds, evaluates every distinct result board in one backend batch,
 * and selects exactly like the trainer's outer loop.
 *
 * The first finalization of a prepared decision forces each option space's
 * memoized analyses, so callers off the dispatch hot path should pass `pause`
 * to keep those slices cooperative; repeat finalizations (the exact
 * dispatch-time seed, a boundary replan) then run warm in about a
 * millisecond. */
export async function finalizeNeuralGoDecision(
  prepared: GoNeuralPrepared,
  seeds: readonly number[],
  engine: GoNeuralEngine,
  options: GoNeuralPrepareOptions = {},
): Promise<GoDecision> {
  if (prepared.immediate) return prepared.immediate;
  const { view, candidates, elapsedRounds } = prepared;
  if (!seeds.length) throw new Error("neural finalization requires at least one WHRNG seed");
  const backend = await engine.backendFor(view.board.size);
  const profile = goModelProfile(view.board.size);
  const opponentIndex = goNeuralOpponentIndex(view.opponent);

  // Result boards repeat heavily (a shared white reply across seeds, passes,
  // superko-blocked replies); evaluate each distinct board exactly once. The
  // input position rides along as batch entry zero for positionValue.
  const boardIndices = new Map<string, number>();
  const batchBoards: GoBoard[] = [];
  const boardIndexOf = (board: GoBoard): number => {
    const key = boardHash(board);
    const existing = boardIndices.get(key);
    if (existing !== undefined) return existing;
    const index = batchBoards.length;
    boardIndices.set(key, index);
    batchBoards.push(board);
    return index;
  };
  boardIndexOf(view.board);

  const moveHistory = new Set(prepared.historyHashes);
  moveHistory.add(boardHash(view.board));
  let unseededDefenseTie = false;
  let slices = sliceCheckpoint(options, "replyPreparation");
  const outcomes: CandidateOutcome[][] = [];
  for (const candidate of candidates) {
    if (candidate.terminal) {
      outcomes.push([{ exact: exactTerminalPrediction(view, candidate.board), probability: 1, replyKey: "pass" }]);
      continue;
    }
    const perCandidate: CandidateOutcome[] = [];
    const replyHistory = candidate.action.type === "move" ? moveHistory : prepared.historyHashes;
    for (const seed of seeds) {
      const forecast = predictPreparedOpponentReplies(candidate.opponent!, seed);
      if (forecast.certainty === "unseeded-defense-tie") unseededDefenseTie = true;
      for (const reply of forecast.replies) {
        const after = reply.move
          ? playMove(candidate.board, reply.move.x, reply.move.y, "O", replyHistory)?.board ?? candidate.board
          : candidate.board;
        perCandidate.push({
          boardIndex: boardIndexOf(after),
          probability: reply.probability / seeds.length,
          replyKey: reply.move ? `${reply.move.x},${reply.move.y}` : "pass",
        });
      }
    }
    outcomes.push(perCandidate);
    const pause = slices.checkpoint();
    if (pause) await pause;
  }

  const words = goBoardWords(backend.extent);
  const packed = engine.packedScratch(profile, words * batchBoards.length);
  for (let index = 0; index < batchBoards.length; index++) {
    packGoBoard(batchBoards[index]!, backend.extent, packed, index * words);
    const pause = slices.checkpoint();
    if (pause) await pause;
  }
  slices.finish();
  const raw = await backend.evaluateBatch({ packed, count: batchBoards.length, opponentIndex });
  slices = sliceCheckpoint(options, "replyPreparation");
  const predictions: GoValuePrediction[] = [];
  for (let index = 0; index < batchBoards.length; index++) {
    predictions.push(decodeGoValue(raw, index));
    const pause = slices.checkpoint();
    if (pause) await pause;
  }
  const positionValue = predictions[0]!.winProbability;

  const forecastCertainty: GoMove["forecastCertainty"] = unseededDefenseTie
    ? "unseeded-defense-tie"
    : seeds.length > 1 ? "seed-window" : "exact";
  const scored: Array<{
    candidate: GoNeuralPreparedCandidate;
    winProbability: number;
    powerPerRound: number;
    predictedReplies: GoPredictedReply[];
  }> = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    let winProbability = 0;
    let powerPerRound = 0;
    const replyCounts = new Map<string, number>();
    for (const outcome of outcomes[index]!) {
      const prediction = outcome.exact ?? predictions[outcome.boardIndex!]!;
      winProbability += outcome.probability * prediction.winProbability;
      powerPerRound += outcome.probability * goPowerPerRound(prediction, elapsedRounds);
      replyCounts.set(outcome.replyKey, (replyCounts.get(outcome.replyKey) ?? 0) + outcome.probability * seeds.length);
    }
    const predictedReplies: GoPredictedReply[] = [...replyCounts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => {
        if (key === "pass") return { x: null, y: null, count };
        const [x, y] = key.split(",").map(Number);
        return { x: x!, y: y!, count };
      });
    scored.push({ candidate, winProbability, powerPerRound, predictedReplies });
    const pause = slices.checkpoint();
    if (pause) await pause;
  }

  // Strict improvement over scan order (pass last) reproduces the trainer's
  // deterministic tie handling exactly.
  let best = scored[0]!;
  for (const entry of scored.slice(1)) {
    if (entry.winProbability > best.winProbability
      || (entry.winProbability === best.winProbability && entry.powerPerRound > best.powerPerRound)) {
      best = entry;
    }
    const pause = slices.checkpoint();
    if (pause) await pause;
  }

  const ranked: GoMove[] = [];
  for (const entry of scored) {
    if (entry.candidate.action.type === "move") {
      const action = entry.candidate.action;
      const modal = entry.predictedReplies[0];
      const modalText = modal
        ? `; forecast ${modal.x === null ? "pass" : `${modal.x},${modal.y}`} with ${modal.count.toFixed(2)}/${seeds.length} support`
        : "";
      ranked.push({
        x: action.x,
        y: action.y,
        score: entry.winProbability,
        powerPerRound: entry.powerPerRound,
        predictedReplies: entry.predictedReplies,
        forecastCertainty,
        captures: entry.candidate.captures,
        why: `neural value${modalText}`,
      });
    }
    const pause = slices.checkpoint();
    if (pause) await pause;
  }
  ranked.sort((a, b) => b.score - a.score || b.powerPerRound - a.powerPerRound || b.captures - a.captures || a.x - b.x || a.y - b.y);
  slices.finish();

  const summary = `neural value over ${candidates.length} candidates`;
  if (best.candidate.action.type === "pass") {
    return {
      action: {
        type: "pass",
        why: best.candidate.terminal
          ? "ending the game rates above every continuation"
          : "passing rates above every legal move",
      },
      ranked: ranked.slice(0, 8),
      why: summary,
      finalists: candidates.length,
      positionValue,
      forecast: best.predictedReplies,
    };
  }
  const action = best.candidate.action;
  return {
    action: {
      type: "move",
      x: action.x,
      y: action.y,
      why: `neural value ${best.winProbability.toFixed(3)} win`,
    },
    ranked: ranked.slice(0, 8),
    why: summary,
    finalists: candidates.length,
    positionValue,
    forecast: best.predictedReplies,
  };
}

/** One-shot convenience for simulators and tests. */
export async function decideGoNeural(
  view: GoView,
  seeds: readonly number[],
  engine: GoNeuralEngine,
  options: GoNeuralPrepareOptions = {},
): Promise<GoDecision> {
  const prepared = await prepareNeuralGoDecision(view, options);
  return finalizeNeuralGoDecision(prepared, seeds, engine, options);
}

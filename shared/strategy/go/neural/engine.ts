/** Neural IPvGO decision engine.
 *
 * The exact rules engine and the clean-room faction-reply model stay in
 * TypeScript. V9 first scores every legal move plus pass on the original board,
 * predicts exact seeded faction replies only for the learned finalists, then
 * batches their distinct post-response boards through the independent value
 * head. Expected win probability ranks candidates; loss-penalized normalized
 * Black score per round breaks exact ties.
 *
 * The two-phase split matches the production driver: preparation is
 * seed-independent; finalization applies one or two concrete WHRNG seeds and
 * the optimized synchronous opponent predictor before the async GPU batch.
 */
import {
  createOpponentPredictionCache,
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
  predictPreparedOpponentReplies,
  prepareOpponentPosition,
  type OpponentWaitTrace,
  type PreparedOpponentPosition,
  type OpponentPredictionCache,
} from "../opponent.ts";
import {
  boardHash,
  legalMoveIndices,
  playMove,
  scoreBoard,
  type GoBoard,
  type GoDecision,
  type GoMove,
  type GoPredictedReply,
  type GoView,
} from "../rules.ts";
import { loadGoValueWeights, type GoV9Weights } from "./artifact.ts";
import {
  decodeGoValue,
  goBoardWords,
  goLegalWords,
  goScorePerRound,
  packGoBoard,
  type GoValueBackend,
  type GoValuePrediction,
} from "./backend.ts";
import { SMALL5_GO_MODEL } from "./models/small5.ts";
import { DAEMON19_GO_MODEL } from "./models/daemon19.ts";
import { GO_REWARD_RULES } from "../rewards.ts";

export type GoModelProfile = "small5" | "daemon19";

export function goModelProfile(boardSize: number): GoModelProfile {
  return boardSize <= 5 ? "small5" : "daemon19";
}

export type GoValueBackendFactory = (
  weights: GoV9Weights,
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
  opponentPredictionCache: OpponentPredictionCache;
  immediate?: GoDecision;
}

/** One public position that can follow the selected Black action. These are
 * worker-cache inputs, not telemetry: retaining the exact wait trace lets the
 * worker start the likely next V9 evaluations while the game is still
 * sleeping inside the current White response. */
export interface GoNeuralContinuation {
  seed: number;
  probability: number;
  response: { type: "move"; x: number; y: number } | { type: "pass" };
  wait: OpponentWaitTrace;
  view: GoView;
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

interface OrderedCandidate {
  x: number;
  y: number;
  played: { board: GoBoard; captures: number };
}

/** Seed-independent half: enumerate all legal candidates. Opponent option
 * spaces remain lazy until V9 has selected finalists. */
export function prepareNeuralGoDecision(view: GoView): GoNeuralPrepared {
  const historyHashes = new Set((view.previousBoards ?? []).map((position) => position.join("")));
  const elapsedRounds = Math.floor((view.previousBoards?.length ?? 0) / 2);
  const immediate = immediateDecision(view);
  const opponentPredictionCache = createOpponentPredictionCache();
  if (immediate) return { view, candidates: [], historyHashes, elapsedRounds,
    opponentPredictionCache, immediate };

  const board = view.board;
  const ordered: OrderedCandidate[] = [];
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      const played = playMove(board, x, y, "X", historyHashes);
      if (!played) continue;
      ordered.push({ x, y, played });
    }
  }
  const passCount = view.consecutivePasses ?? 0;
  // Every black candidate presents white with the same prior positions. Keep
  // one immutable superko index instead of rejoining and rehashing the entire
  // late-game history once per candidate.
  const candidates: GoNeuralPreparedCandidate[] = [];
  for (const candidate of ordered) {
    candidates.push({
      action: { type: "move", x: candidate.x, y: candidate.y },
      board: candidate.played.board,
      captures: candidate.played.captures,
      terminal: false,
    });
  }
  const passTerminal = passCount + 1 >= 2;
  candidates.push({
    action: { type: "pass" },
    board: view.board,
    captures: 0,
    terminal: passTerminal,
  });
  return { view, candidates, historyHashes, elapsedRounds, opponentPredictionCache };
}

interface CandidateOutcome {
  boardIndex?: number;
  /** Terminal double-pass candidates bypass the network: the exact rules
   * engine scores the finished game, mirroring the trainer's reward. */
  exact?: GoValuePrediction;
  probability: number;
  replyKey: string;
}

interface BatchedState {
  board: GoBoard;
  legal: readonly number[];
  passFraction: number;
  elapsedFraction: number;
  responsePass: number;
  responseNoOp: number;
  behavior: Float32Array;
}

function exactTerminalPrediction(view: GoView, board: GoBoard): GoValuePrediction {
  const score = scoreBoard(board, view.komi ?? 0);
  const won = score.X >= score.O;
  const normalizedScore = score.X * (won ? 1 : 0.5);
  // The value target's remaining-round count includes the candidate turn that
  // produced this post-response state, so an immediately terminal move is 1.
  return { winProbability: won ? 1 : 0, terminalScore: normalizedScore, remainingRounds: 1 };
}

/** Seed-dependent half. V9 proposes on the original board, then resolves each
 * finalist's weighted replies, evaluates every distinct result board in one
 * backend batch, and selects exactly like the trainer's outer loop.
 *
 * The first finalization of a prepared decision forces only the option-space
 * branches reached by the concrete seeds. Repeat finalizations (the exact
 * dispatch-time seed or a boundary replan) reuse those memoized analyses. */
export async function finalizeNeuralGoDecision(
  prepared: GoNeuralPrepared,
  seeds: readonly number[],
  engine: GoNeuralEngine,
): Promise<GoDecision> {
  if (prepared.immediate) return prepared.immediate;
  const { view, candidates: allCandidates, elapsedRounds } = prepared;
  if (!seeds.length) throw new Error("neural finalization requires at least one WHRNG seed");
  const backend = await engine.backendFor(view.board.size);
  const profile = goModelProfile(view.board.size);
  const behaviorBySeed = seeds.map((seed) => encodeOpponentTurnBehavior(
    opponentTurnBehavior(view.opponent, seed),
    profile === "small5" ? view.komi ?? GO_REWARD_RULES[view.opponent].komi : undefined,
  ));
  // Daemon19 has one fixed opponent. Once White's exact reply is applied, the
  // current seed signature has been consumed and must not condition the value
  // of the resulting future position. Small5 still needs opponent context
  // until it has a separate stable future-policy descriptor.
  const daemonValueBehavior = profile === "daemon19"
    ? new Float32Array(backend.behaviorFeatures)
    : undefined;
  let candidates = [...allCandidates];
  let proposalPositionValue = 0;
  for (const behavior of behaviorBySeed) if (behavior.length !== backend.behaviorFeatures) {
    throw new Error(`V9 behavior shape ${behavior.length} does not match ${backend.behaviorFeatures}`);
  }
  // The shader indexes the legal plane and the policy logits in extent space,
  // so every board-stride point must be restrided before it is used as a bit
  // position. Boards smaller than the model extent (7/9/13 on daemon19) would
  // otherwise scatter the mask across unrelated points.
  const legalFor = (board: GoBoard, history: ReadonlySet<string>): number[] =>
    legalMoveIndices(board, "X", history).map((point) =>
      Math.floor(point / board.size) * backend.extent + point % board.size);
  {
    const words = goBoardWords(backend.extent);
    const packed = engine.packedScratch(profile, words * seeds.length);
    const legalWords = goLegalWords(backend.extent);
    const legal = new Uint32Array(legalWords * seeds.length);
    const state = new Float32Array(4 * seeds.length);
    const behavior = new Float32Array(backend.behaviorFeatures * seeds.length);
    const originalLegal = legalFor(view.board, prepared.historyHashes);
    for (let index = 0; index < seeds.length; index++) {
      packGoBoard(view.board, backend.extent, packed, index * words);
      for (const point of originalLegal) legal[index * legalWords + (point >> 5)]! |= 1 << (point & 31);
      state.set([(view.consecutivePasses ?? 0) / 2,
        elapsedRounds / Math.max(2 * backend.extent * backend.extent, 1), 0, 0], index * 4);
      behavior.set(behaviorBySeed[index]!, index * backend.behaviorFeatures);
    }
    const proposal = await backend.evaluateProposal({
      packed, legal, state, behavior, count: seeds.length,
    });
    proposalPositionValue = seeds.reduce((sum, _, index) =>
      sum + decodeGoValue(proposal.value, index).winProbability, 0) / seeds.length;
    const area = backend.extent * backend.extent;
    const moveIndex = (candidate: GoNeuralPreparedCandidate): number => candidate.action.type === "pass"
      ? area : candidate.action.x * backend.extent + candidate.action.y;
    const average = candidates.map((candidate) => seeds.reduce((sum, _, seedIndex) =>
      sum + proposal.moves[seedIndex * (area + 1) + moveIndex(candidate)]!, 0) / seeds.length);
    const requested = view.candidateLimit;
    if (requested !== undefined && requested !== Number.POSITIVE_INFINITY
      && (!Number.isFinite(requested) || requested < 1)) {
      throw new Error(`V9 candidate limit must be positive, got ${requested}`);
    }
    let limit = requested === Number.POSITIVE_INFINITY ? candidates.length
      : requested !== undefined ? Math.max(1, Math.floor(requested))
      : 8;
    limit = Math.min(limit, candidates.length);
    const ranked = candidates.map((_, index) => index)
      .sort((left, right) => average[right]! - average[left]! || left - right);
    if (limit < ranked.length && average[ranked[limit - 1]!]! - average[ranked[limit]!]! < 0.25) {
      limit = Math.min(ranked.length, limit * 2);
    }
    const retained = new Set<number>();
    const reserve = Math.max(1, Math.floor(limit / Math.max(2 * seeds.length, 1)));
    for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
      const bySeed = candidates.map((_, index) => index).sort((left, right) =>
        proposal.moves[seedIndex * (area + 1) + moveIndex(candidates[right]!)]!
          - proposal.moves[seedIndex * (area + 1) + moveIndex(candidates[left]!)]! || left - right);
      for (const index of bySeed.slice(0, reserve)) retained.add(index);
    }
    for (const index of ranked) {
      if (retained.size >= limit) break;
      retained.add(index);
    }
    candidates = [...retained].sort((a, b) => a - b).map((index) => candidates[index]!);
  }

  // Result boards repeat heavily (a shared white reply across seeds, passes,
  // superko-blocked replies); evaluate each distinct board exactly once. The
  // V9 already produced the input position value during the proposal pass.
  const boardIndices = new Map<string, number>();
  const batchStates: BatchedState[] = [];
  const boardIndexOf = (state: BatchedState): number => {
    const key = `${boardHash(state.board)}|${state.legal.join(",")}|${state.passFraction}|${state.elapsedFraction}|${state.responsePass}|${state.responseNoOp}|${state.behavior.join(",")}`;
    const existing = boardIndices.get(key);
    if (existing !== undefined) return existing;
    const index = batchStates.length;
    boardIndices.set(key, index);
    batchStates.push(state);
    return index;
  };

  const moveHistory = new Set(prepared.historyHashes);
  moveHistory.add(boardHash(view.board));
  const forecastHistory = [view.board.rows, ...(view.previousBoards ?? [])];
  let unseededDefenseTie = false;
  const outcomes: CandidateOutcome[][] = [];
  for (const candidate of candidates) {
    if (candidate.terminal) {
      outcomes.push([{ exact: exactTerminalPrediction(view, candidate.board), probability: 1, replyKey: "pass" }]);
      continue;
    }
    candidate.opponent ??= candidate.action.type === "move"
      ? prepareOpponentPosition(candidate.board, view.opponent, forecastHistory, 0,
        moveHistory, prepared.opponentPredictionCache)
      : prepareOpponentPosition(candidate.board, view.opponent, view.previousBoards ?? [],
        (view.consecutivePasses ?? 0) + 1, prepared.historyHashes,
        prepared.opponentPredictionCache);
    const perCandidate: CandidateOutcome[] = [];
    const replyHistory = candidate.action.type === "move" ? moveHistory : prepared.historyHashes;
    for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
      const seed = seeds[seedIndex]!;
      const forecast = predictPreparedOpponentReplies(candidate.opponent!, seed);
      if (forecast.certainty === "unseeded-defense-tie") unseededDefenseTie = true;
      for (const reply of forecast.replies) {
        const white = reply.move
          ? playMove(candidate.board, reply.move.x, reply.move.y, "O", replyHistory)
          : undefined;
        const after = white?.board ?? candidate.board;
        const responseNoOp = reply.move && !white ? 1 : 0;
        const responsePass = reply.move ? 0 : 1;
        const candidatePasses = candidate.action.type === "pass"
          ? (view.consecutivePasses ?? 0) + 1 : 0;
        const consecutivePasses = responsePass ? candidatePasses + 1
          : responseNoOp ? candidatePasses : 0;
        const legalHistory = new Set(replyHistory);
        if (white) legalHistory.add(boardHash(candidate.board));
        perCandidate.push({
          ...(consecutivePasses >= 2
            ? { exact: exactTerminalPrediction(view, after) }
            : { boardIndex: boardIndexOf({
              board: after,
              legal: legalFor(after, legalHistory),
              passFraction: consecutivePasses / 2,
              elapsedFraction: (elapsedRounds + 1) / Math.max(2 * backend.extent * backend.extent, 1),
              responsePass,
              responseNoOp,
              behavior: daemonValueBehavior ?? behaviorBySeed[seedIndex],
            }) }),
          probability: reply.probability / seeds.length,
          replyKey: reply.move ? `${reply.move.x},${reply.move.y}` : "pass",
        });
      }
    }
    outcomes.push(perCandidate);
  }

  const words = goBoardWords(backend.extent);
  const packed = engine.packedScratch(profile, words * batchStates.length);
  const legalWords = goLegalWords(backend.extent);
  const legal = new Uint32Array(legalWords * batchStates.length);
  const state = new Float32Array(4 * batchStates.length);
  const behavior = new Float32Array(backend.behaviorFeatures * batchStates.length);
  for (let index = 0; index < batchStates.length; index++) {
    const input = batchStates[index]!;
    packGoBoard(input.board, backend.extent, packed, index * words);
    for (const point of input.legal) {
      legal[index * legalWords + (point >> 5)]! |= 1 << (point & 31);
    }
    state.set([input.passFraction, input.elapsedFraction,
      input.responsePass, input.responseNoOp], index * 4);
    behavior.set(input.behavior, index * backend.behaviorFeatures);
  }
  const raw = batchStates.length ? await backend.evaluateBatch({
    packed, legal, state, behavior, count: batchStates.length,
  }) : new Float32Array();
  const predictions: GoValuePrediction[] = [];
  for (let index = 0; index < batchStates.length; index++) {
    predictions.push(decodeGoValue(raw, index));
  }
  const positionValue = proposalPositionValue;

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
      powerPerRound += outcome.probability * goScorePerRound(prediction, elapsedRounds);
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
  }

  // Strict improvement over scan order (pass last) reproduces the trainer's
  // deterministic tie handling exactly.
  let best = scored[0]!;
  for (const entry of scored.slice(1)) {
    if (entry.winProbability > best.winProbability
      || (entry.winProbability === best.winProbability && entry.powerPerRound > best.powerPerRound)) {
      best = entry;
    }
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
  }
  ranked.sort((a, b) => b.score - a.score || b.powerPerRound - a.powerPerRound || b.captures - a.captures || a.x - b.x || a.y - b.y);

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

/** Materialize the exact public successor positions for the selected action.
 * Finalization has already prepared this candidate's opponent option spaces,
 * so this is a small memoized rules pass and performs no network work. */
export function neuralGoContinuations(
  prepared: GoNeuralPrepared,
  seeds: readonly number[],
  decision: GoDecision,
): GoNeuralContinuation[] {
  if (decision.action.type !== "move" && decision.action.type !== "pass") return [];
  const selected = prepared.candidates.find((candidate) => {
    if (candidate.action.type !== decision.action.type) return false;
    return candidate.action.type === "pass"
      || (decision.action.type === "move"
        && candidate.action.x === decision.action.x
        && candidate.action.y === decision.action.y);
  });
  if (!selected || selected.terminal) return [];

  const { view } = prepared;
  const moveHistory = new Set(prepared.historyHashes);
  moveHistory.add(boardHash(view.board));
  const forecastHistory = [view.board.rows, ...(view.previousBoards ?? [])];
  selected.opponent ??= selected.action.type === "move"
    ? prepareOpponentPosition(selected.board, view.opponent, forecastHistory, 0,
      moveHistory, prepared.opponentPredictionCache)
    : prepareOpponentPosition(selected.board, view.opponent, view.previousBoards ?? [],
      (view.consecutivePasses ?? 0) + 1, prepared.historyHashes,
      prepared.opponentPredictionCache);

  const replyHistory = selected.action.type === "move" ? moveHistory : prepared.historyHashes;
  const continuations: GoNeuralContinuation[] = [];
  for (const seed of seeds) {
    const forecast = predictPreparedOpponentReplies(selected.opponent, seed);
    for (const reply of forecast.replies) {
      const previousBoards = [...view.previousBoards];
      if (selected.action.type === "move") previousBoards.unshift(view.board.rows);
      const white = reply.move
        ? playMove(selected.board, reply.move.x, reply.move.y, "O", replyHistory)
        : undefined;
      if (white) previousBoards.unshift(selected.board.rows);
      const candidatePasses = selected.action.type === "pass"
        ? (view.consecutivePasses ?? 0) + 1 : 0;
      const consecutivePasses = reply.move ? 0 : candidatePasses + 1;
      continuations.push({
        seed,
        probability: reply.probability / seeds.length,
        response: reply.move
          ? { type: "move", x: reply.move.x, y: reply.move.y }
          : { type: "pass" },
        wait: reply.wait,
        view: {
          ...view,
          board: white?.board ?? selected.board,
          currentPlayer: consecutivePasses >= 2 ? "None" : "Black",
          status: consecutivePasses >= 2 ? "gameOver" : "inProgress",
          previousBoards,
          // The successor's public pass count, not merely "white passed": a
          // mutual pass reaches two. The driver reconstructs the same value
          // from its own board update, and any disagreement would make the
          // derived position identity miss and desync the worker cache.
          consecutivePasses,
        },
      });
    }
  }
  return continuations;
}

/** One-shot convenience for simulators and tests. */
export async function decideGoNeural(
  view: GoView,
  seeds: readonly number[],
  engine: GoNeuralEngine,
): Promise<GoDecision> {
  const prepared = prepareNeuralGoDecision(view);
  return finalizeNeuralGoDecision(prepared, seeds, engine);
}

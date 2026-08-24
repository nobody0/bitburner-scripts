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
  encodeOpponentFutureBehavior,
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
  predictOpponentReplies,
  predictPreparedOpponentReplies,
  prepareOpponentPosition,
  type OpponentWaitTrace,
  type PreparedOpponentPosition,
  type OpponentPredictionCache,
} from "../opponent.ts";
import {
  applyGoCheat,
  boardHash,
  goObservedBoardSizeFor,
  legalMoveIndices,
  placeCheatRouterRaw,
  playMove,
  scoreBoard,
  type GoCheatTransition,
  type GoCheatAction,
  type GoBoard,
  type GoDecision,
  type GoMove,
  type GoPlayingAction,
  type GoPredictedReply,
  type GoView,
} from "../rules.ts";
import {
  alignedAiSeed,
  GO_ENGINE_CYCLE_MS,
  goCheatSucceedsSafely,
  goOpponentSeedCandidates,
  goSuccessorDispatchCandidates,
  nextGoTurnTiming,
} from "../rng.ts";
import {
  GO_VALUE_OUTPUTS,
  loadGoValueWeights,
  type GoV9Weights,
  type GoValueModelArtifact,
} from "./artifact.ts";
import {
  decodeGoValue,
  goBoardWords,
  goLegalWords,
  goScorePerRound,
  packGoBoard,
  packGoTactical,
  type GoValueBatch,
  type GoValueBackend,
  type GoValuePrediction,
} from "./backend.ts";
import { SMALL5_GO_MODEL } from "./models/small5.ts";
import { DAEMON19_GO_MODEL } from "./models/daemon19.ts";

function withTacticalInputs(backend: GoValueBackend, batch: GoValueBatch): GoValueBatch {
  if (backend.inputChannels === 16) {
    batch.tactical = packGoTactical(batch.packed, batch.legal, batch.count, backend.extent);
  }
  return batch;
}
import { GO_REWARD_RULES } from "../rewards.ts";

export type GoModelProfile = "small5" | "daemon19";

export function goModelProfile(boardSize: number): GoModelProfile {
  return boardSize <= 5 ? "small5" : "daemon19";
}

/** Production finalist budget per model profile — the single source of truth
 * shared by live play, the arenas, the promotion tools, and the cross-runtime
 * selector audit, so an arena run proves live behavior.
 *
 * - `daemon19` is strict K=1: the installed champion is a policy-only model
 *   whose value head is deliberately neutral, so any K>1 finalizer would
 *   select by candidate scan order rather than by policy. One policy forward
 *   pass chooses the highest-logit legal action; post-response value never
 *   participates in live selection. Boards 7/9/13 route to the daemon19
 *   weights and inherit this contract.
 * - `small5` shortlists K=4 with the policy, applies each exact predicted
 *   White response in TypeScript, and reinvests the narrower root into the
 *   production deep-search finalizer (`GO_PROFILE_DEEP_SEARCH`): round-two
 *   expansion over the predicted successor seeds, selecting win-first with
 *   loss-penalized Power per total turn as the tie-break. Adaptive
 *   flat-boundary expansion still applies above K=1. Evidence (2026-08-16,
 *   two disjoint 768-game paired screens): deep K=4/f3 won 724 and 718 of
 *   768 versus flat K=8's 671 and 667, with ~75/22 favorable flips each
 *   (p<1e-6), better Power/turn and fewer turns, at 5.2/9.0 ms p50/p95
 *   decisions — far inside the 50 ms budget. Flat K=4 alone is strictly
 *   worse than flat K=8 (1,953 vs 1,981 over 2,304 paired games); never
 *   narrow this constant without the deep finalizer.
 *
 * `view.candidateLimit` remains the explicit override for arenas, audits, and
 * gated experiments; `Infinity` is the exhaustive shadow mode. */
export const GO_PROFILE_CANDIDATE_LIMITS: Readonly<Record<GoModelProfile, number>> = {
  small5: 4,
  daemon19: 1,
};

export type GoValueBackendFactory = (
  weights: GoV9Weights,
  profile: GoModelProfile,
) => Promise<GoValueBackend> | GoValueBackend;

export type GoModelArtifactOverrides = Partial<Record<GoModelProfile, GoValueModelArtifact>>;

/** Gated deep-search finalization: after each exact first White reply, the
 * engine predicts the seed candidates of our next dispatch tick from the
 * reply's wait trace, shortlists a small follow-up set with the policy under
 * each successor seed's exact behavior, applies White's exact second reply,
 * and value-evaluates the round-two boards. A root candidate's score becomes
 * the reply-probability-weighted mean (over successor seeds) of its best
 * follow-up's win-first/Power value. Selection stays win-first with
 * Power-per-turn tie-break.
 *
 * This mode reinvests a narrower root shortlist into depth at comparable
 * runtime. It is proven only through the paired deep-eval arena; live play
 * must not enable it without that proof. */
export interface GoDeepSearchV1 {
  schema: "bitburner-go-deep-search-v1";
  /** Follow-up shortlist breadth at each successor decision. */
  followUpK: number;
  /** Extra 200 ms ticks of successor-dispatch uncertainty. Zero models the
   * deterministic arena replay; one models live script/AI processing. */
  uncertaintyTicks: number;
}

function validateDeepSearch(config: GoDeepSearchV1): void {
  if (config.schema !== "bitburner-go-deep-search-v1"
    || !Number.isSafeInteger(config.followUpK) || config.followUpK < 1 || config.followUpK > 32
    || !Number.isSafeInteger(config.uncertaintyTicks)
    || config.uncertaintyTicks < 0 || config.uncertaintyTicks > 4) {
    throw new Error("invalid deep-search configuration");
  }
}

/** Production deep-search configuration per profile, resolved when an engine
 * is constructed without an explicit override (`null` forces flat
 * finalization for baseline arms). An entry may be added only with a paired
 * deep-versus-flat arena win replicated on a disjoint corpus within the 50 ms
 * p95 decision budget; see go-ai/DEPLOYMENT.md. The small5 entry carries the
 * replicated 2026-08-16 proof recorded on GO_PROFILE_CANDIDATE_LIMITS;
 * uncertainty tick 1 covers live script/AI processing inside the 200 ms
 * engine cycle (the deterministic-replay u=0 arms scored equivalently). */
export const GO_PROFILE_DEEP_SEARCH: Readonly<Partial<Record<GoModelProfile, GoDeepSearchV1>>> = {
  small5: {
    schema: "bitburner-go-deep-search-v1",
    followUpK: 3,
    uncertaintyTicks: 1,
  },
};

/** Per-opponent search budget, spent where the field is hardest.
 *
 * The profile defaults are sized for the whole field and leave most of the
 * 50 ms decision budget unused. Opponents are not equally hard, and Power is
 * won per game rather than per turn, so an opponent the deployed net loses to
 * is worth more search than one it already beats. An entry may be added only
 * with a paired arena win against the profile default for that opponent,
 * replicated on a disjoint corpus, inside the same p95 budget. */
export interface GoOpponentSearchOverride {
  candidateLimit?: number;
  deepSearch?: GoDeepSearchV1;
}
export const GO_OPPONENT_SEARCH: Readonly<Record<string, GoOpponentSearchOverride>> = {
  // Illuminati is the only 5x5 opponent the deployed network still loses to
  // regularly, and it responds strongly to a wider root. Three disjoint
  // 384-game corpora (`go:search:screen`, 2026-08-17, seeds 71717101 /
  // 82828201 / 93939301) scored 865/1152 against the profile default's
  // 788/1152 — 75.1% versus 68.4%, paired flips +160/-83 — at 14 ms p95
  // against the 50 ms budget. K=12 and K=16 with deeper follow-ups gained a
  // further ~1 point for 17-27 ms, which is not worth the headroom: the
  // worker evaluates several successor positions per turn for push-ahead, so
  // per-decision cost multiplies there.
  Illuminati: {
    candidateLimit: 8,
    deepSearch: { schema: "bitburner-go-deep-search-v1", followUpK: 5, uncertaintyTicks: 1 },
  },
};

/** Owns one lazily created backend per model profile plus reusable packing
 * scratch, so weight uploads happen once per process. */
export class GoNeuralEngine {
  #factory: GoValueBackendFactory;
  #artifacts: GoModelArtifactOverrides;
  #backends = new Map<GoModelProfile, Promise<GoValueBackend>>();
  #packed = new Map<GoModelProfile, Uint32Array>();
  /** Explicit config wins; `undefined` resolves the per-profile production
   * default at finalization; `null` forces flat finalization. */
  readonly deepSearch?: GoDeepSearchV1 | null;

  constructor(factory: GoValueBackendFactory, artifacts: GoModelArtifactOverrides = {},
    deepSearch?: GoDeepSearchV1 | null) {
    this.#factory = factory;
    this.#artifacts = artifacts;
    if (deepSearch) validateDeepSearch(deepSearch);
    this.deepSearch = deepSearch;
  }

  backendFor(boardSize: number): Promise<GoValueBackend> {
    const profile = goModelProfile(boardSize);
    let backend = this.#backends.get(profile);
    if (!backend) {
      const artifact = this.#artifacts[profile]
        ?? (profile === "small5" ? SMALL5_GO_MODEL : DAEMON19_GO_MODEL);
      backend = Promise.resolve(this.#factory(
        loadGoValueWeights(artifact),
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

type GoCandidateAction =
  | { type: "move"; x: number; y: number }
  | { type: "pass" }
  | GoCheatAction;

export interface GoNeuralPreparedCandidate {
  action: GoCandidateAction;
  /** Board after the black action; passes leave the position untouched. */
  board: GoBoard;
  captures: number;
  /** Ordinary placements push the input board into positional-superko
   * history. Cheats and passes do not. */
  recordsHistory: boolean;
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
  // Compare against the size the reset actually produces: the secret opponent
  // ignores the requested size and always plays 19x19, so a fresh daemon board
  // must not read as a mismatch and re-roll forever.
  const pristineRetarget = view.nextGame !== undefined
    && view.previousBoards.length === 0
    && (view.opponent !== preferredOpponent
      || view.board.size !== goObservedBoardSizeFor(preferredOpponent, boardSize));
  if (view.status === "gameOver" || view.currentPlayer === "None" || pristineRetarget) {
    return {
      action: { type: "newGame", opponent: preferredOpponent, boardSize },
      ranked: [],
      finalists: 0,
      // Immediate transitions never run the network; a neutral nominal value
      // keeps the field's win-probability scale.
      positionValue: 0.5,
    };
  }
  if (view.currentPlayer !== "Black") {
    return {
      action: { type: "resume" },
      ranked: [],
      finalists: 0,
      positionValue: 0.5,
    };
  }
  if ((view.consecutivePasses ?? 0) > 0) {
    const score = scoreBoard(view.board, view.komi ?? 0);
    if (score.X >= score.O) {
      return {
        action: { type: "pass" },
        ranked: [],
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

export interface GoV9ProposalSelection {
  average: number[];
  ranked: number[];
  finalists: number[];
  baseLimit: number;
  adaptiveLimit: number;
  perSeedReserve: number;
}

/** Value output of a neutral (all-zero) head: sigmoid(0) = 0.5 win
 * probability and expm1(softplus(0)) = 1 for both regression heads. The
 * strict K=1 fast path substitutes this constant instead of dispatching the
 * post-response value batch, which keeps its decision fields bit-identical to
 * the full pipeline under the policy-only daemon19 champion. For an explicit
 * K=1 assay on a model with a trained value head the reported scores become
 * this neutral constant; selection is unaffected because a single finalist
 * needs no arbitration. */
const POLICY_ONLY_PREDICTION: GoValuePrediction = decodeGoValue(
  new Float32Array(GO_VALUE_OUTPUTS), 0);

/** Pure proposal-stage deployment rule, shared by production and the
 * cross-runtime selector audit. Candidate indices are returned in stable scan
 * order because that is also the final value tie-break order. */
export function selectV9ProposalFinalists(
  moveIndices: readonly number[],
  proposalMoves: ArrayLike<number>,
  seedCount: number,
  proposalStride: number,
  requestedLimit: number,
): GoV9ProposalSelection {
  if (seedCount < 1) throw new Error("V9 proposal selection requires at least one seed");
  const average = moveIndices.map((move) => {
    let sum = 0;
    for (let seed = 0; seed < seedCount; seed++) {
      sum += proposalMoves[seed * proposalStride + move]!;
    }
    return sum / seedCount;
  });
  const ranked = moveIndices.map((_, index) => index)
    .sort((left, right) => average[right]! - average[left]! || left - right);
  const baseLimit = Math.min(Math.max(1, Math.floor(requestedLimit)), ranked.length);
  let adaptiveLimit = baseLimit;
  // An explicit one-candidate request is the policy-only path: there is no
  // second finalist for the value head to arbitrate.  Adaptive expansion is
  // useful for normal shortlists, but expanding K=1 silently defeats a direct
  // policy-distillation assay (and the caller's stated bound).
  if (baseLimit > 1 && adaptiveLimit < ranked.length
    && average[ranked[adaptiveLimit - 1]!]! - average[ranked[adaptiveLimit]!]! < 0.25) {
    adaptiveLimit = Math.min(ranked.length, adaptiveLimit * 2);
  }
  const retained = new Set<number>();
  const perSeedReserve = Math.max(1, Math.floor(adaptiveLimit / Math.max(2 * seedCount, 1)));
  if (baseLimit === 1) {
    // Strict K=1 selects the seed-averaged policy argmax and nothing else.
    // Per-seed reservation would retain one candidate per disagreeing seed,
    // silently widening a policy-only decision into scan-order arbitration by
    // whatever the (possibly neutral) value head reports.
    retained.add(ranked[0]!);
  } else {
    for (let seed = 0; seed < seedCount; seed++) {
      const bySeed = moveIndices.map((_, index) => index).sort((left, right) =>
        proposalMoves[seed * proposalStride + moveIndices[right]!]!
          - proposalMoves[seed * proposalStride + moveIndices[left]!]! || left - right);
      for (const index of bySeed.slice(0, perSeedReserve)) retained.add(index);
    }
    for (const index of ranked) {
      if (retained.size >= adaptiveLimit) break;
      retained.add(index);
    }
  }
  return {
    average,
    ranked,
    finalists: [...retained].sort((left, right) => left - right),
    baseLimit,
    adaptiveLimit,
    perSeedReserve,
  };
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
      recordsHistory: true,
      terminal: false,
    });
  }
  const passTerminal = passCount + 1 >= 2;
  candidates.push({
    action: { type: "pass" },
    board: view.board,
    captures: 0,
    recordsHistory: false,
    terminal: passTerminal,
  });
  return { view, candidates, historyHashes, elapsedRounds, opponentPredictionCache };
}

interface CandidateOutcome {
  boardIndex?: number;
  /** Terminal double-pass candidates bypass the network: the exact rules
   * engine scores the finished game, mirroring the trainer's reward. */
  exact?: GoValuePrediction;
  /** Deep-search mode scores this branch through its round-two expansion
   * instead; the neutral `exact` value here only keeps the reply histogram. */
  deepPlaceholder?: true;
  probability: number;
  replyKey: string;
}

/** One (root candidate, exact first White reply) branch awaiting round-two
 * expansion under the deep-search finalizer. */
interface GoDeepJob {
  candidateIndex: number;
  /** Reply probability already divided by the root seed count. */
  probability: number;
  wait: OpponentWaitTrace;
  after: GoBoard;
  consecutivePasses: number;
  legalHistory: Set<string>;
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

function cheatCandidate(
  board: GoBoard,
  action: GoCheatAction,
): GoNeuralPreparedCandidate | undefined {
  const played: GoCheatTransition | undefined = applyGoCheat(board, action);
  if (!played) return undefined;
  return { action, board: played.board, captures: played.captures, recordsHistory: false, terminal: false };
}

function cheatHeuristic(view: GoView, candidate: GoNeuralPreparedCandidate): number {
  const score = scoreBoard(candidate.board, view.komi ?? 0);
  return (score.X - score.O) * 100 + candidate.captures * 10;
}

function boundedSinglePointCheats(view: GoView, limit: number): GoNeuralPreparedCandidate[] {
  const families: GoNeuralPreparedCandidate[][] = [[], [], []];
  for (let x = 0; x < view.board.size; x++) for (let y = 0; y < view.board.size; y++) {
    const cell = view.board.rows[x]![y];
    const action = cell === "O"
      ? { type: "cheatRemoveRouter" as const, x, y }
      : cell === "."
        ? { type: "cheatDestroyNode" as const, x, y }
        : cell === "#"
          ? { type: "cheatRepairNode" as const, x, y }
          : undefined;
    if (!action) continue;
    const candidate = cheatCandidate(view.board, action);
    if (!candidate) continue;
    families[action.type === "cheatRemoveRouter" ? 0 : action.type === "cheatDestroyNode" ? 1 : 2]!.push(candidate);
  }
  return families.flatMap((family) => family
    .sort((left, right) => cheatHeuristic(view, right) - cheatHeuristic(view, left)
      || JSON.stringify(left.action).localeCompare(JSON.stringify(right.action)))
    .slice(0, limit));
}

/** Seed-dependent half. V9 proposes on the original board, then resolves each
 * finalist's weighted replies, evaluates every distinct result board in one
 * backend batch, and selects exactly like the trainer's outer loop.
 *
 * The first finalization of a prepared decision forces only the option-space
 * branches reached by the concrete seeds. Repeat finalizations (the exact
 * dispatch-time seed or a boundary replan) reuse those memoized analyses. */
async function finalizeForSeeds(
  prepared: GoNeuralPrepared,
  seeds: readonly number[],
  engine: GoNeuralEngine,
  dispatchPlaytime?: number,
  preferredFirstMove?: { x: number; y: number },
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
  // The exact signature belongs to proposal scoring on the current Black
  // turn. Once that reply is applied its roll is consumed; value scoring keeps
  // the stable opponent policy but marks the unknown future rolls explicitly.
  const futureBehavior = encodeOpponentFutureBehavior(
    view.opponent,
    profile === "small5" ? view.komi ?? GO_REWARD_RULES[view.opponent].komi : undefined,
  );
  let candidates = [...allCandidates];
  const cheatChance = view.cheat?.successByCount[view.cheat.count] ?? 0;
  const useCheat = view.cheat?.unlocked === true
    && dispatchPlaytime !== undefined
    && goCheatSucceedsSafely(dispatchPlaytime, cheatChance);
  let proposalPositionValue = 0;
  let preferredFirstMoveRetained: boolean | undefined;
  for (const behavior of behaviorBySeed) if (behavior.length !== backend.behaviorFeatures) {
    throw new Error(`V9 behavior shape ${behavior.length} does not match ${backend.behaviorFeatures}`);
  }
  if (futureBehavior.length !== backend.behaviorFeatures) {
    throw new Error(`V9 future behavior shape ${futureBehavior.length} does not match ${backend.behaviorFeatures}`);
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
    const proposal = await backend.evaluateProposal(withTacticalInputs(backend, {
      packed, legal, state, behavior, count: seeds.length,
    }));
    proposalPositionValue = seeds.reduce((sum, _, index) =>
      sum + decodeGoValue(proposal.value, index).winProbability, 0) / seeds.length;
    const area = backend.extent * backend.extent;
    const moveIndex = (candidate: GoNeuralPreparedCandidate): number => candidate.action.type === "pass"
      ? area
      : candidate.action.type === "move"
        ? candidate.action.x * backend.extent + candidate.action.y
        : area;
    const proposalSelection = selectV9ProposalFinalists(
      candidates.map(moveIndex), proposal.moves, seeds.length, area + 1, candidates.length);
    const { ranked } = proposalSelection;
    if (useCheat) {
      const cheat = view.cheat!;
      if (!Number.isFinite(cheat.candidateLimit) || cheat.candidateLimit < 0
        || !Number.isFinite(cheat.doubleMoveLimit) || cheat.doubleMoveLimit < 1) {
        throw new Error("Go cheat candidate limits must be nonnegative and doubleMoveLimit must be positive");
      }
      const pass = candidates.find((candidate) => candidate.action.type === "pass")!;
      const bestProposal = candidates[ranked[0]!]!;
      if (cheat.candidateLimit === 0) {
        if (bestProposal.action.type !== "move") {
          return {
            action: { type: "pass" },
            ranked: [],
            finalists: 1,
            positionValue: proposalPositionValue,
            forecast: [],
          };
        }
        const raw = placeCheatRouterRaw(view.board, bestProposal.action.x, bestProposal.action.y);
        if (!raw) throw new Error("first double-move proposal was invalid");
        const secondPacked = engine.packedScratch(profile, words * seeds.length);
        const secondLegal = new Uint32Array(legalWords * seeds.length);
        const secondState = new Float32Array(4 * seeds.length);
        const secondBehavior = new Float32Array(backend.behaviorFeatures * seeds.length);
        const empties: number[] = [];
        for (let x = 0; x < raw.size; x++) for (let y = 0; y < raw.size; y++) {
          if (raw.rows[x]![y] === ".") empties.push(x * backend.extent + y);
        }
        for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
          packGoBoard(raw, backend.extent, secondPacked, seedIndex * words);
          for (const point of empties) secondLegal[seedIndex * legalWords + (point >> 5)]! |= 1 << (point & 31);
          secondState.set([0,
            elapsedRounds / Math.max(2 * backend.extent * backend.extent, 1), 0, 0], seedIndex * 4);
          secondBehavior.set(behaviorBySeed[seedIndex]!, seedIndex * backend.behaviorFeatures);
        }
        const secondProposal = await backend.evaluateProposal(withTacticalInputs(backend, {
          packed: secondPacked,
          legal: secondLegal,
          state: secondState,
          behavior: secondBehavior,
          count: seeds.length,
        }));
        let secondPoint = area;
        let secondValue = Number.NEGATIVE_INFINITY;
        for (let point = 0; point <= area; point++) {
          const x = Math.floor(point / backend.extent);
          const y = point % backend.extent;
          if (point !== area && (x >= raw.size || y >= raw.size || raw.rows[x]![y] !== ".")) continue;
          const value = seeds.reduce((sum, _, seedIndex) => sum
            + secondProposal.moves[seedIndex * (area + 1) + point]!, 0) / seeds.length;
          if (value > secondValue) {
            secondValue = value;
            secondPoint = point;
          }
        }
        if (secondPoint === area) {
          return {
            action: { type: "pass" },
            ranked: [],
            finalists: 1,
            positionValue: proposalPositionValue,
            forecast: [],
          };
        }
        const greedy = cheatCandidate(view.board, {
          type: "cheatTwoMoves",
          x1: bestProposal.action.x,
          y1: bestProposal.action.y,
          x2: Math.floor(secondPoint / backend.extent),
          y2: secondPoint % backend.extent,
        });
        if (!greedy) throw new Error("sequential double-move proposal produced an invalid cheat");
        return {
          action: greedy.action as GoPlayingAction,
          ranked: [],
          finalists: 1,
          positionValue: proposalPositionValue,
          forecast: [],
        };
      }
      // A certified playbook move seeds the double family as an extra first
      // placement — it does not consume a doubleMoveLimit slot — and its plain
      // form is force-retained as a value-batch finalist below, so a seeded
      // cheat is chosen only when it beats the certified continuation
      // head-to-head under the same evaluation.
      const preferred = preferredFirstMove === undefined ? undefined
        : candidates.find((candidate) => candidate.action.type === "move"
          && candidate.action.x === preferredFirstMove.x
          && candidate.action.y === preferredFirstMove.y);
      // Reported to the caller: an engine cheat may only override a certified
      // move when the certified benchmark actually competed in this batch. A
      // dropped preferred move (not a legal candidate here) means no such
      // head-to-head happened.
      if (preferredFirstMove !== undefined) preferredFirstMoveRetained = preferred !== undefined;
      const rankedFirsts = bestProposal.action.type === "pass" ? [] : ranked
        .map((index) => candidates[index]!)
        .filter((candidate) => candidate.action.type === "move")
        .slice(0, Math.floor(cheat.doubleMoveLimit));
      const firsts = preferred && rankedFirsts.length && !rankedFirsts.some((candidate) =>
        candidate.action.type === "move"
        && candidate.action.x === preferredFirstMove!.x
        && candidate.action.y === preferredFirstMove!.y)
        ? [preferred, ...rankedFirsts]
        : rankedFirsts;
      const doubles: GoNeuralPreparedCandidate[] = [];
      if (firsts.length) {
        const count = firsts.length * seeds.length;
        const secondPacked = engine.packedScratch(profile, words * count);
        const secondLegal = new Uint32Array(legalWords * count);
        const secondState = new Float32Array(4 * count);
        const secondBehavior = new Float32Array(backend.behaviorFeatures * count);
        const rawBoards: GoBoard[] = [];
        for (let firstIndex = 0; firstIndex < firsts.length; firstIndex++) {
          const first = firsts[firstIndex]!.action;
          if (first.type !== "move") continue;
          const raw = placeCheatRouterRaw(view.board, first.x, first.y);
          if (!raw) continue;
          rawBoards.push(raw);
          const empties: number[] = [];
          for (let x = 0; x < raw.size; x++) for (let y = 0; y < raw.size; y++) {
            if (raw.rows[x]![y] === ".") empties.push(x * backend.extent + y);
          }
          for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
            const index = firstIndex * seeds.length + seedIndex;
            packGoBoard(raw, backend.extent, secondPacked, index * words);
            for (const point of empties) secondLegal[index * legalWords + (point >> 5)]! |= 1 << (point & 31);
            secondState.set([0,
              elapsedRounds / Math.max(2 * backend.extent * backend.extent, 1), 0, 0], index * 4);
            secondBehavior.set(behaviorBySeed[seedIndex]!, index * backend.behaviorFeatures);
          }
        }
        const second = await backend.evaluateProposal(withTacticalInputs(backend, {
          packed: secondPacked, legal: secondLegal, state: secondState,
          behavior: secondBehavior, count,
        }));
        for (let firstIndex = 0; firstIndex < firsts.length; firstIndex++) {
          const first = firsts[firstIndex]!.action;
          const raw = rawBoards[firstIndex];
          if (first.type !== "move" || !raw) continue;
          let bestPoint = area;
          let bestValue = Number.NEGATIVE_INFINITY;
          for (let point = 0; point <= area; point++) {
            const x = Math.floor(point / backend.extent);
            const y = point % backend.extent;
            if (point !== area && (x >= raw.size || y >= raw.size || raw.rows[x]![y] !== ".")) continue;
            const value = seeds.reduce((sum, _, seedIndex) => sum
              + second.moves[((firstIndex * seeds.length + seedIndex) * (area + 1)) + point]!, 0) / seeds.length;
            if (value > bestValue) {
              bestValue = value;
              bestPoint = point;
            }
          }
          // A policy pass at either stage suppresses this double candidate.
          if (bestPoint === area) continue;
          const candidate = cheatCandidate(view.board, {
            type: "cheatTwoMoves",
            x1: first.x,
            y1: first.y,
            x2: Math.floor(bestPoint / backend.extent),
            y2: bestPoint % backend.extent,
          });
          if (candidate) doubles.push(candidate);
        }
      }
      candidates = [
        ...doubles,
        ...boundedSinglePointCheats(view, Math.floor(cheat.candidateLimit)),
        ...(preferred ? [preferred] : []),
        pass,
      ];
    } else {
      const requested = view.candidateLimit;
      if (requested !== undefined && requested !== Number.POSITIVE_INFINITY
        && (!Number.isFinite(requested) || requested < 1)) {
        throw new Error(`V9 candidate limit must be positive, got ${requested}`);
      }
      const limit = requested === Number.POSITIVE_INFINITY ? candidates.length
        : requested !== undefined ? Math.max(1, Math.floor(requested))
        // Scoped to small5: boards above 5x5 route to the policy-only
        // daemon19 weights and keep the strict K=1 contract whatever the
        // opponent's name happens to be.
        : (profile === "small5" ? GO_OPPONENT_SEARCH[view.opponent]?.candidateLimit : undefined)
          ?? GO_PROFILE_CANDIDATE_LIMITS[profile];
      const selected = selectV9ProposalFinalists(
        candidates.map(moveIndex), proposal.moves, seeds.length, area + 1, limit);
      candidates = selected.finalists.map((index) => candidates[index]!);
    }
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
  // Strict K=1 is the policy-only contract: with a single finalist the
  // post-response value batch cannot change the selected action, so it is not
  // dispatched at all. Exact reply prediction still runs below because the
  // forecast, telemetry, and push-ahead continuations depend on it. The
  // neutral decode keeps every reported field identical to what the all-zero
  // daemon19 value head would have produced for any board.
  const policyOnly = candidates.length === 1;
  if (backend.valuePath === "absent" && !policyOnly) {
    throw new Error(`the installed ${profile} artifact is policy-only; `
      + `${candidates.length} finalists would require the stripped value head — `
      + "restore the full artifact for any K>1 evaluation");
  }
  const deepSearch = engine.deepSearch === null ? undefined
    : engine.deepSearch
      ?? (profile === "small5" ? GO_OPPONENT_SEARCH[view.opponent]?.deepSearch : undefined)
      ?? GO_PROFILE_DEEP_SEARCH[profile];
  const deepActive = deepSearch !== undefined && !useCheat && !policyOnly
    && dispatchPlaytime !== undefined;
  const deepJobs: GoDeepJob[] = [];
  const outcomes: CandidateOutcome[][] = [];
  for (const candidate of candidates) {
    if (candidate.terminal) {
      outcomes.push([{ exact: exactTerminalPrediction(view, candidate.board), probability: 1,
        replyKey: "pass" }]);
      continue;
    }
    candidate.opponent ??= candidate.recordsHistory
      ? prepareOpponentPosition(candidate.board, view.opponent, forecastHistory, 0,
        moveHistory, prepared.opponentPredictionCache)
      : prepareOpponentPosition(candidate.board, view.opponent, view.previousBoards ?? [],
        candidate.action.type === "pass" ? (view.consecutivePasses ?? 0) + 1 : 0,
        prepared.historyHashes,
        prepared.opponentPredictionCache);
    const perCandidate: CandidateOutcome[] = [];
    const replyHistory = candidate.recordsHistory ? moveHistory : prepared.historyHashes;
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
        if (deepActive && consecutivePasses < 2) {
          deepJobs.push({
            candidateIndex: outcomes.length,
            probability: reply.probability / seeds.length,
            wait: reply.wait,
            after,
            consecutivePasses,
            legalHistory,
          });
        }
        perCandidate.push({
          ...(consecutivePasses >= 2
            ? { exact: exactTerminalPrediction(view, after) }
            : policyOnly
            ? { exact: POLICY_ONLY_PREDICTION }
            : deepActive
            ? { exact: POLICY_ONLY_PREDICTION, deepPlaceholder: true as const }
            : { boardIndex: boardIndexOf({
              board: after,
              legal: legalFor(after, legalHistory),
              passFraction: consecutivePasses / 2,
              elapsedFraction: (elapsedRounds + 1) / Math.max(2 * backend.extent * backend.extent, 1),
              responsePass,
              responseNoOp,
              behavior: futureBehavior,
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
  const raw = batchStates.length ? await backend.evaluateBatch(withTacticalInputs(backend, {
    packed, legal, state, behavior, count: batchStates.length,
  })) : new Float32Array();
  const predictions: GoValuePrediction[] = [];
  for (let index = 0; index < batchStates.length; index++) {
    predictions.push(decodeGoValue(raw, index));
  }
  const positionValue = proposalPositionValue;

  /** Round-two expansion: for every deep job, derive the successor dispatch
   * tick candidates from the reply's exact wait trace, shortlist follow-up
   * moves under each successor seed's exact behavior, apply White's exact
   * second reply, and value-evaluate the round-two boards in one batch. Each
   * job scores as the mean over successor variants of its best follow-up. */
  async function evaluateDeepSearchJobs(): Promise<Map<number, { win: number; power: number }>> {
    const config = deepSearch!;
    const behaviorKomi = profile === "small5"
      ? view.komi ?? GO_REWARD_RULES[view.opponent].komi : undefined;
    const area = backend.extent * backend.extent;
    const norm = Math.max(2 * area, 1);
    interface DeepRow {
      job: GoDeepJob;
      rowWeight: number;
      successorSeed: number;
      legalPoints: number[];
    }
    const rows: DeepRow[] = [];
    for (const job of deepJobs) {
      const { timing, candidates: dispatchTicks } = goSuccessorDispatchCandidates(
        dispatchPlaytime!, view.bonusCycles ?? 0, job.wait, config.uncertaintyTicks);
      const variants = dispatchTicks.flatMap((tick) =>
        goOpponentSeedCandidates(tick, timing.bonusCycles));
      const legalPoints = legalFor(job.after, job.legalHistory);
      for (const successorSeed of variants) {
        rows.push({ job, rowWeight: 1 / variants.length, successorSeed, legalPoints });
      }
    }
    if (!rows.length) return new Map();

    const rowWords = goBoardWords(backend.extent);
    const rowPacked = engine.packedScratch(profile, rowWords * rows.length);
    const rowLegalWords = goLegalWords(backend.extent);
    const rowLegal = new Uint32Array(rowLegalWords * rows.length);
    const rowState = new Float32Array(4 * rows.length);
    const rowBehavior = new Float32Array(backend.behaviorFeatures * rows.length);
    rows.forEach((row, index) => {
      packGoBoard(row.job.after, backend.extent, rowPacked, index * rowWords);
      for (const point of row.legalPoints) {
        rowLegal[index * rowLegalWords + (point >> 5)]! |= 1 << (point & 31);
      }
      rowState.set([row.job.consecutivePasses / 2, (elapsedRounds + 1) / norm, 0, 0], index * 4);
      rowBehavior.set(encodeOpponentTurnBehavior(
        opponentTurnBehavior(view.opponent, row.successorSeed), behaviorKomi),
        index * backend.behaviorFeatures);
    });
    const successorProposal = await backend.evaluateProposal(withTacticalInputs(backend, {
      packed: rowPacked, legal: rowLegal, state: rowState, behavior: rowBehavior,
      count: rows.length,
    }));

    interface FollowUpBranch {
      boardIndex?: number;
      exact?: GoValuePrediction;
      probability: number;
    }
    const deepBoardIndices = new Map<string, number>();
    const deepBatch: BatchedState[] = [];
    const deepIndexOf = (input: BatchedState): number => {
      const key = `${boardHash(input.board)}|${input.legal.join(",")}|${input.passFraction}|${input.elapsedFraction}|${input.responsePass}|${input.responseNoOp}`;
      const existing = deepBoardIndices.get(key);
      if (existing !== undefined) return existing;
      const index = deepBatch.length;
      deepBoardIndices.set(key, index);
      deepBatch.push(input);
      return index;
    };
    const followUps: FollowUpBranch[][][] = rows.map((row, rowIndex) => {
      const ranked = [...row.legalPoints, area]
        .sort((left, right) =>
          successorProposal.moves[rowIndex * (area + 1) + right]!
            - successorProposal.moves[rowIndex * (area + 1) + left]! || left - right)
        .slice(0, Math.min(config.followUpK, row.legalPoints.length + 1));
      return ranked.map((movePoint) => {
        const job = row.job;
        const isPass = movePoint === area;
        const passesAfterUs = isPass ? job.consecutivePasses + 1 : 0;
        if (isPass && passesAfterUs >= 2) {
          return [{ exact: exactTerminalPrediction(view, job.after), probability: 1 }];
        }
        const moveX = Math.floor(movePoint / backend.extent);
        const moveY = movePoint % backend.extent;
        const played = isPass ? undefined
          : playMove(job.after, moveX, moveY, "X", job.legalHistory);
        if (!isPass && !played) return [];
        const boardAfterUs = played?.board ?? job.after;
        const whiteHistory = new Set(job.legalHistory);
        if (played) whiteHistory.add(boardHash(job.after));
        const preparedWhite = prepareOpponentPosition(boardAfterUs, view.opponent,
          [job.after.rows], passesAfterUs, whiteHistory, prepared.opponentPredictionCache);
        const forecast = predictPreparedOpponentReplies(preparedWhite, row.successorSeed);
        return forecast.replies.map((reply): FollowUpBranch => {
          const white = reply.move
            ? playMove(boardAfterUs, reply.move.x, reply.move.y, "O", whiteHistory)
            : undefined;
          const boardAfterWhite = white?.board ?? boardAfterUs;
          const responseNoOp = reply.move && !white ? 1 : 0;
          const responsePass = reply.move ? 0 : 1;
          const passes = responsePass ? passesAfterUs + 1
            : responseNoOp ? passesAfterUs : 0;
          if (passes >= 2) {
            return { exact: exactTerminalPrediction(view, boardAfterWhite),
              probability: reply.probability };
          }
          const valueHistory = new Set(whiteHistory);
          if (white) valueHistory.add(boardHash(boardAfterUs));
          return {
            boardIndex: deepIndexOf({
              board: boardAfterWhite,
              legal: legalFor(boardAfterWhite, valueHistory),
              passFraction: passes / 2,
              elapsedFraction: (elapsedRounds + 2) / norm,
              responsePass,
              responseNoOp,
              behavior: futureBehavior,
            }),
            probability: reply.probability,
          };
        });
      });
    });

    const valuePacked = new Uint32Array(rowWords * deepBatch.length);
    const valueLegal = new Uint32Array(rowLegalWords * deepBatch.length);
    const valueState = new Float32Array(4 * deepBatch.length);
    const valueBehavior = new Float32Array(backend.behaviorFeatures * deepBatch.length);
    deepBatch.forEach((input, index) => {
      packGoBoard(input.board, backend.extent, valuePacked, index * rowWords);
      for (const point of input.legal) {
        valueLegal[index * rowLegalWords + (point >> 5)]! |= 1 << (point & 31);
      }
      valueState.set([input.passFraction, input.elapsedFraction,
        input.responsePass, input.responseNoOp], index * 4);
      valueBehavior.set(input.behavior, index * backend.behaviorFeatures);
    });
    const deepRaw = deepBatch.length ? await backend.evaluateBatch(withTacticalInputs(backend, {
      packed: valuePacked, legal: valueLegal, state: valueState, behavior: valueBehavior,
      count: deepBatch.length,
    })) : new Float32Array();

    const totals = new Map<number, { win: number; power: number }>();
    rows.forEach((row, rowIndex) => {
      let best: { win: number; power: number } | undefined;
      for (const branches of followUps[rowIndex]!) {
        if (!branches.length) continue;
        let win = 0;
        let power = 0;
        for (const branch of branches) {
          const prediction = branch.exact ?? decodeGoValue(deepRaw, branch.boardIndex!);
          win += branch.probability * prediction.winProbability;
          power += branch.probability * goScorePerRound(prediction, elapsedRounds + 1);
        }
        if (!best || win > best.win || (win === best.win && power > best.power)) {
          best = { win, power };
        }
      }
      if (!best) return;
      const total = totals.get(row.job.candidateIndex) ?? { win: 0, power: 0 };
      total.win += row.job.probability * row.rowWeight * best.win;
      total.power += row.job.probability * row.rowWeight * best.power;
      totals.set(row.job.candidateIndex, total);
    });
    return totals;
  }
  const deepScores = deepActive && deepJobs.length ? await evaluateDeepSearchJobs() : undefined;

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
      if (!outcome.deepPlaceholder) {
        winProbability += outcome.probability * prediction.winProbability;
        powerPerRound += outcome.probability * goScorePerRound(prediction, elapsedRounds);
      }
      replyCounts.set(outcome.replyKey, (replyCounts.get(outcome.replyKey) ?? 0) + outcome.probability * seeds.length);
    }
    const deep = deepScores?.get(index);
    if (deep) {
      winProbability += deep.win;
      powerPerRound += deep.power;
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
      ranked.push({
        x: action.x,
        y: action.y,
        score: entry.winProbability,
        powerPerRound: entry.powerPerRound,
        predictedReplies: entry.predictedReplies,
        forecastCertainty,
        captures: entry.candidate.captures,
      });
    }
  }
  ranked.sort((a, b) => b.score - a.score || b.powerPerRound - a.powerPerRound || b.captures - a.captures || a.x - b.x || a.y - b.y);

  if (best.candidate.action.type === "pass") {
    return {
      action: { type: "pass" },
      ranked: ranked.slice(0, 8),
      finalists: candidates.length,
      positionValue,
      forecast: best.predictedReplies,
      ...(policyOnly ? {} : { predictedWin: best.winProbability }),
      ...(preferredFirstMoveRetained === undefined ? {} : { preferredFirstMoveRetained }),
    };
  }
  return {
    action: best.candidate.action as GoPlayingAction,
    ranked: ranked.slice(0, 8),
    finalists: candidates.length,
    positionValue,
    forecast: best.predictedReplies,
    ...(policyOnly ? {} : { predictedWin: best.winProbability }),
    ...(preferredFirstMoveRetained === undefined ? {} : { preferredFirstMoveRetained }),
  };
}

/** One-cycle seed wait for positions the lookahead says are already lost.
 *
 * White's reply is a deterministic function of the tick we dispatch in, so a
 * position with no winning continuation at this seed can have one at the next.
 * Waiting costs one engine cycle (200 ms of game time) and one extra decision,
 * and it is attempted at most once per turn — a second wait would compound the
 * cost against a position the network is already pessimistic about, and the
 * caller's turn budget is a single tick of slack.
 *
 * The trigger is deliberately strict: every finalist, after its exact
 * predicted reply and the round-two deep search, must come back below
 * `lossThreshold`, and the waited seed must clear it by `minimumGain`. The
 * policy-only contract (daemon19 and every board above 5x5) reports no win
 * probability at all — its value head is neutral by construction — so it never
 * triggers, and the table is keyed per profile so that stays explicit. */
export interface GoSeedWaitV1 {
  /** How a losing turn is recognised.
   *
   * - `value` reads the finalizer's aggregated win probability. Free, but only
   *   as good as the value head's calibration, and absent entirely on the
   *   policy-only contract.
   * - `rollout` plays the game out: our own policy move, White's exact seeded
   *   reply, repeat, until the game ends or `rolloutPlies` is reached, then
   *   scores the board. It needs no value head, so it is the only detector
   *   available to daemon19, and it answers the actual question — does this
   *   line lose? — instead of a proxy for it. It costs one policy pass per
   *   ply, so it belongs in push-ahead time rather than a turn's own budget.
   */
  mode?: "value" | "rollout";
  /** Best predicted win probability at or above which the turn is fine.
   * Ignored in rollout mode, where losing is decided by playing it out. */
  lossThreshold: number;
  /** Improvement the waited seed must deliver to be worth the cycle. Ignored
   * in rollout mode, where the waited seed must simply win. */
  minimumGain: number;
  /** Rollout depth cap in plies; the board is scored where it stops. */
  rolloutPlies?: number;
}
export const GO_PROFILE_SEED_WAIT: Readonly<Partial<Record<GoModelProfile, GoSeedWaitV1>>> = {};

export interface GoPassWhenLostV1 {
  /** Best predicted win probability at or above which the position is not
   * treated as lost and the move is kept. Absent on policy-only profiles,
   * where the rollout guard is the only winnability test. */
  winAbort: number;
  /** Confirm the chosen line actually loses with a seeded rollout before
   * swapping to pass. Protects multi-move kills that bank no immediate score. */
  rolloutConfirm?: boolean;
  /** Rollout depth cap in plies; the board is scored where it stops. */
  rolloutPlies?: number;
}
/** Bank a lost game instead of playing it into the ground. Node power pays
 * blackScore * difficulty * streak win or lose, and the value-first argmax
 * never selects the exact-0 terminal pass while any move scores above zero —
 * so a dead position used to spiral: fill our own liberties, get captured,
 * repeat on the shrinking remainder while White passes, ending near zero.
 * This rule only ever fires while White's pass is on the table (our pass ends
 * the game immediately), we are behind, and the chosen move cannot guarantee
 * banking more than passing does even against White's kindest reply. */
export const GO_PROFILE_PASS_WHEN_LOST: Readonly<Partial<Record<GoModelProfile, GoPassWhenLostV1>>> = {
  small5: { winAbort: 0.05, rolloutConfirm: true, rolloutPlies: 40 },
  daemon19: { winAbort: 0.05, rolloutConfirm: true, rolloutPlies: 40 },
};

export interface GoFinalizeOptions {
  /** Explicit configuration, or null to disable; absent resolves the
   * per-profile production default. */
  seedWait?: GoSeedWaitV1 | null;
  /** Explicit configuration, or null to disable; absent resolves the
   * per-profile production default. */
  passWhenLost?: GoPassWhenLostV1 | null;
  /** Certified playbook move for the current position. On a cheat-eligible
   * tick it seeds the double-move family's first placement and its plain form
   * is force-retained as a finalist. Per-evaluation state: it never enters
   * GoView or the position identity. */
  preferredFirstMove?: { x: number; y: number };
}

/** Play a decided turn out to its conclusion and report whether it wins.
 *
 * Our side plays the production policy at K=1 (the argmax move; the value head
 * cannot change a single finalist, so this is one proposal pass per ply) and
 * White plays its most probable exact reply for the seed of the tick we would
 * dispatch in. The dispatch tick advances through the same timing model the
 * live push-ahead uses, so the seeds walked here are the seeds the game will
 * actually use. At the ply cap the board is scored as it stands, which is the
 * same win test the game applies at two passes. */
async function rolloutWins(
  view: GoView,
  action: GoPlayingAction,
  engine: GoNeuralEngine,
  dispatchPlaytime: number,
  plies: number,
): Promise<boolean> {
  let board = view.board;
  const history = [...(view.previousBoards ?? [])];
  let passes = view.consecutivePasses ?? 0;
  let playtime = dispatchPlaytime;
  let bonusCycles = view.bonusCycles ?? 0;
  let ourAction: GoPlayingAction | undefined = action;
  for (let ply = 0; ply < plies && passes < 2; ply++) {
    if (!ourAction) {
      const decision = await finalizeForSeeds(
        prepareNeuralGoDecision({ ...view, board, previousBoards: history,
          consecutivePasses: passes, bonusCycles, candidateLimit: 1 }),
        goOpponentSeedCandidates(playtime, bonusCycles),
        engine,
        playtime,
      );
      if (decision.action.type === "resume" || decision.action.type === "newGame") break;
      ourAction = decision.action;
    }
    if (ourAction.type === "move") {
      const played = playMove(board, ourAction.x, ourAction.y, "X",
        new Set(history.map((position) => position.join(""))));
      // An illegal continuation cannot be scored honestly; treat the line as
      // unresolved rather than inventing an outcome for it.
      if (!played) return false;
      history.unshift(board.rows);
      board = played.board;
      passes = 0;
    } else if (ourAction.type === "pass") {
      passes++;
    } else {
      // Cheat actions have their own success roll and are not part of a
      // seeded line; stop and score what is on the board.
      break;
    }
    ourAction = undefined;
    if (passes >= 2) break;

    const forecast = predictOpponentReplies(
      board, view.opponent, alignedAiSeed(playtime, bonusCycles), history, passes);
    const reply = [...forecast.replies].sort((left, right) => right.probability - left.probability)[0];
    if (!reply) break;
    if (reply.move) {
      const played = playMove(board, reply.move.x, reply.move.y, "O",
        new Set(history.map((position) => position.join(""))));
      if (played) {
        history.unshift(board.rows);
        board = played.board;
        passes = 0;
      }
      // A superko-rejected priority move changes nothing upstream either.
    } else {
      passes++;
    }
    const timing = nextGoTurnTiming(playtime, bonusCycles, reply.wait);
    playtime = timing.responsePlaytimeMs;
    bonusCycles = timing.bonusCycles;
  }
  const score = scoreBoard(board, view.komi);
  return score.X > score.O;
}

/** Worst-case Black score after playing `move`: the minimum over White
 * passing and every legal White reply. A one-ply exact-rules bound — a safe
 * endgame stone guarantees at least one more point than passing, while an
 * own-eye fill guarantees nothing and a self-endangering fill guarantees
 * less. Undefined when the move itself is illegal on the held board. */
function worstCaseBlackScoreAfter(
  prepared: GoNeuralPrepared,
  move: { x: number; y: number },
): number | undefined {
  const view = prepared.view;
  const played = playMove(view.board, move.x, move.y, "X", prepared.historyHashes);
  if (!played) return undefined;
  const komi = view.komi ?? 0;
  // White declining to answer is a legal continuation too.
  let worst = scoreBoard(played.board, komi).X;
  const replyHashes = new Set(prepared.historyHashes);
  replyHashes.add(boardHash(view.board));
  const size = played.board.size;
  for (const point of legalMoveIndices(played.board, "O", replyHashes)) {
    const reply = playMove(
      played.board, Math.floor(point / size), point % size, "O", replyHashes);
    if (!reply) continue;
    const banked = scoreBoard(reply.board, komi).X;
    if (banked < worst) worst = banked;
  }
  return worst;
}

/** The lost-game banking rule (`GO_PROFILE_PASS_WHEN_LOST`): swap the decided
 * move for a game-ending pass when the position is behind, White's pass is on
 * the table, and neither the exact one-ply banking bound nor the seeded
 * rollout can justify playing on. Off-trigger the decision flows through
 * untouched. */
async function applyPassWhenLost(
  prepared: GoNeuralPrepared,
  decision: GoDecision,
  engine: GoNeuralEngine,
  dispatchPlaytime: number,
  cfg: GoPassWhenLostV1,
): Promise<GoDecision> {
  const view = prepared.view;
  // Cheats have their own success roll and expected value; certified playbook
  // overrides are applied by the caller and never reach this swap.
  if (decision.action.type !== "move") return decision;
  // The safety rail: only act when our pass ends the game immediately, so the
  // question is "does playing on bank more than passing now", never "should we
  // concede White a free move".
  if ((view.consecutivePasses ?? 0) < 1) return decision;
  const score = scoreBoard(view.board, view.komi ?? 0);
  // Ahead is already locked in by immediateDecision before the search runs.
  if (score.X >= score.O) return decision;
  if (decision.predictedWin !== undefined && decision.predictedWin >= cfg.winAbort) {
    return decision;
  }
  const guaranteed = worstCaseBlackScoreAfter(prepared, decision.action);
  if (guaranteed !== undefined && guaranteed > score.X) return decision;
  if (cfg.rolloutConfirm !== false) {
    const plies = Math.max(1, Math.floor(cfg.rolloutPlies ?? 40));
    const playtime = dispatchPlaytime + (decision.dispatchOffsetMs ?? 0);
    if (await rolloutWins(view, decision.action, engine, playtime, plies)) {
      return decision;
    }
  }
  // A pass is seed-independent, so any seed-wait offset on the abandoned move
  // is dropped rather than delaying the game's end for nothing. The forecast
  // and predicted win must describe the returned action, not the abandoned
  // move: the pass ends the game behind, so no reply follows and the win
  // probability is exactly zero (kept absent on the policy-only contract).
  const { dispatchOffsetMs: _waitOffset, ...banked } = decision;
  return {
    ...banked,
    action: { type: "pass" },
    passReason: "banking-lost-position",
    forecast: [],
    ...(decision.predictedWin === undefined ? {} : { predictedWin: 0 }),
  };
}

export async function finalizeNeuralGoDecision(
  prepared: GoNeuralPrepared,
  seeds: readonly number[],
  engine: GoNeuralEngine,
  dispatchPlaytime?: number,
  options?: GoFinalizeOptions,
): Promise<GoDecision> {
  const decision = await finalizeWithSeedWait(
    prepared, seeds, engine, dispatchPlaytime, options);
  const profile = goModelProfile(prepared.view.board.size);
  const passWhenLost = options?.passWhenLost === null ? undefined
    : options?.passWhenLost ?? GO_PROFILE_PASS_WHEN_LOST[profile];
  if (!passWhenLost || dispatchPlaytime === undefined || prepared.immediate) {
    return decision;
  }
  return applyPassWhenLost(prepared, decision, engine, dispatchPlaytime, passWhenLost);
}

async function finalizeWithSeedWait(
  prepared: GoNeuralPrepared,
  seeds: readonly number[],
  engine: GoNeuralEngine,
  dispatchPlaytime?: number,
  options?: GoFinalizeOptions,
): Promise<GoDecision> {
  const decision = await finalizeForSeeds(
    prepared, seeds, engine, dispatchPlaytime, options?.preferredFirstMove);
  const profile = goModelProfile(prepared.view.board.size);
  const wait = options?.seedWait === null ? undefined
    : options?.seedWait ?? GO_PROFILE_SEED_WAIT[profile];
  if (!wait || dispatchPlaytime === undefined || prepared.immediate) return decision;
  const playing = decision.action.type !== "resume" && decision.action.type !== "newGame";
  if (!playing) return decision;
  const rollout = wait.mode === "rollout";
  if (!rollout && (decision.predictedWin === undefined
    || decision.predictedWin >= wait.lossThreshold)) {
    return decision;
  }
  const plies = Math.max(1, Math.floor(wait.rolloutPlies ?? 60));
  if (rollout && await rolloutWins(
    prepared.view, decision.action as GoPlayingAction, engine, dispatchPlaytime, plies)) {
    return decision;
  }
  const waitedDispatch = dispatchPlaytime + GO_ENGINE_CYCLE_MS;
  const waited = await finalizeForSeeds(
    prepared,
    goOpponentSeedCandidates(waitedDispatch, prepared.view.bonusCycles ?? 0),
    engine,
    waitedDispatch,
    options?.preferredFirstMove,
  );
  const waitedPlaying = waited.action.type !== "resume" && waited.action.type !== "newGame";
  if (rollout) {
    // Only a line that turns the loss into a win is worth the cycle.
    if (!waitedPlaying || !await rolloutWins(
      prepared.view, waited.action as GoPlayingAction, engine, waitedDispatch, plies)) {
      return decision;
    }
    return { ...waited, dispatchOffsetMs: GO_ENGINE_CYCLE_MS };
  }
  if (waited.predictedWin === undefined
    || waited.predictedWin < decision.predictedWin! + wait.minimumGain) {
    return decision;
  }
  return { ...waited, dispatchOffsetMs: GO_ENGINE_CYCLE_MS };
}

/** Materialize the exact public successor positions for the selected action.
 * Finalization has already prepared this candidate's opponent option spaces,
 * so this is a small memoized rules pass and performs no network work. */
export function neuralGoContinuations(
  prepared: GoNeuralPrepared,
  seeds: readonly number[],
  decision: GoDecision,
  dispatchPlaytime?: number,
): GoNeuralContinuation[] {
  if (decision.action.type === "resume" || decision.action.type === "newGame") return [];
  // The 19x19 cheat path deliberately spends two sequential proposal passes
  // and stops.
  // Reconstructing White's large-board option space here would put the same
  // expensive work back onto the critical path merely for speculation.
  const cheat = prepared.view.cheat;
  if (cheat?.candidateLimit === 0
    && dispatchPlaytime !== undefined
    && cheat.unlocked
    && goCheatSucceedsSafely(dispatchPlaytime, cheat.successByCount[cheat.count] ?? 0)) return [];
  const decisionAction = decision.action;
  const selected: GoNeuralPreparedCandidate | undefined = decisionAction.type === "move" || decisionAction.type === "pass"
    ? prepared.candidates.find((candidate) => {
      if (candidate.action.type !== decisionAction.type) return false;
      return candidate.action.type === "pass"
        || (decisionAction.type === "move"
          && candidate.action.x === decisionAction.x
          && candidate.action.y === decisionAction.y);
    })
    : (() => {
      const played = applyGoCheat(prepared.view.board, decisionAction);
      return played ? {
        action: decisionAction,
        board: played.board,
        captures: played.captures,
        recordsHistory: false,
        terminal: false,
      } as GoNeuralPreparedCandidate : undefined;
    })();
  if (!selected || selected.terminal) return [];

  const { view } = prepared;
  const moveHistory = new Set(prepared.historyHashes);
  moveHistory.add(boardHash(view.board));
  const forecastHistory = [view.board.rows, ...(view.previousBoards ?? [])];
  selected.opponent ??= selected.recordsHistory
    ? prepareOpponentPosition(selected.board, view.opponent, forecastHistory, 0,
      moveHistory, prepared.opponentPredictionCache)
    : prepareOpponentPosition(selected.board, view.opponent, view.previousBoards ?? [],
      selected.action.type === "pass" ? (view.consecutivePasses ?? 0) + 1 : 0,
      prepared.historyHashes,
      prepared.opponentPredictionCache);

  const replyHistory = selected.recordsHistory ? moveHistory : prepared.historyHashes;
  const continuations: GoNeuralContinuation[] = [];
  for (const seed of seeds) {
    const forecast = predictPreparedOpponentReplies(selected.opponent, seed);
    for (const reply of forecast.replies) {
      const previousBoards = [...view.previousBoards];
      if (selected.recordsHistory) previousBoards.unshift(view.board.rows);
      const white = reply.move
        ? playMove(selected.board, reply.move.x, reply.move.y, "O", replyHistory)
        : undefined;
      if (white) previousBoards.unshift(selected.board.rows);
      const candidatePasses = selected.action.type === "pass"
        ? (view.consecutivePasses ?? 0) + 1 : 0;
      const consecutivePasses = reply.move ? 0 : candidatePasses + 1;
      const timing = dispatchPlaytime === undefined ? undefined
        : nextGoTurnTiming(dispatchPlaytime, view.bonusCycles ?? 0, reply.wait);
      const usedCheat = selected.action.type !== "move" && selected.action.type !== "pass";
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
          ...(timing ? { bonusCycles: timing.bonusCycles } : {}),
          ...(view.cheat ? { cheat: {
            ...view.cheat,
            count: view.cheat.count + (usedCheat ? 1 : 0),
          } } : {}),
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
  dispatchPlaytime?: number,
  options?: GoFinalizeOptions,
): Promise<GoDecision> {
  const prepared = prepareNeuralGoDecision(view);
  return finalizeNeuralGoDecision(prepared, seeds, engine, dispatchPlaytime, options);
}

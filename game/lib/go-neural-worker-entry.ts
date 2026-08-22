import {
  finalizeNeuralGoDecision,
  goModelProfile,
  GoNeuralEngine,
  neuralGoContinuations,
  prepareNeuralGoDecision,
  type GoNeuralContinuation,
  type GoNeuralPrepared,
} from "../../shared/strategy/go/neural/engine.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";
import {
  goNeuralPositionIdentity,
  goDispatchKey,
  type GoWorkerCertified,
  type GoWorkerEvaluation,
  type GoWorkerAction,
  type GoWorkerPlaybookRoute,
  type GoWorkerRequest,
  type GoWorkerResponse,
} from "../../shared/strategy/go/neural/worker-protocol.ts";
import {
  packCombinedBoard,
  validateMergedPlaybook,
  type MergedPlaybook,
} from "../../shared/strategy/go/playbook-facade.ts";
import {
  GO_ENGINE_CYCLE_MS,
  goOpponentSeedCandidates,
  nextGoTurnTiming,
  normalizeGoPlaytime,
} from "../../shared/strategy/go/rng.ts";
import type { GoDecision, GoView } from "../../shared/strategy/go/rules.ts";

interface WorkerPort {
  onmessage: ((event: { data: GoWorkerRequest }) => void) | null;
  postMessage(value: GoWorkerResponse): void;
}

interface CachedEvaluation {
  promise: Promise<GoWorkerEvaluation>;
  decision?: GoDecision;
  continuations?: GoNeuralContinuation[];
}

interface CachedPosition {
  canonical: string;
  prepared: GoNeuralPrepared;
  preparationMs: number;
  evaluations: Map<string, CachedEvaluation>;
  touched: number;
}

interface ActiveCommit {
  continuations: GoNeuralContinuation[];
  dispatchPlaytime: number;
  nextRolloverAt: number;
  expiry?: ReturnType<typeof setTimeout>;
}

const port = globalThis as unknown as WorkerPort;
let engine = new GoNeuralEngine((weights) => createRequiredWebGpuGoValueBackend(weights));
const positions = new Map<string, CachedPosition>();
const activeCommits = new Map<string, ActiveCommit>();
let touch = 0;
let generation = 0;
let resetting = false;
let predictionEpoch = 0;
/** GoNeuralEngine deliberately reuses one packed-board scratch allocation per
 * profile. Serialize complete finalizations, not merely GPU submissions, so a
 * foreground request cannot overwrite a push-ahead job's queued input. The
 * prediction loop awaits each job before queuing its next seed, allowing a
 * newly arrived foreground request to take the next queue slot. */
let evaluationQueue: Promise<void> = Promise.resolve();
const MAX_POSITIONS = 8;
/** The AI's own work normally gives the worker several hundred milliseconds.
 * Five viable dispatch ticks cover the observed +0..+4 engine-cycle jitter
 * without evaluating ticks at which White cannot have finished yet. */
const FUTURE_DISPATCH_TICKS = 5;
/** A commit produces one bounded generation of predictions. This deadline is
 * only a circuit breaker for a paused/dead controller; normal work finishes
 * long before it. */
const PREDICTION_LIFETIME_MS = 10_000;
const PREDICTION_READY_AHEAD_MS = 75;

/** The build prepends the merged phase playbook as an inlined classic script
 * (its module form uses top-level await, which an IIFE worker bundle cannot
 * contain). A build without an installed playbook simply leaves these globals
 * undefined and every certified lookup reports a miss. */
let playbookResolved: MergedPlaybook | null | undefined;
async function mergedPlaybook(): Promise<MergedPlaybook | null> {
  if (playbookResolved !== undefined) return playbookResolved;
  const injected = globalThis as {
    __combinedPlaybook?: unknown;
    __combinedPlaybookReady?: Promise<unknown>;
  };
  await injected.__combinedPlaybookReady;
  playbookResolved = injected.__combinedPlaybook === undefined
    ? null
    : validateMergedPlaybook(injected.__combinedPlaybook);
  return playbookResolved;
}

async function certifiedPlaybookAction(
  positionId: string,
  dispatchPlaytime: number,
  credit: number,
): Promise<GoWorkerCertified | undefined> {
  const playbook = await mergedPlaybook();
  if (!playbook) return undefined;
  const position = positions.get(positionId);
  if (!position) throw new Error(`Go worker does not hold position ${positionId}`);
  const view = position.prepared.view;
  if (view.board.size !== playbook.BOARD_SIZE || !playbook.OPPONENTS.includes(view.opponent)) {
    return undefined;
  }
  const certified = playbook.certifiedAction(
    view.opponent,
    playbook.phaseNow(dispatchPlaytime),
    view.bonusCycles ?? 0,
    packCombinedBoard(view.board.rows),
    view.consecutivePasses ?? 0,
    credit,
    // GoView history is newest first; the certificate column is oldest first.
    [...view.previousBoards].reverse().map(packCombinedBoard),
  );
  if (!certified) return undefined;
  const described = certified.action;
  const action: GoWorkerCertified["action"] | undefined = described.kind === "move"
    ? { kind: "move", x: described.x, y: described.y }
    : described.kind === "sleep"
      ? { kind: "sleep", variant: described.variant }
      : described.kind === "pass" || described.kind === "align"
        ? { kind: described.kind }
        : undefined;
  if (!action) return undefined;
  return {
    action,
    alignmentCredit: certified.alignmentCredit,
    alignmentBoards: playbook.modelFor(view.opponent).alignmentBoards,
  };
}

async function playbookRoute(
  playtime: number,
  opponent: string,
): Promise<GoWorkerPlaybookRoute | undefined> {
  const playbook = await mergedPlaybook();
  if (!playbook || !playbook.OPPONENTS.includes(opponent)) return undefined;
  let route;
  try {
    route = playbook.selectRoot(playbook.phaseNow(playtime), opponent);
  } catch {
    return undefined;
  }
  if (!route || route.enemy !== opponent) return undefined;
  return {
    enemy: route.enemy,
    entryPhase: route.entryPhase,
    waits: route.waits,
    entryPlaytime: playtime + route.waits * GO_ENGINE_CYCLE_MS,
  };
}

function tickAt(commit: ActiveCommit, wallAt: number): number {
  if (wallAt < commit.nextRolloverAt) return commit.dispatchPlaytime;
  const cycles = 1 + Math.floor((wallAt - commit.nextRolloverAt) / GO_ENGINE_CYCLE_MS);
  return normalizeGoPlaytime(commit.dispatchPlaytime + cycles * GO_ENGINE_CYCLE_MS);
}

function nextTickWallAt(commit: ActiveCommit, wallAt: number): number {
  if (wallAt < commit.nextRolloverAt) return commit.nextRolloverAt;
  return commit.nextRolloverAt
    + (1 + Math.floor((wallAt - commit.nextRolloverAt) / GO_ENGINE_CYCLE_MS)) * GO_ENGINE_CYCLE_MS;
}

function responseMatches(
  expected: GoNeuralContinuation["response"],
  actual: Extract<GoWorkerRequest, { type: "confirm" }>["response"],
): boolean {
  return expected.type === "move"
    ? actual.type === "move" && expected.x === actual.x && expected.y === actual.y
    : actual.type !== "move";
}

async function waitUntil(wallAt: number): Promise<void> {
  const delay = wallAt - Date.now();
  if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

function takeActiveCommit(turnId: string): ActiveCommit | undefined {
  const active = activeCommits.get(turnId);
  if (!active) return undefined;
  activeCommits.delete(turnId);
  if (active.expiry !== undefined) clearTimeout(active.expiry);
  return active;
}

function clearActiveCommits(): void {
  for (const active of activeCommits.values()) {
    if (active.expiry !== undefined) clearTimeout(active.expiry);
  }
  activeCommits.clear();
}

function trimPositions(protectedId?: string): void {
  while (positions.size > MAX_POSITIONS) {
    const oldest = [...positions]
      .filter(([id]) => id !== protectedId)
      .sort((left, right) => left[1].touched - right[1].touched)[0];
    if (!oldest) return;
    positions.delete(oldest[0]);
    port.postMessage({ type: "evicted", positionId: oldest[0] });
  }
}

function install(view: GoView, requestedId?: string): { id: string; position: CachedPosition; cached: boolean } {
  const identity = goNeuralPositionIdentity(view);
  if (requestedId !== undefined && requestedId !== identity.id) {
    throw new Error(`Go position identity mismatch: ${requestedId} != ${identity.id}`);
  }
  const found = positions.get(identity.id);
  if (found && found.canonical === identity.canonical) {
    found.touched = ++touch;
    return { id: identity.id, position: found, cached: true };
  }
  const startedAt = performance.now();
  const position: CachedPosition = {
    canonical: identity.canonical,
    prepared: prepareNeuralGoDecision(view),
    preparationMs: performance.now() - startedAt,
    evaluations: new Map(),
    touched: ++touch,
  };
  positions.set(identity.id, position);
  trimPositions(identity.id);
  return { id: identity.id, position, cached: false };
}

/** The evaluation cache key. A certified preferred move forks the key exactly
 * like the dispatch tick does: it changes the decision without being part of
 * the position identity. */
function evaluationKey(dispatchPlaytime: number, preferredFirstMove?: { x: number; y: number }): string {
  const base = goDispatchKey(dispatchPlaytime);
  return preferredFirstMove ? `${base}|pf:${preferredFirstMove.x},${preferredFirstMove.y}` : base;
}

function evaluate(
  positionId: string,
  dispatchPlaytime: number,
  preferredFirstMove?: { x: number; y: number },
): CachedEvaluation {
  const position = positions.get(positionId);
  if (!position) throw new Error(`Go worker does not hold position ${positionId}`);
  position.touched = ++touch;
  const key = evaluationKey(dispatchPlaytime, preferredFirstMove);
  const found = position.evaluations.get(key);
  if (found) return found;
  const entry = {} as CachedEvaluation;
  const run = evaluationQueue.then(async () => {
    const startedAt = performance.now();
    const seeds = goOpponentSeedCandidates(dispatchPlaytime, position.prepared.view.bonusCycles ?? 0);
    const decision = await finalizeNeuralGoDecision(position.prepared, seeds, engine, dispatchPlaytime,
      preferredFirstMove ? { preferredFirstMove } : undefined);
    const backend = await engine.backendFor(position.prepared.view.board.size);
    entry.decision = decision;
    entry.continuations = neuralGoContinuations(position.prepared, seeds, decision, dispatchPlaytime);
    return {
      decision,
      opponentSeeds: seeds,
      preparationMs: position.preparationMs,
      finalizationMs: performance.now() - startedAt,
      modelProfile: goModelProfile(position.prepared.view.board.size),
      modelExtent: backend.extent,
      cached: false,
      pushed: false,
      continuations: entry.continuations.map(({ seed, probability, response, wait }) => ({
        seed, probability, response, wait,
      })),
    };
  });
  // A rejected evaluation must not stay in the cache: the dispatch-time seed
  // assurance would keep replaying the same failure for this position and seed
  // set forever, turning one transient GPU error into a permanently stuck game.
  entry.promise = run.catch((error: unknown) => {
    if (position.evaluations.get(key) === entry) position.evaluations.delete(key);
    throw error;
  });
  evaluationQueue = run.then(() => undefined, () => undefined);
  position.evaluations.set(key, entry);
  return entry;
}

function sameAction(
  left: Exclude<GoDecision["action"], { type: "resume" | "newGame" }>,
  right: GoWorkerAction,
): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "pass") return true;
  if (left.type === "cheatTwoMoves" && right.type === "cheatTwoMoves") {
    return left.x1 === right.x1 && left.y1 === right.y1 && left.x2 === right.x2 && left.y2 === right.y2;
  }
  return right.type !== "pass" && right.type !== "cheatTwoMoves"
    && "x" in left && left.x === right.x && left.y === right.y;
}

async function predictNextTurns(
  request: Extract<GoWorkerRequest, { type: "commit" }>,
  expectedGeneration: number,
  expectedEpoch: number,
): Promise<void> {
  const source = positions.get(request.positionId);
  if (!source) throw new Error(`committed position is missing for ${request.positionId}`);
  // A seeded evaluation lives under a forked key; the commit request carries
  // only the dispatch tick. When both a plain and a seeded evaluation exist for
  // the tick, the one whose settled decision matches the committed action is
  // the one that was dispatched.
  const dispatchKey = goDispatchKey(request.dispatchPlaytime);
  const tickEvaluations = [...(source?.evaluations ?? [])]
    .filter(([key]) => key === dispatchKey || key.startsWith(`${dispatchKey}|pf:`))
    .map(([, entry]) => entry);
  const evaluated = tickEvaluations.find((entry) => entry.decision !== undefined
    && entry.decision.action.type !== "resume" && entry.decision.action.type !== "newGame"
    && sameAction(entry.decision.action, request.action)) ?? tickEvaluations[0];
  if (!evaluated) throw new Error(`committed evaluation is missing for ${request.positionId}`);
  const committed = await evaluated.promise;
  if (committed.decision.action.type === "resume" || committed.decision.action.type === "newGame") {
    throw new Error(`committed V9 decision is ${committed.decision.action.type}`);
  }
  if (!sameAction(committed.decision.action, request.action)) {
    throw new Error(`committed action does not match V9 evaluation for ${request.positionId}`);
  }
  if (generation !== expectedGeneration || predictionEpoch !== expectedEpoch) return;
  const allContinuations = [...(evaluated.continuations ?? [])];
  const active: ActiveCommit = {
    continuations: allContinuations,
    dispatchPlaytime: request.dispatchPlaytime,
    nextRolloverAt: request.nextRolloverAt,
  };
  activeCommits.set(request.turnId, active);
  active.expiry = setTimeout(() => {
    if (activeCommits.get(request.turnId) !== active) return;
    activeCommits.delete(request.turnId);
    if (predictionEpoch === expectedEpoch) predictionEpoch++;
  }, PREDICTION_LIFETIME_MS);
  const deadline = request.dispatchWallAt + PREDICTION_LIFETIME_MS;
  const alternatives = allContinuations
    .filter((entry) => entry.view.status === "inProgress")
    .sort((left, right) => right.probability - left.probability);
  const selectedPositionIds = new Set<string>();
  for (const alternative of alternatives) {
    const identity = goNeuralPositionIdentity(alternative.view);
    selectedPositionIds.add(identity.id);
    if (selectedPositionIds.size >= 3) break;
  }

  const installedPositions = new Map<string, ReturnType<typeof install>>();
  const pathways = alternatives.flatMap((alternative) => {
    const identity = goNeuralPositionIdentity(alternative.view);
    if (!selectedPositionIds.has(identity.id)) return [];
    let position = installedPositions.get(identity.id);
    if (!position) {
      position = install(alternative.view);
      installedPositions.set(identity.id, position);
    }
    return [{
      alternative,
      position,
      timing: nextGoTurnTiming(
        request.dispatchPlaytime,
        source.prepared.view.bonusCycles ?? 0,
        alternative.wait,
      ),
    }];
  });

  const tasks: Array<{
    alternative: GoNeuralContinuation;
    positionId: string;
    dispatchPlaytime: number;
    startAt: number;
  }> = [];
  const scheduled = new Set<string>();
  for (const candidate of pathways) {
    const responseAt = request.dispatchWallAt + candidate.timing.responseWallMs;
    const firstLaterTickAt = nextTickWallAt(active, responseAt);
    for (let lateCycles = 0; lateCycles < FUTURE_DISPATCH_TICKS; lateCycles++) {
      const neededAt = lateCycles === 0
        ? responseAt
        : firstLaterTickAt + (lateCycles - 1) * GO_ENGINE_CYCLE_MS;
      const dispatchPlaytime = tickAt(active, neededAt);
      const key = `${candidate.position.id}|${goDispatchKey(dispatchPlaytime)}`;
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      const perPositionAllowance = candidate.alternative.view.board.size > 5 ? 75 : 15;
      const computeAllowance = perPositionAllowance * installedPositions.size;
      tasks.push({
        alternative: candidate.alternative,
        positionId: candidate.position.id,
        dispatchPlaytime,
        startAt: neededAt - PREDICTION_READY_AHEAD_MS - computeAllowance,
      });
    }
  }
  tasks.sort((left, right) => left.startAt - right.startAt
    || right.alternative.probability - left.alternative.probability);

  // Wake only for viable future slots. Recompute the remaining timeout after
  // every wake rather than accumulating setInterval drift.
  for (const task of tasks) {
    await waitUntil(task.startAt);
    if (generation !== expectedGeneration || predictionEpoch !== expectedEpoch
      || Date.now() >= deadline) return;
    const value = await evaluate(task.positionId, task.dispatchPlaytime).promise;
    if (generation !== expectedGeneration || predictionEpoch !== expectedEpoch) return;
    port.postMessage({
      type: "predicted",
      prediction: {
        parentTurnId: request.turnId,
        positionId: task.positionId,
        dispatchPlaytime: task.dispatchPlaytime,
        response: task.alternative.response,
        value,
      },
    });
  }
}

port.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    if (resetting && request.type !== "reset") {
      // Prestige invalidation is intentionally fire-and-forget on the game
      // controller's synchronous reset hook. Let the first request from the
      // new world wait behind that reset instead of turning a harmless
      // lifecycle overlap into a failed Go tick.
      await evaluationQueue;
    }
    if (request.type === "install") {
      if (request.parentTurnId) {
        predictionEpoch++;
        takeActiveCommit(request.parentTurnId);
      }
      const installed = install(request.view, request.positionId);
      port.postMessage({
        type: "installed",
        requestId: request.requestId,
        positionId: installed.id,
        // A cache hit did no preparation work this turn. Reporting 0 would
        // read as "instantly prepared"; absence reads as "not measured here".
        ...(installed.cached ? {} : { preparationMs: installed.position.preparationMs }),
        cached: installed.cached,
      });
      return;
    }
    if (request.type === "evaluate") {
      const entry = evaluate(request.positionId, request.dispatchPlaytime, request.preferredFirstMove);
      const cached = entry.decision !== undefined;
      const value = await entry.promise;
      port.postMessage({
        type: "evaluated",
        requestId: request.requestId,
        positionId: request.positionId,
        dispatchPlaytime: request.dispatchPlaytime,
        value: { ...value, cached },
      });
      return;
    }
    if (request.type === "playbook") {
      const certified = await certifiedPlaybookAction(
        request.positionId,
        request.dispatchPlaytime,
        request.credit,
      );
      port.postMessage({
        type: "playbook",
        requestId: request.requestId,
        ...(certified ? { certified } : {}),
      });
      return;
    }
    if (request.type === "playbookRoute") {
      const route = await playbookRoute(request.playtime, request.opponent);
      port.postMessage({
        type: "playbookRoute",
        requestId: request.requestId,
        ...(route ? { route } : {}),
      });
      return;
    }
    if (request.type === "commit") {
      const expectedEpoch = ++predictionEpoch;
      clearActiveCommits();
      await predictNextTurns(request, generation, expectedEpoch);
      return;
    }
    if (request.type === "confirm") {
      // The steady-state board update is only White's compact response plus a
      // modulo clock confirmation. Select the internally derived successor
      // and stop all sibling work.
      predictionEpoch++;
      const committed = takeActiveCommit(request.turnId);
      const selected = committed?.continuations.find((continuation) =>
        responseMatches(continuation.response, request.response)
        && goNeuralPositionIdentity(continuation.view).id === request.positionId);
      if (!committed || !selected) {
        port.postMessage({
          type: "desynced",
          turnId: request.turnId,
          message: `AI response did not produce ${request.positionId}`,
        });
        return;
      }
      install(selected.view, request.positionId);
      // Timer throttling changes which prepared tick is consumed; it does not
      // require a board resync. The next commit replaces this clock anchor.
      const clockDrifted = tickAt(committed, request.observedAt) !== request.observedPlaytime;
      port.postMessage({
        type: "confirmed",
        turnId: request.turnId,
        positionId: request.positionId,
        clockDrifted,
        terminal: selected.view.status === "gameOver",
      });
      return;
    }
    if (resetting) throw new Error("V9 Go worker reset is already in progress");
    resetting = true;
    generation++;
    predictionEpoch++;
    const oldEngine = engine;
    const reset = evaluationQueue.then(async () => {
      // A failed teardown must not leave the worker holding a disposed engine
      // and a stale position cache: the successor game would then be evaluated
      // against dead GPU buffers and no later reset could recover.
      try {
        await oldEngine.dispose();
      } finally {
        engine = new GoNeuralEngine((weights) => createRequiredWebGpuGoValueBackend(weights));
        positions.clear();
        clearActiveCommits();
      }
    });
    evaluationQueue = reset.then(() => undefined, () => undefined);
    try {
      await reset;
    } finally {
      resetting = false;
    }
    port.postMessage({ type: "reset", requestId: request.requestId });
  })().catch((error: unknown) => {
    if (request.type === "commit" || request.type === "confirm") {
      takeActiveCommit(request.turnId);
      port.postMessage({
        type: "desynced",
        turnId: request.turnId,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      return;
    }
    port.postMessage({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  });
};

port.postMessage({ type: "ready" });

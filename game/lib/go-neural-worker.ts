import type { GoAction, GoView } from "../../shared/strategy/go/rules.ts";
import {
  goNeuralPositionIdentity,
  goDispatchKey,
  type GoWorkerCertified,
  type GoWorkerEvaluation,
  type GoWorkerOpponentResponse,
  type GoWorkerPlaybookRoute,
  type GoWorkerPrediction,
  type GoWorkerRequest,
  type GoWorkerResponse,
} from "../../shared/strategy/go/neural/worker-protocol.ts";
import { normalizeGoPlaytime } from "../../shared/strategy/go/rng.ts";
import { gameGlobal } from "./globals.ts";

interface BrowserWorker {
  postMessage(value: GoWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: GoWorkerResponse }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

interface BrowserWorkerConstructor {
  new(url: string): BrowserWorker;
}

interface BlobConstructor {
  new(parts: string[], options: { type: string }): object;
}

interface PendingRequest {
  resolve(value: GoWorkerResponse): void;
  reject(error: Error): void;
}

type GoWorkerRpcRequest =
  | { type: "install"; positionId: string; view: GoView; parentTurnId?: string }
  | { type: "evaluate"; positionId: string; dispatchPlaytime: number }
  | { type: "playbook"; positionId: string; dispatchPlaytime: number; credit: number }
  | { type: "playbookRoute"; playtime: number; opponent: string }
  | { type: "reset" };

export interface GoNeuralRuntime {
  install(view: GoView, parentTurnId?: string): Promise<{ positionId: string; preparationMs?: number; cached: boolean }>;
  evaluate(positionId: string, dispatchPlaytime: number, parentTurnId?: string): Promise<GoWorkerEvaluation>;
  /** Certified merged-playbook action for an installed position at an exact
   * dispatch tick, or undefined off the certified line (or with no playbook
   * embedded in this build). */
  playbook(positionId: string, dispatchPlaytime: number, credit: number): Promise<GoWorkerCertified | undefined>;
  /** Best certified root route for an opponent from an absolute engine tick. */
  playbookRoute(playtime: number, opponent: string): Promise<GoWorkerPlaybookRoute | undefined>;
  commit(
    positionId: string,
    dispatchPlaytime: number,
    dispatchWallAt: number,
    nextRolloverAt: number,
    action: Exclude<GoAction, { type: "resume" | "newGame" }>,
    sourceParentTurnId?: string,
  ): string;
  confirm(
    turnId: string,
    response: GoWorkerOpponentResponse,
    positionId: string,
    observedPlaytime: number,
    observedAt: number,
  ): void;
  reset(): Promise<void>;
  dispose(): void;
}

function embeddedWorkerSource(): string {
  if (typeof __GO_NEURAL_WORKER_SOURCE__ === "undefined" || !__GO_NEURAL_WORKER_SOURCE__) {
    throw new Error("V9 Go worker source was not embedded by the build");
  }
  return __GO_NEURAL_WORKER_SOURCE__;
}

class GoNeuralWorkerClient implements GoNeuralRuntime {
  #worker: BrowserWorker;
  #nextRequest = 1;
  #pending = new Map<number, PendingRequest>();
  #knownPositions = new Map<string, string>();
  #pushedPositions = new Map<string, Set<string>>();
  #predictions = new Map<string, GoWorkerPrediction>();
  #nextTurn = 1;
  #ready: Promise<void>;
  #readyResolve!: () => void;
  #failed?: Error;

  constructor() {
    const globals = globalThis as typeof globalThis & {
      Worker?: BrowserWorkerConstructor;
      Blob?: BlobConstructor;
      URL?: { createObjectURL(value: object): string; revokeObjectURL(url: string): void };
    };
    if (!globals.Worker || !globals.Blob || !globals.URL) {
      throw new Error("this Bitburner browser does not expose Blob WebWorkers");
    }
    this.#ready = new Promise((resolve) => { this.#readyResolve = resolve; });
    const url = globals.URL.createObjectURL(new globals.Blob(
      [embeddedWorkerSource()],
      { type: "text/javascript" },
    ));
    try {
      this.#worker = new globals.Worker(url) as unknown as BrowserWorker;
    } finally {
      globals.URL.revokeObjectURL(url);
    }
    this.#worker.onmessage = (event) => this.#receive(event.data);
    this.#worker.onerror = (event) => this.#fail(new Error(event.message ?? "V9 Go worker crashed"));
  }

  async install(view: GoView, parentTurnId?: string): Promise<{ positionId: string; preparationMs?: number; cached: boolean }> {
    const identity = goNeuralPositionIdentity(view);
    if (this.#knownPositions.get(identity.id) === identity.canonical) {
      if (parentTurnId) this.#acceptParent(parentTurnId, identity.id);
      return { positionId: identity.id, cached: true };
    }
    if (parentTurnId && this.#pushedPositions.get(identity.id)?.has(parentTurnId)) {
      this.#knownPositions.set(identity.id, identity.canonical);
      this.#acceptParent(parentTurnId, identity.id);
      return { positionId: identity.id, cached: true };
    }
    const response = await this.#request({
      type: "install",
      positionId: identity.id,
      view,
      ...(parentTurnId ? { parentTurnId } : {}),
    });
    if (response.type !== "installed") throw new Error(`unexpected Go worker response ${response.type}`);
    this.#knownPositions.set(identity.id, identity.canonical);
    if (parentTurnId) this.#finishParent(parentTurnId);
    return {
      positionId: response.positionId,
      ...(response.preparationMs === undefined ? {} : { preparationMs: response.preparationMs }),
      cached: response.cached,
    };
  }

  async evaluate(positionId: string, dispatchPlaytime: number, parentTurnId?: string): Promise<GoWorkerEvaluation> {
    if (parentTurnId) {
      const key = this.#predictionKey(parentTurnId, positionId, dispatchPlaytime);
      const pushed = this.#predictions.get(key);
      if (pushed) {
        this.#predictions.delete(key);
        return { ...pushed.value, cached: true, pushed: true };
      }
    }
    const response = await this.#request({
      type: "evaluate",
      positionId,
      dispatchPlaytime: normalizeGoPlaytime(dispatchPlaytime),
    });
    if (response.type !== "evaluated") throw new Error(`unexpected Go worker response ${response.type}`);
    return response.value;
  }

  async playbook(
    positionId: string,
    dispatchPlaytime: number,
    credit: number,
  ): Promise<GoWorkerCertified | undefined> {
    const response = await this.#request({
      type: "playbook",
      positionId,
      dispatchPlaytime: normalizeGoPlaytime(dispatchPlaytime),
      credit,
    });
    if (response.type !== "playbook") throw new Error(`unexpected Go worker response ${response.type}`);
    return response.certified;
  }

  async playbookRoute(playtime: number, opponent: string): Promise<GoWorkerPlaybookRoute | undefined> {
    const response = await this.#request({ type: "playbookRoute", playtime, opponent });
    if (response.type !== "playbookRoute") throw new Error(`unexpected Go worker response ${response.type}`);
    return response.route;
  }

  commit(
    positionId: string,
    dispatchPlaytime: number,
    dispatchWallAt: number,
    nextRolloverAt: number,
    action: Exclude<GoAction, { type: "resume" | "newGame" }>,
    sourceParentTurnId?: string,
  ): string {
    if (sourceParentTurnId) this.#finishParent(sourceParentTurnId);
    const turnId = `${__BUILD_ID__}:${this.#nextTurn++}`;
    if (this.#failed) return turnId;
    this.#worker.postMessage({
      type: "commit",
      turnId,
      positionId,
      dispatchPlaytime: normalizeGoPlaytime(dispatchPlaytime),
      dispatchWallAt,
      nextRolloverAt,
      action: action.type === "cheatTwoMoves"
        ? { type: action.type, x1: action.x1, y1: action.y1, x2: action.x2, y2: action.y2 }
        : action.type === "pass"
          ? { type: action.type }
          : { type: action.type, x: action.x, y: action.y },
    });
    return turnId;
  }

  confirm(
    turnId: string,
    response: GoWorkerOpponentResponse,
    positionId: string,
    observedPlaytime: number,
    observedAt: number,
  ): void {
    if (this.#failed) return;
    this.#worker.postMessage({
      type: "confirm",
      turnId,
      response,
      positionId,
      observedPlaytime: normalizeGoPlaytime(observedPlaytime),
      observedAt,
    });
  }

  async reset(): Promise<void> {
    // Drop the local mirror before the round trip. The worker clears its own
    // positions as part of this request, so a tick that starts while the
    // fire-and-forget prestige reset is still in flight must not be told its
    // position is already installed.
    this.#knownPositions.clear();
    this.#pushedPositions.clear();
    this.#predictions.clear();
    const response = await this.#request({ type: "reset" });
    if (response.type !== "reset") throw new Error(`unexpected Go worker response ${response.type}`);
  }

  dispose(): void {
    this.#worker.terminate();
    this.#fail(new Error("V9 Go worker disposed"));
  }

  async #request(request: GoWorkerRpcRequest): Promise<GoWorkerResponse> {
    await this.#ready;
    if (this.#failed) throw this.#failed;
    const requestId = this.#nextRequest++;
    const response = new Promise<GoWorkerResponse>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
    this.#worker.postMessage({ ...request, requestId } as GoWorkerRequest);
    return response;
  }

  #receive(response: GoWorkerResponse): void {
    if (response.type === "ready") {
      this.#readyResolve();
      return;
    }
    if (response.type === "evicted") {
      this.#knownPositions.delete(response.positionId);
      this.#pushedPositions.delete(response.positionId);
      for (const [key, prediction] of this.#predictions) {
        if (prediction.positionId === response.positionId) this.#predictions.delete(key);
      }
      return;
    }
    if (response.type === "predicted") {
      const { prediction } = response;
      const parents = this.#pushedPositions.get(prediction.positionId) ?? new Set<string>();
      parents.add(prediction.parentTurnId);
      this.#pushedPositions.set(prediction.positionId, parents);
      this.#predictions.set(this.#predictionKey(
        prediction.parentTurnId,
        prediction.positionId,
        prediction.dispatchPlaytime,
      ), prediction);
      return;
    }
    if (response.type === "confirmed") {
      if (response.terminal) {
        this.#finishParent(response.turnId);
        return;
      }
      this.#pruneParent(response.turnId, response.positionId);
      if (this.#knownPositions.has(response.positionId)) return;
      const parents = this.#pushedPositions.get(response.positionId) ?? new Set<string>();
      parents.add(response.turnId);
      this.#pushedPositions.set(response.positionId, parents);
      return;
    }
    if (response.type === "desynced") {
      // The worker and game disagreed about a derived successor. Discard the
      // entire local mirror so the next install necessarily transfers the
      // authoritative public view.
      this.#knownPositions.clear();
      this.#pushedPositions.clear();
      this.#predictions.clear();
      return;
    }
    if (response.type === "error" && response.requestId === undefined) return;
    const requestId = "requestId" in response ? response.requestId : undefined;
    if (requestId === undefined) return;
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    if (response.type === "error") pending.reject(new Error(response.message));
    else pending.resolve(response);
  }

  #fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = error;
    this.#readyResolve();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #predictionKey(parentTurnId: string, positionId: string, dispatchPlaytime: number): string {
    return `${parentTurnId}|${positionId}|${goDispatchKey(dispatchPlaytime)}`;
  }

  /** Retain only work for the confirmed successor until its first install. */
  #pruneParent(parentTurnId: string, positionId: string): void {
    for (const [id, parents] of this.#pushedPositions) {
      if (id === positionId) continue;
      parents.delete(parentTurnId);
      if (parents.size === 0) this.#pushedPositions.delete(id);
    }
    for (const [key, prediction] of this.#predictions) {
      if (prediction.parentTurnId === parentTurnId && prediction.positionId !== positionId) {
        this.#predictions.delete(key);
      }
    }
  }

  /** The public view proved which successor was reached. Its canonical value
   * is now known locally, so parent membership is no longer needed. */
  #acceptParent(parentTurnId: string, positionId: string): void {
    this.#pruneParent(parentTurnId, positionId);
    const parents = this.#pushedPositions.get(positionId);
    parents?.delete(parentTurnId);
    if (parents?.size === 0) this.#pushedPositions.delete(positionId);
  }

  #finishParent(parentTurnId: string): void {
    for (const [id, parents] of this.#pushedPositions) {
      parents.delete(parentTurnId);
      if (parents.size === 0) this.#pushedPositions.delete(id);
    }
    for (const [key, prediction] of this.#predictions) {
      if (prediction.parentTurnId === parentTurnId) this.#predictions.delete(key);
    }
  }
}

/** The page realm survives start.js restarts. Keep the worker—and therefore
 * its WebGPU device, weights, prepared positions, and pushed results—alive
 * when the same embedded build restarts. A new build deliberately replaces it
 * because its V9 artifact or protocol may have changed. */
export function goNeuralWorkerRuntime(): GoNeuralRuntime {
  const current = gameGlobal.goNeuralWorker;
  if (current?.buildId === __BUILD_ID__) return current.runtime;
  current?.runtime.dispose();
  const runtime = new GoNeuralWorkerClient();
  gameGlobal.goNeuralWorker = { buildId: __BUILD_ID__, runtime };
  return runtime;
}

export function resetGoNeuralWorkerRuntime(): void {
  const current = gameGlobal.goNeuralWorker;
  if (!current) return;
  // A crashed or wedged worker rejects every request forever, and the realm
  // cache would keep handing the same dead client to each successor game.
  // Drop it here so the next prestige rebuilds the worker instead.
  void current.runtime.reset().catch(() => {
    current.runtime.dispose();
    if (gameGlobal.goNeuralWorker === current) delete gameGlobal.goNeuralWorker;
  });
}

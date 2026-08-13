import type {
  GoWorkerRequest,
  GoWorkerResponse,
} from "../../shared/strategy/go/neural/worker-protocol.ts";
import { goNeuralPositionIdentity } from "../../shared/strategy/go/neural/worker-protocol.ts";
import type { GoView } from "../../shared/strategy/go/rules.ts";
import { GO_ENGINE_CYCLE_MS, nextGoTurnTiming } from "../../shared/strategy/go/rng.ts";

declare const __goWorkerSource: string;

interface WorkerSmokeResult {
  ok: boolean;
  profile?: string;
  extent?: number;
  action?: string;
  coldMs?: number;
  cachedMs?: number;
  cached?: boolean;
  pushed?: boolean;
  pushedMs?: number;
  pushedCachedMs?: number;
  readyAheadMs?: number;
  clockConfirmed?: boolean;
  desyncDetected?: boolean;
  reset?: boolean;
  error?: string;
}

type WorkerRpcRequest =
  | { type: "install"; positionId: string; view: GoView }
  | { type: "evaluate"; positionId: string; seeds: number[] }
  | { type: "reset" };

async function smokeWorker(): Promise<WorkerSmokeResult> {
  const url = URL.createObjectURL(new Blob([__goWorkerSource], { type: "text/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  let nextRequest = 1;
  const pending = new Map<number, {
    resolve(value: GoWorkerResponse): void;
    reject(error: Error): void;
  }>();
  const predictionWaiters = new Map<string, (response: Extract<GoWorkerResponse, { type: "predicted" }>) => void>();
  const confirmationWaiters = new Map<string, (response: Extract<GoWorkerResponse, { type: "confirmed" }>) => void>();
  const desyncWaiters = new Map<string, (response: Extract<GoWorkerResponse, { type: "desynced" }>) => void>();
  const ready = new Promise<void>((resolve, reject) => {
    worker.onerror = (event) => reject(new Error(event.message));
    worker.onmessage = (event: MessageEvent<GoWorkerResponse>) => {
      const response = event.data;
      if (response.type === "ready") {
        resolve();
        return;
      }
      if (response.type === "evicted") return;
      if (response.type === "predicted") {
        predictionWaiters.get(response.prediction.parentTurnId)?.(response);
        return;
      }
      if (response.type === "confirmed") {
        confirmationWaiters.get(response.turnId)?.(response);
        return;
      }
      if (response.type === "desynced") {
        desyncWaiters.get(response.turnId)?.(response);
        return;
      }
      if (!("requestId" in response) || response.requestId === undefined) return;
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      if (response.type === "error") request.reject(new Error(response.message));
      else request.resolve(response);
    };
  });
  const request = async (
    value: WorkerRpcRequest,
  ): Promise<GoWorkerResponse> => {
    await ready;
    const requestId = nextRequest++;
    const result = new Promise<GoWorkerResponse>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
    });
    worker.postMessage({ ...value, requestId } as GoWorkerRequest);
    return result;
  };
  try {
    const view: GoView = {
      board: { size: 5, rows: [".....", ".....", ".....", ".....", "....."] },
      currentPlayer: "Black",
      opponent: "Netburners",
      status: "inProgress",
      previousBoards: [],
      consecutivePasses: 0,
      komi: 1.5,
    };
    const positionId = goNeuralPositionIdentity(view).id;
    const installed = await request({ type: "install", positionId, view });
    if (installed.type !== "installed") throw new Error(`unexpected ${installed.type}`);
    const coldAt = performance.now();
    const evaluated = await request({ type: "evaluate", positionId, seeds: [10_200] });
    const coldMs = performance.now() - coldAt;
    if (evaluated.type !== "evaluated") throw new Error(`unexpected ${evaluated.type}`);
    const cachedAt = performance.now();
    const repeated = await request({ type: "evaluate", positionId, seeds: [10_200] });
    const cachedMs = performance.now() - cachedAt;
    if (repeated.type !== "evaluated") throw new Error(`unexpected ${repeated.type}`);
    const hint = evaluated.value.continuations[0];
    if (!hint) throw new Error("cold decision produced no continuation to precompute");
    const action = evaluated.value.decision.action;
    if (action.type !== "move" && action.type !== "pass") throw new Error(`unexpected ${action.type}`);
    const turnId = "worker-smoke:1";
    const timing = nextGoTurnTiming(10_000, 0, hint.wait);
    const dispatchWallAt = Date.now() - timing.responseWallMs + 250;
    const predicted = new Promise<Extract<GoWorkerResponse, { type: "predicted" }>>((resolve) => {
      predictionWaiters.set(turnId, resolve);
    });
    const pushedAt = performance.now();
    worker.postMessage({
      type: "commit",
      turnId,
      positionId,
      seeds: [10_200],
      dispatchPlaytime: 10_000,
      dispatchWallAt,
      nextRolloverAt: dispatchWallAt + GO_ENGINE_CYCLE_MS,
      bonusCycles: 0,
      action,
    } satisfies GoWorkerRequest);
    const pushed = await predicted;
    const pushedMs = performance.now() - pushedAt;
    const readyAheadMs = dispatchWallAt + timing.responseWallMs - Date.now();
    predictionWaiters.delete(turnId);
    const expectedResponseAt = dispatchWallAt + timing.responseWallMs;
    if (Date.now() < expectedResponseAt) {
      await new Promise<void>((resolve) => setTimeout(resolve, expectedResponseAt - Date.now()));
    }
    const confirmation = new Promise<Extract<GoWorkerResponse, { type: "confirmed" }>>((resolve) => {
      confirmationWaiters.set(turnId, resolve);
    });
    const predictedResponse = pushed.prediction.response;
    worker.postMessage({
      type: "confirm",
      turnId,
      response: predictedResponse.type === "move"
        ? predictedResponse
        : { type: "pass", x: null, y: null },
      positionId: pushed.prediction.positionId,
      observedPlaytime: pushed.prediction.dispatchPlaytime,
      observedAt: Date.now(),
    } satisfies GoWorkerRequest);
    const confirmed = await confirmation;
    confirmationWaiters.delete(turnId);
    const pushedCachedAt = performance.now();
    const pushedCached = await request({
      type: "evaluate",
      positionId: pushed.prediction.positionId,
      seeds: pushed.prediction.seeds,
    });
    const pushedCachedMs = performance.now() - pushedCachedAt;
    if (pushedCached.type !== "evaluated" || !pushedCached.value.cached) {
      throw new Error("pushed next-turn decision was not cache-ready");
    }
    const badTurnId = "worker-smoke:desync";
    const desynced = new Promise<Extract<GoWorkerResponse, { type: "desynced" }>>((resolve) => {
      desyncWaiters.set(badTurnId, resolve);
    });
    const badDispatchAt = Date.now();
    worker.postMessage({
      type: "commit",
      turnId: badTurnId,
      positionId,
      seeds: [10_200],
      dispatchPlaytime: 10_000,
      dispatchWallAt: badDispatchAt,
      nextRolloverAt: badDispatchAt + GO_ENGINE_CYCLE_MS,
      bonusCycles: 0,
      action,
    } satisfies GoWorkerRequest);
    worker.postMessage({
      type: "confirm",
      turnId: badTurnId,
      response: predictedResponse.type === "move"
        ? predictedResponse
        : { type: "pass", x: null, y: null },
      positionId: "deliberately-wrong-position",
      observedPlaytime: 10_000,
      observedAt: Date.now(),
    } satisfies GoWorkerRequest);
    await desynced;
    desyncWaiters.delete(badTurnId);
    // The game reset hook cannot await. Prove that a new-world install arriving
    // immediately behind reset is queued rather than rejected or allowed to
    // overlap disposal of the old WebGPU device.
    const resetPromise = request({ type: "reset" });
    const reinstallPromise = request({ type: "install", positionId, view });
    const [reset, reinstalled] = await Promise.all([resetPromise, reinstallPromise]);
    if (reset.type !== "reset") throw new Error(`unexpected ${reset.type}`);
    if (reinstalled.type !== "installed" || reinstalled.cached) {
      throw new Error("worker reset retained a prepared position");
    }
    const afterReset = await request({ type: "evaluate", positionId, seeds: [10_200] });
    if (afterReset.type !== "evaluated") throw new Error(`unexpected ${afterReset.type}`);
    return {
      ok: true,
      profile: repeated.value.modelProfile,
      extent: repeated.value.modelExtent,
      action: repeated.value.decision.action.type,
      coldMs,
      cachedMs,
      cached: repeated.value.cached,
      pushed: true,
      pushedMs,
      pushedCachedMs,
      readyAheadMs,
      clockConfirmed: !confirmed.clockDrifted,
      desyncDetected: true,
      reset: true,
    };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    worker.terminate();
  }
}

(globalThis as typeof globalThis & { __goWebGpuResult?: Promise<WorkerSmokeResult> })
  .__goWebGpuResult = smokeWorker();

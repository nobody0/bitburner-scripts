import type { GoView } from "../../shared/strategy/go/rules.ts";
import type { GoAction } from "../../shared/strategy/go/rules.ts";
import {
  finalizeNeuralGoDecision,
  goModelProfile,
  GoNeuralEngine,
  prepareNeuralGoDecision,
  neuralGoContinuations,
  type GoNeuralPrepared,
  type GoValueBackendFactory,
} from "../../shared/strategy/go/neural/engine.ts";
import { goNeuralPositionIdentity, type GoWorkerEvaluation } from "../../shared/strategy/go/neural/worker-protocol.ts";
import type { GoWorkerOpponentResponse } from "../../shared/strategy/go/neural/worker-protocol.ts";
import type { GoNeuralRuntime } from "../../game/lib/go-neural-worker.ts";

export class TestGoNeuralRuntime implements GoNeuralRuntime {
  readonly engine: GoNeuralEngine;
  readonly positions = new Map<string, GoNeuralPrepared>();
  #nextTurn = 1;

  constructor(factory: GoValueBackendFactory) {
    this.engine = new GoNeuralEngine(factory);
  }

  async install(view: GoView): Promise<{ positionId: string; preparationMs: number; cached: boolean }> {
    const positionId = goNeuralPositionIdentity(view).id;
    if (this.positions.has(positionId)) return { positionId, preparationMs: 0, cached: true };
    const startedAt = Date.now();
    this.positions.set(positionId, prepareNeuralGoDecision(view));
    return { positionId, preparationMs: Date.now() - startedAt, cached: false };
  }

  async evaluate(positionId: string, seeds: readonly number[]): Promise<GoWorkerEvaluation> {
    const prepared = this.positions.get(positionId);
    if (!prepared) throw new Error(`test Go runtime does not hold position ${positionId}`);
    const startedAt = Date.now();
    const decision = await finalizeNeuralGoDecision(prepared, seeds, this.engine);
    const backend = await this.engine.backendFor(prepared.view.board.size);
    return {
      decision,
      preparationMs: 0,
      finalizationMs: Date.now() - startedAt,
      modelProfile: goModelProfile(prepared.view.board.size),
      modelExtent: backend.extent,
      cached: false,
      pushed: false,
      continuations: neuralGoContinuations(prepared, seeds, decision)
        .map(({ seed, probability, response, wait }) => ({ seed, probability, response, wait })),
    };
  }

  commit(
    _positionId: string,
    _seeds: readonly number[],
    _dispatchPlaytime: number,
    _dispatchWallAt: number,
    _nextRolloverAt: number,
    _bonusCycles: number,
    _action: Extract<GoAction, { type: "move" | "pass" }>,
  ): string {
    return `test:${this.#nextTurn++}`;
  }

  confirm(
    _turnId: string,
    _response: GoWorkerOpponentResponse,
    _positionId: string,
    _observedPlaytime: number,
    _observedAt: number,
  ): void {}

  async reset(): Promise<void> {
    this.positions.clear();
    await this.engine.dispose();
  }

  dispose(): void {
    this.positions.clear();
    void this.engine.dispose();
  }
}

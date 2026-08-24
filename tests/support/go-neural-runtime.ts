import type { GoView } from "../../shared/strategy/go/rules.ts";
import type { GoAction } from "../../shared/strategy/go/rules.ts";
import {
  finalizeNeuralGoDecision,
  goModelProfile,
  GoNeuralEngine,
  prepareNeuralGoDecision,
  neuralGoContinuations,
  type GoFinalizeOptions,
  type GoNeuralPrepared,
  type GoValueBackendFactory,
} from "../../shared/strategy/go/neural/engine.ts";
import {
  goNeuralPositionIdentity,
  type GoWorkerCertified,
  type GoWorkerEvaluation,
  type GoWorkerPlaybookRoute,
} from "../../shared/strategy/go/neural/worker-protocol.ts";
import type { GoWorkerOpponentResponse } from "../../shared/strategy/go/neural/worker-protocol.ts";
import type { GoNeuralRuntime } from "../../game/lib/go-neural-worker.ts";
import { goOpponentSeedCandidates } from "../../shared/strategy/go/rng.ts";

export class TestGoNeuralRuntime implements GoNeuralRuntime {
  readonly engine: GoNeuralEngine;
  readonly positions = new Map<string, GoNeuralPrepared>();
  /** Optional finalize configuration a test pins for every evaluation, e.g.
   * a pass-when-lost trigger the stub backend's neutral value head would
   * otherwise veto. Absent, production per-profile defaults resolve. */
  finalizeOptions?: GoFinalizeOptions;
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

  async evaluate(positionId: string, dispatchPlaytime: number): Promise<GoWorkerEvaluation> {
    const prepared = this.positions.get(positionId);
    if (!prepared) throw new Error(`test Go runtime does not hold position ${positionId}`);
    const startedAt = Date.now();
    const seeds = goOpponentSeedCandidates(dispatchPlaytime, prepared.view.bonusCycles ?? 0);
    const decision = await finalizeNeuralGoDecision(
      prepared, seeds, this.engine, dispatchPlaytime, this.finalizeOptions);
    const backend = await this.engine.backendFor(prepared.view.board.size);
    return {
      decision,
      opponentSeeds: seeds,
      preparationMs: 0,
      finalizationMs: Date.now() - startedAt,
      modelProfile: goModelProfile(prepared.view.board.size),
      modelExtent: backend.extent,
      cached: false,
      pushed: false,
      continuations: neuralGoContinuations(prepared, seeds, decision, dispatchPlaytime)
        .map(({ seed, probability, response, wait }) => ({ seed, probability, response, wait })),
    };
  }

  /** Optional per-test certified-playbook stub; the default is playbook-less
   * (every lookup misses), matching a build without an installed playbook. */
  playbookStub?: (positionId: string, dispatchPlaytime: number, credit: number) => GoWorkerCertified | undefined;
  playbookRouteStub?: (playtime: number, opponent: string) => GoWorkerPlaybookRoute | undefined;

  async playbook(positionId: string, dispatchPlaytime: number, credit: number): Promise<GoWorkerCertified | undefined> {
    return this.playbookStub?.(positionId, dispatchPlaytime, credit);
  }

  async playbookRoute(playtime: number, opponent: string): Promise<GoWorkerPlaybookRoute | undefined> {
    return this.playbookRouteStub?.(playtime, opponent);
  }

  commit(
    _positionId: string,
    _dispatchPlaytime: number,
    _dispatchWallAt: number,
    _nextRolloverAt: number,
    _action: Exclude<GoAction, { type: "resume" | "newGame" }>,
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

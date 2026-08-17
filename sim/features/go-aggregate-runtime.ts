import type { GoNeuralRuntime } from "../../game/lib/go-neural-worker.ts";
import {
  prepareNeuralGoDecision,
  type GoNeuralPrepared,
} from "../../shared/strategy/go/neural/engine.ts";
import {
  goNeuralPositionIdentity,
  type GoWorkerCertified,
  type GoWorkerEvaluation,
  type GoWorkerOpponentResponse,
  type GoWorkerPlaybookRoute,
} from "../../shared/strategy/go/neural/worker-protocol.ts";
import { GO_REWARD_RULES } from "../../shared/strategy/go/rewards.ts";
import { goOpponentSeedCandidates } from "../../shared/strategy/go/rng.ts";
import type { GoAction, GoDecision, GoView } from "../../shared/strategy/go/rules.ts";

/** Fast controller-simulation runtime. It performs the exact immediate-state
 * transitions and legal-move enumeration, but deliberately does not pretend
 * to evaluate the V9 weights without WebGPU. GoSystem's aggregate endpoint
 * settles the selected game from the arena-calibrated profile. */
export class AggregateGoNeuralRuntime implements GoNeuralRuntime {
  readonly positions = new Map<string, GoNeuralPrepared>();
  #nextTurn = 1;

  async install(view: GoView): Promise<{ positionId: string; preparationMs: number; cached: boolean }> {
    const positionId = goNeuralPositionIdentity(view).id;
    const cached = this.positions.has(positionId);
    if (!cached) this.positions.set(positionId, prepareNeuralGoDecision(view));
    return { positionId, preparationMs: 0, cached };
  }

  async evaluate(positionId: string, dispatchPlaytime: number): Promise<GoWorkerEvaluation> {
    const prepared = this.positions.get(positionId);
    if (!prepared) throw new Error(`aggregate Go runtime does not hold position ${positionId}`);
    const decision = prepared.immediate ?? this.#legalAggregateDecision(prepared);
    const small = prepared.view.board.size <= 5;
    return {
      decision,
      backend: "aggregate",
      opponentSeeds: goOpponentSeedCandidates(dispatchPlaytime, prepared.view.bonusCycles ?? 0),
      preparationMs: 0,
      finalizationMs: 0,
      modelProfile: small ? "small5" : "daemon19",
      modelExtent: small ? 5 : 19,
      cached: true,
      pushed: false,
      continuations: [],
    };
  }

  /** The aggregate endpoint settles games from a calibrated profile rather
   * than walking certified lines, so it never holds a playbook. */
  async playbook(): Promise<GoWorkerCertified | undefined> {
    return undefined;
  }

  async playbookRoute(): Promise<GoWorkerPlaybookRoute | undefined> {
    return undefined;
  }

  commit(
    _positionId: string,
    _dispatchPlaytime: number,
    _dispatchWallAt: number,
    _nextRolloverAt: number,
    _action: Exclude<GoAction, { type: "resume" | "newGame" }>,
  ): string {
    return `aggregate:${this.#nextTurn++}`;
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
  }

  dispose(): void {
    this.positions.clear();
  }

  #legalAggregateDecision(prepared: GoNeuralPrepared): GoDecision {
    const profile = GO_REWARD_RULES[prepared.view.opponent];
    const candidate = prepared.candidates.find((entry) => entry.action.type === "move")
      ?? prepared.candidates.at(-1);
    if (!candidate) throw new Error("aggregate Go position has no move or pass candidate");
    if (candidate.action.type === "pass") {
      return {
        action: { type: "pass", why: "aggregate endpoint has no legal placement" },
        ranked: [],
        why: "aggregate arena-calibrated game",
        finalists: 1,
        positionValue: profile.priorWinProbability,
      };
    }
    if (candidate.action.type !== "move") {
      throw new Error(`aggregate Go candidate is ${candidate.action.type}`);
    }
    const { x, y } = candidate.action;
    return {
      action: { type: "move", x, y, why: "legal aggregate-endpoint trigger" },
      ranked: [{
        x,
        y,
        score: profile.priorWinProbability,
        powerPerRound: profile.scoreFraction,
        captures: candidate.captures,
        why: "arena-calibrated aggregate result",
      }],
      why: "aggregate arena-calibrated game",
      finalists: 1,
      positionValue: profile.priorWinProbability,
      forecast: [],
    };
  }
}

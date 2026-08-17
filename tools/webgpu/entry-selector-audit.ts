/** Browser half of the complete V9 selector differential audit. */
import {
  finalizeNeuralGoDecision,
  GO_PROFILE_CANDIDATE_LIMITS,
  GoNeuralEngine,
  prepareNeuralGoDecision,
  selectV9ProposalFinalists,
  type GoModelProfile,
} from "../../shared/strategy/go/neural/engine.ts";
import type {
  GoProposalRaw,
  GoValueBackend,
  GoValueBatch,
} from "../../shared/strategy/go/neural/backend.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";
import { loadGoValueWeights } from "../../shared/strategy/go/neural/artifact.ts";
import { SMALL5_GO_MODEL } from "../../shared/strategy/go/neural/models/small5.ts";
import { DAEMON19_GO_MODEL } from "../../shared/strategy/go/neural/models/daemon19.ts";
import type { GoView } from "../../shared/strategy/go/rules.ts";

interface AuditCase {
  name: string;
  view: GoView;
  seeds: number[];
  dispatchPlaytime?: number;
}

class RecordingBackend implements GoValueBackend {
  readonly proposals: GoProposalRaw[] = [];

  constructor(readonly inner: GoValueBackend) {}
  get extent(): number { return this.inner.extent; }
  get behaviorFeatures(): number { return this.inner.behaviorFeatures; }
  evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    return this.inner.evaluateBatch(batch);
  }
  async evaluateProposal(batch: GoValueBatch): Promise<GoProposalRaw> {
    const result = await this.inner.evaluateProposal(batch);
    this.proposals.push({
      value: new Float32Array(result.value),
      moves: new Float32Array(result.moves),
    });
    return result;
  }
  dispose(): void { this.inner.dispose(); }
}

function actionKey(action: { type: string; [key: string]: unknown }): string {
  if (action.type === "move") return `move:${action.x},${action.y}`;
  if (action.type === "cheatTwoMoves") {
    return `cheatTwoMoves:${action.x1},${action.y1}:${action.x2},${action.y2}`;
  }
  if (action.type.startsWith("cheat")) return `${action.type}:${action.x},${action.y}`;
  return action.type;
}

async function main(): Promise<unknown> {
  const cases = (globalThis as { __goSelectorAuditCases?: AuditCase[] })
    .__goSelectorAuditCases ?? [];
  const backends: Record<GoModelProfile, RecordingBackend> = {
    small5: new RecordingBackend(await createRequiredWebGpuGoValueBackend(
      loadGoValueWeights(SMALL5_GO_MODEL))),
    daemon19: new RecordingBackend(await createRequiredWebGpuGoValueBackend(
      loadGoValueWeights(DAEMON19_GO_MODEL))),
  };
  const engine = new GoNeuralEngine((_weights, profile) => backends[profile]);
  const results: unknown[] = [];
  for (const auditCase of cases) {
    const profile: GoModelProfile = auditCase.view.board.size <= 5 ? "small5" : "daemon19";
    const backend = backends[profile];
    backend.proposals.length = 0;
    const prepared = prepareNeuralGoDecision(auditCase.view);
    const decision = await finalizeNeuralGoDecision(
      prepared, auditCase.seeds, engine, auditCase.dispatchPlaytime);
    const action = decision.action;
    const selected = action.type === "move"
      ? decision.ranked.find((move) => move.x === action.x && move.y === action.y)
      : undefined;
    let finalistMoves: number[] | undefined;
    if (!auditCase.view.cheat && backend.proposals[0]) {
      const area = backend.extent * backend.extent;
      const moveIndices = prepared.candidates.map((candidate) => candidate.action.type === "pass"
        ? area : candidate.action.type === "move"
          ? candidate.action.x * backend.extent + candidate.action.y : area);
      const requested = auditCase.view.candidateLimit === Number.POSITIVE_INFINITY
        ? prepared.candidates.length
        : auditCase.view.candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS[profile];
      const selected = selectV9ProposalFinalists(
        moveIndices, backend.proposals[0].moves, auditCase.seeds.length, area + 1, requested);
      finalistMoves = selected.finalists.map((index) => moveIndices[index]!);
    }
    results.push({
      name: auditCase.name,
      action: actionKey(decision.action),
      finalists: decision.finalists,
      finalistMoves,
      proposalPasses: backend.proposals.length,
      winProbability: selected?.score,
      powerPerRound: selected?.powerPerRound,
    });
  }
  await engine.dispose();
  return { ok: true, results };
}

declare global {
  // eslint-disable-next-line no-var
  var __goWebGpuResult: Promise<unknown>;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false,
  failures: [String(error)],
}));
export {};

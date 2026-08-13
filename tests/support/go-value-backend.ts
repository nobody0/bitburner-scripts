import type { GoV9Weights } from "../../shared/strategy/go/neural/artifact.ts";
import type {
  GoProposalRaw,
  GoValueBackend,
  GoValueBatch,
} from "../../shared/strategy/go/neural/backend.ts";

/** Test double for planner-only tests. It deliberately does not evaluate the
 * network: model correctness belongs to the Chromium/WGSL golden gate. */
export class StubGoValueBackend implements GoValueBackend {
  readonly extent: number;
  readonly behaviorFeatures: number;

  constructor(weights: GoV9Weights) {
    this.extent = weights.extent;
    this.behaviorFeatures = weights.behaviorFeatures;
  }

  evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    return Promise.resolve(new Float32Array(batch.count * 3));
  }

  evaluateProposal(batch: GoValueBatch): Promise<GoProposalRaw> {
    const candidates = this.extent * this.extent + 1;
    return Promise.resolve({
      value: new Float32Array(batch.count * 3),
      moves: new Float32Array(batch.count * candidates),
    });
  }

  dispose(): void {}
}

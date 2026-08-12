import type { GoValueWeights } from "../../shared/strategy/go/neural/artifact.ts";
import type {
  GoValueBackend,
  GoValueBatch,
} from "../../shared/strategy/go/neural/backend.ts";

/** Test double for planner-only tests. It deliberately does not evaluate the
 * network: model correctness belongs to the Chromium/WGSL golden gate. */
export class StubGoValueBackend implements GoValueBackend {
  readonly extent: number;

  constructor(weights: GoValueWeights) {
    this.extent = weights.extent;
  }

  evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    return Promise.resolve(new Float32Array(batch.count * 3));
  }

  dispose(): void {}
}

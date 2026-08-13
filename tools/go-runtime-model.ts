/** Tool-side bridge from a generated runtime artifact back to the trainer's
 * text checkpoint format. Native oracles and evaluators use this to test the
 * exact float32 values the WebGPU backend receives after storage decoding. */
import type { GoValueModelArtifact, GoValueWeights } from "../shared/strategy/go/neural/artifact.ts";
import { loadGoValueWeights } from "../shared/strategy/go/neural/artifact.ts";

function vector(values: Float32Array): string {
  return `${values.length} ${Array.from(values).join(" ")}`;
}

export function goRuntimeCheckpointText(artifact: GoValueModelArtifact): string {
  const weights: GoValueWeights = loadGoValueWeights(artifact);
  return [
    "bitburner-go-value-v7",
    `${weights.extent} ${weights.hidden} ${weights.opponentFeatures}`,
    vector(weights.w1),
    vector(weights.b1),
    vector(weights.w2),
    vector(weights.b2),
    vector(weights.conv),
    vector(weights.convBias),
    "",
  ].join("\n");
}

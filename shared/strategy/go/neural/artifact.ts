/** Compact runtime artifact for the V9 go-ai network.
 *
 * Full-precision checkpoints remain the training source of truth. The game
 * consumes the generated row-wise-int8 artifact and expands it once to the
 * float32 tensor layout used by WebGPU.
 */

export interface GoValueModelArtifact {
  format: "bitburner-go-runtime-v9";
  topology: "bitburner-go-value-v9";
  encoding: "q8-row-f16-bias-le" | "mixed-f16-policy-q8-value-le";
  /** Feature extent. Boards smaller than the extent are padded as offline. */
  extent: number;
  hidden: number;
  channels: number;
  residualBlocks: number;
  valueTower: number;
  behaviorFeatures: number;
  /** Exact rules-derived planes appended to the original eight inputs. */
  inputFeatures?: "tactical-v1";
  /** Zero is the dense value head; positive splits valueW1 at this rank. */
  valueRank: number;
  /** Optional low-rank whole-board correction added to point policy logits. */
  globalPolicyRank?: number;
  globalPolicyEncoding?: "f16-policy";
  /** Encoding-specific bytes in inference order, carried as base64. */
  weights: string;
  byteLength: number;
  /** Provenance recorded by the exporter; not used at runtime. */
  source: string;
  sourceSha256: string;
  factorSource?: string;
  factorSha256?: string;
  payloadSha256: string;
  /** Present only on a deployment derivative: a champion-SHA-bound transform
   * of the named champion checkpoint, never a new champion. Promotion
   * authority stays with the full-precision champion `.model` file.
   * `strip-neutral-value-v1` removes an exactly-zero value head, leaving the
   * policy tensors byte-identical; the loaded backend is policy-only.
   * `structured-distill-v1` marks a structurally compressed student whose
   * `source` checkpoint was distilled from the bound champion; its payload
   * decodes normally. */
  derivative?: {
    championSha256: string;
    transform: "strip-neutral-value-v1" | "structured-distill-v1";
  };
}

export const GO_VALUE_OUTPUTS = 3;

export interface GoV9Weights {
  topology: 9;
  extent: number;
  channels: number;
  residualBlocks: number;
  hidden: number;
  valueTower: number;
  behaviorFeatures: number;
  inputChannels: 8 | 16;
  valueRank: number;
  globalPolicyRank: number;
  /** "absent" when the artifact is a policy-only derivative whose value
   * tensors were stripped; the named value views below are zero-length. */
  valuePath: "trained" | "absent";
  /** All tensors in shader binding order. Named fields below are zero-copy
   * views into this allocation. */
  flat: Float32Array;
  stem: Float32Array;
  stemBias: Float32Array;
  residual: Float32Array;
  residualBias: Float32Array;
  conditioningW: Float32Array;
  conditioningB: Float32Array;
  valueW1: Float32Array;
  valueW1Right: Float32Array;
  valueB1: Float32Array;
  valueW2: Float32Array;
  valueB2: Float32Array;
  valueOutW: Float32Array;
  valueOutB: Float32Array;
  policyW: Float32Array;
  policyB: Float32Array;
  globalPolicyW1: Float32Array;
  globalPolicyB1: Float32Array;
  globalPolicyW2: Float32Array;
  globalPolicyB2: Float32Array;
  passW: Float32Array;
  passB: Float32Array;
}

function halfToFloat(half: number, scratch: DataView): number {
  const sign = (half & 0x8000) << 16;
  let exponent = (half >>> 10) & 0x1f;
  let mantissa = half & 0x3ff;
  let word: number;
  if (exponent === 0) {
    if (mantissa === 0) word = sign;
    else {
      exponent = 1;
      while ((mantissa & 0x400) === 0) { mantissa <<= 1; exponent--; }
      word = sign | ((exponent - 15 + 127) << 23) | ((mantissa & 0x3ff) << 13);
    }
  } else if (exponent === 0x1f) {
    word = sign | 0x7f800000 | (mantissa << 13);
  } else {
    word = sign | ((exponent - 15 + 127) << 23) | (mantissa << 13);
  }
  scratch.setUint32(0, word >>> 0, true);
  return scratch.getFloat32(0, true);
}

/** Decode the only supported deployment topology into float32 tensor views. */
export function loadGoValueWeights(artifact: GoValueModelArtifact): GoV9Weights {
  if (artifact.format !== "bitburner-go-runtime-v9"
    || artifact.topology !== "bitburner-go-value-v9"
    || (artifact.encoding !== "q8-row-f16-bias-le"
      && artifact.encoding !== "mixed-f16-policy-q8-value-le")) {
    throw new Error("unsupported Go model artifact; deployment requires V9 with a supported encoding");
  }
  const dimensions = [artifact.extent, artifact.hidden, artifact.channels,
    artifact.residualBlocks, artifact.valueTower, artifact.behaviorFeatures];
  if (dimensions.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("V9 artifact is missing valid topology dimensions");
  }
  if (artifact.channels % 4 !== 0 || artifact.hidden > 256 || artifact.valueTower > 256) {
    throw new Error("V9 artifact dimensions are incompatible with vectorized WebGPU execution");
  }
  const valueRank = artifact.valueRank;
  if (!Number.isSafeInteger(valueRank) || valueRank < 0
    || valueRank >= Math.min(artifact.hidden, artifact.channels * 25)) {
    throw new Error("V9 artifact has an invalid value rank");
  }
  const globalPolicyRank = artifact.globalPolicyRank ?? 0;
  if (!Number.isSafeInteger(globalPolicyRank) || globalPolicyRank < 0 || globalPolicyRank > 256) {
    throw new Error("V9 artifact has an invalid global policy rank");
  }
  const f16Policy = artifact.encoding === "mixed-f16-policy-q8-value-le";
  if (globalPolicyRank > 0 && (!f16Policy || artifact.globalPolicyEncoding !== "f16-policy")) {
    throw new Error("V9 global policy requires the f16 policy deployment encoding");
  }
  const inputChannels = artifact.inputFeatures === "tactical-v1" ? 16 : 8;
  if (artifact.inputFeatures !== undefined && artifact.inputFeatures !== "tactical-v1") {
    throw new Error("V9 artifact has unsupported input features");
  }
  const derivative = artifact.derivative;
  if (derivative !== undefined) {
    if (derivative.transform !== "strip-neutral-value-v1"
      && derivative.transform !== "structured-distill-v1") {
      throw new Error(`V9 artifact declares unknown derivative transform ${String(derivative.transform)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(derivative.championSha256)) {
      throw new Error("V9 derivative artifact must bind a champion SHA-256");
    }
    if (derivative.transform === "strip-neutral-value-v1" && valueRank !== 0) {
      throw new Error("a value-stripped derivative cannot also declare a value factorization");
    }
  }
  const stripValue = derivative?.transform === "strip-neutral-value-v1";
  const binary = atob(artifact.weights);
  if (binary.length !== artifact.byteLength) {
    throw new Error(`V9 artifact holds ${binary.length} bytes; metadata declares ${artifact.byteLength}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const halfScratch = new DataView(new ArrayBuffer(4));
  const { channels, residualBlocks, hidden, valueTower, behaviorFeatures } = artifact;
  const pooled = channels * 25;
  const parameterCount = channels * inputChannels * 9 + channels
    + residualBlocks * 2 * channels * channels * 9 + residualBlocks * 2 * channels
    + residualBlocks * channels * behaviorFeatures + residualBlocks * channels
    + (stripValue ? 0
      : (valueRank ? hidden * valueRank + valueRank * pooled : hidden * pooled)
        + hidden + valueTower * hidden + valueTower
        + GO_VALUE_OUTPUTS * valueTower + GO_VALUE_OUTPUTS)
    + channels + 1
    + (globalPolicyRank
      ? globalPolicyRank * pooled + globalPolicyRank
        + artifact.extent * artifact.extent * globalPolicyRank
        + artifact.extent * artifact.extent
      : 0)
    + pooled + 1;
  const flat = new Float32Array(parameterCount);
  let offset = 0;
  let outputOffset = 0;
  const takeQ8 = (rows: number, columns: number, name: string): Float32Array => {
    const count = rows * columns;
    const scales = offset + count;
    if (scales + rows * 4 > bytes.length) throw new Error(`truncated V9 ${name} tensor`);
    const result = flat.subarray(outputOffset, outputOffset + count);
    outputOffset += count;
    for (let row = 0; row < rows; row++) {
      const scale = view.getFloat32(scales + row * 4, true);
      if (!Number.isFinite(scale) || scale <= 0) throw new Error(`V9 ${name} tensor has an invalid scale`);
      for (let column = 0; column < columns; column++) {
        const byte = bytes[offset + row * columns + column]!;
        result[row * columns + column] = (byte < 128 ? byte : byte - 256) * scale;
      }
    }
    offset = scales + rows * 4;
    return result;
  };
  const takeF16 = (count: number, name: string): Float32Array => {
    if (offset + count * 2 > bytes.length) throw new Error(`truncated V9 ${name} tensor`);
    const result = flat.subarray(outputOffset, outputOffset + count);
    outputOffset += count;
    for (let index = 0; index < count; index++) {
      result[index] = halfToFloat(view.getUint16(offset, true), halfScratch);
      offset += 2;
    }
    return result;
  };
  const empty = (): Float32Array => flat.subarray(outputOffset, outputOffset);
  const result: GoV9Weights = {
    topology: 9,
    extent: artifact.extent,
    channels,
    residualBlocks,
    hidden,
    valueTower,
    behaviorFeatures,
    inputChannels,
    valueRank,
    globalPolicyRank,
    valuePath: stripValue ? "absent" : "trained",
    flat,
    stem: f16Policy ? takeF16(channels * inputChannels * 9, "stem")
      : takeQ8(channels, inputChannels * 9, "stem"),
    stemBias: takeF16(channels, "stem bias"),
    residual: f16Policy
      ? takeF16(residualBlocks * 2 * channels * channels * 9, "residual")
      : takeQ8(residualBlocks * 2 * channels, channels * 9, "residual"),
    residualBias: takeF16(residualBlocks * 2 * channels, "residual bias"),
    conditioningW: f16Policy
      ? takeF16(residualBlocks * channels * behaviorFeatures, "conditioning")
      : takeQ8(residualBlocks * channels, behaviorFeatures, "conditioning"),
    conditioningB: takeF16(residualBlocks * channels, "conditioning bias"),
    valueW1: stripValue ? empty() : takeQ8(hidden, valueRank || pooled, "value dense left"),
    valueW1Right: valueRank
      ? takeQ8(valueRank, pooled, "value dense right")
      : empty(),
    valueB1: stripValue ? empty() : takeF16(hidden, "value dense bias"),
    valueW2: stripValue ? empty() : takeQ8(valueTower, hidden, "value tower"),
    valueB2: stripValue ? empty() : takeF16(valueTower, "value tower bias"),
    valueOutW: stripValue ? empty() : takeQ8(GO_VALUE_OUTPUTS, valueTower, "value output"),
    valueOutB: stripValue ? empty() : takeF16(GO_VALUE_OUTPUTS, "value output bias"),
    policyW: f16Policy ? takeF16(channels, "point policy") : takeQ8(1, channels, "point policy"),
    policyB: takeF16(1, "point policy bias"),
    globalPolicyW1: globalPolicyRank
      ? takeF16(globalPolicyRank * pooled, "global policy context")
      : flat.subarray(outputOffset, outputOffset),
    globalPolicyB1: globalPolicyRank
      ? takeF16(globalPolicyRank, "global policy context bias")
      : flat.subarray(outputOffset, outputOffset),
    globalPolicyW2: globalPolicyRank
      ? takeF16(artifact.extent * artifact.extent * globalPolicyRank, "global policy output")
      : flat.subarray(outputOffset, outputOffset),
    globalPolicyB2: globalPolicyRank
      ? takeF16(artifact.extent * artifact.extent, "global policy output bias")
      : flat.subarray(outputOffset, outputOffset),
    passW: f16Policy ? takeF16(pooled, "pass policy") : takeQ8(1, pooled, "pass policy"),
    passB: takeF16(1, "pass policy bias"),
  };
  if (offset !== bytes.length) throw new Error(`V9 artifact has ${bytes.length - offset} trailing bytes`);
  if (outputOffset !== flat.length) throw new Error("V9 artifact tensor layout is internally inconsistent");
  return result;
}

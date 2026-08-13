/** Compact runtime artifact for the V9 go-ai network.
 *
 * Full-precision checkpoints remain the training source of truth. The game
 * consumes the generated row-wise-int8 artifact and expands it once to the
 * float32 tensor layout used by WebGPU.
 */

export interface GoValueModelArtifact {
  format: "bitburner-go-runtime-v9";
  topology: "bitburner-go-value-v9";
  encoding: "q8-row-f16-bias-le";
  /** Feature extent. Boards smaller than the extent are padded as offline. */
  extent: number;
  hidden: number;
  channels: number;
  residualBlocks: number;
  valueTower: number;
  behaviorFeatures: number;
  /** Zero is the dense value head; positive splits valueW1 at this rank. */
  valueRank: number;
  /** Encoding-specific bytes in inference order, carried as base64. */
  weights: string;
  byteLength: number;
  /** Provenance recorded by the exporter; not used at runtime. */
  source: string;
  sourceSha256: string;
  factorSource?: string;
  factorSha256?: string;
  payloadSha256: string;
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
  valueRank: number;
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
    || artifact.encoding !== "q8-row-f16-bias-le") {
    throw new Error("unsupported Go model artifact; deployment requires V9 q8-row-f16-bias-le");
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
  const parameterCount = channels * 8 * 9 + channels
    + residualBlocks * 2 * channels * channels * 9 + residualBlocks * 2 * channels
    + residualBlocks * channels * behaviorFeatures + residualBlocks * channels
    + (valueRank ? hidden * valueRank + valueRank * pooled : hidden * pooled)
    + hidden + valueTower * hidden + valueTower
    + GO_VALUE_OUTPUTS * valueTower + GO_VALUE_OUTPUTS
    + channels + 1 + pooled + 1;
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
  const result: GoV9Weights = {
    topology: 9,
    extent: artifact.extent,
    channels,
    residualBlocks,
    hidden,
    valueTower,
    behaviorFeatures,
    valueRank,
    flat,
    stem: takeQ8(channels, 8 * 9, "stem"),
    stemBias: takeF16(channels, "stem bias"),
    residual: takeQ8(residualBlocks * 2 * channels, channels * 9, "residual"),
    residualBias: takeF16(residualBlocks * 2 * channels, "residual bias"),
    conditioningW: takeQ8(residualBlocks * channels, behaviorFeatures, "conditioning"),
    conditioningB: takeF16(residualBlocks * channels, "conditioning bias"),
    valueW1: takeQ8(hidden, valueRank || pooled, "value dense left"),
    valueW1Right: valueRank
      ? takeQ8(valueRank, pooled, "value dense right")
      : flat.subarray(outputOffset, outputOffset),
    valueB1: takeF16(hidden, "value dense bias"),
    valueW2: takeQ8(valueTower, hidden, "value tower"),
    valueB2: takeF16(valueTower, "value tower bias"),
    valueOutW: takeQ8(GO_VALUE_OUTPUTS, valueTower, "value output"),
    valueOutB: takeF16(GO_VALUE_OUTPUTS, "value output bias"),
    policyW: takeQ8(1, channels, "point policy"),
    policyB: takeF16(1, "point policy bias"),
    passW: takeQ8(1, pooled, "pass policy"),
    passB: takeF16(1, "pass policy bias"),
  };
  if (offset !== bytes.length) throw new Error(`V9 artifact has ${bytes.length - offset} trailing bytes`);
  if (outputOffset !== flat.length) throw new Error("V9 artifact tensor layout is internally inconsistent");
  return result;
}

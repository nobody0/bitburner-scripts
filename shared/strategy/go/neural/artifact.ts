/** Compact runtime artifact for the go-ai v7 board-value network.
 *
 * The trainer's `.model` checkpoints stay in go-ai/ as full-precision text.
 * The game consumes a storage-optimized, generated artifact. Quantized values
 * are expanded once to the shader's float32 layout when a profile is first
 * used, so storage choices never add arithmetic to the per-turn forward pass.
 */

export interface GoValueModelArtifact {
  format: "bitburner-go-runtime-v1";
  topology: "bitburner-go-value-v7";
  encoding: "f16-le" | "q8-row-f16-bias-le";
  /** Feature extent. Boards smaller than the extent are padded as offline. */
  extent: number;
  /** Hidden tanh units in the dense value layer. */
  hidden: number;
  /** Opponent one-hot inputs and output heads; 0 means one shared head. */
  opponentFeatures: number;
  /** Encoding-specific bytes in inference order, carried as base64. */
  weights: string;
  byteLength: number;
  /** Provenance recorded by the exporter; not used at runtime. */
  source: string;
  sourceSha256: string;
  payloadSha256: string;
}

export const GO_SPATIAL_CHANNELS = 8;
export const GO_SPATIAL_POOL_EXTENT = 5;
export const GO_VALUE_OUTPUTS = 3;

export interface GoValueWeights {
  extent: number;
  hidden: number;
  opponentFeatures: number;
  headCount: number;
  /** Pooled spatial inputs plus the opponent one-hot. */
  denseInputSize: number;
  /** [channel][plane][dx+1][dy+1] exactly as the trainer indexes it. */
  conv: Float32Array;
  convBias: Float32Array;
  /** [hidden][denseInput] row-major. */
  w1: Float32Array;
  b1: Float32Array;
  /** [head*3+output][hidden] row-major. */
  w2: Float32Array;
  b2: Float32Array;
}

/** Tensor shapes for a v7 profile. The spatial trunk always pools to a fixed
 * 5x5 grid, so sizes depend on width and head count but never on the board
 * extent. */
export function goValueWeightSizes(hidden: number, opponentFeatures: number): {
  conv: number;
  convBias: number;
  w1: number;
  b1: number;
  w2: number;
  b2: number;
  denseInputSize: number;
  headCount: number;
} {
  const denseInputSize = GO_SPATIAL_CHANNELS * GO_SPATIAL_POOL_EXTENT * GO_SPATIAL_POOL_EXTENT
    + opponentFeatures;
  const headCount = Math.max(opponentFeatures, 1);
  return {
    conv: GO_SPATIAL_CHANNELS * 3 * 3 * 3,
    convBias: GO_SPATIAL_CHANNELS,
    w1: hidden * denseInputSize,
    b1: hidden,
    w2: headCount * GO_VALUE_OUTPUTS * hidden,
    b2: headCount * GO_VALUE_OUTPUTS,
    denseInputSize,
    headCount,
  };
}

/** Decode the artifact into typed weight views. The base64 source string is
 * not retained; callers should let the artifact module itself be the only
 * long-lived copy. */
export function loadGoValueWeights(artifact: GoValueModelArtifact): GoValueWeights {
  if (artifact.format !== "bitburner-go-runtime-v1" || artifact.topology !== "bitburner-go-value-v7") {
    throw new Error(`unsupported go value artifact format ${artifact.format}`);
  }
  const sizes = goValueWeightSizes(artifact.hidden, artifact.opponentFeatures);
  const binary = atob(artifact.weights);
  if (binary.length !== artifact.byteLength) throw new Error(
    `go value artifact holds ${binary.length} bytes; metadata declares ${artifact.byteLength}`,
  );
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  let offset = 0;
  const view = new DataView(bytes.buffer);
  const floatScratch = new DataView(new ArrayBuffer(4));
  const takeF16 = (count: number): Float32Array => {
    if (offset + count * 2 > bytes.length) throw new Error("go value artifact is truncated");
    const values = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      const half = view.getUint16(offset, true);
      offset += 2;
      const sign = (half & 0x8000) << 16;
      let exponent = (half >>> 10) & 0x1f;
      let mantissa = half & 0x3ff;
      let word: number;
      if (exponent === 0) {
        if (mantissa === 0) word = sign;
        else {
          exponent = 1;
          while ((mantissa & 0x400) === 0) {
            mantissa <<= 1;
            exponent--;
          }
          word = sign | ((exponent - 15 + 127) << 23) | ((mantissa & 0x3ff) << 13);
        }
      } else if (exponent === 0x1f) {
        word = sign | 0x7f800000 | (mantissa << 13);
      } else {
        word = sign | ((exponent - 15 + 127) << 23) | (mantissa << 13);
      }
      floatScratch.setUint32(0, word >>> 0, true);
      values[index] = floatScratch.getFloat32(0, true);
    }
    return values;
  };
  const takeQ8Rows = (rows: number, columns: number): Float32Array => {
    const count = rows * columns;
    const quantizedOffset = offset;
    const scaleOffset = quantizedOffset + count;
    const end = scaleOffset + rows * 4;
    if (end > bytes.length) throw new Error("go value artifact is truncated");
    offset = end;
    const values = new Float32Array(count);
    for (let row = 0; row < rows; row++) {
      const scale = view.getFloat32(scaleOffset + row * 4, true);
      if (!Number.isFinite(scale) || scale <= 0) throw new Error("go value artifact contains an invalid scale");
      const rowOffset = row * columns;
      for (let column = 0; column < columns; column++) {
        const byte = bytes[quantizedOffset + rowOffset + column]!;
        values[rowOffset + column] = (byte < 128 ? byte : byte - 256) * scale;
      }
    }
    return values;
  };
  let conv: Float32Array;
  let convBias: Float32Array;
  let w1: Float32Array;
  let b1: Float32Array;
  let w2: Float32Array;
  let b2: Float32Array;
  if (artifact.encoding === "f16-le") {
    conv = takeF16(sizes.conv);
    convBias = takeF16(sizes.convBias);
    w1 = takeF16(sizes.w1);
    b1 = takeF16(sizes.b1);
    w2 = takeF16(sizes.w2);
    b2 = takeF16(sizes.b2);
  } else if (artifact.encoding === "q8-row-f16-bias-le") {
    conv = takeQ8Rows(GO_SPATIAL_CHANNELS, 3 * 3 * 3);
    convBias = takeF16(sizes.convBias);
    w1 = takeQ8Rows(artifact.hidden, sizes.denseInputSize);
    b1 = takeF16(sizes.b1);
    w2 = takeQ8Rows(sizes.headCount * GO_VALUE_OUTPUTS, artifact.hidden);
    b2 = takeF16(sizes.b2);
  } else {
    throw new Error(`unsupported go value artifact encoding ${String(artifact.encoding)}`);
  }
  if (offset !== bytes.length) throw new Error(`go value artifact has ${bytes.length - offset} trailing bytes`);
  for (const values of [conv, convBias, w1, b1, w2, b2]) {
    for (const value of values) {
      if (!Number.isFinite(value)) throw new Error("go value artifact contains a non-finite weight");
    }
  }
  return {
    extent: artifact.extent,
    hidden: artifact.hidden,
    opponentFeatures: artifact.opponentFeatures,
    headCount: sizes.headCount,
    denseInputSize: sizes.denseInputSize,
    conv,
    convBias,
    w1,
    b1,
    w2,
    b2,
  };
}

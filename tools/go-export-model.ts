/** Export go-ai v7 checkpoints into compact runtime artifacts.
 *
 * Full-precision text checkpoints remain the training source of truth. The
 * generated game artifact reorders tensors for inference and stores them as
 * either float16 or symmetric row-wise int8 with float16 biases. Both formats
 * expand once to float32 before the unchanged WebGPU forward pass.
 *
 * Usage:
 *   bun run go:export [--encoding q8-row|f16] [--check]
 *   bun run tools/go-export-model.ts <checkpoint.model> <profile> [flags]
 */
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { GO_SPATIAL_CHANNELS, GO_VALUE_OUTPUTS, goValueWeightSizes } from "../shared/strategy/go/neural/artifact.ts";

const ROOT = join(import.meta.dir, "..");
const MODELS_DIR = join(ROOT, "shared", "strategy", "go", "neural", "models");

type StorageEncoding = "f16" | "q8-row";

interface Checkpoint {
  extent: number;
  hidden: number;
  opponentFeatures: number;
  w1: Float32Array;
  b1: Float32Array;
  w2: Float32Array;
  b2: Float32Array;
  conv: Float32Array;
  convBias: Float32Array;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseCheckpoint(text: string, source: string): Checkpoint {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  let cursor = 0;
  const next = () => {
    const token = tokens[cursor++];
    if (token === undefined) throw new Error(`${source}: truncated checkpoint`);
    return token;
  };
  const nextNumber = () => {
    const value = Number(next());
    if (!Number.isFinite(value)) throw new Error(`${source}: non-finite value at token ${cursor - 1}`);
    return value;
  };
  const magic = next();
  if (magic !== "bitburner-go-value-v7") throw new Error(`${source}: expected a v7 checkpoint, found ${magic}`);
  const extent = nextNumber();
  const hidden = nextNumber();
  const opponentFeatures = nextNumber();
  const vector = (expected: number, name: string) => {
    const count = nextNumber();
    if (count !== expected) throw new Error(`${source}: ${name} holds ${count} values; expected ${expected}`);
    return Float32Array.from({ length: count }, nextNumber);
  };
  const sizes = goValueWeightSizes(hidden, opponentFeatures);
  const checkpoint: Checkpoint = {
    extent,
    hidden,
    opponentFeatures,
    w1: vector(sizes.w1, "w1"),
    b1: vector(sizes.b1, "b1"),
    w2: vector(sizes.w2, "w2"),
    b2: vector(sizes.b2, "b2"),
    conv: vector(sizes.conv, "conv"),
    convBias: vector(sizes.convBias, "convBias"),
  };
  if (cursor !== tokens.length) throw new Error(`${source}: ${tokens.length - cursor} trailing tokens`);
  return checkpoint;
}

const FLOAT_SCRATCH = new ArrayBuffer(4);
const FLOAT_BITS = new Uint32Array(FLOAT_SCRATCH);
const FLOAT_VALUES = new Float32Array(FLOAT_SCRATCH);

function floatToHalf(value: number): number {
  FLOAT_VALUES[0] = value;
  const word = FLOAT_BITS[0]!;
  const sign = (word >>> 16) & 0x8000;
  const exponent = (word >>> 23) & 0xff;
  const mantissa = word & 0x7fffff;
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    const shifted = (mantissa | 0x800000) >>> (1 - halfExponent);
    return sign | ((shifted + 0xfff + ((shifted >>> 13) & 1)) >>> 13);
  }
  const rounded = mantissa + 0xfff + ((mantissa >>> 13) & 1);
  if (rounded & 0x800000) {
    const carried = halfExponent + 1;
    return carried >= 0x1f ? sign | 0x7c00 : sign | (carried << 10);
  }
  return sign | (halfExponent << 10) | (rounded >>> 13);
}

function runtimeTensors(checkpoint: Checkpoint): readonly Float32Array[] {
  return [checkpoint.conv, checkpoint.convBias, checkpoint.w1, checkpoint.b1, checkpoint.w2, checkpoint.b2];
}

function encodeF16(checkpoint: Checkpoint): Uint8Array {
  const count = runtimeTensors(checkpoint).reduce((sum, values) => sum + values.length, 0);
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const values of runtimeTensors(checkpoint)) {
    for (const value of values) {
      view.setUint16(offset, floatToHalf(value), true);
      offset += 2;
    }
  }
  return bytes;
}

function q8BlockBytes(rows: number, columns: number): number {
  return rows * columns + rows * 4;
}

function encodeQ8Rows(
  values: Float32Array,
  rows: number,
  columns: number,
  bytes: Uint8Array,
  offset: number,
): number {
  const view = new DataView(bytes.buffer);
  const scalesOffset = offset + values.length;
  for (let row = 0; row < rows; row++) {
    const rowOffset = row * columns;
    let maximum = 0;
    for (let column = 0; column < columns; column++) maximum = Math.max(maximum, Math.abs(values[rowOffset + column]!));
    const scale = Math.fround(maximum === 0 ? 1 : maximum / 127);
    view.setFloat32(scalesOffset + row * 4, scale, true);
    for (let column = 0; column < columns; column++) {
      const quantized = Math.max(-127, Math.min(127, Math.round(values[rowOffset + column]! / scale)));
      bytes[offset + rowOffset + column] = quantized & 0xff;
    }
  }
  return scalesOffset + rows * 4;
}

function encodeF16Block(values: Float32Array, bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer);
  for (const value of values) {
    view.setUint16(offset, floatToHalf(value), true);
    offset += 2;
  }
  return offset;
}

function encodeQ8(checkpoint: Checkpoint): Uint8Array {
  const sizes = goValueWeightSizes(checkpoint.hidden, checkpoint.opponentFeatures);
  const headRows = sizes.headCount * GO_VALUE_OUTPUTS;
  const byteLength = q8BlockBytes(GO_SPATIAL_CHANNELS, 27) + checkpoint.convBias.length * 2
    + q8BlockBytes(checkpoint.hidden, sizes.denseInputSize) + checkpoint.b1.length * 2
    + q8BlockBytes(headRows, checkpoint.hidden) + checkpoint.b2.length * 2;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  offset = encodeQ8Rows(checkpoint.conv, GO_SPATIAL_CHANNELS, 27, bytes, offset);
  offset = encodeF16Block(checkpoint.convBias, bytes, offset);
  offset = encodeQ8Rows(checkpoint.w1, checkpoint.hidden, sizes.denseInputSize, bytes, offset);
  offset = encodeF16Block(checkpoint.b1, bytes, offset);
  offset = encodeQ8Rows(checkpoint.w2, headRows, checkpoint.hidden, bytes, offset);
  offset = encodeF16Block(checkpoint.b2, bytes, offset);
  if (offset !== bytes.length) throw new Error(`internal artifact size mismatch: wrote ${offset}, allocated ${bytes.length}`);
  return bytes;
}

function generatedModule(
  checkpoint: Checkpoint,
  source: string,
  sourceText: string,
  profile: string,
  encoding: StorageEncoding,
): string {
  const bytes = encoding === "f16" ? encodeF16(checkpoint) : encodeQ8(checkpoint);
  const constant = `${profile.toUpperCase()}_GO_MODEL`;
  return `/** Generated by tools/go-export-model.ts from ${source}. Do not edit. */
import type { GoValueModelArtifact } from "../artifact.ts";

export const ${constant}: GoValueModelArtifact = {
  format: "bitburner-go-runtime-v1",
  topology: "bitburner-go-value-v7",
  encoding: "${encoding === "f16" ? "f16-le" : "q8-row-f16-bias-le"}",
  extent: ${checkpoint.extent},
  hidden: ${checkpoint.hidden},
  opponentFeatures: ${checkpoint.opponentFeatures},
  byteLength: ${bytes.length},
  source: ${JSON.stringify(source)},
  sourceSha256: "${sha256(sourceText)}",
  payloadSha256: "${sha256(bytes)}",
  weights:
    "${Buffer.from(bytes).toString("base64")}",
};
`;
}

async function exportModel(
  checkpointPath: string,
  profile: string,
  encoding: StorageEncoding,
  check: boolean,
): Promise<void> {
  const text = await Bun.file(checkpointPath).text();
  const source = relative(ROOT, checkpointPath);
  const checkpoint = parseCheckpoint(text, source);
  const module = generatedModule(checkpoint, source, text, profile, encoding);
  const target = join(MODELS_DIR, `${profile}.ts`);
  if (check) {
    const current = await Bun.file(target).text();
    if (current !== module) throw new Error(`${relative(ROOT, target)} is stale; run bun run go:export`);
  } else {
    await Bun.write(target, module);
  }
  console.log(`${check ? "checked" : "wrote"} ${source} -> ${relative(ROOT, target)} (${encoding}, ${checkpoint.extent}x${checkpoint.extent}, ${module.length} source bytes)`);
}

const rawArgs = Bun.argv.slice(2);
const check = rawArgs.includes("--check");
const encodingIndex = rawArgs.indexOf("--encoding");
const encodingArg = encodingIndex >= 0 ? rawArgs[encodingIndex + 1] : undefined;
if (encodingIndex >= 0 && encodingArg === undefined) throw new Error("--encoding requires f16 or q8-row");
if (encodingArg !== undefined && encodingArg !== "f16" && encodingArg !== "q8-row") {
  throw new Error("--encoding must be f16 or q8-row");
}
const positional = rawArgs.filter((argument, index) =>
  argument !== "--check" && argument !== "--encoding" && index !== encodingIndex + 1);
const defaults: readonly [string, string][] = [
  [join(ROOT, "go-ai", "small5-champion.model"), "small5"],
  [join(ROOT, "go-ai", "daemon19-champion.model"), "daemon19"],
];
const exports = positional.length
  ? [[positional[0]!, positional[1]!] as const]
  : defaults;
if (positional.length && (positional.length !== 2 || !/^[a-z][a-z0-9]*$/.test(positional[1]!))) {
  throw new Error("usage: bun run tools/go-export-model.ts <checkpoint.model> <profile-name> [--encoding f16|q8-row] [--check]");
}
for (const [checkpointPath, profile] of exports) {
  // The deployment corpora establish this per-profile choice. Row-wise int8
  // is neutral on small5 but loses World Daemon games; float16 preserves that
  // more sensitive profile while still halving its artifact.
  const encoding: StorageEncoding = encodingArg ?? (profile === "small5" ? "q8-row" : "f16");
  await exportModel(checkpointPath, profile, encoding, check);
}

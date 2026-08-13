/** Export promoted V9 checkpoints into the sole supported runtime artifact.
 *
 * Usage:
 *   bun run go:export [--check|--inspect]
 *   bun run go:export <checkpoint.model> <small5|daemon19> [--check|--inspect]
 */
import { createHash } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MODELS_DIR = join(ROOT, "shared", "strategy", "go", "neural", "models");

export type Profile = "small5" | "daemon19";

const PROFILE_POLICY = {
  // V9 is a parametric topology. small5 admits structurally distilled students
  // within the promoted champion's envelope; whole channel groups keep the
  // vectorized WebGPU shader exact and make the reduction operationally useful.
  small5: { extent: 5, behaviorFeatures: 31,
    maximum: { hidden: 256, channels: 32, residualBlocks: 4, valueTower: 64 },
    minimum: { hidden: 32, channels: 8, residualBlocks: 1, valueTower: 8 } },
  // 19x19 compression has not been proven yet, so retain its exact contract.
  daemon19: { extent: 19, behaviorFeatures: 30,
    maximum: { hidden: 256, channels: 48, residualBlocks: 8, valueTower: 64 },
    minimum: { hidden: 256, channels: 48, residualBlocks: 8, valueTower: 64 } },
} as const;

interface Checkpoint {
  extent: number;
  channels: number;
  residualBlocks: number;
  hidden: number;
  valueTower: number;
  behaviorFeatures: number;
  responseBranches: 13;
  stem: Float32Array;
  stemBias: Float32Array;
  residual: Float32Array;
  residualBias: Float32Array;
  conditioningW: Float32Array;
  conditioningB: Float32Array;
  valueW1: Float32Array;
  valueB1: Float32Array;
  valueW2: Float32Array;
  valueB2: Float32Array;
  valueOutW: Float32Array;
  valueOutB: Float32Array;
  policyW: Float32Array;
  policyB: Float32Array;
  passW: Float32Array;
  passB: Float32Array;
  branchW: Float32Array;
  branchB: Float32Array;
  passBranchW: Float32Array;
  passBranchB: Float32Array;
}

interface ValueFactor {
  rank: number;
  left: Float32Array;
  right: Float32Array;
  source: string;
  sourceText: string;
}

function usage(): string {
  return `Usage:
  bun run go:export
  bun run go:export --check
  bun run go:export --inspect
  bun run go:export <checkpoint.model> <small5|daemon19> [--check|--inspect]
    [--value-factor checkpoint.factor]

Only bitburner-go-value-v9 checkpoints are supported. Runtime storage is
q8-row-f16-bias-le and every installed artifact must pass the promotion
pipeline's champion-oracle and complete-game WebGPU gates.`;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseCheckpoint(text: string, source: string): Checkpoint {
  const tokens = text.split(/\s+/).filter(Boolean);
  let cursor = 0;
  const next = (): string => {
    const value = tokens[cursor++];
    if (value === undefined) throw new Error(`${source}: truncated V9 checkpoint`);
    return value;
  };
  const number = (): number => {
    const value = Number(next());
    if (!Number.isFinite(value)) throw new Error(`${source}: non-finite value at token ${cursor - 1}`);
    return value;
  };
  const magic = next();
  if (magic !== "bitburner-go-value-v9") {
    throw new Error(`${source}: unsupported checkpoint ${magic}; deployment requires bitburner-go-value-v9`);
  }
  const extent = number();
  const channels = number();
  const residualBlocks = number();
  const hidden = number();
  const valueTower = number();
  const behaviorFeatures = number();
  const responseBranches = number();
  for (const [name, value] of Object.entries({
    extent, channels, residualBlocks, hidden, valueTower, behaviorFeatures, responseBranches,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${source}: ${name} must be a positive integer`);
  }
  if (responseBranches !== 13) throw new Error(`${source}: V9 requires 13 response branches`);
  const vector = (expected: number, name: string): Float32Array => {
    const count = number();
    if (count !== expected) throw new Error(`${source}: ${name} holds ${count}; expected ${expected}`);
    return Float32Array.from({ length: count }, number);
  };
  const pooled = channels * 25;
  const checkpoint: Checkpoint = {
    extent, channels, residualBlocks, hidden, valueTower, behaviorFeatures, responseBranches,
    stem: vector(channels * 8 * 9, "stem"),
    stemBias: vector(channels, "stemBias"),
    residual: vector(residualBlocks * 2 * channels * channels * 9, "residual"),
    residualBias: vector(residualBlocks * 2 * channels, "residualBias"),
    conditioningW: vector(residualBlocks * channels * behaviorFeatures, "conditioningW"),
    conditioningB: vector(residualBlocks * channels, "conditioningB"),
    valueW1: vector(hidden * pooled, "valueW1"),
    valueB1: vector(hidden, "valueB1"),
    valueW2: vector(valueTower * hidden, "valueW2"),
    valueB2: vector(valueTower, "valueB2"),
    valueOutW: vector(3 * valueTower, "valueOutW"),
    valueOutB: vector(3, "valueOutB"),
    policyW: vector(channels, "policyW"),
    policyB: vector(1, "policyB"),
    passW: vector(pooled, "passW"),
    passB: vector(1, "passB"),
    branchW: vector(responseBranches * channels, "branchW"),
    branchB: vector(responseBranches, "branchB"),
    passBranchW: vector(responseBranches * pooled, "passBranchW"),
    passBranchB: vector(responseBranches, "passBranchB"),
  };
  if (cursor !== tokens.length) throw new Error(`${source}: ${tokens.length - cursor} trailing tokens`);
  return checkpoint;
}

function parseValueFactor(text: string, source: string, checkpoint: Checkpoint): ValueFactor {
  const tokens = text.split(/\s+/).filter(Boolean);
  let cursor = 0;
  const next = (): string => {
    const value = tokens[cursor++];
    if (value === undefined) throw new Error(`${source}: truncated value factor`);
    return value;
  };
  const number = (): number => {
    const value = Number(next());
    if (!Number.isFinite(value)) throw new Error(`${source}: non-finite value factor token`);
    return value;
  };
  if (next() !== "bitburner-go-value-factor-v1") throw new Error(`${source}: unsupported value factor`);
  const hidden = number(), pooled = number(), rank = number();
  if (hidden !== checkpoint.hidden || pooled !== checkpoint.channels * 25
    || !Number.isSafeInteger(rank) || rank <= 0 || rank >= Math.min(hidden, pooled)) {
    throw new Error(`${source}: value factor dimensions do not match the V9 checkpoint`);
  }
  const vector = (expected: number, name: string): Float32Array => {
    const count = number();
    if (count !== expected) throw new Error(`${source}: ${name} holds ${count}; expected ${expected}`);
    return Float32Array.from({ length: count }, number);
  };
  const left = vector(hidden * rank, "left factor");
  const right = vector(rank * pooled, "right factor");
  if (cursor !== tokens.length) throw new Error(`${source}: trailing value factor data`);
  let maximumError = 0;
  for (let row = 0; row < hidden; row++) for (let column = 0; column < pooled; column++) {
    let product = 0;
    for (let inner = 0; inner < rank; inner++) {
      product += left[row * rank + inner]! * right[inner * pooled + column]!;
    }
    maximumError = Math.max(maximumError,
      Math.abs(Math.fround(product) - checkpoint.valueW1[row * pooled + column]!));
  }
  if (maximumError > 2e-5) {
    throw new Error(`${source}: factors do not reconstruct checkpoint valueW1; max error ${maximumError}`);
  }
  return { rank, left, right, source, sourceText: text };
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

function q8BlockBytes(rows: number, columns: number): number {
  return rows * columns + rows * 4;
}

function encodeQ8Rows(values: Float32Array, rows: number, columns: number,
  bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer);
  const scalesOffset = offset + values.length;
  for (let row = 0; row < rows; row++) {
    const rowOffset = row * columns;
    let maximum = 0;
    for (let column = 0; column < columns; column++) {
      maximum = Math.max(maximum, Math.abs(values[rowOffset + column]!));
    }
    const scale = Math.fround(maximum === 0 ? 1 : maximum / 127);
    view.setFloat32(scalesOffset + row * 4, scale, true);
    for (let column = 0; column < columns; column++) {
      const quantized = Math.max(-127, Math.min(127,
        Math.round(values[rowOffset + column]! / scale)));
      bytes[offset + rowOffset + column] = quantized & 0xff;
    }
  }
  return scalesOffset + rows * 4;
}

function encodeF16(values: Float32Array, bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer);
  for (const value of values) {
    view.setUint16(offset, floatToHalf(value), true);
    offset += 2;
  }
  return offset;
}

/** Runtime tensors only. V9's response-branch head is an auxiliary training
 * objective; production resolves exact branches with the rules engine. */
type RuntimeBlock = readonly [Float32Array, number, number, Float32Array];

function blocks(checkpoint: Checkpoint, factor?: ValueFactor): readonly RuntimeBlock[] {
  const pooled = checkpoint.channels * 25;
  return [
    [checkpoint.stem, checkpoint.channels, 8 * 9, checkpoint.stemBias],
    [checkpoint.residual, checkpoint.residualBlocks * 2 * checkpoint.channels,
      checkpoint.channels * 9, checkpoint.residualBias],
    [checkpoint.conditioningW, checkpoint.residualBlocks * checkpoint.channels,
      checkpoint.behaviorFeatures, checkpoint.conditioningB],
    ...(factor ? [
      [factor.left, checkpoint.hidden, factor.rank, new Float32Array()] as const,
      [factor.right, factor.rank, pooled, checkpoint.valueB1] as const,
    ] : [[checkpoint.valueW1, checkpoint.hidden, pooled, checkpoint.valueB1] as const]),
    [checkpoint.valueW2, checkpoint.valueTower, checkpoint.hidden, checkpoint.valueB2],
    [checkpoint.valueOutW, 3, checkpoint.valueTower, checkpoint.valueOutB],
    [checkpoint.policyW, 1, checkpoint.channels, checkpoint.policyB],
    [checkpoint.passW, 1, pooled, checkpoint.passB],
  ];
}

function encode(checkpoint: Checkpoint, factor?: ValueFactor): Uint8Array {
  const tensors = blocks(checkpoint, factor);
  const bytes = new Uint8Array(tensors.reduce((sum, [, rows, columns, bias]) =>
    sum + q8BlockBytes(rows, columns) + bias.length * 2, 0));
  let offset = 0;
  for (const [values, rows, columns, bias] of tensors) {
    offset = encodeQ8Rows(values, rows, columns, bytes, offset);
    offset = encodeF16(bias, bytes, offset);
  }
  if (offset !== bytes.length) throw new Error("internal V9 artifact size mismatch");
  return bytes;
}

function generatedModule(checkpoint: Checkpoint, source: string, sourceText: string,
  profile: Profile, factor?: ValueFactor):
  { module: string; payload: Uint8Array; sourceSha: string; payloadSha: string } {
  const payload = encode(checkpoint, factor);
  const sourceSha = sha256(sourceText);
  const payloadSha = sha256(payload);
  const constant = `${profile.toUpperCase()}_GO_MODEL`;
  return {
    payload, sourceSha, payloadSha,
    module: `/** Generated by tools/go-export-model.ts from ${source}. Do not edit. */
import type { GoValueModelArtifact } from "../artifact.ts";

export const ${constant}: GoValueModelArtifact = {
  format: "bitburner-go-runtime-v9",
  topology: "bitburner-go-value-v9",
  encoding: "q8-row-f16-bias-le",
  extent: ${checkpoint.extent},
  hidden: ${checkpoint.hidden},
  channels: ${checkpoint.channels},
  residualBlocks: ${checkpoint.residualBlocks},
  valueTower: ${checkpoint.valueTower},
  behaviorFeatures: ${checkpoint.behaviorFeatures},
  valueRank: ${factor?.rank ?? 0},
  byteLength: ${payload.length},
  source: ${JSON.stringify(source)},
  sourceSha256: "${sourceSha}",
${factor ? `  factorSource: ${JSON.stringify(factor.source)},
  factorSha256: "${sha256(factor.sourceText)}",
` : ""}  payloadSha256: "${payloadSha}",
  weights:
    "${Buffer.from(payload).toString("base64")}",
};
`,
  };
}

async function checkedCheckpoint(checkpointPath: string, profile: Profile): Promise<{
  checkpoint: Checkpoint;
  source: string;
  sourceText: string;
}> {
  if (!await Bun.file(checkpointPath).exists()) throw new Error(`checkpoint ${checkpointPath} does not exist`);
  const sourceText = await Bun.file(checkpointPath).text();
  const source = relative(ROOT, checkpointPath);
  const checkpoint = parseCheckpoint(sourceText, source);
  const required = PROFILE_POLICY[profile];
  for (const key of ["extent", "behaviorFeatures"] as const) {
    if (checkpoint[key] !== required[key]) {
      throw new Error(`${source}: profile ${profile} requires ${key}=${required[key]}; checkpoint declares ${checkpoint[key]}`);
    }
  }
  for (const key of ["hidden", "channels", "residualBlocks", "valueTower"] as const) {
    if (checkpoint[key] < required.minimum[key] || checkpoint[key] > required.maximum[key]) {
      throw new Error(`${source}: profile ${profile} requires ${key} in `
        + `[${required.minimum[key]}, ${required.maximum[key]}]; checkpoint declares ${checkpoint[key]}`);
    }
  }
  if (checkpoint.channels % 4 !== 0) {
    throw new Error(`${source}: V9 WebGPU vectorized execution requires channels divisible by four`);
  }
  return { checkpoint, source, sourceText };
}

async function exportModel(checkpointPath: string, profile: Profile,
  mode: "write" | "check" | "inspect", factorPath?: string): Promise<void> {
  const { checkpoint, source, sourceText } = await checkedCheckpoint(checkpointPath, profile);
  if (factorPath && profile !== "small5") throw new Error("low-rank value export is proven for small5 only");
  const factor = factorPath ? parseValueFactor(
    await Bun.file(factorPath).text(), relative(ROOT, factorPath), checkpoint) : undefined;
  const generated = generatedModule(checkpoint, source, sourceText, profile, factor);
  const target = join(MODELS_DIR, `${profile}.ts`);
  if (mode === "check") {
    if (!await Bun.file(target).exists() || await Bun.file(target).text() !== generated.module) {
      throw new Error(`${relative(ROOT, target)} is stale; run bun run go:export`);
    }
  } else if (mode === "write") {
    const staged = `${target}.${process.pid}.tmp`;
    try {
      await Bun.write(staged, generated.module);
      renameSync(staged, target);
    } finally {
      rmSync(staged, { force: true });
    }
  }
  const parameterCount = blocks(checkpoint, factor).reduce((sum, [values,,, bias]) =>
    sum + values.length + bias.length, 0);
  console.log(`${mode === "write" ? "wrote" : mode === "check" ? "checked" : "inspected"} ${profile}: ${source} -> ${relative(ROOT, target)}`);
  console.log(`  topology: v9, extent ${checkpoint.extent}, channels ${checkpoint.channels}, residual blocks ${checkpoint.residualBlocks}, ${parameterCount.toLocaleString()} parameters`);
  console.log(factor
    ? `  storage: q8-row-f16-bias-le, value rank ${factor.rank}`
    : "  storage: q8-row-f16-bias-le (sole V9 deployment format)");
  console.log(`  size: ${generated.payload.length.toLocaleString()} payload bytes, ${generated.module.length.toLocaleString()} TypeScript bytes; ${(100 * (1 - generated.payload.length / (parameterCount * 4))).toFixed(1)}% below float32`);
  console.log(`  source sha256:  ${generated.sourceSha}`);
  if (factor) {
    console.log(`  factor source:  ${factor.source}`);
    console.log(`  factor sha256:  ${sha256(factor.sourceText)}`);
  }
  console.log(`  payload sha256: ${generated.payloadSha}`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const check = args.includes("--check");
  const inspect = args.includes("--inspect");
  if (check && inspect) throw new Error("--check and --inspect are mutually exclusive");
  const factorIndex = args.indexOf("--value-factor");
  const factorPath = factorIndex < 0 ? undefined : args[factorIndex + 1];
  if (factorIndex >= 0 && !factorPath) throw new Error("--value-factor requires a path");
  const positional = args.filter((argument, index) => argument !== "--check"
    && argument !== "--inspect" && argument !== "--value-factor"
    && (factorIndex < 0 || index !== factorIndex + 1));
  if (positional.length !== 0 && (positional.length !== 2
    || (positional[1] !== "small5" && positional[1] !== "daemon19"))) {
    throw new Error(usage());
  }
  const targets: readonly [string, Profile][] = positional.length
    ? [[positional[0]!, positional[1] as Profile]]
    : [
      [join(ROOT, "go-ai", "small5-champion.model"), "small5"],
      [join(ROOT, "go-ai", "daemon19-champion.model"), "daemon19"],
    ];
  const mode = inspect ? "inspect" : check ? "check" : "write";
  if (factorPath && !positional.length) throw new Error("--value-factor requires an explicit checkpoint and profile");
  for (const [checkpoint, profile] of targets) await exportModel(checkpoint, profile, mode, factorPath);
  if (inspect) console.log("\ninspection only: no files written; deployment still requires go:promote --apply");
  else if (!check) console.log("\nnext: bun run go:golden && bun run go:gpu");
}

if (import.meta.main) await main();

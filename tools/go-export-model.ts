/** Export promoted V9 checkpoints into the sole supported runtime artifact.
 *
 * Usage:
 *   bun run go:export [--check|--inspect]
 *   bun run go:export <checkpoint.model> <small5|daemon19> [--check|--inspect]
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MODELS_DIR = join(ROOT, "shared", "strategy", "go", "neural", "models");

/** Generated provenance is repository-relative and must be byte-stable across
 * Windows and POSIX hosts. */
function repositoryPath(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function normalizedText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export type Profile = "small5" | "daemon19";

const PROFILE_POLICY = {
  // V9 is a parametric topology. small5 admits structurally distilled students
  // within the promoted champion's envelope; whole channel groups keep the
  // vectorized WebGPU shader exact and make the reduction operationally useful.
  small5: { extent: 5, behaviorFeatures: 31,
    maximum: { hidden: 256, channels: 32, residualBlocks: 4, valueTower: 64 },
    minimum: { hidden: 32, channels: 8, residualBlocks: 1, valueTower: 8 } },
  // V9 runtime dimensions are checkpoint metadata, not profile constants.
  // Daemon19 uses the same vectorized kernel constraints as small5; promotion
  // remains arena-gated rather than being encoded as one historical shape.
  daemon19: { extent: 19, behaviorFeatures: 30,
    maximum: { hidden: 256, channels: 48, residualBlocks: 8, valueTower: 64 },
    minimum: { hidden: 32, channels: 8, residualBlocks: 1, valueTower: 8 } },
} as const;

interface Checkpoint {
  extent: number;
  channels: number;
  residualBlocks: number;
  hidden: number;
  valueTower: number;
  behaviorFeatures: number;
  responseBranches: 13;
  globalPolicyRank: number;
  inputChannels: 8 | 16;
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
  globalPolicyW1: Float32Array;
  globalPolicyB1: Float32Array;
  globalPolicyW2: Float32Array;
  globalPolicyB2: Float32Array;
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
    [--strip-neutral-value]
    [--output-module path.ts --constant EXPORTED_CONSTANT]

--strip-neutral-value emits a policy-only deployment derivative: it removes
the value head (refused unless every value tensor is exactly zero, keeping the
transform lossless) and binds the artifact to the source champion SHA. The
champion-default export and --check reproduce an installed derivative
automatically.

Only V9, global-policy, and tactical-global-policy checkpoints are supported. Runtime storage is
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
  if (magic !== "bitburner-go-value-v9"
    && magic !== "bitburner-go-value-v9-global-policy-v1"
    && magic !== "bitburner-go-value-v9-tactical-global-policy-v1") {
    throw new Error(`${source}: unsupported checkpoint ${magic}`);
  }
  const extent = number();
  const channels = number();
  const residualBlocks = number();
  const hidden = number();
  const valueTower = number();
  const behaviorFeatures = number();
  const responseBranches = number();
  const globalPolicyRank = magic !== "bitburner-go-value-v9" ? number() : 0;
  const inputChannels = magic === "bitburner-go-value-v9-tactical-global-policy-v1" ? 16 : 8;
  for (const [name, value] of Object.entries({
    extent, channels, residualBlocks, hidden, valueTower, behaviorFeatures, responseBranches,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${source}: ${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(globalPolicyRank) || globalPolicyRank < 0 || globalPolicyRank > 256) {
    throw new Error(`${source}: globalPolicyRank must be an integer in [0, 256]`);
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
    globalPolicyRank, inputChannels,
    stem: vector(channels * inputChannels * 9, "stem"),
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
    globalPolicyW1: globalPolicyRank
      ? vector(globalPolicyRank * pooled, "globalPolicyW1") : new Float32Array(),
    globalPolicyB1: globalPolicyRank
      ? vector(globalPolicyRank, "globalPolicyB1") : new Float32Array(),
    globalPolicyW2: globalPolicyRank
      ? vector(extent * extent * globalPolicyRank, "globalPolicyW2") : new Float32Array(),
    globalPolicyB2: globalPolicyRank
      ? vector(extent * extent, "globalPolicyB2") : new Float32Array(),
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
type RuntimeBlock = readonly [Float32Array, number, number, Float32Array, "q8" | "f16"];

function blocks(checkpoint: Checkpoint, factor?: ValueFactor,
  stripValue = false): readonly RuntimeBlock[] {
  const pooled = checkpoint.channels * 25;
  const policyStorage = checkpoint.globalPolicyRank ? "f16" : "q8";
  return [
    [checkpoint.stem, checkpoint.channels, checkpoint.inputChannels * 9,
      checkpoint.stemBias, policyStorage],
    [checkpoint.residual, checkpoint.residualBlocks * 2 * checkpoint.channels,
      checkpoint.channels * 9, checkpoint.residualBias, policyStorage],
    [checkpoint.conditioningW, checkpoint.residualBlocks * checkpoint.channels,
      checkpoint.behaviorFeatures, checkpoint.conditioningB, policyStorage],
    ...(stripValue ? [] : [
      ...(factor ? [
        [factor.left, checkpoint.hidden, factor.rank, new Float32Array(), "q8"] as const,
        [factor.right, factor.rank, pooled, checkpoint.valueB1, "q8"] as const,
      ] : [[checkpoint.valueW1, checkpoint.hidden, pooled, checkpoint.valueB1, "q8"] as const]),
      [checkpoint.valueW2, checkpoint.valueTower, checkpoint.hidden, checkpoint.valueB2, "q8"] as const,
      [checkpoint.valueOutW, 3, checkpoint.valueTower, checkpoint.valueOutB, "q8"] as const,
    ]),
    [checkpoint.policyW, 1, checkpoint.channels, checkpoint.policyB, policyStorage],
    ...(checkpoint.globalPolicyRank ? [
      [checkpoint.globalPolicyW1, checkpoint.globalPolicyRank, pooled,
        checkpoint.globalPolicyB1, "f16"] as const,
      [checkpoint.globalPolicyW2, checkpoint.extent * checkpoint.extent,
        checkpoint.globalPolicyRank, checkpoint.globalPolicyB2, "f16"] as const,
    ] : []),
    [checkpoint.passW, 1, pooled, checkpoint.passB, policyStorage],
  ];
}

/** The strip transform is lossless only for an exactly-zero value head. */
function requireNeutralValueHead(checkpoint: Checkpoint, source: string): void {
  const heads: readonly [string, Float32Array][] = [
    ["valueW1", checkpoint.valueW1], ["valueB1", checkpoint.valueB1],
    ["valueW2", checkpoint.valueW2], ["valueB2", checkpoint.valueB2],
    ["valueOutW", checkpoint.valueOutW], ["valueOutB", checkpoint.valueOutB],
  ];
  for (const [name, tensor] of heads) {
    for (const value of tensor) {
      if (value !== 0) {
        throw new Error(`${source}: --strip-neutral-value requires an exactly-zero value head; ${name} is nonzero`);
      }
    }
  }
}

function encode(checkpoint: Checkpoint, factor?: ValueFactor, stripValue = false): Uint8Array {
  const tensors = blocks(checkpoint, factor, stripValue);
  const bytes = new Uint8Array(tensors.reduce((sum, [values, rows, columns, bias, storage]) =>
    sum + (storage === "q8" ? q8BlockBytes(rows, columns) : values.length * 2)
      + bias.length * 2, 0));
  let offset = 0;
  for (const [values, rows, columns, bias, storage] of tensors) {
    offset = storage === "q8" ? encodeQ8Rows(values, rows, columns, bytes, offset)
      : encodeF16(values, bytes, offset);
    offset = encodeF16(bias, bytes, offset);
  }
  if (offset !== bytes.length) throw new Error("internal V9 artifact size mismatch");
  return bytes;
}

interface DerivativeMeta {
  championSha256: string;
  transform: "strip-neutral-value-v1" | "structured-distill-v1";
}

function generatedModule(checkpoint: Checkpoint, source: string, sourceText: string,
  profile: Profile, factor?: ValueFactor, constantOverride?: string, stripValue = false,
  derivative?: DerivativeMeta):
  { module: string; payload: Uint8Array; sourceSha: string; payloadSha: string } {
  const payload = encode(checkpoint, factor, stripValue);
  const sourceSha = sha256(sourceText);
  const payloadSha = sha256(payload);
  const constant = constantOverride ?? `${profile.toUpperCase()}_GO_MODEL`;
  if (!/^[A-Z][A-Z0-9_]*$/.test(constant)) {
    throw new Error(`invalid generated model constant ${JSON.stringify(constant)}`);
  }
  return {
    payload, sourceSha, payloadSha,
    module: `/** Generated by tools/go-export-model.ts from ${source}. Do not edit. */
import type { GoValueModelArtifact } from "../artifact.ts";

export const ${constant}: GoValueModelArtifact = {
  format: "bitburner-go-runtime-v9",
  topology: "bitburner-go-value-v9",
  encoding: "${checkpoint.globalPolicyRank
    ? "mixed-f16-policy-q8-value-le" : "q8-row-f16-bias-le"}",
  extent: ${checkpoint.extent},
  hidden: ${checkpoint.hidden},
  channels: ${checkpoint.channels},
  residualBlocks: ${checkpoint.residualBlocks},
  valueTower: ${checkpoint.valueTower},
  behaviorFeatures: ${checkpoint.behaviorFeatures},
${checkpoint.inputChannels === 16 ? `  inputFeatures: "tactical-v1",
` : ""}  valueRank: ${factor?.rank ?? 0},
${checkpoint.globalPolicyRank ? `  globalPolicyRank: ${checkpoint.globalPolicyRank},
  globalPolicyEncoding: "f16-policy",
` : ""}  byteLength: ${payload.length},
  source: ${JSON.stringify(source)},
  sourceSha256: "${sourceSha}",
${factor ? `  factorSource: ${JSON.stringify(factor.source)},
  factorSha256: "${sha256(factor.sourceText)}",
` : ""}${derivative ? `  derivative: {
    championSha256: "${derivative.championSha256}",
    transform: "${derivative.transform}",
  },
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
  const source = repositoryPath(checkpointPath);
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
  mode: "write" | "check" | "inspect", factorPath?: string,
  targetOverride?: string, constantOverride?: string, stripValue = false,
  derivativeOfPath?: string): Promise<void> {
  const { checkpoint, source, sourceText } = await checkedCheckpoint(checkpointPath, profile);
  if (factorPath && profile !== "small5") throw new Error("low-rank value export is proven for small5 only");
  if (factorPath && stripValue) throw new Error("--strip-neutral-value and --value-factor are mutually exclusive");
  if (stripValue && derivativeOfPath) {
    throw new Error("--strip-neutral-value and --derivative-of are mutually exclusive transforms");
  }
  if (stripValue) requireNeutralValueHead(checkpoint, source);
  let derivative: DerivativeMeta | undefined;
  if (stripValue) {
    derivative = { championSha256: sha256(sourceText), transform: "strip-neutral-value-v1" };
  } else if (derivativeOfPath) {
    if (!await Bun.file(derivativeOfPath).exists()) {
      throw new Error(`--derivative-of champion ${derivativeOfPath} does not exist`);
    }
    const championText = await Bun.file(derivativeOfPath).text();
    if (championText === sourceText) {
      throw new Error("--derivative-of expects a distilled student, not the champion itself");
    }
    derivative = { championSha256: sha256(championText), transform: "structured-distill-v1" };
  }
  const factor = factorPath ? parseValueFactor(
    await Bun.file(factorPath).text(), repositoryPath(factorPath), checkpoint) : undefined;
  const generated = generatedModule(
    checkpoint, source, sourceText, profile, factor, constantOverride, stripValue, derivative);
  const target = targetOverride
    ? (targetOverride.startsWith("/") ? targetOverride : join(ROOT, targetOverride))
    : join(MODELS_DIR, `${profile}.ts`);
  if (mode === "check") {
    if (!await Bun.file(target).exists()
      || normalizedText(await Bun.file(target).text()) !== normalizedText(generated.module)) {
      throw new Error(`${repositoryPath(target)} is stale; run bun run go:export`);
    }
  } else if (mode === "write") {
    mkdirSync(join(target, ".."), { recursive: true });
    const staged = `${target}.${process.pid}.tmp`;
    try {
      await Bun.write(staged, generated.module);
      renameSync(staged, target);
    } finally {
      rmSync(staged, { force: true });
    }
  }
  const parameterCount = blocks(checkpoint, factor, stripValue).reduce((sum, [values,,, bias]) =>
    sum + values.length + bias.length, 0);
  console.log(`${mode === "write" ? "wrote" : mode === "check" ? "checked" : "inspected"} ${profile}: ${source} -> ${repositoryPath(target)}`);
  console.log(`  topology: v9${checkpoint.globalPolicyRank ? ` global-policy rank ${checkpoint.globalPolicyRank}` : ""}${checkpoint.inputChannels === 16 ? " tactical-v1" : ""}, extent ${checkpoint.extent}, channels ${checkpoint.channels}, residual blocks ${checkpoint.residualBlocks}, ${parameterCount.toLocaleString()} parameters`);
  if (stripValue) {
    const fullCount = blocks(checkpoint, factor, false).reduce((sum, [values,,, bias]) =>
      sum + values.length + bias.length, 0);
    const fullBytes = encode(checkpoint, factor, false).length;
    console.log(`  derivative: strip-neutral-value-v1 removed ${(fullCount - parameterCount).toLocaleString()} `
      + `neutral value parameters (${(fullBytes - generated.payload.length).toLocaleString()} payload bytes); `
      + `policy tensors are byte-identical to the champion export`);
  } else if (derivative) {
    console.log(`  derivative: ${derivative.transform} bound to champion ${derivative.championSha256}`);
  }
  console.log(factor
    ? `  storage: q8-row-f16-bias-le, value rank ${factor.rank}`
    : checkpoint.globalPolicyRank
      ? "  storage: mixed f16 policy / q8 value"
      : "  storage: q8-row-f16-bias-le (sole V9 deployment format)");
  console.log(`  size: ${generated.payload.length.toLocaleString()} payload bytes, ${generated.module.length.toLocaleString()} TypeScript bytes; ${(100 * (1 - generated.payload.length / (parameterCount * 4))).toFixed(1)}% below float32`);
  console.log(`  source sha256:  ${generated.sourceSha}`);
  if (factor) {
    console.log(`  factor source:  ${factor.source}`);
    console.log(`  factor sha256:  ${sha256(factor.sourceText)}`);
  }
  console.log(`  payload sha256: ${generated.payloadSha}`);
}

interface InstalledDerivative {
  transform: "strip-neutral-value-v1" | "structured-distill-v1";
  source: string;
}

async function installedDerivative(target: string): Promise<InstalledDerivative | undefined> {
  if (!await Bun.file(target).exists()) return undefined;
  const text = await Bun.file(target).text();
  const transform = text.match(/transform: "(strip-neutral-value-v1|structured-distill-v1)"/)?.[1];
  if (!transform) return undefined;
  const source = text.match(/^ {2}source: ("(?:[^"\\]|\\.)*"),$/m)?.[1];
  if (!source) throw new Error(`${target}: derivative module does not record its source checkpoint`);
  return {
    transform: transform as InstalledDerivative["transform"],
    source: JSON.parse(source) as string,
  };
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
  const outputIndex = args.indexOf("--output-module");
  const outputModule = outputIndex < 0 ? undefined : args[outputIndex + 1];
  if (outputIndex >= 0 && !outputModule) throw new Error("--output-module requires a path");
  const constantIndex = args.indexOf("--constant");
  const constant = constantIndex < 0 ? undefined : args[constantIndex + 1];
  if (constantIndex >= 0 && !constant) throw new Error("--constant requires a name");
  if ((outputModule === undefined) !== (constant === undefined)) {
    throw new Error("--output-module and --constant must be supplied together");
  }
  const stripFlag = args.includes("--strip-neutral-value");
  const derivativeOfIndex = args.indexOf("--derivative-of");
  const derivativeOf = derivativeOfIndex < 0 ? undefined : args[derivativeOfIndex + 1];
  if (derivativeOfIndex >= 0 && !derivativeOf) throw new Error("--derivative-of requires a champion path");
  const consumed = new Set([factorIndex + 1, outputIndex + 1, constantIndex + 1,
    derivativeOfIndex + 1].filter((index) => index > 0));
  const positional = args.filter((argument, index) => argument !== "--check"
    && argument !== "--inspect" && argument !== "--value-factor"
    && argument !== "--output-module" && argument !== "--constant"
    && argument !== "--strip-neutral-value" && argument !== "--derivative-of"
    && !consumed.has(index));
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
  if ((factorPath || outputModule || stripFlag || derivativeOf) && !positional.length) {
    throw new Error("custom export options require an explicit checkpoint and profile");
  }
  for (const [checkpoint, profile] of targets) {
    // Champion-default exports must reproduce the installed transform: after a
    // derivative install, a plain re-export or --check would otherwise clobber
    // or reject the installed module. A strip derivative re-exports the
    // champion itself; a structured-distill derivative re-exports its retained
    // student checkpoint with the champion binding.
    let effectiveCheckpoint = checkpoint;
    let stripValue = positional.length ? stripFlag : false;
    let derivativeOfPath = positional.length ? derivativeOf : undefined;
    if (!positional.length) {
      const installed = await installedDerivative(join(MODELS_DIR, `${profile}.ts`));
      if (installed?.transform === "strip-neutral-value-v1") stripValue = true;
      else if (installed?.transform === "structured-distill-v1") {
        effectiveCheckpoint = join(ROOT, installed.source);
        derivativeOfPath = checkpoint;
      }
    }
    await exportModel(effectiveCheckpoint, profile, mode, factorPath, outputModule, constant,
      stripValue, derivativeOfPath);
  }
  if (inspect) console.log("\ninspection only: no files written; deployment still requires go:promote --apply");
  else if (!check) console.log("\nnext: bun run go:golden && bun run go:gpu");
}

if (import.meta.main) await main();

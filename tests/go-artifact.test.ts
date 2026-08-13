import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadGoValueWeights } from "../shared/strategy/go/neural/artifact.ts";
import { DAEMON19_GO_MODEL } from "../shared/strategy/go/neural/models/daemon19.ts";
import { SMALL5_GO_MODEL } from "../shared/strategy/go/neural/models/small5.ts";

const ROOT = join(import.meta.dir, "..");

function digest(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("generated Go runtime artifacts", () => {
  test("are current, provenance-pinned, and within the deployment budget", async () => {
    const check = Bun.spawnSync(["bun", "run", "tools/go-export-model.ts", "--check"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(check.stderr.toString()).toBe("");
    expect(check.exitCode).toBe(0);

    let encodedBytes = 0;
    for (const artifact of [SMALL5_GO_MODEL, DAEMON19_GO_MODEL]) {
      const source = await Bun.file(join(ROOT, artifact.source)).text();
      const payload = Uint8Array.from(atob(artifact.weights), (character) => character.charCodeAt(0));
      expect(artifact.sourceSha256).toBe(digest(source));
      expect(artifact.payloadSha256).toBe(digest(payload));
      expect(artifact.byteLength).toBe(payload.length);
      encodedBytes += artifact.weights.length;

      const weights = loadGoValueWeights(artifact);
      expect(weights.topology).toBe(9);
      expect(weights.stem.length).toBe(weights.channels * 8 * 3 * 3);
      expect(weights.valueW1.length).toBe(
        weights.hidden * (weights.valueRank || weights.channels * 25),
      );
      expect(weights.valueW1Right.length).toBe(weights.valueRank * weights.channels * 25);
      expect(weights.policyW.length).toBe(weights.channels);
    }
    expect(SMALL5_GO_MODEL.encoding).toBe("q8-row-f16-bias-le");
    expect(DAEMON19_GO_MODEL.encoding).toBe("q8-row-f16-bias-le");
    expect(encodedBytes).toBeLessThanOrEqual(1_360_000);
  });

  test("rejects damaged metadata instead of partially decoding", () => {
    expect(() => loadGoValueWeights({
      ...SMALL5_GO_MODEL,
      byteLength: SMALL5_GO_MODEL.byteLength + 1,
    })).toThrow("metadata declares");
    expect(() => loadGoValueWeights({
      ...SMALL5_GO_MODEL,
      weights: `${SMALL5_GO_MODEL.weights}AAAA`,
      byteLength: SMALL5_GO_MODEL.byteLength + 3,
    })).toThrow();
    expect(() => loadGoValueWeights({
      ...SMALL5_GO_MODEL,
      channels: 30,
    })).toThrow("incompatible with vectorized WebGPU");
    expect(() => loadGoValueWeights({
      ...SMALL5_GO_MODEL,
      valueRank: undefined as never,
    })).toThrow("invalid value rank");
  });

  test("rejects every non-V9 topology", () => {
    expect(() => loadGoValueWeights({
      format: "bitburner-go-runtime-v9",
      topology: "not-v9",
      encoding: "q8-row-f16-bias-le",
    } as unknown as typeof SMALL5_GO_MODEL)).toThrow("deployment requires V9");
  });

  test("decodes every runtime V9 proposal, behavior, and value tensor", () => {
    const chunks: number[] = [];
    const matrix = (rows: number, columns: number) => {
      chunks.push(...new Array(rows * columns).fill(0));
      for (let row = 0; row < rows; row++) chunks.push(0, 0, 128, 63);
    };
    const f16 = (count: number) => chunks.push(...new Array(count * 2).fill(0));
    const block = (rows: number, columns: number, biases: number) => {
      matrix(rows, columns); f16(biases);
    };
    block(4, 72, 4);       // stem
    block(8, 36, 8);       // one residual block
    block(4, 31, 4);       // behavior conditioning
    block(1, 100, 1);      // value dense
    block(1, 1, 1);        // value tower
    block(3, 1, 3);        // value outputs
    block(1, 4, 1);        // point policy
    block(1, 100, 1);      // pass policy
    const payload = Uint8Array.from(chunks);
    const weights = loadGoValueWeights({
      format: "bitburner-go-runtime-v9",
      topology: "bitburner-go-value-v9",
      encoding: "q8-row-f16-bias-le",
      extent: 5,
      hidden: 1,
      channels: 4,
      residualBlocks: 1,
      valueTower: 1,
      behaviorFeatures: 31,
      valueRank: 0,
      weights: Buffer.from(payload).toString("base64"),
      byteLength: payload.length,
      source: "synthetic",
      sourceSha256: "",
      payloadSha256: "",
    });
    expect(weights.topology).toBe(9);
    expect(weights.conditioningW.length).toBe(124);
    expect(weights.valueW1.length).toBe(100);
    expect(weights.policyW.length).toBe(4);
    expect(weights.passW.length).toBe(100);
  });

  test("decodes the V9 low-rank value layout without a dense compatibility path", () => {
    const chunks: number[] = [];
    const matrix = (rows: number, columns: number) => {
      chunks.push(...new Array(rows * columns).fill(0));
      for (let row = 0; row < rows; row++) chunks.push(0, 0, 128, 63);
    };
    const f16 = (count: number) => chunks.push(...new Array(count * 2).fill(0));
    const block = (rows: number, columns: number, biases: number) => {
      matrix(rows, columns); f16(biases);
    };
    block(4, 72, 4);
    block(8, 36, 8);
    block(4, 31, 4);
    block(2, 1, 0);       // left value factor
    block(1, 100, 2);     // right value factor and dense bias
    block(1, 2, 1);
    block(3, 1, 3);
    block(1, 4, 1);
    block(1, 100, 1);
    const payload = Uint8Array.from(chunks);
    const weights = loadGoValueWeights({
      format: "bitburner-go-runtime-v9",
      topology: "bitburner-go-value-v9",
      encoding: "q8-row-f16-bias-le",
      extent: 5,
      hidden: 2,
      channels: 4,
      residualBlocks: 1,
      valueTower: 1,
      behaviorFeatures: 31,
      valueRank: 1,
      weights: Buffer.from(payload).toString("base64"),
      byteLength: payload.length,
      source: "synthetic",
      sourceSha256: "",
      payloadSha256: "",
    });
    expect(weights.valueW1.length).toBe(2);
    expect(weights.valueW1Right.length).toBe(100);
    expect(weights.valueB1.length).toBe(2);
  });

  test("explains the automatic storage decision without writing", async () => {
    const target = join(ROOT, "shared/strategy/go/neural/models/small5.ts");
    const before = await Bun.file(target).text();
    const scratch = await mkdtemp(join(tmpdir(), "go-export-inspect-"));
    const candidate = join(scratch, "candidate.model");
    try {
      await Bun.write(candidate, Bun.file(join(ROOT, "go-ai/small5-champion.model")));
      const inspect = Bun.spawnSync([
        "bun", "run", "tools/go-export-model.ts",
        candidate, "small5", "--inspect",
      ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const output = inspect.stdout.toString();
      expect(inspect.exitCode).toBe(0);
      expect(inspect.stderr.toString()).toBe("");
      expect(output).toContain("storage: q8-row-f16-bias-le (sole V9 deployment format)");
      expect(output).toContain("payload bytes");
      expect(output).toContain("source sha256:");
      expect(output).toContain("payload sha256:");
      expect(output).toContain("inspection only: no files written");
      expect(await Bun.file(target).text()).toBe(before);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("rejects a checkpoint labeled as the wrong deployment profile", () => {
    const inspect = Bun.spawnSync([
      "bun", "run", "tools/go-export-model.ts",
      "go-ai/daemon19-champion.model", "small5", "--inspect",
    ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(inspect.exitCode).not.toBe(0);
    expect(inspect.stderr.toString()).toContain("profile small5 requires extent=5");
  });

  test("exports structurally compressed small5 V9 shapes", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "go-export-compressed-"));
    const candidate = join(scratch, "candidate.model");
    const factor = join(scratch, "candidate.factor");
    const vector = (count: number) => `${count} ${new Array(count).fill("0").join(" ")}\n`;
    const channels = 8, blocks = 1, hidden = 32, tower = 8, behavior = 31;
    const pooled = channels * 25;
    const tensors = [
      channels * 8 * 9, channels,
      blocks * 2 * channels * channels * 9, blocks * 2 * channels,
      blocks * channels * behavior, blocks * channels,
      hidden * pooled, hidden, tower * hidden, tower, 3 * tower, 3,
      channels, 1, pooled, 1, 13 * channels, 13, 13 * pooled, 13,
    ];
    try {
      await Bun.write(candidate,
        `bitburner-go-value-v9\n5 ${channels} ${blocks} ${hidden} ${tower} ${behavior} 13\n`
          + tensors.map(vector).join(""));
      const inspect = Bun.spawnSync([
        "bun", "run", "tools/go-export-model.ts", candidate, "small5", "--inspect",
      ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(inspect.exitCode).toBe(0);
      expect(inspect.stderr.toString()).toBe("");
      expect(inspect.stdout.toString()).toContain("channels 8, residual blocks 1");

      const rank = 4;
      await Bun.write(factor,
        `bitburner-go-value-factor-v1\n${hidden} ${pooled} ${rank}\n`
          + vector(hidden * rank) + vector(rank * pooled));
      const factorInspect = Bun.spawnSync([
        "bun", "run", "tools/go-export-model.ts", candidate, "small5", "--inspect",
        "--value-factor", factor,
      ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(factorInspect.exitCode).toBe(0);
      expect(factorInspect.stderr.toString()).toBe("");
      expect(factorInspect.stdout.toString()).toContain(`value rank ${rank}`);
      expect(factorInspect.stdout.toString()).toContain("factor source:");
      expect(factorInspect.stdout.toString()).toContain("factor sha256:");

      const left = new Array(hidden * rank).fill("0");
      const right = new Array(rank * pooled).fill("0");
      left[0] = "1";
      right[0] = "1";
      await Bun.write(factor,
        `bitburner-go-value-factor-v1\n${hidden} ${pooled} ${rank}\n`
          + `${left.length} ${left.join(" ")}\n${right.length} ${right.join(" ")}\n`);
      const mismatch = Bun.spawnSync([
        "bun", "run", "tools/go-export-model.ts", candidate, "small5", "--inspect",
        "--value-factor", factor,
      ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(mismatch.exitCode).not.toBe(0);
      expect(mismatch.stderr.toString()).toContain("do not reconstruct checkpoint valueW1");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

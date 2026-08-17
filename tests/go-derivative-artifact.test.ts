import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadGoValueWeights, type GoValueModelArtifact } from "../shared/strategy/go/neural/artifact.ts";
import { SMALL5_GO_MODEL } from "../shared/strategy/go/neural/models/small5.ts";

const ROOT = join(import.meta.dir, "..");

describe("policy-only deployment derivative", () => {
  test("the exporter refuses to strip a trained value head", () => {
    const result = Bun.spawnSync([
      "bun", "run", "tools/go-export-model.ts",
      "go-ai/small5-champion.model", "small5", "--strip-neutral-value", "--inspect",
    ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("exactly-zero value head");
  });

  test("a stripped daemon19 export round-trips as a champion-bound policy-only artifact", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "go-derivative-"));
    const module = join(scratch, "derivative.ts");
    try {
      const result = Bun.spawnSync([
        "bun", "run", "tools/go-export-model.ts",
        "go-ai/daemon19-champion.model", "daemon19", "--strip-neutral-value",
        "--output-module", module, "--constant", "DERIVATIVE_GO_MODEL",
      ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      const { DERIVATIVE_GO_MODEL } = await import(module) as {
        DERIVATIVE_GO_MODEL: GoValueModelArtifact;
      };
      expect(DERIVATIVE_GO_MODEL.derivative).toEqual({
        championSha256: DERIVATIVE_GO_MODEL.sourceSha256,
        transform: "strip-neutral-value-v1",
      });
      const weights = loadGoValueWeights(DERIVATIVE_GO_MODEL);
      expect(weights.valuePath).toBe("absent");
      expect(weights.valueW1.length).toBe(0);
      expect(weights.valueB1.length).toBe(0);
      expect(weights.valueW2.length).toBe(0);
      expect(weights.valueOutW.length).toBe(0);
      expect(weights.policyW.length).toBe(weights.channels);
      expect(weights.globalPolicyW2.length)
        .toBe(weights.extent * weights.extent * weights.globalPolicyRank);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("unknown derivative transforms are rejected before any decoding", () => {
    expect(() => loadGoValueWeights({
      ...SMALL5_GO_MODEL,
      derivative: { championSha256: "a".repeat(64), transform: "bogus" as never },
    })).toThrow("unknown derivative transform");
    expect(() => loadGoValueWeights({
      ...SMALL5_GO_MODEL,
      derivative: { championSha256: "not-a-sha", transform: "strip-neutral-value-v1" },
    })).toThrow("must bind a champion SHA-256");
  });
});

import { createHash } from "node:crypto";
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
      expect(weights.conv.length).toBe(8 * 3 * 3 * 3);
      expect(weights.w1.length).toBe(weights.hidden * weights.denseInputSize);
      expect(weights.w2.length).toBe(weights.headCount * 3 * weights.hidden);
    }
    expect(SMALL5_GO_MODEL.encoding).toBe("q8-row-f16-bias-le");
    expect(DAEMON19_GO_MODEL.encoding).toBe("f16-le");
    expect(encodedBytes).toBeLessThanOrEqual(112_000);
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
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runInHeadlessChrome } from "../tools/webgpu/chrome-runner.ts";

/** Executes the deployed WGSL shader — the code path that actually runs in
 * game — against native C++ trainer golden vectors. Bun has no WebGPU, so
 * this drives headless Chrome (Dawn, the
 * same WebGPU implementation family as Bitburner's Electron).
 * Missing Chrome or WebGPU is a gate failure, never a reason to silently skip
 * the only TypeScript inference implementation. */

describe("go WGSL shader", () => {
  test("matches the C++ golden vectors, batching, and capacity growth", async () => {
    const run = await runInHeadlessChrome(join(import.meta.dir, "..", "tools", "webgpu", "entry-golden.ts"), 180_000);
    const result = run.result as {
      ok: boolean;
      goldenCases: number;
      failures: string[];
      latency: Record<string, {
        requestToParsed: { p50: number; p95: number; max: number };
        mainThread: { p50: number; p95: number; max: number };
      }>;
      planning: {
        candidatePreparation: { p50: number; p95: number; max: number };
        replyPreparation: { p50: number; p95: number; max: number };
        boardToMove: { p50: number; p95: number; max: number };
      };
    };
    if (!result.ok) console.error("WebGPU gate details:", JSON.stringify(result, null, 2));
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.goldenCases).toBeGreaterThan(0);
    const daemon = result.latency["daemon19x400"]!;
    expect(daemon.mainThread.max).toBeLessThan(2);
    expect(daemon.requestToParsed.max).toBeLessThan(30);
    expect(result.planning.candidatePreparation.max).toBeLessThan(2);
    expect(result.planning.replyPreparation.max).toBeLessThan(2);
  }, 240_000);
});

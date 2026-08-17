import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runInHeadlessChrome } from "../tools/webgpu/chrome-runner.ts";

/** Executes the deployed WGSL shader — the code path that actually runs in
 * game — against the full-precision promoted C++ checkpoints. Bun has no WebGPU, so
 * this drives headless Chrome (Dawn, the
 * same WebGPU implementation family as Bitburner's Electron).
 * Missing Chrome or WebGPU is a gate failure, never a reason to silently skip
 * the only TypeScript inference implementation. */

describe("go WGSL shader", () => {
  test("matches promoted C++ checkpoints after quantization, batching, and capacity growth", async () => {
    const run = await runInHeadlessChrome(join(import.meta.dir, "..", "tools", "webgpu", "entry-golden.ts"), 180_000);
    const result = run.result as {
      ok: boolean;
      goldenCases: number;
      failures: string[];
      latency: Record<string, {
        requestToParsed: { p50: number; p95: number; max: number };
        mainThread: { p50: number; p95: number; max: number };
      }>;
      coldStart: Record<string, { decodeMs: number; backendCreateMs: number }>;
      quantization: { proposalElementAgreement: number; top8ShortlistAgreement: number };
      planning: {
        candidatePreparation: { p50: number; p95: number; max: number };
        gpuAndSelection: { p50: number; p95: number; max: number };
        boardToMove: { p50: number; p95: number; max: number };
      };
    };
    if (!result.ok) console.error("WebGPU gate details:", JSON.stringify(result, null, 2));
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.goldenCases).toBeGreaterThan(0);
    expect(result.quantization.proposalElementAgreement).toBeGreaterThanOrEqual(0.999);
    expect(result.quantization.top8ShortlistAgreement).toBeGreaterThanOrEqual(0.99);
    // With a policy-only daemon19 derivative installed, the value-batch probe
    // is replaced by the deployed proposal-shaped probe at the same budgets.
    const daemon = (result.latency["daemon19x104"] ?? result.latency["daemon19-proposal-x2"])!;
    expect(daemon.mainThread.max).toBeLessThan(2);
    expect(daemon.requestToParsed.p95).toBeLessThan(80);
    expect(daemon.requestToParsed.max).toBeLessThan(120);
    expect(result.coldStart.small5!.decodeMs).toBeLessThan(10);
    expect(result.coldStart.daemon19!.decodeMs).toBeLessThan(10);
    expect(result.planning.gpuAndSelection.p95).toBeLessThan(45);
    expect(result.planning.boardToMove.p95).toBeLessThan(50);
  }, 240_000);
});

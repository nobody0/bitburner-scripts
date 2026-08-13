import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bundleGoWorkerSource } from "../tools/build.ts";
import { runInHeadlessChrome } from "../tools/webgpu/chrome-runner.ts";

describe("embedded V9 Go worker", () => {
  test("loads the promoted model and serves cached decisions off the page thread", async () => {
    const source = await bundleGoWorkerSource();
    const run = await runInHeadlessChrome(
      join(import.meta.dir, "..", "tools", "webgpu", "entry-worker.ts"),
      30_000,
      { __goWorkerSource: source },
    );
    const result = run.result as {
      ok: boolean;
      profile?: string;
      extent?: number;
      action?: string;
      coldMs?: number;
      cachedMs?: number;
      cached?: boolean;
      pushed?: boolean;
      pushedMs?: number;
      pushedCachedMs?: number;
      readyAheadMs?: number;
      clockConfirmed?: boolean;
      desyncDetected?: boolean;
      reset?: boolean;
      error?: string;
    };
    if (!result.ok) console.error("V9 worker smoke failure:", result.error);
    expect(result.ok).toBe(true);
    expect(result.profile).toBe("small5");
    expect(result.extent).toBe(5);
    expect(["move", "pass"]).toContain(result.action ?? "");
    expect(result.cached).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.clockConfirmed).toBe(true);
    expect(result.desyncDetected).toBe(true);
    expect(result.reset).toBe(true);
    expect(result.coldMs!).toBeLessThan(500);
    expect(result.cachedMs!).toBeLessThan(20);
    expect(result.pushedMs!).toBeLessThan(500);
    expect(result.pushedCachedMs!).toBeLessThan(20);
    expect(result.readyAheadMs!).toBeGreaterThan(40);
  }, 60_000);
});

import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";

const config: BitburnerConfig = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: "build-test-perf",
  watchDirs: ["game", "shared"],
  entries: [{ source: "game/start.ts", target: "start.js" }],
};

afterAll(async () => {
  await rm(config.buildDir, { recursive: true, force: true });
});

describe("compile-time telemetry elimination", () => {
  test("default build contains the telemetry client", async () => {
    const [main, buildId] = await buildScripts(config, { telemetry: true });
    expect(main!.content).toContain("WebSocket");
    expect(main!.content).toContain("telemetry");
    expect(main!.content).toContain("start.boot");
    expect(main!.content).toContain("start.crash");
    expect(main!.content).toContain(buildId!.content);
  });

  test("--perf build eliminates telemetry entirely, payloads included", async () => {
    const [main] = await buildScripts(config, { telemetry: false });
    expect(main!.content).not.toContain("WebSocket");
    expect(main!.content).not.toContain("telemetry");
    expect(main!.content).not.toContain("__TELEMETRY__");
    expect(main!.content).not.toContain("12526");
    for (const payloadMarker of [
      "start.boot",
      "start.crash",
      "start.superseded",
      "start.respawn",
      "start.respawn_failed",
      "net.rooted",
      "farm.targetSwitch",
      "dispatch.slow",
    ]) {
      expect(main!.content).not.toContain(payloadMarker);
    }
    // Dead-code elimination must not use syntax minification: bracket access
    // is what keeps dodged ns calls out of the controller's static RAM bill.
    expect(main!.content).toContain('stubNs["scp"]');
  });
});

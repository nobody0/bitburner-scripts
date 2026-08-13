import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";

/** What `--perf` is allowed to change, and what it is not.
 *
 * The rule: telemetry may only SEND state the script already holds. Every
 * getter, dodge and probe runs unconditionally and writes to the game-state
 * store; `TELEMETRY: if (__TELEMETRY__)` wraps the send and nothing else. So a
 * perf build must drop the socket, the client and every payload — and keep
 * every acquisition, because the controller gates feature drivers on what the
 * capability batch reads. A perf build you cannot compare against a telemetry
 * build is worthless for measurement. */

const config: BitburnerConfig = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: "build-test-perf",
  entries: [{ source: "game/start.ts", target: "start.js" }],
};

/** Model artifacts are deliberately part of the controller bundle. Keep
 * enough headroom for normal strategy growth while preventing a checkpoint
 * export from silently returning start.js to its former >1 MB size. */
const MAX_START_SOURCE_BYTES = 850_000;

afterAll(async () => {
  await rm(config.buildDir, { recursive: true, force: true });
});

/** Every dodged ns call site in a bundle. This is the surface that decides what
 * the script actually does to the game. */
function stubCalls(source: string): string[] {
  return [...new Set(source.match(/stubNs\[[^\]]*\]/g) ?? [])].sort();
}

describe("compile-time telemetry elimination", () => {
  test("default build contains the telemetry client", async () => {
    const [main, buildId] = await buildScripts(config, { telemetry: true });
    expect(main!.content).toContain("WebSocket");
    expect(main!.content).toContain("telemetry");
    expect(main!.content).toContain("start.boot");
    expect(main!.content).toContain("start.crash");
    expect(main!.content).toContain(buildId!.content);
    expect(main!.content.length).toBeLessThanOrEqual(MAX_START_SOURCE_BYTES);
  });

  test("--perf build eliminates telemetry entirely, payloads included", async () => {
    const [main] = await buildScripts(config, { telemetry: false });
    expect(main!.content).not.toContain("WebSocket");
    expect(main!.content).not.toContain("telemetry");
    expect(main!.content).not.toContain("__TELEMETRY__");
    expect(main!.content).not.toContain("12526");
    // Quoted, because these are emitted as string literals. Bare matching
    // collides with real method calls — `heap.resync(...)` on the heap is not
    // the `heap.resync` event.
    for (const payloadMarker of [
      "start.boot",
      "start.crash",
      "start.superseded",
      "start.respawn",
      "start.respawn_failed",
      "net.rooted",
      "fleet.reclaimed",
      "fleet.reaped",
      "heap.resync",
      "farm.targetSwitch",
      "feature.unlocked",
      "feature.locked",
      "feature.failed",
      "augmentation.reset",
      "bitnode.reset",
      "probe.skipped",
      "probe.failed",
      "probe.batch",
      "contract.quarantined",
    ]) {
      expect(main!.content, `perf bundle still carries ${payloadMarker}`).not.toContain(`"${payloadMarker}"`);
    }
    // Dead-code elimination must not use syntax minification: bracket access
    // is what keeps dodged ns calls out of the controller's static RAM bill.
    expect(main!.content).toContain('stubNs["scp"]');
  });

  test("--perf build keeps every acquisition path", async () => {
    // These are the reads the CONTROLLER depends on, not decorations: the gate
    // batch decides which feature drivers may run, and the probe table is the
    // script's model of the world. Stripping any of them would make the perf
    // build a different program.
    const [main] = await buildScripts(config, { telemetry: false });
    expect(main!.content).toContain('stubNs["getResetInfo"]');
    expect(main!.content).toContain("deriveCapabilities");
    expect(main!.content).toContain('stubNs["gang"]["getGangInformation"]');
    expect(main!.content).toContain('stubNs["corporation"]["getCorporation"]');
  });

  test("--perf build keeps the feature-override seam", async () => {
    // Injected feature switches are a DECISION, applied inside caps(). If they
    // were ever stripped from a perf build, the two builds would gate their
    // feature drivers differently — i.e. play different games — and every
    // --perf measurement would stop describing the real one.
    for (const telemetry of [true, false]) {
      const [main] = await buildScripts(config, { telemetry });
      expect(main!.content).toContain("applyOverrides");
    }
  });

  test("both builds call the game in exactly the same places", async () => {
    // The mechanical statement of "behaviour is identical": same dodged ns
    // surface, so the two bundles play the same game at the same cost. If this
    // ever diverges, --perf measurements stop describing the real build.
    const [telemetryBuild] = await buildScripts(config, { telemetry: true });
    const [perfBuild] = await buildScripts(config, { telemetry: false });
    expect(stubCalls(perfBuild!.content)).toEqual(stubCalls(telemetryBuild!.content));
    // And the stripping must still be worth doing.
    expect(perfBuild!.content.length).toBeLessThan(telemetryBuild!.content.length);
  });
});

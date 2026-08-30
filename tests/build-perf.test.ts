import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";

/** What `--perf` is allowed to change, and what it is not.
 *
 * The rule: telemetry may only SEND state the script already holds. Every
 * getter and probe runs unconditionally and writes to the game-state store;
 * `TELEMETRY: if (__TELEMETRY__)` wraps the send and nothing else. So a
 * perf build must drop the socket, the client and every payload — and keep
 * every acquisition, because the controller gates feature drivers on what the
 * capability batch reads. A perf build you cannot compare against a telemetry
 * build is worthless for measurement. */

const config: BitburnerConfig = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: `build-test-perf-${process.pid}`,
  entries: [{ source: "game/main.ts", target: "main.js" }],
};

/** The darknet controller is a SEPARATE bundle built with the same options,
 * and it is the one that still depends on bracket-notation ns access. */
const dnetConfig: BitburnerConfig = {
  ...config,
  entries: [{ source: "game/dnet/controller.ts", target: "dnet/controller.js" }],
};

/** Both q8 V9 profiles are deliberately part of the controller bundle (their
 * generated payloads are ~1.35 MB), and the certified merged playbook —
 * ~3.6 MB installed by go:playbook:install — is embedded into the V9 worker
 * source. Keep modest strategy headroom while preventing regressions toward
 * full-precision checkpoints or an unstripped playbook (the certificate
 * corpus alone would be tens of MB). */
const MAX_MAIN_SOURCE_BYTES = 5_500_000;

afterAll(async () => {
  await rm(config.buildDir, { recursive: true, force: true });
});

const [dnetController] = await buildScripts(dnetConfig, { telemetry: false });
const dnetControllerSource = dnetController!.content;

/** Every string-literal member chain in a bundle. Receiver names are minified
 * away in shipped artifacts, but the strings — the ns proxy's whole call
 * surface, plus the bracket chains the darknet still uses — survive verbatim,
 * so this is comparable across real deployment builds. */
function memberStrings(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of source.matchAll(/(?:\["[A-Za-z_$][\w$]*"\])+/g)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

describe("compile-time telemetry elimination", () => {
  test("deployable game sources contain no console.log", async () => {
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("game/**/*.ts").scan(".")) {
      if (/console\.log\s*\(/.test(await Bun.file(file).text())) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("default build contains the telemetry client", async () => {
    const [main] = await buildScripts(config, { telemetry: true });
    expect(main!.content).toContain("WebSocket");
    expect(main!.content).toContain("telemetry");
    expect(main!.content).toContain("start.boot");
    expect(main!.content).toContain("start.crash");
    expect(main!.content.length).toBeLessThanOrEqual(MAX_MAIN_SOURCE_BYTES);
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
      "probe.failed",
      "probe.batch",
      "contract.quarantined",
    ]) {
      expect(main!.content, `perf bundle still carries ${payloadMarker}`).not.toContain(`"${payloadMarker}"`);
    }
  });

  test("syntax minification stays off, because the darknet still brackets its ns", () => {
    // start.js no longer needs this: the ns proxy names members with STRING
    // ARGUMENTS (`nsp("scp", ...)`), which no minifier can turn back into a
    // property access. The darknet is a different story — its three processes
    // borrow a live `ns` and call it as `borrowed["exec"]` / `ns["dnet"][...]`
    // precisely so the static analyser cannot see the member and bill their
    // `ramOverride` for it. esbuild's syntax minification rewrites exactly
    // that form into a dotted call, so it must stay off for every entry.
    expect(dnetControllerSource).toContain('["exec"]');
  });

  test("--perf build keeps every acquisition path", async () => {
    // These are the reads the CONTROLLER depends on, not decorations: the gate
    // batch decides which feature drivers may run, and the probe table is the
    // script's model of the world. Stripping any of them would make the perf
    // build a different program. A probe names its member as a string path,
    // and string literals survive minification, so this runs against the
    // shipped artifact.
    const [main] = await buildScripts(config, { telemetry: false });
    expect(main!.content).toContain('"getResetInfo"');
    expect(main!.content).toContain('"gang.getGangInformation"');
    expect(main!.content).toContain('"corporation.getCorporation"');
  });

  test("both builds derive capabilities from game observations", async () => {
    for (const telemetry of [true, false]) {
      const [main] = await buildScripts(config, { telemetry, minifyNames: false });
      expect(main!.content).toContain("deriveCapabilities");
    }
  });

  test("both builds call the game in exactly the same places", async () => {
    // The mechanical statement of "behaviour is identical": same ns call
    // surface, so the two bundles play the same game at the same cost. If this
    // ever diverges, --perf measurements stop describing the real build.
    const [telemetryBuild] = await buildScripts(config, { telemetry: true });
    const [perfBuild] = await buildScripts(config, { telemetry: false });
    expect(memberStrings(perfBuild!.content)).toEqual(memberStrings(telemetryBuild!.content));
    // And the stripping must still be worth doing.
    expect(perfBuild!.content.length).toBeLessThan(telemetryBuild!.content.length);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { isScriptVersion, versionedScript } from "../shared/deployment.ts";
import { BUILD_ID_FILE, buildScript, buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";

const buildDir = "build-test-deployment";
const config: BitburnerConfig = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir,
  // Stable first on purpose: the returned push order must still put the
  // immutable helper before it.
  entries: [
    { source: "game/lib/dodge-stub.ts", target: "lib/dodge-stub.js" },
    { source: "game/worker/worker.ts", target: "worker/worker.js", versioned: true },
  ],
  restoreEntry: { source: "game/restore.ts", target: "restore.js" },
};

afterAll(async () => rm(buildDir, { recursive: true, force: true }));

describe("versioned deployment artifacts", () => {
  test("uses the build id and pushes helpers before stable scripts and the stamp", async () => {
    const artifacts = await buildScripts(config);
    const buildId = artifacts.at(-1)!.content;
    expect(artifacts.map((artifact) => artifact.filename)).toEqual([
      versionedScript("worker/worker.js", buildId),
      "lib/dodge-stub.js",
      BUILD_ID_FILE,
    ]);
    expect(await Bun.file(path.join(buildDir, BUILD_ID_FILE)).text()).toBe(buildId);
    expect(artifacts.some((artifact) => artifact.filename === "restore.js")).toBe(false);
    expect(await Bun.file(path.join(buildDir, "restore.js")).exists()).toBe(false);

    const restore = await buildScript(config, config.restoreEntry!);
    expect(restore.filename).toBe("restore.js");
    expect(await Bun.file(path.join(buildDir, "restore.js")).exists()).toBe(true);
    expect(await Bun.file(path.join(buildDir, versionedScript("worker/worker.js", buildId))).exists()).toBe(true);
  });

  test("recognises only members of the managed script family", () => {
    expect(isScriptVersion("worker/worker.js", "worker/worker.js")).toBe(true);
    expect(isScriptVersion("worker/worker.abc-123.js", "worker/worker.js")).toBe(true);
    expect(isScriptVersion("worker/worker.other/name.js", "worker/worker.js")).toBe(false);
    expect(isScriptVersion("worker/not-worker.abc.js", "worker/worker.js")).toBe(false);
  });
});

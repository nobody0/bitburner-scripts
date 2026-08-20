import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { isScriptVersion, isSweepableFile, ownedDirectories, versionedScript } from "../shared/deployment.ts";
import { BUILD_ID_FILE, buildScript, buildScripts } from "../tools/build.ts";
import type { BitburnerConfig } from "../tools/config.ts";

const buildDir = `build-test-deployment-${process.pid}`;
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

  test("owns directories the build writes into, and never the root", () => {
    expect(ownedDirectories(config.entries.map((entry) => entry.target))).toEqual(
      new Set(["lib/", "worker/"]),
    );
    // start.js and build-id.txt sit at the root, which is shared with the game
    // and the player. A root-only config therefore owns nothing.
    expect(ownedDirectories(["start.js", "build-id.txt"])).toEqual(new Set());
  });

  test("sweeps only stale .js files inside owned directories", () => {
    const owned = new Set(["lib/", "worker/"]);
    const keep = new Set(["worker/worker.new-id.js", "lib/dodge-stub.new-id.js"]);

    expect(isSweepableFile("worker/worker.old-id.js", owned, keep)).toBe(true);
    expect(isSweepableFile("lib/go-dodge-stub.old-id.js", owned, keep)).toBe(true);
    expect(isSweepableFile("worker/starter.js", owned, keep)).toBe(true);

    expect(isSweepableFile("worker/worker.new-id.js", owned, keep)).toBe(false);
    // The root is never swept: unversioned targets are overwritten by the push.
    expect(isSweepableFile("start.js", owned, keep)).toBe(false);
    expect(isSweepableFile("main.js", owned, keep)).toBe(false);
    expect(isSweepableFile("build-id.txt", owned, keep)).toBe(false);
    // Written by the running game script, and not a build target directory.
    expect(isSweepableFile("data/run-lineage.txt", owned, keep)).toBe(false);
    // A player's own notes inside one of our directories survive the .js rule.
    expect(isSweepableFile("lib/notes.txt", owned, keep)).toBe(false);
  });
});

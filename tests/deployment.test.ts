import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { isSweepableFile, ownedDirectories } from "../shared/deployment.ts";
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
    { source: "game/lib/ns-resident.ts", target: "lib/ns-resident.js" },
    { source: "game/worker/worker.ts", target: "worker/worker.js" },
  ],
  restoreEntry: { source: "game/restore.ts", target: "restore.js" },
};

afterAll(async () => rm(buildDir, { recursive: true, force: true }));

describe("stable deployment artifacts", () => {
  test("uses stable helper names and writes the stamp last", async () => {
    const artifacts = await buildScripts(config);
    const buildId = artifacts.at(-1)!.content;
    expect(artifacts.map((artifact) => artifact.filename)).toEqual([
      "lib/ns-resident.js",
      "worker/worker.js",
      BUILD_ID_FILE,
    ]);
    expect(await Bun.file(path.join(buildDir, BUILD_ID_FILE)).text()).toBe(buildId);
    expect(artifacts.some((artifact) => artifact.filename === "restore.js")).toBe(false);
    expect(await Bun.file(path.join(buildDir, "restore.js")).exists()).toBe(false);

    const restore = await buildScript(config, config.restoreEntry!);
    expect(restore.filename).toBe("restore.js");
    expect(await Bun.file(path.join(buildDir, "restore.js")).exists()).toBe(true);
    expect(await Bun.file(path.join(buildDir, "worker/worker.js")).exists()).toBe(true);
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
    const keep = new Set(["worker/worker.js", "lib/ns-resident.js"]);

    expect(isSweepableFile("worker/unused.js", owned, keep)).toBe(true);
    expect(isSweepableFile("lib/obsolete.js", owned, keep)).toBe(true);

    expect(isSweepableFile("worker/worker.js", owned, keep)).toBe(false);
    // The root is never swept: stable targets are overwritten by the push.
    expect(isSweepableFile("start.js", owned, keep)).toBe(false);
    expect(isSweepableFile("build-id.txt", owned, keep)).toBe(false);
    // Written by the running game script, and not a build target directory.
    expect(isSweepableFile("data/run-lineage.txt", owned, keep)).toBe(false);
    // A player's own notes inside one of our directories survive the .js rule.
    expect(isSweepableFile("lib/notes.txt", owned, keep)).toBe(false);
  });
});

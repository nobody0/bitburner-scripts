import { describe, expect, test } from "bun:test";
import { validateConfig } from "../tools/config.ts";

const valid = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: "build",
  entries: [{ source: "game/start.ts", target: "start.js" }],
};

describe("validateConfig", () => {
  test("accepts a minimal allowlist", () => {
    expect(validateConfig(valid)).toEqual(valid);
  });

  test("accepts versioned runtime entries and a separate restore entry", () => {
    const configured = {
      ...valid,
      entries: [{ source: "game/worker/worker.ts", target: "worker/worker.js", versioned: true }],
      restoreEntry: { source: "game/restore.ts", target: "restore.js" },
    };
    expect(validateConfig(configured)).toEqual(configured);
  });

  test("rejects a build directory that could contain source", () => {
    expect(() => validateConfig({ ...valid, buildDir: "game" })).toThrow("buildDir must be build/");
  });

  test("rejects entry sources outside game/", () => {
    expect(() => validateConfig({ ...valid, entries: [{ source: "sim/run.ts", target: "run.js" }] })).toThrow(
      "must live under game/",
    );
  });

  test("rejects targets outside the repository", () => {
    expect(() => validateConfig({ ...valid, entries: [{ source: "game/start.ts", target: "../start.js" }] })).toThrow(
      "must stay inside the repository",
    );
  });

  test("rejects duplicate in-game filenames", () => {
    expect(() =>
      validateConfig({
        ...valid,
        entries: [
          { source: "game/start.ts", target: "start.js" },
          { source: "game/other.ts", target: "start.js" },
        ],
      }),
    ).toThrow("duplicate target");
  });

  test("rejects a restore target that overlaps the normal deployment", () => {
    expect(() =>
      validateConfig({ ...valid, restoreEntry: { source: "game/restore.ts", target: "start.js" } }),
    ).toThrow("duplicate target");
  });
});

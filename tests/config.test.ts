import { describe, expect, test } from "bun:test";
import { validateConfig } from "../tools/config.ts";

const valid = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: "build",
  watchDirs: ["game", "shared", "types"],
  entries: [{ source: "game/start.ts", target: "start.js" }],
};

describe("validateConfig", () => {
  test("accepts a minimal allowlist", () => {
    expect(validateConfig(valid)).toEqual(valid);
  });

  test("defaults watchDirs when omitted", () => {
    const { watchDirs: _watchDirs, ...withoutWatchDirs } = valid;
    expect(validateConfig(withoutWatchDirs).watchDirs).toEqual(["game", "shared"]);
  });

  test("rejects watch dirs outside the repository", () => {
    expect(() => validateConfig({ ...valid, watchDirs: ["../elsewhere"] })).toThrow(
      "must stay inside the repository",
    );
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
});

import { describe, expect, test } from "bun:test";
import { validateConfig } from "../tools/config.ts";

const valid = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir: "build",
  entries: [{ source: "src/main.ts", target: "main.js" }],
};

describe("validateConfig", () => {
  test("accepts a minimal allowlist", () => {
    expect(validateConfig(valid)).toEqual(valid);
  });

  test("rejects targets outside the repository", () => {
    expect(() => validateConfig({ ...valid, entries: [{ source: "src/main.ts", target: "../main.js" }] })).toThrow(
      "must stay inside the repository",
    );
  });

  test("rejects duplicate in-game filenames", () => {
    expect(() =>
      validateConfig({
        ...valid,
        entries: [
          { source: "src/main.ts", target: "main.js" },
          { source: "src/other.ts", target: "main.js" },
        ],
      }),
    ).toThrow("duplicate target");
  });
});


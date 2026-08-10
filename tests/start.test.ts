import { describe, expect, test } from "bun:test";
import { parseStartMode } from "../game/start.ts";

describe("start.js invocation contract", () => {
  test("empty args are the single cold-boot form used by autoexec and reset callbacks", () => {
    expect(parseStartMode([], "build-1")).toBe("cold");
  });

  test("handoff requires the exact build id", () => {
    expect(parseStartMode(["handoff", "build-1"], "build-1")).toBe("handoff");
    expect(() => parseStartMode(["handoff", "stale"], "build-1")).toThrow("invalid start.js args");
  });

  test("rejects the obsolete main arg and every partial or extra form", () => {
    for (const args of [["main"], ["cold"], ["handoff"], ["handoff", "build-1", "extra"]]) {
      expect(() => parseStartMode(args, "build-1")).toThrow("invalid start.js args");
    }
  });
});

import { describe, expect, test } from "bun:test";
import { parseSyncArgs, syncOptionsFrom } from "../tools/sync.ts";

/** Both sync transports (CLI flags, hub POST body) must resolve to the same
 * SyncOptions, so the two parsers are pinned side by side. */

describe("parseSyncArgs", () => {
  test("--sync alone means a default full push", () => {
    expect(parseSyncArgs(["--sync"])).toEqual({});
  });

  test("--types-only maps to typesOnly", () => {
    expect(parseSyncArgs(["--types-only"])).toEqual({ typesOnly: true });
  });

  test("every modifier flag maps to its option", () => {
    expect(parseSyncArgs(["--sync", "--perf", "--readable"])).toEqual({
      perf: true,
      readable: true,
    });
  });

  test("exactly one mode flag is required", () => {
    expect(() => parseSyncArgs([])).toThrow("exactly one");
    expect(() => parseSyncArgs(["--perf"])).toThrow("exactly one");
    expect(() => parseSyncArgs(["--sync", "--types-only"])).toThrow("exactly one");
  });

  test("an unknown flag is an error, not a silent default push", () => {
    expect(() => parseSyncArgs(["--sync", "--redable"])).toThrow("unknown flag --redable");
  });

});

describe("syncOptionsFrom", () => {
  test("picks only known keys set to boolean true", () => {
    expect(
      syncOptionsFrom({ readable: true, perf: false, noSweep: "yes", extra: true, typesOnly: 1 }),
    ).toEqual({ readable: true });
  });

  test("non-objects mean default options", () => {
    expect(syncOptionsFrom(null)).toEqual({});
    expect(syncOptionsFrom("readable")).toEqual({});
    expect(syncOptionsFrom(undefined)).toEqual({});
  });
});

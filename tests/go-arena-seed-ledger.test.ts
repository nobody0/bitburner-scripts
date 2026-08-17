import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findGoArenaSeedConflicts,
  readGoArenaSeedLedger,
  recordGoArenaSeedUse,
  seedUseFromConfig,
} from "../tools/go-arena-seed-ledger.ts";

function use(
  profile: "small5" | "daemon19",
  seed: number,
  handicapSeed = 2_000,
  defenseSeed = 3_000,
) {
  return seedUseFromConfig({
    profile,
    games: 1,
    seed,
    handicapSeed,
    defenseSeed,
  }, "screen", [], "2026-08-14T00:00:00.000Z");
}

describe("Go promotion seed hygiene", () => {
  test("sub-tick and whole-period playtime aliases are detected", () => {
    const prior = use("daemon19", 1_001);
    expect(findGoArenaSeedConflicts(use("daemon19", 1_199, 2_001, 3_001), [prior]))
      .toContainEqual(expect.objectContaining({ stream: "playtime", value: 1_000 }));
    expect(findGoArenaSeedConflicts(use("daemon19", 30_001_001, 2_001, 3_001), [prior]))
      .toContainEqual(expect.objectContaining({ stream: "playtime", value: 1_000 }));
  });

  test("reusing any one environment stream makes an apply corpus non-fresh", () => {
    const prior = use("daemon19", 1_000);
    expect(findGoArenaSeedConflicts(use("daemon19", 1_200, 2_000, 3_001), [prior]))
      .toContainEqual(expect.objectContaining({ stream: "handicap" }));
    expect(findGoArenaSeedConflicts(use("daemon19", 1_200, 2_001, 3_000), [prior]))
      .toContainEqual(expect.objectContaining({ stream: "defense" }));
  });

  test("different profile ladders do not burn one another's corpora", () => {
    expect(findGoArenaSeedConflicts(use("daemon19", 1_000), [use("small5", 1_000)]))
      .toEqual([]);
  });

  test("records resolve and pin the effective candidate limit", () => {
    expect(use("small5", 1_000).candidateLimit).toBe(4);
    expect(use("daemon19", 1_000).candidateLimit).toBe(1);
    expect(seedUseFromConfig({
      profile: "daemon19", games: 1, seed: 1_000,
      handicapSeed: 2_000, defenseSeed: 3_000, candidateLimit: 8,
    }, "screen", [], "2026-08-14T00:00:00.000Z").candidateLimit).toBe(8);
  });

  test("legacy records without a candidate limit still parse and conflict", () => {
    const { candidateLimit: _absent, ...legacy } = use("daemon19", 1_001);
    expect(findGoArenaSeedConflicts(use("daemon19", 1_199, 2_001, 3_001), [legacy]))
      .toContainEqual(expect.objectContaining({ stream: "playtime", value: 1_000 }));
  });

  test("a recorded screen blocks reuse by an apply gate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "go-seed-ledger-"));
    const path = join(directory, "ledger.json");
    try {
      const screen = use("daemon19", 1_000);
      await recordGoArenaSeedUse(screen, path);
      expect((await readGoArenaSeedLedger(path)).uses).toHaveLength(1);
      const apply = { ...screen, id: "apply", kind: "promotion-apply" as const };
      await expect(recordGoArenaSeedUse(apply, path, true)).rejects.toThrow("arena corpus is not fresh");
      expect((await readGoArenaSeedLedger(path)).uses).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

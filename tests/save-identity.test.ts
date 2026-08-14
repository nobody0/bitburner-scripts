import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveFileSha256, type SaveEntry } from "../tools/save-io.ts";

function entry(file: string, sha256?: string): SaveEntry {
  return {
    id: "checkpoint",
    label: "checkpoint",
    file,
    bitNode: 5,
    capturedAt: 1,
    playtimeSinceLastBitnode: 0,
    ...(sha256 ? { sha256 } : {}),
  };
}

describe("route checkpoint content identity", () => {
  test("legacy entries acquire a deterministic content fingerprint", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bb-save-id-"));
    try {
      const file = path.join(dir, "save.gz");
      const bytes = Buffer.from("checkpoint-a");
      writeFileSync(file, bytes);
      expect(saveFileSha256(entry(file))).toBe(createHash("sha256").update(bytes).digest("hex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replacing bytes behind an existing id invalidates its lineage", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bb-save-id-"));
    try {
      const file = path.join(dir, "save.gz");
      writeFileSync(file, "checkpoint-a");
      const expected = saveFileSha256(entry(file));
      writeFileSync(file, "checkpoint-b");
      expect(() => saveFileSha256(entry(file, expected))).toThrow("changed bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

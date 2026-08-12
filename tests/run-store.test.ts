import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactIdentity } from "../shared/run-identity.ts";
import type { HelloBody, LogRecord } from "../shared/telemetry/schema.ts";
import { RunStore } from "../ui/store.ts";

const identity: ArtifactIdentity = {
  lineage: { id: "save", kind: "game", label: "game save TEST", createdAt: 1 },
  bitNode: { id: "node", bitNode: 1, startedAt: 10 },
  install: { id: "install", startedAt: 20 },
};

function hello(run: string): HelloBody {
  return { run, src: "game", script: "start.js", startedAt: 30, identity };
}

function event(run: string, seq: number, t: number): LogRecord {
  return { run, seq, t, src: "game", kind: "event", name: "tick" };
}

describe("install artifact store", () => {
  test("accepts handoff emitters with independent sequence spaces", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bb-store-"));
    try {
      const store = new RunStore(dir, hello("old"));
      store.attach(hello("new"));
      const accepted = store.append([event("old", 0, 100), event("new", 0, 101), event("old", 0, 100)]);
      expect(store.id).toBe("install");
      expect(store.recordCount).toBe(2);
      expect(accepted).toEqual([event("old", 0, 100), event("new", 0, 101)]);
      expect(store.metadata().emitters.sort()).toEqual(["new", "old"]);

      store.detach();
      expect(store.live).toBe(true);
      await store.detach();
      expect(store.live).toBe(false);
      const sidecar = JSON.parse(readFileSync(`${store.file}.meta.json`, "utf8")) as { records: number; firstT: number; lastT: number };
      expect(sidecar).toMatchObject({ records: 2, firstT: 100, lastT: 101 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

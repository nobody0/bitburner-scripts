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

function stateRecord(seq: number, t: number, value: unknown): LogRecord {
  return { run: "r", seq, t, src: "game", kind: "state", key: "progression", data: value } as LogRecord;
}

/** Read the persisted JSONL back, oldest line first. */
function lines(file: string): LogRecord[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogRecord);
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

  /** The emitter republishes a dirty topic in full every tick and deliberately
   * does not check whether it moved — proving that costs a second
   * serialization of every topic, and game-script clock time is the resource
   * the telemetry design exists to protect. So the hub sifts instead. */
  describe("unchanged state spans", () => {
    test("collapses a run of identical state to its first and last record", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "bb-store-"));
      try {
        const store = new RunStore(dir, hello("r"));
        store.append([
          stateRecord(0, 100, { a: 1 }),
          stateRecord(1, 200, { a: 1 }),
          stateRecord(2, 300, { a: 1 }),
          stateRecord(3, 400, { a: 1 }),
          stateRecord(4, 500, { a: 2 }),
        ]);
        await store.detach();

        const written = lines(store.file);
        // First (100) opens the span, last (400) closes it, and 500 is the new
        // value. The two middle repeats are dropped.
        expect(written.map((record) => record.t)).toEqual([100, 400, 500]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("keeps the span's END, so the interval it held is recoverable", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "bb-store-"));
      try {
        const store = new RunStore(dir, hello("r"));
        store.append([stateRecord(0, 100, { a: 1 }), stateRecord(1, 9_000, { a: 1 })]);
        await store.detach();

        // Keeping only the opening record would make "held this value for
        // nearly nine seconds" indistinguishable from "sampled once at 100".
        // That span is an observation, so both ends are kept.
        expect(lines(store.file).map((record) => record.t)).toEqual([100, 9_000]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a live viewer still receives every record", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "bb-store-"));
      try {
        const store = new RunStore(dir, hello("r"));
        const records = [
          stateRecord(0, 100, { a: 1 }),
          stateRecord(1, 200, { a: 1 }),
          stateRecord(2, 300, { a: 1 }),
        ];
        // The collapse is a STORAGE decision. What the socket broadcasts is
        // unchanged: a viewer's own liveness reading comes off the stream.
        expect(store.append(records)).toEqual(records);
        await store.detach();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("independent keys keep independent spans", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "bb-store-"));
      try {
        const store = new RunStore(dir, hello("r"));
        const other = (seq: number, t: number, value: unknown): LogRecord =>
          ({ run: "r", seq, t, src: "game", kind: "state", key: "fleet", data: value }) as LogRecord;
        store.append([
          stateRecord(0, 100, { a: 1 }),
          other(1, 110, { b: 1 }),
          stateRecord(2, 200, { a: 1 }),
          other(3, 210, { b: 2 }),
          stateRecord(4, 300, { a: 1 }),
        ]);
        await store.detach();

        const written = lines(store.file);
        // `fleet` changed and so was written twice; `progression` held one
        // value and contributes its first and last only.
        const forKey = (key: string): number[] =>
          written.filter((record) => record.kind === "state" && record.key === key).map((record) => record.t);
        expect(forKey("fleet")).toEqual([110, 210]);
        expect(forKey("progression")).toEqual([100, 300]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /** Ctrl-C is how the hub is actually stopped, and it used to be the one case
     * where the guarantee did not hold: `#flushSpans()` was reachable only from
     * detach(), so every key sitting mid-span lost its closing record. */
    test("close() keeps the span's end when the hub is stopped, not just when the emitter leaves", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "bb-store-"));
      try {
        const store = new RunStore(dir, hello("r"));
        store.append([stateRecord(0, 100, { a: 1 }), stateRecord(1, 9_000, { a: 1 })]);
        // No detach: the emitter is still attached, exactly as it is at a SIGINT.
        await store.close();
        expect(lines(store.file).map((record) => record.t)).toEqual([100, 9_000]);
        const sidecar = JSON.parse(readFileSync(`${store.file}.meta.json`, "utf8")) as { records: number; live: boolean };
        // Metadata is written after the stream closed, so it describes the
        // finished file rather than claiming a live run with a short size.
        expect(sidecar).toMatchObject({ records: 2, live: false });
        // Idempotent: SIGINT then SIGTERM must not re-end an ended stream.
        expect(store.close()).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("the record count reflects what was actually written", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "bb-store-"));
      try {
        const store = new RunStore(dir, hello("r"));
        store.append([
          stateRecord(0, 100, { a: 1 }),
          stateRecord(1, 200, { a: 1 }),
          stateRecord(2, 300, { a: 1 }),
        ]);
        await store.detach();
        // The sidecar drives the catalogue and the compact loader's bounds, so
        // it has to count lines on disk, not records offered.
        const sidecar = JSON.parse(readFileSync(`${store.file}.meta.json`, "utf8")) as { records: number };
        expect(sidecar.records).toBe(lines(store.file).length);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

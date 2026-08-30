import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactMetadata } from "../../shared/run-catalog.ts";
import { SimArtifactSession, type SimSessionManifest } from "../artifacts.ts";
import { summarizeOutput } from "../ns/api.ts";
import { parseBytes } from "../run.ts";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "bb-durability-"));
}

const record = (seq: number, t: number, name: string) =>
  JSON.stringify({ seq, t, run: "emitter", src: "sim", kind: "event", name });

const readManifest = (session: SimArtifactSession): SimSessionManifest =>
  JSON.parse(readFileSync(session.manifestFile, "utf8")) as SimSessionManifest;

const heartbeat = (session: SimArtifactSession): Record<string, unknown>[] =>
  readFileSync(session.progressFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The whole point of this file: a run that is killed from outside — by a
 * watchdog, by the OOM killer, by a Bun segfault — never reaches `close()`,
 * and neither a signal handler nor an atexit hook can change that. What
 * survives such a death is what was already on disk. */
describe("artifacts that survive a killed run", () => {
  test("a checkpoint leaves a complete manifest and sidecar mid-run", () => {
    const dir = scratch();
    try {
      const session = new SimArtifactSession({ outDir: dir, label: "killed", seed: 2, bitNode: 4 });
      session.write(record(0, 0, "sim.started"));
      session.write(JSON.stringify({
        seq: 1, t: 0, run: "emitter", src: "sim", kind: "event", name: "sim.meta",
        data: { scenarioFingerprint: "v1:partial" },
      }));
      session.checkpoint();
      // Nothing below closes the session: this is the state a `kill -9` leaves.

      const manifest = readManifest(session);
      expect(manifest.version).toBe(2);
      expect(manifest.seed).toBe(2);
      expect(manifest.scenarioFingerprint).toBe("v1:partial");
      expect(manifest.artifacts).toEqual([path.basename(session.files[0]!)]);
      // A partial run has no result, and therefore cannot be mistaken for one.
      expect(manifest.result).toBeUndefined();

      const sidecar = JSON.parse(
        readFileSync(`${session.files[0]!}.meta.json`, "utf8"),
      ) as ArtifactMetadata;
      expect(sidecar.records).toBe(2);
      expect(sidecar.identity?.install.index).toBe(0);
      // The flush is what makes the sidecar's claim true on disk.
      expect(readFileSync(session.files[0]!, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a manifest is never observed half-written", () => {
    const dir = scratch();
    try {
      const session = new SimArtifactSession({ outDir: dir, label: "atomic", seed: 1 });
      session.write(record(0, 0, "sim.started"));
      for (let i = 0; i < 20; i++) session.checkpoint();
      // Every intermediate state a reader could catch is a complete document,
      // and no temporary is left behind to be mistaken for one.
      expect(() => readManifest(session)).not.toThrow();
      expect(readdirSync(dir).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rotation checkpoints the install it just ended", async () => {
    const dir = scratch();
    try {
      const session = new SimArtifactSession({ outDir: dir, label: "rotate", seed: 1, bitNode: 1 });
      session.write(record(0, 0, "sim.started"));
      session.write(record(1, 60_000, "sim.prestige"));
      session.write(record(2, 61_000, "start.boot"));
      const manifest = readManifest(session);
      expect(manifest.artifacts).toHaveLength(2);
      await session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close is idempotent and hands every caller the same completion", async () => {
    const dir = scratch();
    try {
      const session = new SimArtifactSession({ outDir: dir, label: "twice", seed: 1 });
      session.write(record(0, 0, "sim.started"));
      // A signal handler and the normal path both close; the handler must wait
      // for the finalizations the normal path already started rather than
      // racing them to process.exit.
      const first = session.close();
      const second = session.close();
      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(existsSync(`${session.files[0]!}.meta.json`)).toBe(true);
      await session.close();
      expect(heartbeat(session).filter((line) => line["phase"] === "done")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records written after close cannot open a phantom install", async () => {
    // The signal-handler race: the pump is still running when the handler
    // closes the session, so a record can arrive afterwards. Opening a new
    // artifact for it would append a file to a manifest already on disk.
    const dir = scratch();
    try {
      const session = new SimArtifactSession({ outDir: dir, label: "race", seed: 1 });
      session.write(record(0, 0, "sim.started"));
      await session.close();
      session.write(record(1, 10, "start.boot"));
      expect(session.files).toHaveLength(1);
      expect(readManifest(session).artifacts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a checkpoint after close does not resurrect the session", async () => {
    const dir = scratch();
    try {
      const session = new SimArtifactSession({ outDir: dir, label: "after", seed: 1 });
      session.write(record(0, 0, "sim.started"));
      await session.close();
      const before = readFileSync(session.manifestFile, "utf8");
      session.checkpoint();
      expect(readFileSync(session.manifestFile, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the progress heartbeat", () => {
  test("exists from construction and ends with the run's own verdict", async () => {
    const dir = scratch();
    try {
      const session = new SimArtifactSession({ outDir: dir, label: "beat", seed: 3, bitNode: 4 });
      // Written before a single record: a run that dies during world
      // construction still says which run it was.
      expect(heartbeat(session)).toEqual([
        expect.objectContaining({ phase: "start", label: "beat", seed: 3, bitNode: 4 }),
      ]);

      session.write(record(0, 0, "sim.started"));
      session.note({ phase: "sample", wallMs: 10_000, throughput: 4.5 });
      session.write(JSON.stringify({
        seq: 1, t: 5, run: "emitter", src: "sim", kind: "event", name: "sim.result",
        data: { reached: false, timeToGoalMs: Infinity, validity: "valid", stoppedBecause: "memory" },
      }));
      await session.close();

      const lines = heartbeat(session);
      // Every line stands alone: an agent tailing this parses what has landed
      // without waiting for the run to finish.
      expect(lines.map((line) => line["phase"])).toEqual(["start", "sample", "done"]);
      expect(lines.every((line) => typeof line["at"] === "number")).toBe(true);
      expect(lines.at(-1)).toMatchObject({ stoppedBecause: "memory", reached: false });
      // And the manifest keeps it too. `Infinity` serializes to `null`, which
      // used to disqualify the whole result and leave every unreached run's
      // session claiming no verdict at all.
      expect(readManifest(session).result).toMatchObject({
        reached: false,
        validity: "valid",
        stoppedBecause: "memory",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("timestamps are real even though the run's clock is not", async () => {
    // The trap spec/simulator.md names: inside an installed realm the global
    // `Date.now` IS the virtual clock, so a sidecar written mid-run used to
    // date itself to the simulated year (2024-01-02, measured) and a reader
    // could not tell a live run from an abandoned one.
    const dir = scratch();
    const realNow = Date.now();
    const patched = Date.now;
    try {
      Date.now = () => 1_704_000_000_000;
      const session = new SimArtifactSession({ outDir: dir, label: "clock", seed: 1 });
      session.write(record(0, 0, "sim.started"));
      session.checkpoint();
      const sidecar = JSON.parse(
        readFileSync(`${session.files[0]!}.meta.json`, "utf8"),
      ) as ArtifactMetadata;
      expect(sidecar.updatedAt).toBeGreaterThanOrEqual(realNow);
      expect(heartbeat(session)[0]!["at"] as number).toBeGreaterThanOrEqual(realNow);
      await session.close();
    } finally {
      Date.now = patched;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session killed before any result says so rather than claiming one", async () => {
    const dir = scratch();
    try {
      const session = new SimArtifactSession({ outDir: dir, label: "nores", seed: 1 });
      session.write(record(0, 0, "sim.started"));
      await session.close();
      expect(heartbeat(session).at(-1)).toMatchObject({ phase: "done", stoppedBecause: "unwritten" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("operator-facing CLI helpers", () => {
  test("sizes read the way durations do", () => {
    expect(parseBytes("512")).toBe(512);
    expect(parseBytes("512mb")).toBe(512 * 1024 ** 2);
    expect(parseBytes("8GB")).toBe(8 * 1024 ** 3);
    expect(parseBytes("1.5gb")).toBe(1.5 * 1024 ** 3);
    expect(() => parseBytes("8gigs")).toThrow("bad size");
    expect(() => parseBytes("")).toThrow("bad size");
  });

  test("repeated output collapses to one counted line", () => {
    // 12,908 copies of one warning is a flood on the terminal and a single
    // fact in the summary.
    expect(summarizeOutput(new Map([["main.js online", 2], ["WARNING: cannot be PLACED", 12_908]])))
      .toEqual([
        { line: "WARNING: cannot be PLACED", count: 12_908 },
        { line: "main.js online", count: 2 },
      ]);
    expect(summarizeOutput(new Map())).toEqual([]);
    expect(summarizeOutput(undefined)).toEqual([]);
  });
});

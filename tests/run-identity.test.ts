import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bitNodeRunId, installRunId } from "../shared/run-identity.ts";
import type { ArtifactMetadata } from "../shared/run-catalog.ts";
import { assertPromotableSession, SimArtifactSession, type SimSessionManifest } from "../sim/artifacts.ts";

describe("hierarchical run identity", () => {
  test("reset epochs distinguish repeated BitNode visits and installs", () => {
    const firstVisit = bitNodeRunId("save-a", 100);
    const secondVisit = bitNodeRunId("save-a", 200);
    expect(firstVisit).not.toBe(secondVisit);
    expect(installRunId(firstVisit, "save-a", 110)).toBe(installRunId(firstVisit, "save-a", 110));
    expect(installRunId(firstVisit, "save-a", 110)).not.toBe(installRunId(firstVisit, "save-a", 120));
  });

  test("a simulator session rotates JSONL artifacts after prestige", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bb-artifacts-"));
    try {
      const experiment = {
        class: "bitnode-route" as const,
        entrance: { kind: "fresh" as const, bitNode: 4 as const },
        route: { route: "all-sf3-bn4-first", leg: "bn4.1", index: 0, bitNode: 4 },
      };
      const session = new SimArtifactSession({
        outDir: dir,
        label: "chain",
        seed: 7,
        bitNode: 1,
        createdAt: 1_000,
        experiment,
      });
      const line = (seq: number, t: number, name: string) => JSON.stringify({
        seq, t, run: "emitter", src: "sim", kind: "event", name,
      });
      session.write(line(0, 0, "sim.started"));
      session.write(JSON.stringify({
        seq: 1, t: 0, run: "emitter", src: "sim", kind: "event", name: "sim.meta",
        data: { scenarioFingerprint: "v1:checkpoint" },
      }));
      session.write(line(2, 60_000, "sim.prestige"));
      session.write(line(3, 65_000, "start.boot"));
      session.write(JSON.stringify({
        seq: 4, t: 181_000, run: "emitter", src: "sim", kind: "event", name: "sim.result",
        data: { reached: true, timeToGoalMs: 181_000, validity: "valid", stoppedBecause: "goal" },
      }));
      await session.close();

      expect(session.files).toHaveLength(2);
      const metadata = session.files.map((file) =>
        JSON.parse(readFileSync(`${file}.meta.json`, "utf8")) as ArtifactMetadata
      );
      expect(metadata.map((entry) => entry.identity?.install.index)).toEqual([0, 1]);
      expect(metadata.map((entry) => entry.identity?.install.startedAt)).toEqual([0, 60_000]);
      expect(metadata[0]!.identity?.lineage.id).toBe(metadata[1]!.identity?.lineage.id);
      expect((metadata[0]!.lastT ?? 0) - (metadata[0]!.firstT ?? 0)).toBe(60_000);
      expect((metadata[1]!.lastT ?? 0) - (metadata[1]!.firstT ?? 0)).toBe(116_000);
      expect(metadata.map((entry) => entry.size)).toEqual(session.files.map((file) => statSync(file).size));

      const manifest = JSON.parse(readFileSync(session.manifestFile, "utf8")) as SimSessionManifest;
      expect(manifest.version).toBe(2);
      expect(manifest.experiment).toEqual(experiment);
      expect(manifest.scenarioFingerprint).toBe("v1:checkpoint");
      expect(manifest.result).toEqual({
        reached: true,
        timeToGoalMs: 181_000,
        validity: "valid",
        stoppedBecause: "goal",
      });
      expect(manifest.artifacts).toEqual(session.files.map((file) => path.basename(file)));
      expect(() => assertPromotableSession(manifest)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("synthetic or invalid sessions cannot be promoted into route state", () => {
    const base: SimSessionManifest = {
      version: 2,
      identity: { id: "x", kind: "sim", label: "x", createdAt: 1 },
      seed: 1,
      scenarioFingerprint: "v1:x",
      artifacts: [],
      experiment: {
        class: "feature-scenario",
        entrance: { kind: "synthetic", bitNode: 1 },
      },
      result: { reached: true, timeToGoalMs: 1, validity: "valid", stoppedBecause: "goal" },
    };
    expect(() => assertPromotableSession(base)).toThrow("only bitnode-route");
    expect(() => assertPromotableSession({
      ...base,
      experiment: {
        class: "bitnode-route",
        entrance: { kind: "fresh", bitNode: 1 },
        route: { route: "r", leg: "l", index: 0, bitNode: 1 },
      },
      result: { ...base.result!, validity: "invalid-for-goal" },
    })).toThrow("valid fidelity");
  });

  test("separate simulator invocations always get fresh lineage ids", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bb-lineages-"));
    try {
      const a = new SimArtifactSession({ outDir: dir, label: "same", seed: 1 });
      const b = new SimArtifactSession({ outDir: dir, label: "same", seed: 1 });
      expect(a.identity.id).not.toBe(b.identity.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

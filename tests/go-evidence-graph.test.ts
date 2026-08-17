import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_GRAPH_SCHEMA,
  EvidenceGraph,
  appendEvidenceRecords,
  comparisonPriority,
  exactStateId,
  makeEvidenceRecord,
  readEvidenceGraph,
  type ExactStateIdentity,
  type PairedComparisonEvidence,
  type StateEvidence,
} from "../go-ai/teacher/evidence-graph.ts";

const at = "2026-08-15T12:00:00.000Z";

function identity(profile: "small5" | "daemon19", stone = "."): ExactStateIdentity {
  const extent = profile === "small5" ? 5 : 19;
  return {
    profile, opponent: profile === "small5" ? "Netburners" : "????????????",
    board: Array.from({ length: extent }, () => stone.repeat(extent)),
    consecutivePasses: 0, historyHashes: [], dispatchPlaytime: 400,
    timingModel: "bitburner-go-ai-v3.0.1", komi: profile === "small5" ? 1.5 : 7.5,
    handicapIdentity: "seed:1",
  };
}

function state(value: ExactStateIdentity): StateEvidence {
  const stateId = exactStateId(value);
  return makeEvidenceRecord({
    schema: EVIDENCE_GRAPH_SCHEMA, kind: "state", recordedAt: at, stateId, identity: value,
  });
}

describe("persistent Go evidence graph", () => {
  test("keys exact Small5 and daemon19 states independently of a model", () => {
    expect(exactStateId(identity("small5"))).toHaveLength(64);
    expect(exactStateId(identity("small5"))).not.toBe(exactStateId(identity("daemon19")));
  });

  test("retains paired terminal regret and prioritizes reachable confident misses", () => {
    const root = state(identity("daemon19"));
    const win = state(identity("daemon19", "X"));
    const loss = state(identity("daemon19", "O"));
    const comparison: PairedComparisonEvidence = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "paired-comparison", recordedAt: at,
      stateId: root.stateId, modelSha256: "a".repeat(64),
      continuationModelSha256: "b".repeat(64), evaluatorVersion: "search-v1",
      phaseDefenseStreamId: "phase:1:defense:2", searchBudget: "visits:64",
      branches: [
        { action: 0, outcome: { completed: true, won: true, blackPower: 20,
          totalTurns: 12, terminalStateId: win.stateId } },
        { action: 1, outcome: { completed: true, won: false, blackPower: 4,
          totalTurns: 13, terminalStateId: loss.stateId } },
      ], preferredAction: 0, regret: 0.8, confidence: 0.75, reachProbability: 0.5,
    });
    const graph = new EvidenceGraph();
    graph.addAll([root, win, loss, comparison]);
    expect(comparisonPriority(comparison)).toBeCloseTo(0.3);
  });

  test("appends complete records and rejects duplicate evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "go-evidence-"));
    const path = join(directory, "book.jsonl");
    const record = state(identity("small5"));
    try {
      await appendEvidenceRecords(path, [record]);
      expect((await readEvidenceGraph(path)).states.size).toBe(1);
      await expect(appendEvidenceRecords(path, [record])).rejects.toThrow("duplicate evidence");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps KataGo-disagreed champion actions hypothetical until paired proof", () => {
    const root = state(identity("daemon19"));
    const win = state(identity("daemon19", "X"));
    const loss = state(identity("daemon19", "O"));
    const champion = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "teacher-observation", recordedAt: at,
      stateId: root.stateId, teacher: "champion", action: 7,
      observerVersion: "v9.5", modelSha256: "c".repeat(64),
    });
    const katago = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "teacher-observation", recordedAt: at,
      stateId: root.stateId, teacher: "katago", action: 8, approvedActions: [8, 9],
      observerVersion: "kata-v1",
    });
    const hypothesis = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "authority-classification", recordedAt: at,
      stateId: root.stateId, teacherObservationId: champion.recordId,
      katagoObservationId: katago.recordId, classification: "novel-hypothesis",
    });
    const comparison: PairedComparisonEvidence = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "paired-comparison", recordedAt: at,
      stateId: root.stateId, modelSha256: "d".repeat(64),
      continuationModelSha256: "e".repeat(64), evaluatorVersion: "search-v1",
      phaseDefenseStreamId: "phase:3:defense:5", searchBudget: "visits:64",
      branches: [
        { action: 7, outcome: { completed: true, won: true, blackPower: 30,
          totalTurns: 20, terminalStateId: win.stateId } },
        { action: 8, outcome: { completed: true, won: false, blackPower: 5,
          totalTurns: 18, terminalStateId: loss.stateId } },
      ], preferredAction: 7, regret: 1, confidence: 1, reachProbability: 0.25,
    });
    const exploit = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "authority-classification", recordedAt: at,
      stateId: root.stateId, teacherObservationId: champion.recordId,
      katagoObservationId: katago.recordId, classification: "opponent-exploit",
      pairedComparisonId: comparison.recordId,
    });
    const graph = new EvidenceGraph();
    graph.addAll([root, win, loss, champion, katago, hypothesis]);
    expect(() => new EvidenceGraph().addAll([root, win, loss, champion, katago, exploit]))
      .toThrow("lacks a matched comparison");
    graph.addAll([comparison, exploit]);
    expect(graph.records.has(exploit.recordId)).toBe(true);
  });

  test("treats the full KataGo good set as agreement, not only root top-1", () => {
    const root = state(identity("small5"));
    const champion = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "teacher-observation", recordedAt: at,
      stateId: root.stateId, teacher: "champion", action: 9,
      observerVersion: "v9.5", modelSha256: "f".repeat(64),
    });
    const katago = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "teacher-observation", recordedAt: at,
      stateId: root.stateId, teacher: "katago", action: 8,
      approvedActions: [8, 9], observerVersion: "kata-v1",
    });
    const general = makeEvidenceRecord({
      schema: EVIDENCE_GRAPH_SCHEMA, kind: "authority-classification", recordedAt: at,
      stateId: root.stateId, teacherObservationId: champion.recordId,
      katagoObservationId: katago.recordId, classification: "general-go",
    });
    const graph = new EvidenceGraph();
    graph.addAll([root, champion, katago, general]);
    expect(graph.records.has(general.recordId)).toBe(true);
  });
});

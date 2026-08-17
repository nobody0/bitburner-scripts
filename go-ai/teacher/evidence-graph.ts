/** Append-only, model-independent Go correction evidence shared by both profiles. */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";

export const EVIDENCE_GRAPH_SCHEMA = "bitburner-go-evidence-graph-v1";
export type EvidenceProfile = "small5" | "daemon19";

export interface ExactStateIdentity {
  profile: EvidenceProfile;
  opponent: string;
  board: string[];
  consecutivePasses: number;
  /** Collision-checked hashes in chronological order, including the parent state. */
  historyHashes: string[];
  dispatchPlaytime: number;
  timingModel: string;
  komi: number;
  handicapIdentity: string;
}

interface EvidenceBase {
  schema: typeof EVIDENCE_GRAPH_SCHEMA;
  recordId: string;
  recordedAt: string;
}

export interface StateEvidence extends EvidenceBase {
  kind: "state";
  stateId: string;
  identity: ExactStateIdentity;
}

export interface RuleOutcome {
  whiteAction: number;
  probability: number;
  stateId: string;
}

export interface RuleEdgeEvidence extends EvidenceBase {
  kind: "rule-edge";
  stateId: string;
  blackAction: number;
  afterBlackStateId: string;
  whiteOutcomes: RuleOutcome[];
  rulesVersion: string;
}

export interface ModelObservationEvidence extends EvidenceBase {
  kind: "model-observation";
  stateId: string;
  modelSha256: string;
  logitsSha256: string;
  selectedAction: number;
  shortlist: number[];
}

export type TeacherAuthority = "katago" | "handcrafted" | "champion" |
  "certified-playbook";

/** A raw, versioned teacher choice. It deliberately makes no authority claim. */
export interface TeacherObservationEvidence extends EvidenceBase {
  kind: "teacher-observation";
  stateId: string;
  teacher: TeacherAuthority;
  action: number;
  /** Optional multi-positive good set (notably KataGo's root shortlist). */
  approvedActions?: number[];
  observerVersion: string;
  /** Required for observations made by a neural champion. */
  modelSha256?: string;
}

export type AuthorityClass = "general-go" | "opponent-exploit" | "novel-hypothesis";

/**
 * A revisable interpretation of immutable observations. KataGo disagreement is
 * never sufficient by itself to claim an exploit: that requires a matched
 * paired comparison preferring the observed action.
 */
export interface AuthorityClassificationEvidence extends EvidenceBase {
  kind: "authority-classification";
  stateId: string;
  teacherObservationId: string;
  katagoObservationId: string;
  classification: AuthorityClass;
  pairedComparisonId?: string;
}

export interface CompletedTerminalOutcome {
  completed: true;
  won: boolean;
  blackPower: number;
  totalTurns: number;
  terminalStateId: string;
}

export interface IncompleteOutcome {
  completed: false;
  leafEvaluation?: number;
}

export interface ComparedBranch {
  action: number;
  outcome: CompletedTerminalOutcome | IncompleteOutcome;
}

export interface PairedComparisonEvidence extends EvidenceBase {
  kind: "paired-comparison";
  stateId: string;
  modelSha256: string;
  continuationModelSha256: string;
  evaluatorVersion: string;
  phaseDefenseStreamId: string;
  searchBudget: string;
  branches: [ComparedBranch, ComparedBranch];
  preferredAction: number;
  regret: number;
  confidence: number;
  reachProbability: number;
}

export type EvidenceRecord = StateEvidence | RuleEdgeEvidence |
  ModelObservationEvidence | TeacherObservationEvidence |
  AuthorityClassificationEvidence | PairedComparisonEvidence;
type EvidenceRecordInput = EvidenceRecord extends infer Record
  ? Record extends EvidenceRecord ? Omit<Record, "recordId"> : never
  : never;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function exactStateId(identity: ExactStateIdentity): string {
  return evidenceHash({ kind: "exact-go-state-v1", identity });
}

export function recordId(record: EvidenceRecordInput): string {
  return evidenceHash(record);
}

function sha256(value: string, where: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${where} must be lowercase SHA-256`);
}

function probability(value: number, where: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${where} must be in [0, 1]`);
  }
}

export class EvidenceGraph {
  readonly records = new Map<string, EvidenceRecord>();
  readonly states = new Map<string, StateEvidence>();

  add(record: EvidenceRecord): void {
    if (record.schema !== EVIDENCE_GRAPH_SCHEMA) throw new Error("incompatible evidence schema");
    sha256(record.recordId, "recordId");
    if (this.records.has(record.recordId)) throw new Error(`duplicate evidence record ${record.recordId}`);
    if (!Number.isFinite(Date.parse(record.recordedAt))) throw new Error("invalid recordedAt");
    const { recordId: ignoredRecordId, ...unsigned } = record;
    void ignoredRecordId;
    if (record.recordId !== recordId(unsigned)) throw new Error("evidence recordId mismatch");

    if (record.kind === "state") {
      if (record.stateId !== exactStateId(record.identity)) throw new Error("exact stateId mismatch");
      const { identity } = record;
      const extent = identity.profile === "small5" ? 5 : 19;
      if (identity.board.length !== extent || identity.board.some((row) => row.length !== extent)) {
        throw new Error("evidence board/profile extent mismatch");
      }
      if (!Number.isSafeInteger(identity.consecutivePasses) || identity.consecutivePasses < 0) {
        throw new Error("invalid consecutive passes");
      }
      identity.historyHashes.forEach((hash, index) => sha256(hash, `historyHashes[${index}]`));
      this.states.set(record.stateId, record);
    } else {
      if (!this.states.has(record.stateId)) throw new Error(`unknown evidence state ${record.stateId}`);
      if (record.kind === "rule-edge") {
        if (!this.states.has(record.afterBlackStateId)) throw new Error("unknown after-Black state");
        if (!record.whiteOutcomes.length) throw new Error("rule edge has no White outcomes");
        let mass = 0;
        for (const outcome of record.whiteOutcomes) {
          probability(outcome.probability, "White outcome probability");
          if (!this.states.has(outcome.stateId)) throw new Error("unknown post-reply state");
          mass += outcome.probability;
        }
        if (Math.abs(mass - 1) > 1e-6) throw new Error("White outcome probability does not sum to one");
      } else if (record.kind === "model-observation") {
        sha256(record.modelSha256, "modelSha256");
        sha256(record.logitsSha256, "logitsSha256");
        if (!record.shortlist.includes(record.selectedAction)) {
          throw new Error("selected action is absent from model shortlist");
        }
      } else if (record.kind === "teacher-observation") {
        if (!Number.isSafeInteger(record.action) || record.action < 0) {
          throw new Error("invalid teacher action");
        }
        if (!record.observerVersion) throw new Error("teacher observerVersion is required");
        if (record.approvedActions) {
          if (!record.approvedActions.includes(record.action)
              || new Set(record.approvedActions).size !== record.approvedActions.length
              || record.approvedActions.some((action) => !Number.isSafeInteger(action) || action < 0)) {
            throw new Error("invalid teacher approved-action set");
          }
        }
        if (record.teacher === "champion") {
          if (!record.modelSha256) throw new Error("champion observation lacks model SHA");
          sha256(record.modelSha256, "modelSha256");
        } else if (record.modelSha256) {
          sha256(record.modelSha256, "modelSha256");
        }
      } else if (record.kind === "authority-classification") {
        const teacher = this.records.get(record.teacherObservationId);
        const katago = this.records.get(record.katagoObservationId);
        if (teacher?.kind !== "teacher-observation" || teacher.teacher === "katago") {
          throw new Error("authority classification lacks non-KataGo teacher observation");
        }
        if (katago?.kind !== "teacher-observation" || katago.teacher !== "katago") {
          throw new Error("authority classification lacks KataGo observation");
        }
        if (teacher.stateId !== record.stateId || katago.stateId !== record.stateId) {
          throw new Error("authority observations refer to another state");
        }
        const agrees = (katago.approvedActions ?? [katago.action]).includes(teacher.action);
        if (record.classification === "general-go" && !agrees) {
          throw new Error("KataGo-disagreed action cannot be classified as general Go");
        }
        if (record.classification !== "general-go" && agrees) {
          throw new Error("KataGo-agreed action cannot be classified as disagreement evidence");
        }
        if (record.classification === "opponent-exploit") {
          const comparison = record.pairedComparisonId
            ? this.records.get(record.pairedComparisonId) : undefined;
          if (comparison?.kind !== "paired-comparison"
              || comparison.stateId !== record.stateId
              || comparison.preferredAction !== teacher.action) {
            throw new Error("opponent exploit lacks a matched comparison preferring its action");
          }
        } else if (record.pairedComparisonId) {
          throw new Error("pairedComparisonId is only valid for proven opponent exploits");
        }
      } else {
        sha256(record.modelSha256, "modelSha256");
        sha256(record.continuationModelSha256, "continuationModelSha256");
        probability(record.confidence, "confidence");
        probability(record.reachProbability, "reachProbability");
        if (!Number.isFinite(record.regret) || record.regret < 0) throw new Error("invalid regret");
        const actions = record.branches.map((branch) => branch.action);
        if (actions[0] === actions[1]) throw new Error("paired comparison repeats one action");
        if (!actions.includes(record.preferredAction)) throw new Error("preferred action was not compared");
        for (const branch of record.branches) {
          if (branch.outcome.completed) {
            if (!this.states.has(branch.outcome.terminalStateId)) {
              throw new Error("unknown completed terminal state");
            }
            if (!Number.isFinite(branch.outcome.blackPower)
                || !Number.isSafeInteger(branch.outcome.totalTurns)
                || branch.outcome.totalTurns < 1) throw new Error("invalid terminal outcome");
          }
        }
      }
    }
    this.records.set(record.recordId, record);
  }

  addAll(records: Iterable<EvidenceRecord>): void {
    for (const record of records) this.add(record);
  }
}

export function comparisonPriority(record: PairedComparisonEvidence): number {
  return record.reachProbability * record.confidence * record.regret;
}

export async function readEvidenceGraph(path: string): Promise<EvidenceGraph> {
  const graph = new EvidenceGraph();
  if (!await Bun.file(path).exists()) return graph;
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  if (lines.at(-1) !== "") throw new Error("evidence graph ends in a partial record");
  graph.addAll(lines.slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as EvidenceRecord));
  return graph;
}

/** Validate against the current revision, then append complete fsynced JSONL records. */
export async function appendEvidenceRecords(path: string, additions: EvidenceRecord[]): Promise<void> {
  if (!additions.length) return;
  const graph = await readEvidenceGraph(path);
  graph.addAll(additions);
  const handle = await open(path, "a");
  try {
    await handle.writeFile(additions.map((record) => `${JSON.stringify(record)}\n`).join(""));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function makeEvidenceRecord<T extends EvidenceRecordInput>(record: T): T & { recordId: string } {
  return { ...record, recordId: recordId(record) };
}

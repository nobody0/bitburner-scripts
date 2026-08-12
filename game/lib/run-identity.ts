import type { NS, ResetInfo } from "@ns";
import {
  bitNodeRunId,
  installRunId,
  shortIdentity,
  type ArtifactIdentity,
  type LineageIdentity,
} from "../../shared/run-identity.ts";
import { dodge, priceCalls } from "./dodge.ts";
import { gameGlobal } from "./globals.ts";

/** Text files on home survive both augmentation and Source-File prestige in
 * Bitburner v3.0.1. Keep this outside the synced source tree so deployment
 * never replaces the live save's identity. */
export const SAVE_ID_FILE = "data/run-lineage.txt";
const MARKER_VERSION = 1;

interface SaveMarker {
  v: typeof MARKER_VERSION;
  id: string;
  label: string;
  createdAt: number;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function marker(raw: string): SaveMarker | undefined {
  if (!raw.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<SaveMarker>;
    if (value.v !== MARKER_VERSION || typeof value.id !== "string" || typeof value.label !== "string") return;
    if (typeof value.createdAt !== "number") return;
    return value as SaveMarker;
  } catch {
    return;
  }
}

function lineageFrom(markerValue: SaveMarker): LineageIdentity {
  return {
    id: markerValue.id,
    kind: "game",
    label: markerValue.label,
    createdAt: markerValue.createdAt,
  };
}

/** Resolve identity before recording starts. This is acquisition, not sending,
 * and therefore runs in both ordinary and --perf builds. */
export async function resolveRunIdentity(ns: NS, handoff = false): Promise<ArtifactIdentity> {
  const inherited = gameGlobal.artifactIdentity;
  if (handoff && inherited) return inherited;

  let saved = marker(ns.read(SAVE_ID_FILE));
  if (!saved) {
    const id = newId();
    saved = { v: MARKER_VERSION, id, label: `game save ${shortIdentity(id)}`, createdAt: Date.now() };
    await ns.write(SAVE_ID_FILE, JSON.stringify(saved), "w");
  }

  const budget = priceCalls(ns, ["getResetInfo"]);
  const reset = await dodge(ns, (stubNs) => stubNs["getResetInfo"](), budget) as ResetInfo;
  const lineage = lineageFrom(saved);
  const nodeId = bitNodeRunId(lineage.id, reset.lastNodeReset);
  const identity: ArtifactIdentity = {
    lineage,
    bitNode: { id: nodeId, bitNode: reset.currentNode, startedAt: reset.lastNodeReset },
    install: {
      id: installRunId(nodeId, lineage.id, reset.lastAugReset),
      startedAt: reset.lastAugReset,
    },
  };
  gameGlobal.artifactIdentity = identity;
  return identity;
}

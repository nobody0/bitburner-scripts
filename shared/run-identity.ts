/** Hierarchical identity for recorded run artifacts.
 *
 * An emitter is a process/socket lifetime. An install is the useful replay
 * artifact. Several emitters (a deployment handoff, reconnect, or manual
 * restart) may therefore contribute to the same install. */

export type LineageKind = "game" | "sim";

export interface LineageIdentity {
  /** Stable across every reset of one real save; fresh for every simulator run. */
  id: string;
  kind: LineageKind;
  label: string;
  /** Real wall-clock creation time. Simulator virtual time does not belong here. */
  createdAt: number;
  /** Registered snapshot used only as input; never the simulator lineage id. */
  seededFrom?: string;
}

export interface BitNodeRunIdentity {
  /** Stable within one visit, including revisiting the same numbered BitNode. */
  id: string;
  bitNode: number;
  /** Game reset epoch, or the simulator's virtual epoch for this visit. */
  startedAt: number;
}

export interface InstallRunIdentity {
  /** Stable through controller restarts and build handoffs within this install. */
  id: string;
  /** Game reset epoch, or simulator virtual epoch. */
  startedAt: number;
  /** Zero-based ordinal within the BitNode run when known. */
  index?: number;
}

export interface ArtifactIdentity {
  lineage: LineageIdentity;
  /** Optional only for deliberately node-less, single-install simulator work. */
  bitNode?: BitNodeRunIdentity;
  install: InstallRunIdentity;
}

/** Epochs are authoritative game identities. Prefixing with the parent keeps
 * old imported saves whose timestamps happen to match from colliding. */
export function bitNodeRunId(lineageId: string, startedAt: number): string {
  return `${lineageId}:bn:${Math.trunc(startedAt).toString(36)}`;
}

export function installRunId(bitNodeId: string | undefined, lineageId: string, startedAt: number): string {
  return `${bitNodeId ?? lineageId}:install:${Math.trunc(startedAt).toString(36)}`;
}

/** Short, readable suffix for default labels without making the label itself
 * an identity or exposing a whole UUID in the picker. */
export function shortIdentity(id: string): string {
  return id.replaceAll(/[^a-z0-9]/gi, "").slice(-6).toUpperCase() || "NEW";
}

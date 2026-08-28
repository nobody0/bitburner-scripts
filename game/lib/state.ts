import type { ContractQueueEntry, DarknetContractListing } from "./contracts.ts";
import { applyOverrides, type FeatureOverrides } from "../../shared/features/profile.ts";
import { unknownCapabilities, type Capabilities } from "../../shared/features/unlock.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";
import type { ContractFailure, ContractOrigin, ContractOriginTotals, ContractSolveReport } from "../../shared/telemetry/topics/side.ts";
import { gameGlobal } from "./globals.ts";

/** The game-state copy: the script's own model of the world, and the single
 * write target for every acquisition path (the sweep scan, ns.getPlayer, the
 * capability gates, every probe, the dispatcher rollup).
 *
 * This module deliberately imports nothing from ./telemetry.ts. Acquisition is
 * unconditional; telemetry is a downstream reader (./telemetry-sink.ts) that
 * also sends this copy over the wire. A --perf build carries this whole module
 * and every writer of it — only the sending disappears. Nothing here may ever
 * be moved behind `TELEMETRY: if (__TELEMETRY__)`, because then the two builds
 * would no longer play the same game.
 *
 * Topics are keyed by shared/telemetry/state-map.ts, so the store, the wire and
 * the UI projection all carry the same shapes by construction. */

export type Topics = { [K in StateKey]?: StateMap[K] };

export interface ProbeBatch {
  ids: string[];
}

export interface GameState {
  topics: Topics;
  /** Topic keys written since the last flush. */
  dirty: Set<StateKey>;
  /** Getter-mirror key space (`getServer:home`). Kept apart from topics: it
   *  is keyed by the ns call, not by the state map. */
  mirrors: Record<string, unknown>;
  mirrorDirty: Set<string>;
  /** Last error per probe id; cleared when the probe next succeeds. */
  probeFailures: Record<string, string>;
  probeBatch?: ProbeBatch;
  /** Last tick each feature driver ran, by feature id. */
  featureLastRun: Record<string, number>;
  /** Wall-clock time of the last unconditional ns.getPlayer snapshot. Kept
   * private so time-sensitive strategies can advance totalPlaytime honestly. */
  playerObservedAt?: number;
  /** Something just changed the player's MULTIPLIERS, so the cadenced snapshot
   * below is describing a player who no longer exists. Set by any feature whose
   * action moves `mults` -- an IPvGO game ending, an augmentation install --
   * and cleared by the controller's next refresh.
   *
   * This exists because a stale multiplier is not merely imprecise to the
   * batcher, it is actively wrong: hack/grow/weaken durations are derived from
   * `hacking_speed`, the dispatcher pads each op with
   * `landing - now - duration`, and an overstated duration lands the op early
   * in proportion to its own length. A feature that can hand over the fresh
   * snapshot it already holds should do that instead (the Go driver does); this
   * is the backstop for the ones that cannot. */
  playerDirty?: boolean;
  /** Coding contracts rejected once are never automatically retried. Kept
   * outside topics so the full quarantine never reaches telemetry. */
  contractQuarantine?: Record<string, ContractFailure>;
  /** Cumulative contract earnings by origin, plus the most recent solves.
   *
   * Kept outside topics for the same reason as `contractQuarantine`: the topic
   * carries a rounded projection and the store keeps the exact running sum, so
   * repeated publishing never rounds an already-rounded total. */
  contractLedger?: {
    since?: number;
    totals: Partial<Record<ContractOrigin, ContractOriginTotals>>;
    recent: ContractSolveReport[];
  };
  /** Private bounded work queue. The Side topic exposes only its front batch
   * plus totals, so this never gets serialized into telemetry. */
  contractQueue?: ContractQueueEntry[];
  /** Authoritative resident observations used to validate darknet work. */
  darknetContractListings?: Record<string, DarknetContractListing>;
  /** Newest listing already given a terminal solver outcome, by contract key. */
  darknetContractHandledAt?: Record<string, number>;
  /** Darknet hosts whose files may have changed after Side touched a contract.
   * Home forwards these stamps to the remote controller, then clears them. */
  darknetContractRefreshHosts?: Record<string, number>;
  /** Injected feature switches. Empty in the real game; a simulation sets them
   *  to isolate a feature. Applied in caps(), so every consumer agrees. */
  featureOverrides?: FeatureOverrides;
}

function emptyState(): GameState {
  return {
    topics: {},
    dirty: new Set(),
    mirrors: {},
    mirrorDirty: new Set(),
    probeFailures: {},
    featureLastRun: {},
  };
}

/** Return the current controller's realm store, or create it. main.ts deletes
 * the previous store before a post-sync launch. */
export function initState(): GameState {
  const existing = gameGlobal.state;
  if (!existing) {
    const fresh = emptyState();
    gameGlobal.state = fresh;
    return fresh;
  }
  existing.dirty = new Set(Object.keys(existing.topics) as StateKey[]);
  existing.mirrorDirty = new Set(Object.keys(existing.mirrors));
  return existing;
}

export function set<K extends StateKey>(state: GameState, key: K, value: StateMap[K]): void {
  state.topics[key] = value;
  state.dirty.add(key);
}

/** Shallow-merge a patch over the current topic value.
 *
 * Several probes contribute to one topic at different cost tiers (the free
 * `factions.joined` and the SF4-gated `standings`, say). Without merging, the
 * cheap tier would clobber the expensive one every sweep. `undefined` fields
 * are dropped so an absent optional never erases a value we already have —
 * a stale field simply persists until its probe runs again. */
export function merge<K extends StateKey>(state: GameState, key: K, patch: Partial<StateMap[K]>): void {
  const defined: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value !== undefined) defined[field] = value;
  }
  const previous = state.topics[key] as Record<string, unknown> | undefined;
  state.topics[key] = (previous ? { ...previous, ...defined } : defined) as StateMap[K];
  state.dirty.add(key);
}

export function setMirror(state: GameState, key: string, value: unknown): void {
  state.mirrors[key] = value;
  state.mirrorDirty.add(key);
}

/** What the save can play right now. Never undefined: before the first gate
 * batch every feature reads "unknown", which is distinct from "locked" and is
 * what stops a driver running on a feature we simply have not looked at.
 *
 * The single place injected overrides are applied, so the feature drivers, the
 * probe gating and the UI cannot disagree about which features this run may
 * use. Acquisition is untouched — the store still holds what the save really
 * has. */
export function caps(state: GameState): Capabilities {
  return applyOverrides(state.topics.capabilities ?? unknownCapabilities(), state.featureOverrides);
}

export function recordProbeFailure(state: GameState, id: string, error: unknown): void {
  state.probeFailures[id] = String(error);
}

export function clearProbeFailure(state: GameState, id: string): void {
  delete state.probeFailures[id];
}

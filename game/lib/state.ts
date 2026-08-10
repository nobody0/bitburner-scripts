import { applyOverrides, type FeatureOverrides } from "../../shared/features/profile.ts";
import { unknownCapabilities, type Capabilities } from "../../shared/features/unlock.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";
import type { ContractFailure } from "../../shared/telemetry/topics/side.ts";
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

/** A probe that could not afford its dodge budget, with the price that made it
 * unaffordable — so the sink can report a price change once rather than the
 * same skip every sweep. */
export interface ProbeSkip {
  cost: number;
  budget: number;
  /** When the skip was last observed. A skip that stops being re-recorded is
   *  a need that went away without a successful retry (the invite arrived
   *  another way, the decision moved on) — consumers age those out rather
   *  than letting a dead entry hold the fleet reserve forever. */
  at: number;
}

export interface ProbeBatch {
  ids: string[];
  cost: number;
  budget: number;
}

export interface GameState {
  topics: Topics;
  /** Topic keys written since the last flush. */
  dirty: Set<StateKey>;
  /** Getter-mirror key space (`getServer:home`), fed by makeDodger. Kept apart
   *  from topics: it is keyed by the ns call, not by the state map. */
  mirrors: Record<string, unknown>;
  mirrorDirty: Set<string>;
  /** Last error per probe id; cleared when the probe next succeeds. */
  probeFailures: Record<string, string>;
  probeSkips: Record<string, ProbeSkip>;
  probeBatch?: ProbeBatch;
  /** Last tick each feature driver ran, by feature id. Survives handoffs, so a
   *  build push does not restart every cadence. */
  featureLastRun: Record<string, number>;
  /** Wall-clock time of the last unconditional ns.getPlayer snapshot. Kept
   * private so time-sensitive strategies can advance totalPlaytime honestly. */
  playerObservedAt?: number;
  /** Coding contracts rejected once are never automatically retried. Kept
   * outside topics so the full quarantine never reaches telemetry. */
  contractQuarantine?: Record<string, ContractFailure>;
  /** Private bounded work queue. The Side topic exposes only its front batch
   * plus totals, so this never gets serialized into telemetry. */
  contractQueue?: { host: string; file: string }[];
  contractSolverVersion?: number;
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
    probeSkips: {},
    featureLastRun: {},
  };
}

/** Rehydrate the realm's store, or create it. On handoff the incoming
 * controller inherits everything the outgoing one knew — but its telemetry run
 * is new, so every known topic is marked dirty and the next flush republishes a
 * full snapshot rather than leaving the UI blank until each cadence comes
 * round again. */
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

export function recordProbeSkip(state: GameState, id: string, cost: number, budget: number): void {
  state.probeSkips[id] = { cost, budget, at: Date.now() };
}

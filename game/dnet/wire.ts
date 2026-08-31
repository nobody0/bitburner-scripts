import type { VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import type { DnetTimingProfile } from "../../shared/strategy/dnet/rates.ts";
import type { TaskKind } from "../../shared/strategy/dnet/jobs.ts";
import type { FarmEconomics } from "../../shared/strategy/dnet/farm.ts";
import type { DarknetProfit, DarknetResidentRam } from "../../shared/telemetry/topics/dnet.ts";
import type { DnetKnowledge } from "../../shared/strategy/dnet/host.ts";

/** The data shapes home and the controller exchange, and the panel reads.
 *
 * Pure types plus one fold helper — no runtime, no realm. Home takes an
 * immutable `DnetSnapshot` and pushes `DnetInputs`; both sides render the
 * report shapes. */

export interface RefusalExample {
  host: string;
  why: string;
  detail: string;
}

/** A SNAPSHOT of the last derivation's refusals, not a counter. */
export interface RefusalRollup {
  refused: Record<string, number>;
  examples: RefusalExample[];
}

/** Roll a planner's refusal list up into counts plus one example per reason. */
export function foldRefusals(entries: readonly RefusalExample[]): RefusalRollup {
  const refused: Record<string, number> = {};
  const examples: RefusalExample[] = [];
  for (const entry of entries) {
    refused[entry.why] = (refused[entry.why] ?? 0) + 1;
    if (refused[entry.why] === 1) examples.push(entry);
  }
  return { refused, examples };
}

export interface DnetSpreadReport extends RefusalRollup {
  planted: number;
  /** Why each still-empty host was not planted, by hostname.
   *
   * The rollup counts reasons and keeps one example each, which answers "what
   * is holding the net back" but never "why is THAT host empty" — and that is
   * the question anyone looking at the map actually has. Bounded by the size
   * of the net, and only ever carries hosts with no agent. */
  why?: Record<string, string>;
}

export interface DnetFarmReport extends RefusalRollup {
  admitted: Record<string, number>;
  cacheHunter?: string;
  expectedMoneyPerSec: number;
  expectedCharismaExpPerSec: number;
}

export interface DnetHoldReport extends RefusalRollup {
  admitted: Record<string, number>;
}

export interface DnetStormReport extends RefusalRollup {
  admitted: number;
  seedHost?: string;
  seedSeenAt?: number;
  firedAt?: number;
  seedHunt?: boolean;
}

export interface DnetStasisSnapshot {
  hosts: string[];
  at: number;
}

/** One PID-bound walker, as the controller can see it from its entry. */
export interface DnetLabWalker {
  from: string;
  at?: string;
  moves: number;
  walls: number;
  radars: number;
  attempts: number;
  believedLeft?: number;
  startedAt: number;
  beatAt: number;
  pinned: boolean;
}

/** The labyrinth as the panel needs it. */
export interface DnetLabReport {
  host: string;
  width: number;
  height: number;
  grid: string;
  candidates: string[];
  exitKnown: boolean;
  walkers: DnetLabWalker[];
}

/** Version of the private, in-realm controller checkpoint. This is deliberately
 * independent of the agent protocol: a build may keep its process handshake
 * while changing what can safely be restored into a new controller. */
export const DNET_RECOVERY_VERSION = 2 as const;

/** Durable controller-owned state. No process handles, promises, borrowed NS
 * objects, queues, or launch windows may enter this shape. It may contain
 * credentials and therefore must never be merged into telemetry. */
export interface DnetRecoveryState {
  version: typeof DNET_RECOVERY_VERSION;
  generation: string;
  capturedAt: number;
  knowledge: DnetKnowledge;
  vault: VaultEntry[];
  codes: Record<string, number>;
  spread?: DnetSpreadReport;
  farm?: DnetFarmReport;
  hold?: DnetHoldReport;
  storm?: DnetStormReport;
  lab?: DnetLabReport;
  stasisSnapshot?: DnetStasisSnapshot;
  /** Latest controller evidence that a home-installed backdoor no longer
   * provides remote execution. Idempotent timestamps make snapshots repeatable. */
  backdoorInvalidations?: { hostname: string; at: number }[];
  charismaNeeded?: number;
  karmaLoss: number;
  profit: DarknetProfit;
  grammar?: { unrecognised: number; lines: Record<string, number> };
  lastPhishCacheAt?: number;
  lastStormAt?: number;
  unknownModels: Record<string, number>;
  agentHostsSeen: string[];
  residentsLost: number;
}

export interface DnetResidentSnapshot {
  host: string;
  lastBeatAt: number;
  pending: number;
  active?: TaskKind;
  /** Targets of the active order. Empty when no job is running; a plant may
   * fan out to several hosts. */
  targets: string[];
  /** Exact RAM held by dnet-owned processes on this host. */
  ram: DarknetResidentRam;
  freeGb?: number;
  completed: number;
  failed: number;
  lastError?: string;
}

export interface DnetRamSnapshot {
  host: string;
  at: number;
  total: number;
  blocked: number;
  used: number;
}

/** Non-destructive view read by home. `recovery` replaces home's prior cache
 * whole; repeated reads therefore cannot double-count anything. */
export interface DnetSnapshot {
  recovery: DnetRecoveryState;
  residents: DnetResidentSnapshot[];
  ram: DnetRamSnapshot[];
  controllerBeatAt: number;
}

export interface DnetInputs {
  charisma: number;
  /** Complete only when home has cached every upstream authentication input. */
  timing?: DnetTimingProfile;
  netDepth?: number;
  bitNode?: number;
  openLabCache?: boolean;
  /** Complete snapshot; absence means there are no symbols to promote. */
  promoteSymbols?: { symbol: string; expectedProfit: number }[];
  crimeSuccessMult?: number;
  farmEconomics?: FarmEconomics;
  /** Home-side contract attempts can consume a remote `.cct`; the controller
   * must invalidate its private listing and run `ls` again. */
  fileInvalidations?: { host: string; at: number }[];
  stasisSnapshot?: DnetStasisSnapshot;
  backdoors?: { hostname: string; installedAt: number }[];
  labExpected?: boolean;
  stasisLimit?: number;
}

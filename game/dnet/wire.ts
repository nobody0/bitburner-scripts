import type { AttemptOutcome, LogDrainOutcome, ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import type { DnetTimingProfile } from "../../shared/strategy/dnet/rates.ts";
import type { FarmEconomics } from "../../shared/strategy/dnet/farm.ts";
import type { DarknetProfit } from "../../shared/telemetry/topics/dnet.ts";

/** The data shapes home and the controller exchange, and the panel reads.
 *
 * Pure types plus one fold helper — no runtime, no realm. Home drains a
 * `DnetDrain` and pushes a `DnetOrders`; both sides render the report shapes. */

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

export interface DnetCredentialRejection {
  hostname: string;
  identity?: string;
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

export interface DnetDrain {
  hosts: ReportHost[];
  credentials: VaultEntry[];
  attempts: { hostname: string; outcome: AttemptOutcome }[];
  logDrains: { hostname: string; outcome: LogDrainOutcome }[];
  codes: Record<string, number>;
  spread?: DnetSpreadReport;
  farm?: DnetFarmReport;
  hold?: DnetHoldReport;
  storm?: DnetStormReport;
  stormFiredAt?: number;
  stasisSnapshot?: DnetStasisSnapshot;
  credentialRejections: DnetCredentialRejection[];
  backdoorInvalidations: { hostname: string; at: number }[];
  charismaNeeded?: number;
  karmaLoss?: number;
  /** Since-last-drain returns, folded into home's cumulative digest. */
  profit?: Partial<DarknetProfit>;
  lastPhishCacheAt?: number;
  grammar?: { unrecognised: number; shapes: Record<string, number> };
  residents: {
    host: string;
    lastBeatAt: number;
    pending: number;
    active?: string;
    freeGb?: number;
    completed: number;
    failed: number;
    lastError?: string;
  }[];
  /** Live engine RAM, sampled together by the controller. */
  ram: {
    host: string;
    at: number;
    total: number;
    blocked: number;
    used: number;
  }[];
  residentsLost: number;
  mutations: number;
  lab?: DnetLabReport;
}

export interface DnetOrders {
  charisma: number;
  /** Complete only when home has cached every upstream authentication input. */
  timing?: DnetTimingProfile;
  vaultSnapshot?: { entries: VaultEntry[]; at: number };
  netDepth?: number;
  bitNode?: number;
  standDown?: boolean;
  openLabCache?: boolean;
  lastPhishCacheAt?: number;
  lastStormAt?: number;
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

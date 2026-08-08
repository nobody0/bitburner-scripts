import type { Skills } from "@ns";

/** Career feature — crime, karma, company work, combat stats. Problem: reach
 * the stat/karma/company-rep thresholds that other features depend on (BN2's
 * gang needs -54000 karma; Bladeburner needs 100 in every combat stat) for
 * the least time, while crime doubles as early income. */

export interface CrimeOption {
  name: string;
  chance: number;
  money: number;
  timeMs: number;
  karma: number;
  kills?: number;
  /** Experience granted on success, per skill. */
  exp?: Record<string, number>;
  /** money * chance / time — the ranking the optimizer cares about. */
  moneyPerSec: number;
}

/** The career decision digest. */
export interface CareerPlan {
  action: { type: string; subject?: string; why: string };
  why: string;
  /** True when no posted need could be served and career fell back to income. */
  incomeFallback: boolean;
  ranked: { label: string; score: number; moneyPerSec: number; why: string }[];
  /** Needs from the board this feature is currently working toward. */
  serving: { kind: string; subject?: string; weight: number; progress: number }[];
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}

export interface CareerState {
  karma: number;
  numPeopleKilled: number;
  skills: Skills;
  exp: Skills;
  city: string;
  location: string;
  entropy: number;
  totalPlaytime: number;
  jobs: Record<string, string>;
  /** ns.singularity.getCurrentWork() digest — needs BN4/SF4. */
  currentWork?: {
    type: string;
    detail?: string;
    focused?: boolean;
    /** Game cycles (200 ms each) already spent on this activity. */
    cyclesWorked?: number;
  };
  /** Ranked crimes — needs BN4/SF4 for chance/stats. */
  crimes?: CrimeOption[];
  /** Company name -> {rep, favor} for held jobs. Needs BN4/SF4. */
  companies?: Record<string, { rep: number; favor: number }>;
  /** The decision digest — what career chose and why. */
  plan?: CareerPlan;
}

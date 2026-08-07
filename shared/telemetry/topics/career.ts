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
  /** money * chance / time — the ranking the optimizer cares about. */
  moneyPerSec: number;
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
  currentWork?: { type: string; detail?: string; focused?: boolean };
  /** Ranked crimes — needs BN4/SF4 for chance/stats. */
  crimes?: CrimeOption[];
  /** Company name -> {rep, favor} for held jobs. Needs BN4/SF4. */
  companies?: Record<string, { rep: number; favor: number }>;
}

import type { GangTaskStats } from "../../strategy/gang/formulas.ts";
import type { GangDecision } from "../../strategy/gang/decide.ts";

/** Gang feature state. Upstream gain fields are per game cycle. */
export interface GangMemberDigest {
  name: string;
  task: string;
  respectGain: number;
  wantedLevelGain: number;
  moneyGain: number;
  skills: { hack: number; str: number; def: number; dex: number; agi: number; cha: number };
}

export interface GangState {
  faction: string;
  isHacking: boolean;
  respect: number;
  respectGainRate: number;
  wantedLevel: number;
  wantedLevelGainRate: number;
  wantedPenalty: number;
  moneyGainRate: number;
  territory: number;
  territoryWarfareEngaged: boolean;
  respectForNextRecruit: number;
  recruitsAvailable: number;
  members: GangMemberDigest[];
  tasks: GangTaskStats[];
  gangSoftcap: number;
  /** Member name to the policy multiplier gain used for ascension. */
  ascensionGain?: Record<string, number>;
  plan?: GangPlan;
}

export interface GangPlan extends GangDecision {
  lastResults?: { action: string; ok: boolean; detail: string; at: number }[];
}

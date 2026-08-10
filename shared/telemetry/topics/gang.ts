/** Gang feature — BN2's theme. Problem: assign each member to a task and
 * schedule ascensions/equipment so respect, money and territory grow without
 * the wanted-level penalty eating the gains. A multi-armed assignment problem
 * over a slowly-changing roster. */

export interface GangMemberDigest {
  name: string;
  task: string;
  earnedRespect: number;
  respectGain: number;
  wantedLevelGain: number;
  moneyGain: number;
  skills: { hack: number; str: number; def: number; dex: number; agi: number; cha: number };
  ascMults: { hack: number; str: number; def: number; dex: number; agi: number; cha: number };
  upgrades: number;
  augmentations: number;
  /** Multiplier gain if ascended right now, per stat. */
  ascensionResult?: { respect: number; hack: number; str: number; def: number; dex: number; agi: number; cha: number };
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
  power: number;
  territory: number;
  territoryClashChance: number;
  territoryWarfareEngaged: boolean;
  respectForNextRecruit: number;
  recruitsAvailable: number;
  canRecruit: boolean;
  members: GangMemberDigest[];
  /** Win chance against each rival gang. */
  clashChances?: Record<string, number>;
  bonusTime?: number;
  /** Per-member task rates, as the game reports them. The strategy scores
   *  against these; without them it would be inventing numbers. */
  taskRates?: Record<string, { name: string; respect: number; money: number; wanted: number }[]>;
  /** Member name -> ascension multiplier gain, for the crossover. */
  ascensionGain?: Record<string, number>;
  plan?: GangPlan;
}

export interface GangPlan {
  actions: { type: string; member?: string; task?: string; engage?: boolean }[];
  assignment: {
    total: number;
    approximated: boolean;
    choices: { member: string; task: string; score: number }[];
  };
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}

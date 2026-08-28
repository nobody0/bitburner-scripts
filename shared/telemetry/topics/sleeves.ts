/** Sleeves feature — BN10's theme. Assign sleeves across recovery,
 * synchronisation, crime, and faction work. Shock suppresses experience and
 * faction reputation but not crime money, karma, or kills; sync scales shared
 * experience and crime karma. Faction targets make allocation capacity-coupled. */

export interface SleeveDigest {
  index: number;
  shock: number;
  sync: number;
  memory: number;
  storedCycles: number;
  city: string;
  hp: { current: number; max: number };
  skills: { hacking: number; strength: number; defense: number; dexterity: number; agility: number; charisma: number; intelligence?: number };
  mults?: Partial<Record<string, number>>;
  /** SleeveTask digest — the union's `type` plus whichever detail applies. */
  task?: { type: string; detail?: string; workType?: string };
}

export interface SleevesState {
  count: number;
  sleeves: SleeveDigest[];
  plan?: SleevesPlan;
}

export interface SleevesPlan {
  assignments: { index: number; task: string }[];
  selection: { index: number; task: string; score: number }[];
  totalScore: number;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}

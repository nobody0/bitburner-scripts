/** Sleeves feature — BN10's theme. Problem: assign N sleeves across crime,
 * faction work, company work, training and synchronisation, accounting for
 * shock (which suppresses gains until recovered) and sync (which scales what
 * the host receives). N independent agents sharing one objective. */

export interface SleeveDigest {
  index: number;
  shock: number;
  sync: number;
  memory: number;
  storedCycles: number;
  city: string;
  hp: { current: number; max: number };
  skills: { hacking: number; strength: number; defense: number; dexterity: number; agility: number; charisma: number };
  /** SleeveTask digest — the union's `type` plus whichever detail applies. */
  task?: { type: string; detail?: string };
  augCount?: number;
  /** Cheapest augmentations still purchasable for this sleeve. */
  purchasableAugs?: { name: string; price: number }[];
}

export interface SleevesState {
  count: number;
  sleeves: SleeveDigest[];
  /** Cost of the next sleeve from The Covenant, if offered. */
  nextSleeveCost?: number;
  /** Task menu, priced per sleeve by the probe. */
  taskOptions?: {
    type: "recovery" | "synchro" | "crime" | "class" | "gym" | "faction" | "company" | "bladeburner";
    detail?: string;
    rates: Record<string, number>;
    moneyPerSec: number;
  }[];
  plan?: SleevesPlan;
}

export interface SleevesPlan {
  assignments: { index: number; task: string; why: string }[];
  why: string;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}

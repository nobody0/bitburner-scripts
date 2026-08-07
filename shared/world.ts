/** The game/sim seam. The simulator implements it today; a future live-game
 * adapter will produce the same WorldView snapshots and execute Actions. The
 * planner remains pure so that adapter can run it unchanged. */

export interface ServerView {
  hostname: string;
  hasAdminRights: boolean;
  purchasedByPlayer: boolean;
  moneyAvailable: number;
  moneyMax: number;
  hackDifficulty: number;
  minDifficulty: number;
  baseDifficulty: number;
  requiredHackingSkill: number;
  serverGrowth: number;
  numOpenPortsRequired: number;
  maxRam: number;
  usedRam: number;
  cpuCores: number;
}

export interface PlayerMults {
  hacking: number;
  hacking_exp: number;
  hacking_money: number;
  hacking_grow: number;
  hacking_speed: number;
  hacking_chance: number;
}

export interface PlayerView {
  money: number;
  hackingSkill: number;
  hackingExp: number;
  mults: PlayerMults;
}

/** Costs the driver can quote. Infinity = unavailable/unknown in this world
 * (e.g. home upgrades without Singularity in the live game). */
export interface Prices {
  upgradeHomeRam: number;
  /** ram (GB, power of two) -> cost for a new cloud server. */
  cloudServer: Record<number, number>;
  cloudServerLimit: number;
}

export interface WorldView {
  /** ms — wall clock in game, virtual clock in sim. */
  time: number;
  player: PlayerView;
  servers: ServerView[];
  prices: Prices;
}

export type Action =
  | { type: "hack" | "grow" | "weaken"; target: string; source: string; threads: number }
  | { type: "nuke"; target: string }
  | { type: "buyServer"; ram: number; name: string }
  | { type: "upgradeHomeRam" }
  | { type: "sleep"; ms: number };

export interface PlanResult<M> {
  actions: Action[];
  memory: M;
}

export interface Planner<M> {
  init(view: WorldView): M;
  /** PURE: no ns, no Date.now, no Math.random, no I/O. */
  plan(view: WorldView, memory: M): PlanResult<M>;
}

/** Per-thread worker script RAM — fidelity constants matching the in-game
 * cost of a worker that calls one of hack/grow/weaken (1.6 base + fn cost). */
export const WORKER_RAM = { hack: 1.7, grow: 1.75, weaken: 1.75 } as const;

export function serverByName(view: WorldView, hostname: string): ServerView | undefined {
  return view.servers.find((s) => s.hostname === hostname);
}

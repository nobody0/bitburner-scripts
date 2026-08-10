import type { HackNodeMults } from "./formulas.ts";

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
  /** Measured hacking exp/sec (EMA), when the driver tracks one. Lets the
   * evaluator discount a candidate's prep time by the skill growth that will
   * happen DURING the prep — treating prep time as a constant overprices
   * every long prep on a small fleet. */
  hackingExpRate?: number;
  intelligence: number;
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

/** What the `stock` feature wants the farm to do to a host's symbol.
 *
 * `hack(host, {stock: true})` lowers the corresponding stock's second-order
 * forecast and `grow(host, {stock: true})` raises it
 * (StockMarket/PlayerInfluencing.ts), so a LONG is driven by grows and a SHORT by
 * hacks. Setting the flag on BOTH sides of an HWGW batch would cancel out: in
 * steady state the grow restores exactly what the hack took, so the two nudges
 * are equal and opposite.
 *
 * `valuePerOp` is dollars of stock profit per influencing op at a steal fraction
 * of 1, which is the unit the target solver can price — it scales by the steal
 * fraction its own batch achieves. */
export interface StockInfluence {
  sym: string;
  side: "long" | "short";
  valuePerOp: number;
}

export interface WorldView {
  /** ms — wall clock in game, virtual clock in sim. */
  time: number;
  player: PlayerView;
  servers: ServerView[];
  prices: Prices;
  /** BitNode multiplier subset for makeHackContext. Sim supplies real values;
   * the game driver supplies {} (BN1 defaults) until SF5 detection exists. */
  nodeMults?: HackNodeMults;
  /** hostname -> stock manipulation intent, published by `stock`. Absent when
   *  the market is not being played, which is the common case. */
  stockInfluence?: Record<string, StockInfluence>;
}

export interface HgwAction {
  type: "hack" | "grow" | "weaken";
  target: string;
  source: string;
  threads: number;
  /** Dispatcher-assigned id, echoed back in the CompletionEvent. */
  opId?: number;
  /** Extra landing delay for HWGW alignment: the op completes at
   * launch + duration + additionalMsec (both worlds honor it identically). */
  additionalMsec?: number;
  /** Pass `{stock: true}` so this op moves the target organization's share
   *  price. Set on grows for a long and hacks for a short, never both. */
  stock?: boolean;
  /** Pooled-worker routing (game driver only; the sim's planner path ignores
   *  it — landings are identical either way). `spawn: true` execs a new
   *  serve-mode worker and queues this op as its first job; `spawn: false`
   *  posts the job to an already-idle worker. Absent = one-shot worker. */
  worker?: { id: number; spawn: boolean };
}

export type Action =
  | HgwAction
  | { type: "nuke"; target: string }
  | { type: "buyServer"; ram: number; name: string }
  | { type: "upgradeServer"; host: string; ram: number }
  | { type: "upgradeHomeRam" }
  | { type: "upgradeHomeCore" }
  | { type: "sleep"; ms: number };

/** Delivered to the driver when a scheduled op settles. `workerExit` reports a
 * pooled serve-worker's process ending (idle timeout, kill, reload): its opId
 * is the WORKER id and its arrival is when the worker's RAM actually frees. */
export interface CompletionEvent {
  kind: "hack" | "grow" | "weaken" | "sleep" | "workerExit";
  opId?: number;
  target?: string;
  threads?: number;
  result?: {
    success?: boolean;
    moneyGained?: number;
    expGained?: number;
    growth?: number;
    securityReduced?: number;
  };
}

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
 * cost of a worker that calls one of hack/grow/weaken (1.6 base + fn cost).
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L10-L20 */
export const WORKER_RAM = { hack: 1.7, grow: 1.75, weaken: 1.75 } as const;

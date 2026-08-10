/** Hacking feature — the network farm. Problem: maximise $/sec/GB across the
 * rooted fleet by choosing a target, holding it at min security / max money,
 * and spending every free gigabyte on it. */

/** 1 Hz dispatcher rollup — the ONLY steady-state farm telemetry (per-op
 * events would be ~3/16ms at scale and are never emitted; transitions get
 * their own rare events). Optional fields fill in as the dispatcher lands. */
export interface FarmRollup {
  target?: string;
  /** Whether the target's integer batch solve exhausted its whole domain. */
  targetSolveExact?: boolean;
  /** Current target's expected $/sec/GB, used to price added fleet RAM. */
  moneyPerSecPerGb?: number;
  prepTarget?: string;
  /** Current demand-driven reservation for the executable prep wave. */
  prepBudgetGb?: number;
  segOrder?: string[];
  /** Farm scheduling mode (hwgw | hgw | shotgun). */
  mode?: string;
  inFlight?: { hack: number; grow: number; weaken: number };
  launched?: { hack: number; grow: number; weaken: number };
  landed?: { hack: number; grow: number; weaken: number };
  moneyRate?: number;
  expRate?: number;
  security?: number;
  minSecurity?: number;
  money?: number;
  moneyMax?: number;
  ramPie?: { farm: number; prep: number; share: number; free: number; reserve: number };
  allocFails?: number;
  /** Fresh processes started (one-shots + pool spawns). Pooling keeps this
   * flat while `launched` climbs — the browser-RAM churn figure. */
  execs?: number;
  /** Ops launched with a `{stock:true}` influence flag — the observable link
   * between manipulation intent and nudges actually rolled. */
  stockOps?: number;
  /** The current farm target's pipeline demand ceiling in GB (one batch per
   * interval for one weakenTime). Infrastructure valuation reads it so RAM
   * beyond saturation prices at its true ~0 marginal income. */
  depthCapGb?: number;
  execFails?: number;
  batchesSkipped?: number;
  pumpMaxMs?: number;
  /** Cumulative early pumps triggered by worker completions (the
   * weaken-landing wake) rather than the 200 ms tick. */
  wakePumps?: number;
  /** Cumulative — goal evaluation reads these (replaces per-op hack.done). */
  totals: { moneyEarned: number; hacks: number };
}

/** Fleet capacity and script income. Cheap enough to sample every sweep;
 * complements `servers` (which carries per-host detail) with the aggregates
 * the Hacking tab shows as tiles. */
export interface FleetRollup {
  /** Rooted, non-purchased hosts with RAM. */
  rootedHosts: number;
  totalHosts: number;
  maxRam: number;
  usedRam: number;
  /** Purchased ("cloud") servers. count/totalRam come from the sweep snapshot;
   *  limit and maxRamPerServer need ns.cloud and fill in when it is probed. */
  purchased: { count: number; totalRam: number; limit?: number; maxRamPerServer?: number };
  /** Port-opener programs owned, inferred from the highest `openPortCount`
   *  seen on the network — a lower bound until the first rooting sweep, exact
   *  after it. Free, unlike asking the game for home's file list. */
  portOpeners?: number;
  home: { maxRam: number; usedRam: number; cores: number };
  /** Singularity quote; absent when home upgrades are not scriptable. */
  homeRamUpgradeCost?: number;
  homeCoreUpgradeCost?: number;
  /** Authoritative one-step cloud quotes. Hacknet servers are player-owned
   * but deliberately absent: they have their own upgrade economy. */
  infrastructureOptions?: {
    kind: "buyServer" | "upgradeServer";
    cost: number;
    addedRam: number;
    host?: string;
    targetRam: number;
  }[];
  homeRamPlan?: {
    cost: number;
    addedRam: number;
    incomePerSec: number;
    paybackSec: number;
    netOverHorizon: number;
    worthBuying: boolean;
    lastResult?: { ok: boolean; detail: string; at: number };
  };
  infrastructurePlan?: {
    /** Inputs captured with the decision, so an offline analysis does not
     * have to time-join independently sampled player/farm topics. */
    evaluatedAt: number;
    horizonSec: number;
    moneyAvailable: number;
    moneyGranted: number;
    incomePerSecPerGb: number;
    reinvestmentReturnPerDollarSec?: number;
    buy?: { kind: string; cost: number; host?: string; targetRam?: number };
    /** True candidate count; `ranked` is a bounded display/telemetry digest. */
    rankedTotal: number;
    ranked: {
      kind: string;
      host?: string;
      targetRam?: number;
      addedRam: number;
      cost: number;
      incomePerSec: number;
      returnPerDollarSec: number;
      paybackSec: number;
      netOverHorizon: number;
      worthBuying: boolean;
      selected: boolean;
    }[];
    lastResult?: { action: string; ok: boolean; detail: string; at: number };
  };
  /** ns.getTotalScriptIncome() -> [current live-script $/sec, $/sec since aug install]. */
  scriptIncome?: [number, number];
  scriptExpGain?: number;
  sharePower?: number;
}

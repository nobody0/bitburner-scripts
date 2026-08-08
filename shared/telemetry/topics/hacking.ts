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
  prepTarget?: string;
  segOrder?: string[];
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
  execFails?: number;
  batchesSkipped?: number;
  pumpMaxMs?: number;
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
  /** ns.getTotalScriptIncome() -> [$/sec since aug install, $/sec since start]. */
  scriptIncome?: [number, number];
  scriptExpGain?: number;
  sharePower?: number;
}

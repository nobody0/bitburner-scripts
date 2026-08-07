/** Hacknet feature — BN9's theme. Problem: schedule node purchases and
 * level/ram/core upgrades so cumulative production minus spend is maximised
 * over the run horizon. Pure knapsack-over-time; the classic "which upgrade
 * has the best payback period" question. */

export interface HacknetNodeDigest {
  name: string;
  level: number;
  ram: number;
  cores: number;
  production: number;
  totalProduction: number;
  timeOnline: number;
  /** Hacknet SERVER fields (BN9 / SF9) — undefined for plain nodes. */
  cache?: number;
  hashCapacity?: number;
  ramUsed?: number;
}

export interface HacknetState {
  /** True in BN9/SF9, where nodes become RAM-bearing hash servers. */
  servers: boolean;
  numNodes: number;
  maxNumNodes: number;
  purchaseNodeCost: number;
  totalProduction: number;
  productionPerSec: number;
  nodes: HacknetNodeDigest[];
  /** Cheapest upgrade of each kind across all nodes, with its payback. */
  nextUpgrades?: { kind: string; node: number; cost: number }[];
  /** Hash economy — hacknet servers only. */
  hashes?: { current: number; capacity: number };
  hashUpgrades?: { name: string; level: number; cost: number }[];
}

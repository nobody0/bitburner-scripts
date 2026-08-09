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
  /** null means uncapped (plain Hacknet Nodes). */
  maxNumNodes: number | null;
  purchaseNodeCost: number;
  totalProduction: number;
  productionPerSec: number;
  nodes: HacknetNodeDigest[];
  /** Every available one-step upgrade. ROI, not sticker price, selects a node. */
  nextUpgrades?: { kind: string; node: number; cost: number }[];
  /** Hash economy — hacknet servers only. */
  hashes?: { current: number; capacity: number; sellForMoneyCost: number };
  hashUpgrades?: { name: string; level: number; cost: number }[];
  /** The decision digest: what to buy, why, and what was passed over. */
  plan?: HacknetPlan;
}

export interface HacknetPlan {
  /** Decision inputs captured atomically with the ranking. */
  evaluatedAt: number;
  horizonSec: number;
  moneyAvailable: number;
  moneyGranted: number;
  hashDollarValue: number;
  fleetUtilization: number;
  fleetDemanded: boolean;
  candidate?: { kind: string; node?: number; cost: number };
  buy?: { kind: string; node?: number; cost: number };
  why: string;
  /** Set when nothing is worth buying, with the reason — an upgrade that
   *  cannot repay itself before the horizon ends is a decision, not a stall. */
  hold?: string;
  rankedTotal: number;
  ranked: {
    kind: string;
    node?: number;
    label: string;
    cost: number;
    deltaProduction: number;
    returnPerDollarSec: number;
    paybackSec: number;
    netOverHorizon: number;
    worthBuying: boolean;
    selected: boolean;
    milestone?: { kind: string; target: number; have: number; delta: number; priority: number; why: string };
    why: string;
  }[];
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
  hashes?: {
    current: number;
    capacity: number;
    productionPerSec: number;
    sellForMoneyCost: number;
    spend?: { name: string; target?: string; count: number; cost: number };
    reserve?: { name: string; target?: string; cost: number; missing: number };
    capacityTarget?: number;
    why: string;
    rankedTotal: number;
    ranked: {
      name: string;
      target?: string;
      cost: number;
      priority: number;
      affordable: boolean;
      fitsCapacity: boolean;
      valueDollars?: number;
      saleValueDollars: number;
      netDollars?: number;
      eligible: boolean;
      selected: boolean;
      why: string;
    }[];
    lastResult?: { action: string; ok: boolean; detail: string; at: number };
  };
}

/** Formula shapes transcribed from Bitburner v3.0.1. Costs still come from
 * ns; these production shapes let us value a first node and exact one-step
 * deltas without buying it as a probe. Pinned against the vendor in sim. */

export interface ProductionNode {
  level: number;
  ram: number;
  cores: number;
  production: number;
  ramUsed?: number;
}

export type ProductionUpgrade = "level" | "ram" | "core";

export function freshProduction(hashMode: boolean, playerMult: number, bitNodeMult: number): number {
  const base = hashMode ? 0.001 : 1.5;
  return base * playerMult * bitNodeMult;
}

/** Native marginal production: dollars/sec for nodes, hashes/sec for servers. */
export function productionDelta(node: ProductionNode, kind: ProductionUpgrade, hashMode: boolean): number {
  if (!(node.production > 0)) return 0;
  if (kind === "level") return node.production / node.level;

  if (!hashMode) {
    if (kind === "ram") return node.production * (Math.pow(1.035, node.ram) - 1);
    return node.production / (node.cores + 5);
  }

  if (kind === "core") return node.production / (node.cores + 4);

  // Server RAM doubles. Besides the 1.07 multiplier, newly free RAM changes
  // the `1 - ramUsed/maxRam` production term.
  const used = Math.max(0, node.ramUsed ?? 0);
  const oldFreeRatio = 1 - used / node.ram;
  const newFreeRatio = 1 - used / (node.ram * 2);
  if (oldFreeRatio <= 0) return 0;
  return node.production * (1.07 * (newFreeRatio / oldFreeRatio) - 1);
}

/** Hash-production delta when the RAM added by a server RAM upgrade is also
 * filled by hacking workers. This is deliberately separate from
 * `productionDelta`: idle RAM improves the free-RAM hash multiplier, occupied
 * RAM earns hacking money but may REDUCE hashes. Adding both outcomes would
 * count the same RAM twice. */
export function productionDeltaWithAddedRamOccupied(node: ProductionNode): number {
  if (!(node.production > 0) || !(node.ram > 0)) return 0;
  const used = Math.max(0, Math.min(node.ram, node.ramUsed ?? 0));
  const oldFreeRatio = 1 - used / node.ram;
  if (oldFreeRatio <= 0) return 0;
  const newUsed = used + node.ram;
  const newFreeRatio = Math.max(0, 1 - newUsed / (node.ram * 2));
  return node.production * (1.07 * (newFreeRatio / oldFreeRatio) - 1);
}

export const HASH_SALE_DOLLARS = 1_000_000;

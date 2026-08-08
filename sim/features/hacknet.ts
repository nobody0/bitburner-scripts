import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { HacknetNodeConstants } from "../vendor/bitburner/src/Hacknet/data/Constants.ts";
import {
  calculateCoreUpgradeCost,
  calculateLevelUpgradeCost,
  calculateMoneyGainRate,
  calculateNodeCost,
  calculateRamUpgradeCost,
} from "../vendor/bitburner/src/Hacknet/formulas/HacknetNodes.ts";

/** The hacknet subsystem.
 *
 * Production is LINEAR in cycles with no bonus-time cap — unlike gang,
 * bladeburner, corp and stanek, hacknet earnings simply scale
 * (`processHacknetEarnings(numCycles)`), which is why it is the one subsystem
 * that needs no CycleBuffer.
 *
 * Every number comes from the vendored formulas, so a cost the strategy reads
 * through ns is the same cost the world charges. */

export interface SimHacknetNode {
  level: number;
  ram: number;
  cores: number;
  totalProduction: number;
  onlineTimeSeconds: number;
}

export class HacknetSystem {
  readonly nodes: SimHacknetNode[] = [];
  #world: SimWorld;
  #player: SimPlayer;

  constructor(world: SimWorld, player: SimPlayer) {
    this.#world = world;
    this.#player = player;
  }

  /** `hacknet_node_money` and friends, from the player's multipliers. */
  #mult(field: string): number {
    return ((this.#world.person.mults as unknown as Record<string, number>)[field] ?? 1);
  }

  production(node: SimHacknetNode): number {
    return calculateMoneyGainRate(node.level, node.ram, node.cores, this.#mult("hacknet_node_money"));
  }

  nodeCost(): number {
    return calculateNodeCost(this.nodes.length + 1, this.#mult("hacknet_node_purchase_cost"));
  }

  levelCost(index: number): number {
    const node = this.nodes[index];
    return node ? calculateLevelUpgradeCost(node.level, 1, this.#mult("hacknet_node_level_cost")) : Infinity;
  }

  ramCost(index: number): number {
    const node = this.nodes[index];
    return node ? calculateRamUpgradeCost(node.ram, 1, this.#mult("hacknet_node_ram_cost")) : Infinity;
  }

  coreCost(index: number): number {
    const node = this.nodes[index];
    return node ? calculateCoreUpgradeCost(node.cores, 1, this.#mult("hacknet_node_core_cost")) : Infinity;
  }

  /** Hacknet NODES have no count limit upstream — only hacknet SERVERS
   * (BN9/SF9) cap at HacknetServerConstants.MaxServers = 20. A cap here would
   * be invented, so the only limit is affordability, and the node cost grows
   * 1.85x per node which bounds it in practice. */
  static readonly MAX_NODES = Infinity;

  purchaseNode(): number {
    const cost = this.nodeCost();
    if (this.#player.money < cost) return -1;
    this.#player.money -= cost;
    this.nodes.push({ level: 1, ram: 1, cores: 1, totalProduction: 0, onlineTimeSeconds: 0 });
    this.#world.emit({ kind: "event", name: "hacknet.node", data: { index: this.nodes.length - 1, cost } });
    return this.nodes.length - 1;
  }

  upgradeLevel(index: number, n = 1): boolean {
    const node = this.nodes[index];
    if (!node) return false;
    const cost = calculateLevelUpgradeCost(node.level, n, this.#mult("hacknet_node_level_cost"));
    if (!Number.isFinite(cost) || this.#player.money < cost) return false;
    this.#player.money -= cost;
    node.level = Math.min(HacknetNodeConstants.MaxLevel, node.level + n);
    return true;
  }

  upgradeRam(index: number, n = 1): boolean {
    const node = this.nodes[index];
    if (!node) return false;
    const cost = calculateRamUpgradeCost(node.ram, n, this.#mult("hacknet_node_ram_cost"));
    if (!Number.isFinite(cost) || this.#player.money < cost) return false;
    this.#player.money -= cost;
    // RAM DOUBLES per upgrade; adding would make every cost projection wrong.
    node.ram = Math.min(HacknetNodeConstants.MaxRam, node.ram * Math.pow(2, n));
    return true;
  }

  upgradeCore(index: number, n = 1): boolean {
    const node = this.nodes[index];
    if (!node) return false;
    const cost = calculateCoreUpgradeCost(node.cores, n, this.#mult("hacknet_node_core_cost"));
    if (!Number.isFinite(cost) || this.#player.money < cost) return false;
    this.#player.money -= cost;
    node.cores = Math.min(HacknetNodeConstants.MaxCores, node.cores + n);
    return true;
  }

  /** Engine hook: `processHacknetEarnings(numCycles)`. LINEAR in cycles — no
   * bonus-time cap, unlike every other buffered subsystem. */
  processEarnings(cycles: number): void {
    if (this.nodes.length === 0) return;
    const seconds = (cycles * 200) / 1000;
    let total = 0;
    for (const node of this.nodes) {
      const gain = this.production(node) * seconds;
      node.totalProduction += gain;
      node.onlineTimeSeconds += seconds;
      total += gain;
    }
    this.#player.money += total;
    this.#world.moneyEarned += total;
  }

  totalProduction(): number {
    return this.nodes.reduce((sum, node) => sum + this.production(node), 0);
  }
}

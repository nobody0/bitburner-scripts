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
import {
  calculateCoreUpgradeCost as calculateServerCoreUpgradeCost,
  calculateHashGainRate,
  calculateLevelUpgradeCost as calculateServerLevelUpgradeCost,
  calculateRamUpgradeCost as calculateServerRamUpgradeCost,
  calculateServerCost,
  calculateCacheUpgradeCost,
} from "../vendor/bitburner/src/Hacknet/formulas/HacknetServers.ts";
import { HacknetServerConstants } from "../vendor/bitburner/src/Hacknet/data/Constants.ts";
import { mockServer } from "../core/mocks.ts";
import type { SimServer } from "../core/effects.ts";
import { unmodeled } from "../realm/unmodeled.ts";
import { SpecialServers } from "../vendor/bitburner/src/Server/data/SpecialServers.ts";

const WORLD_DAEMON = SpecialServers.WorldDaemon;
/** AugmentationName.TheRedPill. Read through `hasAugmentation(..., true)`:
 *  upstream passes ignoreQueued, so a Red Pill that is only QUEUED does not
 *  open the World Daemon — the same spelling game-run.ts:926 uses for the
 *  BitNode-completion gate. */
const RED_PILL = "The Red Pill";

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
  hostname?: string;
  level: number;
  ram: number;
  cores: number;
  totalProduction: number;
  onlineTimeSeconds: number;
  cache?: number;
  ramUsed?: number;
}

export interface HacknetSeed {
  nodes: SimHacknetNode[];
  hashes: number;
  hashLevels: Record<string, number>;
}

/** `HashManager.getMult` for the two exp upgrades: `1 + value * level / 100`
 * with the table's `value: 20` (src/Hacknet/HashManager.ts:34-58). Shared so the
 * study/gym rate and the ns getter cannot drift apart. */
export function hashUpgradeMult(level: number): number {
  return 1 + 0.2 * level;
}

export class HacknetSystem {
  readonly nodes: SimHacknetNode[] = [];
  #world: SimWorld;
  #player: SimPlayer;
  readonly hashMode: boolean;
  hashes = 0;
  readonly hashLevels: Record<string, number> = Object.fromEntries(HASH_UPGRADES.map((entry) => [entry.name, 0]));

  constructor(world: SimWorld, player: SimPlayer, hashMode = false, seed?: HacknetSeed) {
    this.#world = world;
    this.#player = player;
    this.hashMode = hashMode;
    if (seed) {
      this.nodes.push(...seed.nodes.map((node) => ({ ...node })));
      this.hashes = Math.max(0, seed.hashes);
      Object.assign(this.hashLevels, seed.hashLevels);
    }
  }

  /** Hacknet nodes/servers, hashes and hash-upgrade levels are reset by an
   * augmentation install. Public server regeneration is owned by SimWorld. */
  prestige(): void {
    this.nodes.length = 0;
    this.hashes = 0;
    for (const name of Object.keys(this.hashLevels)) this.hashLevels[name] = 0;
  }

  /** `hacknet_node_money` and friends, from the player's multipliers. */
  #mult(field: string): number {
    return ((this.#world.person.mults as unknown as Record<string, number>)[field] ?? 1);
  }

  production(node: SimHacknetNode): number {
    if (this.hashMode) {
      const server = node.hostname ? this.#world.servers.get(node.hostname) : undefined;
      return calculateHashGainRate(
        node.level,
        server?.ramUsed ?? node.ramUsed ?? 0,
        server?.maxRam ?? node.ram,
        node.cores,
        this.#mult("hacknet_node_money"),
      );
    }
    return calculateMoneyGainRate(node.level, node.ram, node.cores, this.#mult("hacknet_node_money"));
  }

  nodeCost(): number {
    if (this.hashMode) return calculateServerCost(this.nodes.length + 1, this.#mult("hacknet_node_purchase_cost"));
    return calculateNodeCost(this.nodes.length + 1, this.#mult("hacknet_node_purchase_cost"));
  }

  levelCost(index: number, n = 1): number {
    const node = this.nodes[index];
    return node
      ? this.hashMode
        ? calculateServerLevelUpgradeCost(node.level, n, this.#mult("hacknet_node_level_cost"))
        : calculateLevelUpgradeCost(node.level, n, this.#mult("hacknet_node_level_cost"))
      : Infinity;
  }

  ramCost(index: number, n = 1): number {
    const node = this.nodes[index];
    return node
      ? this.hashMode
        ? calculateServerRamUpgradeCost(node.ram, n, this.#mult("hacknet_node_ram_cost"))
        : calculateRamUpgradeCost(node.ram, n, this.#mult("hacknet_node_ram_cost"))
      : Infinity;
  }

  coreCost(index: number, n = 1): number {
    const node = this.nodes[index];
    return node
      ? this.hashMode
        ? calculateServerCoreUpgradeCost(node.cores, n, this.#mult("hacknet_node_core_cost"))
        : calculateCoreUpgradeCost(node.cores, n, this.#mult("hacknet_node_core_cost"))
      : Infinity;
  }

  /** Hacknet NODES have no count limit upstream — only hacknet SERVERS
   * (BN9/SF9) cap at HacknetServerConstants.MaxServers = 20. A cap here would
   * be invented, so the only limit is affordability, and the node cost grows
   * 1.85x per node which bounds it in practice. */
  get maxNodes(): number { return this.hashMode ? HacknetServerConstants.MaxServers : Infinity; }

  purchaseNode(): number {
    const cost = this.nodeCost();
    if (this.#player.money < cost) return -1;
    if (this.nodes.length >= this.maxNodes) return -1;
    this.#player.money -= cost;
    this.#world.recordMoney("hacknet_expenses", -cost);
    const index = this.nodes.length;
    const hostname = this.hashMode ? `hacknet-server-${index}` : undefined;
    this.nodes.push({
      ...(hostname ? { hostname } : {}),
      level: 1, ram: 1, cores: 1, totalProduction: 0, onlineTimeSeconds: 0,
      ...(this.hashMode ? { cache: 1, ramUsed: 0 } : {}),
    });
    if (hostname) {
      const server = mockServer({ hostname, hasAdminRights: true, purchasedByPlayer: true, maxRam: 1, cpuCores: 1 }) as SimServer;
      this.#world.servers.set(hostname, server);
      this.#world.mirrorServer(server);
    }
    this.#world.emit({ kind: "event", name: "hacknet.node", data: { index, cost } });
    return index;
  }

  /* THE FOUR UPGRADES. Two things here are easy to get wrong and were:
   *
   * 1. A request that overshoots the cap is NOT a refusal. Upstream recurses on
   *    the remaining difference and buys it (HacknetHelpers.tsx:238-364), so a
   *    node at level 195 asked for 10 buys 5 and returns true. Returning false
   *    made "upgrade to max in one call" stall at the cap in simulation only.
   * 2. `n` must be rounded and screened BEFORE it reaches the node. The
   *    vendored cost formulas return 0 for `sanitizedLevels < 1`, which sailed
   *    through a `Number.isFinite(cost) && money >= cost` guard — so a negative
   *    count LOWERED the node for free, and a fractional one wrote a fractional
   *    level straight into calculateMoneyGainRate. Upstream's
   *    `isNaN(cost) || cost <= 0 || sanitizedLevels < 0` rejects all of it. */

  upgradeLevel(index: number, n = 1): boolean {
    const node = this.nodes[index];
    if (!node) return false;
    const levels = Math.round(n);
    const cost = this.levelCost(index, levels);
    if (Number.isNaN(cost) || cost <= 0 || levels < 0) return false;
    const max = this.hashMode ? HacknetServerConstants.MaxLevel : HacknetNodeConstants.MaxLevel;
    if (node.level >= max) return false;
    if (node.level + levels > max) return this.upgradeLevel(index, Math.max(0, max - node.level));
    if (this.#player.money < cost) return false;
    this.#player.money -= cost;
    this.#world.recordMoney("hacknet_expenses", -cost);
    node.level += levels;
    return true;
  }

  upgradeRam(index: number, n = 1): boolean {
    const node = this.nodes[index];
    if (!node) return false;
    const levels = Math.round(n);
    const cost = this.ramCost(index, levels);
    if (Number.isNaN(cost) || cost <= 0 || levels < 0) return false;
    const max = this.hashMode ? HacknetServerConstants.MaxRam : HacknetNodeConstants.MaxRam;
    if (node.ram >= max) return false;
    if (node.ram * Math.pow(2, levels) > max) {
      return this.upgradeRam(index, Math.max(0, Math.log2(Math.round(max / node.ram))));
    }
    if (this.#player.money < cost) return false;
    this.#player.money -= cost;
    this.#world.recordMoney("hacknet_expenses", -cost);
    // RAM DOUBLES per upgrade; adding would make every cost projection wrong.
    node.ram *= Math.pow(2, levels);
    if (this.hashMode && node.hostname) {
      const server = this.#world.servers.get(node.hostname);
      if (server) server.maxRam = node.ram;
    }
    return true;
  }

  upgradeCore(index: number, n = 1): boolean {
    const node = this.nodes[index];
    if (!node) return false;
    const levels = Math.round(n);
    const cost = this.coreCost(index, levels);
    if (Number.isNaN(cost) || cost <= 0 || levels < 0) return false;
    const max = this.hashMode ? HacknetServerConstants.MaxCores : HacknetNodeConstants.MaxCores;
    if (node.cores >= max) return false;
    if (node.cores + levels > max) return this.upgradeCore(index, Math.max(0, max - node.cores));
    if (this.#player.money < cost) return false;
    this.#player.money -= cost;
    this.#world.recordMoney("hacknet_expenses", -cost);
    node.cores += levels;
    if (this.hashMode && node.hostname) {
      const server = this.#world.servers.get(node.hostname);
      if (server) server.cpuCores = node.cores;
    }
    return true;
  }

  upgradeCache(index: number, n = 1): boolean {
    const node = this.nodes[index];
    if (!this.hashMode || !node) return false;
    const levels = Math.round(n);
    const cost = this.cacheCost(index, levels);
    if (Number.isNaN(cost) || cost <= 0 || levels < 0) return false;
    const cache = node.cache ?? 1;
    if (cache + levels > HacknetServerConstants.MaxCache) {
      return this.upgradeCache(index, Math.max(0, HacknetServerConstants.MaxCache - cache));
    }
    if (this.#player.money < cost) return false;
    this.#player.money -= cost;
    this.#world.recordMoney("hacknet_expenses", -cost);
    node.cache = cache + levels;
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
    if (this.hashMode) {
      const capacity = this.hashCapacity();
      const stored = Math.min(total, Math.max(0, capacity - this.hashes));
      this.hashes += stored;
      // Upstream automatically sells overflow at the same 4 hashes/$1m rate.
      const overflowMoney = (total - stored) * 250_000;
      this.#player.money += overflowMoney;
      this.#world.moneyEarned += overflowMoney;
      this.#world.recordMoney("hacknet", overflowMoney);
    } else {
      this.#player.money += total;
      this.#world.moneyEarned += total;
      this.#world.recordMoney("hacknet", total);
    }
  }

  cacheCost(index: number, n = 1): number {
    const node = this.nodes[index];
    return this.hashMode && node ? calculateCacheUpgradeCost(node.cache ?? 1, n) : Infinity;
  }

  hashCapacity(): number {
    return this.hashMode
      ? this.nodes.reduce((sum, node) => sum + 32 * Math.pow(2, node.cache ?? 1), 0)
      : 0;
  }

  hashUpgrades(): string[] { return HASH_UPGRADES.map((entry) => entry.name); }

  hashCost(name: string, count = 1): number {
    const upgrade = HASH_UPGRADES.find((entry) => entry.name === name);
    if (!this.hashMode || !upgrade || count < 0) return Infinity;
    if (upgrade.fixed !== undefined) return upgrade.fixed * count;
    const level = this.hashLevels[name] ?? 0;
    return upgrade.base * 0.5 * count * (count + 2 * level + 1);
  }

  spendHashes(nameOrCount: string | number, target = "", count = 1): boolean {
    const name = typeof nameOrCount === "number" ? "Sell for Money" : nameOrCount;
    if (typeof nameOrCount === "number") count = nameOrCount;
    if (!this.hashMode || count < 0) return false;
    const cost = this.hashCost(name, count);
    if (!Number.isFinite(cost) || this.hashes < cost) return false;
    // "Improve Studying" and "Improve Gym Training" need no branch below: their
    // whole effect is the level counter this method already increments, which
    // sim/features/education.ts reads as `1 + 0.2 * level` — the same shape as
    // HashManager.getMult. Leaving them out of the allowlist made the two
    // upgrades whose effects ARE modelled the only ones nobody could buy.
    if (![
      "Sell for Money",
      "Reduce Minimum Security",
      "Increase Maximum Money",
      "Improve Studying",
      "Improve Gym Training",
    ].includes(name)) {
      return unmodeled("subsystem", `hacknet.${name}`, "hash-upgrade effect is not modelled yet");
    }
    const server = target ? this.#world.servers.get(target) : undefined;
    // checkServerOwnership(target, Foreign) has TWO clauses, and only the first
    // was here: owned servers are rejected, AND the World Daemon is rejected
    // until The Red Pill is installed (src/Server/ServerHelpers.ts:297-323).
    // Without the second, a run could shave w0r1d_d43m0n's minimum security
    // without TRP — a shortcut on the very BitNode-completion gate route legs
    // exist to measure.
    if (name === "Reduce Minimum Security" || name === "Increase Maximum Money") {
      if (!server || server.purchasedByPlayer) return false;
      if (server.hostname === WORLD_DAEMON && !this.#player.hasAugmentation(RED_PILL, true)) return false;
    }
    this.hashes -= cost;
    this.hashLevels[name] = (this.hashLevels[name] ?? 0) + count;
    if (name === "Sell for Money") {
      const money = 1_000_000 * count;
      this.#player.money += money;
      this.#world.moneyEarned += money;
      this.#world.recordMoney("hacknet", money);
    } else if (name === "Reduce Minimum Security") {
      server!.minDifficulty = Math.max(1, server!.minDifficulty * Math.pow(0.98, count));
      this.#world.mirrorServer(server!);
    } else if (name === "Increase Maximum Money") {
      for (let i = 0; i < count; i++) {
        let mult = 1.02;
        if (server!.moneyMax > 10e12) mult = 1 + 0.02 / Math.log(server!.moneyMax - 10e12) / Math.log(8);
        server!.moneyMax *= mult;
      }
      this.#world.mirrorServer(server!);
    }
    return true;
  }

  /** HashManager.getStudyMult/getTrainingMult, which are a plain 1 outside
   *  hacknet-server mode (NetscriptFunctions/Hacknet.ts:232-243). */
  studyMult(): number {
    return this.hashMode ? hashUpgradeMult(this.hashLevels["Improve Studying"] ?? 0) : 1;
  }

  trainingMult(): number {
    return this.hashMode ? hashUpgradeMult(this.hashLevels["Improve Gym Training"] ?? 0) : 1;
  }

  totalProduction(): number {
    return this.nodes.reduce((sum, node) => sum + this.production(node), 0);
  }
}

const HASH_UPGRADES: readonly { name: string; base: number; fixed?: number }[] = [
  { name: "Sell for Money", base: 4, fixed: 4 },
  { name: "Sell for Corporation Funds", base: 100 },
  { name: "Reduce Minimum Security", base: 50 },
  { name: "Increase Maximum Money", base: 50 },
  { name: "Improve Studying", base: 50 },
  { name: "Improve Gym Training", base: 50 },
  { name: "Exchange for Corporation Research", base: 200 },
  { name: "Exchange for Bladeburner Rank", base: 250 },
  { name: "Exchange for Bladeburner SP", base: 250 },
  { name: "Generate Coding Contract", base: 25 },
  { name: "Company Favor", base: 200 },
];

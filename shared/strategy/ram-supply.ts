/** Pure RAM acquisition supply.
 *
 * The constants are vendored from Bitburner v3.0.1
 * src/Server/data/Constants.ts. sim/tests/ram-supply-parity.test.ts compares
 * these game-bundle-safe exports with the generated vendor file, because
 * shared/ cannot import simulator internals.
 */
export const RAM_COST_CONSTANTS = {
  BaseCostFor1GBOfRamHome: 32_000,
  BaseCostFor1GBOfRamServer: 55_000,
} as const;

export type RamSource = "home" | "cloud";

export interface RamSupplyState {
  home?: {
    currentRam: number;
    costMultiplier: number;
  };
  cloud?: {
    costMultiplier: number;
    softcap: number;
    maxRam: number;
    slotsAvailable: number;
    servers: readonly { host: string; ram: number }[];
  };
}

export interface RamSupplyQuote {
  source: RamSource;
  kind: "homeRam" | "buyServer" | "upgradeServer";
  costPerGb: number;
  addedRam: number;
  cost: number;
  targetRam: number;
  /** GB available at this marginal price before the supply curve steps. */
  availableGb: number;
  host?: string;
}

export function homeRamUpgradeCost(currentRam: number, costMultiplier: number): number {
  const ram = Math.max(0, currentRam);
  return ram * RAM_COST_CONSTANTS.BaseCostFor1GBOfRamHome
    * Math.pow(1.58, Math.log2(ram))
    * Math.max(0, costMultiplier);
}

export function cloudServerCost(
  ram: number,
  costMultiplier: number,
  softcap: number,
): number {
  const capacity = Math.max(0, ram);
  const upgrades = Math.max(0, Math.log2(capacity) - 6);
  return capacity
    * RAM_COST_CONSTANTS.BaseCostFor1GBOfRamServer
    * Math.max(0, costMultiplier)
    * Math.pow(Math.max(0, softcap), upgrades);
}

export function powerOfTwoRungs(maxRam: number, minimum = 2): number[] {
  const limit = Math.max(0, maxRam);
  const first = Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(2, minimum))));
  const out: number[] = [];
  for (let ram = first; ram <= limit; ram *= 2) out.push(ram);
  return out;
}

function compareSupply(a: RamSupplyQuote, b: RamSupplyQuote): number {
  const aSoftcapUpgrades = a.source === "cloud" ? Math.max(0, Math.log2(a.targetRam) - 6) : 0;
  const bSoftcapUpgrades = b.source === "cloud" ? Math.max(0, Math.log2(b.targetRam) - 6) : 0;
  return a.costPerGb - b.costPerGb
    // If a multiplier makes penalized and unpenalized rungs numerically equal,
    // retain the zero-exponent frontier instead of consuming a giant lump.
    || aSoftcapUpgrades - bSoftcapUpgrades
    // Equal dollars/GB should preserve cloud slots and place larger calls.
    || b.addedRam - a.addedRam
    || a.kind.localeCompare(b.kind)
    || (a.host ?? "").localeCompare(b.host ?? "");
}

function cloudQuotes(state: NonNullable<RamSupplyState["cloud"]>): RamSupplyQuote[] {
  const rungs = powerOfTwoRungs(state.maxRam);
  const out: RamSupplyQuote[] = [];
  if (state.slotsAvailable > 0) {
    for (const targetRam of rungs) {
      const cost = cloudServerCost(targetRam, state.costMultiplier, state.softcap);
      out.push({
        source: "cloud",
        kind: "buyServer",
        costPerGb: cost / targetRam,
        addedRam: targetRam,
        cost,
        targetRam,
        availableGb: targetRam,
      });
    }
  }
  for (const server of state.servers) {
    const currentCost = cloudServerCost(server.ram, state.costMultiplier, state.softcap);
    for (const targetRam of rungs) {
      if (targetRam <= server.ram) continue;
      const addedRam = targetRam - server.ram;
      const cost = cloudServerCost(targetRam, state.costMultiplier, state.softcap) - currentCost;
      out.push({
        source: "cloud",
        kind: "upgradeServer",
        costPerGb: cost / addedRam,
        addedRam,
        cost,
        targetRam,
        availableGb: addedRam,
        host: server.host,
      });
    }
  }
  return out;
}

/** Cheapest next marginal GB for one source. Cloud considers every legal
 * power-of-two purchase/upgrade and uses the largest equal-price rung. Thus
 * 64 GB falls out of the exponent's zero-softcap region instead of policy. */
export function marginalCostPerGb(
  source: RamSource,
  state: RamSupplyState,
): RamSupplyQuote | undefined {
  if (source === "home") {
    const home = state.home;
    if (!home || !(home.currentRam > 0)) return undefined;
    const cost = homeRamUpgradeCost(home.currentRam, home.costMultiplier);
    return {
      source,
      kind: "homeRam",
      costPerGb: cost / home.currentRam,
      addedRam: home.currentRam,
      cost,
      targetRam: home.currentRam * 2,
      availableGb: home.currentRam,
    };
  }
  const cloud = state.cloud;
  if (!cloud) return undefined;
  const quotes = cloudQuotes(cloud).sort(compareSupply);
  const best = quotes[0];
  if (!best) return undefined;
  const equalPrice = (quote: RamSupplyQuote): boolean =>
    Math.abs(quote.costPerGb - best.costPerGb) <= Math.max(1, best.costPerGb) * 1e-12;
  const availableGb = best.kind === "buyServer"
    ? best.targetRam * cloud.slotsAvailable
    : [...new Set(cloud.servers.map((server) => server.host))].reduce((sum, host) => {
        const perHost = quotes.filter((quote) => quote.host === host && quote.kind === best.kind && equalPrice(quote));
        return sum + Math.max(0, ...perHost.map((quote) => quote.addedRam));
      }, 0);
  return { ...best, availableGb: Math.max(best.addedRam, availableGb) };
}

/** Round a continuous dollar allocation down to an executable rung from the
 * selected source. The value curve remains smooth; only this boundary knows
 * that Bitburner purchases powers of two. */
export function roundedRamPurchase(
  source: RamSource,
  state: RamSupplyState,
  dollars: number,
): RamSupplyQuote | undefined {
  const budget = Math.max(0, dollars);
  if (source === "home") {
    const quote = marginalCostPerGb(source, state);
    return quote && quote.cost <= budget + 1e-9 ? quote : undefined;
  }
  const cloud = state.cloud;
  const marginal = marginalCostPerGb(source, state);
  if (!cloud || !marginal) return undefined;
  const desiredGb = budget / Math.max(Number.EPSILON, marginal.costPerGb);
  return cloudQuotes(cloud)
    .filter((quote) => quote.cost <= budget + 1e-9 && quote.addedRam <= desiredGb + 1e-9)
    .sort((a, b) => b.addedRam - a.addedRam || a.cost - b.cost || compareSupply(a, b))[0];
}

export function cheapestRamSupply(state: RamSupplyState): RamSupplyQuote | undefined {
  return (["home", "cloud"] as const)
    .map((source) => marginalCostPerGb(source, state))
    .filter((quote): quote is RamSupplyQuote => quote !== undefined)
    .sort(compareSupply)[0];
}

/** Select from an already-observed price table using the same marginal rule.
 * Used by the standalone planners, whose WorldView deliberately contains
 * quotes rather than BitNode multiplier internals.
 *
 * The softcap tie-break is the load-bearing part, exactly as in
 * `compareSupply`. Below the knee cloud cost is linear, so EVERY rung has the
 * same $/GB and "cheapest per GB, largest first" would return the table's
 * maximum (2^20 GB, ~$57b). The callers gate on `money >= cost`, so that
 * answer buys nothing for the whole run instead of the 64 GB rung the same
 * price actually affords. */
export function cheapestCloudQuote(
  prices: Readonly<Record<number, number>>,
): { ram: number; cost: number; costPerGb: number } | undefined {
  const softcapUpgrades = (ram: number): number => Math.max(0, Math.log2(ram) - 6);
  return Object.entries(prices)
    .map(([ram, cost]) => ({ ram: Number(ram), cost, costPerGb: cost / Number(ram) }))
    .filter((quote) => quote.ram > 0 && Number.isFinite(quote.costPerGb))
    .sort((a, b) => a.costPerGb - b.costPerGb
      || softcapUpgrades(a.ram) - softcapUpgrades(b.ram)
      || b.ram - a.ram)[0];
}

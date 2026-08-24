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

/** The single cheapest quote under {@link compareSupply}.
 *
 * `quotes.sort(compareSupply)[0]` and this pick the same element — sort is
 * stable and the comparator is a strict total order over generated quotes, so
 * both return the first minimum in generation order — but only one of them
 * orders the whole list to read one entry. The comparator is not cheap (two
 * `Math.log2`, two `localeCompare`), and this runs on every hacking tick. */
function cheapestQuote(quotes: readonly RamSupplyQuote[]): RamSupplyQuote | undefined {
  let best: RamSupplyQuote | undefined;
  for (const quote of quotes) {
    if (best === undefined || compareSupply(quote, best) < 0) best = quote;
  }
  return best;
}

/** Single-slot memo for {@link cloudQuotes}. The quote list depends only on
 * the cloud fleet's shape — rung ceiling, slots, multipliers, and each
 * server's current RAM — which changes when a purchase lands, not per tick;
 * yet the hacking tick regenerates it at least twice (the rounded purchase
 * and its marginal fallback). The fingerprint includes server order because
 * ties resolve to the FIRST minimum in generation order. Callers treat the
 * list as read-only (they copy before editing), which is what makes sharing
 * one array safe. One slot, module-level: bounded RAM, and this module also
 * runs in-game where retained memory is paid for. */
let CLOUD_QUOTES_KEY = "";
let CLOUD_QUOTES: RamSupplyQuote[] = [];

function cloudQuotes(state: NonNullable<RamSupplyState["cloud"]>): RamSupplyQuote[] {
  let key = `${state.maxRam}|${state.slotsAvailable}|${state.costMultiplier}|${state.softcap}`;
  for (const server of state.servers) key += `|${server.host}:${server.ram}`;
  if (key === CLOUD_QUOTES_KEY) return CLOUD_QUOTES;
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
  CLOUD_QUOTES_KEY = key;
  CLOUD_QUOTES = out;
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
  const quotes = cloudQuotes(cloud);
  const best = cheapestQuote(quotes);
  if (!best) return undefined;
  const equalPrice = (quote: RamSupplyQuote): boolean =>
    Math.abs(quote.costPerGb - best.costPerGb) <= Math.max(1, best.costPerGb) * 1e-12;
  let availableGb: number;
  if (best.kind === "buyServer") {
    availableGb = best.targetRam * cloud.slotsAvailable;
  } else {
    // Per host, the largest equally-priced upgrade of the winning kind. One
    // pass over the quotes rather than a filter of all of them per host: a
    // buyServer quote carries no host, so it can never match a real one.
    const bestPerHost = new Map<string, number>();
    for (const quote of quotes) {
      if (quote.host === undefined || quote.kind !== best.kind || !equalPrice(quote)) continue;
      const held = bestPerHost.get(quote.host);
      if (held === undefined || quote.addedRam > held) bestPerHost.set(quote.host, quote.addedRam);
    }
    availableGb = 0;
    // Distinct hosts: a host listed twice must still contribute once.
    for (const host of new Set(cloud.servers.map((server) => server.host))) {
      availableGb += Math.max(0, bestPerHost.get(host) ?? 0);
    }
  }
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
  if (!cloud) return undefined;
  // One generation, not two: `marginalCostPerGb` would build the same list
  // again, and only its price per GB is wanted here.
  const quotes = cloudQuotes(cloud);
  const marginal = cheapestQuote(quotes);
  if (!marginal) return undefined;
  const desiredGb = budget / Math.max(Number.EPSILON, marginal.costPerGb);
  const affordableFirst = (a: RamSupplyQuote, b: RamSupplyQuote): number =>
    b.addedRam - a.addedRam || a.cost - b.cost || compareSupply(a, b);
  let choice: RamSupplyQuote | undefined;
  for (const quote of quotes) {
    if (quote.cost > budget + 1e-9 || quote.addedRam > desiredGb + 1e-9) continue;
    if (choice === undefined || affordableFirst(quote, choice) < 0) choice = quote;
  }
  return choice;
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

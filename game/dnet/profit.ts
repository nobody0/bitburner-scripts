import type { DarknetProfit } from "../../shared/telemetry/topics/dnet.ts";

type DnetProfitDelta = Partial<DarknetProfit>;

export function emptyDnetProfit(): DarknetProfit {
  return {
    phishAttempts: 0,
    phishSuccesses: 0,
    phishCash: 0,
    phishCaches: 0,
    cachesOpened: 0,
    cacheCash: 0,
    cacheShares: 0,
    cacheRewards: {},
    promotionAttempts: 0,
    promotionBatches: 0,
    promotionThreads: 0,
    promotionSymbols: {},
  };
}

export function mergeDnetProfit(target: DarknetProfit, delta: DnetProfitDelta | undefined): void {
  if (!delta) return;
  target.phishAttempts += delta.phishAttempts ?? 0;
  target.phishSuccesses += delta.phishSuccesses ?? 0;
  target.phishCash += delta.phishCash ?? 0;
  target.phishCaches += delta.phishCaches ?? 0;
  target.cachesOpened += delta.cachesOpened ?? 0;
  target.cacheCash += delta.cacheCash ?? 0;
  target.cacheShares += delta.cacheShares ?? 0;
  target.promotionAttempts += delta.promotionAttempts ?? 0;
  target.promotionBatches += delta.promotionBatches ?? 0;
  target.promotionThreads += delta.promotionThreads ?? 0;
  if (delta.cacheRewards) {
    for (const [reward, count] of Object.entries(delta.cacheRewards)) {
      target.cacheRewards[reward] = (target.cacheRewards[reward] ?? 0) + count;
    }
  }
  if (delta.promotionSymbols) {
    for (const [symbol, count] of Object.entries(delta.promotionSymbols)) {
      target.promotionSymbols[symbol] = (target.promotionSymbols[symbol] ?? 0) + count;
    }
  }
}

export function hasDnetProfit(value: DarknetProfit): boolean {
  return value.phishAttempts > 0 || value.cachesOpened > 0 || value.promotionAttempts > 0;
}

/** Parse Bitburner's stable English/scientific numeric display. The simulator
 * currently emits an unformatted number in the same position, which this also
 * accepts. */
function amountAfter(message: string, prefix: RegExp): number {
  // String.match, never RegExp.exec: Bitburner's static RAM analyser treats a
  // property named `exec` as ns.exec and would bill every resident for 1.3 GB.
  const match = message.match(prefix);
  if (!match?.[1]) return 0;
  let token = match[1].replaceAll(" ", "").replaceAll("\u00a0", "").replaceAll("\u202f", "");
  // Intl may use either separator. At these call sites values >=1000 carry a
  // suffix, so a lone comma is a decimal mark rather than a thousands group.
  if (token.includes(",") && token.includes(".")) {
    if (token.lastIndexOf(",") > token.lastIndexOf(".")) token = token.replaceAll(".", "").replace(",", ".");
    else token = token.replaceAll(",", "");
  } else if (token.includes(",")) token = token.replace(",", ".");
  const suffix = match[2] ?? "";
  const suffixIndex = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n"].indexOf(suffix);
  const value = Number(token) * (suffixIndex < 0 ? 1 : 1000 ** suffixIndex);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function phishProfit(message: string, success: boolean): DnetProfitDelta {
  return {
    phishAttempts: 1,
    phishSuccesses: success ? 1 : 0,
    phishCash: amountAfter(message, /Phishing attack succeeded! \$([0-9](?:[0-9.,]*[0-9])?(?:e[+-]?[0-9]+)?)([kmbtqQsSon]?) retrieved/),
    phishCaches: success && message.includes("Found a cache file") ? 1 : 0,
  };
}

export function cacheProfit(message: string): DnetProfitDelta {
  const moneyPrefix = "You have discovered a cache with ";
  // formatMoney obeys the player's configurable currency symbol and whether it
  // appears before or after the value. The augmentation response shares the
  // prefix and augmentation names may contain digits, so exclude it before
  // looking for the first numeric token.
  const cash = message.startsWith(moneyPrefix)
    && !message.startsWith(moneyPrefix + "the augmentation ")
    ? amountAfter(message, /cache with [^0-9]*([0-9](?:[0-9.,]*[0-9])?(?:e[+-]?[0-9]+)?)([kmbtqQsSon]?)/i)
    : 0;
  const shares = message.match(/containing ([0-9]+) shares of ([A-Za-z0-9_-]+)/i);
  const program = message.match(/program ([^.]+\.[A-Za-z0-9]+)\./i);
  const augmentation = message.match(/augmentation ([^!]+)!/i);
  let label = "other";
  if (cash > 0) label = "money";
  else if (shares) label = `shares: ${shares[2]}`;
  else if (program) label = `program: ${program[1]}`;
  else if (augmentation) label = `augmentation: ${augmentation[1]}`;
  else if (message.includes("coding contracts")) label = "coding contracts";
  else if (message.includes("data file cache")) label = "data files";
  else if (message.includes("WSE Account")) label = "WSE account";
  else if (message.includes("TIX API")) label = "TIX API";
  else if (message.includes("4S Data")) label = "4S data";
  return {
    cachesOpened: 1,
    cacheCash: cash,
    cacheShares: shares ? Number(shares[1]) : 0,
    cacheRewards: { [label]: 1 },
  };
}

export function promotionProfit(symbol: string, threads: number, success: boolean): DnetProfitDelta {
  if (!success) return { promotionAttempts: 1 };
  return {
    promotionAttempts: 1,
    promotionBatches: 1,
    promotionThreads: threads,
    promotionSymbols: { [symbol]: 1 },
  };
}

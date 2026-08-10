/** Where to run a dodge stub.
 *
 * The insight, taken from the predecessor scripts: `stubCall` takes a
 * `hostname`, and they run a 32 GB `destroyW0r1dD43m0n` stub on a rooted client
 * rather than on home (src/_lib/stub-call.ts). All Bitburner scripts share one
 * JS realm, so the `globalThis` rendezvous a dodge uses to hand its result back
 * is realm-wide: a stub on n00dles returns its value exactly as a stub on home
 * does. That dissolves most of the RAM problem outright, because the fleet has
 * orders of magnitude more RAM than home ever will.
 * Source (scripts are imported into the page realm): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptJSEvaluator.ts#L208-L223
 *
 * Two things this must not do, and both are why placement is a policy rather
 * than "pick the biggest host":
 *
 *  - **Never evict live work.** Free RAM is supplied by the caller from the
 *    same ledger the dispatcher allocates against, so a host with reserved-
 *    but-not-yet-exec'd HWGW threads reads as full. Choosing on a raw
 *    `maxRam - ramUsed` scan would race the dispatcher and lose ops.
 *  - **Never fragment the fleet for a cheap call.** A 2 GB scan belongs on
 *    home; putting it on the one host with a large contiguous block would
 *    deny a hack op its landing site for the duration.
 *
 * Pure, so the same policy is testable without a game and identical in sim. */

/** Free RAM on one candidate host, from whatever ledger the caller trusts. */
export interface HostRam {
  hostname: string;
  /** GB genuinely available: max, minus used, minus anything reserved. */
  freeGb: number;
  /** False for hosts the stub has not been copied to. `ns.exec` of a missing
   *  file returns 0, which would look like a RAM failure and burn all the
   *  retries. */
  hasStub: boolean;
}

export interface PlacementOptions {
  /** At or below this budget, prefer home when it fits. A remote stub costs an
   *  extra scheduling hop for no benefit at small sizes, and home is the one
   *  host guaranteed to hold the stub. */
  homePreferenceGb?: number;
}

/** Base cost of the stub script itself, on top of the dynamic budget. Must
 * match game/lib/dodge.ts.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L10-L20 */
export const STUB_BASE_GB = 1.6;

export const DEFAULT_HOME_PREFERENCE_GB = 4;

/** Cheapest host that fits, preferring home for small budgets and the fleet
 * for large ones. `undefined` when nothing fits — which is a real answer, and
 * the caller reports it as an unaffordable probe rather than retrying. */
export function dodgeHost(
  hosts: readonly HostRam[],
  budgetGb: number,
  options: PlacementOptions = {},
): string | undefined {
  const needed = STUB_BASE_GB + budgetGb;
  const homePreference = options.homePreferenceGb ?? DEFAULT_HOME_PREFERENCE_GB;

  const home = hosts.find((host) => host.hostname === "home");
  if (budgetGb <= homePreference && home && home.hasStub && home.freeGb >= needed) return "home";

  // Best fit across the fleet: the SMALLEST host that fits, so large
  // contiguous blocks stay available for hack ops that cannot be split.
  let best: HostRam | undefined;
  for (const host of hosts) {
    if (host.hostname === "home" || !host.hasStub || host.freeGb < needed) continue;
    if (!best || host.freeGb < best.freeGb || (host.freeGb === best.freeGb && host.hostname < best.hostname)) {
      best = host;
    }
  }
  if (best) return best.hostname;

  // Home last: it is the fallback, not the preference, once the budget is big.
  return home && home.hasStub && home.freeGb >= needed ? "home" : undefined;
}

/** Largest dynamic budget any host could serve right now. This is what the
 * probe runner prices against, and what a feature driver is told it may spend.
 *
 * Fleet-wide rather than home-only: with placement in the picture, "what can I
 * afford to dodge" is a question about the whole realm. */
export function dodgeCapacityGb(hosts: readonly HostRam[]): number {
  let best = 0;
  for (const host of hosts) {
    if (!host.hasStub) continue;
    const usable = host.freeGb - STUB_BASE_GB;
    if (usable > best) best = usable;
  }
  return Math.max(0, best);
}

import { DARKSCAPE_COST, TOR_COST } from "./rates.ts";

/** Whether to buy DarkscapeNavigator.exe.
 *
 * The program is the only way to reach the darknet without BN15 or an active
 * SF15, and there is no way to create it — `Programs.ts` gives it `create: null`,
 * so it is bought or it is absent.
 *
 * What it is worth is NOT priced here, deliberately. Its real payoff is the
 * `.cache` reward table — free programs up to `Formulas.exe`, and free WSE / TIX
 * / 4S access, which `stock` otherwise buys for $200m + $5b + $25b — and none of
 * that is modelled anywhere in this project yet. Inventing an income rate to
 * feed the arbiter would be asserting a number we have not measured. So the
 * decision is affordability: buy it once the cost is small against liquid cash,
 * and let a later increment price it properly once the caches are modelled.
 *
 * The affordability test is what keeps that honest. An unpriced claim resolves
 * off the top of its band without ROI ranking, so bidding only when we hold ten
 * times the cost is what stops it displacing a priced hacknet or infrastructure
 * purchase that would earn more. */

/** Only bid when the cost is at most this share of liquid cash. At $50.2m that
 * means bidding from about $500m — by which point the purchase is noise against
 * the bankroll and cannot crowd out a better-priced investment. */
export const DARKSCAPE_AFFORDABLE_SHARE = 0.1;

export interface DarkscapeView {
  /** True when a simulation profile has switched `dnet` OFF. Buying access to a
   *  feature this run has been told not to play is waste — an isolated hacking
   *  soak has no use for a darknet, and spending there would make its numbers
   *  incomparable with every earlier measurement.
   *
   *  Deliberately NOT `activeFeatures.has("dnet")`: that set comes from
   *  `driverEnabled`, so `dnet` is missing from it exactly while it is locked,
   *  and gating on it deadlocks the purchase the same way gating `stock` on
   *  `hasWseAccount` once made the WSE account unbuyable. */
  dnetDisabled: boolean;
  bitNode?: number;
  /** Active SF15 level. */
  sf15: number;
  /** DarkscapeNavigator.exe present on home. `undefined` = not probed yet. */
  hasProgram?: boolean;
  /** Liquid cash. */
  money: number;
}

export interface DarkscapeDecision {
  buy: boolean;
  /** What to reserve. Always includes TOR — see `cost` below. */
  cost: number;
}

/** TOR is a precondition of `purchaseProgram` and is itself wiped by every
 * install, but nothing in the ordinary player snapshot reports whether we hold
 * it: `ns.getPlayer()` does not expose it, and `ns.scan` hides `darkweb`, so
 * home's neighbour list cannot answer either. `purchaseTor()` is idempotent, so
 * the executor simply calls it first and the claim always reserves its price —
 * $200k against $50m, which is not worth a probe to avoid. This mirrors
 * `buyPortOpener`. */
export const DARKSCAPE_TOTAL_COST = DARKSCAPE_COST + TOR_COST;

export function stepDarkscape(view: DarkscapeView): DarkscapeDecision {
  const cost = DARKSCAPE_TOTAL_COST;

  if (view.dnetDisabled) return { buy: false, cost };

  // Free in BN15 and with any active SF15: `Prestige.ts` re-grants it, and TOR,
  // at every install under `canAccessBitNodeFeature(15)`. Buying would be a
  // straight $50m loss.
  if (view.bitNode === 15 || view.sf15 > 0) {
    return { buy: false, cost };
  }
  if (view.hasProgram === undefined) {
    return { buy: false, cost };
  }
  if (view.hasProgram) return { buy: false, cost };

  if (!(view.money * DARKSCAPE_AFFORDABLE_SHARE >= cost)) {
    return { buy: false, cost };
  }
  return { buy: true, cost };
}

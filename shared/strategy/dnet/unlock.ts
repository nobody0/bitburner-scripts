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
 * decision is affordability: buy it as soon as TOR plus the program are
 * affordable, because it gates the entire darknet progression path. A later
 * increment can price its cache payoff once those rewards are modelled. */

/** Bid as soon as liquid cash covers the complete TOR + program purchase. */
export const DARKSCAPE_AFFORDABLE_SHARE = 1;

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

/** TOR is a precondition of `purchaseProgram` and is itself wiped by every
 * install, but nothing in the ordinary player snapshot reports whether we hold
 * it: `ns.getPlayer()` does not expose it, and `ns.scan` hides `darkweb`, so
 * home's neighbour list cannot answer either. `purchaseTor()` is idempotent, so
 * the executor simply calls it first and the claim always reserves its price —
 * $200k against $50m, which is not worth a probe to avoid. This mirrors
 * `buyPortOpener`. */
export const DARKSCAPE_TOTAL_COST = DARKSCAPE_COST + TOR_COST;

/** Whether to buy DarkscapeNavigator.exe right now. The claim reserves
 * DARKSCAPE_TOTAL_COST when this is true. */
export function stepDarkscape(view: DarkscapeView): boolean {
  return (
    !view.dnetDisabled &&
    // Free in BN15 and with any active SF15: `Prestige.ts` re-grants it, and
    // TOR, at every install under `canAccessBitNodeFeature(15)`. Buying would
    // be a straight $50m loss.
    view.bitNode !== 15 && view.sf15 === 0 &&
    // Only once the gate probe has reported the program absent (`undefined`
    // means not probed yet), and only when the complete cost is affordable.
    view.hasProgram === false &&
    view.money * DARKSCAPE_AFFORDABLE_SHARE >= DARKSCAPE_TOTAL_COST
  );
}

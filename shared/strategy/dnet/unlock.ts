import { DARKSCAPE_COST, TOR_COST } from "./rates.ts";

/** Whether to buy DarkscapeNavigator.exe.
 *
 * The program is the only way to reach the darknet without BN15 or an active
 * SF15, and there is no way to create it — `Programs.ts` gives it `create: null`,
 * so it is bought or it is absent.
 *
 * The purchase gate remains pure affordability; the money arbiter prices the
 * indivisible purchase with the calibrated route marginal below. */

/** Conservative gross value before BN15, in BN1 route-seconds saved.
 *
 * Reproduce with `bun run tools/dnet-value-calibration.ts`. The calibration is
 * a fresh BN1/SF0 matched pair with only the SF4.3 automation allowance, equal
 * post-purchase cash, and Darkscape pre-granted only to the treatment. It uses
 * seeds 1..3, caps a local forecast delta at the 24-hour route horizon, takes
 * the median, discounts it by 10% for aggregate-Go optimism, and floors it. */
export const DARKSCAPE_EARLY_BN1_ROUTE_SECONDS = 77_760;

export interface DarkscapeView {
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
    // Free in BN15 and with any active SF15: `Prestige.ts` re-grants it, and
    // TOR, at every install under `canAccessBitNodeFeature(15)`. Buying would
    // be a straight $50m loss.
    view.bitNode !== 15 && view.sf15 === 0 &&
    // Only once the gate probe has reported the program absent (`undefined`
    // means not probed yet), and only when the complete cost is affordable.
    view.hasProgram === false &&
    view.money >= DARKSCAPE_TOTAL_COST
  );
}

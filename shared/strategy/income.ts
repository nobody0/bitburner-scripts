/** What competing for `Player.currentWork` is worth, in the currencies the slot
 * actually produces.
 *
 * The slot is exclusive and every claimant wants it for a different reason, so a
 * fixed number per claimant cannot compare them: `career:income` was a flat 30
 * whether crime was our best earner by an order of magnitude or a rounding error
 * next to the hacking farm. What is comparable is RATES — dollars per second and
 * reputation per second — scored against the best rate available from anyone.
 *
 * A claim's priority is the sum of what it delivers:
 *
 *     repFraction * REP_SPAN + moneyFraction * MONEY_SPAN
 *
 * Each fraction is "ours over the best announced", so the best option in a currency
 * scores its full span and a half-as-good one scores half. They ADD, because a job
 * that pays in both is worth both: best-rep-and-no-money is 60, best-money-and-no-rep
 * is 80, best-rep-and-half-money is 100.
 *
 * MONEY_SPAN EXCEEDS REP_SPAN DELIBERATELY. Our best income option outranks
 * reputation work, which is a decision about what the run is for rather than an
 * accident of the numbers: reputation that arrives after the money has already been
 * converted is worth less than the money that buys the augmentations. The
 * consequence is real and intended — while crime is the top earner it takes the slot
 * from faction work, and reputation only progresses once something else out-earns
 * it.
 *
 * Estimates, not measurements. A feature announcing a rate it merely expects is far
 * more useful than no announcement at all, because the comparison only has to get
 * the ORDER right; being wrong by a factor of two changes a fraction, not a winner.
 */

/** The best reputation option scores this. Matches what `factions:work` was worth
 *  as a constant, so a run where factions is the only reputation earner behaves
 *  exactly as before. */
export const REP_SPAN = 60;

/** The best money option scores this. Above {@link REP_SPAN} on purpose — see above. */
export const MONEY_SPAN = 80;

/** One feature's announced earning rate. */
export interface IncomeAnnouncement {
  /** Feature id, for the digest — this module stays free of the feature registry. */
  by: string;
  /** Money per second this feature expects to earn if left alone. */
  perSec: number;
  why: string;
}

/** Our rate as a fraction of the best anyone announced, clamped to `[0, 1]`.
 *
 * A zero or unknown best means "nobody is earning", and the only honest answer is
 * that we cannot claim to be a fraction of it — so an unmeasured field cannot
 * silently promote a claim to the top of the table. Being the only announcer is a
 * different case and correctly yields 1. */
export function rateFraction(ours: number, best: number): number {
  if (!(ours > 0) || !(best > 0)) return 0;
  return Math.min(1, ours / best);
}

/** The slot priority a claim earns from the rates it delivers. */
export function slotPriority(input: { repFraction?: number; moneyFraction?: number }): number {
  const rep = Math.min(1, Math.max(0, input.repFraction ?? 0));
  const money = Math.min(1, Math.max(0, input.moneyFraction ?? 0));
  return rep * REP_SPAN + money * MONEY_SPAN;
}

/** The largest announced rate, or 0 when nobody announced one. */
export function bestAnnounced(announcements: readonly IncomeAnnouncement[]): number {
  let best = 0;
  for (const entry of announcements) {
    if (entry.perSec > best) best = entry.perSec;
  }
  return best;
}

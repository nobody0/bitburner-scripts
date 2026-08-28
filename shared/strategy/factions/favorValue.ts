import { augCost, NEUROFLUX, scoreAug } from "./augs.ts";
import { bestWorkType, repFromDonation } from "./rep.ts";
import type { FactionsView } from "./state.ts";

/** What one favor event at a faction is actually worth, in work-seconds.
 *
 * Favor persists through augmentation installs, so — unlike node power — its
 * value must be priced over the remaining NODE, not the remaining install.
 *
 * Grounded in the real mechanics, favor has exactly two channels:
 *  1. RATE — faction work rep scales with (1 + favor/100). Worth something
 *     only while work (not donation) is the operative rep path.
 *  2. DONATION GATE — at `favorToDonate` favor, money buys rep directly.
 *     `repFromDonation` does NOT scale with favor, so the gate crossing is a
 *     one-time step, not a slope.
 *
 * NeuroFlux enters only through the highest-favor seller: late game the
 * donate→rep→NeuroFlux loop runs through one faction, so its escalating rep
 * ladder counts as remaining useful rep work there and nowhere else. */

export interface FavorPointValue {
  /** Work-seconds of reachable, still-valuable rep at this faction that the
   * favor RATE channel accelerates (0 when donation already outpaces work). */
  remainingWorkSec: number;
  /** One-time work-seconds saved when favor crosses the donation gate. */
  donationUnlockSec: number;
  donateThreshold: number;
  /** The NeuroFlux ladder was counted here (top-favor seller only). */
  includesNeuroflux: boolean;
}

/** Highest NeuroFlux rep requirement the expected node income can fund. */
function neurofluxTargetRep(view: FactionsView, budget: number): number {
  const neuroflux = view.catalog.get(NEUROFLUX);
  if (!neuroflux) return 0;
  let spent = 0;
  let repTarget = 0;
  for (let level = 0; level < 64; level++) {
    const cost = augCost(neuroflux, {
      ...view.priceContext,
      neurofluxLevel: view.priceContext.neurofluxLevel + level,
    });
    spent += cost.moneyCost;
    if (spent > budget) break;
    repTarget = cost.repCost;
  }
  return repTarget;
}

export function factionFavorPointValues(view: FactionsView): Map<string, FavorPointValue> {
  const out = new Map<string, FavorPointValue>();
  const horizonSec = Number.isFinite(view.horizonSec) ? Math.max(0, view.horizonSec) : 3_600;
  const incomePerSec = Math.max(0, view.incomePerSec);
  // One donated dollar buys the same rep at every faction; only the gate
  // differs. Rate of rep per second if the whole income stream were donated.
  const donationRepPerSec = repFromDonation(
    incomePerSec,
    view.person.mults.faction_rep,
    view.repContext.factionWorkRepGain,
  );
  const neuroflux = view.catalog.get(NEUROFLUX);
  // One pass for one winner. The copy-filter-sort this replaces allocated three
  // arrays and ordered the whole list to read its head, on a path the faction
  // planner runs constantly.
  let nfgBest: (typeof view.factions)[number] | undefined;
  if (neuroflux) {
    for (const standing of view.factions) {
      if (!standing.joined || !neuroflux.factions.includes(standing.name)) continue;
      // Most favour, then most rep, then first by name — and on a full tie the
      // earlier entry stays, matching what a stable sort would have kept.
      const better = nfgBest === undefined
        || (standing.favor - nfgBest.favor
          || standing.rep - nfgBest.rep
          || (standing.name < nfgBest.name ? 1 : -1)) > 0;
      if (better) nfgBest = standing;
    }
  }
  const nfgSeller = nfgBest?.name;
  const nfgRepTarget = nfgSeller !== undefined
    ? neurofluxTargetRep(view, incomePerSec * horizonSec)
    : 0;

  for (const standing of view.factions) {
    if (!standing.joined) continue;
    // Highest rep gate among this faction's still-valuable, un-owned
    // augmentations. Value is judged by the run's own weights — an exhausted
    // faction prices at zero without any special-casing.
    let repTarget = 0;
    for (const aug of view.catalog.values()) {
      if (aug.name === NEUROFLUX || view.owned.has(aug.name)) continue;
      if (!aug.factions.includes(standing.name)) continue;
      if (scoreAug(aug, view.weights, view.rates?.worth) <= 0) continue;
      const { repCost } = augCost(aug, view.priceContext);
      if (repCost > repTarget) repTarget = repCost;
    }
    const includesNeuroflux = standing.name === nfgSeller && nfgRepTarget > 0;
    if (includesNeuroflux) repTarget = Math.max(repTarget, nfgRepTarget);

    const remainingRep = Math.max(0, repTarget - standing.rep);
    const work = bestWorkType(standing.offers, view.person, standing.favor, view.repContext, true);
    const workRepPerSec = work?.repPerSec ?? 0;
    const workSec = remainingRep === 0
      ? 0
      : workRepPerSec > 0
        ? Math.min(horizonSec, remainingRep / workRepPerSec)
        : horizonSec;
    const donatable = standing.favor >= view.favorToDonate;
    const donationDominates = donationRepPerSec > workRepPerSec;
    out.set(standing.name, {
      // Once donation is unlocked AND outpaces work, the rep path no longer
      // runs through favored work — the rate channel is worthless.
      remainingWorkSec: donatable && donationDominates ? 0 : workSec,
      donationUnlockSec: !donatable && donationDominates && workSec > 0
        ? workSec * Math.max(0, 1 - workRepPerSec / donationRepPerSec)
        : 0,
      donateThreshold: view.favorToDonate,
      includesNeuroflux,
    });
  }
  return out;
}

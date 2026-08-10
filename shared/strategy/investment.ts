import { roundSigFigs } from "../format.ts";

/** A common economic unit for purchases made by otherwise independent
 * features. `incomePerSec / cost` is return on one invested dollar per
 * second; its reciprocal is the payback period. */
export interface Investment {
  cost: number;
  incomePerSec: number;
}

export interface ScoredInvestment {
  paybackSec: number;
  netOverHorizon: number;
  returnPerDollarSec: number;
}

export function scoreInvestment(investment: Investment, horizonSec: number): ScoredInvestment {
  const productive = investment.incomePerSec > 0 && investment.cost > 0;
  return {
    paybackSec: productive ? investment.cost / investment.incomePerSec : Infinity,
    netOverHorizon: investment.incomePerSec * Math.max(0, horizonSec) - investment.cost,
    returnPerDollarSec: productive ? investment.incomePerSec / investment.cost : 0,
  };
}

export function paysBackWithin(investment: Investment, horizonSec: number): boolean {
  return scoreInvestment(investment, horizonSec).netOverHorizon > 0;
}

/** Horizon for REPORTS (digests, why-strings): 2 significant figures.
 *
 * Decisions keep the exact number; publishing it raw made every digest whose
 * signature embeds a horizon differ each second as the forecast ticked down —
 * one change-filtered store record per second for the whole run. */
export function coarseHorizonSec(sec: number): number {
  if (sec <= 0) return sec; // a non-positive horizon is reported raw, not rounded
  return roundSigFigs(sec, 2);
}

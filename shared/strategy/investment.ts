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

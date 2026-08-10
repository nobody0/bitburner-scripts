import { formatMoney, formatNumber } from "../format.ts";
import { coarseHorizonSec, scoreInvestment, type ScoredInvestment } from "./investment.ts";

export interface HomeRamView {
  currentRam: number;
  upgradeCost: number;
  /** Expected steady-state hacking dollars produced by one additional GB. */
  incomePerSecPerGb: number;
  horizonSec: number;
}

export interface HomeRamDecision extends ScoredInvestment {
  cost: number;
  addedRam: number;
  incomePerSec: number;
  worthBuying: boolean;
  why: string;
}

export type InfrastructureKind = "homeRam" | "homeCore" | "buyServer" | "upgradeServer";

export interface InfrastructureOption {
  kind: InfrastructureKind;
  cost: number;
  /** Capacity added for RAM purchases. Zero for a core upgrade. */
  addedRam: number;
  /** Marginal steady-state hacking income produced by this exact purchase. */
  incomePerSec: number;
  /** Payoff window for THIS option when it differs from the decision's
   * default — purchased cloud servers die at the next install while home
   * upgrades live for the whole node, so the two amortize differently. */
  horizonSec?: number;
  host?: string;
  targetRam?: number;
}

export interface ScoredInfrastructure extends InfrastructureOption, ScoredInvestment {
  worthBuying: boolean;
  why: string;
}

export interface InfrastructureDecision {
  buy?: ScoredInfrastructure;
  ranked: ScoredInfrastructure[];
  why: string;
  hold?: string;
}

/** Doubling home adds `currentRam` GB. Score that capacity in exactly the
 * same dollars/sec-per-dollar unit used by Hacknet. */
export function scoreHomeRam(view: HomeRamView): HomeRamDecision {
  const addedRam = Math.max(0, view.currentRam);
  const incomePerSec = addedRam * Math.max(0, view.incomePerSecPerGb);
  const scored = scoreInvestment({ cost: view.upgradeCost, incomePerSec }, view.horizonSec);
  const worthBuying = Number.isFinite(view.upgradeCost) && scored.netOverHorizon > 0;
  return {
    ...scored,
    cost: view.upgradeCost,
    addedRam,
    incomePerSec,
    worthBuying,
    why: worthBuying
      ? `${formatNumber(addedRam)} GB adds about ${formatMoney(incomePerSec)}/sec and pays back in ${Math.round(scored.paybackSec)}s`
      : `home RAM does not repay ${formatMoney(view.upgradeCost)} within ${coarseHorizonSec(view.horizonSec)}s`,
  };
}

/** Score one observed infrastructure quote in the same unit as Hacknet. */
export function scoreInfrastructure(option: InfrastructureOption, horizonSec: number): ScoredInfrastructure {
  const horizon = option.horizonSec ?? horizonSec;
  const scored = scoreInvestment({ cost: option.cost, incomePerSec: option.incomePerSec }, horizon);
  const worthBuying = Number.isFinite(option.cost) && option.cost > 0 && scored.netOverHorizon > 0;
  const label = option.kind === "homeRam" ? "home RAM"
    : option.kind === "homeCore" ? "a home core"
    : option.kind === "buyServer" ? `${formatNumber(option.targetRam ?? option.addedRam)} GB cloud server`
    : `${option.host ?? "cloud server"} to ${formatNumber(option.targetRam ?? 0)} GB`;
  return {
    ...option,
    ...scored,
    worthBuying,
    why: worthBuying
      ? `${label} adds about ${formatMoney(option.incomePerSec)}/sec and pays back in ${Math.round(scored.paybackSec)}s`
      : `${label} does not repay ${formatMoney(option.cost)} within ${coarseHorizonSec(horizon)}s`,
  };
}

/** Choose at most one atomic infrastructure purchase per pass. The arbiter
 * then compares this winner directly with Hacknet's winner. */
export function stepInfrastructure(options: readonly InfrastructureOption[], horizonSec: number): InfrastructureDecision {
  const ranked = options
    .map((option) => scoreInfrastructure(option, horizonSec))
    .sort((a, b) => {
      if (a.worthBuying !== b.worthBuying) return b.worthBuying ? 1 : -1;
      if (b.returnPerDollarSec !== a.returnPerDollarSec) return b.returnPerDollarSec - a.returnPerDollarSec;
      if (b.incomePerSec !== a.incomePerSec) return b.incomePerSec - a.incomePerSec;
      const ak = `${a.kind}:${a.host ?? ""}:${a.targetRam ?? 0}`;
      const bk = `${b.kind}:${b.host ?? ""}:${b.targetRam ?? 0}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  const best = ranked[0];
  if (!best) return { ranked, why: "no infrastructure quotes available", hold: "nothing to buy" };
  if (!best.worthBuying) {
    return { ranked, why: "every infrastructure purchase loses money before the horizon", hold: best.why };
  }
  return { buy: best, ranked, why: best.why };
}

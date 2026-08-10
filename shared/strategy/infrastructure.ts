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
  /** Best productive income/sec per dollar, including temporarily
   * unaffordable quotes. Used to value the compounding option of money now. */
  reinvestmentReturnPerDollarSec: number;
  why: string;
  hold?: string;
}

/** The purchased-server aggregate carried by the fleet topic. Kept structural
 * here so the pure strategy does not depend on a telemetry schema. */
export interface PurchasedInfrastructure {
  count: number;
  totalRam: number;
  limit?: number;
  maxRamPerServer?: number;
}

/** Advance a probed one-step frontier after the game confirms a purchase.
 *
 * A mutation invalidates only its own next-step quote. Quotes for unrelated
 * hosts remain authoritative, so discarding the whole frontier needlessly
 * serialises independent purchases on the next probe. The new host/next level
 * still waits for observation; this function never invents a quote. */
export function advanceInfrastructureFrontier<T extends Pick<InfrastructureOption, "kind" | "host" | "addedRam">>(
  options: readonly T[],
  purchased: PurchasedInfrastructure | undefined,
  bought: Pick<InfrastructureOption, "kind" | "host" | "addedRam">,
): { options: T[]; purchased?: PurchasedInfrastructure } {
  let next = [...options];
  let nextPurchased = purchased;
  if (bought.kind === "upgradeServer") {
    next = next.filter((option) => option.kind !== "upgradeServer" || option.host !== bought.host);
    if (purchased) nextPurchased = { ...purchased, totalRam: purchased.totalRam + bought.addedRam };
  } else if (bought.kind === "buyServer") {
    if (!purchased) return { options: next.filter((option) => option.kind !== "buyServer") };
    const count = purchased.count + 1;
    nextPurchased = { ...purchased, count, totalRam: purchased.totalRam + bought.addedRam };
    next = next.filter((option) => option.kind !== "buyServer");
  }
  return { options: next, ...(nextPurchased ? { purchased: nextPurchased } : {}) };
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
export function stepInfrastructure(
  options: readonly InfrastructureOption[],
  horizonSec: number,
  availableMoney = Infinity,
): InfrastructureDecision {
  const scored = options.map((option) => scoreInfrastructure(option, horizonSec));
  const reinvestmentReturnPerDollarSec = scored.reduce(
    (best, option) => option.worthBuying ? Math.max(best, option.returnPerDollarSec) : best,
    0,
  );
  const ranked = scored
    // These are mutually exclusive one-step actions: the feature publishes
    // one winner to the central arbiter. An unaffordable winner would be
    // denied there, but the affordable alternatives hidden behind it would
    // never become claims. Keep the local frontier executable so the arbiter
    // can compare its winner with every other feature's real investment.
    .filter((option) => option.cost <= availableMoney)
    .sort((a, b) => {
      if (a.worthBuying !== b.worthBuying) return b.worthBuying ? 1 : -1;
      if (b.returnPerDollarSec !== a.returnPerDollarSec) return b.returnPerDollarSec - a.returnPerDollarSec;
      if (b.incomePerSec !== a.incomePerSec) return b.incomePerSec - a.incomePerSec;
      // Equal dollars buy equal aggregate capacity, but the larger resulting
      // host can place every job the smaller one can plus indivisible hack
      // calls that do not fit there. It also preserves a purchased-server
      // slot, so concentration strictly dominates scattering in this tie.
      if ((b.targetRam ?? 0) !== (a.targetRam ?? 0)) return (b.targetRam ?? 0) - (a.targetRam ?? 0);
      const ak = `${a.kind}:${a.host ?? ""}:${a.targetRam ?? 0}`;
      const bk = `${b.kind}:${b.host ?? ""}:${b.targetRam ?? 0}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  const best = ranked[0];
  if (!best) return { ranked, reinvestmentReturnPerDollarSec, why: "no infrastructure quotes available", hold: "nothing to buy" };
  if (!best.worthBuying) {
    return { ranked, reinvestmentReturnPerDollarSec, why: "every infrastructure purchase loses money before the horizon", hold: best.why };
  }
  return { buy: best, ranked, reinvestmentReturnPerDollarSec, why: best.why };
}

import { scoreInvestment, type ScoredInvestment } from "./investment.ts";
import type { Need } from "./needs.ts";

/** A lower-urgency prerequisite may be useful later, but it must not drain the
 * bankroll while another subsystem is blocked on a concrete cash threshold.
 * Ready/free actions do not use this rule; callers apply it only to purchases. */
export function deferPrerequisitePurchase(
  urgency: Need["urgency"],
  openNeeds: readonly Need[],
): boolean {
  return urgency !== "blocking"
    && openNeeds.some((need) => need.kind === "money" && need.urgency === "blocking");
}

/** Cap optimistic marginal RAM quotes by throughput the installed fleet has
 * actually demonstrated. The evaluator's ideal $/s/GB is useful for ordinary
 * long-horizon ranking, but during an unsettled bootstrap it can price one new
 * server as if the whole target pipeline were already prepared. Cash-goal
 * crossover decisions need the conservative observed rate instead.
 *
 * This is deliberately not a general valuation: a measured bn1-speedrun had
 * a modelled 480 $/s/GB quote reduced to 1.63 $/s/GB, then fed that quote back
 * into ranking. The fleet stalled at 156 GB because capacity was valued only
 * by the income it could produce after that capacity had already been bought. */
export function capInfrastructureByObservedFleet(
  options: readonly InfrastructureOption[],
  observedIncomePerSec: number,
): InfrastructureOption[] {
  const observedFleetIncome = Math.max(0, observedIncomePerSec);
  return options.map((option) => option.addedRam > 0
    ? {
        ...option,
        incomePerSec: Math.min(
          Math.max(0, option.incomePerSec),
          observedFleetIncome,
        ),
      }
    : { ...option });
}

/** Keep only investments that make a blocking cash threshold arrive sooner.
 * This is the exact one-purchase crossover, not a savings heuristic:
 *
 *   without = (target - money) / currentIncome
 *   with    = (target - money + cost) / (currentIncome + addedIncome)
 *
 * Once the balance reaches the threshold, preserve it until the requester
 * withdraws the need; invitation checks and controller ticks are asynchronous. */
export function infrastructureBeforeMoneyNeeds(
  options: readonly InfrastructureOption[],
  money: number,
  currentIncomePerSec: number,
  needs: readonly Need[],
  capByObservedFleet = false,
): InfrastructureOption[] {
  const target = needs.reduce(
    (highest, need) => need.kind === "money" && need.urgency === "blocking"
      ? Math.max(highest, need.target)
      : highest,
    0,
  );
  if (!(target > 0)) return [...options];
  if (money >= target) return [];
  const remaining = target - money;
  const income = Math.max(0, currentIncomePerSec);
  const withoutSec = income > 0 ? remaining / income : Infinity;
  // Observed throughput belongs only in this cash-arrival crossover. Return
  // the original modelled quotes so ordinary ROI ranking can value capacity
  // by the work it enables instead of creating a bootstrap feedback loop.
  const crossover = capByObservedFleet
    ? capInfrastructureByObservedFleet(options, income)
    : options;
  return options.filter((option, index) => {
    const withIncome = income + Math.max(0, crossover[index]?.incomePerSec ?? 0);
    if (!(withIncome > 0)) return false;
    return (remaining + option.cost) / withIncome < withoutSec;
  });
}

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
}

export interface InfrastructureDecision {
  buy?: ScoredInfrastructure;
  ranked: ScoredInfrastructure[];
  /** Best productive income/sec per dollar, including temporarily
   * unaffordable quotes. Used to value the compounding option of money now. */
  reinvestmentReturnPerDollarSec: number;
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
  };
}

/** Score one observed infrastructure quote in the same unit as Hacknet. */
export function scoreInfrastructure(option: InfrastructureOption, horizonSec: number): ScoredInfrastructure {
  const horizon = option.horizonSec ?? horizonSec;
  const scored = scoreInvestment({ cost: option.cost, incomePerSec: option.incomePerSec }, horizon);
  const worthBuying = Number.isFinite(option.cost) && option.cost > 0 && scored.netOverHorizon > 0;
  return {
    ...option,
    ...scored,
    worthBuying,
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
  if (!best) return { ranked, reinvestmentReturnPerDollarSec };
  if (!best.worthBuying) {
    return { ranked, reinvestmentReturnPerDollarSec };
  }
  return { buy: best, ranked, reinvestmentReturnPerDollarSec };
}

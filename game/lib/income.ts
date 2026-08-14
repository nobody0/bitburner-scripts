import { ENGINE_CYCLE_MS } from "../../shared/strategy/career/schedule.ts";
import type { IncomeAnnouncement } from "../../shared/strategy/income.ts";
import type { MeasuredMarginal } from "../../shared/strategy/progression/marginal.ts";
import { bestAnnounced } from "../../shared/strategy/income.ts";
import { MS_PER_TICK } from "../../shared/strategy/stock/market.ts";
import type { GameState } from "./state.ts";

/** Engine cycles per real second: rates the game reports "per cycle" need this.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Constants.ts#L17-L20 */
const CYCLES_PER_SEC = 1_000 / ENGINE_CYCLE_MS;

/** Who earns what, per second, as each feature reports it.
 *
 * The read side of the income comparison in `shared/strategy/income.ts`. It lives
 * game-side because it walks topics, and in ONE place because the alternative is
 * every claimant hardcoding a different set of paths and quietly disagreeing about
 * who the best earner is.
 *
 * Announcements are whatever the feature can state cheaply and truthfully. A
 * measured rate is preferred where the game gives one; an expectation is fine where
 * it does not, because the comparison only needs the order right. A feature with
 * nothing honest to measure announces `unknown`, never a fabricated zero — see `rateFraction` for
 * why that distinction is load-bearing.
 *
 * WHO IS UNKNOWN, and why each is explicit rather than an oversight. Every one of
 * these can make the measured best too LOW, which flatters `career` — so they are
 * worth closing, and the direction of the error is worth knowing:
 *
 *  - `sleeves` earn real money in parallel, and in BN10 a great deal of it. The
 *    digest prices a task MENU (`taskOptions[].moneyPerSec`) rather than what the
 *    assigned sleeves are currently earning, so summing it would report what they
 *    COULD earn on their best assignment, not what they do. Closing this wants a
 *    per-sleeve current rate in the topic.
 *  - `bladeburner` contracts pay money, but the digest ranks actions by `rankPerSec`
 *    and never records their payout.
 *  - `side` solves coding contracts for one-off rewards. A per-second figure would
 *    have to be invented from a solve cadence nobody measures.
 *  - `go`, `stanek` and `dnet` produce bonuses and unlocks, not cash. */
export function announcedIncome(state: GameState): IncomeAnnouncement[] {
  const out: IncomeAnnouncement[] = [];

  // The hacking farm, measured: ns.getTotalScriptIncome() reports [$/sec from
  // currently running scripts, $/sec since the last augmentation].
  const scriptIncome = state.topics.fleet?.scriptIncome;
  const farmed = Array.isArray(scriptIncome) ? scriptIncome[0] : undefined;
  const farmEma = state.topics.farm?.moneyRate;
  if (farmed !== undefined || farmEma !== undefined) {
    out.push({
      by: "hacking",
      state: "measured",
      perSec: Math.max(0, farmed ?? 0, farmEma ?? 0),
      why: "measured current or rollup-smoothed script income",
    });
  } else {
    out.push({ by: "hacking", state: "unknown", reason: "script income has not been observed", why: "current script income" });
  }

  // Hacknet production is dollars only for nodes. Hash production is a
  // different currency until a spend decision converts it.
  const hacknet = state.topics.hacknet;
  if (hacknet?.hashes !== undefined) {
    out.push({ by: "hacknet", state: "unknown", reason: "hash production has no measured dollar conversion rate", why: "node production" });
  } else if (hacknet?.productionPerSec !== undefined) {
    out.push({ by: "hacknet", state: "measured", perSec: Math.max(0, hacknet.productionPerSec), why: "measured node production" });
  } else {
    out.push({ by: "hacknet", state: "unknown", reason: "node production has not been observed", why: "node production" });
  }

  // GangGenInfo.moneyGainRate is money per 200ms engine cycle.
  const gangRate = state.topics.gang?.moneyGainRate;
  if (gangRate !== undefined) {
    out.push({ by: "gang", state: "measured", perSec: Math.max(0, gangRate) * CYCLES_PER_SEC, why: "measured gang money gain" });
  }

  // Corporation revenue belongs to the corporation; dividends reach the player.
  const dividends = state.topics.corp?.dividendEarnings;
  if (dividends !== undefined) {
    out.push({ by: "corp", state: "measured", perSec: Math.max(0, dividends), why: "measured shareholder dividends" });
  }

  // The market announces its expected profit over its expected hold.
  const stock = state.topics.stock;
  const entry = stock?.plan?.entry;
  if (entry && entry.expectedProfit > 0 && entry.holdTicks > 0) {
    out.push({
      by: "stock",
      state: "measured",
      perSec: entry.expectedProfit / (entry.holdTicks * (MS_PER_TICK / 1_000)),
      why: "expected profit over the planned hold",
    });
  } else if (stock) {
    out.push({ by: "stock", state: "unknown", reason: "no priced position hold is published", why: "expected market profit" });
  }

  // Career publishes the menu it would actually select from. A published empty
  // or zero-paying menu is a measured zero; no plan is unknown.
  const careerPlan = state.topics.career?.plan;
  if (careerPlan) {
    out.push({ by: "career", state: "measured", perSec: careerBestPerSec(state), why: "best ranked career option" });
  } else {
    out.push({ by: "career", state: "unknown", reason: "career has not published a ranked option", why: "best ranked career option" });
  }

  // These features genuinely cannot turn their current topics into an income
  // rate. Announce that explicitly so absence can never be read as zero.
  out.push(
    { by: "sleeves", state: "unknown", reason: "task options do not report assigned-sleeve earnings", why: "parallel sleeve income" },
    { by: "bladeburner", state: "unknown", reason: "action ranking does not publish contract payouts", why: "contract income" },
    { by: "side", state: "unknown", reason: "one-off contract rewards have no measured solve cadence", why: "coding-contract income" },
  );

  return out;
}

/** The best money rate career itself offers, from its published ranking. */
export function careerBestPerSec(state: GameState): number {
  let best = 0;
  for (const entry of state.topics.career?.plan?.ranked ?? []) {
    if (entry.moneyPerSec > best) best = entry.moneyPerSec;
  }
  return best;
}

/** The best rate anyone announced, for scoring a claim against the field. */
export function bestIncomePerSec(state: GameState) {
  return bestAnnounced(announcedIncome(state));
}

/** Convert an added $/sec per unit into BN-seconds saved per unit. The unit can
 * be one atomic purchase (step pricing) or one dollar deployed (a continuous
 * value curve); both must use this same measured conversion. */
export function moneyRateValue(state: GameState, addedIncomePerUnit: number, now: number): MeasuredMarginal {
  const marginal = state.topics.progression?.plan?.marginals?.money;
  if (!marginal || marginal.state === "unknown") {
    return { state: "unknown", reason: marginal?.reason ?? "the progression money marginal is not published" };
  }
  const added = Math.max(0, addedIncomePerUnit);
  if (!(added > 0) || !(marginal.secondsPerRelativeRate > 0)) return { state: "measured", value: 0 };

  const earned = state.topics.progression?.moneySources?.sinceInstall?.total;
  const resetAt = state.topics.progression?.lastAugReset;
  const elapsedSec = resetAt === undefined ? 0 : Math.max(0, (now - resetAt) / 1_000);
  const observedIncomePerSec = Math.max(
    0,
    state.topics.fleet?.scriptIncome?.[0] ?? 0,
    state.topics.farm?.moneyRate ?? 0,
  );
  // Prefer the live/EMA productive rate when available. The cumulative money
  // probe runs on a slower cadence than claims, so requiring it exclusively
  // left Hacknet unpriced during the one pass where it actually competed with
  // infrastructure and reduced a real two-way auction to pricedClaimCount=1.
  const currentIncomePerSec = observedIncomePerSec > 0
    ? observedIncomePerSec
    : earned !== undefined && earned > 0 && elapsedSec > 0
      ? earned / elapsedSec
      : undefined;
  if (currentIncomePerSec === undefined) {
    return { state: "unknown", reason: "since-install money income has not been measured over a positive interval" };
  }
  return {
    state: "measured",
    value: marginal.secondsPerRelativeRate * added / currentIncomePerSec,
  };
}

/** Total BN-seconds saved by one lumpy income purchase. */
export function moneyStepValue(state: GameState, addedIncomePerSec: number, now: number): MeasuredMarginal {
  return moneyRateValue(state, addedIncomePerSec, now);
}
/** Best productive marginal return currently known to the central money
 * arbiter. Both grants and denials matter: money earned now can fund an
 * attractive investment even when the present bankroll cannot. Hacking's
 * infrastructure frontier also publishes its best productive quote because
 * it deliberately submits only an affordable alternative to arbitration. */
export function bestReinvestmentReturnPerDollarSec(state: GameState): number {
  let best = 0;
  const consider = (value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value) && value > best) best = value;
  };

  consider(state.topics.fleet?.infrastructurePlan?.reinvestmentReturnPerDollarSec);
  const arbitration = state.topics.progression?.arbitration;
  for (const claim of [...(arbitration?.grants ?? []), ...(arbitration?.denied ?? [])]) {
    if (claim.resource === "money") consider(claim.returnPerDollarSec);
  }
  return best;
}

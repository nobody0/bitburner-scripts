import { ENGINE_CYCLE_MS } from "../../shared/strategy/career/schedule.ts";
import type { IncomeAnnouncement } from "../../shared/strategy/income.ts";
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
 * nothing honest to say announces NOTHING rather than zero — see `rateFraction` for
 * why a fabricated zero is worse than an absence.
 *
 * WHO IS MISSING, and why each is an absence rather than an oversight. Every one of
 * these makes the announced best too LOW, which flatters `career` — so they are
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
  // currently running scripts, $/sec since the last augmentation]. The first
  // figure describes what the live fleet is earning now.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1278-L1290
  const scriptIncome = state.topics.fleet?.scriptIncome;
  const farmed = Array.isArray(scriptIncome) ? scriptIncome[0] : undefined;
  if (farmed !== undefined && farmed > 0) {
    out.push({ by: "hacking", perSec: farmed, why: "measured current script income" });
  }

  // Hacknet, measured — but only when it pays in money. On hacknet SERVERS the
  // production is hashes, which are not dollars until they are spent, so announcing
  // them here would compare a different currency as if it were cash.
  const hacknet = state.topics.hacknet;
  if (hacknet?.hashes === undefined && (hacknet?.productionPerSec ?? 0) > 0) {
    out.push({ by: "hacknet", perSec: hacknet!.productionPerSec, why: "measured node production" });
  }

  // The gang, measured. UNITS: `GangGenInfo.moneyGainRate` is money "per game
  // cycle" upstream, and a cycle is 200 ms — so it is five times smaller than a
  // per-second figure. Announcing it raw would understate the gang fivefold and hand
  // career a priority it did not earn.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Gang/Gang.ts#L125-L142 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Constants.ts#L17-L20
  const gangRate = state.topics.gang?.moneyGainRate;
  if (gangRate !== undefined && gangRate > 0) {
    out.push({ by: "gang", perSec: gangRate * CYCLES_PER_SEC, why: "measured gang money gain" });
  }

  // The corporation, measured, and DIVIDENDS rather than revenue: revenue is the
  // company's, dividends are the player's. `dividendEarnings` is documented upstream
  // as "your earnings as a shareholder per second", so no conversion.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Corporation.ts#L724-L737
  const dividends = state.topics.corp?.dividendEarnings;
  if (dividends !== undefined && dividends > 0) {
    out.push({ by: "corp", perSec: dividends, why: "measured shareholder dividends" });
  }

  // The market, EXPECTED: the profit the planned entry expects, spread over the hold
  // it expects to need. Not measured — this state stores no realised trading rate —
  // but an expectation is what this comparison is for, and a market that intends to
  // make $1b over ten minutes should not look like it earns nothing.
  const entry = state.topics.stock?.plan?.entry;
  if (entry && entry.expectedProfit > 0 && entry.holdTicks > 0) {
    out.push({
      by: "stock",
      perSec: entry.expectedProfit / (entry.holdTicks * (MS_PER_TICK / 1_000)),
      why: "expected profit over the planned hold",
    });
  }

  // Career, from its own published ranking: the best money rate among the options it
  // would actually take. Read from the digest rather than recomputed, so the claim
  // stays pure and cannot disagree with the decision it came from.
  const best = careerBestPerSec(state);
  if (best > 0) {
    out.push({ by: "career", perSec: best, why: "best ranked career option" });
  }

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
export function bestIncomePerSec(state: GameState): number {
  return bestAnnounced(announcedIncome(state));
}

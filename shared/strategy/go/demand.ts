import type { Need } from "../needs.ts";
import { currencyForNeed } from "../income.ts";
import { rankingValueSec } from "../access/value.ts";
import { fieldChannelResponse, type ValuedResource } from "../multipliers.ts";
import { installHorizonSec, type ForecastComponent, type PlanningHorizons } from "../progression/forecast.ts";
import { GO_EFFECT_FIELDS, GO_REWARD_OPPONENTS, type GoRewardOpponent } from "./rules.ts";
import type { GoEtaDemand } from "./rewards.ts";

/** What each IPvGO reward is worth to THIS run, in the seconds of critical path
 * it can shorten.
 *
 * The answer is a product of three measured things and no policy at all:
 *
 *   1. how many seconds of the remaining route the affected resource costs,
 *   2. which multiplier fields the opponent's Node Power actually lifts
 *      (`GO_EFFECT_FIELDS`) and what those fields accelerate
 *      (`shared/strategy/multipliers.ts`, the augmentation scorer's own table),
 *   3. how much of that resource the lifted subsystem really supplies — its
 *      live share of announced income.
 *
 * The predecessor hand-wrote a resource-to-opponent map, folded the share into
 * the seconds, and let contributions accumulate without a share-scaled ceiling.
 * The consumer then clipped the total at the install horizon, so every
 * money-attributed opponent clipped to the SAME number and the share vanished:
 * Hacknet production, three percent of a mature run's income, was priced as if
 * it were the whole economy and the controller farmed Netburners for hours.
 *
 * The invariant that replaces it: `seconds` is unshared and capped at the
 * runway, `share` rides alongside, and the consumer multiplies. A subsystem
 * supplying fraction s of a bottleneck can never be credited with more than
 * `s * runway`, however much evidence restates the same claim. */

/** Attribution before anything has been measured. Hacking is the one producer
 * present in every BitNode and the only one a Go reward accelerates
 * unconditionally; Hacknet and crime may not be running at all, and inventing a
 * share for a subsystem nobody has observed is exactly the failure this module
 * exists to prevent. Half, not one, because the farm is not yet the whole
 * economy either. */
const COLD_START_SHARES: Readonly<Record<string, number>> = { hacking: 0.5 };

export interface GoDemandView {
  horizons: PlanningHorizons;
  /** Live GROSS dollars-per-second share per announcer, from `incomeShares`.
   * An unmeasured source is ABSENT rather than zero: absent means a multiplier
   * on it cannot be priced, which is not the same claim as "it earns nothing".
   * Empty means nothing is measured yet, see COLD_START_SHARES. */
  incomeShares: Readonly<Record<string, number>>;
  /** The income-maximising crime and its published success chance, when the
   * career probe exposes one. `perSec` against `careerBestPerSec` bounds how
   * much of a career income share is crime rather than salary — a crime-success
   * reward accelerates exactly none of a paycheck. */
  crimeIncome?: { successChance: number; perSec: number; careerBestPerSec: number };
  openNeeds: readonly Need[];
  /** Forecasts can include future route phases whose producing subsystem is
   * unavailable on this save. They are diagnostic, not actionable demand. */
  canEarnFactionRep: boolean;
  canRunBladeburner: boolean;
}

interface ChannelDemand {
  sec: number;
  why: string[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** The channel an open need's bottleneck is denominated in.
 *
 * `currencyForNeed` already answers this for every kind the route model prices;
 * the rest are kinds Go can genuinely accelerate and it cannot.
 *
 * Hacknet capacity gates deliberately resolve to MONEY. A Hacknet RAM upgrade
 * is bought with the player's dollars from whatever source earned them, so it
 * is a money bottleneck like any other — and the reward that lifts three
 * percent of the money rate then earns three percent of the credit for it.
 * Routing them straight to Netburners at full attribution, as the predecessor
 * did, is the same unverified full-credit that broke the ranking. */
function channelForNeedKind(need: Need): ValuedResource | undefined {
  const currency = currencyForNeed(need);
  if (currency !== undefined) return currency;
  if (need.kind === "karma" || need.kind === "kills") return "crime";
  if (need.kind === "companyRep") return "reputation";
  if (need.kind === "backdoor") return "hacking";
  if (need.kind === "hacknetRam" || need.kind === "hacknetCores" || need.kind === "hacknetLevels") return "money";
  if (need.kind === "skill" && ["strength", "defense", "dexterity", "agility"].includes(need.subject ?? "")) {
    return "combat";
  }
  return undefined;
}

/** Fraction of a career income share that a crime-success multiplier can reach.
 * `announcedIncome` prices the career channel at its BEST ranked option, which
 * may be a salary; crime success moves none of that. */
function crimeIncomeFraction(view: GoDemandView): number {
  const crime = view.crimeIncome;
  if (!crime) return 0;
  const best = Math.max(0, crime.perSec, crime.careerBestPerSec);
  return best > 0 ? clamp01(Math.max(0, crime.perSec) / best) : 0;
}

export function goDemands(view: GoDemandView): Partial<Record<GoRewardOpponent, GoEtaDemand>> {
  // Go power is wiped by augmentation prestige. Use the same bounded
  // install-lifetime horizon as every other transient investment. The consumer
  // is handed this same number as `installRemainingSec`, so the two clips agree
  // by construction rather than by luck.
  const runway = installHorizonSec(view.horizons);
  const channels: Partial<Record<ValuedResource, ChannelDemand>> = {};

  const addChannel = (channel: ValuedResource, seconds: number, why: string): void => {
    if (!(seconds > 0)) return;
    // With no faction API a reputation multiplier accelerates nothing, whether
    // the evidence came from a forecast or the board.
    if (channel === "reputation" && !view.canEarnFactionRep) return;
    const previous = channels[channel];
    // Capped at the runway on the way IN. Several forecast components and an
    // open need routinely restate one bottleneck; their sum is bounded by the
    // horizon that bounds the reward itself.
    if (previous) {
      previous.sec = Math.min(runway, previous.sec + seconds);
      previous.why.push(why);
    } else {
      channels[channel] = { sec: Math.min(runway, seconds), why: [why] };
    }
  };

  const addComponent = (part: ForecastComponent, label: string): void => {
    if (part.resource === "money" || part.resource === "hacking" || part.resource === "reputation") {
      addChannel(part.resource, part.sec, label);
    } else if (part.resource === "augmentations") {
      // Aug acquisition is not a producer of its own. Before the count package
      // install it is paid for by the live income engine and often by faction
      // reputation, both of which Go can accelerate. Omitting this mapping made
      // a fresh Daedalus plan publish only `augCount`, so every Go candidate
      // appeared to save exactly zero seconds and play stopped for the entire
      // early node.
      addChannel("money", part.sec, `${label}; augmentation funding`);
      addChannel("reputation", part.sec * 0.5, `${label}; augmentation reputation`);
    } else if (part.resource === "combat" && view.canRunBladeburner) {
      // Combat NEEDS are not gated the same way: gang and crime want the same
      // stats without Bladeburner. Only a forecast can name a route phase whose
      // producing subsystem this save does not have.
      addChannel("combat", part.sec, label);
    }
  };

  if (view.horizons.install.state === "estimated") {
    for (const part of view.horizons.install.components) {
      if (part.critical) addComponent(part, `install component: ${part.what}`);
    }
  }
  if (view.horizons.node.state === "estimated") {
    for (const part of view.horizons.node.components) {
      // Node power is erased by augmentation prestige. Later route phases are
      // real ETA, but this game's transient reward cannot survive to affect
      // them (notably BN1's post-Red Pill hacking regrow).
      if (part.resource === "install") break;
      if (part.critical) addComponent(part, `node route component: ${part.what}`);
    }
  }
  for (const need of view.openNeeds) {
    const channel = channelForNeedKind(need);
    // The board's own measured economics when it has them, and the shared
    // nominal window when it does not. The predecessor charged a weight-10 need
    // the ENTIRE runway, which is how the horizon saturated in the first place.
    if (channel !== undefined) addChannel(channel, rankingValueSec(need), need.why);
  }

  const shares = Object.keys(view.incomeShares).length > 0 ? view.incomeShares : COLD_START_SHARES;
  // Career income is priced at its BEST ranked option, which may be a salary,
  // so only the crime slice of it is reachable by a crime-success reward. With
  // no published crime at all this is zero, which drops the crime money leg
  // entirely: no SF4 means the same missing source file hides both the rate and
  // whether it is already at its cap, and crediting unverified elasticity at
  // full strength is the pattern that produced this bug.
  const moneyShares = { ...shares, career: (shares.career ?? 0) * crimeIncomeFraction(view) };
  const demands: Partial<Record<GoRewardOpponent, GoEtaDemand>> = {};
  for (const opponent of GO_REWARD_OPPONENTS) {
    // Per channel, the STRONGEST response any of this opponent's fields has.
    // Max across fields landing on one channel: Tetrads' four stats are one
    // combat gate and Daedalus' two reputation fields one reputation channel,
    // so summing them would charge the same work two and four times over. Sum
    // across DISTINCT channels below: Illuminati's cycle speed genuinely
    // shortens both the money work and the hacking-experience work.
    const response: Partial<Record<ValuedResource, number>> = {};
    let gainCap: number | undefined;
    for (const field of GO_EFFECT_FIELDS[opponent]) {
      // Success chance is the one reward ceiling in reach: at chance c neither
      // the money nor the karma a crime yields can grow by more than 1 - c,
      // however far Node Power pushes the multiplier.
      if (field === "crime_success" && view.crimeIncome) {
        gainCap = clamp01(1 - view.crimeIncome.successChance);
      }
      for (const [channel, sensitivity] of Object.entries(fieldChannelResponse(field, moneyShares)) as [ValuedResource, number][]) {
        response[channel] = Math.max(response[channel] ?? 0, sensitivity);
      }
    }
    let baseSec = 0;
    let weightedSec = 0;
    const why: string[] = [];
    for (const [channel, sensitivity] of Object.entries(response) as [ValuedResource, number][]) {
      const demand = channels[channel];
      if (!demand) continue;
      baseSec += demand.sec;
      weightedSec += demand.sec * sensitivity;
      why.push(...demand.why);
    }
    if (!(baseSec > 0) || !(weightedSec > 0)) continue;
    demands[opponent] = {
      seconds: Math.min(baseSec, runway),
      share: clamp01(weightedSec / baseSec),
      ...(gainCap !== undefined ? { gainCap } : {}),
      why: [...new Set(why)].join("; "),
    };
  }
  return demands;
}

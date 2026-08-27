import { rankingValueSec } from "./access/value.ts";
import { needKey, type Need, type NeedBoard } from "./needs.ts";
import { MARGINAL_RESOURCES, type MarginalResource, type MeasuredMarginal, type ProgressionMarginals } from "./progression/marginal.ts";

/** What a rate is WORTH, and what competing for `Player.currentWork` is worth.
 *
 * The slot is exclusive and every claimant wants it for a different reason, so a
 * fixed number per claimant cannot compare them: `career:income` was a flat 30
 * whether crime was our best earner by an order of magnitude or a rounding error
 * next to the hacking farm. What is comparable is RATES — dollars per second,
 * reputation per second, experience per second — scored against the best rate
 * available from anyone, and then converted into the only unit the whole run
 * shares: BN-SECONDS SAVED.
 *
 *     valueSec = Σ_channel  (ourRate / bestRate) × worthSec(channel)
 *
 * `ourRate / bestRate` is the relative rate increase handing this claim the slot
 * buys, and `worthSec` is what progression measured a 100% relative increase to
 * be worth (`ProgressionMarginals.secondsPerRelativeRate`). Their product is
 * seconds off the route. They ADD, because work that pays in two currencies is
 * worth both.
 *
 * THE SPANS THIS REPLACES. Priority used to be `repFraction * 60 + moneyFraction
 * * 80`, with the excess deliberately ranking money above reputation. That is a
 * policy baked into a constant, and it is wrong in both directions depending on
 * the node: mid-run with a farm earning four orders of magnitude more than crime,
 * money is worth literally zero seconds off the route while reputation is the
 * only binding part of it; early — or in a node where the fleet cannot run — work
 * money is genuinely the best thing the slot can do. Both answers now fall out of
 * the same measurement instead of a hardcoded ordering.
 *
 * Estimates, not measurements. A feature announcing a rate it merely expects is far
 * more useful than no announcement at all, because the comparison only has to get
 * the ORDER right; being wrong by a factor of two changes a fraction, not a winner.
 */

/** What a rate is produced IN. The three progression currencies are priced by
 * `ProgressionMarginals`; anything else is a needs-board key (`needKey`), priced
 * by what the poster said satisfying it is worth. */
export type RateChannel = string;

export const MONEY_CHANNEL = "money" satisfies MarginalResource;
export const HACKING_CHANNEL = "hacking" satisfies MarginalResource;
export const CHARISMA_CHANNEL = "charisma" satisfies MarginalResource;
export const REPUTATION_CHANNEL = "reputation" satisfies MarginalResource;
export const COMBAT_CHANNEL = "combat" satisfies MarginalResource;
export const BLADEBURNER_RANK_CHANNEL = "bladeburnerRank" satisfies MarginalResource;
export const AUGMENTATIONS_CHANNEL = "augmentations" satisfies MarginalResource;

/** One feature's explicit earning-rate announcement. Unknown is a first-class
 * statement, never a numeric zero. */
export type IncomeAnnouncement =
  | {
      by: string;
      state: "measured";
      /** Money per second this feature expects to earn if left alone. */
      perSec: number;
    }
  | {
      by: string;
      state: "unknown";
      reason: string;
    };

/** An announcement about any channel — the money-only form plus what it is in. */
export type RateAnnouncement = IncomeAnnouncement & { channel: RateChannel };

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

/** The largest positive measured rate. If nobody can measure a positive rate,
 * preserve the distinction between a measured zero and an unknown field. */
export function bestAnnounced(announcements: readonly IncomeAnnouncement[]): MeasuredMarginal {
  let best = 0;
  let measured = false;
  const unknown: string[] = [];
  for (const entry of announcements) {
    if (entry.state === "unknown") {
      unknown.push(entry.by + ": " + entry.reason);
      continue;
    }
    measured = true;
    if (entry.perSec > best) best = entry.perSec;
  }
  if (best > 0 || (measured && unknown.length === 0)) return { state: "measured", value: best };
  return {
    state: "unknown",
    reason: unknown.length > 0 ? unknown.join("; ") : "no feature has announced an income observation",
  };
}

/** The best rate per channel — the ALTERNATIVES table. What else could produce
 * this, and how fast, so a claim is scored as a fraction of the field rather
 * than on its own say-so. */
export function bestByChannel(announcements: readonly RateAnnouncement[]): Map<RateChannel, MeasuredMarginal> {
  const byChannel = new Map<RateChannel, RateAnnouncement[]>();
  for (const entry of announcements) {
    const group = byChannel.get(entry.channel);
    if (group) group.push(entry);
    else byChannel.set(entry.channel, [entry]);
  }
  const out = new Map<RateChannel, MeasuredMarginal>();
  for (const [channel, group] of byChannel) out.set(channel, bestAnnounced(group));
  return out;
}

/** BN-seconds a 100% relative increase in one channel is worth. An absent
 * channel is "nobody has priced this"; a present zero is "priced, and worth
 * nothing" — that distinction decides whether a claim can be priced at all. */
export type ChannelWorth = ReadonlyMap<RateChannel, number>;

export interface ChannelValue {
  channel: RateChannel;
  ourRate: number;
  /** Best announced rate for this channel; absent when nobody could measure one. */
  bestRate?: number;
  worthSec: number;
  valueSec: number;
}

export interface SlotValue {
  /** `priced` when at least one channel this claim produces carries a worth.
   *  `unpriced` means nothing it offers has been valued — a fresh install with
   *  no forecast and an empty board — and the caller falls back to raw money.
   *  See `compareSlotValues`. */
  state: "priced" | "unpriced";
  /** Σ over channels, in BN-seconds saved by handing this claim the slot. */
  valueSec: number;
  /** Money per second the claim produces, kept separately: it is the bootstrap
   *  ordering key, and it is always worth showing. */
  moneyPerSec: number;
  channels: ChannelValue[];
}

/** Price one claim's production against the field. */
export function slotValue(input: {
  produces: Readonly<Record<RateChannel, number>>;
  best: ReadonlyMap<RateChannel, MeasuredMarginal>;
  worth: ChannelWorth;
}): SlotValue {
  const channels: ChannelValue[] = [];
  let valueSec = 0;
  let priced = false;
  for (const channel of Object.keys(input.produces).sort()) {
    const ourRate = input.produces[channel] ?? 0;
    if (!(ourRate > 0)) continue;
    const worthSec = input.worth.get(channel);
    if (worthSec === undefined) continue;
    priced = true;
    const best = input.best.get(channel);
    const bestRate = best?.state === "measured" ? best.value : undefined;
    // `rateFraction` yields 0 against an unknown best on purpose: a claim must
    // not promote itself by nobody else having spoken. A channel we alone
    // produce still scores its full worth, because `raiseBest` has already put
    // our own rate into the table — being the only producer of something and
    // having no measurement for it are different statements.
    const fraction = rateFraction(ourRate, bestRate ?? 0);
    const contribution = fraction * worthSec;
    valueSec += contribution;
    channels.push({
      channel,
      ourRate,
      ...(bestRate !== undefined ? { bestRate } : {}),
      worthSec,
      valueSec: contribution,
    });
  }
  return {
    state: priced ? "priced" : "unpriced",
    valueSec,
    moneyPerSec: Math.max(0, input.produces[MONEY_CHANNEL] ?? 0),
    channels,
  };
}

/** How much of a BOUNDED bid's worth actually lands inside the planning horizon.
 *
 * `slotValue` above is a SUSTAINED-rate valuation: `worthSec` is what holding a
 * rate for the rest of the route is worth. Some claims are not sustained. A
 * program write occupies the slot for `occupiesSec` and delivers ONE file at the
 * end of it, so only the `horizonSec - occupiesSec` tail of the route is left to
 * benefit — and a write that outruns the horizon lands after the node is expected
 * to end and delivers nothing at all.
 *
 *     deliveryFraction = 1 - min(1, occupiesSec / horizonSec)
 *
 * This is a DERIVATION from what `worthSec` means, not a policy: nothing here
 * knows which program, which node, or which channel. `horizonSec` is the measured
 * node forecast, so a long node keeps a long write worth doing and a nearly
 * finished one does not.
 *
 * WHY THIS IS NOT APPLIED TO THE RATE. The obvious version — scale `perSec` and
 * let `slotValue` do the rest — is a no-op, and silently so. `raiseBest` lifts the
 * alternatives table to our OWN announced rate, and a program is the only producer
 * of its `file:<name>` channel, so `rateFraction(k·x, k·x) = 1` for every `k`: the
 * multiplier divides straight back out. Occupancy is orthogonal to rate share and
 * has to be applied to the resulting `SlotValue`, where `raiseBest` never sees it.
 *
 * The rejected alternative was to announce a fictitious reference rate for the
 * channel so the fraction stops self-normalising. Any reference is `1/R` seconds
 * for some `R`, giving `min(1, R/T)` — the same discount with the wrong shape,
 * since `rateFraction` clamps at 1 and every write shorter than `R` would score
 * identically. It also puts a producer that does not exist into the table every
 * consumer of `bestByChannel` reads. */
export function deliveryFraction(occupiesSec: number, horizonSec: number): number {
  if (!(horizonSec > 0)) return 0;
  if (!(occupiesSec > 0)) return 1;
  return 1 - Math.min(1, occupiesSec / horizonSec);
}

/** Discount a priced claim by the fraction of its worth that actually lands.
 *
 * A scale can only ever DISCOUNT — it is clamped to `[0, 1]` — so no caller can
 * inflate a bid past what its channels are worth, which is the invariant the
 * whole table depends on.
 *
 * Scaling to zero returns `unpriced`, not a priced zero. That is load-bearing:
 * `compareSlotValues` puts every priced claim ahead of every unpriced one, so a
 * write that delivers nothing inside the horizon would otherwise still outrank
 * every crime on a board where only its own need carries a worth, and would hold
 * the slot forever producing nothing. It matches what `slotValue` already does
 * with a claim whose produced rates are all zero.
 *
 * `worthSec`, `ourRate` and `bestRate` are left alone: the channel really is worth
 * that much and we really do produce at that rate, and the UI shows both beside the
 * discounted contribution. `moneyPerSec` is left alone because it is the bootstrap
 * ordering key, in dollars, and a dollar earned during the write is still earned. */
export function scaleSlotValue(value: SlotValue, fraction: number): SlotValue {
  const scale = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  if (scale === 1) return value;
  return {
    state: scale > 0 ? value.state : "unpriced",
    valueSec: value.valueSec * scale,
    moneyPerSec: value.moneyPerSec,
    channels: value.channels.map((channel) => ({ ...channel, valueSec: channel.valueSec * scale })),
  };
}

/** Raise the best-known rate per channel by what these producers offer.
 *
 * The alternatives table starts from the announcements — the producers that
 * never compete for the slot, like the farm — and has to include the BIDDERS
 * too, or the comparison is degenerate: the best karma crime and one at half
 * its speed would both be "the only karma producer" and score identically.
 * Used once across features (the arbiter, over every time claim) and once
 * within career (over its own menu), which are the same question one level
 * apart. */
export function raiseBest(
  best: ReadonlyMap<RateChannel, MeasuredMarginal>,
  produced: Iterable<Readonly<Record<RateChannel, number>>>,
): Map<RateChannel, MeasuredMarginal> {
  const out = new Map(best);
  for (const produces of produced) {
    for (const [channel, rate] of Object.entries(produces)) {
      if (!(rate > 0)) continue;
      const current = out.get(channel);
      if (current?.state === "measured" && current.value >= rate) continue;
      out.set(channel, { state: "measured", value: rate });
    }
  }
  return out;
}

/** Order two valued claims, best first.
 *
 * BOOTSTRAP: before progression publishes a forecast nothing has a worth and
 * every claim comes back `unpriced`. Ranking those by raw money per second is
 * the deliberate fallback — it is the one rate every early claimant can state,
 * and it is what actually matters before a route exists. Dollars and BN-seconds
 * are never mixed: a priced claim always sorts ahead of an unpriced one, so the
 * two units are only ever compared within their own kind. */
export function compareSlotValues(a: SlotValue, b: SlotValue): number {
  if (a.state !== b.state) return a.state === "priced" ? -1 : 1;
  if (a.state === "priced") return b.valueSec - a.valueSec;
  return b.moneyPerSec - a.moneyPerSec;
}

/** Needs whose outcome IS one of the three priced currencies.
 *
 * Their worth comes from the measured route marginal, never from the posted
 * weight — posting both would count the same progress twice, and only one of
 * the two was measured. Not academic: progression posts the Daedalus
 * `money >= $1e11` gate at weight 5, urgency blocking, while its own money
 * marginal reports that a relative income increase saves ZERO seconds, because
 * the farm clears that gate long before anything else on the route binds. */
export function currencyForNeed(need: Pick<Need, "kind" | "subject">): MarginalResource | undefined {
  if (need.kind === "money") return MONEY_CHANNEL;
  if (need.kind === "factionRep") return REPUTATION_CHANNEL;
  if (need.kind === "bladeburnerRank") return BLADEBURNER_RANK_CHANNEL;
  if (need.kind === "augCount") return AUGMENTATIONS_CHANNEL;
  // `combatSkills` is the ALL-FOUR gate, which is what the route's combat rate
  // estimates (`lowestCombatSkill`). A single-stat `skill:strength` requirement
  // is a different outcome and keeps its own channel: folding it in here would
  // SUM the four stats into one rate, and a crime training one stat to the
  // exclusion of the others would then outscore a balanced one on the very
  // need that is met by the weakest of them.
  if (need.kind === "combatSkills") return COMBAT_CHANNEL;
  if (need.kind === "skill" && need.subject === "hacking") return HACKING_CHANNEL;
  // Charisma is a single stat, so the dedicated `charisma` kind and a
  // `skill:charisma` requirement are the same outcome — unlike the four-stat
  // combat gate, folding them cannot mis-credit an unbalanced trainer.
  if (need.kind === "charisma") return CHARISMA_CHANNEL;
  if (need.kind === "skill" && need.subject === "charisma") return CHARISMA_CHANNEL;
  return undefined;
}

/** The channel an outcome is priced in: its currency if it is one, otherwise
 * its own board key. Producers and the worth table must agree on this or a rate
 * is announced into a channel nobody priced, which is silently free. */
export function channelForNeed(need: Pick<Need, "kind" | "subject">): RateChannel {
  return currencyForNeed(need) ?? needKey(need);
}

/** BN-seconds a 100% relative increase in each channel is worth.
 *
 * Currencies come from progression's measured route marginals; an `unknown`
 * marginal leaves the channel absent, which puts its claims on the bootstrap
 * money rule. Everything else comes from the board: a need states what
 * satisfying it is worth (`valueSec`, or the nominal fallback in
 * `rankingValueSec`), and same-key needs ADD exactly as their weights do.
 *
 * ONE implementation, called by both the feature that prices career's own
 * ranking and the controller that hands the table to the arbiter. Two would
 * drift, and a rate announced into a channel nobody priced is silently free. */
export function currencyWorth(marginals?: Partial<ProgressionMarginals>): Map<RateChannel, number> {
  const worth = new Map<RateChannel, number>();
  for (const resource of MARGINAL_RESOURCES) {
    const marginal = marginals?.[resource];
    // `estimated` is an answer, INCLUDING an estimated zero. `unknown` is not.
    if (marginal?.state === "estimated") worth.set(resource, Math.max(0, marginal.secondsPerRelativeRate));
  }
  return worth;
}

export function channelWorth(board: NeedBoard, marginals?: Partial<ProgressionMarginals>): ChannelWorth {
  const worth = currencyWorth(marginals);
  // Snapshot BEFORE the board contributes: the override test is "did a marginal
  // price this currency", not "has anything written to this key yet". Testing
  // the live map instead made the FIRST posted money need silence every later
  // one, so two features blocked on the same currency counted once — while
  // non-currency keys added up as documented.
  const measured = new Set(worth.keys());
  for (const need of board.open) {
    const currency = currencyForNeed(need);
    // A measured marginal OVERRIDES the posted weight for the same outcome:
    // both would be counting the same progress, and only one of them was
    // measured. With no marginal the poster's estimate is still better than
    // silence — a blocking hacking gate must not go unpriced just because no
    // forecast exists yet.
    if (currency !== undefined && measured.has(currency)) continue;
    const key = currency ?? needKey(need);
    worth.set(key, (worth.get(key) ?? 0) + rankingValueSec(need));
  }
  return worth;
}

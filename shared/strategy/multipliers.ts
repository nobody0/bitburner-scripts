import type { MarginalResource } from "./progression/marginal.ts";

/** The one table describing what each game multiplier field actually
 * accelerates, shared by every consumer that has to price one.
 *
 * It lived inside the augmentation scorer until the Go opponent selector needed
 * the same answers: an IPvGO reward IS a multiplier field (Netburners lifts
 * `hacknet_node_money`, Illuminati `hacking_speed`), so both features are asking
 * "what does raising this field buy, and how much of the run does it touch?".
 * Two copies would drift, and the copy Go had was a bespoke resource-to-opponent
 * map that mispriced hacknet by 32x. */

/** Channels the route model prices, plus the one outcome it does not.
 *
 * `crime` is deliberately NOT a `MarginalResource`: progression measures no
 * crime rate marginal, but karma and kills are real bottlenecks posted on the
 * needs board, and `crime_success` is the only field that moves them. Keeping
 * it here rather than widening `MarginalResource` means nothing in the forecast
 * perturbation has to pretend it can measure a channel it cannot. */
export type ValuedResource = MarginalResource | "crime";

/** Which priced channel each multiplier field accelerates, and by how much of
 * a relative rate increase one relative multiplier buys.
 *
 * MECHANICS, not policy: `hacking_speed` halves batch time, so it lifts both
 * money and experience one-for-one; `hacking_grow` only shortens one leg of the
 * batch. What each channel is WORTH is measured elsewhere and multiplied in.
 * A field absent here but named in `INCOME_SOURCE_FIELDS` lifts that source's
 * dollars and nothing else; a field in NEITHER accelerates nothing the route
 * model prices and contributes zero rather than a guess. */
const FIELD_SENSITIVITY: Readonly<Record<string, Readonly<Partial<Record<ValuedResource, number>>>>> = {
  hacking: { hacking: 1 },
  hacking_exp: { hacking: 1 },
  // Charisma is priced by the labyrinth ladder (every walk move gates on it,
  // and every reward install resets it); elsewhere its marginal measures zero
  // and these contribute nothing, exactly like a combat field off-route.
  charisma: { charisma: 1 },
  charisma_exp: { charisma: 1 },
  hacking_speed: { money: 1, hacking: 1 },
  hacking_money: { money: 1 },
  hacking_chance: { money: 1 },
  hacking_grow: { money: 0.5 },
  faction_rep: { reputation: 1 },
  company_rep: { reputation: 1 },
  strength: { combat: 1 },
  defense: { combat: 1 },
  dexterity: { combat: 1 },
  agility: { combat: 1 },
  strength_exp: { combat: 1 },
  defense_exp: { combat: 1 },
  dexterity_exp: { combat: 1 },
  agility_exp: { combat: 1 },
  bladeburner_success_chance: { bladeburnerRank: 1 },
  bladeburner_analysis: { bladeburnerRank: 0.5 },
  bladeburner_max_stamina: { bladeburnerRank: 0.5 },
  bladeburner_stamina_gain: { bladeburnerRank: 0.5 },
  // A better crime success rate is more money per attempt AND more karma and
  // kills per attempt, which is the only reason the early run commits to crime
  // at all. Pricing it on money alone made the karma path invisible.
  crime_success: { money: 1, crime: 1 },
};

/** Income multipliers that lift ONE source rather than the whole money rate.
 * Doubling crime money is worth double crime's share of what we earn, which on
 * a live farm is a rounding error — the same comparison the work slot makes.
 *
 * The three `hacking_*` entries are not decoration: without them those fields
 * carry `{money: 1}` at share ONE, i.e. priced as if they lifted every dollar
 * the run earns rather than the hacking farm's dollars. */
const INCOME_SOURCE_FIELDS: Readonly<Record<string, string>> = {
  hacking_money: "hacking",
  hacking_speed: "hacking",
  hacking_chance: "hacking",
  hacking_grow: "hacking",
  hacknet_node_money: "hacknet",
  work_money: "career",
  crime_money: "career",
  crime_success: "career",
  dnet_money: "dnet",
};

/** One field's response, with its income attribution already applied.
 *
 * A field named in `INCOME_SOURCE_FIELDS` earns only its source's DOLLARS, so
 * the share scales the `money` channel and nothing else: `hacking_speed` earns
 * only the farm's dollars but shortens every hacking-experience second
 * regardless of who pays the bills, and `crime_success` lifts karma at full
 * strength on a run whose income is entirely a salary. A field named ONLY
 * there lifts dollars and nothing else, so it responds on `money` alone.
 *
 * An unmeasured source contributes no money channel at all — absent is
 * "cannot be priced", never "measured zero". */
export function fieldChannelResponse(
  field: string,
  incomeShares?: Readonly<Record<string, number>>,
): Partial<Record<ValuedResource, number>> {
  const source = INCOME_SOURCE_FIELDS[field];
  const channels = FIELD_SENSITIVITY[field] ?? (source !== undefined ? { money: 1 } : {});
  const share = source === undefined ? 1 : Math.max(0, Math.min(1, incomeShares?.[source] ?? 0));
  const out: Partial<Record<ValuedResource, number>> = {};
  for (const [channel, sensitivity] of Object.entries(channels) as [ValuedResource, number][]) {
    const scaled = channel === "money" ? sensitivity * share : sensitivity;
    if (scaled > 0) out[channel] = scaled;
  }
  return out;
}

/** Every field either table names, so a consumer can enumerate the whole
 * multiplier surface without knowing which half a field lives in. */
export const VALUED_FIELDS: readonly string[] = [
  ...new Set([...Object.keys(FIELD_SENSITIVITY), ...Object.keys(INCOME_SOURCE_FIELDS)]),
];

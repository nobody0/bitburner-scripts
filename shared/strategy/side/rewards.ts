/** What one non-empty `ns.codingcontract.attempt()` return says a contract paid.
 *
 * The reward string is the ONLY channel. `attempt` returns display text and
 * nothing else (`types/NetscriptDefinitions.d.ts`: "a reward string on success
 * or empty string on failure"), and no getter reports the reward type, the
 * money gained, or the `rewardScaling` factor the payout is derived from — so a
 * gain cannot be computed, only read back out of a sentence meant for a human.
 *
 * Upstream produces exactly six shapes, and only the money one goes through a
 * locale- and settings-sensitive formatter. Reputation is interpolated as a
 * raw `${number}` and is therefore EXACT; money is formatted to about four
 * significant digits and is therefore a MAGNITUDE. Every name here keeps that
 * distinction visible.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObjectGeneralMethods.ts#L501-L568
 *
 * A parsed currency says WHAT WAS PAID, not what the contract was worth:
 * upstream falls back between currencies, so a faction-reputation reward with
 * no hacking faction joined pays money instead, and a company-reputation reward
 * with no job pays reputation. The split is an income attribution, never
 * reward-type generation statistics.
 *
 * TOTAL by contract: this never throws, for any input. The caller runs inside
 * the driver's post-attempt block, where a throw is swallowed by the
 * controller and would leave the pipeline resume vars set — re-attempting
 * contracts that were already submitted and burning a try on a one-try
 * contract. `solve()` in ./contracts.ts is total for the same class of reason. */

/** Suffixes `formatNumber` appends, in ascending powers of 1000. Case matters:
 * `q`/`Q` and `s`/`S` are different magnitudes.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/ui/formatNumber.ts#L5 */
const MONEY_SUFFIXES = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n"] as const;

/** The money shape, and the reason it can be this strict.
 *
 * A canonical `formatNumber` output CANNOT contain a thousands separator.
 * Below the suffix threshold the value is under 1000; at or above it the
 * mantissa is `n / 1000^floor(log10|n|/3)`, always within [1, 1000), and the
 * rounding-bump branch sets it to exactly 1. Grouping therefore never fires,
 * and the only punctuation a legitimate string carries is one `.` decimal
 * point. So a separator is proof the player's locale is not the one this
 * parser reads, and the match failing is the correct outcome — an
 * `Intl`-formatted `"$1,235m"` means 1.235e6 in de-DE and 1235e6 read
 * naively, and a silent 1000x error is far worse than a reported gap.
 *
 * `\D*` on both ends absorbs `Settings.CurrencySymbol` at either end, which
 * covers `Settings.CurrencySymbolAfterValue`. The exponent alternative covers
 * the branch upstream takes when `Settings.disableSuffixes` is set or the value
 * reaches 1e33.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/ui/formatNumber.ts#L122-L157 */
const MONEY_SHAPE = /^(\D*?)(\d+(?:\.\d+)?(?:e[+-]?\d+)?)([kmbtqQsSon])?(\D*)$/u;

/** JS `\d` is ASCII-only, so `\D` above would happily swallow a non-ASCII digit
 * into a currency-symbol slot and read the number short. */
const ANY_DIGIT = /\p{Nd}/u;

const GAINED = "Gained ";
const NO_REWARD = "No reward for this contract";

export type ContractReward =
  /** The contract was consumed and paid nothing: its `reward` was null. */
  | { kind: "none" }
  /** APPROXIMATE — read off display text carrying ~4 significant digits, so a
   *  magnitude and never a ledger. A zero here is REAL and expected: BN8 sets
   *  `CodingContractMoney` to 0, so every money reward there is literally
   *  `"Gained $0"`. That is exactly why `unparsed` is a separate variant. */
  | { kind: "money"; money: number }
  /** EXACT. `to` names every credited faction. For the "each of the following
   *  factions" form `repEach` is the floored per-faction figure upstream pays
   *  and `rep` is the true total (`repEach * to.length`); for the single form
   *  `rep` is the whole award and `repEach` is absent. */
  | { kind: "factionRep"; rep: number; to: string[]; repEach?: number }
  /** EXACT. */
  | { kind: "companyRep"; rep: number; to: string[] }
  /** Could NOT be read — deliberately distinct from "read as zero", which is
   *  the whole point of the variant. `why` names which half failed so a moved
   *  number format is diagnosable straight off the wire. */
  | { kind: "unparsed"; why: "money-format" | "rep-number" | "no-pattern" };

function repAmount(text: string): number | undefined {
  // `Number`, not `parseFloat`: parseFloat("12abc") is 12, which would invent a
  // reputation gain out of a string this build does not actually understand.
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function parseMoney(text: string): ContractReward {
  const match = MONEY_SHAPE.exec(text);
  if (!match) return { kind: "unparsed", why: "money-format" };
  const [, pre = "", digits = "", suffix, post = ""] = match;
  if (ANY_DIGIT.test(pre) || ANY_DIGIT.test(post)) return { kind: "unparsed", why: "money-format" };
  const mantissa = Number(digits);
  const money = mantissa * 1000 ** MONEY_SUFFIXES.indexOf((suffix ?? "") as typeof MONEY_SUFFIXES[number]);
  if (!Number.isFinite(money)) return { kind: "unparsed", why: "money-format" };
  return { kind: "money", money };
}

/** Read one reward string. Order is load-bearing — see the comments. */
export function parseContractReward(reward: string): ContractReward {
  // The driver never calls this for `""` (that is a rejected answer, handled as
  // a quarantine), so reaching here with one is a misuse and must be loud.
  if (reward === "") return { kind: "unparsed", why: "no-pattern" };
  if (reward === NO_REWARD) return { kind: "none" };
  if (!reward.startsWith(GAINED)) return { kind: "unparsed", why: "no-pattern" };
  const body = reward.slice(GAINED.length);

  // The multi-faction form BEFORE the single one: it also contains the
  // substring "reputation for", so a looser single-faction pattern would match
  // it and take "each of the following factions: ..." as a faction NAME. The
  // single form additionally spells "faction reputation" where this one says
  // only "reputation", which is a second independent guard.
  const each = /^(\S+) reputation for each of the following factions: (.+)$/u.exec(body);
  if (each) {
    const repEach = repAmount(each[1]!);
    if (repEach === undefined) return { kind: "unparsed", why: "rep-number" };
    const to = each[2]!.split(", ").map((name) => name.trim()).filter((name) => name.length > 0);
    return { kind: "factionRep", rep: repEach * to.length, to, repEach };
  }

  const faction = /^(\S+) faction reputation for (.+)$/u.exec(body);
  if (faction) {
    const rep = repAmount(faction[1]!);
    if (rep === undefined) return { kind: "unparsed", why: "rep-number" };
    // NOT split: a single faction name is the whole remainder, commas and all.
    return { kind: "factionRep", rep, to: [faction[2]!] };
  }

  const company = /^(\S+) company reputation for (.+)$/u.exec(body);
  if (company) {
    const rep = repAmount(company[1]!);
    if (rep === undefined) return { kind: "unparsed", why: "rep-number" };
    return { kind: "companyRep", rep, to: [company[2]!] };
  }

  // Money is the FALLBACK, because `Gained ${formatMoney(n)}` carries no
  // keyword to anchor on. That is precisely why the three patterns above are
  // strictly anchored: a reputation string that fails its own number check must
  // land in `unparsed`, never slide down here and be read as money.
  return parseMoney(body);
}

import type { FeatureId } from "../features/ids.ts";

/** The arbiter: allocation of the three genuinely contended resources.
 *
 * Distinct from the needs board (./needs.ts), which broadcasts desired
 * OUTCOMES. This one answers "there is one of it and two features want it".
 * There are exactly three such resources, and they contend for different
 * reasons:
 *
 *  - **money** — fungible, divisible, and every feature spends it. A hacknet
 *    upgrade must not be able to outbid a faction augmentation fund simply by
 *    asking first.
 *  - **time** — `Player.currentWork` is a single slot. Faction work, company
 *    work, crime, a class and grafting are mutually exclusive, and the loser
 *    is not delayed, it is CANCELLED (ns.singularity.workForFaction silently
 *    stops whatever was running). That makes pre-emption a correctness
 *    concern, not a fairness one.
 *  - **ram** — the dodge budget. Two features wanting an expensive probe step
 *    in the same pass cannot both have it.
 *
 * Pure and deterministic: no Math.random, no clock read (the caller passes
 * `now`), and every ordering is fully specified down to a tie-break on claim
 * identity, so ordering never depends on the order features were collected in.
 * `resolveClaims` is therefore directly unit-testable. It is intentionally
 * stateless: persistence belongs to the controller, which re-supplies cached
 * time and reserve claims on passes where their feature is not due. Omitting
 * an incumbent time claim is still the explicit release protocol. */

export type ResourceId = "money" | "time" | "ram";

export interface Claim {
  by: FeatureId;
  /** Stable across ticks. Re-issuing the SAME id means "same claim, still
   *  running" — that is how a time-slot incumbent holds its slot, and how a
   *  money reservation persists rather than being re-won every pass. */
  id: string;
  resource: ResourceId;
  amount: number;
  priority: number;
  /** `spend` consumes the resource now; `reserve` holds it for a future spend.
   *  Both consume the pool identically — that IS the reservation — and the
   *  reserver may spend what it reserved. The distinction is reported, so the
   *  UI can show money that is spoken for but not yet gone. */
  mode: "spend" | "reserve";
  /** Tie-break, in the claimant's own units. Only compared between claims of
   *  equal priority, where "own units" is close enough to fair. */
  ratePerSec?: number;
  /** Comparable economic return: marginal dollars/sec divided by cost. */
  returnPerDollarSec?: number;
  /** Time claims: refuse pre-emption until this timestamp. Work that has
   *  already sunk cost into a partial reputation tick should not be thrown
   *  away by a marginally higher bidder. */
  holdUntil?: number;
  /** Divisible claims accept a partial grant (buy fewer hacknet levels).
   *  Indivisible ones are all-or-nothing: half an augmentation is nothing. */
  divisible?: boolean;
  why: string;
}

export interface Grant {
  claimId: string;
  by: FeatureId;
  resource: ResourceId;
  /** What was actually granted — may be less than `amount` for a divisible
   *  claim. Never more. */
  amount: number;
  mode: "spend" | "reserve";
  /** True when a divisible claim got less than it asked for. */
  partial: boolean;
}

export type DenyReason = "outbid" | "partial" | "slot-held" | "empty";

export interface Denial {
  claimId: string;
  by: FeatureId;
  resource: ResourceId;
  wanted: number;
  available: number;
  reason: DenyReason;
  why: string;
}

/** Who holds the single player-time slot. Carried across ticks by the caller. */
export interface SlotState {
  claimId: string;
  by: FeatureId;
  priority: number;
  /** When this holder took the slot. `now - since` is how long it has held. */
  since: number;
}

export interface ArbiterInput {
  now: number;
  pools: { money: number; ram: number };
  claims: readonly Claim[];
  /** The slot holder as of the previous resolve. Omit on the first tick. */
  slot?: SlotState;
}

export interface ArbiterResult {
  grants: Grant[];
  /** Grants in `reserve` mode, repeated here so a consumer can show
   *  "committed but unspent" without filtering. */
  reserved: Grant[];
  denied: Denial[];
  /** The slot holder AFTER this resolve. Feed straight back in next tick. */
  slot?: SlotState;
  /** Set when this resolve took the slot away from a live incumbent. */
  preempted?: { claimId: string; by: FeatureId; heldMs: number };
  /** Pool left over, for reporting. */
  remaining: { money: number; ram: number };
}

/** A challenger must beat the incumbent by this much to take the work slot.
 *
 * Non-zero on purpose: switching player work throws away the current activity
 * outright, and a slot that changes hands on a 1-point difference would
 * oscillate between two near-equal bidders and complete neither. */
export const PREEMPT_MARGIN = 10;

/** Named priorities, so two features' claims are comparable by construction
 * rather than by whatever number each happened to pick. Higher wins.
 *
 * The ordering rationale: things that are irreversible or that gate everything
 * else outrank things that merely earn. An augmentation fund outranks a
 * hacknet upgrade because the fund converts into permanent multipliers, while
 * the upgrade competes with it for the same dollars every tick and would
 * otherwise always win by being cheaper and always ready. */
export const PRIORITY = {
  /** Freeze every remaining dollar after the final augmentation sweep. */
  "progression:install-freeze": 110,
  /** The reset is FORECAST minutes away: ordinary reset-lifetime investments
   *  at band 25 stop being funded, while prerequisites needed to clear the
   *  forecast (65) and endgame conversion (donate 70, aug-fund 90, blocking
   *  needs 95) still outbid this. */
  "progression:imminent-install": 50,
  /** Money set aside to buy a planned augmentation set. */
  "factions:aug-fund": 90,
  /** Donating for reputation, once favor allows it. */
  "factions:donate": 70,
  /** The player-time slot, working for a faction.
   *
   *  DERIVED, not chosen: `factions` posts `slotPriority({ repFraction: 1 })`, which
   *  is `REP_SPAN` — it is the only source of faction reputation, so whenever it wants
   *  the slot it is the best reputation option available. The constant is kept for the
   *  graft claim, which occupies the same slot to install an augmentation rather than
   *  to earn a rate, and as the named point the ordering tests compare against. */
  "factions:work": 60,
  /** Career satisfying a BLOCKING need from the board (karma, stats).
   *
   *  Deliberately more than PREEMPT_MARGIN above BOTH rates the slot can be scored
   *  on, and the test suite pins that. Anything less and the number would be
   *  decorative: a blocking need arising WHILE the slot is already busy could never
   *  interrupt it, so the feature that posted the need would wait for the incumbent
   *  to give up on its own.
   *
   *  It has to clear `MONEY_SPAN`, not just reputation. A blocking need is usually
   *  the gate on something far more valuable than either rate — the karma, stats or
   *  backdoor that UNLOCKS a faction, without which no amount of reputation or
   *  income moves the run forward. At 75 it sat below a best-in-game earner's 80, so
   *  crime could outrank the very unlock it was funding. */
  "career:blocking-need": 95,
  /** Career's request queue. Blocking work may interrupt ordinary faction
   * reputation; wanted/nice work may not. The gaps exceed PREEMPT_MARGIN so a
   * priority change has the same result regardless of which side is incumbent. */
  "career:wanted-request": 45,
  "career:nice-request": 35,
  /** Atomic Hacknet purchases that directly clear another feature's posted
   * milestone. They outrank ordinary income only while that need is open. */
  "hacknet:blocking-need": 75,
  "hacknet:wanted-need": 45,
  "hacknet:nice-need": 35,
  /** Temporary ownership while a completable task has unbanked progress. This
   * is a lock, not an assertion that its objective is more valuable.
   *
   * Above the combined spans (`REP_SPAN + MONEY_SPAN` = 140) minus the pre-emption
   * margin, so an ordinary claim cannot cancel a crime at 99% and throw the unit
   * away. It is deliberately NOT out of reach: a claim that scores past 130 is
   * simultaneously the best reputation AND very nearly the best money option
   * available, and cancelling the partial task for that genuinely is the right
   * trade. As more currencies get scored, the ceiling rises toward this and the lock
   * becomes breakable on merit rather than by exception. */
  "career:progress-lock": 120,
  /** Career earning money with no need outstanding.
   *
   *  RETAINED AS A REFERENCE POINT, not as the live value: `career` now scores this
   *  band from its earning rate against the best rate anyone announced (see
   *  `shared/strategy/income.ts`), because a constant says the same thing whether
   *  crime out-earns the farm tenfold or is a rounding error beside it. Kept so the
   *  ordering tests have a named number to compare against. */
  "career:income": 30,
  /** Corp seed money — huge, rare, and gates the whole feature. */
  "corp:seed": 85,
  "corp:expand": 40,
  "gang:equipment": 35,
  /** Economically interchangeable income investments compare by ROI. This is
   *  THE shared band: hacking infrastructure, hacknet upgrades and stock
   *  unlocks all post here so returnPerDollarSec decides between them. */
  "income:investment": 25,
  /** Alias of income:investment kept for the table's readability — hacknet's
   *  ordinary upgrades post at income:investment; only milestone-clearing
   *  ones escalate to the hacknet:*-need bands. */
  "hacknet:upgrade": 25,
  "stock:position": 20,
  /** A position in a node where hacked money arrives at ZERO value — BN8's
   *  `ScriptHackMoneyGain: 0`. There the market is not one income source among
   *  several, it is the only one, so a hacknet upgrade or a home-RAM investment
   *  must not outbid it. Still below `factions:aug-fund`: even in BN8 the money
   *  exists to become permanent multipliers. */
  "stock:sole-income": 55,
  /** Port openers and TOR that unblock requested rooting/backdoors. They must
   *  remain fundable through the imminent-install reserve: until the backdoor
   *  clears, the faction sweep that forecast is waiting on cannot finish.
   *  Home/cloud RAM posts at income:investment so ROI decides. */
  "hacking:blocking-prerequisite": 65,
  /** Probe RAM. Acquisition outranks spending, because a decision made on
   *  stale state is worse than a decision deferred. */
  "probe:core": 75,
  "probe:detail": 50,
} as const;

export type PriorityKey = keyof typeof PRIORITY;

export function priorityOf(key: PriorityKey): number {
  return PRIORITY[key];
}

/** Total ordering over claims. Fully specified — no reliance on sort stability
 * or on collection order, so the same claim set always resolves the same way. */
/** Two returns within this relative band count as "the same growth rate" and
 * fall through to absolute rate. Without it the ratePerSec tiebreak was
 * unreachable — exact float equality on returnPerDollarSec never happens — so
 * "similar payback speed, prefer the bigger earner" never fired. Outside the
 * band the faster payback still wins outright: getting the money back sooner
 * means reinvesting it sooner, which is worth more than a slightly larger
 * but slower stream (a 5-minute payback at $5/s beats an hour at $6/s). */
export const RETURN_TOLERANCE = 0.15;

function normalizedReturn(claim: Claim): number {
  const value = claim.returnPerDollarSec ?? 0;
  return value > 0 ? value : 0;
}

/** Assign deterministic return tiers before sorting. Pairwise similarity is
 * not transitive, so it cannot be evaluated inside a comparator. Each tier is
 * anchored to its highest return; every member is within the tolerance of that
 * one leader, and all comparisons then use the same integer key. */
function returnTiers(claims: readonly Claim[]): ReadonlyMap<Claim, number> {
  const tiers = new Map<Claim, number>();
  const byPriority = new Map<number, Claim[]>();
  for (const claim of claims) {
    const group = byPriority.get(claim.priority) ?? [];
    group.push(claim);
    byPriority.set(claim.priority, group);
  }

  for (const group of byPriority.values()) {
    const positive = group
      .filter((claim) => normalizedReturn(claim) > 0)
      .sort((a, b) =>
        normalizedReturn(b) - normalizedReturn(a)
        || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let tier = -1;
    let leader = Infinity;
    for (const claim of positive) {
      const value = normalizedReturn(claim);
      if (
        tier < 0
        || (leader === Infinity ? value !== Infinity : value < leader * (1 - RETURN_TOLERANCE))
      ) {
        tier += 1;
        leader = value;
      }
      tiers.set(claim, tier);
    }
    const noReturnTier = tier + 1;
    for (const claim of group) {
      if (normalizedReturn(claim) === 0) tiers.set(claim, noReturnTier);
    }
  }
  return tiers;
}

function compareClaims(a: Claim, b: Claim, tiers: ReadonlyMap<Claim, number>): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const aTier = tiers.get(a) ?? 0;
  const bTier = tiers.get(b) ?? 0;
  if (aTier !== bTier) return aTier - bTier;
  const aRate = a.ratePerSec ?? 0;
  const bRate = b.ratePerSec ?? 0;
  if (bRate !== aRate) return bRate - aRate;
  const aReturn = normalizedReturn(a);
  const bReturn = normalizedReturn(b);
  if (bReturn !== aReturn) return bReturn - aReturn;
  if (a.by !== b.by) return a.by < b.by ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function resolveClaims(input: ArbiterInput): ArbiterResult {
  const grants: Grant[] = [];
  const denied: Denial[] = [];

  const pools = { money: Math.max(0, input.pools.money), ram: Math.max(0, input.pools.ram) };
  for (const resource of ["money", "ram"] as const) {
    const claims = input.claims.filter((claim) => claim.resource === resource);
    const tiers = returnTiers(claims);
    claims.sort((a, b) => compareClaims(a, b, tiers));
    for (const claim of claims) {
      const available = pools[resource];
      const wanted = Math.max(0, claim.amount);
      if (wanted === 0) {
        denied.push(denial(claim, available, "empty"));
        continue;
      }
      if (available <= 0) {
        denied.push(denial(claim, available, "outbid"));
        continue;
      }
      if (available >= wanted) {
        pools[resource] = available - wanted;
        grants.push({ claimId: claim.id, by: claim.by, resource, amount: wanted, mode: claim.mode, partial: false });
        continue;
      }
      // Short. A divisible claim takes what is there; an indivisible one takes
      // nothing, and — critically — does NOT consume the pool, so a cheaper
      // lower-priority claim behind it can still be funded.
      if (claim.divisible) {
        pools[resource] = 0;
        grants.push({ claimId: claim.id, by: claim.by, resource, amount: available, mode: claim.mode, partial: true });
      } else {
        denied.push(denial(claim, available, "partial"));
      }
    }
  }

  const slotOutcome = resolveSlot(input);
  grants.push(...slotOutcome.grants);
  denied.push(...slotOutcome.denied);

  return {
    grants,
    reserved: grants.filter((grant) => grant.mode === "reserve"),
    denied,
    ...(slotOutcome.slot ? { slot: slotOutcome.slot } : {}),
    ...(slotOutcome.preempted ? { preempted: slotOutcome.preempted } : {}),
    remaining: pools,
  };
}

function denial(claim: Claim, available: number, reason: DenyReason): Denial {
  return {
    claimId: claim.id,
    by: claim.by,
    resource: claim.resource,
    wanted: claim.amount,
    available,
    reason,
    why: claim.why,
  };
}

/** The single player-time slot.
 *
 * Three rules, and the third is the one that is easy to miss:
 *  1. A challenger takes the slot only if it beats the incumbent by more than
 *     PREEMPT_MARGIN.
 *  2. ...and only once the incumbent's `holdUntil` has passed.
 *  3. An incumbent that stops RE-ISSUING its claim has released the slot. That
 *     is how a feature ends its own work without a separate "release" message:
 *     it simply stops asking, and the next tick hands the slot on. */
function resolveSlot(input: ArbiterInput): {
  grants: Grant[];
  denied: Denial[];
  slot?: SlotState;
  preempted?: { claimId: string; by: FeatureId; heldMs: number };
} {
  const claims = input.claims.filter((claim) => claim.resource === "time");
  const tiers = returnTiers(claims);
  claims.sort((a, b) => compareClaims(a, b, tiers));
  if (claims.length === 0) return { grants: [], denied: [] };

  const previous = input.slot;
  const incumbent = previous
    ? claims.find((claim) => claim.id === previous.claimId && claim.by === previous.by)
    : undefined;

  let winner = claims[0]!;
  let preempted: { claimId: string; by: FeatureId; heldMs: number } | undefined;

  if (incumbent) {
    const challenger = claims.find((claim) => claim !== incumbent);
    const held = input.now >= (incumbent.holdUntil ?? 0);
    const outclassed = challenger !== undefined && challenger.priority > incumbent.priority + PREEMPT_MARGIN;
    if (held && outclassed) {
      winner = challenger!;
      preempted = { claimId: incumbent.id, by: incumbent.by, heldMs: input.now - previous!.since };
    } else {
      winner = incumbent;
    }
  }

  const keepsSince = incumbent && winner === incumbent ? previous!.since : input.now;
  const grants: Grant[] = [
    { claimId: winner.id, by: winner.by, resource: "time", amount: 1, mode: winner.mode, partial: false },
  ];
  const denied: Denial[] = claims
    .filter((claim) => claim !== winner)
    .map((claim) => denial(claim, 0, "slot-held"));

  return {
    grants,
    denied,
    slot: { claimId: winner.id, by: winner.by, priority: winner.priority, since: keepsSince },
    ...(preempted ? { preempted } : {}),
  };
}

/** Did this feature get what it asked for? The driver-side read. */
export function grantFor(result: ArbiterResult, by: FeatureId, claimId: string): Grant | undefined {
  return result.grants.find((grant) => grant.by === by && grant.claimId === claimId);
}

/** Total granted to one feature on one resource — what a driver may actually
 * spend this tick. */
export function grantedAmount(result: ArbiterResult, by: FeatureId, resource: ResourceId): number {
  let total = 0;
  for (const grant of result.grants) {
    if (grant.by === by && grant.resource === resource) total += grant.amount;
  }
  return total;
}

/** Does this feature hold the player-time slot right now? */
export function holdsSlot(result: ArbiterResult, by: FeatureId): boolean {
  return result.slot?.by === by;
}

export function emptyArbitration(): ArbiterResult {
  return { grants: [], reserved: [], denied: [], remaining: { money: 0, ram: 0 } };
}

import type { FeatureId } from "../features/ids.ts";
import { incomePresentValue } from "./economics.ts";
import {
  compareSlotValues,
  raiseBest,
  scaleSlotValue,
  slotValue,
  type ChannelWorth,
  type RateChannel,
  type SlotValue,
} from "./income.ts";
import type { MeasuredMarginal } from "./progression/marginal.ts";

/** The arbiter: allocation of the two genuinely contended resources.
 *
 * Distinct from the needs board (./needs.ts), which broadcasts desired
 * OUTCOMES. This one answers "there is one of it and two features want it".
 * There are exactly two such resources, and they contend for different
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
 *
 * Dodge RAM is not a fungible pool: placement is contiguous, host-local and
 * changes as workers land. It is admitted continuously by shared/ram/broker.ts
 * and deliberately is not represented by this arbiter.
 *
 * Pure and deterministic: no Math.random, no clock read (the caller passes
 * `now`), and every ordering is fully specified down to a tie-break on claim
 * identity, so ordering never depends on the order features were collected in.
 * `resolveClaims` is therefore directly unit-testable. It is intentionally
 * stateless: persistence belongs to the controller, which re-supplies cached
 * time and reserve claims on passes where their feature is not due. Omitting
 * an incumbent time claim is still the explicit release protocol. */

export type ResourceId = "money" | "time";

/** A concave claim's local value in BN-seconds saved per additional resource
 * unit. At least one direction is required. `demandAt` is preferred when the
 * curve has a closed-form inverse; the solver derives the missing direction
 * with a fixed number of bisection samples. */
export type ClaimValueCurve =
  | {
      marginalValueAt(granted: number): number;
      demandAt?: (lambda: number) => number;
    }
  | {
      marginalValueAt?: (granted: number) => number;
      demandAt(lambda: number): number;
    };

interface ClaimBase {
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
  /** TIME CLAIMS: the rates holding the slot would produce, by channel. This is
   *  what a claim is scored on — see `./income.ts`. ABSENT makes the claim
   *  `hard`, ordered by `priority` alone, which is correct for the things that
   *  are not a rate at all: an in-flight crime's progress lock, a mandatory
   *  route install, a terminal action. Present-but-zero is a different
   *  statement — "I want the slot and cannot say what it is worth" — and loses
   *  to every bid that can put a number on it. */
  produces?: Readonly<Record<RateChannel, number>>;
  /** TIME CLAIMS: the fraction of this bid's worth that lands inside the
   *  planning horizon, for a claimant that must OCCUPY the slot before it
   *  delivers anything — a program write, not a wage. Absent means 1, which is
   *  every claim that produces for as long as it holds the slot.
   *
   *  It belongs on the claim, not just inside the owning feature's own ranking:
   *  a feature ranks its options against each other and then bids the winner
   *  here, so a discount applied only internally would be re-inflated the moment
   *  the bid met another feature's. See `deliveryFraction` in `./income.ts`. */
  deliveryFraction?: number;
}

/** A resource request has exactly one allocation shape. Continuous claims are
 * divisible and resolve by one water-fill. Step claims are one exact,
 * indivisible rung; an unknown value is explicit and retains hard-band greedy
 * semantics instead of being fabricated as zero. */
export type Claim =
  | (ClaimBase & {
      shape: "continuous";
      /** Fresh per-pass economics supplied by the owning FeatureModule. */
      valueCurve?: ClaimValueCurve;
    })
  | (ClaimBase & {
      shape: "step";
      /** Hard steps obey the priority lattice; economic steps are priced against lambda. */
      pricing: "hard" | "economic";
      value: MeasuredMarginal;
      valueCurve?: never;
    });

export type StepClaim = Extract<Claim, { shape: "step" }>;

export interface Grant {
  claimId: string;
  by: FeatureId;
  resource: ResourceId;
  /** What was actually granted — may be less than `amount` for a continuous
   *  claim or an unaffordable step reservation. Never more. */
  amount: number;
  mode: "spend" | "reserve";
  /** True when the grant is less than the claim's exact requested amount. */
  partial: boolean;
  /** BN-seconds saved by the next unit at this allocation. */
  marginalValue?: number;
}

export type DenyReason = "outbid" | "partial" | "slot-held" | "empty";

export interface Denial {
  claimId: string;
  by: FeatureId;
  resource: ResourceId;
  wanted: number;
  available: number;
  reason: DenyReason;
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
  pools: { money: number };
  claims: readonly Claim[];
  /** Best currently announced cash production. Unknown is deliberately not
   * zero: without a rate the wait to an unaffordable rung cannot be priced. */
  expectedIncomePerSec?: MeasuredMarginal;
  /** Best marginal productive return from the previous arbitration digest. */
  reinvestmentReturnPerDollarSec?: number;
  /** THE ALTERNATIVES TABLE for the player-time slot: the best rate anyone
   * announced per channel, and what a relative increase in that channel is
   * worth in BN-seconds. Absent leaves every time claim unpriced, which falls
   * back to raw money per second — see `compareSlotValues`. */
  rates?: {
    best: ReadonlyMap<RateChannel, MeasuredMarginal>;
    worth: ChannelWorth;
  };
  /** Pure feature callback for the rung exposed after an exact step grant. */
  nextStep?: (granted: StepClaim, remainingPool: number) => StepClaim | undefined;
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
  /** EVERY time claim considered and what it was worth, best first — the
   * alternatives, kept rather than discarded. The UI renders it to answer "why
   * is the player doing this", and `hacking` prices a program write against the
   * best thing the slot would otherwise be doing. */
  slotValues: {
    claimId: string;
    by: FeatureId;
    /** Hard claims are ordered by the lattice and carry no rate valuation. */
    pricing: "hard" | "economic";
    priority: number;
    value?: SlotValue;
  }[];
  /** One marginal-value threshold for every priority band that was
   * water-filled. Several can exist because hard bands never compete. */
  waterlines: {
    resource: "money";
    priority: number;
    lambda: number;
    /** All continuous claims in the band, including hard unpriced reserves. */
    claimCount: number;
    /** Claims contributing an explicit BN-seconds value curve to lambda. */
    pricedClaimCount: number;
  }[];
  /** Bounded step-loop diagnostics. A warning makes cap truncation visible. */
  stepLoop: { iterations: number; cap: number; capHit: boolean };
  warnings: string[];
  /** Pool left over, for reporting. */
  remaining: { money: number };
}

export const STEP_LOOP_CAP = 16;

export interface WaterFillClaim {
  id: string;
  amount: number;
  curve: ClaimValueCurve;
}

export interface WaterFillResult {
  lambda: number;
  grants: { id: string; amount: number; marginalValue: number }[];
  remaining: number;
}

/** Closed-form inverse for a constant-marginal (linear-value) claim. */
export function linearValueCurve(marginalValue: number, amount: number): ClaimValueCurve {
  const value = Math.max(0, marginalValue);
  const limit = Math.max(0, amount);
  return { demandAt: (lambda) => Math.max(0, lambda) <= value ? limit : 0 };
}

/** A challenger must beat a HARD incumbent by this much to take the work slot.
 *
 * Non-zero on purpose: switching player work throws away the current activity
 * outright, and a slot that changes hands on a 1-point difference would
 * oscillate between two near-equal bidders and complete neither. */
export const PREEMPT_MARGIN = 10;

/** The same anti-oscillation rule for PRICED claims, where an absolute margin
 * is meaningless: BN-seconds have no fixed scale, so the incumbent keeps the
 * slot unless a challenger is worth this much MORE, relatively.
 *
 * Hysteresis, NOT policy. The real cost of switching — the partial crime or
 * grafting unit that is destroyed by starting something else — is modelled
 * exactly, by `holdUntil` (see `career/schedule.ts#progressLockUntil`), and
 * that is absolute while it lasts. This only stops two claims whose estimates
 * cross back and forth from trading the slot every pass and finishing neither. */
export const SLOT_HYSTERESIS = 0.05;

/** Named priorities, so two features' claims are comparable by construction
 * rather than by whatever number each happened to pick. Higher wins.
 *
 * The ordering rationale: things that are irreversible or that gate everything
 * else outrank things that merely earn. An augmentation fund outranks a
 * hacknet upgrade because the fund converts into permanent multipliers, while
 * the upgrade competes with it for the same dollars every tick and would
 * otherwise always win by being cheaper and always ready. */
export const PRIORITY = {
  /** Irreversible terminal actions must be able to reclaim one in-flight farm
   * worker after the install transaction has been armed. */
  "progression:terminal-action": 121,
  /** Freeze every remaining dollar after the final augmentation sweep. */
  "progression:install-freeze": 110,
  /** The reset is forecast minutes away: ordinary reset-lifetime investments
   * stop being funded, while reset prerequisites still outbid this. */
  "progression:imminent-install": 50,
  /** Money set aside to buy a planned augmentation set. */
  "factions:aug-fund": 90,
  /** Donating for reputation, once favor allows it. */
  "factions:donate": 70,
  /** The player-time slot held to GRAFT — an augmentation being installed
   *  rather than a rate being earned, so it is priced by the lattice like any
   *  other non-rate claim. Ordinary faction reputation work is no longer a
   *  band at all: it announces `produces: { reputation }` and is scored on
   *  what that rate is worth (see `./income.ts`). */
  "factions:work": 60,
  /** RAM for reputation work on the selected faction-acquisition route.
   * Player time and the dodge that STARTS that work are one atomic action, so
   * the RAM half is banded to match the policy weight of the time half. The
   * time half itself is priced, not banded. */
  "factions:route-work": 91,
  /** Route mechanics require the current install and the route-weighted
   * augmentation package is the remaining pre-reset work. This is deliberately
   * NOT used for an ordinary economic install recommendation: doing so forced
   * tiny two-augmentation resets. The mandatory band clears both blocking
   * career and its pre-emption margin; ordinary route work competes with skill
   * training through the measured marginal-XP model. */
  "factions:install-work": 121,
  /** Career's MONEY claims (tuition, travel fare) while it is serving a
   *  BLOCKING need from the board.
   *
   *  NO LONGER A TIME BAND. It was, and that is precisely what stalled a live
   *  BN12 run for six hours: `priorityFor` bands a career option by the urgency
   *  of any need it TOUCHES, with no magnitude test, so a crime paying $1.8e4/s
   *  against progression's $1e11 route need — a contribution scored at 1e-6,
   *  toward a resource the same route priced at zero BN-seconds — outranked the
   *  reputation work that was the only thing the slot could actually advance.
   *  Career's time claim now announces the rates it produces and is scored
   *  against the field like every other claimant.
   *
   *  Strictly BELOW `progression:install-freeze`. An exact tie there would not be
   *  a tie in practice: `compareClaims` falls through to the feature id, so
   *  "career" would sort ahead of "progression" on every pass and its training
   *  and travel funds would be allocated out of the very bankroll the post-sweep
   *  freeze exists to protect. */
  "career:blocking-need": 109,
  /** The same, for career money claims backing a wanted/nice request. */
  "career:wanted-request": 45,
  "career:nice-request": 35,
  /** Atomic Hacknet purchases that directly clear another feature's posted
   * milestone. They outrank ordinary income only while that need is open. */
  "hacknet:blocking-need": 75,
  "hacknet:wanted-need": 45,
  "hacknet:nice-need": 35,
  /** Temporary ownership while a completable task has unbanked progress. This
   * is a lock, not an assertion that its objective is more valuable — and it is
   * a HARD claim, because the thing it protects is not a rate. Cancelling a
   * ten-minute Heist at 99% destroys the whole unit, so no priced bid may take
   * the slot before `holdUntil`.
   *
   * The lock is bounded by the moment that progress BANKS (see
   * `career/schedule.ts#progressLockUntil`). At the boundary career drops back
   * to a priced claim and the slot is re-decided on merit — which is the half
   * that was broken: the lock was correct, the automatic renewal at an unearned
   * band was not.
   *
   * Above every other hard time band except the mandatory route/terminal ones,
   * which must be able to interrupt even unbanked work. */
  "career:progress-lock": 120,
  /** Career MONEY claims with no need outstanding. Career's time claim carries
   *  no band at all — it is priced from the rates it produces. */
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
  /** A blocking server-access dodge (backdoor install) whose measured
   *  BN-seconds-per-second value beats the farm income of the RAM it needs.
   *  At or above `FARM_PREEMPTION_PRIORITY` (= progression:install-freeze,
   *  110) the RAM broker may reclaim one in-flight farm worker for it — which
   *  is the point: on a saturated fleet a backdoor stub priced at probe:detail
   *  waited on arena growth forever while the faction it gated idled. Strictly
   *  below career:progress-lock (120): evicting a worker desyncs one batch,
   *  cancelling near-complete player work throws whole units away. The
   *  escalation is CONDITIONAL — claims() only posts this band when the need
   *  is blocking AND the value comparison holds; everything else stays at
   *  probe:detail. */
  "hacking:critical-access": 111,
  /** Port openers and TOR that unblock requested rooting/backdoors. They must
   *  remain fundable through the imminent-install reserve: until the backdoor
   *  clears, the faction sweep that forecast is waiting on cannot finish.
   *  Home/cloud RAM posts at income:investment so ROI decides. */
  "hacking:blocking-prerequisite": 65,
  /** Probe RAM. Acquisition outranks spending, because a decision made on
   *  stale state is worse than a decision deferred. */
  "probe:gate": 100,
  "probe:core": 75,
  "probe:detail": 50,
  "probe:background": 40,
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

const CURVE_SEARCH_ITERATIONS = 48;
const LAMBDA_BRACKET_STEPS = 64;

function finiteNonnegative(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  return value === Infinity ? Number.MAX_VALUE : value;
}

/** Demand from a marginal curve. This is the bounded numerical fallback used
 * only when a feature cannot provide the analytic inverse. */
export function curveDemandAt(curve: ClaimValueCurve, amount: number, lambda: number): number {
  const limit = Math.max(0, amount);
  const threshold = finiteNonnegative(lambda);
  if (curve.demandAt) return Math.min(limit, finiteNonnegative(curve.demandAt(threshold)));
  const marginalValueAt = curve.marginalValueAt;
  if (!marginalValueAt) return 0;
  if (limit <= 0) return 0;
  if (finiteNonnegative(marginalValueAt(0)) < threshold) return 0;
  if (finiteNonnegative(marginalValueAt(limit)) >= threshold) return limit;
  let low = 0;
  let high = limit;
  for (let iteration = 0; iteration < CURVE_SEARCH_ITERATIONS; iteration++) {
    const mid = (low + high) / 2;
    if (finiteNonnegative(marginalValueAt(mid)) >= threshold) low = mid;
    else high = mid;
  }
  return low;
}

/** Marginal from an inverse-demand curve, again with a fixed sample bound.
 * This is used for telemetry and for resolving flat-value ties; allocation
 * itself still uses the claimant's exact closed-form demand. */
export function curveMarginalValueAt(curve: ClaimValueCurve, amount: number, granted: number): number {
  const allocation = Math.min(Math.max(0, granted), Math.max(0, amount));
  if (curve.marginalValueAt) return finiteNonnegative(curve.marginalValueAt(allocation));
  let low = 0;
  let high = 1;
  for (let step = 0; step < LAMBDA_BRACKET_STEPS; step++) {
    const demand = curveDemandAt(curve, amount, high);
    if (allocation > 0 ? demand < allocation : demand <= 0) break;
    high *= 2;
  }
  for (let iteration = 0; iteration < CURVE_SEARCH_ITERATIONS; iteration++) {
    const mid = (low + high) / 2;
    if (curveDemandAt(curve, amount, mid) >= allocation) low = mid;
    else high = mid;
  }
  return low;
}

/** Allocate one economically comparable hard-priority band in one bounded
 * pass. Concavity makes aggregate demand monotone in lambda. Flat linear
 * segments can jump across the pool; the residual is split across that tied
 * segment, where every split has the same objective value. */
export function waterFill(pool: number, claims: readonly WaterFillClaim[]): WaterFillResult {
  const available = Math.max(0, pool);
  const eligible = claims.filter((claim) => Math.max(0, claim.amount) > 0);
  // A claim asking for nothing is still an ANSWERED claim. Dropping it here
  // would leave the caller with neither a grant nor a denial for it, and the
  // "empty" denial is the only thing that tells a feature its own claim was
  // degenerate.
  const zeroGrants = claims
    .filter((claim) => !(Math.max(0, claim.amount) > 0))
    .map((claim) => ({ id: claim.id, amount: 0, marginalValue: 0 }));
  if (eligible.length === 0 || available <= 0) {
    return {
      lambda: 0,
      grants: [
        ...eligible.map((claim) => ({
          id: claim.id,
          amount: 0,
          marginalValue: curveMarginalValueAt(claim.curve, claim.amount, 0),
        })),
        ...zeroGrants,
      ],
      remaining: available,
    };
  }

  const totalDemand = (lambda: number): number => eligible.reduce(
    (sum, claim) => sum + curveDemandAt(claim.curve, claim.amount, lambda),
    0,
  );
  const fullDemand = totalDemand(0);
  if (fullDemand <= available) {
    const grants = eligible.map((claim) => {
      const amount = curveDemandAt(claim.curve, claim.amount, 0);
      return { id: claim.id, amount, marginalValue: curveMarginalValueAt(claim.curve, claim.amount, amount) };
    });
    return { lambda: 0, grants: [...grants, ...zeroGrants], remaining: available - fullDemand };
  }

  let low = 0;
  let high = 1;
  for (let step = 0; step < LAMBDA_BRACKET_STEPS && totalDemand(high) > available; step++) high *= 2;
  for (let iteration = 0; iteration < CURVE_SEARCH_ITERATIONS; iteration++) {
    const mid = (low + high) / 2;
    if (totalDemand(mid) > available) low = mid;
    else high = mid;
  }

  const lower = eligible.map((claim) => curveDemandAt(claim.curve, claim.amount, low));
  const upper = eligible.map((claim) => curveDemandAt(claim.curve, claim.amount, high));
  const upperTotal = upper.reduce((sum, amount) => sum + amount, 0);
  const residual = Math.max(0, available - upperTotal);
  const tiedHeadroom = lower.reduce((sum, amount, index) => sum + Math.max(0, amount - upper[index]!), 0);
  const amounts = upper.map((amount, index) => amount + (
    tiedHeadroom > 0 ? residual * Math.max(0, lower[index]! - amount) / tiedHeadroom : 0
  ));
  const grantedTotal = amounts.reduce((sum, amount) => sum + amount, 0);
  const grants = eligible.map((claim, index) => ({
    id: claim.id,
    amount: amounts[index]!,
    marginalValue: curveMarginalValueAt(claim.curve, claim.amount, amounts[index]!),
  }));
  return { lambda: high, grants: [...grants, ...zeroGrants], remaining: Math.max(0, available - grantedTotal) };
}

function resolveAtomicClaim(
  claim: StepClaim,
  resource: "money",
  pools: { money: number },
  grants: Grant[],
  denied: Denial[],
): void {
  const available = pools[resource];
  const wanted = Math.max(0, claim.amount);
  if (wanted === 0) {
    denied.push(denial(claim, available, "empty"));
  } else if (available <= 0) {
    denied.push(denial(claim, available, "outbid"));
  } else if (available >= wanted) {
    pools[resource] = available - wanted;
    grants.push({ claimId: claim.id, by: claim.by, resource, amount: wanted, mode: claim.mode, partial: false });
  } else {
    // A step without measured economics retains the established all-or-nothing
    // rule. In particular, a short atomic claim never consumes the pool.
    denied.push(denial(claim, available, "partial"));
  }
}

/** Exponential point-value discount derived from the shared discounted-flow
 * primitive. The ratio cancels the arbitrary one-second unit window:
 * PV([t,t+1]) / PV([0,1]) = exp(-r*t). */
export function stepWaitDiscount(waitSec: number, reinvestmentRate: number): number {
  const wait = Math.max(0, waitSec);
  const baseline = incomePresentValue(1, 0, 1, reinvestmentRate);
  if (!(baseline > 0)) return 1;
  return incomePresentValue(1, wait, wait + 1, reinvestmentRate) / baseline;
}

interface PricedStep {
  claim: StepClaim;
  waitSec: number;
  discount: number;
  valuePerResource: number;
}

/** True when the step model has no evidence to price this claim at all —
 * its value is unknown, or it needs saving up and no income rate has been
 * measured. Such a claim must keep its ORIGINAL greedy-by-priority treatment;
 * only claims the model can genuinely evaluate may be deferred on its say-so. */
function stepUnpriceable(claim: StepClaim, input: ArbiterInput, availableNow: number): boolean {
  if (claim.value.state !== "measured") return true;
  const cost = Math.max(0, claim.amount);
  if (!(cost > 0)) return false;
  // Income is only needed to cost the WAIT, so it is only missing evidence
  // when the claim actually has to save up. Mirror `priceStep` exactly or the
  // two disagree about which claims the model can speak to.
  if (cost <= Math.max(0, availableNow)) return false;
  const announced = input.expectedIncomePerSec;
  return !announced || announced.state !== "measured" || !(announced.value > 0);
}

function priceStep(
  claim: StepClaim,
  availableNow: number,
  lambda: number,
  input: ArbiterInput,
): PricedStep | undefined {
  if (claim.value.state !== "measured") return undefined;
  const cost = Math.max(0, claim.amount);
  const value = Math.max(0, claim.value.value);
  if (!(cost > 0) || !(value > 0)) return undefined;

  const shortfall = Math.max(0, cost - Math.max(0, availableNow));
  let waitSec = 0;
  if (shortfall > 0) {
    const announced = input.expectedIncomePerSec;
    // Unknown is not zero and is not infinity: it means this wait cannot be
    // priced, so the step cannot sequester money on invented evidence.
    if (!announced || announced.state !== "measured" || !(announced.value > 0)) return undefined;
    waitSec = shortfall / announced.value;
  }
  const discount = stepWaitDiscount(waitSec, input.reinvestmentReturnPerDollarSec ?? 0);
  const valuePerResource = discount * value / cost;
  return valuePerResource > lambda ? { claim, waitSec, discount, valuePerResource } : undefined;
}

function fallbackContinuousCurve(claim: Extract<Claim, { shape: "continuous" }>): ClaimValueCurve {
  // Unpriced continuous claims exist only for hard reservations. A zero flat
  // curve still participates in the one-pass solver and splits a tied band
  // without inventing positive BN-time value.
  return claim.valueCurve ?? linearValueCurve(0, claim.amount);
}

function waterFillBand(
  pool: number,
  claims: readonly Extract<Claim, { shape: "continuous" }>[],
): WaterFillResult {
  return waterFill(pool, claims.map((claim) => ({
    id: claim.by + "\0" + claim.id,
    amount: claim.amount,
    curve: fallbackContinuousCurve(claim),
  })));
}

function validNextStep(
  previous: StepClaim,
  next: StepClaim,
  warnings: string[],
): boolean {
  if (
    next.by === previous.by
    && next.resource === previous.resource
    && next.priority === previous.priority
  ) return true;
  warnings.push(
    "ignored invalid next step " + next.by + ":" + next.id
      + "; it must stay in " + previous.by + "'s " + previous.resource
      + " priority-" + previous.priority + " band",
  );
  return false;
}

export function resolveClaims(input: ArbiterInput): ArbiterResult {
  const grants: Grant[] = [];
  const denied: Denial[] = [];
  const waterlines: ArbiterResult["waterlines"] = [];
  const warnings: string[] = [];
  let stepIterations = 0;
  let capHit = false;

  const pools = { money: Math.max(0, input.pools.money) };
  for (const resource of ["money"] as const) {
    const claims = input.claims.filter((claim) => claim.resource === resource);
    const tiers = returnTiers(claims);
    claims.sort((a, b) => compareClaims(a, b, tiers));
    const priorities = [...new Set(claims.map((claim) => claim.priority))].sort((a, b) => b - a);
    for (const priority of priorities) {
      const band = claims.filter((claim) => claim.priority === priority);

      // Hard-policy steps retain deterministic exact all-or-nothing ordering.
      // Their objective value is intentionally outside economic comparison.
      for (const claim of band) {
        if (claim.shape === "step" && claim.pricing === "hard") {
          resolveAtomicClaim(claim, resource, pools, grants, denied);
        }
      }

      const continuous = band.filter(
        (claim): claim is Extract<Claim, { shape: "continuous" }> => claim.shape === "continuous",
      );
      // Economic steps are priced against the same provisional lambda as the
      // continuous curves. Count them as waterline participants even though a
      // winning rung is removed before the final continuous fill; otherwise
      // telemetry reports a one-claim shadow price for a real two-way auction.
      const economicSteps = band.filter(
        (claim): claim is StepClaim => claim.shape === "step" && claim.pricing === "economic",
      );
      // EVERY economic step enters the loop, including one whose value the
      // model cannot state. `priceStep` simply declines the unpriceable ones,
      // and they fall out of the loop into the greedy-by-priority fallback
      // below — the same treatment a measured-value step gets when its saving
      // wait cannot be costed. Filtering them out here instead denied them
      // outright, which is exactly the behaviour change the note at
      // `if (!winner) break` says must not happen: `stock:unlock` carries an
      // `unknown` value until progression publishes a money marginal AND a
      // positive income rate has been measured, so the WSE/TIX purchase could
      // never be funded on a cash-poor node (BN8) no matter the bankroll.
      const pending = [...economicSteps];
      const pricedEconomicStepCount = economicSteps.filter(
        (claim) => !stepUnpriceable(claim, input, pools[resource]),
      ).length;
      while (pending.length > 0 && pools[resource] > 0) {
        const provisional = waterFillBand(pools[resource], continuous);
        const lambda = continuous.length > 0 ? provisional.lambda : 0;
        const priced = pending
          .map((claim) => priceStep(claim, pools[resource], lambda, input))
          .filter((entry): entry is PricedStep => entry !== undefined)
          .sort((a, b) =>
            b.valuePerResource - a.valuePerResource
            || compareClaims(a.claim, b.claim, tiers));

        const winner = priced[0];
        // Nothing left that can be PRICED. That is not the same as nothing
        // left that should be BOUGHT: `priceStep` declines a step whose value
        // or whose income rate is `unknown`, because it must not sequester
        // cash on invented evidence. Dropping those outright changed
        // behaviour rather than encoding it — measured on bn1-speedrun seed 1,
        // infrastructure purchases were suppressed, peak fleet fell
        // 9,052 -> 8,540 GB and time-to-$1b regressed 2.321h -> 2.594h.
        //
        // So an unpriceable step falls back to the ORIGINAL greedy-by-priority
        // rule below instead of being denied. Encoding a decision we cannot
        // yet price must leave that decision exactly as it was.
        if (!winner) break;
        if (stepIterations >= STEP_LOOP_CAP) {
          capHit = true;
          warnings.push(
            "step loop hit cap " + STEP_LOOP_CAP + " in " + resource
              + " priority-" + priority + "; remaining rungs were re-priced but not granted",
          );
          break;
        }

        const index = pending.indexOf(winner.claim);
        pending.splice(index, 1);
        const cost = Math.max(0, winner.claim.amount);
        const available = pools[resource];
        stepIterations += 1;
        if (cost > available) {
          // This is a savings decision, not a partial purchase. It consumes
          // only the cash actually present and remains visible as a reserve.
          pools[resource] = 0;
          grants.push({
            claimId: winner.claim.id,
            by: winner.claim.by,
            resource,
            amount: available,
            mode: "reserve",
            partial: true,
            marginalValue: winner.valuePerResource,
          });
          break;
        }

        pools[resource] = available - cost;
        grants.push({
          claimId: winner.claim.id,
          by: winner.claim.by,
          resource,
          amount: cost,
          mode: winner.claim.mode,
          partial: false,
          marginalValue: winner.valuePerResource,
        });
        const next = input.nextStep?.(winner.claim, pools[resource]);
        if (next && validNextStep(winner.claim, next, warnings)) pending.push(next);
      }

      const filled = waterFillBand(pools[resource], continuous);
      if (continuous.length > 0) {
        waterlines.push({
          resource,
          priority,
          lambda: filled.lambda,
          claimCount: continuous.length + economicSteps.length,
          pricedClaimCount:
            continuous.filter((claim) => claim.valueCurve !== undefined).length + pricedEconomicStepCount,
        });
        pools[resource] = filled.remaining;
        const byKey = new Map(continuous.map((claim) => [claim.by + "\0" + claim.id, claim]));
        for (const allocation of filled.grants) {
          const claim = byKey.get(allocation.id)!;
          if (allocation.amount <= 0) {
            // A claim that asked for nothing is "empty", not "outbid" — the
            // same distinction the pre-water-fill arbiter drew.
            denied.push(denial(claim, pools[resource], Math.max(0, claim.amount) > 0 ? "outbid" : "empty"));
            continue;
          }
          grants.push({
            claimId: claim.id,
            by: claim.by,
            resource,
            amount: allocation.amount,
            mode: claim.mode,
            partial: allocation.amount < Math.max(0, claim.amount),
            marginalValue: allocation.marginalValue,
          });
        }
      }

      // Steps left unpriced (unknown value, or unknown income so the saving
      // wait cannot be costed) fall back to the ORIGINAL greedy-by-priority
      // rule rather than being denied. See the note at `if (!winner) break`:
      // denying them suppressed infrastructure purchases and cost 11.8% of
      // time-to-$1b on the primary benchmark. Priceable steps have already
      // been removed from `pending`, so this only ever sees the claims the
      // new model has nothing to say about.
      for (const claim of pending) {
        const available = pools[resource];
        const wanted = Math.max(0, claim.amount);
        if (wanted === 0) {
          denied.push(denial(claim, available, "empty"));
          continue;
        }
        // A step the model CAN price, left over because the loop hit its cap,
        // is deferred rather than granted: it will be re-priced next tick, and
        // granting it greedily here would simply undo the bound.
        if (!stepUnpriceable(claim, input, available)) {
          denied.push(denial(claim, available, "outbid"));
          continue;
        }
        if (available >= wanted) {
          pools[resource] = available - wanted;
          grants.push({
            claimId: claim.id,
            by: claim.by,
            resource,
            amount: wanted,
            mode: claim.mode,
            partial: false,
          });
          continue;
        }
        // Indivisible and short: does NOT consume the pool, so a cheaper
        // claim behind it can still be funded (pinned by tests/arbiter.test.ts).
        denied.push(denial(claim, available, available <= 0 ? "outbid" : "partial"));
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
    waterlines,
    stepLoop: { iterations: stepIterations, cap: STEP_LOOP_CAP, capHit },
    warnings,
    slotValues: slotOutcome.slotValues,
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
  };
}

/** A time claim, with what it is worth if it can be priced at all. */
interface SlotBid {
  claim: Claim;
  pricing: "hard" | "economic";
  value?: SlotValue;
}

/** A claim that names what it produces is PRICED; one that names nothing is a
 * lock, a mandatory action or an install — not a rate, and the lattice is still
 * the right tool for those.
 *
 * PRESENCE decides, not magnitude. A claimant that names its channels and
 * reports zero on all of them is saying "I want the slot but cannot price what
 * for": it must lose to anything that can, and must not be promoted to a lock
 * by the absence of a number. */
function slotBid(
  claim: Claim,
  best: ReadonlyMap<RateChannel, MeasuredMarginal>,
  worth: ChannelWorth,
): SlotBid {
  if (claim.produces === undefined) return { claim, pricing: "hard" };
  return {
    claim,
    pricing: "economic",
    value: scaleSlotValue(
      slotValue({ produces: claim.produces, best, worth }),
      claim.deliveryFraction ?? 1,
    ),
  };
}

/** Does the challenger take the slot from the incumbent?
 *
 * Hard outranks priced outright: a lock protecting unbanked work, or an
 * irreversible route action, is not something an earning rate may interrupt.
 * Between two hard claims the absolute lattice margin applies; between two
 * priced ones the relative hysteresis does. */
function outbidsIncumbent(challenger: SlotBid, incumbent: SlotBid): boolean {
  if (challenger.pricing !== incumbent.pricing) return challenger.pricing === "hard";
  if (challenger.pricing === "hard") return challenger.claim.priority > incumbent.claim.priority + PREEMPT_MARGIN;
  const ours = challenger.value!;
  const theirs = incumbent.value!;
  if (ours.state !== theirs.state) return ours.state === "priced";
  const margin = 1 + SLOT_HYSTERESIS;
  return ours.state === "priced"
    ? ours.valueSec > theirs.valueSec * margin
    : ours.moneyPerSec > theirs.moneyPerSec * margin;
}

/** The single player-time slot.
 *
 * Four rules, and the last is the one that is easy to miss:
 *  1. Hard claims — locks and mandatory actions — are ordered by the priority
 *     lattice, and always outrank priced ones.
 *  2. Priced claims are ordered by BN-seconds saved, which is `(our rate / the
 *     best announced rate) × what that rate is worth`, summed over everything
 *     the work produces. See `./income.ts`.
 *  3. A challenger takes the slot only by beating the incumbent (absolute
 *     margin between hard claims, relative hysteresis between priced ones) and
 *     only once the incumbent's `holdUntil` has passed.
 *  4. An incumbent that stops RE-ISSUING its claim has released the slot. That
 *     is how a feature ends its own work without a separate "release" message:
 *     it simply stops asking, and the next tick hands the slot on. */
function resolveSlot(input: ArbiterInput): {
  grants: Grant[];
  denied: Denial[];
  slot?: SlotState;
  preempted?: { claimId: string; by: FeatureId; heldMs: number };
  slotValues: ArbiterResult["slotValues"];
} {
  const claims = input.claims.filter((claim) => claim.resource === "time");
  if (claims.length === 0) return { grants: [], denied: [], slotValues: [] };

  const tiers = returnTiers(claims);
  const best = raiseBest(input.rates?.best ?? new Map(), claims.map((claim) => claim.produces ?? {}));
  const worth = input.rates?.worth ?? new Map();
  const bids = claims.map((claim) => slotBid(claim, best, worth));
  bids.sort((a, b) => {
    if (a.pricing !== b.pricing) return a.pricing === "hard" ? -1 : 1;
    if (a.pricing === "hard") return compareClaims(a.claim, b.claim, tiers);
    const value = compareSlotValues(a.value!, b.value!);
    if (value !== 0) return value;
    // Deterministic to the end: two equally valuable bids must not depend on
    // the order features were collected in.
    return a.claim.by !== b.claim.by
      ? (a.claim.by < b.claim.by ? -1 : 1)
      : a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0;
  });

  const previous = input.slot;
  const incumbent = previous
    ? bids.find((bid) => bid.claim.id === previous.claimId && bid.claim.by === previous.by)
    : undefined;

  let winner = bids[0]!;
  let preempted: { claimId: string; by: FeatureId; heldMs: number } | undefined;

  if (incumbent) {
    const challenger = bids.find((bid) => bid !== incumbent);
    const held = input.now >= (incumbent.claim.holdUntil ?? 0);
    if (held && challenger !== undefined && outbidsIncumbent(challenger, incumbent)) {
      winner = challenger;
      preempted = { claimId: incumbent.claim.id, by: incumbent.claim.by, heldMs: input.now - previous!.since };
    } else {
      winner = incumbent;
    }
  }

  const keepsSince = incumbent && winner === incumbent ? previous!.since : input.now;
  const grants: Grant[] = [
    {
      claimId: winner.claim.id,
      by: winner.claim.by,
      resource: "time",
      amount: 1,
      mode: winner.claim.mode,
      partial: false,
      ...(winner.value?.state === "priced" ? { marginalValue: winner.value.valueSec } : {}),
    },
  ];
  const denied: Denial[] = bids
    .filter((bid) => bid !== winner)
    .map((bid) => denial(bid.claim, 0, "slot-held"));

  return {
    grants,
    denied,
    slot: { claimId: winner.claim.id, by: winner.claim.by, priority: winner.claim.priority, since: keepsSince },
    ...(preempted ? { preempted } : {}),
    slotValues: bids.map((bid) => ({
      claimId: bid.claim.id,
      by: bid.claim.by,
      pricing: bid.pricing,
      priority: bid.claim.priority,
      ...(bid.value ? { value: bid.value } : {}),
    })),
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
  return {
    grants: [], reserved: [], denied: [], waterlines: [], slotValues: [],
    stepLoop: { iterations: 0, cap: STEP_LOOP_CAP, capHit: false }, warnings: [], remaining: { money: 0 },
  };
}

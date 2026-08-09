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
  /** Money set aside to buy a planned augmentation set. */
  "factions:aug-fund": 90,
  /** Donating for reputation, once favor allows it. */
  "factions:donate": 70,
  /** The player-time slot, working for a faction. */
  "factions:work": 60,
  /** Career satisfying a BLOCKING need from the board (karma, stats).
   *
   *  Deliberately more than PREEMPT_MARGIN above `factions:work`, and the test
   *  suite pins that. Anything less and the number would be decorative: a
   *  blocking need arising WHILE faction work is already running could never
   *  interrupt it, so the feature that posted the need would wait for the
   *  incumbent to give up on its own. Clearing something another feature is
   *  blocked on genuinely outranks ordinary reputation grinding. */
  "career:blocking-need": 75,
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
   * is a lock, not an assertion that its objective is more valuable. */
  "career:progress-lock": 100,
  /** Career earning money with no need outstanding. */
  "career:income": 30,
  /** Corp seed money — huge, rare, and gates the whole feature. */
  "corp:seed": 85,
  "corp:expand": 40,
  "gang:equipment": 35,
  /** Economically interchangeable income investments compare by ROI. */
  "income:investment": 25,
  "hacknet:upgrade": 25,
  "stock:position": 20,
  /** A position in a node where hacked money arrives at ZERO value — BN8's
   *  `ScriptHackMoneyGain: 0`. There the market is not one income source among
   *  several, it is the only one, so a hacknet upgrade or a home-RAM investment
   *  must not outbid it. Still below `factions:aug-fund`: even in BN8 the money
   *  exists to become permanent multipliers. */
  "stock:sole-income": 55,
  "hacking:infrastructure": 45,
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
function compareClaims(a: Claim, b: Claim): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const aReturn = a.returnPerDollarSec ?? 0;
  const bReturn = b.returnPerDollarSec ?? 0;
  if (bReturn !== aReturn) return bReturn - aReturn;
  const aRate = a.ratePerSec ?? 0;
  const bRate = b.ratePerSec ?? 0;
  if (bRate !== aRate) return bRate - aRate;
  if (a.by !== b.by) return a.by < b.by ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function resolveClaims(input: ArbiterInput): ArbiterResult {
  const grants: Grant[] = [];
  const denied: Denial[] = [];

  const pools = { money: Math.max(0, input.pools.money), ram: Math.max(0, input.pools.ram) };
  for (const resource of ["money", "ram"] as const) {
    const claims = input.claims.filter((claim) => claim.resource === resource).sort(compareClaims);
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
  const claims = input.claims.filter((claim) => claim.resource === "time").sort(compareClaims);
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

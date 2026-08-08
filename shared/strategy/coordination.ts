import type { ArbitrationDigest, NeedDigest } from "../telemetry/topics/progression.ts";
import { resolveClaims, type ArbiterResult, type Claim, type SlotState } from "./arbiter.ts";
import { needProgress, isSatisfied, postNeeds, type Need, type NeedBoard } from "./needs.ts";

/** The coordination pass: one pure function from "what every feature wants
 * and is bidding for" to "the board, the allocation, and what to report".
 *
 * It exists so the controller's feature pass has no logic of its own beyond
 * collecting and dispatching. The controller re-supplies standing time and
 * reserve claims between feature cadences; this function remains stateless.
 * That matters for two reasons: the whole
 * cross-feature mechanism becomes unit-testable without an ns mock, and the
 * simulator exercises the identical code path rather than an approximation.
 *
 * The ordering is load-bearing and is fixed here rather than at the call site:
 * needs are posted FIRST, so a feature can bid harder BECAUSE something else is
 * blocked on it. `career` outbidding `factions` for the work slot when a karma
 * need is blocking depends on the board already being complete when claims are
 * collected. */

export interface CoordinationInput {
  now: number;
  /** Pools to allocate: the player's spendable cash and the dodge budget. */
  money: number;
  ramGb: number;
  /** The board, already posted — the caller needs it before this call to build
   *  the claim context, and passing it in rather than re-deriving it here
   *  guarantees the drivers and the claim phase saw the SAME object. */
  board: NeedBoard;
  claims: readonly Claim[];
  /** Work-slot holder carried from the previous pass. */
  slot?: SlotState;
}

export interface Coordination {
  arbitration: ArbiterResult;
  /** Wire form — `undefined` when nothing was posted at all.
   *
   * Silence is the point: a hacking-only run posts no needs and no claims, and
   * must stay byte-identical to one without this machinery. Reporting an empty
   * board every 200 ms tick would be both noise and a behaviour change in the
   * telemetry stream that `--perf` parity is measured against. */
  digest?: { needs: NeedDigest[]; arbitration: ArbitrationDigest };
}

export function coordinate(input: CoordinationInput): Coordination {
  const arbitration = resolveClaims({
    now: input.now,
    pools: { money: input.money, ram: input.ramGb },
    claims: input.claims,
    ...(input.slot ? { slot: input.slot } : {}),
  });

  if (input.board.needs.length === 0 && input.claims.length === 0) return { arbitration };

  return {
    arbitration,
    digest: {
      needs: input.board.needs.map(needDigest),
      arbitration: arbitrationDigest(arbitration, input.now),
    },
  };
}

/** What to write when nothing is posted any more.
 *
 * Deliberately not `undefined`: the store merges patches and DROPS undefined
 * fields, so writing `arbitration: undefined` would leave the last
 * arbitration on screen forever. A stale board outliving the feature that
 * posted it reads as "still blocked" when the truth is "nobody asked". */
export function emptyDigest(): NonNullable<Coordination["digest"]> {
  return { needs: [], arbitration: { grants: [], denied: [], remaining: { money: 0, ram: 0 } } };
}

/** Re-exported so a caller has exactly one import for the whole pass. */
export { postNeeds };
export type { NeedBoard };

export function needDigest(need: Need): NeedDigest {
  return {
    by: need.by,
    kind: need.kind,
    ...(need.subject !== undefined ? { subject: need.subject } : {}),
    target: need.target,
    have: need.have,
    progress: needProgress(need),
    weight: need.weight,
    urgency: need.urgency,
    satisfied: isSatisfied(need),
    why: need.why,
  };
}

export function arbitrationDigest(result: ArbiterResult, now: number): ArbitrationDigest {
  return {
    grants: result.grants.map((grant) => ({
      by: grant.by,
      id: grant.claimId,
      resource: grant.resource,
      amount: grant.amount,
      mode: grant.mode,
      partial: grant.partial,
    })),
    denied: result.denied.map((denial) => ({
      by: denial.by,
      id: denial.claimId,
      resource: denial.resource,
      wanted: denial.wanted,
      available: denial.available,
      reason: denial.reason,
      why: denial.why,
    })),
    ...(result.slot
      ? { slot: { by: result.slot.by, id: result.slot.claimId, priority: result.slot.priority, heldMs: now - result.slot.since } }
      : {}),
    ...(result.preempted
      ? { preempted: { by: result.preempted.by, id: result.preempted.claimId, heldMs: result.preempted.heldMs } }
      : {}),
    remaining: result.remaining,
  };
}

import { compareDepthDesc, freeRam, fresh, type DarknetKnowledge, type ExpiryOpts } from "./knowledge.ts";

/** Where to put the next agent, and why not everywhere else.
 *
 * Spreading is the whole point of the feature — BN15's own text asks for scripts
 * that are "self-sufficient and durable, and spread themselves to stay alive" —
 * so the policy is: **every neighbour we can reach gets an agent, at any depth,
 * unconditionally.** Nothing here is a budget any more.
 *
 * It used to carry three: a hop budget, a per-source fan-out and a global agent
 * cap. All three were guesses, and each one produced a refusal that could fire
 * on a host there was nothing wrong with. They are gone, and their refusal names
 * are gone with them rather than left as dead strings — a name that can never
 * fire teaches the panel reader that a limit exists.
 *
 * What survives is six GROUNDED refusals, each naming something about the host
 * itself, and `not-enough-ram` now does the real work. A planner that silently
 * skipped a host would make all six invisible at once, so every rule here
 * produces a NAMED REFUSAL rather than a skip, and the refusals are what the
 * panel shows when the net stops growing.
 *
 * Depth is not a bound. It is the ORDERING KEY: see `planSpread`.
 *
 * The mechanical ladder a plant executes, all in ONE process:
 *
 *     probe()                           -> my neighbours
 *     authenticate(Y, password)         -> needs a direct connection; the
 *                                          session belongs to this PID alone
 *     scp([payloads], Y, X)             -> needs the session, no connection
 *     exec(payload, Y, ...)             -> needs the session AND the connection
 *
 * That is why a plant is planned per (from, to) pair rather than per target: the
 * vantage is part of the move. A credential we hold for a host we are not
 * standing next to buys `scp` and nothing else. */

export interface SpreadCandidate {
  host: string;
  /** Where a worker would have to be STANDING to do this. */
  from: string;
  depth?: number;
  freeRam?: number;
  hasCredential: boolean;
  /** A live agent is already here. */
  agentAlive: boolean;
  lastPlantAt?: number;
  goneAt?: number;
}

export interface SpreadLimits {
  /** RAM the payload needs. The surveyor is the small one; a breaker needs more,
   *  and the caller picks which it is asking about. */
  agentRamGb: number;
  /** How long after a plant a host is left alone. The one surviving limit that
   *  is not a fact about RAM, and it is not a budget either: a host that keeps
   *  coming back empty is RESTARTING, and re-planting it every derivation would
   *  spend the whole net's spare RAM on one flapping machine.
   *
   *  A minute is a little over ten mutation ticks at the default depth, so a
   *  host that survives one cooldown has survived long enough to be worth the
   *  2.6 GB. */
  plantCooldownMs: number;
}

export const DEFAULT_SPREAD_LIMITS: SpreadLimits = {
  agentRamGb: 2.6,
  plantCooldownMs: 60_000,
};

/** Six reasons, and every one of them is a fact about the host in front of us.
 *
 * `too-deep`, `fan-out` and `agent-cap` were deleted rather than retired: they
 * were the three invented budgets, and a refusal name that can never fire is a
 * worse lie than no name at all — it tells the panel reader a limit is in force
 * when the code has stopped enforcing one. */
export type RefusalReason =
  | "gone"
  | "agent-alive"
  | "no-credential"
  | "not-enough-ram"
  | "unknown-ram"
  | "cooldown";

export interface Refusal {
  host: string;
  why: RefusalReason;
  detail: string;
}

export interface SpreadPlan {
  plant: SpreadCandidate[];
  refused: Refusal[];
}

/** Decide where agents go next: everywhere we can, deepest first.
 *
 * Order matters twice over, and neither is arbitrary.
 *
 * **The refusal order.** The cheapest and most certain refusals come first, so a
 * host that is simply gone is never reported as "not enough RAM" — a refusal
 * that sends someone looking at the wrong problem is worse than no refusal at
 * all.
 *
 * **The candidate order: DEEPEST first.** This used to be shallow-first, argued
 * from "a shallow host is the cheapest place to stand while cracking the next
 * one". That argument only held while depth was also a BOUND, because then the
 * shallow hosts were the only ones we would ever take. With the hop budget gone
 * we take all of them, and the ordering answers a different question: which host
 * do we want first when RAM runs out or the net rearranges under us?
 *
 * The answer is the deep one. A deep host is the SCARCE vantage — it is the only
 * place a still-deeper host can be reached from, its adjacency expires faster
 * (`30_000/depth`), and it is the one most likely to be gone by the next
 * derivation. A shallow host is reachable again in a moment from anywhere.
 *
 * Ties go to the host with the most room — it will hold the heaviest job — then
 * by name, so the plan is deterministic. A host whose depth we cannot place
 * sorts LAST: it is a host we have not surveyed, and preferring it would spend
 * the scarce plant on the candidate we know least about. */
export function planSpread(
  candidates: readonly SpreadCandidate[],
  limits: SpreadLimits,
  now: number,
): SpreadPlan {
  const plant: SpreadCandidate[] = [];
  const refused: Refusal[] = [];

  const ordered = [...candidates].sort((a, b) => {
    const byDepth = compareDepthDesc(a.depth, b.depth);
    if (byDepth !== 0) return byDepth;
    const ra = a.freeRam ?? -1;
    const rb = b.freeRam ?? -1;
    if (ra !== rb) return rb - ra;
    return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
  });

  for (const candidate of ordered) {
    const refuse = (why: RefusalReason, detail: string): void => {
      refused.push({ host: candidate.host, why, detail });
    };

    if (candidate.goneAt !== undefined) {
      refuse("gone", "the host is offline; darknet hosts go permanently");
      continue;
    }
    if (candidate.agentAlive) {
      refuse("agent-alive", "an agent is already standing here");
      continue;
    }
    if (!candidate.hasCredential) {
      // Not a failure of spreading — a failure of cracking, and the two want
      // different fixes. Saying so is what routes attention correctly.
      refuse("no-credential", "no password known; this is an attempt, not a plant");
      continue;
    }
    if (candidate.freeRam === undefined) {
      // Unknown capacity must never read as "room for an agent": exec would
      // return a silent 0, indistinguishable from a host that is simply full.
      refuse("unknown-ram", "no believable RAM facts; survey it before planting");
      continue;
    }
    if (candidate.freeRam < limits.agentRamGb) {
      refuse(
        "not-enough-ram",
        `${candidate.freeRam.toFixed(2)}GB free, needs ${limits.agentRamGb.toFixed(2)}GB`
        + " — usually the owner's block, which memoryReallocation would have to grind down",
      );
      continue;
    }
    if (candidate.lastPlantAt !== undefined && now - candidate.lastPlantAt < limits.plantCooldownMs) {
      // A host that keeps restarting must not absorb every worker we have.
      refuse("cooldown", "planted recently; if it is empty again it is restarting");
      continue;
    }
    // No per-source cap and no global cap. The one real thing `fanOut`
    // prevented was filing more plants than a source host's queue can hold, and
    // that is a queue-depth fact rather than a spread policy: the overseer's
    // `MAX_QUEUED_PER_HOST` is where it belongs and where it is already
    // enforced.
    plant.push(candidate);
  }

  return { plant, refused };
}

/** Every host a plant could be aimed at, read out of the folded map.
 *
 * This was a closure in `game/dnet/overseer.ts`, which `AGENTS.md` forbids:
 * deciding what counts as a candidate is strategy, and a driver only moves data.
 * Lifting it also makes the one rule here testable — a candidate needs a
 * VANTAGE, meaning a host we are standing on whose adjacency we still believe
 * lists the target. A neighbour list we no longer believe is not a route.
 *
 * `agentAlive` is always false by construction, because a host we are standing
 * on is skipped outright. The field stays on `SpreadCandidate` because a caller
 * that builds candidates some other way still owes `planSpread` the answer, and
 * "an agent is already standing here" is a refusal worth naming. */
export function candidatesFrom(
  knowledge: DarknetKnowledge,
  at: number,
  opts: {
    /** Hosts we have a process on — the overseer's own, plus every resident. */
    standing: ReadonlySet<string>;
    /** Hosts we hold a credential for. */
    vault: ReadonlySet<string>;
    /** When each host was last planted, for the cooldown. */
    lastPlantAt?: ReadonlyMap<string, number>;
    expiry?: ExpiryOpts;
  },
): SpreadCandidate[] {
  const expiry = opts.expiry ?? {};
  const out: SpreadCandidate[] = [];
  for (const host of Object.values(knowledge.hosts)) {
    if (opts.standing.has(host.hostname)) continue;
    let from: string | undefined;
    for (const where of opts.standing) {
      const neighbours = fresh<string[]>(knowledge.hosts[where], "neighbours", at, expiry);
      if (neighbours?.includes(host.hostname)) {
        from = where;
        break;
      }
    }
    if (from === undefined) continue;
    const depth = fresh<number>(host, "depth", at, expiry);
    const plantedAt = opts.lastPlantAt?.get(host.hostname);
    out.push({
      host: host.hostname,
      from,
      ...(depth !== undefined ? { depth } : {}),
      freeRam: freeRam(host, at, expiry),
      hasCredential: opts.vault.has(host.hostname),
      agentAlive: false,
      ...(plantedAt !== undefined ? { lastPlantAt: plantedAt } : {}),
      ...(host.goneAt !== undefined ? { goneAt: host.goneAt } : {}),
    });
  }
  return out;
}

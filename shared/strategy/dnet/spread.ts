/** Where to put the next agent, and why not everywhere else.
 *
 * Spreading is the whole point of the feature — BN15's own text asks for scripts
 * that are "self-sufficient and durable, and spread themselves to stay alive" —
 * but it is bounded by four independent things, and a planner that silently
 * skipped a host would make all four invisible at once. So every rule here
 * produces a NAMED REFUSAL rather than a skip, and the refusals are what the
 * panel shows when the net stops growing.
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
  /** Deepest we are willing to go for now. Raised once agent mortality shows the
   *  current frontier is holding. */
  hopBudget: number;
  /** Plants per SOURCE host per derivation, so one lucky breaker cannot spend
   *  the whole agent budget on its own neighbourhood. */
  fanOut: number;
  /** Total live agents. Bounded so a lucky run does not blanket the net before
   *  we have watched how residents die out there: every agent is RAM held on a
   *  host the mutation clock can restart, and mortality is the number the cap
   *  should be raised against. */
  liveAgentCap: number;
  plantCooldownMs: number;
}

export const DEFAULT_SPREAD_LIMITS: SpreadLimits = {
  agentRamGb: 2.6,
  // Four is a starting position, not a discovery. Raise it once
  // `agents.lostSinceBoot` shows the frontier holding.
  hopBudget: 4,
  fanOut: 2,
  liveAgentCap: 12,
  plantCooldownMs: 60_000,
};

export type RefusalReason =
  | "gone"
  | "agent-alive"
  | "no-credential"
  | "not-enough-ram"
  | "unknown-ram"
  | "too-deep"
  | "cooldown"
  | "fan-out"
  | "agent-cap";

export interface Refusal {
  host: string;
  why: RefusalReason;
  detail: string;
}

export interface SpreadPlan {
  plant: SpreadCandidate[];
  refused: Refusal[];
}

/** Decide where agents go next.
 *
 * Order matters and is not arbitrary: the cheapest and most certain refusals come
 * first, so a host that is simply gone is never reported as "not enough RAM" —
 * a refusal that sends someone looking at the wrong problem is worse than no
 * refusal at all. */
export function planSpread(
  candidates: readonly SpreadCandidate[],
  limits: SpreadLimits,
  now: number,
  liveAgents = 0,
): SpreadPlan {
  const plant: SpreadCandidate[] = [];
  const refused: Refusal[] = [];
  const perSource = new Map<string, number>();
  let budget = Math.max(0, limits.liveAgentCap - liveAgents);

  // Shallow first: depth is what the whole exercise is for, and a shallow host
  // is also the cheapest place to stand while cracking the next one. Ties go to
  // the host with the most room, then by name so the plan is deterministic.
  const ordered = [...candidates].sort((a, b) => {
    const da = a.depth ?? Number.MAX_SAFE_INTEGER;
    const db = b.depth ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
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
    if ((candidate.depth ?? 0) > limits.hopBudget) {
      refuse("too-deep", `depth ${candidate.depth} is past the hop budget of ${limits.hopBudget}`);
      continue;
    }
    if (candidate.lastPlantAt !== undefined && now - candidate.lastPlantAt < limits.plantCooldownMs) {
      // A host that keeps restarting must not absorb every worker we have.
      refuse("cooldown", "planted recently; if it is empty again it is restarting");
      continue;
    }
    const used = perSource.get(candidate.from) ?? 0;
    if (used >= limits.fanOut) {
      refuse("fan-out", `${candidate.from} has already placed ${used} this pass`);
      continue;
    }
    if (budget <= 0) {
      refuse("agent-cap", `${limits.liveAgentCap} agents already live`);
      continue;
    }

    plant.push(candidate);
    perSource.set(candidate.from, used + 1);
    budget--;
  }

  return { plant, refused };
}

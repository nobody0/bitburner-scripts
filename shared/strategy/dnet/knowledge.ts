import { msPerHostEvent, msPerHostEventAny } from "./rates.ts";
import type { AttemptOutcome, ReportHost } from "./courier.ts";

/** What we know about the darknet, and when it stops being believable.
 *
 * The darknet is the only subject in this project that rearranges itself while
 * we look at it: a mutation tick lands every few seconds, moving servers,
 * severing every connection a host had, restarting it, or deleting it
 * permanently. So a bare value is not knowledge here — a value without a
 * timestamp is a claim about a world that may already be gone.
 * See spec/dnet.md. */

export interface HostFact<T> {
  value: T;
  /** When it was OBSERVED, not when it arrived. A drain hands over a batch of
   *  hosts at once and the residents that saw them ran at different times. */
  at: number;
}

/** Fact classes, grouped by what can invalidate them.
 *
 * This split is the whole point. A flat expiry would either distrust a host's
 * password format — which cannot change while the host lives — or trust its
 * neighbour list long after the net rewired it. */
export type FactClass = "identity" | "position" | "topology" | "resource";

export const FACT_CLASS: Readonly<Record<string, FactClass>> = {
  // Fixed for the lifetime of a host identity. A deleted host that later
  // reappears is a NEW host with a new password, so these are invalidated by
  // disappearance, never by age.
  modelId: "identity",
  passwordLength: "identity",
  passwordFormat: "identity",
  passwordHint: "identity",
  data: "identity",
  difficulty: "identity",
  isStationary: "identity",
  logTrafficInterval: "identity",
  requiredCharisma: "identity",
  // Changes when the host moves.
  depth: "position",
  // Churned by move, connect and disconnect alike — the most perishable thing
  // we hold, and the thing reachability depends on.
  neighbours: "topology",
  // Ours to change, and only changes when we or the owner act.
  blockedRam: "resource",
  maxRam: "resource",
  usedRam: "resource",
  // A session belongs to the PID that won it, so this is worthless the moment
  // its observer dies. Classing it `resource` gives it the shortest expiry we
  // have, which is the honest answer rather than a flattering one.
  hasSession: "resource",
  // Cache files change when WE open one, when a RAM block is cleared, when a
  // phish lands one — and they go with the host when it is deleted. `resource`
  // is the shortest expiry we have and therefore the honest one: acting on a
  // stale listing means calling `openCache` on a filename the host no longer
  // holds, and that call THROWS rather than refusing.
  caches: "resource",
};

/** How far the cracker got against one host identity.
 *
 * Not a fact, because it is about US rather than about the host, and it must not
 * expire on the mutation clock — a dictionary we have already walked stays
 * walked. It IS discarded when the host disappears, because a host that returns
 * is a new host with a new password (see the `goneAt` branch in the fold). */
export interface AttemptLedger {
  /** The model the ledger was built against. A different model id means the
   *  host was replaced and the count below means nothing. */
  modelId?: string;
  /** How many ordered candidates have been ruled out. */
  tried: number;
  /** Deliberate failures spent to make an unsolved model's oracle appear. */
  probes: number;
  lastAt?: number;
  lastCode?: number;
  solved?: boolean;
  /** A feedback solver's place in its conversation with this host.
   *
   * It lives here rather than in the job because a solve can outlast the
   * ADJACENCY it depends on: a vantage lasts about 108 s while the password
   * itself only changes when the host is deleted, roughly five times longer. So
   * an expensive solve has to be resumable from a different neighbour, and this
   * is what it resumes from.
   *
   * Typed loosely on purpose. `shared/strategy/dnet/solvers/` owns the shape and
   * validates it with its own fingerprint; the ledger only has to carry it. It
   * is redacted by `stripCredentials` — see `courier.ts` — because a partly
   * solved password is still a password. */
  solver?: Record<string, unknown>;
}

/** Fold attempt outcomes into a host's ledger.
 *
 * Shared between the controller — whose ledger drives `planAttempt` — and home,
 * whose copy survives the controller's death and feeds the panel. One function,
 * so the two can never count a candidate differently. Mutates in place, like the
 * ledger itself: attempts are about US, not the host, so they sit outside the
 * fold's newest-wins rule. */
export function foldAttempts(
  host: DarknetHostKnowledge | undefined,
  outcomes: readonly AttemptOutcome[],
): void {
  // A gone host's ledger stays dropped: the fold discards cracking progress on
  // disappearance because a returning host is a new host with a new password,
  // and an outcome that lands in the same drain as the gone report must not
  // resurrect counts that belong to the dead identity.
  if (!host || host.goneAt !== undefined) return;
  for (const attempt of outcomes) {
    const ledger = host.attempts ?? { tried: 0, probes: 0 };
    if (attempt.modelId !== undefined) ledger.modelId = attempt.modelId;
    // The solver's own place in the conversation. Carried verbatim: this module
    // does not interpret it, and `solvers/` refuses a state whose fingerprint no
    // longer matches the host.
    if (attempt.solver !== undefined) ledger.solver = attempt.solver;
    if (attempt.status === "implemented") ledger.tried = (attempt.candidateIndex ?? ledger.tried) + 1;
    else ledger.probes += 1;
    ledger.lastAt = attempt.at;
    ledger.lastCode = attempt.code;
    if (attempt.success) ledger.solved = true;
    host.attempts = ledger;
  }
}

export interface DarknetHostKnowledge {
  hostname: string;
  /** Newest observation of this host by anything, for any fact. */
  lastSeenAt: number;
  /** Set when an observation reported the host gone. Identity facts die here. */
  goneAt?: number;
  facts: Record<string, HostFact<unknown>>;
  attempts?: AttemptLedger;
  /** That we HOLD a credential, never the credential. This record is published
   *  to telemetry; the password lives only in the driver's vault. */
  credentialKnown?: boolean;
}

export interface DarknetKnowledge {
  hosts: Record<string, DarknetHostKnowledge>;
  /** Generation of the run that produced this. Agents outlive controllers, so a
   * mismatch means the whole rendezvous belongs to a world this run no longer
   * shares; it is refused there, by `overseerIsLive`, rather than per fact. */
  generation: string;
  /** Mutation ticks observed, which is the clock staleness is really measured
   * against. */
  mutationsSeen: number;
}

export function emptyKnowledge(generation: string): DarknetKnowledge {
  return { hosts: {}, generation, mutationsSeen: 0 };
}

export interface ExpiryOpts {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  /** Hosts we hold a stasis link on.
   *
   *  Taken from the controller rather than from the observed `stasisLinked`
   *  fact, because we are the only thing that sets or releases a link: the
   *  controller knows the set exactly, while an observed copy is a worse source
   *  that can itself go stale. */
  stasisLinked?: ReadonlySet<string>;
  /** Set by a caller that has already resolved it for this host — see
   *  `isImmune`. Left out, it is worked out per host from the two fields above. */
  immune?: boolean;
}

/** Whether the mutation clock can touch this host at all.
 *
 * Every branch of `mutateDarknet` picks its victim from
 * `getAllMovableDarknetServers` (`DarkNet/utils/darknetNetworkUtils.ts:69-78`),
 * which skips any server that `isStationary` or `hasStasisLink` — so move,
 * delete, disconnect and restart all miss it alike. (`isImmutable` in
 * `NetworkMovement.ts:227` is a second, narrower guard covering stasis links but
 * NOT `isStationary`; the pool exclusion is what does the work for both.)
 *
 * So immunity is a property of the HOST, not of a fact class: ageing anything
 * about such a server would invent churn the engine cannot produce. Upstream
 * marks `darkweb` and the labyrinth stationary, and raises rather than move
 * `darkweb` at all. */
export function isImmune(
  host: Pick<DarknetHostKnowledge, "hostname" | "facts"> | undefined,
  opts: ExpiryOpts = {},
): boolean {
  if (!host) return false;
  if (opts.stasisLinked?.has(host.hostname) === true) return true;
  return host.facts["isStationary"]?.value === true;
}

/** `opts` narrowed to one host, computed once so the per-fact calls below do
 * not each redo it. */
function hostExpiry(
  host: Pick<DarknetHostKnowledge, "hostname" | "facts"> | undefined,
  opts: ExpiryOpts,
): ExpiryOpts {
  if (opts.immune !== undefined) return opts;
  return { ...opts, immune: isImmune(host, opts) };
}

/** How long a fact of this class stays believable.
 *
 * Derived, not chosen: `msPerHostEvent` gives the expected time before a
 * mutation touches one named host in the relevant way, and we distrust a fact
 * at a fraction of that. `identity` never expires with age — only with the
 * host's disappearance — and on an immune host nothing does. */
export function expiryMs(factClass: FactClass, opts: ExpiryOpts = {}): number {
  const { netDepth, bitNode, backdoored, immune } = opts;
  if (immune === true) return Infinity;
  const anyOf = (kinds: Parameters<typeof msPerHostEventAny>[0]): number =>
    msPerHostEventAny(kinds, netDepth, bitNode, backdoored);
  switch (factClass) {
    case "identity":
      return Infinity;
    case "position":
      return anyOf(["moved"]) * TRUST_FRACTION;
    case "topology":
      // A move, a disconnect and a new connection each invalidate an edge list,
      // so their rates compound — edges are strictly shorter-lived than position.
      return anyOf(["moved", "disconnected", "connected"]) * TRUST_FRACTION;
    case "resource":
      return anyOf(["restarted"]) * TRUST_FRACTION;
  }
}

/** We distrust a fact well before the expected event, because the expected time
 * is a mean over a memoryless-ish process, not a guarantee. A third is a
 * judgement call and the one number here that is not derived; it is stated
 * plainly rather than hidden inside the expiry function. */
export const TRUST_FRACTION = 1 / 3;

export interface Staleness {
  ageMs: number;
  expiresInMs: number;
  stale: boolean;
}

export function staleness(
  fact: HostFact<unknown> | undefined,
  key: string,
  now: number,
  opts: ExpiryOpts = {},
): Staleness | undefined {
  if (!fact) return undefined;
  const limit = expiryMs(FACT_CLASS[key] ?? "topology", opts);
  const ageMs = Math.max(0, now - fact.at);
  return {
    ageMs,
    expiresInMs: limit === Infinity ? Infinity : Math.max(0, limit - ageMs),
    stale: ageMs > limit,
  };
}

/** Read a fact only if it is still believable. Returning undefined for a stale
 * fact is deliberate: a caller that wants the value anyway (to render it, to
 * explain a refusal) reaches into `facts` and says so. */
export function fresh<T>(
  host: DarknetHostKnowledge | undefined,
  key: string,
  now: number,
  opts: ExpiryOpts = {},
): T | undefined {
  const fact = host?.facts[key] as HostFact<T> | undefined;
  if (!fact) return undefined;
  if (host?.goneAt !== undefined) return undefined;
  return staleness(fact, key, now, hostExpiry(host, opts))?.stale ? undefined : fact.value;
}

export interface FoldOutcome {
  knowledge: DarknetKnowledge;
  /** Facts that lost to a newer observation of the same field. */
  superseded: number;
  hostsForgotten: string[];
}

/** Merge reported hosts into knowledge.
 *
 * One rule does the work: facts merge by OBSERVATION time, never by arrival
 * order. A drain hands over a batch whose residents ran at different moments,
 * and two residents adjacent to the same host will both describe it.
 *
 * Generation is deliberately NOT rechecked here. It is enforced once, on the
 * whole rendezvous, by `overseerIsLive` and by the drain: agents outlive
 * controllers, so what has to be refused is the channel, not the record. */
export function foldReports(
  knowledge: DarknetKnowledge,
  reports: readonly ReportHost[],
  now: number,
  opts: ExpiryOpts = {},
): FoldOutcome {
  const hosts: Record<string, DarknetHostKnowledge> = {};
  for (const [name, host] of Object.entries(knowledge.hosts)) {
    hosts[name] = { ...host, facts: { ...host.facts } };
  }
  let superseded = 0;

  for (const seen of reports) {
    const { hostname, present, at, ...rest } = seen;
    // A clock we do not control can hand us the future; treat it as now.
    const observedAt = Math.min(at, now);
    const existing = hosts[hostname];
    const host: DarknetHostKnowledge = existing ?? {
      hostname,
      lastSeenAt: observedAt,
      facts: {},
    };
    if (observedAt >= host.lastSeenAt) host.lastSeenAt = observedAt;

    if (!present) {
      // Absence is itself an observation, and a newer one wins. A host that
      // comes back is a different host with a different password, so its
      // identity facts must not survive the gap.
      if (host.goneAt === undefined || observedAt > host.goneAt) {
        host.goneAt = observedAt;
        host.facts = {};
        // The cracking progress goes with the identity facts, and for the same
        // reason: a host that comes back is CLEANED and given a new password
        // upstream, so a ledger saying "the first 40 candidates are ruled out"
        // would be ruling out candidates for a password that no longer exists.
        delete host.attempts;
        delete host.credentialKnown;
      }
      hosts[hostname] = host;
      continue;
    }
    // Seeing it present is newer evidence than the note that it was gone.
    if (host.goneAt !== undefined && observedAt >= host.goneAt) delete host.goneAt;

    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      const prior = host.facts[key];
      if (prior && prior.at > observedAt) {
        superseded++;
        continue;
      }
      if (prior) superseded++;
      host.facts[key] = { value, at: observedAt };
    }
    hosts[hostname] = host;
  }

  const forgetAfter = forgetMs(opts);
  const hostsForgotten: string[] = [];
  for (const [name, host] of Object.entries(hosts)) {
    // Darknet servers go offline permanently. Remembering one for ever would be
    // publishing a map of a world that no longer contains it — unless it is one
    // the engine cannot delete, which is never gone and so never forgotten.
    const reference = host.goneAt ?? host.lastSeenAt;
    if (now - reference > forgetAfter && !isImmune(host, opts)) {
      hostsForgotten.push(name);
      delete hosts[name];
    }
  }

  return {
    knowledge: { ...knowledge, hosts },
    superseded,
    hostsForgotten,
  };
}

/** A host unseen for this long is dropped. Scaled off deletion rather than
 * movement: the question "is it gone" is answered by the deletion clock — and
 * an immune host is never deleted, so it is never forgotten either. */
export function forgetMs(opts: ExpiryOpts = {}): number {
  if (opts.immune === true) return Infinity;
  return msPerHostEvent("deleted", opts.netDepth, opts.bitNode, opts.backdoored);
}

export interface KnowledgeCoverage {
  known: number;
  /** Hosts whose neighbour list we hold and still believe. */
  adjacencyKnown: number;
  /** Share of held facts that are still believable. */
  freshFraction: number;
  gone: number;
  /** Hosts we hold a credential for. The frontier we have already opened. */
  cracked: number;
  /** Hosts we could put an agent on right now: a credential, plus believable
   *  RAM facts showing room for one. The gap between this and `cracked` is
   *  usually blocked RAM, which is a different problem with a different fix. */
  plantable: number;
}

export function coverage(
  knowledge: DarknetKnowledge,
  now: number,
  opts: ExpiryOpts = {},
  /** RAM an agent needs, for the `plantable` count. */
  agentRamGb = 2.6,
): KnowledgeCoverage {
  let total = 0;
  let stale = 0;
  let adjacencyKnown = 0;
  let gone = 0;
  let cracked = 0;
  let plantable = 0;
  for (const host of Object.values(knowledge.hosts)) {
    if (host.goneAt !== undefined) {
      gone++;
      continue;
    }
    const expiry = hostExpiry(host, opts);
    if (fresh<string[]>(host, "neighbours", now, expiry) !== undefined) adjacencyKnown++;
    if (host.credentialKnown === true) {
      cracked++;
      if (freeRam(host, now, expiry) >= agentRamGb) plantable++;
    }
    for (const [key, fact] of Object.entries(host.facts)) {
      total++;
      if (staleness(fact, key, now, expiry)?.stale) stale++;
    }
  }
  return {
    known: Object.keys(knowledge.hosts).length - gone,
    adjacencyKnown,
    freshFraction: total === 0 ? 0 : (total - stale) / total,
    gone,
    cracked,
    plantable,
  };
}

/** RAM actually available to a script on a darknet host.
 *
 * The subtraction is not obvious. Owner-blocked RAM presents AS used RAM
 * upstream — `updateRamUsed(server.blockedRam)` runs at construction and again
 * whenever used RAM is recalculated — so a naive `max - blocked - used`
 * double-counts the block and can go negative on a host that is doing nothing
 * wrong. `blockedRam` is therefore only subtracted when `usedRam` has not
 * already absorbed it.
 *
 * Returns 0 rather than a guess when the facts are missing or stale: an unknown
 * capacity must never read as "room for an agent". */
export function freeRam(
  host: DarknetHostKnowledge | undefined,
  now: number,
  opts: ExpiryOpts = {},
): number {
  const expiry = hostExpiry(host, opts);
  const maxRam = fresh<number>(host, "maxRam", now, expiry);
  if (maxRam === undefined) return 0;
  const blocked = fresh<number>(host, "blockedRam", now, expiry) ?? 0;
  const used = fresh<number>(host, "usedRam", now, expiry) ?? 0;
  const occupied = used >= blocked ? used : used + blocked;
  return Math.max(0, maxRam - occupied);
}

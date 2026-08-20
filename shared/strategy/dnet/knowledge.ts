import { msPerHostEvent, msPerHostEventAny } from "./rates.ts";

/** What we know about the darknet, how we learned it, and when it stops being
 * believable.
 *
 * The darknet is the only subject in this project that rearranges itself while
 * we look at it: a mutation tick lands every few seconds, moving servers,
 * severing every connection a host had, restarting it, or deleting it
 * permanently. So a bare value is not knowledge here — a value without a
 * timestamp and a source is a claim about a world that may already be gone.
 * See spec/dnet.md. */

export type Provenance = "self" | "agent";

export interface HostFact<T> {
  value: T;
  /** When it was OBSERVED, not when it arrived. Reports race each other. */
  at: number;
  from: Provenance;
  /** The host that observed it, when an agent did. */
  via?: string;
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
  stasisLinked: "resource",
};

export interface DarknetHostKnowledge {
  hostname: string;
  /** Newest observation of this host by anything, for any fact. */
  lastSeenAt: number;
  /** Set when an observation reported the host gone. Identity facts die here. */
  goneAt?: number;
  facts: Record<string, HostFact<unknown>>;
}

export interface DarknetKnowledge {
  hosts: Record<string, DarknetHostKnowledge>;
  /** Generation of the run that produced this. A report stamped with anything
   * else is from a controller that no longer exists — agents outlive us. */
  generation: string;
  /** Mutation ticks observed, which is the clock staleness is really measured
   * against. */
  mutationsSeen: number;
}

export function emptyKnowledge(generation: string): DarknetKnowledge {
  return { hosts: {}, generation, mutationsSeen: 0 };
}

/** How long a fact of this class stays believable.
 *
 * Derived, not chosen: `msPerHostEvent` gives the expected time before a
 * mutation touches one named host in the relevant way, and we distrust a fact
 * at a fraction of that. `identity` never expires with age — only with the
 * host's disappearance. */
export function expiryMs(
  factClass: FactClass,
  opts: { netDepth?: number; bitNode?: number; backdoored?: number } = {},
): number {
  const { netDepth, bitNode, backdoored } = opts;
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
  opts: Parameters<typeof expiryMs>[1] = {},
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
  opts: Parameters<typeof expiryMs>[1] = {},
): T | undefined {
  const fact = host?.facts[key] as HostFact<T> | undefined;
  if (!fact) return undefined;
  if (host?.goneAt !== undefined) return undefined;
  return staleness(fact, key, now, opts)?.stale ? undefined : fact.value;
}

export interface ObservedHost {
  hostname: string;
  /** False when the observation found the host gone. */
  present: boolean;
  facts: Record<string, unknown>;
}

export interface Observation {
  /** Where the observing script was standing. */
  from: string;
  provenance: Provenance;
  /** When the observation was MADE. */
  at: number;
  generation: string;
  hosts: ObservedHost[];
}

export interface FoldOutcome {
  knowledge: DarknetKnowledge;
  /** Observations refused because they came from another run. */
  rejectedGenerations: number;
  /** Facts that lost to a newer observation of the same field. */
  superseded: number;
  hostsForgotten: string[];
}

/** Merge observations into knowledge.
 *
 * Two rules do the work. Facts merge by OBSERVATION time, never by arrival
 * order, because a slow report can carry an older truth than a fast one. And a
 * report from another generation is dropped rather than merged: agents survive a
 * controller cold boot, a build handoff and a page reload, so a live script from
 * a dead run can still be talking to us. */
export function foldObservations(
  knowledge: DarknetKnowledge,
  observations: readonly Observation[],
  now: number,
  opts: Parameters<typeof expiryMs>[1] = {},
): FoldOutcome {
  const hosts: Record<string, DarknetHostKnowledge> = {};
  for (const [name, host] of Object.entries(knowledge.hosts)) {
    hosts[name] = { ...host, facts: { ...host.facts } };
  }
  let rejectedGenerations = 0;
  let superseded = 0;

  for (const observation of observations) {
    if (observation.generation !== knowledge.generation) {
      rejectedGenerations++;
      continue;
    }
    for (const seen of observation.hosts) {
      const existing = hosts[seen.hostname];
      const host: DarknetHostKnowledge = existing ?? {
        hostname: seen.hostname,
        lastSeenAt: observation.at,
        facts: {},
      };
      if (observation.at >= host.lastSeenAt) host.lastSeenAt = observation.at;

      if (!seen.present) {
        // Absence is itself an observation, and a newer one wins. A host that
        // comes back is a different host with a different password, so its
        // identity facts must not survive the gap.
        if (host.goneAt === undefined || observation.at > host.goneAt) {
          host.goneAt = observation.at;
          host.facts = {};
        }
        hosts[seen.hostname] = host;
        continue;
      }
      // Seeing it present is newer evidence than the note that it was gone.
      if (host.goneAt !== undefined && observation.at >= host.goneAt) delete host.goneAt;

      for (const [key, value] of Object.entries(seen.facts)) {
        if (value === undefined) continue;
        const prior = host.facts[key];
        if (prior && prior.at > observation.at) {
          superseded++;
          continue;
        }
        if (prior) superseded++;
        host.facts[key] = {
          value,
          // A clock we do not control can hand us the future; treat it as now.
          at: Math.min(observation.at, now),
          from: observation.provenance,
          ...(observation.provenance === "agent" ? { via: observation.from } : {}),
        };
      }
      hosts[seen.hostname] = host;
    }
  }

  const forgetAfter = forgetMs(opts);
  const hostsForgotten: string[] = [];
  for (const [name, host] of Object.entries(hosts)) {
    // Darknet servers go offline permanently. Remembering one for ever would be
    // publishing a map of a world that no longer contains it.
    const reference = host.goneAt ?? host.lastSeenAt;
    if (now - reference > forgetAfter) {
      hostsForgotten.push(name);
      delete hosts[name];
    }
  }

  return {
    knowledge: { ...knowledge, hosts },
    rejectedGenerations,
    superseded,
    hostsForgotten,
  };
}

/** A host unseen for this long is dropped. Scaled off deletion rather than
 * movement: the question "is it gone" is answered by the deletion clock. */
export function forgetMs(opts: Parameters<typeof expiryMs>[1] = {}): number {
  return msPerHostEvent("deleted", opts.netDepth, opts.bitNode, opts.backdoored);
}

export interface KnowledgeCoverage {
  known: number;
  /** Hosts whose neighbour list we hold and still believe. */
  adjacencyKnown: number;
  /** Share of held facts that are still believable. */
  freshFraction: number;
  gone: number;
}

export function coverage(
  knowledge: DarknetKnowledge,
  now: number,
  opts: Parameters<typeof expiryMs>[1] = {},
): KnowledgeCoverage {
  let total = 0;
  let stale = 0;
  let adjacencyKnown = 0;
  let gone = 0;
  for (const host of Object.values(knowledge.hosts)) {
    if (host.goneAt !== undefined) {
      gone++;
      continue;
    }
    if (fresh<string[]>(host, "neighbours", now, opts) !== undefined) adjacencyKnown++;
    for (const [key, fact] of Object.entries(host.facts)) {
      total++;
      if (staleness(fact, key, now, opts)?.stale) stale++;
    }
  }
  return {
    known: Object.keys(knowledge.hosts).length - gone,
    adjacencyKnown,
    freshFraction: total === 0 ? 0 : (total - stale) / total,
    gone,
  };
}

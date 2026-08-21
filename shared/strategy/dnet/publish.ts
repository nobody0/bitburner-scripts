import { stripCredentials } from "./courier.ts";
import { modelEntry } from "./models.ts";
import {
  FACT_CLASS,
  expiryMs,
  freeRam,
  fresh,
  staleness,
  type DarknetHostKnowledge,
  type DarknetKnowledge,
} from "./knowledge.ts";
import type {
  DarknetAgentDigest,
  DarknetFactMeta,
  DarknetKnowledgeDigest,
  DarknetKnownHost,
} from "../../telemetry/topics/dnet.ts";

/** Turning what the controller KNOWS into something a person can look at.
 *
 * The driver has always folded agent reports into a provenance-stamped fact set
 * and then thrown it away, publishing only the home probe's one-hop view. That
 * is why the Darknet panel showed `darkweb` and nothing else no matter how much
 * the agents learned. This module is the missing half.
 *
 * The rule it exists to serve is the one in spec/dnet.md: *every fact about the
 * darknet carries where it came from and when.* A digest that flattened facts
 * back to bare values would publish a map of a world that may no longer exist
 * and give no way to tell. So each fact travels WITH its age, its source and
 * whether we still believe it, and the panel can show a stale value greyed out
 * rather than pretending it is current or hiding it entirely.
 *
 * Two things deliberately do not travel:
 *
 * - **Credentials.** `credentialKnown` is a boolean. The password itself lives
 *   only in the driver's vault, because this digest is mirrored to telemetry and
 *   written to disk as JSONL.
 * - **Infinity.** `expiryMs` returns it for the identity class and JSON cannot
 *   carry it, so `expiresInMs` is `null` there and the panel reads that as
 *   "never expires by age" rather than as a missing number. */

/** Hosts published per digest. The deepest labyrinth builds a net of roughly 163
 * servers (`spec/strategy/bitnodes/bn15.md`), so this clears the largest real
 * net with room to spare while still bounding a runaway. */
export const KNOWLEDGE_MAX_HOSTS = 220;

/** Facts we publish per host, in the order the detail panel reads best. Listed
 * explicitly rather than dumped, so a new internal fact does not silently become
 * part of the wire. */
const PUBLISHED_FACTS = [
  "depth",
  "neighbours",
  "ip",
  "maxRam",
  "blockedRam",
  "usedRam",
  "requiredCharisma",
  "difficulty",
  "isStationary",
  "modelId",
  "passwordLength",
  "passwordFormat",
  "passwordHint",
  "data",
  "logTrafficInterval",
  "hasSession",
  "stasisLinked",
] as const;

export interface PublishOptions {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  /** RAM an agent needs, for the plantable/`freeRam` readouts. */
  agentRamGb?: number;
  /** Live agents, keyed by the host they are standing on. */
  agents?: Record<string, DarknetAgentDigest>;
  /** Hosts we hold a credential for. Passed in rather than read off the
   *  knowledge record so the vault stays the single source of that truth. */
  vault?: ReadonlySet<string>;
  unknownModels?: Record<string, number>;
  /** Agents seen and lost since boot — the mortality metric spec/dnet.md asks
   *  for, which has never had anywhere to live. */
  agentsSeenEver?: number;
  agentsLost?: number;
  overseer?: DarknetKnowledgeDigest["overseer"];
  queue?: DarknetKnowledgeDigest["queue"];
}

function factMeta(
  host: DarknetHostKnowledge,
  key: string,
  now: number,
  opts: Parameters<typeof expiryMs>[1],
): DarknetFactMeta | undefined {
  const fact = host.facts[key];
  if (!fact) return undefined;
  const age = staleness(fact, key, now, opts);
  if (!age) return undefined;
  return {
    at: fact.at,
    from: fact.from,
    ...(fact.via !== undefined ? { via: fact.via } : {}),
    ageMs: age.ageMs,
    // JSON has no Infinity. `null` is the identity class saying "not by age".
    expiresInMs: Number.isFinite(age.expiresInMs) ? age.expiresInMs : null,
    stale: age.stale,
    class: FACT_CLASS[key] ?? "topology",
  };
}

/** One host, as the panel needs it: the current best value of every fact, plus
 * the provenance of each, plus what we have tried against it. */
export function publishHost(
  host: DarknetHostKnowledge,
  now: number,
  opts: PublishOptions = {},
): DarknetKnownHost {
  const expiry = { netDepth: opts.netDepth, bitNode: opts.bitNode, backdoored: opts.backdoored };
  const facts: Record<string, DarknetFactMeta> = {};
  const values: Record<string, unknown> = {};
  for (const key of PUBLISHED_FACTS) {
    const meta = factMeta(host, key, now, expiry);
    if (!meta) continue;
    facts[key] = meta;
    // The VALUE is published even when stale, and the meta says it is stale.
    // Hiding a stale value would leave the panel blank exactly when the operator
    // most wants to know what we last believed and how long ago.
    values[key] = host.facts[key]!.value;
  }

  const gone = host.goneAt !== undefined;
  const isDarkweb = host.hostname === "darkweb";
  const depth = values["depth"] as number | undefined;
  const entry = modelEntry(values["modelId"] as string | undefined);
  const ledger = host.attempts;

  return {
    hostname: host.hostname,
    lastSeenAt: host.lastSeenAt,
    ...(gone ? { goneAt: host.goneAt } : {}),
    ...(isDarkweb ? { isDarkweb: true } : {}),
    // `depth` is OMITTED when unknown rather than sent as -1. The map lays out
    // by depth, and -1 already means "darkweb" — one sentinel cannot mean both
    // "the root" and "we have no idea", or the root ends up in the unplaced row.
    ...(depth !== undefined ? { depth } : {}),
    ...(values["ip"] !== undefined ? { ip: values["ip"] as string } : {}),
    ...(values["neighbours"] !== undefined ? { neighbours: values["neighbours"] as string[] } : {}),
    ...(values["maxRam"] !== undefined ? { maxRam: values["maxRam"] as number } : {}),
    ...(values["blockedRam"] !== undefined ? { blockedRam: values["blockedRam"] as number } : {}),
    ...(values["usedRam"] !== undefined ? { usedRam: values["usedRam"] as number } : {}),
    freeRam: freeRam(host, now, expiry),
    ...(values["requiredCharisma"] !== undefined ? { requiredCharisma: values["requiredCharisma"] as number } : {}),
    ...(values["difficulty"] !== undefined ? { difficulty: values["difficulty"] as number } : {}),
    ...(values["isStationary"] !== undefined ? { isStationary: values["isStationary"] as boolean } : {}),
    ...(values["modelId"] !== undefined ? { modelId: values["modelId"] as string } : {}),
    ...(values["passwordLength"] !== undefined ? { passwordLength: values["passwordLength"] as number } : {}),
    ...(values["passwordFormat"] !== undefined ? { passwordFormat: values["passwordFormat"] as string } : {}),
    ...(values["passwordHint"] !== undefined ? { passwordHint: values["passwordHint"] as string } : {}),
    ...(values["data"] !== undefined ? { data: values["data"] as string } : {}),
    ...(values["logTrafficInterval"] !== undefined
      ? { logTrafficInterval: values["logTrafficInterval"] as number }
      : {}),
    ...(values["stasisLinked"] !== undefined ? { stasisLinked: values["stasisLinked"] as boolean } : {}),
    facts,
    // The model's own account of itself, so the panel can say WHY a host is
    // untouched instead of leaving a blank where a reason belongs.
    ...(entry
      ? {
        modelName: entry.name,
        modelFamily: entry.family,
        modelFeedback: entry.feedback,
        modelOracle: entry.oracle,
        modelVia: entry.via,
        ...(entry.blocked !== undefined ? { modelBlocked: entry.blocked } : {}),
      }
      : values["modelId"] !== undefined
        // A model id we do not recognise is shown as exactly that. Falling back
        // to a generic family here would hide a game update behind a shrug.
        ? { modelFamily: "oracle" as const, modelBlocked: "unrecognised model id" }
        : {}),
    ...(ledger
      ? {
        attempt: {
          ...(ledger.modelId !== undefined ? { modelId: ledger.modelId } : {}),
          status: ledger.solved === true
            ? "solved"
            : entry === undefined && values["modelId"] !== undefined
              ? "unknown-model"
              : entry?.status === "implemented"
                ? "failed"
                : "unattempted",
          tried: ledger.tried,
          probes: ledger.probes,
          ...(ledger.lastCode !== undefined ? { lastCode: ledger.lastCode } : {}),
          ...(ledger.lastOracle !== undefined ? { lastOracle: ledger.lastOracle } : {}),
          ...(ledger.lastAt !== undefined ? { lastAt: ledger.lastAt } : {}),
        },
      }
      : {}),
    credentialKnown: opts.vault?.has(host.hostname) === true || host.credentialKnown === true,
    ...(opts.agents?.[host.hostname] ? { agent: opts.agents[host.hostname] } : {}),
    authState: authStateOf(host, now, expiry, gone, isDarkweb, opts),
  };
}

/** What the map draws on the box border, decided ONCE here so the map and the
 * table can never disagree about a host's status. */
function authStateOf(
  host: DarknetHostKnowledge,
  now: number,
  expiry: Parameters<typeof expiryMs>[1],
  gone: boolean,
  isDarkweb: boolean,
  opts: PublishOptions,
): DarknetKnownHost["authState"] {
  if (gone) return "offline";
  // darkweb is authenticated by construction: the session check short-circuits
  // for it upstream, so it is never "auth required" no matter what we hold.
  if (isDarkweb) return "session";
  if (opts.agents?.[host.hostname]?.alive === true) return "session";
  if (opts.vault?.has(host.hostname) === true || host.credentialKnown === true) return "authenticated";
  // Without a believable neighbour list we cannot claim it is even reachable;
  // the in-game map draws exactly this distinction.
  const neighbours = fresh<string[]>(host, "neighbours", now, expiry);
  return neighbours === undefined ? "no-connection" : "auth-required";
}

/** The whole digest. Everything here is state the driver already holds, so this
 * satisfies the telemetry rule with no new getter and a `--perf` build is
 * unchanged. */
export function publishKnowledge(
  knowledge: DarknetKnowledge,
  now: number,
  opts: PublishOptions = {},
): DarknetKnowledgeDigest {
  const all = Object.values(knowledge.hosts);
  // Sorted by depth then name so the panel is stable frame to frame: an
  // insertion-ordered list would reshuffle whenever a host was forgotten, and a
  // map that shimmers is a map nobody reads.
  const sorted = [...all].sort((a, b) => {
    const da = (a.facts["depth"]?.value as number | undefined) ?? Number.MAX_SAFE_INTEGER;
    const db = (b.facts["depth"]?.value as number | undefined) ?? Number.MAX_SAFE_INTEGER;
    return da - db || (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0);
  });
  const hosts = sorted.slice(0, KNOWLEDGE_MAX_HOSTS).map((host) => publishHost(host, now, opts));
  const gone = all.filter((host) => host.goneAt !== undefined).length;
  const live = Object.values(opts.agents ?? {}).filter((agent) => agent.alive).length;

  // Stripped on the way out. The host records above are built from an explicit
  // allow-list of fact names, so nothing carrying a credential should reach here
  // — this catches the field somebody adds later to a nested structure the
  // digest happens to carry along.
  return stripCredentials({
    at: now,
    generation: knowledge.generation,
    hosts,
    ...(sorted.length > hosts.length ? { truncated: true, totalHosts: sorted.length } : {}),
    gone,
    mutationsSeen: knowledge.mutationsSeen,
    ...(opts.unknownModels && Object.keys(opts.unknownModels).length > 0
      ? { unknownModels: { ...opts.unknownModels } }
      : {}),
    agents: {
      live,
      seenEver: opts.agentsSeenEver ?? live,
      // The gap between agents seen and agents still reporting IS agent
      // mortality, and out there that is the loss that actually matters: the
      // transport does not drop data, hosts drop agents.
      lostSinceBoot: opts.agentsLost ?? 0,
    },
    ...(opts.overseer ? { overseer: opts.overseer } : {}),
    ...(opts.queue ? { queue: opts.queue } : {}),
  });
}

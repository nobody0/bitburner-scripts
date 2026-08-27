import { stripCredentials } from "./courier.ts";
import { modelEntry } from "./models.ts";
import {
  fieldGroup,
  fresh,
  isImmune,
  type DnetHost,
  type DnetKnowledge,
  type ExpiryOpts,
} from "./host.ts";
import type {
  DarknetAgentDigest,
  DarknetKnowledgeDigest,
  DarknetKnownHost,
} from "../../telemetry/topics/dnet.ts";

/** Turning what the controller KNOWS into something a person can look at.
 *
 * The rule it serves is the one in spec/dnet.md: no darknet fact may be treated
 * as current without checking its age. A digest of bare values would publish a
 * map of a world that may no longer exist and give no way to tell — so every
 * fact's observation time travels with it, and the panel can grey a stale value
 * out rather than pretending it is current or hiding it entirely.
 *
 * **Only what cannot be derived travels.** Age, expiry class and staleness all
 * follow from that timestamp plus the mutation clock, and a model's name, oracle
 * and reason-untouched follow from its `modelId`. `ui/` computes both from the
 * same shared modules this file uses, so sending them would add six fields to
 * each of the sixteen facts below plus six strings per host — on a net that can
 * reach `KNOWLEDGE_MAX_HOSTS`, every tick.
 *
 * Usable script capacity and `authState` are resolved once here so the map and
 * table cannot disagree about them.
 *
 * One thing deliberately does not travel at all: **credentials**.
 * `credentialKnown` is a boolean, because this digest is mirrored to telemetry
 * and written to disk as JSONL. `stripCredentials` is the second line behind
 * the allow-list below. */

/** Hosts published per digest. The deepest labyrinth builds a net of roughly 163
 * servers (`spec/dnet.md`), so this clears the largest real
 * net with room to spare while still bounding a runaway. */
export const KNOWLEDGE_MAX_HOSTS = 220;

/** Facts we publish per host, in the order the detail panel reads best. Listed
 * explicitly rather than dumped, so a new internal fact does not silently become
 * part of the wire. */
const PUBLISHED_FACTS = [
  "depth",
  "neighbours",
  "maxRam",
  "blockedRam",
  "requiredCharisma",
  "difficulty",
  "isStationary",
  "modelId",
  "passwordLength",
  "passwordFormat",
  "passwordHint",
  "data",
  "logTrafficInterval",
  // The unopened `.cache` files on a host. Already collected by `surveyJob` and
  // already classed `resource`, so its timestamp carries its own staleness — it
  // was simply missing from the allow-list, which is why nothing downstream
  // could say which hosts were holding one. A lab's cache listing is also the
  // only evidence we have that its maze has been walked.
  "caches",
  // When we last read this host's log ring. The `.at` IS the payload, so this
  // adds no field to `DarknetKnownHost` — it rides `facts` like everything
  // else, and it is what lets a reader work out whether a bleed is due.
] as const;

/** How far a feedback solver has got, and NOTHING else from its state.
 *
 * `SolverState.scratch` accumulates resolved characters, known prefixes and
 * modular residues — late in a solve it IS the password — so `stripCredentials`
 * deletes any key named `solver` or `scratch` at any depth, and that stays
 * absolute. This does not weaken it and does not ask to be exempted from it:
 * it publishes under a DIFFERENT name, and it is built field by field.
 *
 * The allow-list is the whole safety argument. A spread of the state, or a loop
 * over its entries, would ship `scratch` the first time a solver added a field;
 * naming the two scalars means `scratch` is never read at this site at all, so
 * there is no path from it into the result.
 *
 * `budget` is deliberately absent: `Solver.budget(facts)` is a pure function of
 * the password facts we already publish, so a reader derives it exactly as it
 * derives the model's name and oracle from `modelId`.
 *
 * `phase` is solver-defined free text, so it is capped rather than trusted. */
function solveProgress(state: Record<string, unknown> | undefined): { solve?: { phase: string; spent: number } } {
  if (state === undefined) return {};
  const phase = typeof state["phase"] === "string" ? state["phase"] : "";
  const spent = typeof state["spent"] === "number" && Number.isFinite(state["spent"]) ? state["spent"] : 0;
  if (phase === "" && spent === 0) return {};
  return { solve: { phase: phase.slice(0, PHASE_MAX), spent } };
}

/** A solver's phase name is a label like `bisect` or `probe`. Anything longer is
 * not a label, and a cap costs nothing to enforce. */
const PHASE_MAX = 32;

export interface PublishOptions {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  /** Hosts we hold a stasis link on. A stasis-linked host is outside the
   *  mutation clock entirely, so nothing of it ages — see `isImmune`. */
  stasisLinked?: ReadonlySet<string>;
  /** RAM an agent needs, for the plantable/usable-RAM readouts. */
  agentRamGb?: number;
  /** Live agents, keyed by the host they are standing on. */
  agents?: Record<string, DarknetAgentDigest>;
  /** Volatile runtime RAM samples, separate from durable host facts. */
  ram?: ReadonlyMap<string, NonNullable<DarknetKnownHost["ram"]>>;
  /** Hosts we hold a credential for. Passed in rather than read off the
   *  knowledge record so the vault stays the single source of that truth. */
  vault?: ReadonlySet<string>;
  unknownModels?: Record<string, number>;
  /** Agents seen and lost since boot — the mortality metric spec/dnet.md asks
   *  for, which has never had anywhere to live. */
  agentsSeenEver?: number;
  agentsLost?: number;
  controller?: DarknetKnowledgeDigest["controller"];
  queue?: DarknetKnowledgeDigest["queue"];
}

/** One host, as the panel needs it: the current best value of every fact, when
 * each was seen, and what we have tried against it. */
export function publishHost(
  host: DnetHost,
  now: number,
  opts: PublishOptions = {},
  /** The frontier, from `reachableFrom`. Defaulted so a caller publishing a
   *  single host in isolation still gets a sane answer — it just cannot know
   *  that the host is reachable, which is the honest result with no graph. */
  reachable: ReadonlySet<string> = new Set(),
): DarknetKnownHost {
  const facts: Record<string, number> = {};
  const values: Record<string, unknown> = {};
  for (const key of PUBLISHED_FACTS) {
    const value = (host as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const group = fieldGroup(key);
    const observedAt = group === "identity" ? host.identitySeenAt : group === undefined ? undefined : host.seenAt[group];
    if (observedAt !== undefined) facts[key] = observedAt;
    // The VALUE is published even when stale, and the age says it is stale.
    // Hiding a stale value would leave the panel blank exactly when the operator
    // most wants to know what we last believed and how long ago.
    values[key] = value;
  }

  const gone = host.goneAt !== undefined;
  const isDarkweb = host.hostname === "darkweb";
  const depth = values["depth"] as number | undefined;
  const maxRam = values["maxRam"] as number | undefined;
  const blockedRam = values["blockedRam"] as number | undefined;
  const entry = modelEntry(values["modelId"] as string | undefined);
  const ledger = host.attempts;
  const ram = opts.ram?.get(host.hostname);
  // Not aged out. Three of this sample's four fields cannot go stale on a
  // clock — `total` never changes and is re-read on every `getServerDetails`,
  // and `blocked` has its own dirty bit — so a 60s cutoff hid the whole RAM
  // readout, durable fields included, over one volatile one. The sample is
  // replaced when a newer one arrives and carries `at` so the panel can say
  // how old it is. A gone host keeps nothing.
  const liveRam = gone ? undefined : ram;

  return {
    hostname: host.hostname,
    lastSeenAt: host.lastSeenAt,
    ...(gone ? { goneAt: host.goneAt } : {}),
    ...(isDarkweb ? { isDarkweb: true } : {}),
    // `depth` is OMITTED when unknown rather than sent as -1. The map lays out
    // by depth, and -1 already means "darkweb" — one sentinel cannot mean both
    // "the root" and "we have no idea", or the root ends up in the unplaced row.
    ...(depth !== undefined ? { depth } : {}),
    ...(values["neighbours"] !== undefined ? { neighbours: values["neighbours"] as string[] } : {}),
    ...(maxRam !== undefined ? { maxRam } : {}),
    ...(blockedRam !== undefined ? { blockedRam } : {}),
    ...(maxRam !== undefined ? { usableRam: Math.max(0, maxRam - (blockedRam ?? 0)) } : {}),
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
    ...(values["caches"] !== undefined ? { caches: values["caches"] as string[] } : {}),
    // Not a fact: we are the only thing that links or releases, so the
    // controller's set is the truth and an observed copy could only be staler.
    ...(opts.stasisLinked?.has(host.hostname) === true ? { stasisLinked: true } : {}),
    facts,
    ...(Object.keys(host.dirty).length > 0 ? { dirty: { ...host.dirty } } : {}),
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
          ...(ledger.lastAt !== undefined ? { lastAt: ledger.lastAt } : {}),
          ...(ledger.solver !== undefined ? { solving: true } : {}),
          ...solveProgress(ledger.solver),
        },
      }
      : {}),
    credentialKnown: opts.vault?.has(host.hostname) === true || host.credentialKnown === true,
    ...(opts.agents?.[host.hostname] ? { agent: opts.agents[host.hostname] } : {}),
    ...(liveRam ? { ram: liveRam } : {}),
    authState: authStateOf(host, gone, isDarkweb, reachable, opts),
  };
}

/** What the map and table show for authentication reachability.
 * `reachable` is computed across the graph using upstream's outward rule:
 * `allowAuth`, handed to each box as its `enableAuth` prop:
 *
 *     allowAuth = server.hasAdminRights
 *       || server.serversOnNetwork.some((n) => n.hasAdminRights)
 *
 * Source: src/DarkNet/ui/NetworkDisplayWrapper.tsx:89,
 *   src/DarkNet/ui/ServerSummary.tsx:26-31 */
function authStateOf(
  host: DnetHost,
  gone: boolean,
  isDarkweb: boolean,
  reachable: ReadonlySet<string>,
  opts: PublishOptions,
): DarknetKnownHost["authState"] {
  if (gone) return "offline";
  // darkweb is authenticated by construction: the session check short-circuits
  // for it upstream, so it is never "auth required" no matter what we hold.
  if (isDarkweb) return "session";
  if (opts.agents?.[host.hostname]?.alive === true) return "session";
  if (opts.vault?.has(host.hostname) === true || host.credentialKnown === true) return "authenticated";
  return reachable.has(host.hostname) ? "auth-required" : "no-connection";
}

/** Hosts adjacent to one we hold — the frontier, and the live work queue.
 *
 * Adjacency is symmetric, and the evidence for it arrives from whichever end
 * happened to have an agent on it. So BOTH directions count:
 *
 * - a held host's own neighbour list names everything one hop out from it;
 * - a host naming a held host as ITS neighbour is, by the same token, one hop
 *   out from that held host.
 *
 * The second half is not a nicety. `probe()` is host-local, so the only way to
 * learn darkweb's own list is home's one-hop probe; a depth-0 host reporting
 * "my neighbour is darkweb" is exactly as good, and often arrives first. This is
 * why the frontier is populated before anything has been cracked at all. */
function reachableFrom(
  hosts: readonly DnetHost[],
  now: number,
  opts: PublishOptions,
  expiryFor: (host: DnetHost) => ExpiryOpts,
): Set<string> {
  const held = (host: DnetHost): boolean =>
    host.goneAt === undefined
    && (host.hostname === "darkweb"
      || opts.agents?.[host.hostname]?.alive === true
      || opts.vault?.has(host.hostname) === true
      || host.credentialKnown === true);
  // A stale neighbour list still names real hosts. The net rewires, but a host
  // that WAS beside darkweb a minute ago is a far better guess at the frontier
  // than no guess at all, and the box's own staleness fade already says how much
  // to trust it.
  const neighboursOf = (host: DnetHost): readonly string[] =>
    fresh<string[]>(host, "neighbours", now, expiryFor(host))
      ?? host.neighbours
      ?? [];

  const heldNames = new Set(hosts.filter(held).map((host) => host.hostname));
  const reachable = new Set<string>();
  for (const host of hosts) {
    if (heldNames.has(host.hostname)) {
      for (const name of neighboursOf(host)) reachable.add(name);
      continue;
    }
    if (neighboursOf(host).some((name) => heldNames.has(name))) reachable.add(host.hostname);
  }
  return reachable;
}

/** The whole digest. Everything here is state the driver already holds, so this
 * satisfies the telemetry rule with no new getter and a `--perf` build is
 * unchanged. */
export function publishKnowledge(
  knowledge: DnetKnowledge,
  now: number,
  opts: PublishOptions = {},
): DarknetKnowledgeDigest {
  const all = [...knowledge.hosts.values()];
  // Sorted by depth then name so the panel is stable frame to frame: an
  // insertion-ordered list would reshuffle whenever a host was forgotten, and a
  // map that shimmers is a map nobody reads.
  const sorted = [...all].sort((a, b) => {
    const da = a.depth ?? Number.MAX_SAFE_INTEGER;
    const db = b.depth ?? Number.MAX_SAFE_INTEGER;
    return da - db || (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0);
  });
  // The frontier is a property of the GRAPH, so it is resolved once over every
  // host we hold and handed down, rather than re-derived per host from the one
  // host itself — which is what made every crackable host read "no connection".
  const reachable = reachableFrom(all, now, opts, (host) => ({
    netDepth: opts.netDepth,
    bitNode: opts.bitNode,
    backdoored: opts.backdoored,
    immune: isImmune(host, opts),
  }));
  const hosts = sorted.slice(0, KNOWLEDGE_MAX_HOSTS).map((host) => publishHost(host, now, opts, reachable));
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
    ...(opts.controller ? { controller: opts.controller } : {}),
    ...(opts.queue ? { queue: opts.queue } : {}),
  });
}

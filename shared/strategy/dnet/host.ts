import { msPerHostEvent, msPerHostEventAny } from "./rates.ts";
import { conclusiveAttempt, type AttemptOutcome, type DnetFactGroup, type LogDrainOutcome, type ReportHost } from "./courier.ts";
import type { PasswordEvidence } from "./evidence.ts";

/** One flat record per darknet host, and when its fields stop being believable.
 *
 * The darknet is the only subject in this project that rearranges itself while
 * we look at it, so a bare value is not knowledge here — a value without a
 * timestamp is a claim about a world that may already be gone. The old model
 * wrapped every field in its own `{value, at}` fact; this one keeps the same
 * semantics with a flat record whose fields are stamped and invalidated in
 * GROUPS, because fields that arrive through one call go stale through the same
 * events. See spec/dnet.md. */

/** Field groups, named for what refreshes them.
 *
 * This split is the whole point. A flat expiry would either distrust a host's
 * password format — which cannot change while the host lives — or trust its
 * neighbour list long after the net rewired it.
 *
 * - ram: blockedRam. Restart preserves it; memory reallocation changes it.
 * - `files`: caches/contracts/stormSeed. A resident's `ls` is its
 *   separate refresh channel. Splitting the
 *   old `resource` class in two is deliberate: with a single bit a details
 *   sweep would re-bless a stale cache listing, and acting on one means calling
 *   `openCache` on a filename the host no longer holds, which THROWS. */
export type DirtyGroup = DnetFactGroup;

export const DIRTY_GROUPS: readonly DirtyGroup[] = ["position", "topology", "ram", "files"];

export interface DnetHost {
  hostname: string;
  /** Stable for one server lifetime (dnsLookup ip). Hostnames are reused after
   *  a deletion; a NEW ip retires the whole record in place. */
  identity?: string;

  // ---- identity fields: fixed for the lifetime of a host identity. A deleted
  // host that later reappears is a NEW host with a new password, so these are
  // invalidated by disappearance, never by age.
  modelId?: string;
  passwordLength?: number;
  passwordFormat?: string;
  passwordHint?: string;
  data?: string;
  difficulty?: number;
  isStationary?: boolean;
  logTrafficInterval?: number;
  requiredCharisma?: number;
  maxRam?: number;

  // ---- position ----
  depth?: number;
  // ---- topology ----
  neighbours?: string[];
  // ---- ram ----
  blockedRam?: number;
  // ---- files (all three read off the one `ls` call). Empty array / explicit
  // false is a real observation — "we looked and there were none" — and must
  // not be conflated with absent, which means "the job did not look". ----
  caches?: string[];
  contracts?: string[];
  stormSeed?: boolean;

  // ---- lifecycle ----
  /** Newest observation of this host by anything, for any field. */
  lastSeenAt: number;
  /** Set when an observation reported the host gone. Identity fields die here. */
  goneAt?: number;
  /** When each group was last observed. The freshness authority. */
  seenAt: Partial<Record<DirtyGroup, number>>;
  /** When the identity fields were first/last confirmed, for the panel's age
   *  stamps only — identity never expires by age. */
  identitySeenAt?: number;
  /** Controller-set invalidation, cleared by the group's refresh channel.
   *  Dirty means "an event may have changed this since we looked": our own
   *  actions, a report's explicit invalidation, or a storm wipe.
   *  The age fallback below covers what dirty marks cannot — mutations nobody
   *  observed. */
  dirty: Partial<Record<DirtyGroup, true>>;

  // ---- ours: about US rather than the host. Never expires on the mutation
  // clock; discarded when the host identity dies. ----
  /** That we HOLD a credential, never the credential. This record is published
   *  to telemetry; the password lives only in the driver's vault. */
  credentialKnown?: boolean;
  attempts?: AttemptLedger;
  ring?: LogRingState;
  lastPlantAt?: number;

  // ---- runtime overlay, stamped by the controller before each derivation.
  // Observed truths about our own processes; controller secrets (vault,
  // stasisLinked) deliberately stay OUT of the record — see PlanContext. ----
  agentAlive?: boolean;
  /** RAM a JOB would get here (free + what the resident hands back). */
  jobFreeGb?: number;
  /** TaskKinds a live process is already running against this host. */
  busy?: ReadonlySet<string>;
}

export type DnetHosts = Map<string, DnetHost>;

/** Durable home-owned knowledge metadata around the canonical host map. */
export interface DnetKnowledge {
  hosts: DnetHosts;
  generation: string;
  mutationsSeen: number;
}

export function emptyKnowledge(generation: string): DnetKnowledge {
  return { hosts: new Map(), generation, mutationsSeen: 0 };
}

/** Which group a reportable field belongs to; identity fields are absent. */
export const GROUP_FIELDS: Readonly<Record<DirtyGroup, readonly string[]>> = {
  position: ["depth"],
  topology: ["neighbours"],
  ram: ["blockedRam"],
  files: ["caches", "contracts", "stormSeed"],
};

export const IDENTITY_FIELDS: readonly string[] = [
  "modelId", "passwordLength", "passwordFormat", "passwordHint", "data",
  "difficulty", "isStationary", "logTrafficInterval", "requiredCharisma", "maxRam",
];

export function fieldGroup(key: string): DirtyGroup | "identity" | undefined {
  for (const group of DIRTY_GROUPS) if (GROUP_FIELDS[group].includes(key)) return group;
  if (IDENTITY_FIELDS.includes(key)) return "identity";
  return undefined;
}

export function emptyHost(hostname: string, lastSeenAt: number): DnetHost {
  return { hostname, lastSeenAt, seenAt: {}, dirty: {} };
}

/** How far the cracker got against one host identity.
 *
 * Not host knowledge, because it is about US rather than about the host, and it
 * must not expire on the mutation clock — a dictionary we have already walked
 * stays walked. It IS discarded when the host disappears, because a host that
 * returns is a new host with a new password (see the `goneAt` branch in the fold). */
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
   * It lives here rather than in the job because the random mutation process
   * may remove the current adjacency at any call boundary, while the password
   * changes only when the host is deleted. A solve must therefore be resumable
   * from a different neighbour, and this is what it resumes from.
   *
   * Typed loosely on purpose. `shared/strategy/dnet/solvers/` owns the shape and
   * validates it with its own fingerprint; the ledger only has to carry it. It
   * is redacted by `stripCredentials` — see `courier.ts` — because a partly
   * solved password is still a password. */
  solver?: Record<string, unknown>;
  /** Every attempt against this identity, shared by all future vantages. */
  history?: AttemptOutcome[];
  /** Parsed constraints owned by this target, never by the draining agent. */
  evidence?: PasswordEvidence[];
}

/** Minimal target-ring state, independent of password-cracking history. */
export interface LogRingState {
  pendingAuthRecords: number;
  lastBleedAttemptAt?: number;
  lastBleedAt?: number;
}

/** Fold attempt outcomes into a host's ledger.
 *
 * Shared between the controller — whose ledger drives attempt planning — and
 * home, whose copy survives the controller's death and feeds the panel. One
 * function, so the two can never count a candidate differently. Mutates in
 * place, like the ledger itself: attempts are about US, not the host, so they
 * sit outside the fold's newest-wins rule. */
export function foldAttempts(
  host: DnetHost | undefined,
  outcomes: readonly AttemptOutcome[],
): void {
  // A gone host's ledger stays dropped: the fold discards cracking progress on
  // disappearance because a returning host is a new host with a new password,
  // and an outcome that lands in the same drain as the gone report must not
  // resurrect counts that belong to the dead identity.
  if (!host || host.goneAt !== undefined) return;
  for (const attempt of outcomes) {
    const ledger = host.attempts ?? { tried: 0, probes: 0 };
    const history = ledger.history ??= [];
    const existing = history.find((item) => item === attempt || (
      item.at === attempt.at
      && item.attempted === attempt.attempted
      && item.code === attempt.code
      && item.status === attempt.status
      && item.candidateIndex === attempt.candidateIndex
    ));
    // Counted on the fold that first makes the outcome CONCLUSIVE, not on the
    // first fold of the object. `runAttempt` records one authentication twice —
    // once the instant it returns, so a cancellation at the delayed drain cannot
    // erase it, and again with the oracle folded in — and the first of those
    // reads `oracle-unavailable` for every oracle-bearing step. Keying on "first
    // fold" therefore never counted those at all, and `tried`/`probes` stopped
    // advancing for exactly the models whose progress they measure.
    const wasConclusive = existing !== undefined && conclusiveAttempt(existing);
    if (existing) Object.assign(existing, attempt);
    else history.push(attempt);
    if (attempt.modelId !== undefined) ledger.modelId = attempt.modelId;
    // The solver's own place in the conversation. Carried verbatim: this module
    // does not interpret it, and `solvers/` refuses a state whose fingerprint no
    // longer matches the host.
    if (attempt.solver !== undefined) ledger.solver = attempt.solver;
    const merged = existing ?? attempt;
    if (!wasConclusive && conclusiveAttempt(merged)) {
      if (merged.status === "implemented") {
        ledger.tried = Math.max(ledger.tried, (merged.candidateIndex ?? ledger.tried) + 1);
      } else if (merged.oracle !== undefined) {
        ledger.probes += 1;
      }
    }
    ledger.lastAt = attempt.at;
    ledger.lastCode = attempt.code;
    if (attempt.success) ledger.solved = true;
    host.attempts = ledger;
  }
}

/** Fold a completed or deferred ring read into the target-owned ledger. */
export function foldLogDrain(host: DnetHost | undefined, outcome: LogDrainOutcome | undefined): void {
  if (!host || host.goneAt !== undefined || outcome === undefined) return;
  const ring = host.ring ?? { pendingAuthRecords: 0 };
  ring.pendingAuthRecords = outcome.pendingAuthRecords;
  if (outcome.attemptedAt !== undefined) {
    ring.lastBleedAttemptAt = Math.max(ring.lastBleedAttemptAt ?? 0, outcome.attemptedAt);
  }
  if (outcome.drainedAt !== undefined) {
    ring.lastBleedAt = Math.max(ring.lastBleedAt ?? 0, outcome.drainedAt);
  }
  host.ring = ring;
  if (host.credentialKnown !== true && outcome.evidence.length > 0) {
    const ledger = host.attempts ?? { tried: 0, probes: 0 };
    const evidence = ledger.evidence ?? [];
    for (const item of outcome.evidence) {
      const key = JSON.stringify(item);
      if (!evidence.some((existing) => JSON.stringify(existing) === key)) evidence.push(item);
    }
    ledger.evidence = evidence;
    host.attempts = ledger;
  }
}

/** A verified credential makes cracking history dead weight. */
export function markCredentialKnown(host: DnetHost | undefined): void {
  if (!host || host.goneAt !== undefined) return;
  host.credentialKnown = true;
  delete host.attempts;
}

/** Deepest first; a host whose depth we cannot place sorts LAST.
 *
 * The planners all rank deepest-first — a deep host is the scarce vantage — and
 * each used to carry its own copy of this line. The sentinel sits BELOW the
 * floor because the comparison runs descending: an unsurveyed host must never
 * outrank one we can actually place. Callers keep their own tie-breaks. */
export function compareDepthDesc(a: number | undefined, b: number | undefined): number {
  return (b ?? Number.MIN_SAFE_INTEGER) - (a ?? Number.MIN_SAFE_INTEGER);
}

export interface ExpiryOpts {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  /** Hosts we hold a stasis link on.
   *
   *  Taken from the controller rather than from an observed fact, because we
   *  are the only thing that sets or releases a link: the controller knows the
   *  set exactly, while an observed copy is a worse source that can itself go
   *  stale. */
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
 * Immunity fixes the host's own lifetime and position. Its edge list still
 * ages: mutable neighbours can move, disconnect, appear or disappear without
 * the immune host itself being selected. Upstream marks `darkweb` and the
 * labyrinth stationary, and raises rather than move `darkweb` at all. */
export function isImmune(
  host: Pick<DnetHost, "hostname" | "isStationary"> | undefined,
  opts: ExpiryOpts = {},
): boolean {
  if (!host) return false;
  if (opts.stasisLinked?.has(host.hostname) === true) return true;
  return host.isStationary === true;
}

/** `opts` narrowed to one host, computed once so the per-group calls below do
 * not each redo it. */
function hostExpiry(
  host: Pick<DnetHost, "hostname" | "isStationary"> | undefined,
  opts: ExpiryOpts,
): ExpiryOpts {
  if (opts.immune !== undefined) return opts;
  return { ...opts, immune: isImmune(host, opts) };
}

/** How long a group of fields stays believable without a fresh observation.
 *
 * Derived, not chosen: `msPerHostEvent` gives the expected time before a
 * mutation touches one named host in the relevant way, and we distrust a value
 * at a fraction of that. Identity fields never expire with age — only with the
 * host's disappearance. Immunity freezes position; topology still ages because
 * neighbours remain mutable.
 *
 * This age fallback exists ALONGSIDE the dirty bits: dirty marks are prompt but
 * depend on the controller observing `nextMutation()` — a dead prober means
 * unobserved mutations, and pure dirty bits would then assert a rotting map
 * forever. Belt and braces. */
export function expiryMs(group: DirtyGroup | "identity", opts: ExpiryOpts = {}): number {
  const { netDepth, bitNode, backdoored, immune } = opts;
  const anyOf = (kinds: Parameters<typeof msPerHostEventAny>[0]): number =>
    msPerHostEventAny(kinds, netDepth, bitNode, backdoored);
  switch (group) {
    case "identity":
      return Infinity;
    case "position":
      return immune === true ? Infinity : anyOf(["moved"]) * TRUST_FRACTION;
    case "topology":
      // A move, a disconnect and a new connection each invalidate an edge list,
      // so their rates compound — edges are strictly shorter-lived than position.
      return anyOf(["moved", "disconnected", "connected"]) * TRUST_FRACTION;
    case "ram":
    case "files":
      return Infinity;
  }
}

/** We distrust a value well before the expected event, because the expected
 * time is a mean over a memoryless-ish process, not a guarantee. A third is a
 * judgement call and the one number here that is not derived; it is stated
 * plainly rather than hidden inside the expiry function. */
export const TRUST_FRACTION = 1 / 3;

export interface Staleness {
  ageMs: number;
  expiresInMs: number;
  stale: boolean;
}

/** Age report for one group, for callers that explain rather than decide. */
export function groupStaleness(
  host: DnetHost | undefined,
  group: DirtyGroup,
  now: number,
  opts: ExpiryOpts = {},
): Staleness | undefined {
  const at = host?.seenAt[group];
  if (host === undefined || at === undefined) return undefined;
  const limit = expiryMs(group, hostExpiry(host, opts));
  const ageMs = Math.max(0, now - at);
  return {
    ageMs,
    expiresInMs: limit === Infinity ? Infinity : Math.max(0, limit - ageMs),
    stale: host.dirty[group] === true || ageMs > limit,
  };
}

/** True when a group is believable: observed, not dirty, and inside its age
 * fallback. A gone host believes nothing. */
export function groupFresh(
  host: DnetHost | undefined,
  group: DirtyGroup,
  now: number,
  opts: ExpiryOpts = {},
): boolean {
  if (!host || host.goneAt !== undefined) return false;
  if (host.dirty[group] === true) return false;
  const state = groupStaleness(host, group, now, opts);
  return state !== undefined && !state.stale;
}

/** Read one field only while its group is still believable. Returning undefined
 * for a stale field is deliberate: a caller that wants the value anyway (to
 * render it, to explain a refusal) reads the record directly and says so. */
export function fresh<T>(
  host: DnetHost | undefined,
  key: string,
  now: number,
  opts: ExpiryOpts = {},
): T | undefined {
  if (!host || host.goneAt !== undefined) return undefined;
  const group = fieldGroup(key);
  if (group === undefined) return undefined;
  const value = (host as unknown as Record<string, unknown>)[key] as T | undefined;
  if (group === "identity") return value;
  return groupFresh(host, group, now, opts) ? value : undefined;
}

/** Shallow copy with every non-fresh group's fields removed, so planners can
 * branch on `!== undefined` and stale reads as unknown. Identity fields and the
 * ours-fields survive; a gone host keeps only its lifecycle stamps. */
export function planningView(host: DnetHost, now: number, opts: ExpiryOpts = {}): DnetHost {
  const view: DnetHost = { ...host };
  const expiry = hostExpiry(host, opts);
  const strip = (group: DirtyGroup) => {
    for (const key of GROUP_FIELDS[group]) delete (view as unknown as Record<string, unknown>)[key];
  };
  if (host.goneAt !== undefined) {
    for (const group of DIRTY_GROUPS) strip(group);
    for (const key of IDENTITY_FIELDS) delete (view as unknown as Record<string, unknown>)[key];
    return view;
  }
  for (const group of DIRTY_GROUPS) {
    if (!groupFresh(host, group, now, expiry)) strip(group);
  }
  return view;
}

export interface FoldOutcome {
  /** Group observations that lost to a newer observation of the same group. */
  superseded: number;
  hostsForgotten: string[];
  hostsReplaced: string[];
}

/** Merge reported hosts into the map, IN PLACE.
 *
 * In place because the map is the live global: runtime handles (agents,
 * probers, staged orders) hang off the same entries, and replacing objects
 * would orphan them. One rule does the work: groups merge by OBSERVATION time,
 * never by arrival order. A drain hands over a batch whose residents ran at
 * different moments, and two residents adjacent to the same host will both
 * describe it.
 *
 * Generation is deliberately NOT rechecked here. It is enforced once, on the
 * whole rendezvous, by the liveness check and by the drain: agents outlive
 * controllers, so what has to be refused is the channel, not the record. */
export function foldReports(
  hosts: DnetHosts,
  reports: readonly ReportHost[],
  now: number,
  opts: ExpiryOpts = {},
): FoldOutcome {
  let superseded = 0;
  const hostsReplaced: string[] = [];

  for (const seen of reports) {
    const { hostname, identity, present, at } = seen;
    // A clock we do not control can hand us the future; treat it as now.
    const observedAt = Math.min(at, now);
    let host = hosts.get(hostname);
    const staleIdentity = present && identity !== undefined
      && host?.identity !== undefined && host.identity !== identity
      && observedAt < host.lastSeenAt;
    if (staleIdentity) {
      superseded++;
      continue;
    }
    const replaced = present && identity !== undefined
      && host?.identity !== undefined && host.identity !== identity
      && observedAt >= host.lastSeenAt;
    if (replaced && host) {
      // A new ip is a new server wearing an old name. Reset the knowledge
      // fields on the SAME object so runtime fields survive for the controller
      // to reconcile; everything the dead lifetime knew dies here.
      hostsReplaced.push(hostname);
      resetLifetime(host);
      host.identity = identity;
      host.lastSeenAt = observedAt;
    }
    if (!host) {
      host = emptyHost(hostname, observedAt);
      if (identity !== undefined) host.identity = identity;
      hosts.set(hostname, host);
    }
    if (identity !== undefined && host.identity === undefined) host.identity = identity;
    if (observedAt >= host.lastSeenAt) host.lastSeenAt = observedAt;

    if (!present) {
      // Absence is itself an observation, and a newer one wins. A host that
      // comes back is a different host with a different password, so its
      // identity fields must not survive the gap.
      if (observedAt >= host.lastSeenAt && (host.goneAt === undefined || observedAt > host.goneAt)) {
        resetLifetime(host);
        host.goneAt = observedAt;
      }
      continue;
    }
    // Seeing it present is newer evidence than the note that it was gone.
    if (host.goneAt !== undefined && observedAt >= host.goneAt) delete host.goneAt;

    const record = host as unknown as Record<string, unknown>;
    const carries = (keys: readonly string[]) =>
      keys.some((key) => (seen as unknown as Record<string, unknown>)[key] !== undefined);
    if (carries(IDENTITY_FIELDS)) {
      if (host.identitySeenAt !== undefined && host.identitySeenAt > observedAt) {
        superseded++;
      } else {
        if (host.identitySeenAt !== undefined) superseded++;
        for (const key of IDENTITY_FIELDS) {
          const value = (seen as unknown as Record<string, unknown>)[key];
          if (value !== undefined) record[key] = value;
        }
        host.identitySeenAt = observedAt;
      }
    }
    for (const group of DIRTY_GROUPS) {
      if (!carries(GROUP_FIELDS[group])) continue;
      const prior = host.seenAt[group];
      if (prior !== undefined && prior > observedAt) {
        superseded++;
        continue;
      }
      if (prior !== undefined) superseded++;
      for (const key of GROUP_FIELDS[group]) {
        const value = (seen as unknown as Record<string, unknown>)[key];
        if (value !== undefined) record[key] = value;
      }
      host.seenAt[group] = observedAt;
      delete host.dirty[group];
    }
    for (const group of seen.invalidates ?? []) host.dirty[group] = true;
  }

  // A deleted identity can disappear from the graph and later be reused.
  // Forget absent movable hosts so published knowledge describes the live net;
  // stationary hosts cannot be deleted and therefore remain known.
  const hostsForgotten: string[] = [];
  for (const [name, host] of hosts) {
    const reference = host.goneAt ?? host.lastSeenAt;
    if (now - reference > forgetMs(hostExpiry(host, opts)) && !isImmune(host, opts)) {
      hostsForgotten.push(name);
      hosts.delete(name);
    }
  }

  return { superseded, hostsForgotten, hostsReplaced };
}

/** Home-side adapter around the same in-place fold the controller uses. */
export function foldKnowledgeReports(
  knowledge: DnetKnowledge,
  reports: readonly ReportHost[],
  now: number,
  opts: ExpiryOpts = {},
): FoldOutcome & { knowledge: DnetKnowledge } {
  return { knowledge, ...foldReports(knowledge.hosts, reports, now, opts) };
}

/** Drop everything that belongs to one server lifetime: identity fields, group
 * fields and stamps, and the ours-fields — the cracking progress goes with the
 * identity because a host that comes back is CLEANED and given a new password
 * upstream, so a ledger saying "the first 40 candidates are ruled out" would be
 * ruling out candidates for a password that no longer exists. */
function resetLifetime(host: DnetHost): void {
  const record = host as unknown as Record<string, unknown>;
  for (const key of IDENTITY_FIELDS) delete record[key];
  for (const group of DIRTY_GROUPS) for (const key of GROUP_FIELDS[group]) delete record[key];
  host.seenAt = {};
  host.dirty = {};
  delete host.identitySeenAt;
  delete host.identity;
  delete host.goneAt;
  delete host.attempts;
  delete host.ring;
  delete host.credentialKnown;
  delete host.lastPlantAt;
}

/** A host unseen for this long is dropped. Scaled off deletion rather than
 * movement: the question "is it gone" is answered by the deletion clock — and
 * an immune host is never deleted, so it is never forgotten either. */
export function forgetMs(opts: ExpiryOpts = {}): number {
  if (opts.immune === true) return Infinity;
  return msPerHostEvent("deleted", opts.netDepth, opts.bitNode, opts.backdoored);
}

/** What a webstorm invalidates, applied the moment the burst is believed over.
 *
 * A storm is the one event whose scope we know at the instant it happens —
 * because we fired it. Waiting for the ordinary expiries would leave the map
 * asserting positions, edges and free RAM for a net that was just rerolled, and
 * every derivation in the quiet minutes after would plan against ghosts.
 *
 * One function, shared by the controller and home's fold, because the two must
 * not disagree about what a storm destroys. The rule is upstream's own victim
 * pool: everything OUTSIDE `isStationary`/stasis can be deleted, moved and
 * restarted, so a non-immune host keeps only what survives all three — its
 * IDENTITY fields (a survivor's are still true; a deleted host's die by the
 * ordinary goneAt path when re-surveys report it missing) and its credential
 * (restart and move change no password; only a delete retires an identity, and
 * that path clears the vault entry elsewhere). Position, topology and file/ram
 * fields are dropped outright, and the log ring goes with them — a restart
 * resets the server's logs, so a pending-records count would send a bleed to
 * drain records that no longer exist. Immune hosts keep everything: the storm
 * cannot touch them, which is the entire reason stasis links are spent first.
 *
 * Pure — the input map is untouched — so a caller replaying history can diff
 * before against after. The controller swaps its live map's CONTENTS from the
 * result to keep the global's identity. */
export function stormWipe(hosts: DnetHosts, opts: ExpiryOpts = {}): DnetHosts {
  const out: DnetHosts = new Map();
  for (const [name, host] of hosts) {
    if (isImmune(host, opts)) {
      out.set(name, host);
      continue;
    }
    const wiped: DnetHost = { ...host, seenAt: {}, dirty: {} };
    const record = wiped as unknown as Record<string, unknown>;
    for (const group of DIRTY_GROUPS) {
      for (const key of GROUP_FIELDS[group]) delete record[key];
      wiped.dirty[group] = true;
    }
    delete wiped.ring;
    delete wiped.lastPlantAt;
    delete wiped.agentAlive;
    delete wiped.jobFreeGb;
    delete wiped.busy;
    out.set(name, wiped);
  }
  return out;
}

export interface KnowledgeCoverage {
  known: number;
  /** Hosts whose neighbour list we hold and still believe. */
  adjacencyKnown: number;
  /** Share of held groups that are still believable. */
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
  hosts: DnetHosts,
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
  for (const host of hosts.values()) {
    if (host.goneAt !== undefined) {
      gone++;
      continue;
    }
    const expiry = hostExpiry(host, opts);
    if (fresh<string[]>(host, "neighbours", now, expiry) !== undefined) adjacencyKnown++;
    if (host.credentialKnown === true) {
      cracked++;
      if (usableRam(host, now, expiry) >= agentRamGb) plantable++;
    }
    if (host.identitySeenAt !== undefined) total++;
    for (const group of DIRTY_GROUPS) {
      if (host.seenAt[group] === undefined) continue;
      total++;
      if (!groupFresh(host, group, now, expiry)) stale++;
    }
  }
  return {
    known: hosts.size - gone,
    adjacencyKnown,
    freshFraction: total === 0 ? 0 : (total - stale) / total,
    gone,
    cracked,
    plantable,
  };
}

export function knowledgeCoverage(
  knowledge: DnetKnowledge,
  now: number,
  opts: ExpiryOpts = {},
  agentRamGb = 2.6,
): KnowledgeCoverage {
  return coverage(knowledge.hosts, now, opts, agentRamGb);
}

/** Script capacity after the owner's durable RAM block. Runtime occupancy is
 * deliberately excluded: it changes as our known handles start and stop and
 * therefore is not durable host knowledge. */
export function usableRam(
  host: DnetHost | undefined,
  now: number,
  opts: ExpiryOpts = {},
): number {
  if (!host || host.goneAt !== undefined) return 0;
  const expiry = hostExpiry(host, opts);
  const maxRam = host.maxRam;
  if (maxRam === undefined) return 0;
  if (!groupFresh(host, "ram", now, expiry)) return 0;
  const blocked = host.blockedRam ?? 0;
  return Math.max(0, maxRam - blocked);
}

export function stormWipeKnowledge(knowledge: DnetKnowledge, opts: ExpiryOpts = {}): DnetKnowledge {
  return { ...knowledge, hosts: stormWipe(knowledge.hosts, opts) };
}

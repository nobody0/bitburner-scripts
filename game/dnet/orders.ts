import type { NS } from "@ns";
import { LOCAL_CODE, type ReportHost } from "../../shared/strategy/dnet/courier.ts";
import { isDarknetDataFile, parseDarknetFileClue } from "../../shared/strategy/dnet/file-clues.ts";
import { harvestLogs } from "../../shared/strategy/dnet/oracle.ts";
import { grammarDrift, LOG_LINES, targetStateFor } from "./report-shared.ts";
import { handoffLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch, DnetProberLaunch } from "./launch.ts";
import {
  KIND_CALLS,
  live,
  orderCalls,
  priceCalls,
  proberReserveGb,
  type AgentIo,
  type ControllerDeps,
  type Order,
  type Report,
} from "./shared.ts";
import { runAttempt } from "./attempt.ts";
import { awaitDnetOperation } from "./timing.ts";
import { runWalk } from "./walk.ts";
import { cacheProfit, phishProfit, promotionProfit } from "./profit.ts";

/** What every order body DOES, dispatched by a `switch` in the AGENT's process.
 *
 * These were closures the old controller shipped through the realm; now they are
 * direct `ns.*` calls the agent makes itself. The RAM is controlled purely by
 * the `ramOverride` the controller sized for each kind — the static analyser is
 * bypassed at spawn — so the only thing that matters is that a kind's dynamic
 * surface stays inside `KIND_CALLS[kind]`. Bracket notation everywhere so an
 * accidental dot-reference cannot smuggle a member past that budget. Regexes
 * are safe, but a method call named `exec` is not: the static analyser mistakes
 * `RegExp.exec` for the 1.3 GB Netscript member. */

type OrderResult = Omit<Report, "id" | "kind" | "host" | "from">;

const STORM_SEED_FILE = "STORM_SEED.exe";

/** Everything one `ls` teaches about a darknet host, in one call. */
function listingOn(jobNs: NS, host: string, deps: ControllerDeps): { caches: string[]; contracts: string[]; stormSeed: boolean } {
  const names = jobNs["ls"](host);
  const at = Date.now();
  for (const name of names) {
    if (isDarknetDataFile(name)) {
      const clue = parseDarknetFileClue(jobNs["read"](name), at);
      if (clue?.kind === "named-password") {
        deps.recordProvisional({ hostname: clue.hostname, password: clue.password, via: "data-file", at });
      } else if (clue?.kind === "neighbour-password") {
        deps.recordNeighbourPassword(host, clue.password, at);
      } else if (clue?.kind === "evidence") {
        deps.recordFileEvidence(clue.hostname, clue.evidence);
      }
      jobNs["rm"](name, host);
    } else if (name.endsWith(".lit")) {
      jobNs["rm"](name, host);
    }
  }
  return {
    caches: names.filter((name) => name.endsWith(".cache")),
    contracts: names.filter((name) => name.endsWith(".cct")),
    stormSeed: names.includes(STORM_SEED_FILE),
  };
}

/** One host, as the caller can see it from where it is standing. */
function describeHost(jobNs: NS, host: string, deps: ControllerDeps, withListing = false, withIdentity = false): ReportHost {
  const at = Date.now();
  const details = jobNs["dnet"]["getServerDetails"](host);
  if (!details.isOnline) return { hostname: host, at, present: false };
  return {
    hostname: host,
    ...(withIdentity ? { identity: jobNs["dnsLookup"](host) } : {}),
    at,
    present: true,
    depth: details.depth,
    blockedRam: details.blockedRam,
    requiredCharisma: details.requiredCharismaSkill,
    difficulty: details.difficulty,
    isStationary: details.isStationary,
    modelId: details.modelId,
    passwordLength: details.passwordLength,
    passwordFormat: details.passwordFormat,
    passwordHint: details.passwordHint,
    data: details.data,
    logTrafficInterval: details.logTrafficInterval,
    ...(withListing ? listingOn(jobNs, host, deps) : {}),
  };
}

// --- inventory ---------------------------------------------------------------

async function inventoryOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  return { ok: true, hosts: [describeHost(jobNs, order.from, io.deps, true, true)], detail: "listed" };
}

// --- bleed -------------------------------------------------------------------

async function bleedOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const jobCodes: Record<string, number> = {};
  if (order.followAttemptIds !== undefined) {
    await live()?.afterOrders(order.followAttemptIds);
    if (io.cancelled() !== undefined) {
      return { ok: false, targetState: "cancelled", detail: io.cancelled() };
    }
  }
  const attemptedAt = Date.now();
  const bled = await awaitDnetOperation(io, {
    operation: "heartbleed", host: order.host, from: order.from, threads: order.jobThreads ?? order.threads,
  }, () => jobNs["dnet"]["heartbleed"](order.host, { peek: false, logsToCapture: LOG_LINES }));
  jobCodes[String(bled.code)] = 1;
  if (!bled.success) {
    deps.recordLogDrain(order.host, {
      pendingAuthRecords: deps.ringFor(order.host)?.pendingAuthRecords ?? 0,
      evidence: [],
      attemptedAt,
    });
    return { ok: false, codes: jobCodes, ...targetStateFor(bled.code), hosts: [describeHost(jobNs, order.host, deps)], detail: bled.message };
  }
  const at = Date.now();
  const harvest = harvestLogs(bled.logs, { bledFrom: order.host, knownHosts: order.knownHosts ?? [order.host], at });
  for (const found of harvest.credentials) deps.recordProvisional({ hostname: found.host, password: found.password, via: found.via, at });
  for (const password of harvest.loose) deps.recordLoose(password);
  const drift = grammarDrift(harvest.unrecognised);
  deps.recordLogDrain(order.host, { pendingAuthRecords: 0, evidence: harvest.evidence, attemptedAt, drainedAt: at });
  return {
    ok: true,
    codes: jobCodes,
    hosts: [describeHost(jobNs, order.host, deps)],
    ...(drift ? { grammar: drift } : {}),
    detail: `${harvest.credentials.length} named candidates, ${harvest.loose.length} unattributed,`
      + ` ${harvest.unrecognised.length} unrecognised lines`,
  };
}

// --- plant -------------------------------------------------------------------

async function plantOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const jobCodes: Record<string, number> = {};
  if (order.password === undefined) {
    return { ok: false, codes: { [LOCAL_CODE.NoCredential]: 1 }, detail: "no credential" };
  }
  const diagnose = (detail: string, fallback: "credential-rejected" | "launch-refused"): OrderResult => {
    const details = jobNs["dnet"]["getServerDetails"](order.host);
    const identity = jobNs["dnsLookup"](order.host);
    const observed: ReportHost = details.isOnline && identity.length > 0
      ? { hostname: order.host, identity, at: Date.now(), present: true }
      : { hostname: order.host, at: Date.now(), present: false };
    if (!observed.present) return { ok: false, targetState: "gone", hosts: [observed], codes: jobCodes, detail };
    if (order.targetIdentity !== undefined && observed.identity !== undefined && order.targetIdentity !== observed.identity) {
      return { ok: false, targetState: "replaced", hosts: [observed], codes: jobCodes, detail };
    }
    return { ok: false, targetState: fallback, hosts: [observed], codes: jobCodes, detail };
  };
  let session = jobNs["dnet"]["connectToSession"](order.host, order.password);
  let filesDirty = false;
  jobCodes[String(session.code)] = (jobCodes[String(session.code)] ?? 0) + 1;
  if (!session.success && order.sessionOnly) {
    if (session.code === 401) {
      jobCodes[LOCAL_CODE.CredentialRejected] = 1;
      return diagnose(session.message, "credential-rejected");
    }
    return { ok: false, codes: jobCodes, ...targetStateFor(session.code), detail: session.message };
  } else if (!session.success) {
    session = await awaitDnetOperation(io, {
      operation: "authenticate", host: order.host, from: order.from, threads: order.jobThreads ?? order.threads,
    }, () => jobNs["dnet"]["authenticate"](order.host, order.password!));
    filesDirty = session.success;
    jobCodes[String(session.code)] = (jobCodes[String(session.code)] ?? 0) + 1;
  }
  if (!session.success) {
    if (session.code === 401) {
      jobCodes[LOCAL_CODE.CredentialRejected] = 1;
      return diagnose(session.message, "credential-rejected");
    }
    return { ok: false, codes: jobCodes, ...targetStateFor(session.code), detail: session.message };
  }
  if (!jobNs["scp"](order.payloads ?? [], order.host, order.from)) {
    jobCodes[LOCAL_CODE.LaunchRefused] = 1;
    return diagnose("scp refused", "launch-refused");
  }
  if (order.bootstrapReclaim === true) {
    const threads = Math.max(1, order.bootstrapThreads ?? 1);
    const pid = await handoffLaunch<DnetAgentLaunch>(
      { kind: "dnet-agent", host: order.host, bootstrapReclaim: true },
      (launchId) => jobNs["exec"](
        (order.payloads ?? [])[0]!,
        order.host,
        temporaryRunOptions({ threads, ramOverride: priceCalls(jobNs, KIND_CALLS.bootstrapReclaim) }),
        launchId,
      ),
    );
    if (pid === 0) {
      jobCodes[LOCAL_CODE.LaunchRefused] = 1;
      return diagnose("exec refused while launching local reclaim", "launch-refused");
    }
    live()?.registerBootstrap(order.host, pid);
    return {
      ok: true,
      codes: jobCodes,
      hosts: [{ ...describeHost(jobNs, order.host, deps), ...(filesDirty ? { invalidates: ["files" as const] } : {}) }],
      detail: `local reclaim pid ${pid}, ${threads} thread${threads === 1 ? "" : "s"}`,
    };
  }
  const proberFile = (order.payloads ?? [])[1];
  const controller = live();
  // Claim the queued successor before sizing the exec. Stasis-linked targets
  // are remotely recoverable, and may already own the ordinary constant probe.
  const prepared = controller?.preparePlant(order.host) ?? {
    controllerManaged: order.targetControllerManaged === true,
    reuseProber: false,
  };
  const omitProber = order.omitProber === true || prepared.reuseProber;
  const claim = omitProber ? undefined : controller?.beginProbeRefresh(order.host);
  const proberPid = omitProber
    ? -1
    : proberFile === undefined || controller === undefined || claim === undefined
      ? 0
      : claim.launch
        ? await handoffLaunch<DnetProberLaunch>(
          { kind: "dnet-prober", host: order.host, refresh: claim.refresh },
          (launchId) => jobNs["exec"](proberFile, order.host, temporaryRunOptions({ threads: 1, ramOverride: proberReserveGb(jobNs) }), launchId),
        )
        : -1;
  if (proberPid === 0) {
    if (claim !== undefined) controller?.cancelProbeRefresh(order.host, claim.refresh);
    jobCodes[LOCAL_CODE.LaunchRefused] = 1;
    return diagnose("exec refused while launching the reserved prober", "launch-refused");
  }
  if (claim !== undefined && await claim.refresh.refreshed === undefined) {
    jobCodes[LOCAL_CODE.LaunchRefused] = 1;
    return diagnose("reserved prober refresh was cancelled", "launch-refused");
  }
  const next = prepared.next;
  const agentThreads = next?.threads ?? 1;
  const agentRam = next?.ramOverrideGb
    ?? priceCalls(jobNs, orderCalls("idle", prepared.controllerManaged));
  const pid = await handoffLaunch<DnetAgentLaunch>(
    {
      kind: "dnet-agent",
      host: order.host,
      ...(prepared.controllerManaged ? { controllerManaged: true } : {}),
    },
    (launchId) => jobNs["exec"](
      (order.payloads ?? [])[0]!,
      order.host,
      temporaryRunOptions({ threads: agentThreads, ramOverride: agentRam }),
      launchId,
    ),
  );
  if (pid === 0) {
    if (proberPid > 0) jobNs["kill"](proberPid);
    jobCodes[LOCAL_CODE.LaunchRefused] = 1;
    return diagnose("exec refused while launching the resident", "launch-refused");
  }
  return {
    ok: true,
    codes: jobCodes,
    hosts: [{ ...describeHost(jobNs, order.host, deps), ...(filesDirty ? { invalidates: ["files" as const] } : {}) }],
    detail: order.omitProber === true
      ? `resident pid ${pid}, prober reserved for lab walk`
      : prepared.reuseProber
        ? `resident pid ${pid}, surviving prober reused`
        : `resident pid ${pid}, prober pid ${proberPid}`,
  };
}

// --- reclaim -----------------------------------------------------------------

async function reclaimOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => { jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1; };
  const freed = await awaitDnetOperation(io, {
    operation: "memoryReallocation", host: order.host, from: order.from, threads: order.jobThreads ?? order.threads,
  }, () => jobNs["dnet"]["memoryReallocation"](order.host));
  count(freed.code);
  const report = describeHost(jobNs, order.host, deps);
  const cleared = freed.code === 454 || (report.present === true && report.blockedRam !== undefined && report.blockedRam <= 0);
  const resized = !cleared && freed.success && order.resizeAtBlockedRam !== undefined
    && report.present === true && report.blockedRam !== undefined && report.blockedRam <= order.resizeAtBlockedRam;
  return {
    ok: freed.success || cleared,
    codes: jobCodes,
    hosts: [{ ...report, ...(cleared ? { invalidates: ["files" as const] } : {}) }],
    detail: cleared
      ? `${order.host}: block cleared`
      : resized
        ? `${order.host}: opened another worker thread`
        : `${order.host}: ${freed.message}`,
  };
}

// --- phish -------------------------------------------------------------------

async function phishOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => { jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1; };
  const phished = await awaitDnetOperation(io, {
    operation: "phishingAttack", host: order.host, from: order.from, threads: order.jobThreads ?? order.threads,
  }, () => jobNs["dnet"]["phishingAttack"]());
  count(phished.code);
  const wonCache = phished.success && phished.message.includes("Found a cache file");
  if (wonCache) count(LOCAL_CODE.PhishingCacheWon);
  return {
    ok: phished.success,
    profit: phishProfit(phished.message, phished.success),
    codes: jobCodes,
    hosts: [{ ...describeHost(jobNs, order.host, deps), ...(wonCache ? { invalidates: ["files" as const] } : {}) }],
    detail: wonCache ? "one phish claimed the cache window" : `one phish: ${phished.message}`,
  };
}

// --- cache -------------------------------------------------------------------

async function cacheOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const wanted = order.filename;
  if (wanted === undefined) {
    return { ok: false, codes: { [LOCAL_CODE.NoCredential]: 1 }, detail: "no cache filename; a job never invents one" };
  }
  const heldListing = listingOn(jobNs, order.host, deps);
  if (!heldListing.caches.includes(wanted)) {
    return {
      ok: false,
      codes: { "404": 1 },
      hosts: [{ ...describeHost(jobNs, order.host, deps, false, true), ...heldListing }],
      detail: `${wanted} is no longer on ${order.host}`,
    };
  }
  let opened: { success: boolean; message: string; karmaLoss: number };
  try {
    opened = jobNs["dnet"]["openCache"](wanted, true);
  } catch (error) {
    return {
      ok: false,
      codes: { "404": 1 },
      hosts: [{ ...describeHost(jobNs, order.host, deps, false, true), ...listingOn(jobNs, order.host, deps) }],
      detail: `openCache threw on ${wanted}: ${String(error)}`.slice(0, 200),
    };
  }
  return {
    ok: opened.success,
    codes: { [String(opened.success ? 200 : 404)]: 1 },
    ...(opened.success ? { karmaLoss: opened.karmaLoss } : {}),
    ...(opened.success ? { profit: cacheProfit(opened.message) } : {}),
    hosts: [{ ...describeHost(jobNs, order.host, deps, false, true), ...listingOn(jobNs, order.host, deps) }],
    detail: opened.message.slice(0, 200),
  };
}

// --- promote -----------------------------------------------------------------

async function promoteOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const symbol = order.symbol;
  if (symbol === undefined) {
    return { ok: false, codes: { [LOCAL_CODE.NoCredential]: 1 }, detail: "no symbol; a job never invents one" };
  }
  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => { jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1; };
  const spread = await awaitDnetOperation(io, {
    operation: "promoteStock", host: order.host, from: order.from, threads: order.jobThreads ?? order.threads,
  }, () => jobNs["dnet"]["promoteStock"](symbol));
  count(spread.code);
  return {
    ok: spread.success,
    profit: promotionProfit(symbol, order.jobThreads ?? order.threads, spread.success),
    codes: jobCodes,
    hosts: [describeHost(jobNs, order.host, deps)],
    detail: `one promotion of ${symbol}: ${spread.message}`,
  };
}

// --- induce ------------------------------------------------------------------

async function induceOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => { jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1; };
  const before = jobNs["dnet"]["getServerDetails"](order.host);
  const cancellation = io.cancelled();
  if (cancellation !== undefined) {
    return { ok: false, targetState: "cancelled", codes: jobCodes, detail: `${order.host}: ${cancellation}` };
  }
  const pushed = await awaitDnetOperation(io, {
    operation: "induceServerMigration", host: order.host, from: order.from, threads: order.jobThreads ?? order.threads,
  }, () => jobNs["dnet"]["induceServerMigration"](order.host));
  count(pushed.code);
  const after = describeHost(jobNs, order.host, deps);
  const moved = before.isOnline && after.present === true && after.depth !== before.depth;
  return {
    ok: pushed.success,
    codes: jobCodes,
    ...targetStateFor(pushed.code),
    hosts: [after],
    detail: moved
      ? `${order.host} migrated from depth ${before.depth} to ${after.depth}`
      : `one migration charge against ${order.host}; ${pushed.message}`,
  };
}

// --- pin ---------------------------------------------------------------------

async function pinOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  if (order.unpin === true) {
    const released = await awaitDnetOperation(io, {
      operation: "setStasisLink", host: order.host, from: order.from, threads: order.threads, shouldLink: false,
    }, () => jobNs["dnet"]["setStasisLink"](false));
    return {
      ok: released.success,
      codes: { [String(released.code)]: 1 },
      hosts: [describeHost(jobNs, order.host, deps)],
      detail: released.success ? `${order.host}: link released, slot freed` : `${order.host}: ${released.message}`,
    };
  }
  if (order.edge !== undefined && !jobNs["dnet"]["probe"]().includes(order.edge)) {
    return {
      ok: false,
      codes: { [String(LOCAL_CODE.EdgeGone)]: 1 },
      hosts: [describeHost(jobNs, order.host, deps)],
      detail: `${order.host}: the edge to ${order.edge} is severed; the link was NOT spent`,
    };
  }
  const pinned = await awaitDnetOperation(io, {
    operation: "setStasisLink", host: order.host, from: order.from, threads: order.threads, shouldLink: true,
  }, () => jobNs["dnet"]["setStasisLink"](true));
  return {
    ok: pinned.success,
    codes: { [String(pinned.code)]: 1 },
    hosts: [describeHost(jobNs, order.host, deps)],
    detail: pinned.success ? `${order.host} is pinned` : `${order.host}: ${pinned.message}`,
  };
}

// --- storm -------------------------------------------------------------------

async function stormOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const listing = listingOn(jobNs, order.host, deps);
  if (!listing.stormSeed) {
    return {
      ok: false,
      codes: { "404": 1 },
      hosts: [{ ...describeHost(jobNs, order.host, deps), ...listing }],
      detail: `${STORM_SEED_FILE} is no longer on ${order.host}`,
    };
  }
  const fired = jobNs["dnet"]["unleashStormSeed"]();
  return {
    ok: fired.success,
    codes: { [String(fired.code)]: 1 },
    ...(fired.success ? { stormFiredAt: Date.now() } : {}),
    detail: fired.message.slice(0, 200),
  };
}

// --- relaunchProbe -----------------------------------------------------------

async function relaunchProbeOrder(jobNs: NS, order: Order): Promise<OrderResult> {
  const proberFile = order.filename;
  if (proberFile === undefined) return { ok: false, codes: {}, detail: "no prober file on the order" };
  // `exec` only proves that the process was admitted. Until its first probe is
  // stored, the controller still sees the old stale stamp and can derive a
  // second relaunch on the very next agent handoff. Keep this order active
  // until the replacement has claimed the host entry, exactly as plant does.
  const controller = live();
  if (controller === undefined) return { ok: false, codes: {}, detail: "controller unavailable while repairing prober" };
  const claim = controller.beginProbeRefresh(order.host);
  const pid = claim.launch
    ? await handoffLaunch<DnetProberLaunch>(
      { kind: "dnet-prober", host: order.host, refresh: claim.refresh },
      (launchId) => jobNs["exec"](proberFile, order.host, temporaryRunOptions({ threads: 1, ramOverride: proberReserveGb(jobNs) }), launchId),
    )
    : -1;
  if (pid === 0) controller.cancelProbeRefresh(order.host, claim.refresh);
  const report = pid !== 0 ? await claim.refresh.refreshed : undefined;
  const refreshed = report !== undefined;
  return {
    ok: refreshed,
    codes: refreshed ? {} : { [LOCAL_CODE.NotEnoughRam]: 1 },
    detail: !refreshed ? "prober exec refused or refresh cancelled" : pid < 0 ? "prober refresh already in flight" : `prober pid ${pid}`,
  };
}

/** The switch. An unknown kind is a programming error, not a silent no-op. */
export function runOrder(ns: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  switch (order.kind) {
    case "attempt": return runAttempt(ns, order, io);
    case "walk": return runWalk(ns, order, io);
    case "inventory": return inventoryOrder(ns, order, io);
    case "bleed": return bleedOrder(ns, order, io);
    case "plant": return plantOrder(ns, order, io);
    case "reclaim": return reclaimOrder(ns, order, io);
    case "phish": return phishOrder(ns, order, io);
    case "cache": return cacheOrder(ns, order, io);
    case "promote": return promoteOrder(ns, order, io);
    case "induce": return induceOrder(ns, order, io);
    case "pin": return pinOrder(ns, order, io);
    case "storm": return stormOrder(ns, order, io);
    case "relaunchProbe": return relaunchProbeOrder(ns, order);
    case "idle":
    case "bootstrapReclaim":
      return Promise.resolve({ ok: false, detail: `${order.kind} is not run through the order switch` });
  }
}

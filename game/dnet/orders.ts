import type { NS } from "@ns";
import { LOCAL_CODE, type ReportHost } from "../../shared/strategy/dnet/courier.ts";
import { FARM_BATCH_MS, batchHasRoom } from "../../shared/strategy/dnet/farm.ts";
import { isDarknetDataFile, parseDarknetFileClue } from "../../shared/strategy/dnet/file-clues.ts";
import { harvestLogs, logShape } from "../../shared/strategy/dnet/oracle.ts";
import { SOLVER_CODES } from "../../shared/strategy/dnet/solvers/types.ts";
import { INDUCE_WAIT_MS } from "../../shared/strategy/dnet/rates.ts";
import { handoffLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch, DnetProberLaunch } from "./launch.ts";
import {
  KIND_CALLS,
  live,
  priceCalls,
  proberReserveGb,
  type AgentIo,
  type ControllerDeps,
  type Order,
  type Report,
} from "./shared.ts";
import { runAttempt } from "./attempt.ts";
import { runWalk } from "./walk.ts";

/** What every order body DOES, dispatched by a `switch` in the AGENT's process.
 *
 * These were closures the overseer shipped through the realm; now they are
 * direct `ns.*` calls the agent makes itself. The RAM is controlled purely by
 * the `ramOverride` the controller sized for each kind — the static analyser is
 * bypassed at spawn — so the only thing that matters is that a kind's dynamic
 * surface stays inside `KIND_CALLS[kind]`. Bracket notation everywhere so an
 * accidental dot-reference cannot smuggle a member past that budget, and never
 * a `RegExp` (`RegExp.prototype.exec` bills the full 1.3 GB of `ns.exec`). */

type OrderResult = Omit<Report, "id" | "kind" | "host" | "from">;

const LOG_LINES = 200;
const SHAPES_PER_JOB = 2;
const STORM_SEED_FILE = "STORM_SEED.exe";

function grammarDrift(unrecognised: readonly string[]): { unrecognised: number; shapes: string[] } | undefined {
  if (unrecognised.length === 0) return undefined;
  const shapes: string[] = [];
  for (const line of unrecognised) {
    const shape = logShape(line);
    if (shape.length > 0 && !shapes.includes(shape)) shapes.push(shape);
    if (shapes.length >= SHAPES_PER_JOB) break;
  }
  return { unrecognised: unrecognised.length, shapes };
}

function targetStateFor(code: number): Pick<Report, "targetState"> {
  if (code === 351) return { targetState: "edge-lost" };
  if (code === 503) return { targetState: "gone" };
  return {};
}

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
  const attemptedAt = Date.now();
  const bled = await jobNs["dnet"]["heartbleed"](order.host, { peek: false, logsToCapture: LOG_LINES });
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
  let dirtied = false;
  jobCodes[String(session.code)] = (jobCodes[String(session.code)] ?? 0) + 1;
  if (!session.success && order.sessionOnly) {
    if (session.code === 401) {
      jobCodes[LOCAL_CODE.CredentialRejected] = 1;
      return diagnose(session.message, "credential-rejected");
    }
    return { ok: false, codes: jobCodes, ...targetStateFor(session.code), detail: session.message };
  } else if (!session.success) {
    session = await jobNs["dnet"]["authenticate"](order.host, order.password);
    dirtied = session.success;
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
      () => jobNs["exec"](
        (order.payloads ?? [])[0]!,
        order.host,
        temporaryRunOptions({ threads, ramOverride: priceCalls(jobNs, KIND_CALLS.bootstrapReclaim) }),
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
      hosts: [describeHost(jobNs, order.host, deps)],
      ...(dirtied ? { dirtied: true } : {}),
      detail: `local reclaim pid ${pid}, ${threads} thread${threads === 1 ? "" : "s"}`,
    };
  }
  const proberFile = (order.payloads ?? [])[1];
  let firstProbe!: () => void;
  const firstProbeReported = new Promise<void>((resolve) => { firstProbe = resolve; });
  const proberPid = order.omitProber === true
    ? -1
    : proberFile === undefined ? 0 : await handoffLaunch<DnetProberLaunch>(
      { kind: "dnet-prober", host: order.host, firstReport: firstProbe },
      () => jobNs["exec"](proberFile, order.host, temporaryRunOptions({ threads: 1, ramOverride: proberReserveGb(jobNs) })),
    );
  if (proberPid === 0) {
    jobCodes[LOCAL_CODE.LaunchRefused] = 1;
    return diagnose("exec refused while launching the reserved prober", "launch-refused");
  }
  if (proberPid > 0) await firstProbeReported;
  live()?.preparePlant(order.host);
  const pid = await handoffLaunch<DnetAgentLaunch>(
    { kind: "dnet-agent", host: order.host },
    () => jobNs["exec"](
      (order.payloads ?? [])[0]!,
      order.host,
      temporaryRunOptions({ threads: 1, ramOverride: priceCalls(jobNs, KIND_CALLS.idle) }),
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
    hosts: [describeHost(jobNs, order.host, deps)],
    ...(dirtied ? { dirtied: true } : {}),
    detail: order.omitProber === true
      ? `resident pid ${pid}, prober reserved for lab walk`
      : `resident pid ${pid}, prober pid ${proberPid}`,
  };
}

// --- reclaim -----------------------------------------------------------------

async function reclaimOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => { jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1; };
  const startedAt = Date.now();
  let calls = 0;
  let cleared = false;
  let resized = false;
  for (;;) {
    if (!batchHasRoom("reclaim", startedAt, Date.now(), deps.charisma())) break;
    const freed = await jobNs["dnet"]["memoryReallocation"](order.host);
    count(freed.code);
    if (!freed.success) {
      cleared = freed.code === 454;
      break;
    }
    calls++;
    if (order.resizeAtBlockedRam !== undefined) {
      const details = jobNs["dnet"]["getServerDetails"](order.host);
      cleared = details.blockedRam <= 0;
      if (details.blockedRam <= order.resizeAtBlockedRam || cleared) {
        resized = !cleared;
        break;
      }
    }
  }
  const report = describeHost(jobNs, order.host, deps);
  cleared = cleared || (report.present === true && report.blockedRam !== undefined && report.blockedRam <= 0);
  return {
    ok: calls > 0 || cleared,
    codes: jobCodes,
    hosts: [report],
    ...(cleared ? { dirtied: true } : {}),
    detail: cleared
      ? `${order.host}: block cleared after ${calls} calls`
      : resized
        ? `${order.host}: ${calls} calls opened another worker thread`
        : `${calls} calls against ${order.host}'s block`,
  };
}

// --- phish -------------------------------------------------------------------

async function phishOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => { jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1; };
  const startedAt = Date.now();
  let calls = 0;
  let paid = 0;
  let wonCache = false;
  for (;;) {
    if (!batchHasRoom("phish", startedAt, Date.now(), deps.charisma())) break;
    const phished = await jobNs["dnet"]["phishingAttack"]();
    count(phished.code);
    calls++;
    if (phished.success) paid++;
    if (phished.success && phished.message.includes("Found a cache file")) {
      count(LOCAL_CODE.PhishingCacheWon);
      wonCache = true;
      break;
    }
  }
  return {
    ok: calls > 0,
    codes: jobCodes,
    hosts: [describeHost(jobNs, order.host, deps)],
    ...(wonCache ? { dirtied: true } : {}),
    detail: wonCache ? `${calls} phishes, one claimed the cache window` : `${calls} phishes, ${paid} paid`,
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
  const startedAt = Date.now();
  let calls = 0;
  for (;;) {
    if (!batchHasRoom("promote", startedAt, Date.now(), deps.charisma())) break;
    const spread = await jobNs["dnet"]["promoteStock"](symbol);
    count(spread.code);
    if (!spread.success) break;
    calls++;
  }
  return { ok: calls > 0, codes: jobCodes, hosts: [describeHost(jobNs, order.host, deps)], detail: `${calls} promotions of ${symbol}` };
}

// --- induce ------------------------------------------------------------------

async function induceOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => { jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1; };
  const before = jobNs["dnet"]["getServerDetails"](order.host);
  const startedAt = Date.now();
  let calls = 0;
  let stopped: { code: number; message: string } | undefined;
  for (;;) {
    const cancellation = io.cancelled();
    if (cancellation !== undefined) {
      return { ok: false, targetState: "cancelled", codes: jobCodes, detail: `${order.host}: ${cancellation}` };
    }
    if (Date.now() + INDUCE_WAIT_MS > startedAt + FARM_BATCH_MS) break;
    const pushed = await jobNs["dnet"]["induceServerMigration"](order.host);
    count(pushed.code);
    if (!pushed.success) {
      stopped = pushed;
      break;
    }
    calls++;
    io.beat({ calls });
  }
  const after = describeHost(jobNs, order.host, deps);
  const moved = before.isOnline && after.present === true && after.depth !== before.depth;
  return {
    ok: calls > 0,
    codes: jobCodes,
    ...(stopped === undefined ? {} : targetStateFor(stopped.code)),
    hosts: [after],
    detail: moved
      ? `${order.host} migrated from depth ${before.depth} to ${after.depth} after ${calls} calls`
      : `${calls} calls of charge against ${order.host}${stopped ? `; ${stopped.message}` : ""}`,
  };
}

// --- pin ---------------------------------------------------------------------

async function pinOrder(jobNs: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const deps = io.deps;
  if (order.unpin === true) {
    const released = await jobNs["dnet"]["setStasisLink"](false);
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
  const pinned = await jobNs["dnet"]["setStasisLink"](true);
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
  const pid = await handoffLaunch<DnetProberLaunch>(
    { kind: "dnet-prober", host: order.host },
    () => jobNs["exec"](proberFile, order.host, temporaryRunOptions({ threads: 1, ramOverride: proberReserveGb(jobNs) })),
  );
  return {
    ok: pid !== 0,
    codes: pid === 0 ? { [LOCAL_CODE.NotEnoughRam]: 1 } : {},
    detail: pid === 0 ? "prober exec refused: no room" : `prober pid ${pid}`,
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

void SOLVER_CODES;

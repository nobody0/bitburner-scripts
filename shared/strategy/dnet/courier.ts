import type { Observation, ObservedHost, Provenance } from "./knowledge.ts";

/** The report an agent sends home, and the codes it reports failures with.
 *
 * Pure and ns-free on purpose: the agent encodes, the driver decodes, and one
 * round-trip test covers both so the two cannot drift. Following the marker
 * pattern in game/lib/run-identity.ts, an unrecognised version is a REJECTION
 * with a reason, never a throw and never a partial merge. */

export const REPORT_VERSION = 1;

/** The port darknet agents report on. Ports are shared across every host at
 * 0 GB and need no session, so this is the whole delivery mechanism — no file,
 * no scp, and no dodge to read it. */
export const DNET_REPORT_PORT = 1;

/** Bounds on what one report may carry. The wire is JSON over a socket and a
 * port, and a darknet host's hint text is free-form, so the caps live here
 * beside the schema rather than at each call site. */
export const REPORT_MAX_HOSTS = 24;
const REPORT_MAX_LOG_LINES = 8;
const REPORT_MAX_LOG_CHARS = 240;
export const REPORT_MAX_HINT_CHARS = 120;

/** DarknetResponseCode, transcribed from src/DarkNet/Enums.ts. The UI cannot
 * import game code, so the names live in shared/ where both sides read them. */
export const DARKNET_CODES = {
  200: "Success",
  351: "DirectConnectionRequired",
  401: "AuthFailure",
  403: "Forbidden",
  404: "NotFound",
  408: "RequestTimeOut",
  451: "NotEnoughCharisma",
  453: "StasisLinkLimitReached",
  454: "NoBlockRAM",
  455: "PhishingFailed",
  503: "ServiceUnavailable",
} as const;

export function codeName(code: number): string {
  return (DARKNET_CODES as Record<number, string>)[code] ?? `Unknown(${code})`;
}

export interface ReportHost {
  hostname: string;
  /** False when the observation found it gone. Everything else is then absent. */
  present: boolean;
  depth?: number;
  neighbours?: string[];
  blockedRam?: number;
  maxRam?: number;
  requiredCharisma?: number;
  difficulty?: number;
  isStationary?: boolean;
  modelId?: string;
  passwordLength?: number;
  passwordFormat?: string;
  passwordHint?: string;
  data?: string;
  logTrafficInterval?: number;
}

export interface DnetReport {
  v: typeof REPORT_VERSION;
  /** Ties the report to the mission that asked for it. */
  missionId: string;
  /** The run that launched the agent. Agents outlive controllers. */
  generation: string;
  /** Where the agent was standing. */
  agentHost: string;
  /** "boot" is written before any work, so an agent killed mid-mission still
   *  leaves evidence that it existed. */
  phase: "boot" | "final";
  at: number;
  hosts: ReportHost[];
  /** Response codes seen, counted. This is the diagnosis channel. */
  codes: Record<string, number>;
  logs: string[];
  /** Set when the caps above dropped something. */
  truncated?: boolean;
  /** The mission file did not arrive with the agent. A measured channel
   *  failure, not a crash. */
  missionFileMissing?: boolean;
}

function clip(text: unknown, max: number): string | undefined {
  return typeof text === "string" && text.length > 0 ? text.slice(0, max) : undefined;
}

/** Build a report, applying every cap. Passwords are stripped rather than
 * trusted not to be passed: a credential must never leave home, and the one
 * place to guarantee that is the encoder. */
export function encodeReport(report: DnetReport): string {
  const hosts = report.hosts.slice(0, REPORT_MAX_HOSTS).map((host) => {
    const { passwordHint, data, ...rest } = host as ReportHost & { password?: unknown };
    delete (rest as { password?: unknown }).password;
    return {
      ...rest,
      ...(clip(passwordHint, REPORT_MAX_HINT_CHARS) !== undefined
        ? { passwordHint: clip(passwordHint, REPORT_MAX_HINT_CHARS) }
        : {}),
      ...(clip(data, REPORT_MAX_HINT_CHARS) !== undefined ? { data: clip(data, REPORT_MAX_HINT_CHARS) } : {}),
    };
  });
  const logs = report.logs.slice(0, REPORT_MAX_LOG_LINES).map((line) => line.slice(0, REPORT_MAX_LOG_CHARS));
  const truncated =
    report.truncated === true
    || report.hosts.length > REPORT_MAX_HOSTS
    || report.logs.length > REPORT_MAX_LOG_LINES;
  return JSON.stringify({ ...report, hosts, logs, ...(truncated ? { truncated: true } : {}) });
}

export type DecodeResult =
  | { ok: true; report: DnetReport }
  | { ok: false; reason: "unparseable" | "version" | "shape"; detail: string };

/** Never throws, and never returns a half-understood report. A rejection is a
 * counted outcome so the channel's health is visible instead of silent. */
export function decodeReport(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: "unparseable", detail: String(error) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "shape", detail: "not an object" };
  }
  const value = parsed as Partial<DnetReport>;
  if (value.v !== REPORT_VERSION) {
    return { ok: false, reason: "version", detail: `expected v${REPORT_VERSION}, got ${String(value.v)}` };
  }
  if (
    typeof value.missionId !== "string"
    || typeof value.generation !== "string"
    || typeof value.agentHost !== "string"
    || typeof value.at !== "number"
    || !Array.isArray(value.hosts)
  ) {
    return { ok: false, reason: "shape", detail: "missing required fields" };
  }
  return { ok: true, report: value as DnetReport };
}

/** Turn a decoded report into the observation the fold consumes. Keeping these
 * separate means the fold never has to know a report existed. */
export function observationOf(report: DnetReport, provenance: Provenance = "agent"): Observation {
  const hosts: ObservedHost[] = report.hosts.map((host) => {
    const { hostname, present, ...facts } = host;
    const defined: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(facts)) {
      if (entry !== undefined) defined[key] = entry;
    }
    return { hostname, present, facts: present ? defined : {} };
  });
  return {
    from: report.agentHost,
    provenance,
    at: report.at,
    generation: report.generation,
    hosts,
  };
}

import type { OracleCapture } from "./oracle.ts";

/** The shapes the darknet's findings travel in, and the rule that keeps a
 * password out of everything that is written down.
 *
 * This file used to be a WIRE: three netscript ports, each with an encoder, a
 * decoder, a version marker and a rejection path, carrying reports, credentials
 * and orders between the darknet and home. All of it is gone. Every script the
 * game runs shares one JS realm, so the controller's own object is reachable
 * from home directly — see `game/dnet/realm.ts` for why that is sound rather
 * than merely convenient, and what it costs.
 *
 * What survives is what the serialization was carrying: the shapes, the response
 * codes that make a refusal attributable, and `stripCredentials`, which is the
 * one rule that genuinely needed enforcing in a single place. */

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

/** Codes we invent, kept numerically clear of the engine's 2xx-5xx range and
 * commented as ours so nobody hunts for them in the game source. They exist so
 * that "nothing happened" is never a blank in the response-code panel — every
 * one of these is emitted by a real refusal in `game/dnet/overseer.ts`. */
export const LOCAL_CODES = {
  900: "UnknownModel",
  902: "NoCredential",
  903: "NotEnoughRam",
  904: "ModelUnattempted",
  /** The job's promise was rejected rather than settled: its process died with
   *  its host, its resident was swept, or it hit the controller's timeout. Kept
   *  apart from 903 so a dying net does not read as a RAM shortage. */
  905: "JobDied",
} as const;

export function codeName(code: number): string {
  return (DARKNET_CODES as Record<number, string>)[code]
    ?? (LOCAL_CODES as Record<number, string>)[code]
    ?? `Unknown(${code})`;
}

/** One host, as an agent standing next to it saw it. */
export interface ReportHost {
  hostname: string;
  /** When the observing job looked, stamped where the observation HAPPENED.
   *
   *  Not at drain time: residents run on their own clocks and home collects them
   *  in one batch, so a drain-time stamp would give every host in that batch the
   *  same age and make the fold's newest-wins comparison meaningless. Two
   *  residents adjacent to the same host is the case this exists for. */
  at: number;
  /** False when the observation found it gone. Everything else is then absent. */
  present: boolean;
  depth?: number;
  neighbours?: string[];
  blockedRam?: number;
  maxRam?: number;
  usedRam?: number;
  requiredCharisma?: number;
  difficulty?: number;
  isStationary?: boolean;
  modelId?: string;
  passwordLength?: number;
  passwordFormat?: string;
  passwordHint?: string;
  data?: string;
  logTrafficInterval?: number;
  /** Whether the OBSERVING process held a session. Per-PID, so it says nothing
   *  about anyone else and expires with its observer. */
  hasSession?: boolean;
}

/** One password attempt and what it taught us.
 *
 * `attempted` is OUR string and may be recorded; the server's password never
 * may. `passwordExpected` inside `oracle` is deliberately NOT a credential: it
 * is the buffer half of a `Pr0verFl0` failure — what our own attempt overwrote —
 * and losing it would blind the one model whose whole trick is reading it back. */
export interface AttemptOutcome {
  at: number;
  /** Which model we believed we were attacking, so a wrong belief is visible. */
  modelId?: string;
  status: "implemented" | "unattempted" | "unknown-model";
  /** Index into the model's ordered candidate list, for a dictionary attack. */
  candidateIndex?: number;
  attempted?: string;
  code: number;
  success: boolean;
  /** Wall time. For `2G_cellular` this IS the oracle: each correct leading
   *  character adds 50ms, so the duration is the signal, not the response. */
  elapsedMs?: number;
  /** The model-specific response, scraped back out of the log ring. */
  oracle?: OracleCapture;
}

/** A resident saying it is alive. Three missed beats and the controller retires
 * its queue, because a resident dies with its host. */
export interface AgentBeat {
  agentId: string;
  host: string;
  role: string;
  at: number;
}

/** A password an agent recovered, on its way to the controller's vault.
 *
 * The one structure in the feature that carries a secret. It never crosses a
 * channel that is written down: it lives in the realm between the job that found
 * it and the controller, and in home's module state after that. */
export interface VaultEntry {
  hostname: string;
  password: string;
  /** How it was learned. A `leak` credential came out of a log and is worth
   *  trying anywhere; a `cracked` one is a fact about this host. */
  via: "cracked" | "leak" | "loose";
  at: number;
}

/** Field names that carry a recovered credential and must never be recorded.
 *
 * `passwordExpected` is deliberately absent: see `AttemptOutcome`. */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(["password", "credential", "credentials", "vault"]);

/** Strip credentials at every depth.
 *
 * Recursive and BY NAME, because the things being recorded are nested objects
 * built from log lines we did not write — an attempt carries an oracle, and an
 * oracle is parsed out of a line that may itself have contained a password. A
 * strip that only reached the top level would be reopened by the next field
 * anyone added.
 *
 * Applied by `publishKnowledge` to everything the panel is given. That digest is
 * mirrored over a socket and written to disk as JSONL, so a password reaching it
 * would outlive the run in a file nobody remembers.
 *
 * It is a second line rather than the first: the digest is built from an
 * explicit ALLOW-list of fact names, so a credential has no route in to begin
 * with. This catches the case that allow-list cannot — a field added later to
 * some nested structure the digest carries along. */
export function stripCredentials<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripCredentials) as unknown as T;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key)) continue;
    out[key] = stripCredentials(entry);
  }
  return out as unknown as T;
}

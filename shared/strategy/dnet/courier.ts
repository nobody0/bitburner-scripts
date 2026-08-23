import type { OracleCapture } from "./oracle.ts";
import type { PasswordEvidence } from "./evidence.ts";
import { SOLVER_CODES } from "./solvers/types.ts";

/** The shapes the darknet's findings travel in, and the rule that keeps a
 * password out of everything that is written down.
 *
 * Nothing here is serialized: every script the game runs shares one JS realm, so
 * the overseer's own object is reachable from home directly — see
 * `game/dnet/realm.ts` for why that is sound rather than merely convenient, and
 * what it costs. What lives here is the shapes, the response codes that make a
 * refusal attributable, and `stripCredentials`, which is the one rule that
 * genuinely needed enforcing in a single place. */

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

/** Codes we invent, kept clear of the engine's 2xx-5xx range. Named constants
 * are the source of truth used by emitters; the panel map below is derived from
 * them so the two directions cannot drift. */
export const LOCAL_CODE = {
  UnknownModel: 900,
  NoCredential: 902,
  NotEnoughRam: 903,
  ModelUnattempted: 904,
  /** A queued job died, was swept, or timed out; this is not a RAM refusal. */
  JobDied: 905,
  ...SOLVER_CODES,
  /** A phishing call won the net-wide cache window. */
  PhishingCacheWon: 911,
  /** A pin arrived after the edge it was meant to preserve disappeared. */
  EdgeGone: 912,
  /** The target existed, but scp or exec refused the plant. */
  LaunchRefused: 913,
  /** Authentication rejected this credential for the same target identity. */
  CredentialRejected: 914,
} as const;

export const LOCAL_CODES: Readonly<Record<number, keyof typeof LOCAL_CODE>> = Object.fromEntries(
  Object.entries(LOCAL_CODE).map(([name, code]) => [code, name]),
) as Readonly<Record<number, keyof typeof LOCAL_CODE>>;

export function codeName(code: number): string {
  return (DARKNET_CODES as Record<number, string>)[code]
    ?? (LOCAL_CODES as Record<number, string>)[code]
    ?? `Unknown(${code})`;
}

/** One host, as an agent standing next to it saw it. */
export interface ReportHost {
  hostname: string;
  /** Stable for one server lifetime. Darknet hostnames may be reused after a
   * deletion; the IP distinguishes the replacement from the old identity. */
  identity?: string;
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
  /** `.cache` files `ns.ls` listed on the host.
   *
   *  The only channel there is: upstream appends a darknet server's caches to
   *  its `ls` listing and exposes them through no other member, which is why
   *  `survey` pays 0.2 GB for a call it otherwise would not make. An empty array
   *  is a real observation — "we looked and there were none" — and is what stops
   *  a `cache` task from being derived, so it must not be conflated with absent. */
  caches?: string[];
  /** Coding contracts seen by the same `ls` call as caches.
   * Empty is conclusive and retires the previous listing. */
  contracts?: string[];
  /** Whether `STORM_SEED.exe` sat in the host's program list — read off the
   *  same `ls` call that reports the caches, since upstream appends programs to
   *  the listing too. Explicit `false` is "we looked and it was not there",
   *  which is what retires a stale sighting; absent means the job did not look. */
  stormSeed?: boolean;
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
  /** Whether the call actually tested this password against the expected host. */
  disposition?: AttemptDisposition;
  /** Wall time. For `2G_cellular` this IS the oracle: each correct leading
   *  character adds 50ms, so the duration is the signal, not the response. */
  elapsedMs?: number;
  /** The model-specific response, scraped back out of the log ring. */
  oracle?: OracleCapture;
  /** Where a feedback solver got to, so the next vantage resumes rather than
   *  starting the conversation again. Redacted before anything is published —
   *  see `CREDENTIAL_KEYS` — because a half-solved password is a password. */
  solver?: Record<string, unknown>;
}

export type AttemptDisposition =
  | 'success'
  | 'wrong-password'
  | 'transient'
  | 'edge-lost'
  | 'gone'
  | 'oracle-unavailable';

/** Normalize the engine's response codes without hiding them. */
export function attemptDisposition(
  code: number,
  success: boolean,
  oracleRequired = false,
  oracleCaptured = true,
): AttemptDisposition {
  if (success) return 'success';
  if (code === 351) return 'edge-lost';
  if (code === 503) return 'gone';
  if (code === 408) return 'transient';
  if (oracleRequired && !oracleCaptured) return 'oracle-unavailable';
  return 'wrong-password';
}

export function conclusiveAttempt(outcome: Pick<AttemptOutcome, 'code' | 'success' | 'disposition'>): boolean {
  const disposition = outcome.disposition ?? attemptDisposition(outcome.code, outcome.success);
  return disposition === 'success' || disposition === 'wrong-password';
}

/** Final state of one full destructive read of a target's shared ring. */
export interface LogDrainOutcome {
  pendingAuthRecords: number;
  evidence: PasswordEvidence[];
  /** Last time we paid for a heartbleed call, successful or not. This is our
   * retry clock, not a claim that the ring was consumed. */
  attemptedAt?: number;
  /** Last successful destructive full-ring read. Passive line estimates are
   * measured from this stamp; a refusal must never pretend logs were drained. */
  drainedAt?: number;
}

/** A resident saying it is alive. Three missed beats and the overseer retires
 * its queue, because a resident dies with its host. */
export interface AgentBeat {
  agentId: string;
  host: string;
  role: string;
  at: number;
}

/** A password an agent verified, on its way to the overseer's vault.
 *
 * The one structure in the feature that carries a secret. It never crosses a
 * channel that is written down: it lives in the realm between the job that found
 * it and the overseer, and in home's module state after that. */
export interface VaultEntry {
  hostname: string;
  password: string;
  /** Server lifetime this credential was verified against. */
  identity?: string;
  at: number;
}

/** A plaintext leak whose owner was named, but whose password has not yet been
 * verified against that server lifetime. It is a targeted candidate, never a
 * vault entry and never an unattributed spray candidate. */
export interface ProvisionalCredential {
  hostname: string;
  password: string;
  via: "connecting" | "passcode" | "packet" | "data-file" | "neighbour-file";
  /** When heartbleed exposed the line. The ring carries no creation stamp, so
   * this is the only honest WHEN the script can attach to the observation. */
  at: number;
  /** Server identity held when the overseer received the observation. */
  identity?: string;
}

/** Field names that carry a recovered credential and must never be recorded.
 *
 * `passwordExpected` is deliberately absent: see `AttemptOutcome`. */
/** `solver` and `scratch` are here for the same reason `password` is. A solver's
 * scratch accumulates resolved characters, known prefixes and modular residues,
 * so late in a solve it IS the password in pieces — and it rides on the attempt
 * ledger, which is a published structure. */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "password",
  "credential",
  "credentials",
  "vault",
  "solver",
  "scratch",
  "history",
  "evidence",
]);

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

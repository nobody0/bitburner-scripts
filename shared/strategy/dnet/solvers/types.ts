/** What a password solver is, and why it is a state machine rather than a list.
 *
 * `planAttempt` (`../models.ts`) can only walk an ordered list of candidates: it
 * takes a COUNT of how many have been ruled out and hands back the next one.
 * That is exactly right for the five dictionary models. Eight more decode
 * directly from host facts, while eleven are conversations: you send a guess,
 * the host answers with something about it, and the answer decides what to send
 * next. There was nowhere for that answer to go.
 *
 * A solver is therefore `(facts, state, observation) -> step`, pure, with the
 * state serialised onto the host's attempt ledger between calls.
 *
 * ## Why the state lives in knowledge and not in the job
 *
 * A round trip out there is `authenticate` plus a `heartbleed` at 1.5x its time
 * — about 3.3 s at one thread, and nearly flat across progression. The
 * ADJACENCY the conversation depends on lasts about 108 s (`rates.ts`,
 * `msPerHostEventAny(["moved", "disconnected"])`), so one vantage buys roughly
 * thirty exchanges. Several of these solvers need more than that.
 *
 * But the PASSWORD lasts far longer: only deletion mints a new one (~576 s), and
 * a move or a restart leaves it alone. So a solve that outlives its vantage must
 * be resumable from a different one, which means the state has to survive in the
 * overseer's knowledge rather than in the process holding the session. That is
 * already how the ledger behaves — `foldReports` drops `attempts` only when a
 * host reports absent — so the state rides along with it.
 *
 * ## Two things that are not obvious
 *
 * **`scratch` is a credential.** It accumulates resolved characters, known
 * prefixes and modular residues; late in a solve it IS the password. It must
 * never reach a topic or a log, and `stripCredentials` is the enforcement point.
 *
 * **Giving up is a named outcome, not a silence.** A solver that stops has to
 * say which kind of stop it was, because "we ran out of budget" (resume later),
 * "the host stopped answering" (find another vantage) and "we eliminated the
 * whole search space" (our model of the game is WRONG) want completely different
 * responses from the operator. The codes are in `../courier.ts`.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c */

import type { ModelId, PasswordFacts } from "../models.ts";
import type { OracleCapture } from "../oracle.ts";

/** Everything a solver remembers between attempts. Plain JSON: it is written to
 * the ledger, folded, and read back by a different process on a different host.
 * Nothing in here may be a closure, a Map or a class instance. */
export interface SolverState {
  model: ModelId;
  /** Which IDENTITY this state belongs to — see `solverFingerprint`. */
  fingerprint: string;
  /** Solver-defined. The one field this module does not interpret. */
  phase: string;
  /** Attempts charged against this identity, across every vantage that has
   *  worked on it. Compared against `budget()`. */
  spent: number;
  /** Partial password material. **Secret** — see the header. */
  scratch: Record<string, unknown>;
}

/** What came back from one attempt. `oracle` is already matched to this attempt
 * by the caller; a solver may trust that it describes its own guess. */
export interface SolverObservation {
  attempted: string;
  /** A `DarknetResponseCode`. */
  code: number;
  success: boolean;
  /** Measured wall time. The `2G_cellular` side channel, and the one feedback
   *  path that does not need `heartbleed` — so it works below the charisma
   *  gate, where the log ring is unreadable. */
  elapsedMs?: number;
  oracle?: OracleCapture;
}

export type SolverStep =
  /** The password is known. One `authenticate` should open the host; if it does
   *  not, our decoding of this model is wrong and that is worth hearing about. */
  | { kind: "answer"; password: string; note: string }
  /** Send this, observe, come back with the state. */
  | { kind: "attempt"; password: string; state: SolverState; needsOracle: boolean; note: string }
  /** Stop, for a named reason. `state` is carried when the stop is resumable —
   *  a budget cap is, an exhausted search space is not. */
  | { kind: "give-up"; code: number; reason: string; state?: SolverState };

export interface Solver {
  /** Whether this solver reads the log ring at all. `false` means it runs below
   *  the host's charisma requirement, because `heartbleed` is the only
   *  charisma-gated call and `authenticate` is not. Every closed-form model is
   *  `false`, which is a large part of why they are worth doing first. */
  readonly needsOracle: boolean;
  /** The most attempts this solver may spend on one identity. Declared rather
   *  than discovered: every one of these converges eventually by brute force, so
   *  an undeclared budget is not a solver, it is a loop. */
  budget(facts: PasswordFacts): number;
  first(facts: PasswordFacts): SolverStep;
  next(facts: PasswordFacts, state: SolverState, seen: SolverObservation): SolverStep;
}

/** Local refusal codes, continuing the 900-905 block in `../courier.ts`.
 *
 * Ordered by how loudly they should be read. The last two are not operational
 * problems, they are evidence that our transcription of the game is wrong. */
export const SOLVER_CODES = {
  /** The declared budget ran out. State is kept; the next vantage resumes. */
  SolverBudget: 906,
  /** A matched response taught us nothing new — the conversation is not
   *  progressing, which usually means we are parsing its grammar loosely. */
  SolverStalled: 907,
  /** Feedback was needed and the ring could not be read: below the charisma
   *  gate, or `heartbleed` refused. Not the solver's fault. */
  OracleUnavailable: 908,
  /** The response did not match the grammar this model is documented to speak.
   *  Upstream changed, or we transcribed it wrong. */
  OracleUnparsed: 909,
  /** The search space was eliminated with no hit. The password was provably not
   *  where our model of the game says it must be. */
  SolverExhausted: 910,
} as const;

/** Which IDENTITY a solver's state belongs to.
 *
 * Hostnames are recycled: upstream draws new servers from a generated-name pool,
 * so `depth3_a1b2` can be deleted and a different machine can appear later
 * wearing the same name. Every field here is an `identity`-class fact — one that
 * never changes for a given host and can only be replaced wholesale — so a
 * mismatch means the name is being worn by someone else and the state we are
 * holding solves a password that no longer exists.
 *
 * Cheap, and it fails in the safe direction: a false mismatch costs a restart, a
 * false match costs an unbounded number of attempts against the wrong answer. */
export function solverFingerprint(model: ModelId, facts: PasswordFacts): string {
  return [
    model,
    facts.passwordLength ?? "?",
    facts.passwordFormat ?? "?",
    hash(facts.passwordHint ?? ""),
    hash(facts.data ?? ""),
  ].join("|");
}

/** A short non-cryptographic digest. Only ever compared against itself, so the
 * bar is "different inputs usually differ", not collision resistance. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Start a solver's state for a fresh identity. */
export function freshState(model: ModelId, facts: PasswordFacts, phase: string): SolverState {
  return { model, fingerprint: solverFingerprint(model, facts), phase, spent: 0, scratch: {} };
}

/** Whether a state may still be used against the host described by `facts`. */
export function stateMatches(state: SolverState, facts: PasswordFacts): boolean {
  return state.fingerprint === solverFingerprint(state.model, facts);
}

// --- the resume protocol -----------------------------------------------------
//
// A solver offers `first()` and `next(state, observation)` and nothing in
// between, so a state alone is not enough to re-enter a conversation: what
// advances it is the ANSWER to the attempt it was waiting on. These two keys are
// how that attempt, and the end of the road, travel with the state through the
// attempt ledger and home's fold without either having to know about them.

/** Where a paused solve records the attempt it was waiting on.
 *
 * It lives inside the solver's own `scratch` so that it travels with the state,
 * and so that `stripCredentials` redacts it along with everything else in there
 * — a pending attempt is a guess at the password, and late in a solve that is
 * very nearly the password. The solvers never see it: `withoutPending` removes
 * it before the state is handed back to one. */
export const PENDING_ATTEMPT = "__pendingAttempt";
/** Whether the pending attempt's response has to be read from the ring. Kept
 * beside the password because solver-wide `needsOracle` is deliberately
 * pessimistic and can differ from a later candidate step. */
export const PENDING_NEEDS_ORACLE = "__pendingNeedsOracle";

/** The phase a solver's state is parked in once its search space is GONE.
 *
 * `SolverExhausted` means the password provably is not where our model of the
 * game says it must be, so running the identical search again cannot reach a
 * different answer — and nothing else stops it running: `planAttempt` calls
 * `solver.first()` fresh on every derivation, and the ledger's `lastCode` holds
 * the engine's 401 rather than our 910. Without this marker a search that
 * eliminates every candidate is filed again on the next tick, for ever.
 *
 * It is a normal `SolverState`, so it carries the identity fingerprint and dies
 * exactly when the identity does: `foldReports` drops a host's whole ledger when
 * it reports absent, and a re-minted host is tried again as it should be. */
export const EXHAUSTED_PHASE = "__exhausted";

/** The state as its solver expects it, with the job's own bookkeeping removed. */
export function withoutPending(state: SolverState): SolverState {
  const {
    [PENDING_ATTEMPT]: _pending,
    [PENDING_NEEDS_ORACLE]: _pendingNeedsOracle,
    ...scratch
  } = state.scratch;
  return { ...state, scratch };
}

/** Whether a carried state may resume THIS identity's conversation, and the
 * attempt it was waiting on.
 *
 * Three things have to hold, and each fails in a different way:
 *
 * - The MODEL must match, and it is checked here rather than inside
 *   `stateMatches`, which recomputes the fingerprint from the state's own
 *   `model` and so can only ever confirm what the state already believes. Two
 *   models with the same length, the same format and no hint or data fingerprint
 *   identically — `AccountsManager_4.2` and `NIL` do — and feeding one solver's
 *   scratch to another does not fail politely: it spreads an `undefined` and
 *   THROWS, which kills the agent process rather than failing the attempt.
 * - The IDENTITY must match, or we would be resuming onto a new password and
 *   never terminate: hostnames are recycled upstream, so a ledger can outlive
 *   the machine it describes.
 * - A PENDING ATTEMPT must travel with it, or there is no way back into the
 *   conversation and the solve restarts from `first()`. */
export function resumableState(
  carried: SolverState | undefined,
  modelId: string | undefined,
  facts: PasswordFacts,
): { state?: SolverState; pending?: string; pendingNeedsOracle?: boolean } {
  if (carried === undefined || carried.model !== modelId || !stateMatches(carried, facts)) return {};
  const pending = carried.scratch[PENDING_ATTEMPT];
  const pendingNeedsOracle = carried.scratch[PENDING_NEEDS_ORACLE];
  return typeof pending === "string"
    ? {
        state: carried,
        pending,
        ...(typeof pendingNeedsOracle === "boolean" ? { pendingNeedsOracle } : {}),
      }
    : { state: carried };
}

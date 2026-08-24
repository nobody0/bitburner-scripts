import type { NS } from "@ns";
import { attemptDisposition, conclusiveAttempt, LOCAL_CODE, type AttemptOutcome, type ReportHost } from "../../shared/strategy/dnet/courier.ts";
import { modelEntry, planAttempt, type ModelId, type PasswordFacts } from "../../shared/strategy/dnet/models.ts";
import { harvestLogs, logShape, oracleFor } from "../../shared/strategy/dnet/oracle.ts";
import { solverFor } from "../../shared/strategy/dnet/solvers/index.ts";
import { authenticateWaitMs } from "../../shared/strategy/dnet/rates.ts";
import {
  EXHAUSTED_PHASE,
  PENDING_ATTEMPT,
  PENDING_NEEDS_ORACLE,
  PENDING_STEP_KIND,
  SOLVER_CODES,
  freshState,
  resumableState,
  withoutPending,
  type SolverObservation,
  type SolverState,
  type SolverStep,
} from "../../shared/strategy/dnet/solvers/types.ts";
import type { AgentIo, ControllerDeps, Order, Report } from "./shared.ts";
import { awaitDnetOperation } from "./timing.ts";

/** The `attempt` order body owns authenticate plus any heartbleed needed to
 * advance a feedback solver. One-shot attempts may also have a separately
 * prequeued post-attempt bleed on a second vantage.
 *
 * The body returns the report FIELDS; the agent wrapper stamps `id`, `kind`,
 * `host` and `from` on top.
 *
 * ## The rule this file exists under, with no exceptions
 *
 * It bundles into the same artifact as the controller, and Bitburner's static
 * analyser charges by MEMBER NAME across the whole bundle. So every `ns` reach
 * here is bracket notation on the `jobNs` the body was HANDED
 * (`jobNs["dnet"]["authenticate"]`), and one dot-access would bill the entire
 * order surface — authenticate, heartbleed, scp, exec — to the small controller
 * allocation. `tests/ram-budget.test.ts` greps every file in this directory for
 * that shape and pins the built artifact against esbuild rewriting it.
 *
 * The same trap catches names: a local called `exec`, `scan`, `read` or `run`
 * is never free, and `RegExp.prototype.exec` bills the full 1.3 GB of `ns.exec`
 * wherever it appears. Use `String.prototype.match`. */

type OrderResult = Omit<Report, "id" | "kind" | "host" | "from">;

/** Every read drains the complete upstream ring. A target-owned pending count
 * preserves any records that cannot be read yet because charisma is too low. */
const LOG_LINES = 200;

/** At most this many distinct shapes per job. Drift shows up in the first one or
 * two; a whole bleed's worth would be a list of the same shape. */
const SHAPES_PER_JOB = 2;

/** What a bleed learned about our own parser, in a form that is safe to carry.
 *
 * The COUNT says the grammar has drifted; the shapes say which line drifted, and
 * `logShape` is what makes reporting them safe — see its comment. Undefined when
 * nothing was unrecognised, so the common case adds no field. */
function grammarDrift(
  unrecognised: readonly string[],
): { unrecognised: number; shapes: string[] } | undefined {
  if (unrecognised.length === 0) return undefined;
  const shapes: string[] = [];
  for (const line of unrecognised) {
    const shape = logShape(line);
    if (shape.length > 0 && !shapes.includes(shape)) shapes.push(shape);
    if (shapes.length >= SHAPES_PER_JOB) break;
  }
  return { unrecognised: unrecognised.length, shapes };
}

/** The storm seed's filename, exactly as upstream's program enum spells it. */

/** Everything one `ls` teaches about a darknet host, in one call.
 *
 * `ls` returns every file the host holds, and upstream appends a darknet
 * server's caches, contracts and programs to that list — none has a member of
 * its own — so the filters are ours. `.d.cache` ends in `.cache` too, which is
 * deliberate: a phishing cache is the only kind that can hand back a coding
 * contract, and both are opened by the same call. The seed flag is a boolean
 * rather than a listing because there is exactly one filename to see, and an
 * explicit `false` is the observation that retires a stale sighting.
 *
 * `String.prototype.endsWith`, never a RegExp: `RegExp.prototype.exec` anywhere
 * in a bundle that reaches a game script bills the full 1.3 GB of `ns.exec`. */
/** One host, from `getServerDetails` alone — the attempt body's whole reporting
 * surface. It never lists files or reads identity (those cost `ls`/`dnsLookup`,
 * which are not in `KIND_CALLS.attempt`); a winning authenticate flags the host
 * dirty and the controller's instant `inventory` order reads the drop. */
function describeHost(jobNs: NS, host: string): ReportHost {
  // Stamped HERE, at the getter, not when home eventually drains this: a drain
  // is a batch, and a drain-time stamp would give every host in it one age and
  // make the fold's newest-wins comparison decide nothing.
  const at = Date.now();
  const details = jobNs["dnet"]["getServerDetails"](host);
  if (!details.isOnline) return { hostname: host, at, present: false };
  return {
    hostname: host,
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
  };
}

/** Feedback authenticate + heartbleed stay in one job on purpose.
 *
 * `authenticate()` returns a GENERIC failure for every model but the labyrinth:
 * the model's real answer goes into the target's log ring, and only
 * `heartbleed` reads it back. Splitting a multi-round solver across jobs would
 * race the 200-line ring and lose its exact response. One-shot candidates do
 * not need that response, so they may use a promise-linked second vantage. */
export async function runAttempt(ns: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const jobNs = ns;
  const state = order;
  const deps = io.deps;
  const cancelled = io.cancelled;

  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => {
    jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
  };
  const details = jobNs["dnet"]["getServerDetails"](state.host);
  if (!details.isOnline) {
    return { ok: false, targetState: 'gone', hosts: [{ hostname: state.host, at: Date.now(), present: false }], codes: { "503": 1 } };
  }
  const entry = modelEntry(details.modelId);
  const ledger = deps.ledgerFor(state.host);
  const ring = deps.ringFor(state.host);

  // `heartbleed` is the only charisma-gated call, so below the requirement the
  // log ring is unreadable and every feedback model is deaf. Read once: it
  // decides whether a solver may hold a conversation at all.
  const canBleed = details.requiredCharismaSkill <= deps.charisma();

  const attempts: NonNullable<Report["attempts"]> = [];
  const targetCandidates: string[] = [];
  const factsEvidence = [...(ledger?.evidence ?? [])];
  /** Lines this conversation could not parse, pooled across its rounds. */
  let pendingAuthRecords = ring?.pendingAuthRecords ?? 0;
  let lastBleedAttemptAt = ring?.lastBleedAttemptAt;
  let lastBleedAt = ring?.lastBleedAt;
  const driftLines: string[] = [];

  const drainLogs = async (): Promise<ReturnType<typeof harvestLogs> | undefined> => {
    const attemptedAt = Date.now();
    lastBleedAttemptAt = attemptedAt;
    const bled = await awaitDnetOperation(io, {
      operation: "heartbleed", host: state.host, from: state.from, threads: state.jobThreads ?? state.threads,
    }, () => jobNs["dnet"]["heartbleed"](state.host, { peek: false, logsToCapture: LOG_LINES }));
    count(bled.code);
    if (!bled.success) {
      deps.recordLogDrain(state.host, {
        pendingAuthRecords,
        evidence: [],
        attemptedAt,
      });
      return undefined;
    }
    const at = Date.now();
    lastBleedAt = at;
    const harvest = harvestLogs(bled.logs, { bledFrom: state.host, knownHosts: state.knownHosts ?? [state.host], at });
    pendingAuthRecords = 0;
    deps.recordLogDrain(state.host, { pendingAuthRecords, evidence: harvest.evidence, attemptedAt, drainedAt: at });
    factsEvidence.push(...harvest.evidence);
    driftLines.push(...harvest.unrecognised);
    for (const found of harvest.credentials) {
      deps.recordProvisional({ hostname: found.host, password: found.password, via: found.via, at });
      if (found.host === state.host && !targetCandidates.includes(found.password)) {
        targetCandidates.push(found.password);
      }
    }
    for (const password of harvest.loose) deps.recordLoose(password);
    return harvest;
  };

  // Drain before this identity's first attempt: authenticate prepends into a
  // capped ring, so even one attempt could otherwise evict its oldest hint or
  // leaked credential. The ring's own stamp is authoritative—a standalone
  // drain may already have done this before an attempt job was scheduled.
  if (!state.skipInitialBleed && canBleed && (lastBleedAt === undefined || pendingAuthRecords > 0)) await drainLogs();

  const facts: PasswordFacts = {
    passwordLength: details.passwordLength,
    passwordFormat: details.passwordFormat,
    passwordHint: details.passwordHint,
    data: details.data,
    evidence: factsEvidence,
    difficulty: details.difficulty,
  };

  /** Whether the timing channel is available at all. `ns.formulas` is gated
   *  on OWNING Formulas.exe ($5b on the dark web) and THROWS without it — so
   *  the very first 2G_cellular attempt of a run that has not bought it would
   *  otherwise raise out of the body, fail the job, and re-derive for ever.
   *  One probe decides it; the solver's other channel — the mismatch index
   *  the failure log states outright — needs no formulas at all. */

  /** One measured authentication and its optional full-ring drain. */
  const send = async (password: string, wantsOracle: boolean): Promise<SolverObservation> => {
    // The fourth formula argument is the caller's assumed prefix length; it
    // does not inspect the password. Refresh the zero-prefix baseline before
    // every measurement because failed attempts can raise charisma.
    if (details.modelId === "2G_cellular") {
      const profile = deps.timing();
      if (profile !== undefined) {
        const threads = state.jobThreads ?? state.threads;
        const baseline = authenticateWaitMs(details, profile, threads, 0);
        facts.authenticateBaseMs = baseline;
        facts.authenticateStepMs = authenticateWaitMs(details, profile, threads, 1) - baseline;
      } else {
        delete facts.authenticateBaseMs;
        delete facts.authenticateStepMs;
      }
    }
    const at = Date.now();
    const answer = await awaitDnetOperation(io, {
      operation: "authenticate", host: state.host, from: state.from, threads: state.jobThreads ?? state.threads,
    }, () => jobNs["dnet"]["authenticate"](state.host, password));
    const elapsedMs = Date.now() - at;
    count(answer.code);
    if (answer.code === 401 || answer.success) {
      pendingAuthRecords++;
      deps.recordLogDrain(state.host, { pendingAuthRecords, evidence: [], ...(lastBleedAttemptAt !== undefined ? { attemptedAt: lastBleedAttemptAt } : {}), ...(lastBleedAt !== undefined ? { drainedAt: lastBleedAt } : {}) });
    }
    if (answer.success) {
      // Migration outranks harvesting a ring whose credential is already won.
      // Write through before the next await so completion can synchronously
      // queue the plant consumed by this process's atExit.
      deps.recordCredential({
        hostname: state.host,
        password,
        ...(state.targetIdentity !== undefined ? { identity: state.targetIdentity } : {}),
        at: Date.now(),
      }, state.from);
    }
    // A model id our transcription does not know is either a game update or a
    // hole in `shared/strategy/dnet/models.ts`.
    if (entry === undefined) count(LOCAL_CODE.UnknownModel);

    const outcome: AttemptOutcome = {
      at,
      ...(details.modelId !== undefined ? { modelId: details.modelId } : {}),
      status: entry === undefined ? "unknown-model" : entry.status,
      attempted: password,
      code: answer.code,
      success: answer.success,
      disposition: attemptDisposition(answer.code, answer.success, wantsOracle, false),
      elapsedMs,
    };
    attempts.push(outcome);
    // This authenticate has completed. Persist it before the optional delayed
    // drain so cancellation at that boundary cannot erase the exchange.
    deps.recordAttempt(state.host, outcome);

    // Feedback models drain immediately; timing-only 2G rounds can safely
    // batch until the full-ring bound. A SUCCESS deliberately drains nothing:
    // the credential is already recorded above, spreading onto the opened
    // host outranks harvesting its leftovers, and whatever the ring still
    // holds keeps deriving an ordinary bleed task against the same stamp.
    const harvest = canBleed && !answer.success && (wantsOracle || pendingAuthRecords >= LOG_LINES)
      ? await drainLogs()
      : undefined;
    // Match the response to THIS attempt. The ring is shared with every other
    // agent and with the host's own noise, so folding whichever oracle came
    // back first would hand the solver someone else's feedback.
    const oracle = harvest ? oracleFor(harvest, password, details.modelId) : undefined;
    outcome.disposition = attemptDisposition(answer.code, answer.success, wantsOracle, oracle !== undefined);
    if (oracle !== undefined) outcome.oracle = oracle;
    deps.recordAttempt(state.host, outcome);
    return {
      attempted: password,
      code: answer.code,
      success: answer.success,
      elapsedMs,
      ...(oracle ? { oracle } : {}),
    };
  };

  const checkpoint = (
    carried: SolverState | undefined,
    pending: string,
    pendingNeedsOracle: boolean,
    kind: "attempt" | "answer" = "attempt",
  ): void => {
    if (carried === undefined || attempts.length === 0) return;
    const withPending = {
      ...carried,
      scratch: {
        ...carried.scratch,
        [PENDING_ATTEMPT]: pending,
        [PENDING_NEEDS_ORACLE]: pendingNeedsOracle,
        [PENDING_STEP_KIND]: kind,
      },
    };
    const outcome = attempts[attempts.length - 1]!;
    outcome.solver = withPending as unknown as Record<string, unknown>;
    deps.recordAttempt(state.host, outcome);
  };

  const settle = (
    ok: boolean,
    detail: string,
    carried?: SolverState,
    pending?: string,
    pendingNeedsOracle?: boolean,
  ): OrderResult => {
    // The solver's place rides home on the LAST attempt, which is the record
    // the fold writes into the ledger. `pending` is the attempt that state was
    // waiting on — see the resume path for why the pair has to travel
    // together.
    if (carried !== undefined && attempts.length > 0) {
      const withPending = pending === undefined
        ? carried
        : {
            ...carried,
            scratch: {
              ...carried.scratch,
              [PENDING_ATTEMPT]: pending,
              ...(pendingNeedsOracle !== undefined ? { [PENDING_NEEDS_ORACLE]: pendingNeedsOracle } : {}),
              [PENDING_STEP_KIND]: "attempt",
            },
          };
      const outcome = attempts[attempts.length - 1]!;
      outcome.solver = withPending as unknown as Record<string, unknown>;
      deps.recordAttempt(state.host, outcome);
    }
    const grammar = grammarDrift(driftLines);
    const disposition = attempts[attempts.length - 1]?.disposition;
    const targetState = disposition === 'edge-lost' || disposition === 'gone'
      ? disposition
      : undefined;
    const won = attempts.some((attempt) => attempt.success);
    return {
      ok,
      ...(targetState !== undefined ? { targetState } : {}),
      codes: jobCodes,
      // A server's FIRST successful authentication can create a `.cache`, but
      // this thread-scaled job does NOT `ls` to see it — that is 0.2 GB on every
      // authenticate thread. A successful solve flags the host dirty and the
      // controller files one instant list job. Plain describe otherwise.
      hosts: [{ ...describeHost(jobNs, state.host), ...(won ? { invalidates: ["files" as const] } : {}) }],
      attempts,
      ...(grammar ? { grammar } : {}),
      detail,
    };
  };

  const cancelledResult = (carried?: SolverState, pending?: string, pendingNeedsOracle?: boolean): OrderResult =>
    ({ ...settle(false, `${state.host}: ${cancelled() ?? 'cancelled'}`, carried, pending, pendingNeedsOracle), targetState: 'cancelled' });

  // --- one unattributed password, and nothing else -----------------------

  /** Spend newly drained candidates for THIS target before paying for more
   * model information. This covers both the pre-drain and candidates found
   * inside an OpenWeb response during the conversation. */
  const tryTargetCandidates = async (): Promise<SolverObservation | undefined> => {
    while (targetCandidates.length > 0) {
      const seen = await send(targetCandidates.shift()!, false);
      if (seen.success || seen.code === 351 || seen.code === 503) return seen;
    }
    return undefined;
  };

  const drainedCandidate = await tryTargetCandidates();
  if (drainedCandidate?.success) return settle(true, `opened ${state.host} with a named log leak`);
  if (drainedCandidate?.code === 351 || drainedCandidate?.code === 503) {
    return settle(false, `${state.host}: lost the target while checking a named log leak`);
  }
  //
  // A log line that reads `--<password>--` leaks a random MOVABLE host's
  // password with no name attached, and the controller has already narrowed
  // it to hosts whose length and format match. Spending it is one call: a
  // failed `authenticate` costs nothing but time and even pays charisma xp
  // (`effects.ts:48-50`), so there is nothing to weigh up. It short-circuits
  // the solver entirely, because running a thirty-exchange search while a
  // free candidate waits is paying for information the candidate may make
  // unnecessary.
  if (state.guess !== undefined) {
    const seen = await send(state.guess, false);
    return settle(
      seen.success,
      seen.success
        ? `opened ${state.host} with a leaked password`
        : `${state.host}: the leaked password was not this host's`,
    );
  }

  const solver = solverFor(details.modelId);
  if (solver) {
    // --- the conversation, in ONE process ---------------------------------
    //
    // One attempt per job would pay the 2.0 GB spawn tax and a full controller
    // tick per guess, turning a nine-exchange solve into half a minute of
    // scheduling. `JOB_METHODS.attempt` already carries both calls, so the
    // whole conversation happens here and reports once.
    const carried = resumableState(ledger?.solver as SolverState | undefined, details.modelId, facts);

    /** The marker this identity is parked under once it is eliminated. */
    const exhaustedState = (): SolverState =>
      freshState(details.modelId as ModelId, facts, EXHAUSTED_PHASE);

    const budget = solver.budget(facts);

    /** The exchanges, from wherever the conversation currently stands. */
    const converse = async (first: SolverStep, alreadySpent: number): Promise<OrderResult> => {
      let step = first;
      let spent = alreadySpent;
      while (step.kind !== "give-up") {
        if (cancelled() !== undefined) {
          return cancelledResult(
            step.kind === "attempt" ? step.state : undefined,
            step.password,
            step.kind === "attempt" ? step.needsOracle : false,
          );
        }
        if (spent >= budget) {
          count(SOLVER_CODES.SolverBudget);
          return settle(
            false,
            `${state.host}: solve paused after ${spent} attempts`,
            step.kind === "attempt" ? step.state : undefined,
            step.password,
            step.kind === "attempt" ? step.needsOracle : false,
          );
        }
        checkpoint(
          step.kind === "attempt" ? step.state : undefined,
          step.password,
          step.kind === "attempt" ? step.needsOracle : false,
        );
        const seen = await send(step.password, step.kind === "attempt" ? step.needsOracle : false);
        if (seen.success) return settle(true, `opened ${state.host}`);

        // A timeout fires AFTER the delay and BEFORE the model is consulted, so
        // no log line was written and nothing was learned. Retry the same step
        // without charging it.
        if (seen.code === 408) continue;
        // The host moved or went offline mid-conversation. Keep the state: the
        // password has not changed, only our ability to reach it.
        if (seen.code === 351 || seen.code === 503) {
          return settle(
            false,
            `${state.host}: lost the vantage mid-solve`,
            step.kind === "attempt" ? step.state : undefined,
            step.password,
            step.kind === "attempt" ? step.needsOracle : false,
          );
        }
        spent++;
        if (step.kind === "answer") {
          // We asserted a decoded password and it was refused, so our reading of
          // this model is wrong rather than unlucky. That is worth hearing.
          count(SOLVER_CODES.SolverExhausted);
          return settle(false, `${state.host}: decoded password refused`, exhaustedState());
        }
        if (step.needsOracle && seen.oracle === undefined) {
          count(SOLVER_CODES.OracleUnavailable);
          // The attempt travels with the state, exactly as a budget pause's
          // does. Without it the state is unresumable — the next vantage would
          // fall back to `first()` and throw away a conversation that may have
          // been thirty exchanges deep — and this stop is the most resumable
          // one there is: charisma catches up, the ring becomes readable, and
          // re-sending the same password recovers the answer that was lost.
          return settle(false, `${state.host}: no readable response`, step.state, step.password, step.needsOracle);
        }
        const next = solver.next(facts, step.state, seen);
        if (next.kind !== "give-up") {
          checkpoint(step.state, next.password, next.kind === "attempt" ? next.needsOracle : false, next.kind);
        }
        const leaked = await tryTargetCandidates();
        if (leaked?.success) return settle(true, `opened ${state.host} with a named log leak`);
        if (leaked?.code === 351 || leaked?.code === 503) {
          return settle(false, `${state.host}: lost the target while checking a named log leak`);
        }
        step = next;
      }

      count(step.code);
      return settle(
        false,
        `${state.host}: ${step.reason}`,
        step.code === SOLVER_CODES.SolverExhausted ? exhaustedState() : step.state,
      );
    };

    // An identity we have already eliminated. Costs nothing and spends no
    // call: see `EXHAUSTED_PHASE`.
    if (carried.state?.phase === EXHAUSTED_PHASE) {
      count(SOLVER_CODES.SolverExhausted);
      return settle(false, `${state.host}: this identity was eliminated already`);
    }
    if (carried.state !== undefined && carried.pending !== undefined) {
      const needsOracle = carried.pendingNeedsOracle ?? solver.needsOracle;
      // Reconstruct the pending step and use the ordinary loop, so resumed
      // work shares its budget, deadline, cancellation, timeout, and
      // target-loss semantics.
      return await converse(carried.pendingKind === "answer"
        ? { kind: "answer", password: carried.pending, note: "resumed decoded answer" }
        : {
            kind: "attempt",
            password: carried.pending,
            state: withoutPending(carried.state),
            needsOracle,
            note: "resumed pending attempt",
          }, carried.state.spent);
    }
    if (cancelled() !== undefined) return cancelledResult();
    return await converse(solver.first(facts), 0);
  }

  // --- no solver: a dictionary walk, or the one deliberate probe -----------
  const plan = planAttempt(
    entry,
    facts,
    ledger?.tried ?? 0,
    ledger?.probes ?? 0,
    1,
    ledger?.history?.filter(conclusiveAttempt)
      .map((outcome) => outcome.attempted)
      .filter((value): value is string => value !== undefined) ?? [],
  );
  if (plan.kind === "none") {
    return { ok: false, codes: { [LOCAL_CODE.ModelUnattempted]: 1 }, detail: plan.reason };
  }
  if (cancelled() !== undefined) return cancelledResult();
  const seen = await send(plan.password, plan.kind === "probe");
  if (plan.kind === "candidate" && attempts.length > 0) {
    attempts[attempts.length - 1]!.candidateIndex = plan.index;
  }
  return settle(seen.success, seen.success ? `opened ${state.host}` : `${state.host}: ${plan.password} refused`);
}

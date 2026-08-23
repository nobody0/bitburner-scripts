import type { NS } from "@ns";
import { attemptDisposition, conclusiveAttempt, LOCAL_CODE, type AttemptOutcome, type LogDrainOutcome, type ProvisionalCredential, type ReportHost, type VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import type { AttemptLedger, LogRingState } from "../../shared/strategy/dnet/knowledge.ts";
import { modelEntry, planAttempt, type ModelId, type PasswordFacts } from "../../shared/strategy/dnet/models.ts";
import { harvestLogs, logShape, oracleFor } from "../../shared/strategy/dnet/oracle.ts";
import { solverFor } from "../../shared/strategy/dnet/solvers/index.ts";
import {
  EXHAUSTED_PHASE,
  PENDING_ATTEMPT,
  PENDING_NEEDS_ORACLE,
  SOLVER_CODES,
  freshState,
  resumableState,
  withoutPending,
  type SolverObservation,
  type SolverState,
  type SolverStep,
} from "../../shared/strategy/dnet/solvers/types.ts";
import { FARM_BATCH_MS, batchHasRoom } from "../../shared/strategy/dnet/farm.ts";
import { isDarknetDataFile, parseDarknetFileClue } from "../../shared/strategy/dnet/file-clues.ts";
import type { PasswordEvidence } from "../../shared/strategy/dnet/evidence.ts";
import type { TaskKind } from "../../shared/strategy/dnet/queue.ts";
import { INDUCE_WAIT_MS, labStage } from "../../shared/strategy/dnet/rates.ts";
import {
  decideLab,
  emptyField,
  LAB_FIRST_PROBE,
  labPrior,
  mergeLabFields,
  observeLab,
  readCoords,
  refuseEdge,
  type Cell,
  type Direction,
  type LabField,
} from "../../shared/strategy/dnet/maze.ts";
import { BOOTSTRAP_RECLAIM_METHODS, RESIDENT_METHODS, liveRendezvous, priceAgent, proberReserveGb, type DnetJobResult, type DnetJobState, type JobBeat, type JobCancellation } from "./realm.ts";
import { handoffLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetAgentLaunch, DnetProberLaunch } from "./launch.ts";

/** What a darknet job actually DOES, separated from the overseer that decides
 * it should happen.
 *
 * Every body here runs in the AGENT's process, never in the overseer's. They
 * were once closures in `game/dnet/overseer.ts` for one reason only: some need
 * overseer state that moves (charisma, and the per-host attempt ledger).
 * Passing those as FUNCTIONS gets the bodies out of the scheduler while
 * keeping them live — the overseer reassigns both, so capturing either by
 * value would have a job authenticating on last hour's charisma.
 *
 * ## The rule this file exists under, with no exceptions
 *
 * It bundles into the same artifact as the overseer, and Bitburner's static
 * analyser charges by MEMBER NAME across the whole bundle. So every `ns` reach
 * here is bracket notation on the `jobNs` the body was HANDED
 * (`jobNs["dnet"]["authenticate"]`), and one dot-access would bill the entire
 * job surface — authenticate, heartbleed, scp, exec — to the small overseer
 * allocation. `tests/ram-budget.test.ts` greps every file in this directory for
 * that shape and pins the built artifact against esbuild rewriting it.
 *
 * The same trap catches names: a local called `exec`, `scan`, `read` or `run`
 * is never free, and `RegExp.prototype.exec` bills the full 1.3 GB of `ns.exec`
 * wherever it appears. Use `String.prototype.match`. */

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

function targetStateFor(code: number): Pick<DnetJobResult, 'targetState'> {
  if (code === 351) return { targetState: 'edge-lost' };
  if (code === 503) return { targetState: 'gone' };
  return {};
}

/** How long one attempt job may keep talking to a host.
 *
 * Not a taste decision. A vantage — the adjacency `authenticate` and
 * `heartbleed` both require — survives about 108 s at the default net depth
 * before a move or a disconnect takes it away, and a round trip out there is
 * roughly 3.3 s. A job that ran longer than this would be conversing with a
 * host it can no longer reach, and would learn that by collecting 351s. Well
 * under `JOB_TIMEOUT_MS`, so the overseer never times out a job that is
 * working.
 *
 * A solve that does not finish inside it is not lost: the solver's state rides
 * home on the attempt ledger and the next vantage resumes the conversation. */
const ATTEMPT_WALL_MS = 36_000;

/** The storm seed's filename, exactly as upstream's program enum spells it. */
const STORM_SEED_FILE = "STORM_SEED.exe";

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
function listingOn(jobNs: NS, host: string, deps: JobDeps): { caches: string[]; contracts: string[]; stormSeed: boolean } {
  const names = jobNs["ls"](host);
  const at = Date.now();
  for (const name of names) {
    if (isDarknetDataFile(name)) {
      const clue = parseDarknetFileClue(jobNs["read"](name), at);
      if (clue?.kind === "named-password") {
        deps.recordProvisional?.({ hostname: clue.hostname, password: clue.password, via: "data-file", at });
      } else if (clue?.kind === "neighbour-password") {
        deps.recordNeighbourPassword?.(host, clue.password, at);
      } else if (clue?.kind === "evidence") {
        deps.recordFileEvidence?.(clue.hostname, clue.evidence);
      }
      jobNs["rm"](name, host);
    } else if (name.endsWith(".lit")) {
      jobNs["rm"](name, host);
    }
    // Upstream BaseServer.removeFile does not handle `.msg`; dnet does not
    // generate them, so deliberately do not make a doomed rm call here.
  }
  return {
    caches: names.filter((name) => name.endsWith(".cache")),
    contracts: names.filter((name) => name.endsWith(".cct")),
    stormSeed: names.includes(STORM_SEED_FILE),
  };
}

/** The two pieces of overseer state a job needs and cannot be handed once.
 *
 * Both are read at CALL time, inside the job, because the overseer reassigns
 * them: home refreshes charisma through the rendezvous, and the ledger is
 * re-folded every time an attempt lands. */
export interface JobDeps {
  /** Charisma as the overseer last heard it, for the heartbleed gate. */
  charisma: () => number;
  /** What this host's model has already been asked, so a dictionary walk
   *  resumes rather than restarting at candidate one. */
  ledgerFor: (host: string) => AttemptLedger | undefined;
  ringFor?: (host: string) => LogRingState | undefined;
  /** Write through to the target-owned ledger after every call, so a worker
   *  death cannot take completed attempts or drained evidence with it. */
  recordAttempt?: (host: string, outcome: AttemptOutcome) => void;
  recordLogDrain?: (host: string, outcome: LogDrainOutcome) => void;
  recordCredential?: (entry: VaultEntry, from: string) => void;
  recordLoose?: (password: string) => void;
  recordProvisional?: (entry: ProvisionalCredential) => void;
  recordNeighbourPassword?: (source: string, password: string, at: number) => void;
  recordFileEvidence?: (host: string, evidence: PasswordEvidence) => void;
  /** The lab's shared maze knowledge, keyed by lab hostname and held by the
   *  overseer — the ONE piece of walk progress that outlives a walker's PID.
   *  A walker folds it in before every decision and publishes after every
   *  observation, which lets a re-seeded walker start with the map its dead
   *  predecessor paid for. Live references, like everything in the realm; the
   *  overseer merges rather than replaces. */
  labField?: (host: string) => LabField | undefined;
  publishLabField?: (host: string, field: LabField) => void;
}

/** What a job body is handed.
 *
 * The third argument is the LONG-JOB BEAT and short jobs ignore it: a job that
 * declares `longLived` is skipped by the overseer's timeout loop, so the only
 * evidence it is still alive is its own stamp. See `LONG_JOB_BEAT_MS`. */
export type JobBody = (
  jobNs: NS,
  state: DnetJobState,
  beat?: JobBeat,
  cancelled?: JobCancellation,
) => Promise<DnetJobResult>;

export function makeJobBodies(deps: JobDeps): Readonly<Record<TaskKind, JobBody>> {
  /** One host, as the caller can see it from where it is standing.
   *
   * `withListing` is a parameter rather than always-on because `ns.ls` is
   * 0.2 GB. Survey, reclaim, cache and the completed labyrinth walk pay for it;
   * every other job would be paying for a call it never makes. */
  const describeHost = (jobNs: NS, host: string, withListing = false, withIdentity = false): ReportHost => {
    // Stamped HERE, at the getter, not when home eventually drains this. A
    // resident runs on its own clock and a drain is a batch; a drain-time stamp
    // would give every host in the batch one age and make the fold's
    // newest-wins comparison decide nothing.
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
      // NO `maxRam`/`usedRam` here any more. The overseer reads `maxRam` itself
      // (identity, once, off darkweb) and computes each host's usable RAM from
      // `maxRam − blockedRam − prober`; it never consults `usedRam` at all. So the
      // two 0.05 GB getters that used to ride EVERY job are gone — the controller
      // owns RAM, the job owns its action. `blockedRam` above is the one RAM fact
      // a job still carries, because an action (a grind) is what MOVES it.
      // An EMPTY array is a real observation and has to reach the fold as one:
      // "we looked and there were none" is exactly what stops a `cache` task
      // being derived for ever off a listing nobody ever refreshed. The seed
      // flag rides the same `ls` — one call, two facts.
      ...(withListing ? listingOn(jobNs, host, deps) : {}),
    };
  };

  /** probe + getServerDetails. The only way to learn adjacency at all: probe is
   * host-local, so this fact can only come from a process standing here. */
  const inventoryJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    // The dedicated LIST job: ONE `ls` of the host it stands on, reporting its
    // caches, contracts and identity. Adjacency is the prober's job now, so no
    // `probe`; host FACTS are the overseer's own per-mutation `getServerDetails`
    // sweep, so no neighbours. This exists only to read a DROP — the overseer
    // files it when an action marked the host dirty — off the long, thread-scaled
    // action jobs, so a single instant resident pays the `ls`, not every thread.
    return { ok: true, hosts: [describeHost(jobNs, state.from, true, true)], detail: "listed" };
  };

  /** heartbleed.
   *
   * Worth a job of its own because the log NOISE leaks plaintext passwords — a
   * neighbour's, a stranger's — which is a credential source owing nothing to
   * any of the 24 password minigames, and the reason a crawler spreads without
   * solving one. */
  const bleedJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const attemptedAt = Date.now();
    const bled = await jobNs["dnet"]["heartbleed"](state.host, { peek: false, logsToCapture: LOG_LINES });
    jobCodes[String(bled.code)] = 1;
    if (!bled.success) {
      const logDrain: LogDrainOutcome = {
        pendingAuthRecords: deps.ringFor?.(state.host)?.pendingAuthRecords ?? 0,
        evidence: [],
        attemptedAt,
      };
      deps.recordLogDrain?.(state.host, logDrain);
      return {
        ok: false,
        codes: jobCodes,
        ...targetStateFor(bled.code),
        hosts: [describeHost(jobNs, state.host)],
        detail: bled.message,
      };
    }
    const at = Date.now();
    const harvest = harvestLogs(bled.logs, { bledFrom: state.host, knownHosts: state.knownHosts ?? [state.host], at });
    for (const found of harvest.credentials)
      deps.recordProvisional?.({ hostname: found.host, password: found.password, via: found.via, at });
    for (const password of harvest.loose) deps.recordLoose?.(password);
    const drift = grammarDrift(harvest.unrecognised);
    const logDrain: LogDrainOutcome = {
      pendingAuthRecords: 0,
      evidence: harvest.evidence,
      attemptedAt,
      drainedAt: at,
    };
    deps.recordLogDrain?.(state.host, logDrain);
    return {
      ok: true,
      codes: jobCodes,
      hosts: [describeHost(jobNs, state.host)],
      ...(drift ? { grammar: drift } : {}),
      detail: `${harvest.credentials.length} named candidates, ${harvest.loose.length} unattributed,`
        + ` ${harvest.unrecognised.length} unrecognised lines`,
    };
  };

  /** authenticate + heartbleed, in ONE job on purpose.
   *
   * `authenticate()` returns a GENERIC failure for every model but the labyrinth:
   * the model's real answer goes into the target's log ring, and only
   * `heartbleed` reads it back. Splitting them across two jobs would race the
   * 200-line ring against every other agent's noise for the sake of 0.6 GB. */
  const attemptJob = async (
    jobNs: NS,
    state: DnetJobState,
    _beat?: JobBeat,
    cancelled?: JobCancellation,
  ): Promise<DnetJobResult> => {
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
    const ring = deps.ringFor?.(state.host);

    // `heartbleed` is the only charisma-gated call, so below the requirement the
    // log ring is unreadable and every feedback model is deaf. Read once: it
    // decides whether a solver may hold a conversation at all.
    const canBleed = details.requiredCharismaSkill <= deps.charisma();

    const attempts: NonNullable<DnetJobResult["attempts"]> = [];
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
      const bled = await jobNs["dnet"]["heartbleed"](state.host, { peek: false, logsToCapture: LOG_LINES });
      count(bled.code);
      if (!bled.success) {
        deps.recordLogDrain?.(state.host, {
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
      deps.recordLogDrain?.(state.host, { pendingAuthRecords, evidence: harvest.evidence, attemptedAt, drainedAt: at });
      factsEvidence.push(...harvest.evidence);
      driftLines.push(...harvest.unrecognised);
      for (const found of harvest.credentials) {
        deps.recordProvisional?.({ hostname: found.host, password: found.password, via: found.via, at });
        if (found.host === state.host && !targetCandidates.includes(found.password)) {
          targetCandidates.push(found.password);
        }
      }
      for (const password of harvest.loose) deps.recordLoose?.(password);
      return harvest;
    };

    // Drain before this identity's first attempt: authenticate prepends into a
    // capped ring, so even one attempt could otherwise evict its oldest hint or
    // leaked credential. The ring's own stamp is authoritative—a standalone
    // drain may already have done this before an attempt job was scheduled.
    if (canBleed && (lastBleedAt === undefined || pendingAuthRecords > 0)) await drainLogs();

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
    let timingChannel = true;

    /** One measured authentication and its optional full-ring drain. */
    const send = async (password: string, wantsOracle: boolean): Promise<SolverObservation> => {
      // The fourth formula argument is the caller's assumed prefix length; it
      // does not inspect the password. Refresh the zero-prefix baseline before
      // every measurement because failed attempts can raise charisma.
      if (details.modelId === "2G_cellular" && timingChannel) {
        try {
          const threads = state.jobThreads ?? 1;
          const baseline = jobNs["formulas"]["dnet"]["getAuthenticateTime"](details, threads, undefined, 0);
          facts.authenticateBaseMs = baseline;
          const stepMs = jobNs["formulas"]["dnet"]["getAuthenticateTime"](details, threads, undefined, 1) - baseline;
          // Defensive for incomplete test doubles; upstream always returns > 0.
          if (stepMs > 0) facts.authenticateStepMs = stepMs;
        } catch {
          // No Formulas.exe, or no darknet formulas surface at all. Stop asking
          // and leave the baseline unset: `readMismatchIndex` is the channel
          // the solver falls back to, and it gives up by name if neither is
          // available rather than killing the agent.
          timingChannel = false;
          delete facts.authenticateBaseMs;
          delete facts.authenticateStepMs;
        }
      }
      const at = Date.now();
      const answer = await jobNs["dnet"]["authenticate"](state.host, password);
      const elapsedMs = Date.now() - at;
      count(answer.code);
      if (answer.code === 401 || answer.success) {
        pendingAuthRecords++;
        deps.recordLogDrain?.(state.host, { pendingAuthRecords, evidence: [], ...(lastBleedAttemptAt !== undefined ? { attemptedAt: lastBleedAttemptAt } : {}), ...(lastBleedAt !== undefined ? { drainedAt: lastBleedAt } : {}) });
      }
      if (answer.success) {
        // Migration outranks harvesting a ring whose credential is already won.
        // Write through before the next await so completion can synchronously
        // queue the plant consumed by this process's atExit.
        deps.recordCredential?.({
          hostname: state.host,
          password,
          ...(state.targetIdentity !== undefined ? { identity: state.targetIdentity } : {}),
          at: Date.now(),
        }, state.from);
      }
      // A model id our transcription does not know is either a game update or a
      // hole in `shared/strategy/dnet/models.ts`.
      if (entry === undefined) count(LOCAL_CODE.UnknownModel);

      // Feedback models drain immediately. Timing-only 2G rounds can safely
      // batch until the full-ring bound; success always drains the remainder.
      const harvest = canBleed && !answer.success && (wantsOracle || pendingAuthRecords >= LOG_LINES)
        ? await drainLogs()
        : undefined;
      // Match the response to THIS attempt. The ring is shared with every other
      // agent and with the host's own noise, so folding whichever oracle came
      // back first would hand the solver someone else's feedback.
      const oracle = harvest ? oracleFor(harvest, password, details.modelId) : undefined;
      const outcome: AttemptOutcome = {
        at,
        ...(details.modelId !== undefined ? { modelId: details.modelId } : {}),
        status: entry === undefined ? "unknown-model" : entry.status,
        attempted: password,
        code: answer.code,
        success: answer.success,
        disposition: attemptDisposition(answer.code, answer.success, wantsOracle, oracle !== undefined),
        elapsedMs,
        ...(oracle ? { oracle } : {}),
      };
      attempts.push(outcome);
      deps.recordAttempt?.(state.host, outcome);
      return {
        attempted: password,
        code: answer.code,
        success: answer.success,
        elapsedMs,
        ...(oracle ? { oracle } : {}),
      };
    };

    const settle = (
      ok: boolean,
      detail: string,
      carried?: SolverState,
      pending?: string,
      pendingNeedsOracle?: boolean,
    ): DnetJobResult => {
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
              },
            };
        const outcome = attempts[attempts.length - 1]!;
        outcome.solver = withPending as unknown as Record<string, unknown>;
        deps.recordAttempt?.(state.host, outcome);
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
        // overseer files one instant list job. Plain describe otherwise.
        hosts: [describeHost(jobNs, state.host)],
        ...(won ? { dirtied: true } : {}),
        attempts,
        ...(grammar ? { grammar } : {}),
        detail,
      };
    };

    const cancelledResult = (carried?: SolverState, pending?: string, pendingNeedsOracle?: boolean): DnetJobResult =>
      ({ ...settle(false, `${state.host}: ${cancelled?.() ?? 'cancelled'}`, carried, pending, pendingNeedsOracle), targetState: 'cancelled' });

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
    // password with no name attached, and the overseer has already narrowed
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
      // One attempt per job would pay the 2.0 GB spawn tax and a full overseer
      // tick per guess, turning a nine-exchange solve into half a minute of
      // scheduling. `JOB_METHODS.attempt` already carries both calls, so the
      // whole conversation happens here and reports once.
      const carried = resumableState(ledger?.solver as SolverState | undefined, details.modelId, facts);

      /** The marker this identity is parked under once it is eliminated. */
      const exhaustedState = (): SolverState =>
        freshState(details.modelId as ModelId, facts, EXHAUSTED_PHASE);

      const deadline = Date.now() + ATTEMPT_WALL_MS;
      const budget = solver.budget(facts);

      /** The exchanges, from wherever the conversation currently stands. */
      const converse = async (first: SolverStep, alreadySpent: number): Promise<DnetJobResult> => {
        let step = first;
        let spent = alreadySpent;
        while (step.kind !== "give-up") {
          if (cancelled?.() !== undefined) {
            return cancelledResult(
              step.kind === "attempt" ? step.state : undefined,
              step.password,
              step.kind === "attempt" ? step.needsOracle : false,
            );
          }
          if (Date.now() > deadline || spent >= budget) {
            count(SOLVER_CODES.SolverBudget);
            return settle(
              false,
              `${state.host}: solve paused after ${spent} attempts`,
              step.kind === "attempt" ? step.state : undefined,
              step.password,
              step.kind === "attempt" ? step.needsOracle : false,
            );
          }
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
          const leaked = await tryTargetCandidates();
          if (leaked?.success) return settle(true, `opened ${state.host} with a named log leak`);
          if (leaked?.code === 351 || leaked?.code === 503) {
            return settle(false, `${state.host}: lost the target while checking a named log leak`);
          }

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
          step = solver.next(facts, step.state, seen);
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
        return await converse({
          kind: "attempt",
          password: carried.pending,
          state: withoutPending(carried.state),
          needsOracle,
          note: "resumed pending attempt",
        }, carried.state.spent);
      }
      if (cancelled?.() !== undefined) return cancelledResult();
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
    if (cancelled?.() !== undefined) return cancelledResult();
    const seen = await send(plan.password, plan.kind === "probe");
    if (plan.kind === "candidate" && attempts.length > 0) {
      attempts[attempts.length - 1]!.candidateIndex = plan.index;
    }
    return settle(seen.success, seen.success ? `opened ${state.host}` : `${state.host}: ${plan.password} refused`);
  };

  /** connectToSession/authenticate + scp + exec: put a resident on an open host.
   *
   * `connectToSession` comes first, and that choice makes the normal spawn chain
   * affordable. The credential was won by a PREVIOUS process and its session
   * died with that PID. Re-opening one costs 0.05 GB and no time; authenticate is
   * the fallback when the target no longer has the state the cheap path needs.
   *
   * `exec` and not `spawn` here, because the target is a DIFFERENT host: spawn
   * only ever starts a script where the caller already is. */
  const plantJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    if (state.password === undefined) {
      return { ok: false, codes: { [LOCAL_CODE.NoCredential]: 1 }, detail: "no credential" };
    }
    const diagnose = (
      detail: string,
      fallback: "credential-rejected" | "launch-refused",
    ): DnetJobResult => {
      const details = jobNs["dnet"]["getServerDetails"](state.host);
      const identity = jobNs["dnsLookup"](state.host);
      const observed: ReportHost = details.isOnline && identity.length > 0
        ? { hostname: state.host, identity, at: Date.now(), present: true }
        : { hostname: state.host, at: Date.now(), present: false };
      if (!observed.present) {
        return { ok: false, targetState: "gone", hosts: [observed], codes: jobCodes, detail };
      }
      if (state.targetIdentity !== undefined && observed.identity !== undefined
        && state.targetIdentity !== observed.identity) {
        return { ok: false, targetState: "replaced", hosts: [observed], codes: jobCodes, detail };
      }
      return { ok: false, targetState: fallback, hosts: [observed], codes: jobCodes, detail };
    };
    // connectToSession is the cheap optimistic path. If the identity-bound
    // credential outlived the target's session state, authenticate restores it.
    let session = jobNs["dnet"]["connectToSession"](state.host, state.password);
    let dirtied = false;
    jobCodes[String(session.code)] = (jobCodes[String(session.code)] ?? 0) + 1;
    if (!session.success && state.sessionOnly) {
      if (session.code === 401) {
        jobCodes[LOCAL_CODE.CredentialRejected] = 1;
        return diagnose(session.message, "credential-rejected");
      }
      return { ok: false, codes: jobCodes, ...targetStateFor(session.code), detail: session.message };
    } else if (!session.success) {
      session = await jobNs["dnet"]["authenticate"](state.host, state.password);
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
    if (!jobNs["scp"](state.payloads ?? [], state.host, state.from)) {
      jobCodes[LOCAL_CODE.LaunchRefused] = 1;
      return diagnose("scp refused", "launch-refused");
    }
    if (state.bootstrapReclaim === true) {
      const threads = Math.max(1, state.bootstrapThreads ?? 1);
      const pid = await handoffLaunch<DnetAgentLaunch>(
        {
          kind: "dnet-agent",
          host: state.host,
          bootstrapReclaim: true,
        },
        () => jobNs["exec"](
          (state.payloads ?? [])[0]!,
          state.host,
          temporaryRunOptions({
            threads,
            ramOverride: priceAgent(jobNs, BOOTSTRAP_RECLAIM_METHODS),
          }),
        ),
      );
      if (pid === 0) {
        jobCodes[LOCAL_CODE.LaunchRefused] = 1;
        return diagnose("exec refused while launching local reclaim", "launch-refused");
      }
      // Register from the parent before this plant settles. The child repeats
      // the write on entry, but waiting for that would leave a small window in
      // which the next derivation could file a duplicate plant.
      liveRendezvous()?.bootstraps.set(state.host, { pid, lastBeatAt: Date.now() });
      return {
        ok: true,
        codes: jobCodes,
        hosts: [describeHost(jobNs, state.host)],
        ...(dirtied ? { dirtied: true } : {}),
        detail: `local reclaim pid ${pid}, ${threads} thread${threads === 1 ? "" : "s"}`,
      };
    }
    const proberFile = (state.payloads ?? [])[1];
    let firstProbe!: () => void;
    const firstProbeReported = new Promise<void>((resolve) => { firstProbe = resolve; });
    const proberPid = state.omitProber === true
      ? -1
      : proberFile === undefined ? 0 : await handoffLaunch<DnetProberLaunch>(
      { kind: "dnet-prober", host: state.host, firstReport: firstProbe },
      () => jobNs["exec"](
        proberFile,
        state.host,
        temporaryRunOptions({ threads: 1, ramOverride: proberReserveGb(jobNs) }),
      ),
    );
    if (proberPid === 0) {
      jobCodes[LOCAL_CODE.LaunchRefused] = 1;
      return diagnose("exec refused while launching the reserved prober", "launch-refused");
    }
    if (proberPid > 0) await firstProbeReported;
    liveRendezvous()?.preparePlantedHost?.(state.host);
    const pid = await handoffLaunch<DnetAgentLaunch>(
      { kind: "dnet-agent", host: state.host },
      () => jobNs["exec"](
      (state.payloads ?? [])[0]!,
      state.host,
      // Priced with the JOB's ns, in the job's own process. The overseer could
      // pass a number, but a stale one would under-allocate the resident and
      // kill it on its first call — and this is free.
        temporaryRunOptions({ threads: 1, ramOverride: priceAgent(jobNs, RESIDENT_METHODS) }),
      ),
    );
    if (pid === 0) {
      // Do not strand the mandatory reserve. A lone prober consumes the room a
      // retry needs, so roll back the one this plant just launched.
      if (proberPid > 0) jobNs["kill"](proberPid);
      jobCodes[LOCAL_CODE.LaunchRefused] = 1;
      return diagnose("exec refused while launching the resident", "launch-refused");
    }
    // The mandatory prober rides beside the worker (`payloads[1]`, scp'd above).
    // It carries no self-revival; if it later dies the overseer re-launches it
    // through a `relaunchProbe` job.
    return {
      ok: true,
      codes: jobCodes,
      hosts: [describeHost(jobNs, state.host)],
      ...(dirtied ? { dirtied: true } : {}),
      detail: state.omitProber === true
        ? `resident pid ${pid}, prober reserved for lab walk`
        : `resident pid ${pid}, prober pid ${proberPid}`,
    };
  };

  // --- the farm ------------------------------------------------------------
  //
  // Three calls that need no credential and no neighbour, because all three act
  // on the host the process is already standing on. They are BATCHES rather than
  // single calls: one `memoryReallocation` is a six-second wait, and paying the
  // 2.0 GB spawn back plus a full overseer tick per six seconds would spend
  // more on scheduling than on the work. Every batch is bounded well under
  // `JOB_TIMEOUT_MS`, which is what leaves `longLived` with no user here at all.

  /** memoryReallocation, in a bounded grind.
   *
   * On the CALLING host it needs no credential: the call declares
   * `requireAdminRights`, but `checkDarknetServer` evaluates the direct-
   * connection requirement first and then early-outs on self
   * (`offlineServerHandling.ts:98-101`) BEFORE the admin-rights check is
   * reached — so a resident grinds its own owner's block open for free. That is
   * what makes blocked RAM a problem the net can solve for itself.
   *
   * The call reaches an authenticated NEIGHBOUR too, and `state.host` already
   * carries the target — so when the farm elects a roomy helper to grind a
   * cramped host's block remotely (`state.from !== state.host`), this body runs
   * unchanged; only the vantage the overseer filed it on differs. The remote
   * case is the one that pays the admin check, which is why the planner gates
   * it on the vault. 454/351/503 semantics carry over: 454 NoBlockRAM is still
   * the successful end whichever side the call stands on. */
  const reclaimJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
    const startedAt = Date.now();
    let calls = 0;
    let cleared = false;
    let resized = false;
    for (;;) {
      // Checked BEFORE the call, because the wait is known in advance: starting
      // an eight-second grind with two seconds of batch left overruns by design.
      if (!batchHasRoom("reclaim", startedAt, Date.now(), deps.charisma())) break;
      const freed = await jobNs["dnet"]["memoryReallocation"](state.host);
      count(freed.code);
      if (!freed.success) {
        // 454 NoBlockRAM is the SUCCESSFUL end of a grind — the block is gone,
        // and clearing one to zero is what drops a free `.cache`. 351 and 503
        // are the host moving or dying under us, and end the batch the same way.
        cleared = freed.code === 454;
        break;
      }
      calls++;
      if (state.resizeAtBlockedRam !== undefined) {
        const details = jobNs["dnet"]["getServerDetails"](state.host);
        cleared = details.blockedRam <= 0;
        if (details.blockedRam <= state.resizeAtBlockedRam || cleared) {
          resized = !cleared;
          break;
        }
      }
    }
    const report = describeHost(jobNs, state.host);
    // A successful final call can clear the last block exactly as the batch
    // deadline closes. In that case there is no following 454 response to set
    // cleared, and deriving from blockedRam=0 retires reclaim permanently.
    // Reuse the details read we already owe for the result and turn the observed
    // zero into the inventory invalidation that discovers the guaranteed cache.
    cleared = cleared || (report.present === true && report.blockedRam !== undefined && report.blockedRam <= 0);
    return {
      ok: calls > 0 || cleared,
      codes: jobCodes,
      // Plain describe (for the fresh `blockedRam` this grind exists to move) — but
      // NO listing and NO identity: reading the cleared block's `.cache` would cost
      // `ls` (0.2) AND `getServer` (2.0) on EVERY grind thread. Clearing to zero
      // drops the file, so flag the host dirty and let the overseer's instant list
      // job read it.
      hosts: [report],
      ...(cleared ? { dirtied: true } : {}),
      detail: cleared
        ? `${state.host}: block cleared after ${calls} calls`
        : resized
          ? `${state.host}: ${calls} calls opened another worker thread`
        : `${calls} calls against ${state.host}'s block`,
    };
  };

  /** phishingAttack, in a bounded batch.
   *
   * Every call pays charisma — a quarter rate even when it fails — which is the
   * reliable payoff; the money is a depth-scaled tail and the `.d.cache` is a
   * lottery behind a THREE-MINUTE NET-WIDE cooldown. That cooldown is engine
   * state (`DarknetState.lastPhishingCacheTime`) exposed through no member at
   * all, so the only sighting of it we ever get is our own success message — and
   * the batch stops on it, because the window is now shut for three minutes and
   * the overseer should re-size this host's threads for money instead. */
  const phishJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
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
      // The one discriminator upstream gives us. `String.prototype.includes`,
      // never a RegExp: `RegExp.prototype.exec` anywhere in this bundle bills the
      // full 1.3 GB of `ns.exec` to an overseer pinned at 1.65.
      if (phished.success && phished.message.includes("Found a cache file")) {
        count(LOCAL_CODE.PhishingCacheWon);
        wonCache = true;
        break;
      }
    }
    return {
      ok: calls > 0,
      codes: jobCodes,
      // A successful cache roll creates a `.d.cache` inside `phishingAttack`, but
      // this thread-scaled batch does NOT spend an `ls` to see it — that would
      // cost 0.2 GB on every phishing thread. It flags the host dirty instead, and
      // the overseer files one instant `list` job to read the drop.
      hosts: [describeHost(jobNs, state.host)],
      ...(wonCache ? { dirtied: true } : {}),
      detail: wonCache
        ? `${calls} phishes, one claimed the cache window`
        : `${calls} phishes, ${paid} paid`,
    };
  };

  /** openCache, on the calling host and nowhere else.
   *
   * Two guards, and both exist because this member THROWS rather than refusing.
   * `openCache` raises on a filename the host does not hold
   * (`NetscriptFunctions/Darknet.ts:292-303`), and a throw kills the agent
   * PROCESS instead of failing the job — costing the host its resident over a
   * stale listing. So the listing is re-read first, and the call is wrapped
   * anyway. */
  const cacheJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const wanted = state.filename;
    if (wanted === undefined) {
      return {
        ok: false,
        codes: { [LOCAL_CODE.NoCredential]: 1 },
        detail: "no cache filename; a job never invents one",
      };
    }
    const heldListing = listingOn(jobNs, state.host, deps);
    const held = heldListing.caches;
    if (!held.includes(wanted)) {
      // The listing moved under us — someone else opened it, or the host was
      // restarted. Report the fresh one so the next derivation is right.
      return {
        ok: false,
        codes: { "404": 1 },
        hosts: [{ ...describeHost(jobNs, state.host, false, true), ...heldListing }],
        detail: `${wanted} is no longer on ${state.host}`,
      };
    }
    let opened: { success: boolean; message: string; karmaLoss: number };
    try {
      opened = jobNs["dnet"]["openCache"](wanted, true);
    } catch (error) {
      return {
        ok: false,
        codes: { "404": 1 },
        hosts: [{ ...describeHost(jobNs, state.host, false, true), ...listingOn(jobNs, state.host, deps) }],
        detail: `openCache threw on ${wanted}: ${String(error)}`.slice(0, 200),
      };
    }
    return {
      ok: opened.success,
      codes: { [String(opened.success ? 200 : 404)]: 1 },
      // `karmaLoss` comes back NEGATIVE and karma only ever moves down, so it is
      // free progress toward the gang threshold. The overseer accumulates it
      // and publishes the total for `gang` to read.
      ...(opened.success ? { karmaLoss: opened.karmaLoss } : {}),
      hosts: [{ ...describeHost(jobNs, state.host, false, true), ...listingOn(jobNs, state.host, deps) }],
      detail: opened.message.slice(0, 200),
    };
  };

  /** promoteStock, in a bounded batch.
   *
   * The cheapest call in the feature — 8 s at charisma 0, floored at 200 ms —
   * and the one with the least to say for itself. It raises a symbol's
   * VOLATILITY and never its forecast, so it pays nothing by itself; what makes
   * it worth a job is that the charges DECAY 0.4x at every 75-tick market
   * cycle, which makes propaganda a rate to be maintained rather than a
   * purchase to be made. The symbol is home's: nothing standing on a darknet
   * host can see the market. */
  const promoteJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const symbol = state.symbol;
    if (symbol === undefined) {
      return {
        ok: false,
        codes: { [LOCAL_CODE.NoCredential]: 1 },
        detail: "no symbol; a job never invents one",
      };
    }
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
    const startedAt = Date.now();
    let calls = 0;
    for (;;) {
      if (!batchHasRoom("promote", startedAt, Date.now(), deps.charisma())) break;
      const spread = await jobNs["dnet"]["promoteStock"](symbol);
      count(spread.code);
      if (!spread.success) break;
      calls++;
    }
    return {
      ok: calls > 0,
      codes: jobCodes,
      hosts: [describeHost(jobNs, state.host)],
      detail: `${calls} promotions of ${symbol}`,
    };
  };

  /** induceServerMigration, against a NEIGHBOUR.
   *
   * The one call in the feature that refuses the host it is running on
   * (`Darknet.ts:428-439`), so `state.host` is the target and `state.from` is
   * where we stand. Each call adds
   * `((cha + 500) / (difficulty * 200 + 1000)) * 0.01 * threads` to that host's
   * accumulated charge and pays `5 * threads * difficulty` charisma xp; the
   * move fires when the charge reaches 1, which is a project of hundreds of
   * calls rather than one call with a long wait.
   *
   * The charge is engine state on `DarknetState.migrationInductionServers` and
   * no member reads it back, so progress is only ever inferred: the DEPTH
   * moving is the one observation that says the move landed, and
   * `describeHost` at the end is what carries it home. */
  const induceJob = async (
    jobNs: NS,
    state: DnetJobState,
    beat?: JobBeat,
    cancelled?: JobCancellation,
  ): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
    const before = jobNs["dnet"]["getServerDetails"](state.host);
    const startedAt = Date.now();
    let calls = 0;
    let stopped: { code: number; message: string } | undefined;
    for (;;) {
      const cancellation = cancelled?.();
      if (cancellation !== undefined) {
        return { ok: false, targetState: "cancelled", codes: jobCodes, detail: `${state.host}: ${cancellation}` };
      }
      // The wait is a hardcoded 6 s that no skill shortens, so the batch fits
      // six of them and the check is made before the call rather than after.
      if (Date.now() + INDUCE_WAIT_MS > startedAt + FARM_BATCH_MS) break;
      const pushed = await jobNs["dnet"]["induceServerMigration"](state.host);
      count(pushed.code);
      if (!pushed.success) {
        stopped = pushed;
        break;
      }
      calls++;
      beat?.({ calls });
    }
    const after = describeHost(jobNs, state.host);
    const moved = before.isOnline && after.present === true && after.depth !== before.depth;
    return {
      ok: calls > 0,
      codes: jobCodes,
      ...(stopped === undefined ? {} : targetStateFor(stopped.code)),
      hosts: [after],
      detail: moved
        ? `${state.host} migrated from depth ${before.depth} to ${after.depth} after ${calls} calls`
        : `${calls} calls of charge against ${state.host}${stopped ? `; ${stopped.message}` : ""}`,
    };
  };

  /** setStasisLink, on the calling host and taking no target.
   *
   * Two things make this job unlike every other one. It costs 12 GB, which is
   * three quarters of a shallow host's entire RAM — so beside its prober the
   * allocation cannot carry the 2.0 GB spawn back. The process ends and the new
   * stasis backdoor lets `planSpread` re-`exec` a resident remotely. What it buys
   * is not a capability but an
   * absence: a pinned host is outside `getAllMovableDarknetServers`, so no
   * mutation branch can move it, delete it or restart it.
   *
   * `453 StasisLinkLimitReached` is the refusal that matters, and it is not an
   * error: the limit is `1 + TheBrokenWings + TheHammer + TheStaff`, so it is 1
   * until the labyrinth starts paying out, and a 453 means home's belief about
   * which hosts are pinned has drifted from the engine's. */
  const pinJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    // THE RELEASE DIRECTION. Same call, opposite argument, and no edge check —
    // a release is filed precisely because the edge is gone, so probing for it
    // would refuse the one job that fixes the situation.
    if (state.unpin === true) {
      const released = await jobNs["dnet"]["setStasisLink"](false);
      return {
        ok: released.success,
        codes: { [String(released.code)]: 1 },
        hosts: [describeHost(jobNs, state.host)],
        detail: released.success
          ? `${state.host}: link released, slot freed`
          : `${state.host}: ${released.message}`,
      };
    }
    // THE LAST LOOK BEFORE THE IRREVOCABLE ACT. A pin freezes this host's
    // edges only from the moment it is applied — the mutation clock can sever
    // every connection on one host per branch roll, so the lab edge this pin
    // was planned against may already be gone. Pinning anyway would spend a
    // slot on a host that no longer reaches the thing it was pinned FOR, so
    // the job probes first and refuses without spending. `dnet.probe` is
    // declared in `JOB_METHODS.pin` for exactly this call.
    if (state.edge !== undefined && !jobNs["dnet"]["probe"]().includes(state.edge)) {
      return {
        ok: false,
        codes: { [String(LOCAL_CODE.EdgeGone)]: 1 },
        hosts: [describeHost(jobNs, state.host)],
        detail: `${state.host}: the edge to ${state.edge} is severed; the link was NOT spent`,
      };
    }
    const pinned = await jobNs["dnet"]["setStasisLink"](true);
    return {
      ok: pinned.success,
      codes: { [String(pinned.code)]: 1 },
      hosts: [describeHost(jobNs, state.host)],
      detail: pinned.success ? `${state.host} is pinned` : `${state.host}: ${pinned.message}`,
    };
  };

  /** unleashStormSeed, on the calling host and taking no target.
   *
   * The seed cannot be moved (`scp` allows only scripts, text and `.lit`), so
   * the job runs where the file is. Two properties shape the body. The listing
   * is re-read first because the sighting can go stale exactly like a cache
   * filename — unlike `openCache` the member refuses with a 404 rather than
   * throwing, but a fresh `stormSeed: false` in the failure report is what
   * corrects the next derivation without spending anything. And the SUCCESS
   * path is deliberately minimal — no `describeHost`, nothing slow — because
   * `restartAllDarknetServers` reaches this host about five seconds after the
   * call and the facts it would report are about to be garbage anyway; a small
   * result has the best chance of draining home before the agent dies. The
   * overseer stamps `lastStormFiredAt` pessimistically at claim time for
   * exactly the case where it does not. */
  const stormJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const listing = listingOn(jobNs, state.host, deps);
    if (!listing.stormSeed) {
      return {
        ok: false,
        codes: { "404": 1 },
        hosts: [{ ...describeHost(jobNs, state.host), ...listing }],
        detail: `${STORM_SEED_FILE} is no longer on ${state.host}`,
      };
    }
    const fired = jobNs["dnet"]["unleashStormSeed"]();
    return {
      ok: fired.success,
      codes: { [String(fired.code)]: 1 },
      ...(fired.success ? { stormFiredAt: Date.now() } : {}),
      detail: fired.message.slice(0, 200),
    };
  };

  /** The maze walker: `authenticate(lab, <direction>)`, over and over, with the
   * occasional paid `labradar` when one render decides more than one move can.
   *
   * THE ONE JOB THAT MUST NEVER END EARLY. Position is
   * `DarknetState.labLocations[pid]`, so a dead PID abandons the walk and the
   * next process is re-seeded at the start — there is no resuming, and a deep
   * lab is thousands of moves. That is why it is the only `longLived` kind, why
   * it beats every move, and why its host is the first thing a stasis link is
   * spent on.
   *
   * The lab is the one model that answers through `authenticate`'s own return
   * value: `message` carries the new coordinates and `data` a radius-1 render.
   * That free render reveals all four adjacent walls BEFORE the next choice, so
   * the planner in `shared/strategy/dnet/maze.ts` never pays an authentication
   * to bump a wall — except the deliberate first probe, made blind because the
   * position is unknown until the first response. `labradar` costs the same
   * full authentication as a move and earns no charisma, so `decideLab` pays
   * for one only when its radius-3 window would decide the exit outright or
   * scout several of a seam's door candidates at once.
   *
   * **A wall refusal leaves the position UNCHANGED.** The engine tests the cell
   * BETWEEN us and the target and returns "You are still at X,Y" without
   * moving, so every position comes from parsing the response rather than from
   * assuming the move worked. */
  const walkJob = async (
    jobNs: NS,
    state: DnetJobState,
    beat?: JobBeat,
    cancelled?: JobCancellation,
  ): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
    const stage = labStage(state.host);
    // Below the lab's charisma every single move answers 451 and nothing is
    // learned. Refusing to start is the difference between a job that reports
    // a career need and one that spends an hour collecting 451s.
    // The planner's whole edge is knowing the generator's arithmetic for THIS
    // stage — the seams, the door candidates, the exit candidates. A lab host
    // outside the ladder has no stage to know, and walking it blind would be
    // the old DFS without its aim; stop and say so instead.
    if (!stage) {
      return {
        ok: false,
        codes: { [String(SOLVER_CODES.OracleUnparsed)]: 1 },
        detail: `${state.host} is not a labyrinth rung the walker knows`,
      };
    }
    const basePrior = labPrior(stage);
    let prior = basePrior;
    // Seed from the overseer's shared field: the one piece of walk progress
    // that outlives a PID. A re-seeded walker starts with its predecessor's
    // map, so a replacement starts with everything its predecessor learned.
    let field: LabField = deps.labField?.(state.host) ?? emptyField();
    let at: Cell | undefined;
    /** The direction of the move in flight, so a refusal can be written down. */
    let pending: Direction | undefined;
    let moves = 0;
    let walls = 0;
    let radars = 0;
    /** The planner's own A* estimate of what is left, refreshed every decision.
     *  The walk's only forward-looking number, and the one the panel turns into
     *  an ETA against the walk's own observed pace. */
    let believedLeft: number | undefined;
    const progress = (): Record<string, unknown> => ({
      ...(at !== undefined ? { at: `${at[0]},${at[1]}` } : {}),
      moves,
      walls,
      radars,
      learned: Object.keys(field.slots).length,
      ...(believedLeft !== undefined ? { believedLeft } : {}),
    });
    for (;;) {
      const cancellation = cancelled?.();
      if (cancellation !== undefined) {
        return { ok: false, targetState: "cancelled", codes: jobCodes, detail: `${state.host}: ${cancellation}` };
      }
      // The FIRST call has no known position, so it is a deliberate blind
      // probe: any direction answers with our coordinates whether it moves us
      // or not, and probing TOWARD the exit's corner turns the lucky half of
      // those probes into a free first step.
      let direction: Direction;
      if (at === undefined) {
        direction = LAB_FIRST_PROBE;
      } else {
        // Fold in whatever the OTHER walker has published since our last look,
        // then decide. Merging every step is cheap — a field tops out around
        // two thousand slots — and it is what turns two walkers into one
        // mapper rather than two strangers.
        field = mergeLabFields(field, deps.labField?.(state.host));
        let plan = decideLab(field, at, prior);
        if (plan.kind === "lost" && prior !== basePrior) {
          // The route bias closed every remaining path. Drop it for good and
          // help wherever the map still has questions.
          prior = basePrior;
          plan = decideLab(field, at, prior);
        }
        if (plan.kind === "lost") {
          return {
            ok: false,
            codes: jobCodes,
            detail: `${state.host}: ${plan.reason}`.slice(0, 200),
          };
        }
        field = plan.field;
        if (plan.kind === "radar") {
          // One authentication for a radius-3 render with the exit overlay ON.
          // `decideLab` has already written this vantage down, so a refused or
          // unreadable radar is skipped rather than retried forever.
          const seen = await jobNs["dnet"]["labradar"]();
          radars++;
          count(seen.success ? "radar" : "radar-refused");
          if (seen.success) {
            field = observeLab(field, at, String(seen.message ?? ""), basePrior) ?? field;
          }
          deps.publishLabField?.(state.host, field);
          beat?.(progress());
          continue;
        }
        direction = plan.direction;
        believedLeft = plan.believedCost;
      }
      // The direction word IS the password. `getDirectionFromInput` splits on
      // spaces and takes the first token that parses, so "north" and "go north"
      // are the same move and the shorter one is one less thing to get wrong.
      pending = direction;
      const answer = await jobNs["dnet"]["authenticate"](state.host, direction);
      count(answer.code);
      if (answer.success) {
        return {
          ok: true,
          codes: jobCodes,
          // Neither listing NOR identity: the walker's only job is to reach the
          // exit. The `.cache` the exit drops, and the lab's ip, are read by the
          // ORDINARY worker `planSpread` re-plants here the moment the walk ends —
          // paying `ls` (0.2) and `getServer` (2.0) on ONE resident instead of on
          // every one of the walker's authenticate threads.
          detail: `${state.host}: reached the exit after ${moves} moves and ${radars} radars`,
        };
      }
      // A move that never reached the model — the host moved, or we lost the
      // charisma gate mid-walk. Neither is recoverable from here, and the walk
      // is lost with the PID either way, so stop rather than spin.
      if (answer.code !== 401) {
        return {
          ok: false,
          codes: jobCodes,
          ...targetStateFor(answer.code),
          detail: `${state.host}: ${answer.message}`.slice(0, 200),
        };
      }
      const where = readCoords(answer.message);
      if (where === undefined) {
        // The grammar moved. Stopping is right: a walker that cannot read its
        // own position would walk into the same wall for hours.
        count(SOLVER_CODES.OracleUnparsed);
        return {
          ok: false,
          codes: jobCodes,
          detail: `${state.host}: could not read a position out of the response`,
        };
      }
      const seen = observeLab(field, where, String(answer.data ?? ""), basePrior);
      if (seen === undefined) {
        // Same verdict for a render that is no longer a centred odd square: a
        // walker that believed it would learn confident lies.
        count(SOLVER_CODES.OracleUnparsed);
        return {
          ok: false,
          codes: jobCodes,
          detail: `${state.host}: could not read the surroundings out of the response`,
        };
      }
      field = seen;
      const moved = at === undefined || where[0] !== at[0] || where[1] !== at[1];
      if (at !== undefined && moved) moves++;
      if (at !== undefined && !moved) {
        walls++;
        // THE ENGINE REFUSED A STEP WE BELIEVED OPEN. With the prior in place
        // this should never happen — the border is pre-walled and the first
        // edge of every plan is already known — but an engine that disagrees
        // with our model must be written down, or the identical decision
        // repeats until the host dies, which no watchdog would catch because
        // the beat below keeps stamping.
        field = refuseEdge(field, at, pending);
      }
      at = where;
      // Publish AFTER folding this response in, so the other walker — and any
      // successor of ours — plans over everything this step just paid for.
      deps.publishLabField?.(state.host, field);
      beat?.(progress());
    }
  };

  /** Re-establish this host's dead prober with one local `exec`.
   *
   * The prober carries no `spawn`, so it cannot revive itself; the overseer files
   * this max-priority job when a host's prober stamp goes stale in `probes`.
   * Everything it needs rides on the task or the process it runs in: the stable
   * prober filename comes on the task (`state.filename`). The prober file is already on
   * the host from plant time — a restart kills processes, not files — so this is a
   * bare `exec`, no `scp`. */
  const relaunchProbeJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    // The prober filename rides in on the task (`state.filename`), exactly as the
    // plant carries its payloads — the overseer owns the name and a job never
    // constructs one.
    const proberFile = state.filename;
    if (proberFile === undefined) return { ok: false, codes: {}, detail: "no prober file on the task" };
    const pid = await handoffLaunch<DnetProberLaunch>(
      { kind: "dnet-prober", host: state.host },
      () => jobNs["exec"](
        proberFile,
        state.host,
        temporaryRunOptions({ threads: 1, ramOverride: proberReserveGb(jobNs) }),
      ),
    );
    return {
      ok: pid !== 0,
      codes: pid === 0 ? { [LOCAL_CODE.NotEnoughRam]: 1 } : {},
      detail: pid === 0 ? "prober exec refused: no room" : `prober pid ${pid}`,
    };
  };

  // Exhaustive by `TaskKind`: an unknown kind is a programming error, never a
  // licence to silently substitute an inventory job.
  return {
    inventory: inventoryJob,
    relaunchProbe: relaunchProbeJob,
    bleed: bleedJob,
    attempt: attemptJob,
    plant: plantJob,
    reclaim: reclaimJob,
    phish: phishJob,
    cache: cacheJob,
    promote: promoteJob,
    induce: induceJob,
    pin: pinJob,
    walk: walkJob,
    storm: stormJob,
  };
}

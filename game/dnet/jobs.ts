import type { NS } from "@ns";
import type { ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import type { AttemptLedger } from "../../shared/strategy/dnet/knowledge.ts";
import { modelEntry, planAttempt, type ModelId, type PasswordFacts } from "../../shared/strategy/dnet/models.ts";
import { harvestLogs, logShape, oracleFor } from "../../shared/strategy/dnet/oracle.ts";
import { solverFor } from "../../shared/strategy/dnet/solvers/index.ts";
import {
  SOLVER_CODES,
  freshState,
  stateMatches,
  type SolverObservation,
  type SolverState,
  type SolverStep,
} from "../../shared/strategy/dnet/solvers/types.ts";
import { FARM_BATCH_MS, batchHasRoom } from "../../shared/strategy/dnet/farm.ts";
import { INDUCE_WAIT_MS, labMazeSize, labStage } from "../../shared/strategy/dnet/rates.ts";
import { emptyMaze, markBlocked, readCoords, stepMaze, type Cell } from "../../shared/strategy/dnet/maze.ts";
import { RESIDENT_METHODS, priceAgent, type DnetJobResult, type DnetJobState, type JobBeat } from "./realm.ts";

/** What a darknet job actually DOES, separated from the controller that decides
 * it should happen.
 *
 * These five bodies run in the AGENT's process, never in the controller's, so
 * they were closures in `game/dnet/overseer.ts` for one reason only: two of them
 * need controller state that moves (charisma, and the per-host attempt ledger).
 * Passing those two as FUNCTIONS gets the bodies out of a 635-line scheduler
 * while keeping them live — the overseer reassigns both, so capturing either by
 * value would have a job authenticating on last hour's charisma.
 *
 * ## The rule this file exists under, with no exceptions
 *
 * It bundles into the same artifact as the controller, and Bitburner's static
 * analyser charges by MEMBER NAME across the whole bundle. So every `ns` reach
 * here is bracket notation on the `jobNs` the body was HANDED
 * (`jobNs["dnet"]["authenticate"]`), and one dot-access would bill the entire
 * job surface — authenticate, heartbleed, scp, exec — to a controller pinned at
 * 1.65 GB. `tests/ram-budget.test.ts` greps every file in this directory for
 * that shape and pins the built artifact against esbuild rewriting it.
 *
 * The same trap catches names: a local called `exec`, `scan`, `read` or `run`
 * is never free, and `RegExp.prototype.exec` bills the full 1.3 GB of `ns.exec`
 * wherever it appears. Use `String.prototype.match`. */

/** Log lines pulled per bleed. `peek` leaves them, so this does not consume
 * evidence another agent may want, and the ring holds 200. */
const LOG_LINES = 8;

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

/** How long one attempt job may keep talking to a host.
 *
 * Not a taste decision. A vantage — the adjacency `authenticate` and
 * `heartbleed` both require — survives about 108 s at the default net depth
 * before a move or a disconnect takes it away, and a round trip out there is
 * roughly 3.3 s. A job that ran longer than this would be conversing with a
 * host it can no longer reach, and would learn that by collecting 351s. Well
 * under `JOB_TIMEOUT_MS`, so the controller never times out a job that is
 * working.
 *
 * A solve that does not finish inside it is not lost: the solver's state rides
 * home on the attempt ledger and the next vantage resumes the conversation. */
const ATTEMPT_WALL_MS = 36_000;

/** Where a paused solve records the attempt it was waiting on.
 *
 * It lives inside the solver's own `scratch` so that it travels with the state
 * through the ledger and the fold without any of them needing to know about it,
 * and so that `stripCredentials` redacts it along with everything else in there
 * — a pending attempt is a guess at the password, and late in a solve that is
 * very nearly the password. The solvers never see it: it is removed before the
 * state is handed back to one. */
const PENDING = "__pendingAttempt";

/** The phase a solver's state is parked in once its search space is GONE.
 *
 * `SolverExhausted` means the password provably is not where our model of the
 * game says it must be, so running the identical search again cannot reach a
 * different answer — and nothing else stops it running: `planAttempt` calls
 * `solver.first()` fresh on every derivation, and the ledger's `lastCode` holds
 * the engine's 401 rather than our 910. Without this marker a host whose model
 * we cannot open (`Factori-Os` above difficulty 24 is the transcribed example,
 * and `deep.ts` says so in its own give-up) spends its whole walk, gives up, and
 * is filed again on the next tick, for ever.
 *
 * It is a normal `SolverState`, so it carries the identity fingerprint and dies
 * exactly when the identity does: `foldReports` drops a host's whole ledger when
 * it reports absent, and a re-minted host is tried again as it should be. */
const EXHAUSTED = "__exhausted";

/** The `.cache` files on a host, out of `ns.ls`.
 *
 * `ls` returns every file the host holds and upstream appends a darknet
 * server's caches to that list — there is no cache-specific member — so the
 * filter is ours. `.d.cache` ends in `.cache` too, which is deliberate: a
 * phishing cache is the only kind that can hand back a coding contract, and both
 * are opened by the same call.
 *
 * `String.prototype.endsWith`, never a RegExp: `RegExp.prototype.exec` anywhere
 * in a bundle that reaches a game script bills the full 1.3 GB of `ns.exec`. */
function cacheFilesOn(jobNs: NS, host: string): string[] {
  return jobNs["ls"](host).filter((name) => name.endsWith(".cache"));
}

/** The state as its solver expects it, with the job's own bookkeeping removed. */
function withoutPending(state: SolverState): SolverState {
  const { [PENDING]: _pending, ...scratch } = state.scratch;
  return { ...state, scratch };
}

/** The two pieces of controller state a job needs and cannot be handed once.
 *
 * Both are read at CALL time, inside the job, because the overseer reassigns
 * them: home refreshes charisma through the rendezvous, and the ledger is
 * re-folded every time an attempt lands. */
export interface JobDeps {
  /** Charisma as the controller last heard it, for the heartbleed gate. */
  charisma: () => number;
  /** What this host's model has already been asked, so a dictionary walk
   *  resumes rather than restarting at candidate one. */
  ledgerFor: (host: string) => AttemptLedger | undefined;
}

/** What a job body is handed.
 *
 * The third argument is the LONG-JOB BEAT and short jobs ignore it: a job that
 * declares `longLived` is skipped by the controller's timeout loop, so the only
 * evidence it is still alive is its own stamp. See `LONG_JOB_BEAT_MS`. */
export type JobBody = (jobNs: NS, state: DnetJobState, beat?: JobBeat) => Promise<DnetJobResult>;

export function makeJobBodies(deps: JobDeps): Readonly<Record<string, JobBody>> {
  /** One host, as the caller can see it from where it is standing.
   *
   * `withCaches` is a parameter rather than always-on because `ns.ls` is 0.2 GB
   * and only two kinds declare it: `survey`, which is how a `.cache` is ever
   * discovered, and `cache`, which re-reads the listing after opening one. Every
   * other job would be paying for a call it never makes. */
  const describeHost = (jobNs: NS, host: string, withCaches = false): ReportHost => {
    // Stamped HERE, at the getter, not when home eventually drains this. A
    // resident runs on its own clock and a drain is a batch; a drain-time stamp
    // would give every host in the batch one age and make the fold's
    // newest-wins comparison decide nothing.
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
      hasSession: details.hasSession,
      // The two ordinary getters, 0.05 each. Without them `freeRam` is 0 for
      // every host, `planSpread` refuses every plant for want of room, and the
      // net never grows past the beachhead — which looks exactly like a
      // credential problem and is not one.
      maxRam: jobNs["getServerMaxRam"](host),
      usedRam: jobNs["getServerUsedRam"](host),
      // An EMPTY array is a real observation and has to reach the fold as one:
      // "we looked and there were none" is exactly what stops a `cache` task
      // being derived for ever off a listing nobody ever refreshed.
      ...(withCaches ? { caches: cacheFilesOn(jobNs, host) } : {}),
    };
  };

  /** probe + getServerDetails. The only way to learn adjacency at all: probe is
   * host-local, so this fact can only come from a process standing here. */
  const surveyJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const around = jobNs["dnet"]["probe"]();
    // The vantage describes ITSELF as well as its neighbours, and with its cache
    // listing. Without this a resident's own host is only ever described by a
    // neighbour's survey — so a host at the edge of the crawl, which is exactly
    // the one worth farming, never reported its own blocked RAM or its own
    // `.cache` files at all.
    const hosts: ReportHost[] = [{ ...describeHost(jobNs, state.from, true), neighbours: [...around] }];
    for (const host of around) hosts.push(describeHost(jobNs, host, true));
    return { ok: true, hosts, detail: `${around.length} neighbours` };
  };

  /** heartbleed.
   *
   * Worth a job of its own because the log NOISE leaks plaintext passwords — a
   * neighbour's, a stranger's — which is a credential source owing nothing to
   * any of the 24 password minigames, and the reason a crawler spreads without
   * solving one. */
  const bleedJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const bled = await jobNs["dnet"]["heartbleed"](state.host, { peek: true, logsToCapture: LOG_LINES });
    jobCodes[String(bled.code)] = 1;
    if (!bled.success) {
      return { ok: false, codes: jobCodes, hosts: [describeHost(jobNs, state.host)], detail: bled.message };
    }
    const harvest = harvestLogs(bled.logs, state.host);
    const credentials: VaultEntry[] = harvest.credentials.map((found) => ({
      hostname: found.host!,
      password: found.password,
      via: "leak" as const,
      at: Date.now(),
    }));
    const drift = grammarDrift(harvest.unrecognised);
    return {
      ok: true,
      codes: jobCodes,
      credentials,
      // The `--<password>--` lines, which name no owner. They travel to the
      // controller and no further: it is the only thing that knows which hosts
      // a password of this length and format could belong to, and an
      // unattributed password is still a password.
      ...(harvest.loose.length > 0 ? { loose: harvest.loose } : {}),
      hosts: [describeHost(jobNs, state.host)],
      ...(drift ? { grammar: drift } : {}),
      detail: `${credentials.length} credentials, ${harvest.loose.length} unattributed,`
        + ` ${harvest.unrecognised.length} unrecognised lines`,
    };
  };

  /** authenticate + heartbleed, in ONE job on purpose.
   *
   * `authenticate()` returns a GENERIC failure for every model but the labyrinth:
   * the model's real answer goes into the target's log ring, and only
   * `heartbleed` reads it back. Splitting them across two jobs would race the
   * 200-line ring against every other agent's noise for the sake of 0.6 GB. */
  const attemptJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
    const details = jobNs["dnet"]["getServerDetails"](state.host);
    if (!details.isOnline) {
      return { ok: false, hosts: [{ hostname: state.host, at: Date.now(), present: false }], codes: { "503": 1 } };
    }
    const entry = modelEntry(details.modelId);
    const ledger = deps.ledgerFor(state.host);
    const facts: PasswordFacts = {
      passwordLength: details.passwordLength,
      passwordFormat: details.passwordFormat,
      passwordHint: details.passwordHint,
      data: details.data,
      difficulty: details.difficulty,
    };
    // `heartbleed` is the only charisma-gated call, so below the requirement the
    // log ring is unreadable and every feedback model is deaf. Read once: it
    // decides whether a solver may hold a conversation at all.
    const canBleed = details.requiredCharismaSkill <= deps.charisma();

    const credentials: VaultEntry[] = [];
    /** Unattributed passwords the ring gave up while we were talking to it. */
    const loose: string[] = [];
    const attempts: NonNullable<DnetJobResult["attempts"]> = [];
    /** Lines this conversation could not parse, pooled across its rounds. */
    const driftLines: string[] = [];

    /** One `authenticate`, plus the log read its real answer may be hiding in. */
    const send = async (password: string, wantsOracle: boolean): Promise<SolverObservation> => {
      const at = Date.now();
      const answer = await jobNs["dnet"]["authenticate"](state.host, password);
      const elapsedMs = Date.now() - at;
      count(answer.code);
      // A model id our transcription does not know is either a game update or a
      // hole in `shared/strategy/dnet/models.ts`.
      if (entry === undefined) count(900);

      // Read the ring whatever happened: on a failure it holds the model's
      // response, and on a success it still holds whatever the host leaked while
      // we were working.
      const bled = (wantsOracle || answer.success) && canBleed
        ? await jobNs["dnet"]["heartbleed"](state.host, { peek: true, logsToCapture: LOG_LINES })
        : undefined;
      const harvest = bled?.success ? harvestLogs(bled.logs, state.host) : undefined;
      // Drift accumulates across the whole conversation rather than per round:
      // a solve is many bleeds against one ring, and reporting each round
      // separately would count the same unparsed line a dozen times.
      for (const line of harvest?.unrecognised ?? []) driftLines.push(line);
      for (const found of harvest?.credentials ?? []) {
        credentials.push({ hostname: found.host!, password: found.password, via: "leak", at: Date.now() });
      }
      for (const bare of harvest?.loose ?? []) loose.push(bare);
      if (answer.success) {
        credentials.push({ hostname: state.host, password, via: "cracked", at: Date.now() });
      }
      // Match the response to THIS attempt. The ring is shared with every other
      // agent and with the host's own noise, so folding whichever oracle came
      // back first would hand the solver someone else's feedback.
      const oracle = harvest ? oracleFor(harvest, password, details.modelId) : undefined;
      attempts.push({
        at,
        ...(details.modelId !== undefined ? { modelId: details.modelId } : {}),
        status: entry === undefined ? "unknown-model" : entry.status,
        attempted: password,
        code: answer.code,
        success: answer.success,
        elapsedMs,
        ...(oracle ? { oracle } : {}),
      });
      return {
        attempted: password,
        code: answer.code,
        success: answer.success,
        elapsedMs,
        ...(oracle ? { oracle } : {}),
      };
    };

    const settle = (ok: boolean, detail: string, carried?: SolverState, pending?: string): DnetJobResult => {
      // The solver's place rides home on the LAST attempt, which is the record
      // the fold writes into the ledger. `pending` is the attempt that state was
      // waiting on — see the resume path for why the pair has to travel
      // together.
      if (carried !== undefined && attempts.length > 0) {
        const withPending = pending === undefined
          ? carried
          : { ...carried, scratch: { ...carried.scratch, [PENDING]: pending } };
        attempts[attempts.length - 1]!.solver = withPending as unknown as Record<string, unknown>;
      }
      const grammar = grammarDrift(driftLines);
      return {
        ok,
        codes: jobCodes,
        credentials,
        ...(loose.length > 0 ? { loose } : {}),
        hosts: [describeHost(jobNs, state.host)],
        attempts,
        ...(grammar ? { grammar } : {}),
        detail,
      };
    };

    // --- one unattributed password, and nothing else -----------------------
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
      const resumed = ledger?.solver as SolverState | undefined;
      // A resumed state is only usable if it belongs to THIS identity: hostnames
      // are recycled upstream, so a ledger can outlive the machine it describes,
      // and resuming onto a new password would never terminate.
      //
      // The MODEL is checked here and not inside `stateMatches`, which
      // recomputes the fingerprint from the state's own `model` and so can only
      // ever confirm what the state already believes. Two models with the same
      // length, the same format and no hint or data fingerprint identically —
      // `AccountsManager_4.2` and `NIL` do — and feeding one solver's scratch to
      // another does not fail politely: it spreads an `undefined` and THROWS,
      // which kills the agent process rather than failing the attempt.
      const usable = resumed !== undefined
          && resumed.model === details.modelId
          && stateMatches(resumed, facts)
        ? resumed
        : undefined;

      /** The marker this identity is parked under once it is eliminated. */
      const exhaustedState = (): SolverState =>
        freshState(details.modelId as ModelId, facts, EXHAUSTED);

      const deadline = Date.now() + ATTEMPT_WALL_MS;
      const budget = solver.budget(facts);
      // An identity we have already eliminated. Costs nothing and spends no
      // call: see `EXHAUSTED`.
      if (usable?.phase === EXHAUSTED) {
        count(SOLVER_CODES.SolverExhausted);
        return settle(false, `${state.host}: this identity was eliminated already`);
      }
      // A state is only RESUMABLE when a pending attempt travels with it: the
      // `Solver` contract offers `first()` and `next(state, observation)` and
      // nothing in between, so without the attempt whose answer advances it
      // there is no way back into the conversation and the solve restarts.
      const resuming = usable !== undefined && typeof usable.scratch[PENDING] === "string";
      // Carried forward only when we are actually continuing. Charging a
      // restarted solve for the attempts it is NOT building on would shrink its
      // budget every time it was interrupted, until `spent >= budget` fired on
      // the first pass and the host could never be opened at all.
      let spent = resuming ? usable!.spent : 0;
      let step: SolverStep;

      if (resuming && spent >= budget) {
        // THE BUDGET BOUNDS THE RESUME, and it has to: the resume path sends its
        // pending attempt before the loop's own check is ever reached, so
        // without this a solve that had spent its budget made one more exchange
        // on every vantage, for ever — `solver.next` handed back a fresh pending
        // each time, the task re-derived on the next tick, and the declared
        // "most attempts this solver may spend on one identity" was exceeded
        // without bound. Stopping here costs nothing and keeps the state
        // resumable, so a later budget change picks the conversation back up.
        count(SOLVER_CODES.SolverBudget);
        return settle(
          false,
          `${state.host}: solve is at its ${budget}-attempt budget`,
          withoutPending(usable!),
          usable!.scratch[PENDING] as string,
        );
      }
      if (resuming) {
        // --- resuming a conversation the previous vantage did not finish -----
        //
        // A solver's state pairs with the attempt it was about to make, and the
        // answer to that attempt is what advances it. The previous job sent that
        // attempt and never heard back, so what has to be recovered is the
        // ANSWER, not the state.
        //
        // Re-sending the same password recovers it exactly: every model's
        // response is a pure function of (password, attempt), so the reply is
        // the one that was lost. That is why this is a resume rather than an
        // approximation — and it costs exactly one exchange, against restarting
        // a search that may have been thirty deep.
        const pending = usable.scratch[PENDING] as string;
        const seen = await send(pending, true);
        if (seen.success) return settle(true, `opened ${state.host}`);
        if (seen.code === 351 || seen.code === 503) {
          return settle(false, `${state.host}: lost the vantage again`, usable);
        }
        step = solver.next(facts, withoutPending(usable), seen);
      } else {
        step = solver.first(facts);
      }

      while (step.kind !== "give-up") {
        if (Date.now() > deadline || spent >= budget) {
          count(SOLVER_CODES.SolverBudget);
          return settle(
            false,
            `${state.host}: solve paused after ${spent} attempts`,
            step.kind === "attempt" ? step.state : undefined,
            step.password,
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
          return settle(false, `${state.host}: no readable response`, step.state, step.password);
        }
        step = solver.next(facts, step.state, seen);
      }

      count(step.code);
      return settle(
        false,
        `${state.host}: ${step.reason}`,
        step.code === SOLVER_CODES.SolverExhausted ? exhaustedState() : step.state,
      );
    }

    // --- no solver: a dictionary walk, or the one deliberate probe -----------
    const plan = planAttempt(entry, facts, ledger?.tried ?? 0, ledger?.probes ?? 0);
    if (plan.kind === "none") return { ok: false, codes: { "904": 1 }, detail: plan.reason };
    const seen = await send(plan.password, true);
    if (plan.kind === "candidate" && attempts.length > 0) {
      attempts[attempts.length - 1]!.candidateIndex = plan.index;
    }
    return settle(seen.success, seen.success ? `opened ${state.host}` : `${state.host}: ${plan.password} refused`);
  };

  /** connectToSession + scp + exec: put a resident on a host we have opened.
   *
   * `connectToSession` rather than `authenticate`, and that choice is what makes
   * the whole spawn design affordable. The credential was won by a PREVIOUS
   * process and its session died with that PID. Re-opening one costs 0.05 GB and
   * no time at all; authenticating again would cost 0.4 GB and seconds of it,
   * every time an agent chained.
   *
   * `exec` and not `spawn` here, because the target is a DIFFERENT host: spawn
   * only ever starts a script where the caller already is. */
  const plantJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    if (state.password === undefined) return { ok: false, codes: { "902": 1 }, detail: "no credential" };
    // connectToSession is the cheap path, and it only works on a host that is
    // ALREADY ROOTED — `requireAdminRights`, which only a successful
    // `authenticate` ever sets. A credential harvested from a log is for a host
    // we may never have authenticated to, so the first use of one has to be the
    // expensive call. Trying the cheap one first and falling back keeps a
    // re-planted host at 0.05 GB while still opening a leaked one at all.
    let session = jobNs["dnet"]["connectToSession"](state.host, state.password);
    jobCodes[String(session.code)] = (jobCodes[String(session.code)] ?? 0) + 1;
    if (!session.success) {
      session = await jobNs["dnet"]["authenticate"](state.host, state.password);
      jobCodes[String(session.code)] = (jobCodes[String(session.code)] ?? 0) + 1;
    }
    if (!session.success) return { ok: false, codes: jobCodes, detail: session.message };
    if (!jobNs["scp"](state.payloads ?? [], state.host, state.from)) {
      return { ok: false, codes: jobCodes, detail: "scp refused" };
    }
    const pid = jobNs["exec"](
      (state.payloads ?? [])[0]!,
      state.host,
      // Priced with the JOB's ns, in the job's own process. The controller could
      // pass a number, but a stale one would under-allocate the resident and
      // kill it on its first call — and this is free.
      { threads: 1, ramOverride: priceAgent(jobNs, RESIDENT_METHODS), temporary: true },
      ...(state.plantArgs ?? []),
    );
    if (pid === 0) {
      jobCodes["903"] = 1;
      return { ok: false, codes: jobCodes, detail: "exec refused: no room for a resident" };
    }
    return { ok: true, codes: jobCodes, hosts: [describeHost(jobNs, state.host)], detail: `resident pid ${pid}` };
  };

  // --- the farm ------------------------------------------------------------
  //
  // Three calls that need no credential and no neighbour, because all three act
  // on the host the process is already standing on. They are BATCHES rather than
  // single calls: one `memoryReallocation` is a six-second wait, and paying the
  // 2.0 GB spawn back plus a full controller tick per six seconds would spend
  // more on scheduling than on the work. Every batch is bounded well under
  // `JOB_TIMEOUT_MS`, which is what leaves `longLived` with no user here at all.

  /** memoryReallocation, in a bounded grind.
   *
   * It works on the CALLING host with no credential. The call declares
   * `requireAdminRights`, but `checkDarknetServer` evaluates the direct-
   * connection requirement first and then early-outs on self
   * (`offlineServerHandling.ts:98-101`) BEFORE the admin-rights check is
   * reached — so a resident grinds its own owner's block open for free. That is
   * what makes blocked RAM a problem the net can solve for itself. */
  const reclaimJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
    const startedAt = Date.now();
    let calls = 0;
    let cleared = false;
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
    }
    return {
      ok: calls > 0 || cleared,
      codes: jobCodes,
      // With the cache listing: the whole point of grinding a block to the end
      // is the file that lands when it reaches zero.
      hosts: [describeHost(jobNs, state.host, true)],
      detail: cleared
        ? `${state.host}: block cleared after ${calls} calls`
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
   * the controller should re-size this host's threads for money instead. */
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
      // full 1.3 GB of `ns.exec` to a controller pinned at 1.65.
      if (phished.success && phished.message.includes("Found a cache file")) {
        count(911);
        wonCache = true;
        break;
      }
    }
    return {
      ok: calls > 0,
      codes: jobCodes,
      hosts: [describeHost(jobNs, state.host)],
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
      return { ok: false, codes: { "902": 1 }, detail: "no cache filename; a job never invents one" };
    }
    const held = cacheFilesOn(jobNs, state.host);
    if (!held.includes(wanted)) {
      // The listing moved under us — someone else opened it, or the host was
      // restarted. Report the fresh one so the next derivation is right.
      return {
        ok: false,
        codes: { "404": 1 },
        hosts: [{ ...describeHost(jobNs, state.host), caches: held }],
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
        hosts: [{ ...describeHost(jobNs, state.host), caches: cacheFilesOn(jobNs, state.host) }],
        detail: `openCache threw on ${wanted}: ${String(error)}`.slice(0, 200),
      };
    }
    return {
      ok: opened.success,
      codes: { [String(opened.success ? 200 : 404)]: 1 },
      // `karmaLoss` comes back NEGATIVE and karma only ever moves down, so it is
      // free progress toward the gang threshold. The controller accumulates it
      // and publishes the total for `gang` to read.
      ...(opened.success ? { karmaLoss: opened.karmaLoss } : {}),
      hosts: [{ ...describeHost(jobNs, state.host), caches: cacheFilesOn(jobNs, state.host) }],
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
      return { ok: false, codes: { "902": 1 }, detail: "no symbol; a job never invents one" };
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
  const induceJob = async (jobNs: NS, state: DnetJobState, beat?: JobBeat): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
    const before = jobNs["dnet"]["getServerDetails"](state.host);
    const startedAt = Date.now();
    let calls = 0;
    for (;;) {
      // The wait is a hardcoded 6 s that no skill shortens, so the batch fits
      // six of them and the check is made before the call rather than after.
      if (Date.now() + INDUCE_WAIT_MS > startedAt + FARM_BATCH_MS) break;
      const pushed = await jobNs["dnet"]["induceServerMigration"](state.host);
      count(pushed.code);
      if (!pushed.success) break;
      calls++;
      beat?.({ calls });
    }
    const after = describeHost(jobNs, state.host);
    const moved = before.isOnline && after.present === true && after.depth !== before.depth;
    return {
      ok: calls > 0,
      codes: jobCodes,
      hosts: [after],
      detail: moved
        ? `${state.host} migrated from depth ${before.depth} to ${after.depth} after ${calls} calls`
        : `${calls} calls of charge against ${state.host}`,
    };
  };

  /** setStasisLink, on the calling host and taking no target.
   *
   * Two things make this job unlike every other one. It costs 12 GB, which is
   * three quarters of a shallow host's entire RAM — so its allocation drops the
   * 2.0 GB spawn back and the process simply ENDS, leaving the host for
   * `planSpread` to re-plant. And what it buys is not a capability but an
   * absence: a pinned host is outside `getAllMovableDarknetServers`, so no
   * mutation branch can move it, delete it or restart it.
   *
   * `453 StasisLinkLimitReached` is the refusal that matters, and it is not an
   * error: the limit is `1 + TheBrokenWings + TheHammer + TheStaff`, so it is 1
   * until the labyrinth starts paying out, and a 453 means home's belief about
   * which hosts are pinned has drifted from the engine's. */
  const pinJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const pinned = await jobNs["dnet"]["setStasisLink"](true);
    return {
      ok: pinned.success,
      codes: { [String(pinned.code)]: 1 },
      hosts: [describeHost(jobNs, state.host)],
      detail: pinned.success ? `${state.host} is pinned` : `${state.host}: ${pinned.message}`,
    };
  };

  /** The maze walker: `authenticate(lab, <direction>)`, over and over.
   *
   * THE ONE JOB THAT MUST NEVER END EARLY. Position is
   * `DarknetState.labLocations[pid]`, so a dead PID abandons the walk and the
   * next process is re-seeded at the start — there is no resuming, and a deep
   * lab is thousands of moves. That is why it is the only `longLived` kind, why
   * it beats every move, and why its host is the first thing a stasis link is
   * spent on.
   *
   * The lab is the one model that answers through `authenticate`'s own return
   * value: `message` carries the new coordinates and `data` a radius-1 render,
   * so there is no `heartbleed` round trip and no need for `labradar` — which
   * would cost a full authentication time for a radius-3 look at the same
   * information.
   *
   * **A wall refusal leaves the position UNCHANGED.** The engine tests the cell
   * BETWEEN us and the target and returns "You are still at X,Y" without
   * moving, so every position comes from parsing the response rather than from
   * assuming the move worked. */
  const walkJob = async (jobNs: NS, state: DnetJobState, beat?: JobBeat): Promise<DnetJobResult> => {
    const jobCodes: Record<string, number> = {};
    const count = (code: number | string): void => {
      jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
    };
    const stage = labStage(state.host);
    const details = jobNs["dnet"]["getServerDetails"](state.host);
    if (!details.isOnline) {
      return { ok: false, codes: { "503": 1 }, detail: `${state.host} is offline` };
    }
    // Below the lab's charisma every single move answers 451 and nothing is
    // learned. Refusing to start is the difference between a job that reports
    // a career need and one that spends an hour collecting 451s.
    if (details.requiredCharismaSkill > deps.charisma()) {
      return {
        ok: false,
        codes: { "451": 1 },
        hosts: [describeHost(jobNs, state.host)],
        charismaNeeded: details.requiredCharismaSkill,
        detail: `${state.host} needs charisma ${details.requiredCharismaSkill}`,
      };
    }
    const bounds = stage ? labMazeSize(stage) : undefined;
    let known = emptyMaze();
    let at: Cell | undefined;
    /** The radius-1 render the LAST response carried. It is the only vision the
     *  walker has, and it arrives with the move rather than being asked for. */
    let lastRender = "";
    let moves = 0;
    let walls = 0;
    for (;;) {
      // The direction word IS the password. `getDirectionFromInput` splits on
      // spaces and takes the first token that parses, so "north" and "go north"
      // are the same move and the shorter one is one less thing to get wrong.
      //
      // The FIRST call has no known position, so it is a deliberate probe: any
      // direction answers with our coordinates, whether it moves us or not.
      const step = at === undefined
        ? { kind: "go" as const, direction: "north" as const, known, note: "first look" }
        : stepMaze(known, at, lastRender, bounds);
      if (step.kind !== "go") {
        return {
          ok: false,
          codes: jobCodes,
          hosts: [describeHost(jobNs, state.host)],
          detail: `${state.host}: ${step.reason}`.slice(0, 200),
        };
      }
      const answer = await jobNs["dnet"]["authenticate"](state.host, step.direction);
      count(answer.code);
      if (answer.success) {
        return {
          ok: true,
          codes: jobCodes,
          hosts: [describeHost(jobNs, state.host, true)],
          detail: `${state.host}: reached the exit after ${moves} moves`,
        };
      }
      // A move that never reached the model — the host moved, or we lost the
      // charisma gate mid-walk. Neither is recoverable from here, and the walk
      // is lost with the PID either way, so stop rather than spin.
      if (answer.code !== 401) {
        return {
          ok: false,
          codes: jobCodes,
          hosts: [describeHost(jobNs, state.host)],
          ...(answer.code === 451 ? { charismaNeeded: details.requiredCharismaSkill } : {}),
          detail: `${state.host}: ${answer.message}`.slice(0, 200),
        };
      }
      const where = readCoords(answer.message);
      if (where === undefined) {
        // The grammar moved. Stopping is right: a walker that cannot read its
        // own position would walk into the same wall for hours.
        count(909);
        return {
          ok: false,
          codes: jobCodes,
          hosts: [describeHost(jobNs, state.host)],
          detail: `${state.host}: could not read a position out of the response`,
        };
      }
      const moved = at === undefined || where[0] !== at[0] || where[1] !== at[1];
      if (at !== undefined && moved) moves++;
      if (at !== undefined && !moved) {
        walls++;
        // THE RENDER SAID THIS WAY WAS OPEN AND THE ENGINE DISAGREED. Record the
        // refusal, or the next `stepMaze` reaches the identical decision off the
        // identical render and this wall is bumped until the host dies — which
        // no watchdog would catch, because the beat below keeps stamping. The
        // trail is kept as it was: a step that did not happen has not earned a
        // way back from anywhere.
        known = markBlocked({ ...(step.known ?? known), trail: known.trail }, at, step.direction);
      } else {
        known = step.known ?? known;
      }
      at = where;
      lastRender = String(answer.data ?? "");
      beat?.({ at: `${where[0]},${where[1]}`, moves, walls, visited: known.visited.length });
    }
  };

  // Keyed by `TaskKind`, and `survey` is the fallback the controller uses for a
  // kind it does not recognise: surveying is the one job that is safe to do to
  // anything, because it only looks.
  return {
    survey: surveyJob,
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
  };
}

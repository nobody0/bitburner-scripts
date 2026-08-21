import type { NS } from "@ns";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import type { AgentBeat, ReportHost, VaultEntry } from "../../shared/strategy/dnet/courier.ts";
import { parseOverseerArgs, residentArgs } from "../../shared/strategy/dnet/mission.ts";
import {
  coverage,
  emptyKnowledge,
  foldObservations,
  freeRam,
  fresh,
  type DarknetKnowledge,
} from "../../shared/strategy/dnet/knowledge.ts";
import { deriveTasks, type Task } from "../../shared/strategy/dnet/queue.ts";
import { DEFAULT_SPREAD_LIMITS, planSpread, type SpreadCandidate } from "../../shared/strategy/dnet/spread.ts";
import { modelEntry, planAttempt } from "../../shared/strategy/dnet/models.ts";
import { harvestLogs } from "../../shared/strategy/dnet/oracle.ts";
import {
  JOB_METHODS,
  JOB_TIMEOUT_MS,
  RENDEZVOUS_PROTOCOL,
  RESIDENT_METHODS,
  dnetRealm,
  priceAgent,
  overseerIsLive,
  sweepQueues,
  type DnetHostQueue,
  type DnetJob,
  type DnetJobResult,
  type DnetJobState,
  type DnetOrders,
  type DnetRendezvous,
} from "./realm.ts";
import { initTelemetry } from "../lib/telemetry.ts";

/** The darknet controller: one long-lived script that decides, and never acts.
 *
 * It exists because of a shape the darknet forces on us. `probe()` is host-local
 * and `ns.scan` excludes the darknet, so the map can only be assembled by
 * scripts standing in different places — and those scripts are mortal, because
 * their hosts get restarted and deleted out from under them. Something has to
 * hold the accumulated picture and decide what happens next, and it cannot be
 * `home`: from there the darknet is one host wide.
 *
 * ## Why it cannot start anything itself
 *
 * It keeps state, so it must not die — and `spawn` kills its caller. It could
 * `exec`, but that leaves both processes resident, and on a darknet host the
 * second base plus 1.3 GB is usually RAM we do not have.
 *
 * So it does not launch work. It QUEUES work, per host, and the resident already
 * standing there spawns into it. The controller decides WHAT runs and in what
 * order; the resident decides WHEN, because only it can see how much RAM is free
 * at the instant it looks — and out here that moves without warning.
 *
 * ## What it costs
 *
 * base 1.6 + `getHostname` 0.05 = **1.65 GB static**, pinned by
 * tests/ram-budget.test.ts. Home launches it with a little more than that, since
 * every allocation carries `priceAgent`'s margin. Everything else it does is
 * free: `sleep` is 0 GB and the queues are live objects in the page realm.
 *
 * Deliberately absent: `probe`, `getServerDetails`, `heartbleed`, `authenticate`,
 * `scp`, `exec` and `spawn`. It cannot observe, cannot crack, and cannot launch.
 *
 * That absence is the design rather than an economy. A controller that COULD do
 * the work would, and then the process holding the only copy of the map would be
 * the one sitting inside a multi-second `authenticate` on a host about to be
 * restarted.
 *
 * ## How it describes work it cannot do
 *
 * The job bodies below run in the AGENT's process, not this one, and call
 * everything through bracket notation on the ns they are handed —
 * `jobNs["dnet"]["authenticate"]`. The static analyser therefore charges the
 * agent's declared `ramOverride` rather than this bundle, which is the same
 * trick `game/lib/dodge.ts` uses and the reason this file stays at 1.65 GB while
 * the work it describes costs several times that. */

/** How often the controller tells home it is alive. Home re-seeds if this stops. */
const BEAT_INTERVAL_MS = 15_000;
/** How often it reconsiders the queues. `ns.sleep` is 0 GB, so this is only a
 * question of how promptly a freshly-queued job starts. */
const TICK_MS = 2_000;
/** Jobs queued per host at once. The resident runs them one at a time, and a
 * deep queue is just a stale plan: the net rearranges itself every few seconds. */
const MAX_QUEUED_PER_HOST = 3;
/** Log lines pulled per bleed. `peek` leaves them, so this does not consume
 * evidence another agent may want, and the ring holds 200. */
const LOG_LINES = 8;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const mission = parseOverseerArgs(ns.args);
  if (!mission) return;

  const realm = dnetRealm();
  const bootAt = Date.now();
  // Deferring to a live controller of the same generation is what makes a
  // re-seed idempotent: home may launch us whenever it is unsure, and the
  // redundant copy exits instead of running a second scheduler.
  if (overseerIsLive(realm.dnet_overseer, mission.generation, bootAt)) return;

  let identity: ArtifactIdentity | undefined;
  try {
    identity = JSON.parse(mission.identity) as ArtifactIdentity;
  } catch {
    /* Unreadable identity costs telemetry, never the work. */
  }

  let tel: ReturnType<typeof initTelemetry> | undefined;
  TELEMETRY: if (__TELEMETRY__) {
    if (identity) tel = initTelemetry(ns, ns.getScriptName(), identity);
  }

  const selfHost = ns.getHostname();
  const payloads = [mission.agentFile];
  let charisma = mission.charisma;
  let knowledge: DarknetKnowledge = emptyKnowledge(mission.generation);
  const vault = new Map<string, string>();
  const codes: Record<string, number> = {};
  const lastPlantAt = new Map<string, number>();
  const pendingHosts: ReportHost[] = [];
  const pendingCredentials: VaultEntry[] = [];
  const queues = new Map<string, DnetHostQueue>();
  let residentsSeenEver = 0;
  let residentsLost = 0;
  let standDown = false;

  const rendezvous: DnetRendezvous = {
    protocol: RENDEZVOUS_PROTOCOL,
    generation: mission.generation,
    controllerPid: ns.pid,
    startedAt: bootAt,
    lastBeatAt: bootAt,
    queues,
    // Home's whole view of the darknet, handed over once and forgotten. See the
    // note on DnetRendezvous.drain for why it clears.
    drain() {
      const drained = {
        hosts: pendingHosts.splice(0, pendingHosts.length),
        credentials: pendingCredentials.splice(0, pendingCredentials.length),
        codes: { ...codes },
        residents: [...queues.values()].map((queue) => ({
          host: queue.host,
          lastBeatAt: queue.lastBeatAt,
          pending: queue.pending.length,
          ...(queue.active ? { active: queue.active.kind } : {}),
          ...(queue.freeGb !== undefined ? { freeGb: queue.freeGb } : {}),
        })),
        residentsLost,
      };
      for (const key of Object.keys(codes)) delete codes[key];
      residentsLost = 0;
      return drained;
    },
    order(orders: DnetOrders) {
      charisma = orders.charisma;
      for (const entry of orders.vault ?? []) vault.set(entry.hostname, entry.password);
      if (orders.standDown === true) standDown = true;
    },
  };
  // BOOTSTRAP. The queue is DERIVED from knowledge, so a controller that knows
  // nothing derives nothing and files no work — for ever. Recording that our own
  // host exists, with no facts at all, is what makes the first
  // `survey:<selfHost>` job appear: an absent adjacency IS the work, and the
  // resident standing here is the only thing that can learn it.
  knowledge = foldObservations(
    knowledge,
    [{
      from: selfHost,
      provenance: "agent",
      at: bootAt,
      generation: mission.generation,
      hosts: [{ hostname: selfHost, present: true, facts: {} }],
    }],
    bootAt,
  ).knowledge;

  realm.dnet_overseer = rendezvous;

  const note = (code: number, n = 1): void => {
    codes[String(code)] = (codes[String(code)] ?? 0) + n;
  };

  /** Fold a finished job's findings into the map, so the very next derivation
   * already accounts for them. This is the dedup: work a believable fact covers
   * does not exist, so a job that just refreshed one has, by returning, removed
   * the task that asked for it. No acknowledgement protocol, nothing to drift. */
  const absorb = (from: string, result: DnetJobResult): void => {
    const at = Date.now();
    if (result.hosts && result.hosts.length > 0) {
      knowledge = foldObservations(
        knowledge,
        [{ from, provenance: "agent", at, generation: mission.generation, hosts: result.hosts.map(toObserved) }],
        at,
      ).knowledge;
      pendingHosts.push(...result.hosts);
    }
    for (const entry of result.credentials ?? []) {
      if (entry.hostname.length === 0) continue;
      vault.set(entry.hostname, entry.password);
      const host = knowledge.hosts[entry.hostname];
      if (host) host.credentialKnown = true;
      pendingCredentials.push(entry);
    }
    for (const [code, count] of Object.entries(result.codes ?? {})) note(Number(code), count);
  };

  const recordAttempts = (hostname: string, result: DnetJobResult): void => {
    const host = knowledge.hosts[hostname];
    if (!host) return;
    for (const attempt of result.attempts ?? []) {
      const ledger = host.attempts ?? { tried: 0, probes: 0 };
      if (attempt.modelId !== undefined) ledger.modelId = attempt.modelId;
      if (attempt.status === "implemented") ledger.tried = (attempt.candidateIndex ?? ledger.tried) + 1;
      else ledger.probes += 1;
      ledger.lastAt = attempt.at;
      ledger.lastCode = attempt.code;
      if (attempt.oracle) ledger.lastOracle = attempt.oracle.data ?? attempt.oracle.message;
      if (attempt.success) ledger.solved = true;
      host.attempts = ledger;
    }
  };

  /** Queue one job on a host, and KEEP ITS PROMISE.
   *
   * The promise is how the controller tells "still working" from "died holding
   * the host", and out here the second is the common case: a mutation tick
   * restarts a server and takes whatever was running on it. A settled promise is
   * a result; one that never settles is a death, and the timeout below is what
   * turns the difference into a fact instead of a leak. */
  const enqueue = (queue: DnetHostQueue, draft: Omit<DnetJob, "settle" | "fail">): void => {
    if (queue.pending.length >= MAX_QUEUED_PER_HOST) return;
    if (queue.pending.some((entry) => entry.id === draft.id) || queue.active?.id === draft.id) return;
    const job = draft as DnetJob;
    const promise = new Promise<DnetJobResult>((resolve, reject) => {
      job.settle = resolve;
      job.fail = reject;
    });
    void promise.then(
      (result) => {
        absorb(queue.host, result);
        recordAttempts(job.state.host, result);
        if (job.kind === "plant" && result.ok) lastPlantAt.set(job.state.host, Date.now());
      },
      () => {
        note(903);
      },
    );
    queue.pending.push(job);
  };

  // --- the job bodies ------------------------------------------------------
  // Every one of these runs in the AGENT's process. Bracket notation throughout,
  // so this file pays nothing for calls it only describes.

  const describeHost = (jobNs: NS, host: string): ReportHost => {
    const details = jobNs["dnet"]["getServerDetails"](host);
    if (!details.isOnline) return { hostname: host, present: false };
    return {
      hostname: host,
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
    };
  };

  /** probe + getServerDetails. The only way to learn adjacency at all: probe is
   * host-local, so this fact can only come from a process standing here. */
  const surveyJob = async (jobNs: NS, state: DnetJobState): Promise<DnetJobResult> => {
    const around = jobNs["dnet"]["probe"]();
    const hosts: ReportHost[] = [{ hostname: state.from, present: true, neighbours: [...around] }];
    for (const host of around) hosts.push(describeHost(jobNs, host));
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
    return {
      ok: true,
      codes: jobCodes,
      credentials,
      hosts: [describeHost(jobNs, state.host)],
      detail: `${credentials.length} credentials, ${harvest.unrecognised.length} unrecognised lines`,
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
    const details = jobNs["dnet"]["getServerDetails"](state.host);
    if (!details.isOnline) return { ok: false, hosts: [{ hostname: state.host, present: false }], codes: { "503": 1 } };
    const entry = modelEntry(details.modelId);
    const ledger = knowledge.hosts[state.host]?.attempts;
    const plan = planAttempt(
      entry,
      {
        passwordLength: details.passwordLength,
        passwordFormat: details.passwordFormat,
        passwordHint: details.passwordHint,
        data: details.data,
        difficulty: details.difficulty,
      },
      ledger?.tried ?? 0,
      ledger?.probes ?? 0,
    );
    if (plan.kind === "none") return { ok: false, codes: { "904": 1 }, detail: plan.reason };

    const startedAttempt = Date.now();
    const answer = await jobNs["dnet"]["authenticate"](state.host, plan.password);
    const elapsedMs = Date.now() - startedAttempt;
    jobCodes[String(answer.code)] = (jobCodes[String(answer.code)] ?? 0) + 1;
    // A model id our transcription does not know is either a game update or a
    // hole in `shared/strategy/dnet/models.ts`. Counted so it shows up in the
    // response-code panel rather than passing as an ordinary auth failure.
    if (entry === undefined) jobCodes["900"] = (jobCodes["900"] ?? 0) + 1;

    // Read the ring back whatever happened: on a failure it holds the model's
    // response, and on a success it still holds whatever the host leaked while
    // we were working.
    const bled = await jobNs["dnet"]["heartbleed"](state.host, { peek: true, logsToCapture: LOG_LINES });
    const harvest = bled.success ? harvestLogs(bled.logs, state.host) : undefined;
    const credentials: VaultEntry[] = (harvest?.credentials ?? []).map((found) => ({
      hostname: found.host!,
      password: found.password,
      via: "leak" as const,
      at: Date.now(),
    }));
    if (answer.success) {
      credentials.push({ hostname: state.host, password: plan.password, via: "cracked", at: Date.now() });
    }
    return {
      ok: answer.success,
      codes: jobCodes,
      credentials,
      hosts: [describeHost(jobNs, state.host)],
      attempts: [{
        at: startedAttempt,
        ...(details.modelId !== undefined ? { modelId: details.modelId } : {}),
        status: entry === undefined ? "unknown-model" : entry.status,
        ...(plan.kind === "candidate" ? { candidateIndex: plan.index } : {}),
        attempted: plan.password,
        code: answer.code,
        success: answer.success,
        elapsedMs,
        ...(harvest?.oracles[0] ? { oracle: harvest.oracles[0] } : {}),
      }],
      detail: answer.success ? `opened ${state.host}` : answer.message,
    };
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

  // What each job costs the host that runs it, priced from the game's own
  // table. `ns.getFunctionRamCost` is 0 GB, so this is free.
  const budgets: Record<string, number> = Object.fromEntries(
    Object.entries(JOB_METHODS).map(([kind, methods]) => [kind, priceAgent(ns, methods)]),
  );
  const residentGb = priceAgent(ns, RESIDENT_METHODS);

  const bodyFor = (kind: string): DnetJob["body"] => {
    if (kind === "bleed") return bleedJob;
    if (kind === "attempt") return attemptJob;
    if (kind === "plant") return plantJob;
    return surveyJob;
  };

  const spreadCandidates = (at: number): SpreadCandidate[] => {
    const standing = new Set([selfHost, ...queues.keys()]);
    const out: SpreadCandidate[] = [];
    for (const host of Object.values(knowledge.hosts)) {
      if (standing.has(host.hostname)) continue;
      let from: string | undefined;
      for (const where of standing) {
        const neighbours = fresh<string[]>(knowledge.hosts[where], "neighbours", at);
        if (neighbours?.includes(host.hostname)) {
          from = where;
          break;
        }
      }
      if (from === undefined) continue;
      out.push({
        host: host.hostname,
        from,
        ...(fresh<number>(host, "depth", at) !== undefined ? { depth: fresh<number>(host, "depth", at)! } : {}),
        freeRam: freeRam(host, at),
        hasCredential: vault.has(host.hostname),
        agentAlive: false,
        ...(lastPlantAt.has(host.hostname) ? { lastPlantAt: lastPlantAt.get(host.hostname)! } : {}),
        ...(host.goneAt !== undefined ? { goneAt: host.goneAt } : {}),
      });
    }
    return out;
  };

  /** Turn the derived task list into queued jobs, filed against the host a
   * resident would have to be standing on to do them. */
  const fileWork = (at: number): Task[] => {
    const plan = planSpread(spreadCandidates(at), DEFAULT_SPREAD_LIMITS, at, queues.size);
    const tasks = deriveTasks(knowledge, at, {
      agents: new Set([selfHost, ...queues.keys()]),
      vault: new Set(vault.keys()),
      plantable: plan.plant.map((entry) => ({ host: entry.host, from: entry.from })),
    });
    for (const task of tasks) {
      const queue = queues.get(task.from);
      // No resident there: nothing can run it, and filing it would be a plan for
      // a machine we cannot reach.
      if (!queue) continue;
      const budget = budgets[task.kind] ?? budgets["survey"]!;
      // The resident's own allocation comes back when it spawns, so that is what
      // a job actually gets. Skipping here rather than queueing keeps a job that
      // can never fit from blocking the ones that can.
      if (queue.freeGb !== undefined && budget > queue.freeGb + residentGb) continue;
      enqueue(queue, {
        id: task.id,
        kind: task.kind,
        label: task.reason,
        budgetGb: budget,
        // Everything here finishes on its own. The flag exists for the work that
        // will not — phishing, a stasis hold — which the controller has to watch
        // rather than assume.
        longLived: false,
        state: {
          host: task.host,
          from: task.from,
          ...(vault.has(task.host) ? { password: vault.get(task.host)! } : {}),
          ...(task.kind === "plant"
            ? {
              payloads,
              plantArgs: residentArgs({
                missionId: mission.missionId,
                generation: mission.generation,
                identity: mission.identity,
                agentId: `resident-${task.host}`,
              }),
            }
            : {}),
        },
        body: bodyFor(task.kind),
      });
    }
    return tasks;
  };

  let lastBeat = bootAt;

  while (!standDown) {
    const at = Date.now();
    rendezvous.lastBeatAt = at;

    // The condition the realm exception rests on: entries are expired by the
    // controller, never trusted. A resident dies with its host, and a queue left
    // behind would be a plan for a machine that is gone.
    for (const dead of sweepQueues(queues, at)) {
      residentsLost++;
      // Fail what it was holding, so a promise nobody will ever settle does not
      // sit in memory pretending to be work in progress.
      if (dead.active) dead.active.fail(new Error(`${dead.host} lost its resident mid-job`));
      for (const job of dead.pending) job.fail(new Error(`${dead.host} lost its resident`));
    }
    // A job whose process was killed never settles. The timeout is what turns
    // that into a counted fact rather than a leak.
    for (const queue of queues.values()) {
      const active = queue.active;
      if (active?.startedAt !== undefined && !active.longLived && at - active.startedAt > JOB_TIMEOUT_MS) {
        queue.active = undefined;
        queue.failed++;
        active.fail(new Error(`${active.label} timed out on ${queue.host}`));
      }
    }
    residentsSeenEver = Math.max(residentsSeenEver, queues.size);

    const tasks = fileWork(at);

    if (at - lastBeat >= BEAT_INTERVAL_MS) {
      lastBeat = at;
      TELEMETRY: if (__TELEMETRY__ && tel) {
        tel.mirror(`dnet.overseer:${selfHost}`, {
          at,
          host: selfHost,
          charisma,
          residents: queues.size,
          residentsSeenEver,
          residentsLost,
          coverage: coverage(knowledge, at),
          tasks: tasks.length,
          queued: [...queues.values()].map((queue) => ({
            host: queue.host,
            pending: queue.pending.length,
            active: queue.active?.kind,
            freeGb: queue.freeGb,
            completed: queue.completed,
            failed: queue.failed,
            ...(queue.lastError !== undefined ? { lastError: queue.lastError } : {}),
          })),
        });
      }
    }

    await ns.sleep(TICK_MS);
  }

  if (realm.dnet_overseer === rendezvous) delete realm.dnet_overseer;
  TELEMETRY: if (__TELEMETRY__ && tel) tel.flush();
}

/** `ReportHost` as the fold wants it. Here rather than in `courier.ts` because
 * the controller is the only thing that folds a job result directly. */
function toObserved(host: ReportHost): { hostname: string; present: boolean; facts: Record<string, unknown> } {
  const { hostname, present, ...facts } = host;
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) if (value !== undefined) defined[key] = value;
  return { hostname, present, facts: present ? defined : {} };
}

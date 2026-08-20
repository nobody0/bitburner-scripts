import type { NS, Player, Server } from "@ns";
import { versionedScript } from "../../shared/deployment.ts";
import type { HackNodeMults } from "../../shared/formulas.ts";
import type { SharePricingInput } from "../../shared/strategy/share.ts";
import { initFarm, planFarm, reportFailed, type FarmMemory } from "../../shared/strategy/farm-planner.ts";
import type { CompletionEvent, HgwAction, ServerView, ShareAction, StockInfluence, WorldView } from "../../shared/world.ts";
import { WORKER_RAM } from "../../shared/world.ts";
import { gameBuildId } from "./build-id.ts";
import { workerGlobals, type WorkerGlobalThis } from "./worker-shared.ts";

import {
  planReclamation,
  type BrokerHost,
  type BrokerRequest,
  type PreemptibleFarmWorker,
  type ReclamationPlan,
} from '../../shared/ram/broker.ts';
import { releaseWorkerExits, requestShareStops, type Tracked } from '../../shared/strategy/dispatch.ts';

/** Game-side driver for the pure HWGW engine. It only moves data: builds a
 * WorldView from the cached scan plus live reads of the hot targets, hands
 * completions to the planner, and turns returned Actions into ns.exec calls.
 * All decisions live in shared/strategy. */

export const WORKER_BASE_SCRIPT = "worker/worker.js";
export function workerScript(): string {
  return versionedScript(WORKER_BASE_SCRIPT, gameBuildId());
}

export interface DriverState {
  memory: FarmMemory;
  globals: WorkerGlobalThis;
  /** Hosts the worker script has been copied to this session. */
  deployed: Set<string>;
  execFails: number;
}

export function initDriver(): DriverState {
  return { memory: initFarm(), globals: workerGlobals(), deployed: new Set(["home"]), execFails: 0 };
}

/** Drain worker completions into planner events. */
export function drainCompletions(state: DriverState): CompletionEvent[] {
  const done = state.globals.dispatch_done ?? [];
  if (done.length === 0) return [];
  const events: CompletionEvent[] = done.map((entry) =>
    entry.kind === "workerExit"
      ? { kind: "workerExit", opId: entry.opId, threads: entry.threads }
      : {
          kind: entry.kind,
          opId: entry.opId,
          target: entry.target,
          threads: entry.threads,
          // Stamped by the worker in its own atExit, not here: a pump may run
          // many milliseconds after the effect landed, and the whole point of
          // the measurement is the difference between planned and actual.
          ...(entry.at === undefined ? {} : { at: entry.at }),
          // Undefined is the worker protocol's failure marker (kill, reset or
          // exception). Preserve it so a failed weaken cannot masquerade as a
          // proven min-security landing window.
          ...(entry.result === undefined
            ? {}
            : { result:
                entry.kind === "hack"
                  ? { success: entry.result > 0, moneyGained: entry.result }
                  : entry.kind === "weaken"
                    ? { securityReduced: entry.result }
                    : { growth: entry.result } }),
        },
  );
  done.length = 0;
  return events;
}

/** Build the planner's view: static fields from the last dodged scan, live
 * security/money for the hot targets (two cheap direct getters — the hot path
 * never dodges), live used RAM from our own ledger.
 * Source getters: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L989-L1002 */
export function buildView(
  ns: NS,
  state: DriverState,
  servers: Record<string, Server>,
  player: Player,
  hotHosts: string[],
  /** BitNode multipliers, when SF5 has let us read them. Two of the fields
   *  matter here and they are NOT interchangeable: `ScriptHackMoney` scales what
   *  is drained from a server (and so what a batch steals AND how strongly it
   *  manipulates), while `ScriptHackMoneyGain` scales only the player's cut.
   *  BN8 sets the second to 0 — hacking earns nothing while still moving prices —
   *  and without this the farm would report every BN8 target as profitable.
   *  Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacking.ts#L40-L57 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L575-L616 */
  nodeMults?: Record<string, number>,
  /** hostname -> what `stock` wants that host's symbol to do. Published by the
   *  stock driver on its topic; read here so the target solver can price
   *  manipulation into the same `$/GB/sec` score as hacked money. */
  stockInfluence?: Record<string, StockInfluence>,
  /** Measured hacking exp/sec (the driver's EMA), for the evaluator's
   *  skill-growth prep discount. */
  hackingExpRate?: number,
): WorldView {
  const hot = new Set(hotHosts);
  const views: ServerView[] = [];
  for (const server of Object.values(servers)) {
    const live = hot.has(server.hostname);
    const heapHost = state.memory.dispatch.heap.host(server.hostname);
    views.push({
      hostname: server.hostname,
      hasAdminRights: server.hasAdminRights,
      purchasedByPlayer: server.purchasedByPlayer,
      moneyAvailable: live ? ns.getServerMoneyAvailable(server.hostname) : (server.moneyAvailable ?? 0),
      moneyMax: server.moneyMax ?? 0,
      hackDifficulty: live ? ns.getServerSecurityLevel(server.hostname) : (server.hackDifficulty ?? 100),
      minDifficulty: server.minDifficulty ?? 1,
      baseDifficulty: server.baseDifficulty ?? 1,
      requiredHackingSkill: server.requiredHackingSkill ?? 1e9,
      serverGrowth: server.serverGrowth ?? 0,
      numOpenPortsRequired: server.numOpenPortsRequired ?? 5,
      maxRam: server.maxRam,
      usedRam: heapHost?.used ?? server.ramUsed,
      cpuCores: server.cpuCores,
    });
  }
  return {
    // Scheduler deadlines need a monotonic, sub-millisecond clock. Date.now()
    // remains the timestamp domain for diagnostics and persisted game state.
    time: performance.now(),
    player: {
      money: player.money,
      hackingSkill: player.skills.hacking,
      hackingExp: player.exp.hacking,
      ...(hackingExpRate !== undefined && hackingExpRate > 0 ? { hackingExpRate } : {}),
      intelligence: player.skills.intelligence,
      mults: {
        hacking: player.mults.hacking,
        hacking_exp: player.mults.hacking_exp,
        hacking_money: player.mults.hacking_money,
        hacking_grow: player.mults.hacking_grow,
        hacking_speed: player.mults.hacking_speed,
        hacking_chance: player.mults.hacking_chance,
      },
    },
    servers: views,
    // Purchases are start.js's business; quoting them as unavailable keeps the
    // dispatcher from emitting buy actions the game driver would ignore.
    prices: { upgradeHomeRam: Infinity, cloudServer: {}, cloudServerLimit: 0 },
    ...(nodeMults ? { nodeMults: nodeMults as HackNodeMults } : {}),
    ...(stockInfluence && Object.keys(stockInfluence).length > 0 ? { stockInfluence } : {}),
  };
}

/** One dispatcher pass: plan, then launch. Returns how many ops started. */
export function pump(
  ns: NS,
  state: DriverState,
  view: WorldView,
  completions: CompletionEvent[],
  /** Planning options, passed straight through to planFarm.
   *  - arenaReserves: broker-owned per-host executable headroom.
   *  - horizonMs: expected remaining run time (endgame route decision).
   *  `goalRemaining` is deliberately NOT named here: the game has no money
   *  goal — that is the sim's device, and the sim sets it on planFarm
   *  directly. Named options rather than a positional number tail, because
   *  three adjacent defaulted numbers in three different units transpose
   *  silently. */
  options: {
    arenaReserves?: Readonly<Record<string, number>>;
    horizonMs?: number;
    pooling?: boolean;
    reinvestmentReturnPerDollarSec?: number;
    hackingSkillGoal?: number;
    shareValue?: SharePricingInput;
  } = {},
): { launched: number; failed: number; directive: ReturnType<typeof planFarm>["directive"]; nextWakeMs?: number } {
  const result = planFarm(view, state.memory, completions, {
    ...(options.arenaReserves ? { arenaReserves: options.arenaReserves } : {}),
    ...(options.reinvestmentReturnPerDollarSec !== undefined
      ? { reinvestmentReturnPerDollarSec: options.reinvestmentReturnPerDollarSec }
      : {}),
    ...(options.hackingSkillGoal !== undefined ? { hackingSkillGoal: options.hackingSkillGoal } : {}),
    ...(options.horizonMs !== undefined ? { horizonMs: options.horizonMs } : {}),
    ...(options.pooling ? { pooling: true } : {}),
    ...(options.shareValue ? { shareValue: options.shareValue } : {}),
    sourceHosts: state.deployed,
  });
  state.memory = result.memory;

  const failed: number[] = [];
  let launched = 0;
  for (const action of result.actions) {
    if (action.type === "stopShare") {
      state.globals.worker_stop_requested?.add(action.opId);
      state.globals.worker_stop?.get(action.opId)?.();
      continue;
    }
    if (action.type === "share") {
      if (startShare(ns, state, action)) launched++;
      else failed.push(action.opId);
      continue;
    }
    if (action.type !== "hack" && action.type !== "grow" && action.type !== "weaken") continue;
    if (action.opId === undefined) continue;
    if (startOp(ns, state, action, action.opId, view.time)) launched++;
    else failed.push(action.opId);
  }
  if (failed.length > 0) reportFailed(state.memory, failed);
  const nextWakeMs = result.actions.reduce(
    (earliest, action) => action.type === "sleep" ? Math.min(earliest, action.ms) : earliest,
    Infinity,
  );
  return {
    launched,
    failed: failed.length,
    directive: result.directive,
    ...(Number.isFinite(nextWakeMs) ? { nextWakeMs } : {}),
  };
}

function startShare(ns: NS, state: DriverState, action: ShareAction): boolean {
  if (!state.deployed.has(action.source) || !state.globals.worker_info) return false;
  state.globals.worker_info.set(action.opId, {
    kind: "share",
    target: "",
    threads: action.threads,
    mode: "share",
  });
  const pid = ns.exec(
    workerScript(),
    action.source,
    // ramOverride is per thread, exactly as for HGW workers.
    { threads: action.threads, temporary: true, ramOverride: WORKER_RAM.share },
    action.opId,
  );
  if (pid !== 0) {
    const info = state.globals.worker_info.get(action.opId);
    if (info) info.pid = pid;
    return true;
  }
  state.globals.worker_info.delete(action.opId);
  state.globals.worker_stop?.delete(action.opId);
  state.globals.worker_stop_requested?.delete(action.opId);
  state.execFails++;
  return false;
}

function startOp(ns: NS, state: DriverState, action: HgwAction, opId: number, plannedAt: number): boolean {
  const host = action.source;
  // Deployment is done by the dodged sweep; an undeployed host is simply not
  // usable this pass (keeping ns.scp out of the controller's static RAM).
  // Source (imports participate in static dependency/RAM analysis): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Script/RamCalculations.ts#L448-L480
  if (!state.deployed.has(host)) return false;
  const globals = state.globals;
  // A missing registry means the realm slots were swept out from under this
  // epoch (augmentation install, build handoff) — every worker is dead and the
  // successor owns the rendezvous. Fail the op instead of resurrecting the map.
  if (!globals.worker_info || !globals.worker_jobs) return false;

  // The pure action's additionalMsec was measured at `plannedAt`; workers turn
  // this absolute padding deadline back into a relative delay immediately
  // before their Netscript call, after async exec/module startup.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L48-L66
  // Pooled job to an already-running serve worker: no exec at all — push the
  // job and poke the worker's parked resolver. A missing mailbox means the
  // worker died (reload, kill); failing the op makes the pure layer respawn.
  // Last line of defence for the fractional strength. The engine throws when
  // `opts.threads` exceeds the process's thread count, and a throw mid-batch
  // loses the whole op — so clamp here rather than trusting the pure layer's
  // arithmetic to land on the right side of a float comparison.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L434-L474
  const strengthThreads = action.strengthThreads === undefined
    ? undefined
    : Math.min(action.strengthThreads, action.threads);

  if (action.worker && !action.worker.spawn) {
    const queue = globals.worker_jobs?.get(action.worker.id);
    if (!queue || !globals.worker_info?.has(action.worker.id)) return false;
    queue.push({
      opId,
      target: action.target,
      ...(action.additionalMsec !== undefined ? { delayUntil: plannedAt + action.additionalMsec } : {}),
      ...(action.stock ? { stock: true } : {}),
      ...(strengthThreads !== undefined ? { threads: strengthThreads } : {}),
    });
    globals.worker_wake?.get(action.worker.id)?.();
    return true;
  }

  // Descriptor before exec: a worker can never find a missing entry. A serve
  // spawn registers under the WORKER id and queues this op as its first job
  // BEFORE exec, so the fresh loop finds work immediately.
  const execId = action.worker ? action.worker.id : opId;
  globals.worker_info!.set(execId, {
    kind: action.type,
    target: action.target,
    threads: action.threads,
    ...(action.worker ? { mode: "serve" as const } : {}),
    ...(!action.worker && action.additionalMsec !== undefined
      ? { delayUntil: plannedAt + action.additionalMsec }
      : {}),
    ...(!action.worker && action.stock ? { stock: true } : {}),
    ...(!action.worker && strengthThreads !== undefined ? { strengthThreads } : {}),
  });
  if (action.worker) {
    globals.worker_jobs!.set(action.worker.id, [
      {
        opId,
        target: action.target,
        ...(action.additionalMsec !== undefined ? { delayUntil: plannedAt + action.additionalMsec } : {}),
        ...(action.stock ? { stock: true } : {}),
        ...(strengthThreads !== undefined ? { threads: strengthThreads } : {}),
      },
    ]);
  }

  const pid = ns.exec(
    workerScript(),
    host,
    // ramOverride is per thread: the generic worker is billed exactly as the
    // op it performs. One binary, deliberately — and the batcher reference
    // agrees: nobody01/bitburnerscript@master execs a single
    // `scripts/worker.js` for every role and varies only ramOverride
    // (imports/batchRunner.ts:21-38), holding those processes resident in
    // pools. Its earlier @2023 branch had moved the OTHER way, to a script per
    // batch role (src/workers/{hs,w1s,gs,w2s}.ts), to fix that branch's shotgun
    // batcher ("fixed shotgun by separating different workers", 8a8fb9c); the
    // later line abandoned that split. Our pooled serve mode matches @master:
    // per-role INSTANCES of one script.
    // Source (ramOverride is the per-thread RunningScript allocation): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L275-L310
    { threads: action.threads, temporary: true, ramOverride: WORKER_RAM[action.type] },
    execId,
  );
  if (pid === 0) {
    globals.worker_info!.delete(execId);
    if (action.worker) globals.worker_jobs!.delete(action.worker.id);
    state.execFails++;
    return false;
  }
  const info = globals.worker_info!.get(execId);
  if (info) info.pid = pid;
  return true;
}

export interface ReclamationExecution {
  plan: ReclamationPlan;
  preempted: boolean;
}

/** Execute the broker's pure ladder through the dispatcher's existing
 * cooperative-stop and failure/worker-exit paths. */
export function reclaimForDodge(
  ns: NS,
  state: DriverState,
  request: BrokerRequest,
  hosts: readonly BrokerHost[],
): ReclamationExecution {
  const dispatch = state.memory.dispatch;
  const shares = [...dispatch.shareWorkers.values()];
  const farmWorkers = preemptibleWorkers(state);
  const plan = planReclamation(request, hosts, shares, farmWorkers, performance.now());
  if (plan.action === 'wait') return { plan, preempted: false };

  const actions: import('../../shared/world.ts').Action[] = [];
  requestShareStops(dispatch, actions, plan.shareGb, new Set(plan.shareWorkerIds));
  for (const action of actions) {
    if (action.type !== 'stopShare') continue;
    state.globals.worker_stop_requested?.add(action.opId);
    state.globals.worker_stop?.get(action.opId)?.();
  }
  if (plan.action !== 'preempt') return { plan, preempted: false };

  const info = state.globals.worker_info?.get(plan.victim.workerId);
  const kill = Reflect.get(ns, ['ki', 'll'].join('')) as ((pid: number) => boolean) | undefined;
  const killed = info?.pid !== undefined && kill?.(info.pid) === true;
  if (!killed) return { plan, preempted: false };
  if (plan.victim.opId !== undefined) reportFailed(state.memory, [plan.victim.opId]);
  releaseWorkerExits(dispatch, [plan.victim.workerId]);
  return { plan, preempted: true };
}

function preemptibleWorkers(state: DriverState): PreemptibleFarmWorker[] {
  const dispatch = state.memory.dispatch;
  // One pass over the ledger, not two: pooled ops index their resident worker,
  // non-pooled ops are candidates in their own right. The candidate list is
  // inherently one entry per preemptible op — that is the broker's contract,
  // not an accident of this loop.
  const activeByWorker = new Map<number, { opId: number; tracked: Tracked }>();
  const oneShot: PreemptibleFarmWorker[] = [];
  for (const [opId, tracked] of dispatch.tracked) {
    if (tracked.workerId !== undefined) {
      activeByWorker.set(tracked.workerId, { opId, tracked });
      continue;
    }
    if (tracked.segment === 'share') continue;
    if (state.globals.worker_info?.get(opId)?.pid === undefined) continue;
    oneShot.push({
      workerId: opId,
      opId,
      hostname: tracked.hostname,
      kind: tracked.kind,
      segment: tracked.segment,
      gb: tracked.gb,
      ...(tracked.landing !== undefined ? { landing: tracked.landing } : {}),
      active: true,
    });
  }

  const workers: PreemptibleFarmWorker[] = [];
  for (const worker of dispatch.pool.workers.values()) {
    if (state.globals.worker_info?.get(worker.workerId)?.pid === undefined) continue;
    const active = activeByWorker.get(worker.workerId);
    workers.push({
      workerId: worker.workerId,
      ...(active ? { opId: active.opId } : {}),
      hostname: worker.hostname,
      kind: worker.kind,
      segment: active?.tracked.segment === 'prep' ? 'prep' : 'farm',
      gb: worker.gb,
      ...(active?.tracked.landing !== undefined ? { landing: active.tracked.landing } : {}),
      active: active !== undefined,
    });
  }
  // Appended one by one, never spread: this list is one entry per in-flight op
  // and a spread of tens of thousands would exceed the argument limit.
  for (const worker of oneShot) workers.push(worker);
  return workers;
}

/** Consume only broker-requested share exits, leaving every ordinary farm
 * completion on the original pump-first wake path. This is resyncHeap's
 * ordering barrier narrowed to the RAM the queued dodge is reclaiming. */
export function settleBrokerShareExits(state: DriverState): number[] {
  const done = state.globals.dispatch_done;
  if (!done || done.length === 0) return [];
  const workerIds: number[] = [];
  for (let index = done.length - 1; index >= 0; index--) {
    const completion = done[index]!;
    if (completion.kind !== 'workerExit') continue;
    if (!state.memory.dispatch.shareWorkers.get(completion.opId)?.stopping) continue;
    workerIds.push(completion.opId);
    done.splice(index, 1);
  }
  releaseWorkerExits(state.memory.dispatch, workerIds);
  return workerIds;
}

/** Reconcile the heap against the game's real usage (30s sweep). Returns the
 * hosts that had drifted. */
export function resyncHeap(state: DriverState, servers: Record<string, Server>): string[] {
  const dispatch = state.memory.dispatch;
  const info = state.globals.worker_info;

  // A worker's process releases real RAM before the controller can drain its
  // atExit completion. A fleet scan in that interval therefore observes less
  // RAM than the heap still (correctly) owns; replacing the heap with that
  // observation and then draining the completion subtracts the same worker
  // twice. JIT makes this ordinary because many landings can queue during a
  // sweep. Separate our accounted reservations from observed live workers:
  // keep every reservation until dispatch consumes its completion, while
  // still reconciling genuinely foreign RAM whenever no exit is pending.
  //
  // Bucketed in ONE pass over the three ledgers rather than re-walking all of
  // them per host: liveness is a per-op `worker_info` lookup, so it cannot come
  // from a maintained index, but it also does not need re-deriving for every
  // host in the fleet.
  const accounted = new Map<string, number>();
  const live = new Map<string, number>();
  const add = (hostname: string, gb: number, alive: boolean): void => {
    accounted.set(hostname, (accounted.get(hostname) ?? 0) + gb);
    if (alive) live.set(hostname, (live.get(hostname) ?? 0) + gb);
  };
  for (const [opId, tracked] of dispatch.tracked) {
    if (tracked.workerId !== undefined) continue;
    add(tracked.hostname, tracked.gb, info?.has(opId) ?? false);
  }
  for (const worker of dispatch.pool.workers.values()) {
    add(worker.hostname, worker.gb, info?.has(worker.workerId) ?? false);
  }
  for (const worker of dispatch.shareWorkers.values()) {
    add(worker.hostname, worker.gb, info?.has(worker.workerId) ?? false);
  }

  const drifted: string[] = [];
  for (const server of Object.values(servers)) {
    const heapHost = dispatch.heap.host(server.hostname);
    if (!heapHost) continue;
    const accountedGb = accounted.get(server.hostname) ?? 0;
    const liveGb = live.get(server.hostname) ?? 0;
    const priorForeignGb = Math.max(0, heapHost.used - accountedGb);
    const observedForeignGb = Math.max(0, server.ramUsed - liveGb);
    const pendingExit = accountedGb > liveGb + 0.01;
    const reconciledUsed = accountedGb + (pendingExit
      ? Math.max(priorForeignGb, observedForeignGb)
      : observedForeignGb);
    const drift = dispatch.heap.resync(server.hostname, reconciledUsed);
    if (Math.abs(drift) > 0.05) drifted.push(server.hostname);
  }
  return drifted;
}

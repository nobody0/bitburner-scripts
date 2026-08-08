import type { NS, Player, Server } from "@ns";
import { versionedScript } from "../../shared/deployment.ts";
import { HOME_RESERVE_GB } from "../../shared/ram/heap.ts";
import { initFarm, planFarm, reportFailed, type FarmMemory } from "../../shared/strategy/farm-planner.ts";
import type { CompletionEvent, HgwAction, ServerView, WorldView } from "../../shared/world.ts";
import { WORKER_RAM } from "../../shared/world.ts";
import { gameBuildId } from "./build-id.ts";
import { workerGlobals, type WorkerGlobalThis } from "./worker-shared.ts";

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
  const events: CompletionEvent[] = done.map((entry) => ({
    kind: entry.kind,
    opId: entry.opId,
    target: entry.target,
    threads: entry.threads,
    result:
      entry.kind === "hack"
        ? { success: (entry.result ?? 0) > 0, moneyGained: entry.result ?? 0 }
        : entry.kind === "weaken"
          ? { securityReduced: entry.result ?? 0 }
          : { growth: entry.result ?? 0 },
  }));
  done.length = 0;
  return events;
}

/** Build the planner's view: static fields from the last dodged scan, live
 * security/money for the hot targets (two cheap direct getters — the hot path
 * never dodges), live used RAM from our own ledger. */
export function buildView(
  ns: NS,
  state: DriverState,
  servers: Record<string, Server>,
  player: Player,
  hotHosts: string[],
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
    time: Date.now(),
    player: {
      money: player.money,
      hackingSkill: player.skills.hacking,
      hackingExp: player.exp.hacking,
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
  };
}

/** One dispatcher pass: plan, then launch. Returns how many ops started. */
export function pump(
  ns: NS,
  state: DriverState,
  view: WorldView,
  completions: CompletionEvent[],
  /** Planning options, passed straight through to planFarm.
   *  - homeReserveGb: computed per pass by the controller — base reserve plus
   *    the largest dodge step any unlocked feature declares
   *    (shared/ram/reserve.ts); the constant is only the no-context fallback.
   *  - horizonMs: expected remaining run time (endgame route decision).
   *  `goalRemaining` is deliberately NOT named here: the game has no money
   *  goal — that is the sim's device, and the sim sets it on planFarm
   *  directly. Named options rather than a positional number tail, because
   *  three adjacent defaulted numbers in three different units transpose
   *  silently. */
  options: { homeReserveGb?: number; horizonMs?: number } = {},
): { launched: number; failed: number; directive: ReturnType<typeof planFarm>["directive"] } {
  const result = planFarm(view, state.memory, completions, {
    homeReserveGb: options.homeReserveGb ?? HOME_RESERVE_GB,
    ...(options.horizonMs !== undefined ? { horizonMs: options.horizonMs } : {}),
  });
  state.memory = result.memory;

  const failed: number[] = [];
  let launched = 0;
  for (const action of result.actions) {
    if (action.type !== "hack" && action.type !== "grow" && action.type !== "weaken") continue;
    if (action.opId === undefined) continue;
    if (startOp(ns, state, action, action.opId)) launched++;
    else failed.push(action.opId);
  }
  if (failed.length > 0) reportFailed(state.memory, failed);
  return { launched, failed: failed.length, directive: result.directive };
}

function startOp(ns: NS, state: DriverState, action: HgwAction, opId: number): boolean {
  const host = action.source;
  // Deployment is done by the dodged sweep; an undeployed host is simply not
  // usable this pass (keeping ns.scp out of the controller's static RAM).
  if (!state.deployed.has(host)) return false;

  // Descriptor before exec: a worker can never find a missing entry.
  state.globals.worker_info!.set(opId, {
    kind: action.type,
    target: action.target,
    threads: action.threads,
    ...(action.additionalMsec !== undefined ? { additionalMsec: action.additionalMsec } : {}),
  });

  const pid = ns.exec(
    workerScript(),
    host,
    // ramOverride is per thread: the generic worker is billed exactly as the
    // op it performs. One binary, deliberately — note that the predecessor
    // scripts moved the OTHER way, to a script per batch role
    // (src/workers/{hs,w1s,gs,w2s}.ts), to fix their shotgun batcher
    // ("fixed shotgun by separating different workers", 8a8fb9c). Understand
    // why that was needed before collapsing or splitting this.
    { threads: action.threads, temporary: true, ramOverride: WORKER_RAM[action.type] },
    opId,
  );
  if (pid === 0) {
    state.globals.worker_info!.delete(opId);
    state.execFails++;
    return false;
  }
  return true;
}

/** Reconcile the heap against the game's real usage (30s sweep). Returns the
 * hosts that had drifted. */
export function resyncHeap(state: DriverState, servers: Record<string, Server>): string[] {
  const drifted: string[] = [];
  for (const server of Object.values(servers)) {
    if (!state.memory.dispatch.heap.host(server.hostname)) continue;
    // Our workers are temporary and tracked; anything else on the host is
    // foreign usage the heap must respect.
    const drift = state.memory.dispatch.heap.resync(server.hostname, server.ramUsed);
    if (Math.abs(drift) > 0.05) drifted.push(server.hostname);
  }
  return drifted;
}

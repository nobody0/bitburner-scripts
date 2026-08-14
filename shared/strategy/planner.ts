import type { Action, Planner, ServerView, WorldView } from "../world.ts";
import { WORKER_RAM } from "../world.ts";
import { cheapestCloudQuote } from "./ram-supply.ts";

/** Baseline strategy — the code under A/B test. PURE: decisions come only
 * from the WorldView; sim/run.ts owns side effects today and a future game
 * adapter will do the same. Deliberately simple v1: one op against one target
 * per replan, batch-style, plus opportunistic infrastructure purchases. */

export interface PlannerMemory {
  nextPservIndex: number;
}

const WEAKEN_THRESHOLD = 5; // weaken when security exceeds min by this
const GROW_THRESHOLD = 0.75; // grow when money below this fraction of max
const HACK_FRACTION = 0.25; // fraction of capacity to spend hacking

function freeThreads(server: ServerView, ramPerThread: number): number {
  return Math.max(0, Math.floor((server.maxRam - server.usedRam) / ramPerThread));
}

function pickTarget(view: WorldView): ServerView | undefined {
  const skill = view.player.hackingSkill;
  const candidates = view.servers.filter(
    (s) => s.hasAdminRights && !s.purchasedByPlayer && s.hostname !== "home" && s.moneyMax > 0,
  );
  // Classic early heuristic: among servers comfortably below our level, pick
  // by moneyMax * growth — raw moneyMax alone walks into slow-growth traps
  // (foodnstuff: rich, growth 5, unfarmable early).
  const comfortable = candidates.filter((s) => s.requiredHackingSkill <= Math.max(1, skill / 2));
  const pool = comfortable.length > 0 ? comfortable : candidates.filter((s) => s.requiredHackingSkill <= skill);
  return pool.sort((a, b) => b.moneyMax * b.serverGrowth - a.moneyMax * a.serverGrowth)[0];
}

export const defaultPlanner: Planner<PlannerMemory> = {
  init: () => ({ nextPservIndex: 0 }),

  plan(view: WorldView, memory: PlannerMemory) {
    const actions: Action[] = [];
    const money = view.player.money;

    for (const server of view.servers) {
      if (!server.hasAdminRights && server.numOpenPortsRequired === 0) {
        actions.push({ type: "nuke", target: server.hostname });
      }
    }

    const owned = view.servers.filter((s) => s.purchasedByPlayer && s.hostname !== "home");
    const cloud = cheapestCloudQuote(view.prices.cloudServer);
    if (cloud && owned.length < view.prices.cloudServerLimit && money >= cloud.cost) {
      actions.push({ type: "buyServer", ram: cloud.ram, name: `pserv-${memory.nextPservIndex}` });
      memory = { ...memory, nextPservIndex: memory.nextPservIndex + 1 };
    }
    if (money >= view.prices.upgradeHomeRam) {
      actions.push({ type: "upgradeHomeRam" });
    }

    const target = pickTarget(view);
    if (!target) return { actions, memory };

    const op: "hack" | "grow" | "weaken" =
      target.hackDifficulty > target.minDifficulty + WEAKEN_THRESHOLD
        ? "weaken"
        : target.moneyAvailable < GROW_THRESHOLD * target.moneyMax
          ? "grow"
          : "hack";

    const sources = view.servers.filter((s) => s.hostname === "home" || s.purchasedByPlayer);
    let wanted =
      op === "weaken"
        ? Math.ceil((target.hackDifficulty - target.minDifficulty) / 0.05)
        : op === "grow"
          ? Number.POSITIVE_INFINITY
          : Math.max(1, Math.floor(sources.reduce((n, s) => n + freeThreads(s, WORKER_RAM.hack), 0) * HACK_FRACTION));

    for (const source of sources) {
      if (wanted <= 0) break;
      const threads = Math.min(wanted, freeThreads(source, WORKER_RAM[op]));
      if (threads < 1) continue;
      actions.push({ type: op, target: target.hostname, source: source.hostname, threads });
      wanted -= threads;
    }

    return { actions, memory };
  },
};

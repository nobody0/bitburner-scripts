import { describe, expect, test } from "bun:test";
import { dispatch, trackOp } from "../../shared/strategy/dispatch.ts";
import { initFarm, planFarm } from "../../shared/strategy/farm-planner.ts";
import { WORKER_RAM, type CompletionEvent } from "../../shared/world.ts";
import type { ServerSpec } from "../core/effects.ts";
import { SimWorld } from "../world.ts";

const moneyServer = (
  hostname: string,
  moneyMax: number,
  minDifficulty: number,
  currentDifficulty: number,
  serverGrowth = 50,
): ServerSpec => ({
  hostname,
  hackDifficulty: minDifficulty + 20,
  moneyAvailable: moneyMax / 25,
  requiredHackingSkill: 700,
  serverGrowth,
  numOpenPortsRequired: 5,
  maxRam: 0,
  currentDifficulty,
  currentMoney: moneyMax,
});

const ramHost = (hostname: string, maxRam: number): ServerSpec => ({
  hostname,
  hackDifficulty: 1,
  moneyAvailable: 0,
  requiredHackingSkill: 1,
  serverGrowth: 1,
  numOpenPortsRequired: 0,
  maxRam,
  currentDifficulty: 1,
  currentMoney: 0,
});

function rhoWorld(): SimWorld {
  // Captured 2026-08-25: 65,536 GB home + 59,392 GB purchased +
  // 3,948 GB rooted-server RAM = 128,876 GB total.
  const purchased = [
    ...Array.from({ length: 13 }, (_, index) => ramHost(`pserv-${index}`, 4_096)),
    ...Array.from({ length: 3 }, (_, index) => ramHost(`pserv-small-${index}`, 2_048)),
  ];
  const world = new SimWorld({
    seed: 25,
    homeRam: 65_536,
    startingMoney: 1.866e12,
    network: [
      moneyServer("rho-construction", 6_889_424_845.317483, 26, 26),
      moneyServer("alpha-ent", 7_220_340_148.953157, 25, 72.72662666194172, 100),
      ...purchased,
      ramHost("rooted-tail", 3_948),
    ],
  });
  world.person.skills.hacking = 1_000;
  for (const server of world.servers.values()) server.hasAdminRights = true;
  return world;
}

describe("live rho-construction regressions", () => {
  test("a zero share allotment reclaims the captured 106,208 GB in one pass", () => {
    const world = rhoWorld();
    const memory = initFarm();
    const dispatchMemory = memory.dispatch;
    dispatchMemory.evaluator.farmReadyHost = "rho-construction";
    dispatchMemory.evaluator.farmReadySince = -1_000_000;
    expect(world.view().servers.reduce((sum, server) => sum + server.maxRam, 0)).toBe(128_876);

    for (const server of world.view().servers) {
      if (server.hasAdminRights && server.maxRam > 0) {
        dispatchMemory.heap.upsert(server.hostname, server.maxRam, 0, server.cpuCores);
      }
    }
    const shareThreads = 26_552;
    const heldShareGb = shareThreads * WORKER_RAM.share;
    expect(heldShareGb).toBe(106_208);
    const allocation = dispatchMemory.heap.allocate({
      blockSize: WORKER_RAM.share,
      threads: shareThreads,
      policy: "spread",
    });
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) throw new Error(JSON.stringify(allocation));

    const heldByWorker = new Map<number, number>();
    for (const block of allocation.reservation.blocks) {
      const workerId = dispatchMemory.nextOpId++;
      const gb = block.threads * WORKER_RAM.share;
      heldByWorker.set(workerId, gb);
      dispatchMemory.shareWorkers.set(workerId, {
        workerId,
        hostname: block.hostname,
        threads: block.threads,
        gb,
        effectiveThreads: block.threads,
        stopping: false,
      });
    }
    dispatchMemory.segmentGb.share = heldShareGb;

    const options = {
      // The captured solve reported hack marginal 0.681 BN-s/GB, share
      // marginal 1.24 BN-s/GB at zero, crossing 2.29 GB, allotment 0 GB.
      // A strong measured money clock keeps this fixture on that zero-thread
      // side of the same marginal equation without hard-coding a directive.
      shareValue: {
        moneySecondsPerRelativeRate: 1e9,
        hackingSecondsPerRelativeRate: 0,
        totalMoneyPerSec: 9.663e7,
        totalHackingExpPerSec: 1.332e4,
        reputationSecondsPerBonus: 77.5,
      },
    } as const;
    const result = planFarm(world.view(), memory, [], options);

    expect(result.directive.farm?.host).toBe("rho-construction");
    expect(result.directive.prep?.host).toBe("alpha-ent");
    expect(result.directive.share?.allotmentGb).toBe(0);
    const stoppedGb = result.actions
      .filter((action) => action.type === "stopShare")
      .reduce((sum, action) => sum + (heldByWorker.get(action.opId) ?? 0), 0);
    expect(stoppedGb).toBe(heldShareGb);
    expect([...dispatchMemory.shareWorkers.values()].every((worker) => worker.stopping)).toBe(true);

    planFarm(
      world.view(),
      memory,
      [...heldByWorker.keys()].map((opId) => ({ kind: "workerExit" as const, opId })),
      options,
    );
    expect(dispatchMemory.segmentGb.share).toBe(0);
    const reclaimedGb = dispatchMemory.heap.freeTotal()
      + dispatchMemory.segmentGb.farm
      + dispatchMemory.segmentGb.prep
      + dispatchMemory.segmentGb.charge;
    expect(reclaimedGb).toBeGreaterThanOrEqual(heldShareGb);
  });

  test("split physical workers count as one logical landing role", () => {
    const world = rhoWorld();
    const memory = initFarm().dispatch;
    const roles = ["h", "w1", "g", "w2", "w2"] as const;
    memory.batches.set(42, {
      id: 42,
      kind: "hwgw",
      target: "rho-construction",
      segment: "farm",
      startedAt: 0,
      planned: [...roles],
      intended: ["h", "w1", "g", "w2"],
      observed: [],
      ops: roles.length,
      landed: 0,
      threads: { hack: 4, grow: 13, weaken: 2 },
      gb: 0,
      gbMs: 0,
      moneyEarned: 0,
      hacks: 0,
    });

    const completions: CompletionEvent[] = roles.map((role, index) => {
      const kind = role === "h" ? "hack" : role === "g" ? "grow" : "weaken";
      const opId = 10_000 + index;
      trackOp(memory, opId, {
        hostname: "home",
        target: "rho-construction",
        kind,
        segment: "farm",
        gb: 0,
        wave: false,
        batchId: 42,
        jitRole: role,
      });
      memory.inFlight[kind]++;
      return {
        opId,
        kind,
        target: "rho-construction",
        threads: 1,
        ...(kind === "hack" ? { result: { success: true, moneyGained: 1 } } : { result: {} }),
      } as CompletionEvent;
    });

    dispatch(world.view(), memory, completions);
    const aggregate = memory.stats.batchesByKind.hwgw;
    expect(aggregate.graded).toBe(1);
    expect(aggregate.inOrder).toBe(1);
    expect([...memory.stats.landingOrders.values()]).toEqual([{
      planned: "h-w1-g-w2",
      observed: "h-w1-g-w2",
      batches: 1,
    }]);
  });
});

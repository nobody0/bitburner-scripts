import { describe, expect, test } from "bun:test";
import { dispatch, initDispatch } from "../shared/strategy/dispatch.ts";
import type { ChargePricingInput } from "../shared/strategy/stanek/charge.ts";
import type { WorldView } from "../shared/world.ts";

const pricing: ChargePricingInput = {
  fragments: [{
    id: 6,
    type: "6",
    x: 1,
    y: 2,
    power: 2,
    numCharge: 0,
    highestCharge: 0,
    chargedEffect: 1,
  }],
  moneySecondsPerRelativeRate: 1_000,
  hackingSecondsPerRelativeRate: 1_000,
  totalMoneyPerSec: 1e15,
  totalHackingExpPerSec: 1e15,
};

function view(time = 0): WorldView {
  return {
    time,
    player: {
      money: 0,
      hackingSkill: 1,
      hackingExp: 0,
      intelligence: 0,
      mults: {
        hacking: 1,
        hacking_exp: 1,
        hacking_money: 1,
        hacking_grow: 1,
        hacking_speed: 1,
        hacking_chance: 1,
      },
    },
    servers: [
      {
        hostname: "home",
        hasAdminRights: true,
        purchasedByPlayer: true,
        moneyAvailable: 0,
        moneyMax: 0,
        hackDifficulty: 1,
        minDifficulty: 1,
        baseDifficulty: 1,
        requiredHackingSkill: 1,
        serverGrowth: 1,
        numOpenPortsRequired: 0,
        maxRam: 64,
        usedRam: 0,
        cpuCores: 1,
      },
      {
        hostname: "n00dles",
        hasAdminRights: true,
        purchasedByPlayer: false,
        moneyAvailable: 1_000_000,
        moneyMax: 1_000_000,
        hackDifficulty: 1,
        minDifficulty: 1,
        baseDifficulty: 1,
        requiredHackingSkill: 1,
        serverGrowth: 100,
        numOpenPortsRequired: 0,
        maxRam: 0,
        usedRam: 0,
        cpuCores: 1,
      },
    ],
    prices: { upgradeHomeRam: Infinity, cloudServer: {}, cloudServerLimit: 0 },
  };
}

describe("charge dispatch ownership", () => {
  test("heartbeat launches one largest-block call and completion is its only release", () => {
    const memory = initDispatch();
    // The first heartbeat selects the farm target; fillers are deliberately
    // suppressed across that context switch.
    dispatch(view(), memory, [], { chargeValue: pricing });
    const planned = dispatch(view(200), memory, [], { chargeValue: pricing });
    const charge = planned.actions.find((action) => action.type === "charge");
    expect(charge).toMatchObject({ type: "charge", source: "home", threads: 32, x: 1, y: 2 });
    expect(memory.segmentGb.charge).toBe(64);
    expect(memory.heap.freeTotal()).toBe(0);

    const released = dispatch(view(1_200), memory, [{ kind: "charge", opId: charge!.opId }], {
      trigger: { kind: "target-wake", target: "n00dles", source: "completion" },
    });
    expect(released.actions.some((action) => action.type === "charge")).toBe(false);
    expect(memory.segmentGb.charge).toBe(0);
    expect(memory.heap.freeTotal()).toBe(64);
  });

  test("target-local wakes never evaluate or launch charge", () => {
    const memory = initDispatch();
    const result = dispatch(view(), memory, [], {
      chargeValue: pricing,
      trigger: { kind: "target-wake", target: "n00dles", source: "deadline" },
    });
    expect(result.actions.some((action) => action.type === "charge")).toBe(false);
  });

  test("a multiplier step invalidates cached solves and suppresses charge until the next stable pass", () => {
    const memory = initDispatch();
    dispatch(view(), memory, []);
    const generation = memory.evaluator.generation;
    const changed = view(200);
    changed.player.mults.hacking_speed = 1.1;
    const invalidated = dispatch(changed, memory, [], { chargeValue: pricing });
    expect(memory.evaluator.generation).toBe(generation + 1);
    expect(memory.evaluator.ctxMultKey).toContain("1.1");
    expect(invalidated.actions.some((action) => action.type === "charge")).toBe(false);
    const stableView = view(400);
    stableView.player.mults.hacking_speed = 1.1;
    const stable = dispatch(stableView, memory, [], { chargeValue: pricing });
    expect(stable.actions.some((action) => action.type === "charge")).toBe(true);
  });
});

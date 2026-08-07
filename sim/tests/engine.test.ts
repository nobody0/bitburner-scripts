import { describe, expect, test } from "bun:test";
import { Clock } from "../clock.ts";
import { BONUS_CAPS, CycleBuffer, Engine, MILLI_PER_CYCLE, initialCounters } from "../engine.ts";

/** Pins the 200ms cycle's real behaviour, including the parts that look like
 * bugs. Anything a feature model is later written against lives here. */

describe("engine cycle", () => {
  test("ticks once per 200ms of virtual time", () => {
    const clock = new Clock();
    const engine = new Engine(clock);
    engine.start();
    clock.run(() => false, 2_000);
    // 2s / 200ms = 10 cycles, delivered one per tick.
    expect(engine.cyclesProcessed).toBe(10);
    expect(engine.updates).toBe(10);
  });

  test("carries the sub-cycle remainder instead of losing it", () => {
    const clock = new Clock();
    const engine = new Engine(clock);
    // A tick that lands off-boundary must not drop the remainder: over a long
    // run, cycles processed tracks elapsed time exactly.
    engine.start();
    clock.run(() => false, 10_000);
    expect(engine.cyclesProcessed).toBe(10_000 / MILLI_PER_CYCLE);
  });

  test("a sub-cycle gap produces no update at all", () => {
    const clock = new Clock();
    const engine = new Engine(clock);
    engine.updateGame(0);
    const before = engine.updates;
    // updateGame is simply not called when fewer than one cycle elapsed.
    engine.start();
    clock.run(() => false, 100);
    expect(engine.updates).toBe(before);
  });

  test("a fat catch-up tick fires each counter exactly once", () => {
    const clock = new Clock();
    let invitations = 0;
    let contracts = 0;
    let passiveRep = 0;
    const engine = new Engine(clock, {
      checkFactionInvitations: () => void invitations++,
      generateContracts: () => void contracts++,
      processPassiveFactionRepGain: (cycles) => void (passiveRep += cycles),
    });

    // 3000 cycles = 10 minutes backgrounded, delivered as ONE update.
    engine.updateGame(3_000);

    // contractGeneration has a 3000-cycle period, so ten minutes "should" be
    // one firing — it is. But so is an hour: the counter cannot fire twice.
    expect(contracts).toBe(1);
    expect(invitations).toBe(1);
    // passiveFactionGrowth is the only one that credits the missed cycles.
    expect(passiveRep).toBe(3_000);
  });

  test("passive faction rep compensates where the others do not", () => {
    const clock = new Clock();
    let passiveRep = 0;
    let invitations = 0;
    const engine = new Engine(clock, {
      processPassiveFactionRepGain: (cycles) => void (passiveRep += cycles),
      checkFactionInvitations: () => void invitations++,
    });
    for (let i = 0; i < 10; i++) engine.updateGame(5);
    // 50 cycles elapsed; rep is credited for all of them...
    expect(passiveRep).toBe(50);
    // ...while invitations, on a 10-cycle period, fired only five times.
    expect(invitations).toBe(5);
  });

  test("the six dead counters are decremented forever and never reset", () => {
    const clock = new Clock();
    const engine = new Engine(clock);
    engine.updateGame(100);
    // Nothing in checkCounters touches these; they just go negative.
    expect(engine.counters["updateDisplays"]).toBe(3 - 100);
    expect(engine.counters["updateSkillLevelsCounter"]).toBe(10 - 100);
    expect(engine.counters["augmentationsNotifications"]).toBe(10 - 100);
    // ...whereas a live one is reset to its period.
    expect(engine.counters["achievementsCounter"]).toBe(5);
  });

  test("counters start at their documented periods", () => {
    const counters = initialCounters();
    expect(counters["autoSaveCounter"]).toBe(300); // 60s
    expect(counters["passiveFactionGrowth"]).toBe(5); // 1s
    expect(counters["mechanicProcess"]).toBe(5); // 1s
    expect(counters["contractGeneration"]).toBe(3000); // 10min
    expect(counters["messages"]).toBe(150); // 30s
  });

  test("corporation stores cycles then processes, in that order", () => {
    const clock = new Clock();
    const order: string[] = [];
    const engine = new Engine(clock, {
      corporationStoreCycles: () => void order.push("store"),
      corporationProcess: () => void order.push("process"),
    });
    engine.updateGame(10);
    expect(order).toEqual(["store", "process"]);
  });

  test("stop() halts the tick", () => {
    const clock = new Clock();
    const engine = new Engine(clock);
    engine.start();
    clock.run(() => false, 1_000);
    const processed = engine.cyclesProcessed;
    engine.stop();
    clock.run(() => false, 10_000);
    expect(engine.cyclesProcessed).toBe(processed);
  });
});

describe("bonus time", () => {
  test("buffers below the threshold and drains at the cap", () => {
    const gang = new CycleBuffer(BONUS_CAPS.gang.min, BONUS_CAPS.gang.max);
    gang.store(5);
    // Under 10 cycles (2s) a gang does not tick at all.
    expect(gang.take()).toBe(0);
    gang.store(5);
    expect(gang.take()).toBe(10);
    // Banked time drains at most 25 cycles (5s) per engine tick -> 25x.
    gang.store(1_000);
    expect(gang.take()).toBe(25);
    expect(gang.stored).toBe(975);
  });

  test("reports bonus time the way getBonusTime does", () => {
    const gang = new CycleBuffer(BONUS_CAPS.gang.min, BONUS_CAPS.gang.max);
    gang.store(300);
    // ns.gang.getBonusTime() === storedCycles * MilliPerCycle.
    expect(gang.bonusTimeMs()).toBe(300 * MILLI_PER_CYCLE);
  });

  test("each subsystem drains at its own documented multiplier", () => {
    // Normal play consumes `min` per tick; bonus play consumes `max`. The
    // ratio is the multiplier the game's UI advertises.
    expect(BONUS_CAPS.gang.max / BONUS_CAPS.gang.min).toBe(2.5);
    expect(BONUS_CAPS.sleeve.max / BONUS_CAPS.sleeve.min).toBe(3);
    expect(BONUS_CAPS.corporation.max / BONUS_CAPS.corporation.min).toBe(1);
    expect(BONUS_CAPS.stanek.max / BONUS_CAPS.stanek.min).toBe(5);
    // Against a 200ms tick: gang drains 5s of game time per tick = 25x.
    expect((BONUS_CAPS.gang.max * MILLI_PER_CYCLE) / MILLI_PER_CYCLE).toBe(25);
    expect(BONUS_CAPS.sleeve.max * MILLI_PER_CYCLE).toBe(3_000);
  });
});

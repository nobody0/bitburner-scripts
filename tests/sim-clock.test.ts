import { describe, expect, test } from "bun:test";
import { Clock, SAME_INSTANT_EVENT_BOUND } from "../sim/clock.ts";

describe("virtual clock stall tripwire", () => {
  test("a zero-delay self-rescheduling loop throws instead of freezing", () => {
    const clock = new Clock();
    // The pathological shape: every callback reschedules itself at delay 0,
    // so the heap head never moves and `run` would otherwise spin forever at
    // 100% CPU with virtual time frozen (and the virtual-time-keyed forced GC
    // starved along with it).
    const loop = (): void => {
      clock.in(0, loop);
    };
    clock.in(0, loop);
    expect(() => clock.run()).toThrow(/virtual clock stalled/);
  });

  test("advancing time resets the same-instant counter", () => {
    const clock = new Clock();
    let ran = 0;
    // Far more total events than the bound, but time moves every BOUND/2
    // events — a busy-but-honest queue must never trip.
    const burst = Math.floor(SAME_INSTANT_EVENT_BOUND / 2);
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < burst; i++) clock.at(round, () => { ran++; });
    }
    expect(clock.run()).toBe("empty");
    expect(ran).toBe(burst * 4);
  });
});

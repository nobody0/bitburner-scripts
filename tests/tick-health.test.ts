/** The lateness signal is the only reading that measures main-thread
 * starvation directly rather than one of its consequences, so its arithmetic
 * is pinned here rather than inferred from a live panel. */
import { beforeEach, describe, expect, test } from "bun:test";
import { noteTickLateness, resetTickHealth, takeTickLateness } from "../game/lib/tick-health.ts";

describe("engine tick lateness", () => {
  beforeEach(() => resetTickHealth());

  test("reports nothing until a tick has been observed", () => {
    expect(takeTickLateness()).toBeUndefined();
  });

  test("seeds on the first sample instead of climbing out of zero", () => {
    // An EMA started at zero would spend its whole time constant claiming the
    // thread is healthy, which is exactly the window a stall happens in.
    noteTickLateness(80);
    expect(takeTickLateness()).toEqual({ meanMs: 80, maxMs: 80 });
  });

  test("clamps an early tick rather than letting it pull the mean below zero", () => {
    noteTickLateness(-30);
    expect(takeTickLateness()).toEqual({ meanMs: 0, maxMs: 0 });
  });

  test("smooths a spike instead of tracking it", () => {
    for (let i = 0; i < 20; i++) noteTickLateness(0);
    noteTickLateness(1_000);
    // One 1s outlier moves a 10-tick constant by a tenth of the gap, so the
    // mean stays readable while the max preserves the outlier itself.
    const drained = takeTickLateness()!;
    expect(drained.meanMs).toBeCloseTo(100, 6);
    expect(drained.maxMs).toBe(1_000);
  });

  test("drains the max per window but carries the mean across drains", () => {
    noteTickLateness(500);
    takeTickLateness();
    noteTickLateness(0);
    const second = takeTickLateness()!;
    expect(second.maxMs).toBe(0);
    // The mean is a control input for planning cadence, not a per-window
    // counter: resetting it every second would make the signal unusable for
    // anything that has to react over more than one window.
    expect(second.meanMs).toBeCloseTo(450, 6);
    expect(takeTickLateness()).toBeUndefined();
  });

  test("reset returns it to the cold state", () => {
    noteTickLateness(400);
    resetTickHealth();
    expect(takeTickLateness()).toBeUndefined();
  });
});

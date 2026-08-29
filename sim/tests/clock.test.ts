import { describe, expect, test } from "bun:test";
import { Clock } from "../clock.ts";

describe("Clock", () => {
  test("runs events in time order", () => {
    const clock = new Clock();
    const order: string[] = [];
    clock.at(30, () => order.push("c"));
    clock.at(10, () => order.push("a"));
    clock.at(20, () => order.push("b"));
    expect(clock.run()).toBe("empty");
    expect(order).toEqual(["a", "b", "c"]);
    expect(clock.now()).toBe(30);
  });

  test("breaks ties FIFO", () => {
    const clock = new Clock();
    const order: number[] = [];
    for (let i = 0; i < 50; i++) clock.at(5, () => order.push(i));
    clock.run();
    expect(order).toEqual([...Array(50).keys()]);
  });

  test("events can schedule events", () => {
    const clock = new Clock();
    const seen: number[] = [];
    clock.at(10, () => {
      seen.push(clock.now());
      clock.in(15, () => seen.push(clock.now()));
    });
    clock.run();
    expect(seen).toEqual([10, 25]);
  });

  test("stops at horizon without running later events", () => {
    const clock = new Clock();
    let ran = false;
    clock.at(100, () => (ran = true));
    expect(clock.run(() => false, 50)).toBe("horizon");
    expect(ran).toBe(false);
    expect(clock.now()).toBe(50);
  });

  test("stops when until() is satisfied", () => {
    const clock = new Clock();
    let count = 0;
    for (let i = 1; i <= 10; i++) clock.at(i, () => count++);
    expect(clock.run(() => count >= 3)).toBe("goal");
    expect(count).toBe(3);
  });

  test("rejects scheduling in the past", () => {
    const clock = new Clock();
    clock.at(10, () => {
      expect(() => clock.at(5, () => {})).toThrow("in the past");
    });
    clock.run();
  });

  test("rejects a non-finite deadline instead of pinning virtual time at NaN", () => {
    // NaN loses every comparison, so it slipped past the past-check, sorted
    // arbitrarily in the heap and then set `now` to NaN permanently — taking
    // Date.now, the horizon check and the stall tripwire with it while the run
    // still reported a result.
    const clock = new Clock();
    expect(() => clock.at(Number.NaN, () => {})).toThrow("non-finite");
    expect(() => clock.in(Number.NaN, () => {})).toThrow("non-finite");
    expect(() => clock.at(Number.POSITIVE_INFINITY, () => {})).toThrow("non-finite");
    clock.at(10, () => {});
    clock.run();
    expect(clock.now()).toBe(10);
  });
});

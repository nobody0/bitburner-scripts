import { afterEach, describe, expect, test } from "bun:test";
import { Clock } from "../clock.ts";
import { DEFAULT_EPOCH_MS, installVirtualTime, type VirtualTime } from "../realm/timers.ts";

/** These pin the browser semantics the game's timing depends on. Every
 * assertion here traces to a real mechanism in bitburner-src @ v3.0.1:
 * netscriptDelay is a window.setTimeout, its effect runs in a .then(), and kill
 * clearTimeout()s the pending timer so the effect never lands. */

let realm: VirtualTime | undefined;

function install(): Clock {
  const clock = new Clock();
  realm = installVirtualTime(clock);
  return clock;
}

afterEach(() => {
  realm?.restore();
  realm = undefined;
});

describe("virtual time", () => {
  test("fires equal-deadline timers in registration order", async () => {
    const clock = install();
    const order: number[] = [];
    for (let i = 0; i < 20; i++) setTimeout(() => order.push(i), 100);
    expect(await clock.runAsync()).toBe("empty");
    expect(order).toEqual([...Array(20).keys()]);
    expect(clock.now()).toBe(100);
  });

  test("drains microtasks between equal-deadline timers", async () => {
    // The HWGW invariant. A hack and a weaken landing on the same millisecond
    // must apply their effects in registration order, each fully settled before
    // the next timer callback — because the game applies the effect in a .then()
    // on the delay promise, and a microtask checkpoint follows every task.
    const clock = install();
    const order: string[] = [];
    setTimeout(() => {
      order.push("timerA");
      void Promise.resolve().then(() => order.push("effectA"));
    }, 100);
    setTimeout(() => {
      order.push("timerB");
      void Promise.resolve().then(() => order.push("effectB"));
    }, 100);
    await clock.runAsync();
    expect(order).toEqual(["timerA", "effectA", "timerB", "effectB"]);
  });

  test("the synchronous pump does NOT interleave effects (why runAsync exists)", () => {
    const clock = new Clock();
    const order: string[] = [];
    clock.at(100, () => {
      order.push("timerA");
      void Promise.resolve().then(() => order.push("effectA"));
    });
    clock.at(100, () => {
      order.push("timerB");
      void Promise.resolve().then(() => order.push("effectB"));
    });
    clock.run();
    expect(order).toEqual(["timerA", "timerB"]);
  });

  test("clearTimeout from inside a firing callback cancels an equal-deadline timer", async () => {
    // This is kill-mid-delay: stopAndCleanUpWorkerScript clearTimeout()s the
    // pending netscriptDelay, so the killed op's effect never applies at all.
    const clock = install();
    const fired: string[] = [];
    let second = 0;
    setTimeout(() => {
      fired.push("first");
      clearTimeout(second);
    }, 50);
    second = setTimeout(() => fired.push("second"), 50) as unknown as number;
    await clock.runAsync();
    expect(fired).toEqual(["first"]);
    expect(clock.pending()).toBe(0);
  });

  test("clamps nested timers below 4ms past depth 5", async () => {
    const clock = install();
    const times: number[] = [];
    let depth = 0;
    const tick = (): void => {
      times.push(clock.now());
      if (++depth < 8) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    await clock.runAsync();
    expect(times.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(times[5]! - times[4]!).toBe(4);
    expect(times[7]! - times[6]!).toBe(4);
  });

  test("coerces negative and non-numeric delays to zero", async () => {
    const clock = install();
    const at: number[] = [];
    setTimeout(() => at.push(clock.now()), -500);
    setTimeout(() => at.push(clock.now()), Number.NaN);
    setTimeout(() => at.push(clock.now()), undefined);
    await clock.runAsync();
    expect(at).toEqual([0, 0, 0]);
  });

  test("setInterval repeats until cleared", async () => {
    const clock = install();
    const at: number[] = [];
    const id: number = setInterval(() => {
      at.push(clock.now());
      if (at.length === 3) clearInterval(id);
    }, 25) as unknown as number;
    expect(await clock.runAsync()).toBe("empty");
    expect(at).toEqual([25, 50, 75]);
  });

  test("passes extra arguments through to the callback", async () => {
    const clock = install();
    let seen: unknown[] = [];
    setTimeout((...args: unknown[]) => (seen = args), 10, "a", 1);
    await clock.runAsync();
    expect(seen).toEqual(["a", 1]);
  });

  test("Date and performance read the virtual clock", async () => {
    const clock = install();
    expect(Date.now()).toBe(DEFAULT_EPOCH_MS);
    expect(new Date().getTime()).toBe(DEFAULT_EPOCH_MS);
    expect(performance.now()).toBe(0);
    setTimeout(() => {
      expect(Date.now()).toBe(DEFAULT_EPOCH_MS + 5_000);
      expect(performance.now()).toBe(5_000);
    }, 5_000);
    await clock.runAsync();
    // Explicit arguments still construct a real date, and statics survive.
    expect(new Date(0).getTime()).toBe(0);
    expect(new Date(2024, 0, 2) instanceof Date).toBe(true);
    expect(Date.UTC(2024, 0, 1)).toBe(DEFAULT_EPOCH_MS);
  });

  test("restore puts the real primitives back", () => {
    const realNow = Date.now();
    const clock = install();
    expect(Date.now()).toBe(DEFAULT_EPOCH_MS);
    realm!.restore();
    realm = undefined;
    expect(Date.now()).toBeGreaterThanOrEqual(realNow);
    expect(clock.now()).toBe(0);
  });

  test("refuses a second install", () => {
    install();
    expect(() => installVirtualTime(new Clock())).toThrow("already installed");
  });
});

import { describe, expect, test } from "bun:test";
import {
  Clock,
  CollectionPacer,
  COLLECT_MAX_WALL_MS,
  COLLECT_MIN_WALL_MS,
  COLLECT_RSS_GROWTH_BYTES,
  COLLECT_VIRTUAL_INTERVAL_MS,
  processRssBytes,
} from "../clock.ts";

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

describe("CollectionPacer", () => {
  /** A pacer on injected clocks, so the rule is testable without allocating a
   * gigabyte to prove it. */
  const build = () => {
    let wall = 0;
    let rss = 1024 ** 3;
    const collected: { wall: number; virtual: number }[] = [];
    let virtualNow = 0;
    const pacer = new CollectionPacer({
      collect: () => collected.push({ wall, virtual: virtualNow }),
      wallNow: () => wall,
      rssBytes: () => rss,
    });
    return {
      collected,
      /** Advance both clocks and run `events` events through the pacer. */
      run(events: number, wallMs: number, virtualMs: number, rssDelta = 0): void {
        for (let i = 0; i < events; i++) {
          wall += wallMs / events;
          virtualNow += virtualMs / events;
          rss += rssDelta / events;
          pacer.tick(virtualNow);
        }
      },
    };
  };

  test("the virtual trigger still paces an ordinary run", () => {
    const host = build();
    // Ten virtual minutes and well past the wall floor: exactly the old rule's
    // common case, which must not have changed.
    host.run(4096, 10_000, COLLECT_VIRTUAL_INTERVAL_MS);
    expect(host.collected.length).toBeGreaterThanOrEqual(1);
  });

  test("a run whose virtual clock has crawled still collects", () => {
    // THE REGRESSION. Late in a leg run the pump does minutes of host work per
    // virtual minute (throughput measured at 0.12 virtual hours per wall
    // minute), so the old rule — ten virtual minutes, floored at two wall
    // seconds — went minutes between collections while the run allocated at
    // full tilt. That is how a 24h leg run reached 58.69 GB.
    const host = build();
    // A full minute of wall time and 4 GB of growth, for one virtual second.
    host.run(65_536, 60_000, 1_000, 4 * 1024 ** 3);
    // The old rule would have collected ZERO times here: virtual time never
    // reached its interval.
    expect(host.collected.length).toBeGreaterThanOrEqual(3);
    // And it is the growth that drove it, not the ceiling alone.
    expect(host.collected.length).toBeGreaterThan(60_000 / COLLECT_MAX_WALL_MS);
  });

  test("the wall ceiling backstops a host that reports no RSS", () => {
    let wall = 0;
    let collections = 0;
    const pacer = new CollectionPacer({
      collect: () => { collections++; },
      wallNow: () => wall,
      // A host with no RSS reading: `processRssBytes` answers 0, so the growth
      // trigger can never fire and only the ceiling is left.
      rssBytes: () => 0,
    });
    for (let i = 0; i < 65_536; i++) {
      wall += 60_000 / 65_536;
      pacer.tick(1);
    }
    expect(collections).toBeGreaterThanOrEqual(Math.floor(60_000 / COLLECT_MAX_WALL_MS) - 1);
  });

  test("the wall floor still bounds what collection costs", () => {
    let wall = 0;
    let collections = 0;
    let rss = 0;
    const pacer = new CollectionPacer({
      collect: () => { collections++; },
      wallNow: () => wall,
      rssBytes: () => rss,
    });
    // Enormous growth and enormous virtual progress, but only one wall
    // millisecond of it: collecting here would be the instrument eating the
    // run. One tick can still slip through on the very first check.
    for (let i = 0; i < 4096; i++) {
      rss += COLLECT_RSS_GROWTH_BYTES;
      pacer.tick(i * COLLECT_VIRTUAL_INTERVAL_MS);
    }
    expect(wall).toBeLessThan(COLLECT_MIN_WALL_MS);
    expect(collections).toBe(0);
  });

  test("tick reports exactly the ticks that collected", () => {
    let wall = 0;
    let collections = 0;
    const pacer = new CollectionPacer({
      collect: () => { collections++; },
      wallNow: () => wall,
      rssBytes: () => 0,
    });
    let reported = 0;
    for (let i = 0; i < 65_536; i++) {
      wall += 60_000 / 65_536;
      if (pacer.tick(1)) reported++;
    }
    expect(reported).toBe(collections);
    expect(pacer.collections).toBe(collections);
  });

  test("RSS is a real reading on this host", () => {
    expect(processRssBytes()).toBeGreaterThan(0);
  });
});

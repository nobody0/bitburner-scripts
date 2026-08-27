/** Virtual clock: a binary min-heap of scheduled callbacks.
 * Mirrors the game finding (spec/simulator.md): there is no tick system —
 * hack/grow/weaken durations are computed at start and their effects applied
 * atomically at completion, so a discrete-event queue reproduces the timing
 * model exactly. seq breaks time ties FIFO for determinism.
 *
 * `run` drives synchronous worlds (the planner driver). `runAsync` drives
 * script code: it lets the microtask queue settle between events, which is what
 * reproduces the game's ordering — a netscriptDelay timer resolves, its `.then`
 * effect lands, and only THEN does the next same-deadline timer fire. */

interface Scheduled {
  time: number;
  seq: number;
  fn: () => void;
}

/** Captured at module load, before sim/realm/timers.ts patches the globals: the
 * pump itself must not run on the clock it is driving. Both are bound eagerly —
 * reading globalThis.setTimeout at call time would pick up the patched one and
 * deadlock the pump against its own clock. */
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate: (fn: () => void) => unknown =
  typeof globalThis.setImmediate === "function"
    ? globalThis.setImmediate.bind(globalThis)
    : (fn: () => void) => realSetTimeout(fn, 0);

/** Real wall-clock milliseconds, for the same reason and by the same trick as
 * the timers above: sim/realm/timers.ts replaces `performance.now` with
 * `() => clock.now()`, so anything measuring the HOST cost of a run has to hold
 * a reference captured before the patch. Every wall-clock measurement inside a
 * running simulation must come through here — a bare `performance.now()` or
 * `Date.now()` silently reports virtual game time instead. */
const realPerformanceNow = globalThis.performance.now.bind(globalThis.performance);

export function realNowMs(): number {
  return realPerformanceNow();
}

/** One real macrotask: every pending microtask and already-resolved promise
 * chain settles before it returns. */
export function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => void realSetImmediate(resolve));
}

export class Clock {
  #heap: Scheduled[] = [];
  #now = 0;
  /** Also the FIFO tie-breaker: ids are monotonic, so ordering equal-deadline
   *  events by id is ordering them by registration. */
  #nextId = 1;
  /** Cancelled-but-still-heaped ids (lazy deletion). */
  #cancelled = new Set<number>();
  /** Events actually popped and run. The denominator for every throughput
   * number: virtual ms per event says how much time a run buys per unit of
   * host work. */
  #events = 0;

  now(): number {
    return this.#now;
  }

  /** Live (uncancelled) scheduled events. */
  pending(): number {
    return this.#heap.length - this.#cancelled.size;
  }

  /** Queue shape, for cost reporting. `cancelled` is the lazy-deletion backlog:
   * a cancelled id is only dropped when it surfaces at the heap top, so a run
   * that kills a lot of in-flight ops carries the handles until then. Watching
   * it grow is how you tell a leak from a merely busy queue. */
  stats(): { events: number; heap: number; cancelled: number } {
    return { events: this.#events, heap: this.#heap.length, cancelled: this.#cancelled.size };
  }

  /** Returns a cancellation handle. Ids start at 1: the game's
   * `if (ws.delay) clearTimeout(ws.delay)` treats a 0 handle as absent. */
  at(time: number, fn: () => void): number {
    if (time < this.#now) throw new Error(`cannot schedule in the past (${time} < ${this.#now})`);
    const seq = this.#nextId++;
    this.#heap.push({ time, seq, fn });
    this.#siftUp(this.#heap.length - 1);
    return seq;
  }

  in(delayMs: number, fn: () => void): number {
    return this.at(this.#now + delayMs, fn);
  }

  cancel(id: number): void {
    this.#cancelled.add(id);
  }

  /** Pop-and-run events until `until()` is true, the queue empties, or the
   * horizon is passed. Returns why it stopped. */
  run(until: () => boolean = () => false, horizonMs = Infinity): "goal" | "empty" | "horizon" {
    for (;;) {
      if (until()) return "goal";
      const next = this.#takeNext(horizonMs);
      if (next === "empty" || next === "horizon") return next;
      next.fn();
    }
  }

  /** As `run`, but drains the microtask queue between events so async script
   * code actually makes progress. `until` is re-checked after each drain, so a
   * goal reached inside a promise continuation stops the pump immediately. */
  async runAsync(
    until: () => boolean = () => false,
    horizonMs = Infinity,
    drain: () => Promise<void> = drainMicrotasks,
  ): Promise<"goal" | "empty" | "horizon"> {
    // Virtual hours pass in wall-seconds, so the allocation churn of a busy
    // late-game fleet outruns the collector's own pacing: RSS ratcheted to
    // 50+ GB with a ~0.5 GB live heap and the OS killed whole seed processes
    // with no result written. A forced full collection once per virtual
    // 10 minutes keeps the footprint bounded; Bun.gc is absent outside bun.
    const gc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
    let nextGcAt = 600_000;
    for (;;) {
      await drain();
      if (until()) return "goal";
      const next = this.#takeNext(horizonMs);
      if (next === "empty" || next === "horizon") return next;
      if (gc && this.now() >= nextGcAt) {
        nextGcAt = this.now() + 600_000;
        gc(true);
      }
      next.fn();
    }
  }

  /** Pop the earliest live event, skipping cancelled ones without advancing
   * time past them. */
  #takeNext(horizonMs: number): Scheduled | "empty" | "horizon" {
    for (;;) {
      const next = this.#heap[0];
      if (!next) return "empty";
      if (this.#cancelled.delete(next.seq)) {
        this.#pop();
        continue;
      }
      if (next.time > horizonMs) {
        this.#now = horizonMs;
        return "horizon";
      }
      this.#pop();
      this.#now = next.time;
      this.#events++;
      return next;
    }
  }

  #pop(): void {
    const last = this.#heap.pop()!;
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#siftDown(0);
    }
  }

  #less(a: number, b: number): boolean {
    const x = this.#heap[a]!;
    const y = this.#heap[b]!;
    return x.time < y.time || (x.time === y.time && x.seq < y.seq);
  }

  #siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.#less(i, parent)) return;
      [this.#heap[i], this.#heap[parent]] = [this.#heap[parent]!, this.#heap[i]!];
      i = parent;
    }
  }

  #siftDown(i: number): void {
    for (;;) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < this.#heap.length && this.#less(left, smallest)) smallest = left;
      if (right < this.#heap.length && this.#less(right, smallest)) smallest = right;
      if (smallest === i) return;
      [this.#heap[i], this.#heap[smallest]] = [this.#heap[smallest]!, this.#heap[i]!];
      i = smallest;
    }
  }
}

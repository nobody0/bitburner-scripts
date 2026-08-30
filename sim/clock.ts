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

/** The same capture for `Date.now`, and needed for the same reason.
 *
 * `realNowMs` is monotonic-since-process-start, which measures intervals and
 * dates nothing. Anything a HUMAN or another process reads while a run is in
 * flight — an artifact's `updatedAt`, a heartbeat line's timestamp — has to be
 * a real epoch, or it reports the simulated year. Sim sidecars written from
 * inside a run were stamped 2024-01-02 for exactly this reason. */
const realDateNow = globalThis.Date.now.bind(globalThis.Date);

export function realEpochMs(): number {
  return realDateNow();
}

/** Resident set size of the whole process, in bytes, or 0 where the host does
 * not report it.
 *
 * Here beside `realNowMs` for the same reason: both measure the HOST rather
 * than the simulation, and both must be reachable from code running inside an
 * installed realm. `process.memoryUsage.rss()` is the cheap form — it skips
 * building the object the full `memoryUsage()` returns. */
export function processRssBytes(): number {
  const usage = globalThis.process?.memoryUsage as
    | ((() => { rss: number }) & { rss?: () => number })
    | undefined;
  if (usage === undefined) return 0;
  try {
    return usage.rss ? usage.rss() : usage().rss;
  } catch {
    return 0;
  }
}

/** Virtual time between forced collections, in the common case. */
export const COLLECT_VIRTUAL_INTERVAL_MS = 600_000;
/** Never collect more often than this. A cost bound, not a memory bound. */
export const COLLECT_MIN_WALL_MS = 2_000;
/** Never go longer than this between collections, whatever the clocks say. */
export const COLLECT_MAX_WALL_MS = 15_000;
/** RSS growth since the last collection that forces the next one. */
export const COLLECT_RSS_GROWTH_BYTES = 512 * 1024 ** 2;
/** Events between consultations of the two triggers that cost a syscall. */
const COLLECT_CHECK_EVERY = 0x3ff;

/** When the pump forces a full collection — and why virtual time cannot decide
 * it alone.
 *
 * Garbage is produced by HOST WORK: events popped, Netscript calls served,
 * closures and promises built. The original rule was "every ten virtual
 * minutes, but no more often than every two wall seconds", and those two
 * clocks agree only while throughput is steady. A leg run's throughput decays
 * by an order of magnitude across its horizon — 8.06 to 0.12 virtual hours per
 * wall minute on `leg-bn4.1` seed 3 — so the same ten virtual minutes stretches
 * from under a second of allocation to minutes of it, and the interval between
 * collections grows without bound in the only units that matter. It is
 * self-reinforcing: a heap that big makes every pass slower, which stretches
 * the interval further. That spiral is how a 24-hour leg run reached 58.69 GB
 * and segfaulted Bun (sim/tests/baselines/bn4.json).
 *
 * So the pacing is bounded on the resource itself. RSS growth since the last
 * collection is the primary trigger: it is what actually kills the process, and
 * it assumes nothing about how fast a phase allocates. The virtual trigger
 * stays as the cheap common case, a wall ceiling backstops a host that reports
 * no RSS, and the two-second floor stays because it is what stops a fast
 * simulator spending its wall clock inside synchronous collections. */
export class CollectionPacer {
  readonly #collect: ((force: boolean) => void) | undefined;
  readonly #wallNow: () => number;
  readonly #rssBytes: () => number;
  #events = 0;
  #nextVirtualMs = COLLECT_VIRTUAL_INTERVAL_MS;
  #lastWallMs: number;
  #lastRssBytes: number;
  /** Collections performed, for tests and cost reporting. */
  collections = 0;

  constructor(options: {
    /** Defaults to `Bun.gc`; absent outside Bun, where the pacer is inert. */
    collect?: (force: boolean) => void;
    wallNow?: () => number;
    rssBytes?: () => number;
  } = {}) {
    this.#collect = options.collect
      ?? (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
    this.#wallNow = options.wallNow ?? realNowMs;
    this.#rssBytes = options.rssBytes ?? processRssBytes;
    this.#lastWallMs = this.#wallNow();
    this.#lastRssBytes = this.#rssBytes();
  }

  /** Call once per popped event. Returns whether it collected. */
  tick(virtualNowMs: number): boolean {
    const collect = this.#collect;
    if (collect === undefined) return false;
    // The virtual trigger is a comparison, so it is consulted every event. The
    // other two cost a syscall each and are consulted every CHECK_EVERY events
    // — at the event rates this harness measures, a clock and an RSS read per
    // event would themselves show up in the profile.
    const virtualDue = virtualNowMs >= this.#nextVirtualMs;
    const sampleDue = (this.#events++ & COLLECT_CHECK_EVERY) === 0;
    if (!virtualDue && !sampleDue) return false;
    const wallNow = this.#wallNow();
    const sinceWall = wallNow - this.#lastWallMs;
    if (sinceWall < COLLECT_MIN_WALL_MS) return false;
    const rss = this.#rssBytes();
    if (
      !virtualDue
      && sinceWall < COLLECT_MAX_WALL_MS
      && rss - this.#lastRssBytes < COLLECT_RSS_GROWTH_BYTES
    ) return false;
    this.#nextVirtualMs = virtualNowMs + COLLECT_VIRTUAL_INTERVAL_MS;
    this.#lastWallMs = wallNow;
    collect(true);
    // Re-read AFTER collecting: the new baseline is what the collection gave
    // back, not what it started from. Keeping the pre-collection reading would
    // leave the growth trigger armed and collect on every check from then on.
    this.#lastRssBytes = this.#rssBytes();
    this.collections++;
    return true;
  }
}

/** One real macrotask: every pending microtask and already-resolved promise
 * chain settles before it returns. */
export function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => void realSetImmediate(resolve));
}

/** Consecutive same-instant events before the clock declares a stall.
 *
 * A discrete-event clock only moves when the queue's head does, so a callback
 * that reschedules itself at delay 0 freezes virtual time FOREVER while
 * burning host CPU — and starves the forced GC, whose trigger is virtual, so
 * the freeze compounds into an OOM spiral. The real game survives the same
 * code because its engine ticks in wall time regardless. A legitimate burst
 * (a 200 ms wake pump over a 24k-worker fleet, a prestige kill sweep) is tens
 * of thousands of same-instant events; a million is nothing but a loop.
 * `SIM_STALL_BOUND` overrides it for stall diagnosis, where a tighter bound
 * names the loop within seconds instead of after a million planner passes. */
export const SAME_INSTANT_EVENT_BOUND = (() => {
  const raw = Number(globalThis.process?.env?.["SIM_STALL_BOUND"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000_000;
})();

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
  /** Same-instant stall tripwire (see SAME_INSTANT_EVENT_BOUND). */
  #sameInstant = 0;

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
    // NaN fails EVERY comparison, so an unguarded NaN deadline slips past the
    // past-check, sorts arbitrarily in the heap and then pins `#now` at NaN for
    // the rest of the run — taking Date.now, the horizon check and the stall
    // tripwire with it, while the run still reports a result. Infinity is the
    // same story with a different ending, so both are refused here rather than
    // at each caller.
    if (!Number.isFinite(time)) throw new Error(`cannot schedule at a non-finite time (${time})`);
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
   * goal reached inside a promise continuation stops the pump immediately.
   *
   * `SIM_TRACE_STALL=<path>` synchronously overwrites that file with the
   * source of each event callback before running it — diagnosis-only, for the
   * stall class the tripwire cannot see: a promise chain that never awaits a
   * real timer starves the drain's setImmediate, so the pump never pops
   * another event and the LAST traced callback is the loop's entry point. */
  async runAsync(
    until: () => boolean = () => false,
    horizonMs = Infinity,
    drain: () => Promise<void> = drainMicrotasks,
  ): Promise<"goal" | "empty" | "horizon"> {
    const tracePath = globalThis.process?.env?.["SIM_TRACE_STALL"];
    const trace = tracePath
      ? await (async () => {
          const fs = await import("node:fs");
          return (event: Scheduled): void => {
            fs.writeFileSync(
              tracePath,
              `t=${event.time} seq=${event.seq}\n${String(event.fn).slice(0, 4_000)}\n`,
            );
          };
        })()
      : undefined;
    // Virtual time can create allocations faster than the host collector's
    // ordinary pacing, so the pump forces its own; see CollectionPacer for why
    // the pacing cannot be read off the virtual clock.
    const pacer = new CollectionPacer();
    for (;;) {
      await drain();
      if (until()) return "goal";
      const next = this.#takeNext(horizonMs);
      if (next === "empty" || next === "horizon") return next;
      pacer.tick(this.now());
      trace?.(next);
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
      if (next.time === this.#now) {
        this.#sameInstant++;
        if (this.#sameInstant > SAME_INSTANT_EVENT_BOUND) {
          // Name the callback source so a zero-delay scheduling loop is
          // diagnosable when the same-instant bound trips.
          throw new Error(
            `virtual clock stalled: ${this.#sameInstant} consecutive events at t=${this.#now}ms; `
            + `next callback: ${String(next.fn).slice(0, 300)}`,
          );
        }
      } else {
        this.#sameInstant = 0;
      }
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

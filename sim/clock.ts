/** Virtual clock: a binary min-heap of scheduled callbacks, run synchronously.
 * Mirrors the game finding (spec/simulator.md): there is no tick system —
 * hack/grow/weaken durations are computed at start and their effects applied
 * atomically at completion, so a discrete-event queue reproduces the timing
 * model exactly. seq breaks time ties FIFO for determinism. */

interface Scheduled {
  time: number;
  seq: number;
  fn: () => void;
}

export class Clock {
  #heap: Scheduled[] = [];
  #now = 0;
  #seq = 0;

  now(): number {
    return this.#now;
  }

  pending(): number {
    return this.#heap.length;
  }

  at(time: number, fn: () => void): void {
    if (time < this.#now) throw new Error(`cannot schedule in the past (${time} < ${this.#now})`);
    this.#heap.push({ time, seq: this.#seq++, fn });
    this.#siftUp(this.#heap.length - 1);
  }

  in(delayMs: number, fn: () => void): void {
    this.at(this.#now + delayMs, fn);
  }

  /** Pop-and-run events until `until()` is true, the queue empties, or the
   * horizon is passed. Returns why it stopped. */
  run(until: () => boolean = () => false, horizonMs = Infinity): "goal" | "empty" | "horizon" {
    for (;;) {
      if (until()) return "goal";
      const next = this.#heap[0];
      if (!next) return "empty";
      if (next.time > horizonMs) {
        this.#now = horizonMs;
        return "horizon";
      }
      this.#pop();
      this.#now = next.time;
      next.fn();
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

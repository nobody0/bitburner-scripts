/** The in-flight ledger, held in landing order instead of rebuilt in it.
 *
 * Every consumer of the ledger wants the same thing — operations in
 * `(landing, opId)` order, folded forward from now. Maintaining that order
 * avoids repeated materialization and sorting at scheduler depth.
 *
 * Insertions are tail-biased (a batch's operations land after everything
 * already in flight) and removals head-biased (they land in order), but
 * neither exclusively: a brake trip splices an operation out of the middle,
 * and abandoning the pending suffix removes a whole run of them. So this has
 * to be a genuinely ordered structure, not a queue with a fast path.
 *
 * CHUNKED SORTED ARRAY. Entries live in chunks of at most `CHUNK_SIZE`, each
 * sorted, with a parallel array of per-chunk maximum keys. Insert and remove
 * binary-search the chunk index, then the chunk, then splice inside it — the
 * memmove is bounded by the chunk rather than by the ledger, which is the
 * whole point: one flat sorted array of 400k entries would memmove megabytes
 * per operation, hundreds of times a second.
 *
 * Iteration is a contiguous walk with no allocation, and that matters more
 * than the insert cost: a fold reads the whole ledger several times per pass,
 * so a pointer-chasing structure (skip list, tree) would lose on the operation
 * that dominates. Tombstones were rejected for the same reason — they make
 * every later walk pay for every past removal.
 *
 * The entry objects are the caller's own: this stores references, never
 * copies. Fields that change after insertion (an operation's threads, its
 * strength after an arrival brake) are therefore read live by whoever folds
 * them. `landing` and `opId` are the exception — they are the sort key, so
 * mutating either while an entry is in here corrupts the order silently.
 * Callers remove, mutate, and re-insert instead.
 *
 * NOT WIRED IN YET. `dispatch.ts` still rebuilds and sorts; the call sites move
 * across together with the stable pending-id scheme, because the ids are the
 * tie-break at equal landings and changing the two separately would alter which
 * of two same-instant operations folds first. Until then the only consumer is
 * `tests/ledger-order.test.ts`, which holds it against a plain sort.
 */

/** Bounded so the in-chunk splice stays a short memmove while the chunk index
 * stays short enough to binary-search in a handful of comparisons: 400k
 * entries is ~780 chunks, i.e. 10 comparisons to place one. */
const CHUNK_SIZE = 512;

export interface LedgerKeyed {
  /** Sort key, primary. Immutable while the entry is in the ledger. */
  readonly landing: number;
  /** Sort key, tie-break. Immutable while the entry is in the ledger.
   *
   * Ties are not hypothetical — a spread weaken is many operations on one
   * landing — and which of two same-instant operations folds first is
   * observable in the prediction, so the tie-break is part of the contract
   * rather than an implementation detail. */
  readonly opId: number;
}

function before(entry: LedgerKeyed, landing: number, opId: number): boolean {
  return entry.landing < landing || (entry.landing === landing && entry.opId < opId);
}

export class OrderedLedger<T extends LedgerKeyed> {
  #chunks: T[][] = [];
  /** `#maxLanding[i]`/`#maxOpId[i]` mirror the last key in `#chunks[i]`, so
   * the chunk search never touches the chunks themselves. */
  #maxLanding: number[] = [];
  #maxOpId: number[] = [];
  #size = 0;

  get size(): number {
    return this.#size;
  }

  /** Index of the first chunk that could hold `(landing, opId)`. */
  #chunkFor(landing: number, opId: number): number {
    let lo = 0;
    let hi = this.#chunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const maxLanding = this.#maxLanding[mid]!;
      const maxOpId = this.#maxOpId[mid]!;
      if (maxLanding < landing || (maxLanding === landing && maxOpId < opId)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Insertion point within a chunk. */
  #offsetFor(chunk: readonly T[], landing: number, opId: number): number {
    let lo = 0;
    let hi = chunk.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(chunk[mid]!, landing, opId)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #noteMax(index: number): void {
    const chunk = this.#chunks[index]!;
    const last = chunk[chunk.length - 1]!;
    this.#maxLanding[index] = last.landing;
    this.#maxOpId[index] = last.opId;
  }

  insert(entry: T): void {
    const { landing, opId } = entry;
    let index = this.#chunkFor(landing, opId);
    if (index === this.#chunks.length) {
      // Past every existing chunk — the common case, since new work lands
      // after everything already in flight. Append to the last chunk while it
      // has room, so a tail-biased load does not produce a chunk per entry.
      if (index === 0 || this.#chunks[index - 1]!.length >= CHUNK_SIZE) {
        this.#chunks.push([entry]);
        this.#maxLanding.push(landing);
        this.#maxOpId.push(opId);
        this.#size++;
        return;
      }
      index -= 1;
    }
    const chunk = this.#chunks[index]!;
    chunk.splice(this.#offsetFor(chunk, landing, opId), 0, entry);
    this.#size++;
    if (chunk.length > CHUNK_SIZE) {
      // Split down the middle rather than off the end: a tail-biased load
      // otherwise splits the same chunk on every second insert.
      const half = chunk.splice(chunk.length >> 1);
      this.#chunks.splice(index + 1, 0, half);
      this.#maxLanding.splice(index + 1, 0, 0);
      this.#maxOpId.splice(index + 1, 0, 0);
      this.#noteMax(index + 1);
    }
    this.#noteMax(index);
  }

  /** Remove the entry with this exact key. Returns whether one was there. */
  remove(landing: number, opId: number): boolean {
    const index = this.#chunkFor(landing, opId);
    if (index >= this.#chunks.length) return false;
    const chunk = this.#chunks[index]!;
    const at = this.#offsetFor(chunk, landing, opId);
    const found = chunk[at];
    if (!found || found.landing !== landing || found.opId !== opId) return false;
    chunk.splice(at, 1);
    this.#size--;
    if (chunk.length === 0) {
      this.#chunks.splice(index, 1);
      this.#maxLanding.splice(index, 1);
      this.#maxOpId.splice(index, 1);
      return true;
    }
    this.#noteMax(index);
    return true;
  }

  /** Every entry, in `(landing, opId)` order. The walk allocates nothing per
   * entry; mutating the ledger during one is the caller's problem, exactly as
   * it is for an array. */
  *[Symbol.iterator](): IterableIterator<T> {
    for (const chunk of this.#chunks) {
      for (const entry of chunk) yield entry;
    }
  }

  /** A forward cursor.
   *
   * The fold this exists for consumes the ledger in one direction and stops at
   * a moving horizon, so it needs to resume where it stopped rather than
   * re-seek from the head on every query. */
  cursor(): OrderedCursor<T> {
    return new OrderedCursor<T>(this.#chunks);
  }
}

/** Forward-only reader over a ledger's chunks. */
export class OrderedCursor<T extends LedgerKeyed> {
  #chunks: readonly T[][];
  #chunk = 0;
  #offset = 0;

  constructor(chunks: readonly T[][]) {
    this.#chunks = chunks;
  }

  /** The next entry without consuming it. */
  peek(): T | undefined {
    while (this.#chunk < this.#chunks.length) {
      const chunk = this.#chunks[this.#chunk]!;
      if (this.#offset < chunk.length) return chunk[this.#offset];
      this.#chunk++;
      this.#offset = 0;
    }
    return undefined;
  }

  /** The next entry, consuming it. */
  next(): T | undefined {
    const entry = this.peek();
    if (entry !== undefined) this.#offset++;
    return entry;
  }
}

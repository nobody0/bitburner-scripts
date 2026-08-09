/** Fleet RAM allocator — the slab-heap design from an earlier rewrite
 * (`nobody0/bitburner`, no longer checked out; see README's citation note) with
 * its known defects fixed. The predecessor scripts now on disk
 * (nobody01/bitburnerscript@2023) have no heap at all: their `cluster.ts`
 * re-reads ns.getServerUsedRam every pass and reconciles by killing non-HGW
 * workers, which is why this file cites the rewrite rather than them.
 *
 * Pure data structure: the sim and the game driver each own an instance; all
 * mutation flows through #update (O(1) rebucket, single choke point).
 *
 * Inherited keepers: 21 power-of-two slabs bucketed by clz32 (no Math.log),
 * home pinned last as a fallback, three policies (contiguous best-fit for
 * hack, home-first for grow's core bonus, ascending-slab spread for weaken /
 * prep so fragments get eaten first), two-phase-commit spread.
 *
 * Fixes over the rewrite: allocations return Reservation handles with
 * idempotent release() (rollback on exec failure — its leak); failures are
 * typed values, never silent; the home reserve lives HERE, once, as explicit
 * reserved GB (not fake ramUsed); batch-atomic multi-request allocation
 * (all ops of an HWGW batch or none). */

/** The single home-reserve BASE constant (the rewrite hardcoded its equivalent
 * in three places). Covers the transient dodge stub plus handoff overlap; the
 * controller's own RAM is already counted in the observed usedRam. Sim passes
 * 0 — nothing else runs on its home.
 *
 * This is a floor, not the whole reserve: shared/ram/reserve.ts raises it by
 * the largest dodge step the enabled features declare, so a feature whose probe
 * needs 8 GB is not permanently starved by the dispatcher. */
export const HOME_RESERVE_GB = 4.5;

export interface HeapHost {
  hostname: string;
  maxRam: number;
  used: number;
  /** Kept free on this host (home: controller + dodge stub headroom). */
  reserved: number;
  cores: number;
  slab: number;
}

export interface Block {
  hostname: string;
  threads: number;
  cores: number;
}

export interface Reservation {
  blocks: Block[];
  gb: number;
  release(): void;
}

export interface AllocFailure {
  ok: false;
  wanted: number;
  /** Largest single contiguous grant currently possible for this block size. */
  grantable: number;
  freeTotal: number;
}

export type AllocResult = { ok: true; reservation: Reservation } | AllocFailure;

export interface AllocRequest {
  /** GB per thread (WORKER_RAM[kind]). */
  blockSize: number;
  threads: number;
  policy: "contiguous" | "homeFirst" | "spread";
  /** Grow/weaken requests express `threads` in one-core effect units. When
   * true, fewer real threads are reserved on multi-core hosts. */
  coreAware?: boolean;
}

const SLABS = 21;

function slabIndex(free: number): number {
  return free <= 1 ? 0 : 31 - Math.clz32(Math.ceil(free));
}

export class Heap {
  #hosts = new Map<string, HeapHost>();
  /** slabs[i] holds hosts with free RAM in (2^i - 1, 2^(i+1) - 1]; home is
   * kept out of slabs and scanned last. */
  #slabs: HeapHost[][] = Array.from({ length: SLABS }, () => []);
  #home: HeapHost | undefined;
  maxRam = 0;
  usedTotal = 0;
  reservedTotal = 0;

  /** Add or refresh a host. Home is identified by hostname. */
  upsert(hostname: string, maxRam: number, used: number, cores = 1, reserved = 0): void {
    const existing = this.#hosts.get(hostname);
    if (existing) {
      this.maxRam += maxRam - existing.maxRam;
      this.reservedTotal += reserved - existing.reserved;
      existing.maxRam = maxRam;
      existing.reserved = reserved;
      existing.cores = cores;
      this.#update(existing, used);
      return;
    }
    const host: HeapHost = { hostname, maxRam, used, reserved, cores, slab: -1 };
    this.#hosts.set(hostname, host);
    this.maxRam += maxRam;
    this.usedTotal += used;
    this.reservedTotal += reserved;
    if (hostname === "home") {
      this.#home = host;
    } else {
      host.slab = slabIndex(this.#free(host));
      this.#slabs[host.slab]!.push(host);
    }
  }

  host(hostname: string): HeapHost | undefined {
    return this.#hosts.get(hostname);
  }

  hosts(): IterableIterator<HeapHost> {
    return this.#hosts.values();
  }

  freeTotal(): number {
    let free = 0;
    for (const host of this.#hosts.values()) free += this.#free(host);
    return free;
  }

  /** Free RAM on one host, from the live ledger rather than a stale scan.
   *
   * `includeReserved` counts the host's reserve as available. That is not a
   * loophole: home's reserve exists precisely so a dodge stub can launch, so
   * the dodge placement asks with it included while the dispatcher — which
   * must never touch it — asks without. Returns 0 for an unknown host, which
   * reads as "cannot place here" at every call site. */
  freeOn(hostname: string, includeReserved = false): number {
    const host = this.#hosts.get(hostname);
    if (!host) return 0;
    const free = host.maxRam - host.used - (includeReserved ? 0 : host.reserved);
    return Math.max(0, free);
  }

  /** Threads of `blockSize` that a spread allocation could place right now.
   * Callers size divisible work (weaken, prep grow) against this instead of
   * failing and retrying. */
  capacity(blockSize: number): number {
    let threads = 0;
    for (const host of this.#hosts.values()) threads += Math.floor(this.#free(host) / blockSize);
    return threads;
  }

  /** Release part of a reservation. Ops of one allocation can complete
   * independently (a spread weaken lands per host), so the dispatcher frees
   * per block rather than per reservation. */
  free(hostname: string, gb: number): void {
    const host = this.#hosts.get(hostname);
    if (host) this.#update(host, host.used - gb);
  }

  /** Reconcile a host against externally observed usage (game sweep).
   * Returns the drift in GB (0 = in sync). */
  resync(hostname: string, observedUsed: number): number {
    const host = this.#hosts.get(hostname);
    if (!host) return 0;
    const drift = observedUsed - host.used;
    if (drift !== 0) this.#update(host, observedUsed);
    return drift;
  }

  /** Reserve a block on a NAMED host, for a consumer that has already chosen
   * where it is going — currently only dodge placement
   * (shared/ram/placement.ts picks the host by policy, then this makes the
   * choice visible to the dispatcher).
   *
   * Without this a dodge stub would occupy RAM the heap still believed was
   * free, and the dispatcher would keep allocating it and keep getting pid 0
   * back from `ns.exec` — the two allocators silently fighting over the same
   * gigabytes. Taking the lease here means an HWGW batch simply plans around
   * the stub, which is the whole reason the heap exists.
   *
   * `includeReserved` lets a caller draw on the host's reserve. Home's reserve
   * exists precisely so a stub can launch, so the dodge is entitled to it —
   * and once the stub is running, that RAM genuinely IS used, which is what
   * the next `resync` will independently observe. */
  reserveOn(hostname: string, gb: number, includeReserved = false): Reservation | undefined {
    const host = this.#hosts.get(hostname);
    if (!host) return undefined;
    const free = host.maxRam - host.used - (includeReserved ? 0 : host.reserved);
    if (free < gb) return undefined;
    return this.#commit([{ hostname, threads: 1, cores: host.cores }], gb);
  }

  /** Allocate one request. Never partially succeeds. */
  allocate(request: AllocRequest): AllocResult {
    const blocks = this.#place(request);
    if (!blocks) return this.#failure(request);
    return { ok: true, reservation: this.#commit(blocks, request.blockSize) };
  }

  /** Batch-atomic: place every request (against tentative state), then commit
   * all — an HWGW batch gets all four ops or none. */
  allocateAll(requests: AllocRequest[]): { ok: true; reservations: Reservation[] } | (AllocFailure & { index: number }) {
    const placed: { blocks: Block[]; blockSize: number }[] = [];
    const tentative = new Map<string, number>();
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i]!;
      const blocks = this.#place(request, tentative);
      if (!blocks) {
        return { ...this.#failure(request, tentative), index: i };
      }
      placed.push({ blocks, blockSize: request.blockSize });
      for (const block of blocks) {
        tentative.set(block.hostname, (tentative.get(block.hostname) ?? 0) + block.threads * request.blockSize);
      }
    }
    return { ok: true, reservations: placed.map((p) => this.#commit(p.blocks, p.blockSize)) };
  }

  #free(host: HeapHost, tentative?: Map<string, number>): number {
    return host.maxRam - host.used - host.reserved - (tentative?.get(host.hostname) ?? 0);
  }

  /** Find blocks for a request without mutating state. */
  #place(request: AllocRequest, tentative?: Map<string, number>): Block[] | undefined {
    const { blockSize, threads, policy, coreAware = false } = request;
    const wanted = blockSize * threads;

    if (policy === "homeFirst" && this.#home) {
      const actualThreads = coreAware ? Math.ceil(threads / coreEffect(this.#home.cores) - 1e-12) : threads;
      if (this.#free(this.#home, tentative) >= actualThreads * blockSize) {
        return [{ hostname: this.#home.hostname, threads: actualThreads, cores: this.#home.cores }];
      }
    }

    // grow (homeFirst) is divisible, so when home is full it spreads rather
    // than demanding one contiguous block; only hack must stay contiguous.
    if (policy === "spread" || policy === "homeFirst") {
      if (coreAware) {
        const blocks: Block[] = [];
        let remainingEffect = threads;
        // Highest cores first is the minimum-RAM allocation for a fixed grow
        // or weaken effect — but the heap's other two invariants still hold:
        // home stays the LAST resort (grow's homeFirst and hack's contiguous
        // fallback depend on it), and equal-core hosts keep the ascending-slab
        // order so fragments are eaten before large contiguous blocks. Stable
        // hostname tie-break keeps replay exact.
        const hosts = [...this.#hosts.values()]
          .filter((host) => host !== this.#home)
          .sort((a, b) => b.cores - a.cores || a.slab - b.slab || a.hostname.localeCompare(b.hostname));
        if (this.#home) hosts.push(this.#home);
        for (const host of hosts) {
          if (remainingEffect <= 1e-9) break;
          const fit = Math.floor(this.#free(host, tentative) / blockSize);
          if (fit < 1) continue;
          const bonus = coreEffect(host.cores);
          const take = Math.min(fit, Math.ceil(remainingEffect / bonus - 1e-12));
          blocks.push({ hostname: host.hostname, threads: take, cores: host.cores });
          remainingEffect -= take * bonus;
        }
        return remainingEffect <= 1e-9 ? blocks : undefined;
      }
      const blocks: Block[] = [];
      let remaining = threads;
      // Ascending slabs: consume the most fragmented hosts first, preserving
      // large contiguous blocks for hack/grow. Two-phase: commit only if full.
      for (let slab = 0; slab < SLABS && remaining > 0; slab++) {
        if (2 ** (slab + 1) - 1 < blockSize) continue;
        for (const host of this.#slabs[slab]!) {
          if (remaining <= 0) break;
          const fit = Math.floor(this.#free(host, tentative) / blockSize);
          if (fit < 1) continue;
          const take = Math.min(fit, remaining);
          blocks.push({ hostname: host.hostname, threads: take, cores: host.cores });
          remaining -= take;
        }
      }
      if (remaining > 0 && this.#home) {
        const fit = Math.floor(this.#free(this.#home, tentative) / blockSize);
        if (fit >= 1) {
          const take = Math.min(fit, remaining);
          blocks.push({ hostname: this.#home.hostname, threads: take, cores: this.#home.cores });
          remaining -= take;
        }
      }
      return remaining <= 0 ? blocks : undefined;
    }

    // contiguous (and homeFirst fallback): best fit within the smallest slab
    // that yields any fit; home scanned last.
    let best: HeapHost | undefined;
    let bestFree = Infinity;
    const startSlab = Math.max(0, slabIndex(Math.max(1, wanted)) - 0);
    for (let slab = startSlab; slab < SLABS; slab++) {
      for (const host of this.#slabs[slab]!) {
        const free = this.#free(host, tentative);
        if (free >= wanted && free < bestFree) {
          best = host;
          bestFree = free;
        }
      }
      if (best) break;
    }
    if (!best && this.#home && this.#free(this.#home, tentative) >= wanted) best = this.#home;
    if (!best) return undefined;
    return [{ hostname: best.hostname, threads, cores: best.cores }];
  }

  #commit(blocks: Block[], blockSize: number): Reservation {
    let gb = 0;
    for (const block of blocks) {
      const host = this.#hosts.get(block.hostname)!;
      const amount = block.threads * blockSize;
      gb += amount;
      this.#update(host, host.used + amount);
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      for (const block of blocks) {
        const host = this.#hosts.get(block.hostname);
        if (host) this.#update(host, host.used - block.threads * blockSize);
      }
    };
    return { blocks, gb, release };
  }

  #failure(request: AllocRequest, tentative?: Map<string, number>): AllocFailure {
    let grantable = 0;
    let freeTotal = 0;
    for (const host of this.#hosts.values()) {
      const free = this.#free(host, tentative);
      freeTotal += Math.max(0, free);
      const fit = Math.floor(free / request.blockSize) * (request.coreAware ? coreEffect(host.cores) : 1);
      if (fit > grantable) grantable = fit;
    }
    return { ok: false, wanted: request.threads, grantable, freeTotal };
  }

  /** Single mutation choke point: O(1) rebucket only when the slab changes. */
  #update(host: HeapHost, newUsed: number): void {
    this.usedTotal += newUsed - host.used;
    host.used = newUsed;
    if (host === this.#home) return;
    const newSlab = Math.min(SLABS - 1, Math.max(0, slabIndex(Math.max(0, this.#free(host)))));
    if (newSlab === host.slab) return;
    const oldList = this.#slabs[host.slab]!;
    const index = oldList.indexOf(host);
    if (index >= 0) oldList.splice(index, 1);
    host.slab = newSlab;
    this.#slabs[newSlab]!.push(host);
  }
}

function coreEffect(cores: number): number {
  return 1 + (Math.max(1, cores) - 1) / 16;
}

import { describe, expect, test } from "bun:test";
import { Heap, type AllocRequest, type Reservation } from "../shared/ram/heap.ts";
import { mulberry32 } from "../sim/core/rng.ts";

function makeFleet(): Heap {
  const heap = new Heap();
  heap.upsert("home", 32, 0, 2, 8);
  heap.upsert("n00dles", 4, 0);
  heap.upsert("foodnstuff", 16, 0);
  heap.upsert("pserv-0", 64, 0);
  heap.upsert("pserv-1", 1024, 0);
  return heap;
}

describe("Heap", () => {
  test("contiguous allocates a single block, best-fit, home last", () => {
    const heap = makeFleet();
    const result = heap.allocate({ blockSize: 1.7, threads: 5, policy: "contiguous" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.reservation.blocks).toHaveLength(1);
    // 8.5GB fits foodnstuff(16) — smaller than pserv-0(64)/pserv-1(1024) — not home
    expect(result.reservation.blocks[0]!.hostname).toBe("foodnstuff");
  });

  test("homeFirst prefers home while it fits, then falls back", () => {
    const heap = makeFleet();
    const onHome = heap.allocate({ blockSize: 1.75, threads: 10, policy: "homeFirst" }); // 17.5 <= 32-8
    expect(onHome.ok && onHome.reservation.blocks[0]!.hostname).toBe("home");
    const fallback = heap.allocate({ blockSize: 1.75, threads: 10, policy: "homeFirst" }); // home now full
    expect(fallback.ok && fallback.reservation.blocks[0]!.hostname).not.toBe("home");
  });

  test("spread eats fragments first and is two-phase (all or nothing)", () => {
    const heap = makeFleet();
    const spread = heap.allocate({ blockSize: 1.75, threads: 12, policy: "spread" });
    expect(spread.ok).toBe(true);
    if (!spread.ok) throw new Error("unreachable");
    // smallest hosts consumed first
    expect(spread.reservation.blocks[0]!.hostname).toBe("n00dles");

    const before = heap.usedTotal;
    const impossible = heap.allocate({ blockSize: 1.75, threads: 100_000, policy: "spread" });
    expect(impossible.ok).toBe(false);
    expect(heap.usedTotal).toBe(before); // nothing reserved on failure
  });

  test("home reserve is honored by every policy", () => {
    const heap = new Heap();
    heap.upsert("home", 8, 0, 1, 8); // fully reserved
    for (const policy of ["contiguous", "homeFirst", "spread"] as const) {
      expect(heap.allocate({ blockSize: 1.7, threads: 1, policy }).ok).toBe(false);
    }
  });

  test("release is idempotent and restores state exactly", () => {
    const heap = makeFleet();
    const result = heap.allocate({ blockSize: 1.75, threads: 20, policy: "spread" });
    if (!result.ok) throw new Error("alloc failed");
    const used = heap.usedTotal;
    result.reservation.release();
    result.reservation.release();
    expect(heap.usedTotal).toBe(used - result.reservation.gb);
    expect(heap.usedTotal).toBe(0);
  });

  test("typed failure reports grantable and freeTotal", () => {
    const heap = makeFleet();
    const result = heap.allocate({ blockSize: 1.7, threads: 10_000, policy: "contiguous" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.wanted).toBe(10_000);
    expect(result.grantable).toBe(Math.floor(1024 / 1.7));
    expect(result.freeTotal).toBeCloseTo(4 + 16 + 64 + 1024 + 24, 6);
  });

  test("allocateAll is batch-atomic", () => {
    const heap = new Heap();
    heap.upsert("only", 16, 0);
    const requests: AllocRequest[] = [
      { blockSize: 1.7, threads: 4, policy: "contiguous" }, // 6.8
      { blockSize: 1.75, threads: 4, policy: "spread" }, // 7.0 -> 13.8 fits
      { blockSize: 1.75, threads: 4, policy: "spread" }, // would exceed 16
    ];
    const failed = heap.allocateAll(requests);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("unreachable");
    expect(failed.index).toBe(2);
    expect(heap.usedTotal).toBe(0); // nothing committed

    const okay = heap.allocateAll(requests.slice(0, 2));
    expect(okay.ok).toBe(true);
    if (!okay.ok) throw new Error("unreachable");
    expect(heap.usedTotal).toBeCloseTo(13.8, 6);
  });

  test("core-aware grow/weaken reserves fewer real threads on stronger hosts", () => {
    const heap = new Heap();
    heap.upsert("quad", 64, 0, 4, 0);
    heap.upsert("one-core", 64, 0, 1, 0);
    // 17 effect threads at coreEffect(4) = 1.1875 -> 15 real threads.
    const result = heap.allocate({ blockSize: 1.75, threads: 17, policy: "spread", coreAware: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.reservation.blocks).toEqual([{ hostname: "quad", threads: 15, cores: 4 }]);
    expect(result.reservation.gb).toBe(26.25);
  });

  test("core-aware spread still leaves home as the last resort", () => {
    const heap = new Heap();
    heap.upsert("home", 64, 0, 8, 0);
    heap.upsert("one-core", 64, 0, 1, 0);
    // one-core fits the whole request, so home — despite having the most
    // cores — must not be touched: grow's homeFirst and hack's contiguous
    // fallback depend on home staying free.
    const result = heap.allocate({ blockSize: 1.75, threads: 17, policy: "spread", coreAware: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.reservation.blocks).toEqual([{ hostname: "one-core", threads: 17, cores: 1 }]);
    // Only when the rest of the fleet cannot finish the job does home chip in.
    const spill = heap.allocate({ blockSize: 1.75, threads: 40, policy: "spread", coreAware: true });
    expect(spill.ok).toBe(true);
    if (!spill.ok) throw new Error("unreachable");
    expect(spill.reservation.blocks.map((block) => block.hostname)).toEqual(["one-core", "home"]);
  });

  test("resync reports and repairs drift", () => {
    const heap = makeFleet();
    heap.allocate({ blockSize: 1.7, threads: 2, policy: "contiguous" });
    const host = [...heap.hosts()].find((h) => h.used > 0)!;
    const drift = heap.resync(host.hostname, host.used + 4);
    expect(drift).toBe(4);
    expect(heap.host(host.hostname)!.used).toBeCloseTo(3.4 + 4, 6);
  });

  test("property: random alloc/release stream conserves RAM vs naive ledger", () => {
    const rng = mulberry32(42);
    const heap = new Heap();
    const capacities: Record<string, number> = { home: 64 };
    heap.upsert("home", 64, 0, 2, 8);
    for (let i = 0; i < 12; i++) {
      const ram = 2 ** (2 + Math.floor(rng() * 9));
      capacities[`s${i}`] = ram;
      heap.upsert(`s${i}`, ram, 0);
    }

    const live: Reservation[] = [];
    let ledger = 0; // naive reference: total GB we believe is allocated
    for (let step = 0; step < 3_000; step++) {
      if (rng() < 0.45 && live.length > 0) {
        const idx = Math.floor(rng() * live.length);
        const [reservation] = live.splice(idx, 1);
        ledger -= reservation!.gb;
        reservation!.release();
      } else {
        const policy = (["contiguous", "homeFirst", "spread"] as const)[Math.floor(rng() * 3)]!;
        const blockSize = [1.7, 1.75][Math.floor(rng() * 2)]!;
        const threads = 1 + Math.floor(rng() * 64);
        const result = heap.allocate({ blockSize, threads, policy });
        if (result.ok) {
          ledger += result.reservation.gb;
          live.push(result.reservation);
          // every block respects its host's capacity & reserve
          for (const host of heap.hosts()) {
            expect(host.used).toBeLessThanOrEqual(host.maxRam - host.reserved + 1e-9);
            expect(host.used).toBeGreaterThanOrEqual(-1e-9);
          }
        }
      }
      expect(heap.usedTotal).toBeCloseTo(ledger, 6);
    }
    for (const reservation of live) reservation.release();
    expect(heap.usedTotal).toBeCloseTo(0, 6);
  });
});

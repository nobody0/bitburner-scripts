import { describe, expect, test } from "bun:test";
import { Heap, HOME_RESERVE_GB } from "../shared/ram/heap.ts";
import {
  DEFAULT_HOME_PREFERENCE_GB,
  dodgeCapacityGb,
  dodgeHost,
  STUB_BASE_GB,
  type HostRam,
} from "../shared/ram/placement.ts";
import { homeReserveGb, MAX_RESERVE_FRACTION } from "../shared/ram/reserve.ts";

describe("homeReserveGb", () => {
  test("is just the base when no enabled feature declares a step", () => {
    const result = homeReserveGb({ enabled: ["hacking"], demand: {}, homeMaxRam: 64 });
    expect(result.reserveGb).toBe(HOME_RESERVE_GB);
    expect(result.capped).toBe(false);
    expect(result.driver).toBeUndefined();
  });

  test("covers the LARGEST step among enabled features, not their sum", () => {
    // Steps are sequential — one stub at a time — so the peak RAM the game has
    // to find at once is one step, never the total.
    const result = homeReserveGb({
      enabled: ["factions", "corp"],
      demand: { factions: 8, corp: 20 },
      homeMaxRam: 256,
    });
    expect(result.reserveGb).toBe(HOME_RESERVE_GB + 20);
    expect(result.driver).toBe("corp");
  });

  test("a locked feature costs the dispatcher nothing", () => {
    // Its probe never runs, so reserving for it would be pure waste.
    const result = homeReserveGb({ enabled: ["hacking"], demand: { corp: 20 }, homeMaxRam: 256 });
    expect(result.reserveGb).toBe(HOME_RESERVE_GB);
  });

  test("caps the increase so a small home is never starved, and SAYS so", () => {
    // The honest half: a 64 GB home cannot hand 20 GB to one probe and still
    // be a useful farm, so the reserve is clamped and the shortfall becomes a
    // reported blocker rather than a silently smaller budget.
    const result = homeReserveGb({ enabled: ["corp"], demand: { corp: 40 }, homeMaxRam: 64 });
    expect(result.wantedGb).toBe(HOME_RESERVE_GB + 40);
    expect(result.reserveGb).toBe(64 * MAX_RESERVE_FRACTION);
    expect(result.capped).toBe(true);
    expect(result.driver).toBe("corp");
    expect(result.why).toContain("corp needs more home RAM");
  });

  test("never clamps BELOW the base, however small home is", () => {
    // 40% of a fresh 8 GB home is 3.2 GB — under the base reserve. Honouring
    // the fraction there would leave too little for `ns.exec` of the stub
    // itself, and the script would lose its only way to read the world.
    const result = homeReserveGb({ enabled: ["hacking"], demand: {}, homeMaxRam: 8 });
    expect(result.reserveGb).toBe(HOME_RESERVE_GB);
    expect(result.capped).toBe(false);
  });

  test("names the same driver regardless of key order", () => {
    const a = homeReserveGb({ enabled: ["corp", "gang"], demand: { corp: 10, gang: 10 }, homeMaxRam: 512 });
    const b = homeReserveGb({ enabled: ["gang", "corp"], demand: { gang: 10, corp: 10 }, homeMaxRam: 512 });
    expect(a.driver).toBe(b.driver!);
  });
});

describe("dodgeHost", () => {
  const fleet = (over: Partial<HostRam>[] = []): HostRam[] => [
    { hostname: "home", freeGb: 6, hasStub: true },
    { hostname: "n00dles", freeGb: 4, hasStub: true },
    { hostname: "pserv-0", freeGb: 64, hasStub: true },
    { hostname: "pserv-1", freeGb: 1024, hasStub: true },
    ...(over as HostRam[]),
  ];

  test("small budgets stay on home — a remote hop buys nothing", () => {
    expect(dodgeHost(fleet(), 1.5)).toBe("home");
  });

  test("big budgets go to the fleet, best fit, so large blocks survive", () => {
    // 30 GB fits pserv-0 (64) and pserv-1 (1024); taking the 1 TB host would
    // deny a hack op the only contiguous block big enough for it.
    expect(dodgeHost(fleet(), 30)).toBe("pserv-0");
  });

  test("falls back to home when the fleet cannot take it", () => {
    const hosts: HostRam[] = [
      { hostname: "home", freeGb: 40, hasStub: true },
      { hostname: "n00dles", freeGb: 4, hasStub: true },
    ];
    expect(dodgeHost(hosts, 20)).toBe("home");
  });

  test("a host without the stub is not a candidate", () => {
    // `ns.exec` of a missing file returns 0 — indistinguishable from "full" —
    // so a missing stub would burn every retry and look like a RAM shortage.
    const hosts: HostRam[] = [
      { hostname: "home", freeGb: 2, hasStub: true },
      { hostname: "pserv-0", freeGb: 1024, hasStub: false },
    ];
    expect(dodgeHost(hosts, 20)).toBeUndefined();
  });

  test("accounts for the stub's own footprint, not just the budget", () => {
    const hosts: HostRam[] = [{ hostname: "n00dles", freeGb: 8, hasStub: true }];
    expect(dodgeHost(hosts, 8 - STUB_BASE_GB)).toBe("n00dles");
    expect(dodgeHost(hosts, 8 - STUB_BASE_GB + 0.1)).toBeUndefined();
  });

  test("ties break on hostname, so placement is deterministic", () => {
    const hosts: HostRam[] = [
      { hostname: "beta", freeGb: 64, hasStub: true },
      { hostname: "alpha", freeGb: 64, hasStub: true },
    ];
    expect(dodgeHost(hosts, 30)).toBe("alpha");
    expect(dodgeHost([...hosts].reverse(), 30)).toBe("alpha");
  });

  test("nothing fits is a real answer, not an exception", () => {
    expect(dodgeHost([], 1)).toBeUndefined();
    expect(dodgeHost(fleet(), 1e6)).toBeUndefined();
  });

  test("the home preference is a preference, not a ceiling", () => {
    const hosts: HostRam[] = [
      { hostname: "home", freeGb: 2, hasStub: true },
      { hostname: "pserv-0", freeGb: 64, hasStub: true },
    ];
    // Small budget, but home cannot take it — go to the fleet anyway.
    expect(dodgeHost(hosts, DEFAULT_HOME_PREFERENCE_GB - 1)).toBe("pserv-0");
  });
});

describe("dodgeCapacityGb", () => {
  test("reports the best single host, minus the stub's own cost", () => {
    const hosts: HostRam[] = [
      { hostname: "home", freeGb: 6, hasStub: true },
      { hostname: "pserv-0", freeGb: 64, hasStub: true },
    ];
    expect(dodgeCapacityGb(hosts)).toBe(64 - STUB_BASE_GB);
  });

  test("ignores hosts without the stub, and never goes negative", () => {
    expect(dodgeCapacityGb([{ hostname: "pserv-0", freeGb: 1024, hasStub: false }])).toBe(0);
    expect(dodgeCapacityGb([{ hostname: "home", freeGb: 0.5, hasStub: true }])).toBe(0);
  });
});

describe("Heap.reserveOn", () => {
  function heap(): Heap {
    const h = new Heap();
    h.upsert("home", 32, 0, 2, HOME_RESERVE_GB);
    h.upsert("pserv-0", 64, 0);
    return h;
  }

  test("takes RAM the dispatcher can then no longer allocate", () => {
    // The point: without the lease, a dodge stub occupies RAM the heap still
    // believes is free, and the two allocators fight over it.
    const h = heap();
    const before = h.freeOn("pserv-0");
    const lease = h.reserveOn("pserv-0", 20);
    expect(lease).toBeDefined();
    expect(h.freeOn("pserv-0")).toBe(before - 20);
    lease!.release();
    expect(h.freeOn("pserv-0")).toBe(before);
  });

  test("release is idempotent", () => {
    const h = heap();
    const lease = h.reserveOn("pserv-0", 20)!;
    lease.release();
    lease.release();
    expect(h.freeOn("pserv-0")).toBe(64);
  });

  test("home may draw on its reserve — that is what the reserve is FOR", () => {
    const h = heap();
    // Dispatcher's view excludes the reserve...
    expect(h.freeOn("home")).toBe(32 - HOME_RESERVE_GB);
    // ...but a dodge asking with it included can take the whole 32.
    expect(h.reserveOn("home", 32 - HOME_RESERVE_GB + 1, false)).toBeUndefined();
    expect(h.reserveOn("home", 32 - HOME_RESERVE_GB + 1, true)).toBeDefined();
  });

  test("declines rather than overcommitting, and never knows an unknown host", () => {
    const h = heap();
    expect(h.reserveOn("pserv-0", 65)).toBeUndefined();
    expect(h.reserveOn("nowhere", 1)).toBeUndefined();
    expect(h.freeOn("nowhere")).toBe(0);
  });

  test("a leased host is skipped by a normal allocation", () => {
    const h = heap();
    h.reserveOn("pserv-0", 60);
    const result = h.allocate({ blockSize: 1.75, threads: 8, policy: "contiguous" });
    // 14 GB wanted; pserv-0 has only 4 left, so it lands on home instead.
    expect(result.ok && result.reservation.blocks[0]!.hostname).toBe("home");
  });
});

import { describe, expect, test } from 'bun:test';
import { DodgeBrokerDriver } from '../game/lib/ram.ts';
import {
  COLD_HOME_ARENA_GB,
  FARM_PREEMPTION_PRIORITY,
  HANDOFF_HOME_RESERVE_GB,
  planReclamation,
  RamBroker,
  STARVATION_MS,
  STUB_BASE_GB,
  type ArenaPlan,
  type BrokerHost,
  type BrokerRequest,
} from '../shared/ram/broker.ts';
import { Heap } from '../shared/ram/heap.ts';

const request = (id: string, gb: number, priority = 10): BrokerRequest => ({
  by: 'test', id, gb, priority, lane: 'default', class: 'deferrable',
});

const hosts = (free = true): BrokerHost[] => [
  { hostname: 'home', maxRam: 8, freeGb: free ? 4.4 : 0, rooted: true, deployed: true },
  { hostname: 'n00dles', maxRam: 4, freeGb: free ? 4 : 0, rooted: true, deployed: true },
  { hostname: 'foodnstuff', maxRam: 16, freeGb: free ? 16 : 0, rooted: true, deployed: true },
  { hostname: 'omega-net', maxRam: 32, freeGb: free ? 32 : 0, rooted: true, deployed: true },
];

describe('RamBroker arena', () => {
  test('cold home and first-sweep n00dles derive the instant boundary from actual arena hosts', () => {
    const broker = new RamBroker();
    const cold = broker.arena([hosts()[0]!], 0, 0);
    expect(cold.reserves).toEqual({ home: COLD_HOME_ARENA_GB });
    expect(cold.guaranteedDynamicGb).toBeCloseTo(COLD_HOME_ARENA_GB - STUB_BASE_GB);

    const swept = broker.arena(hosts(), 1, 1);
    expect(swept.reserves).toEqual({ home: HANDOFF_HOME_RESERVE_GB, n00dles: 4 });
    expect(broker.classify(4 - STUB_BASE_GB, swept)).toBe('instant');
    expect(broker.classify(4 - STUB_BASE_GB + 0.001, swept)).toBe('deferrable');
  });

  test('grows only for proven starvation, never speculatively, and gives the RAM back', () => {
    const broker = new RamBroker();
    const floor = broker.arena(hosts(), 0, 0);
    broker.request(request('large', 10), hosts(false), floor, 0);

    // A queued request that has NOT yet starved must not cost the batcher a
    // host. Sizing the arena to measured demand here would reserve a whole
    // extra server before placement has demonstrated that it is necessary.
    const fresh = broker.arena(hosts(), STARVATION_MS - 1, 0);
    expect(fresh.reserves).toEqual({ home: HANDOFF_HOME_RESERVE_GB, n00dles: 4 });
    expect(fresh.targetGb).toBe(4);

    // Once it has genuinely waited, the arena opens room for it — smallest
    // host that fits, so the largest contiguous hack block survives.
    const starved = broker.arena(hosts(), STARVATION_MS, 0);
    const needed = 10 + STUB_BASE_GB;
    expect(starved.targetGb).toBeCloseTo(needed);
    expect(starved.reserves['foodnstuff']).toBeCloseTo(needed);
    expect(starved.reserves['omega-net']).toBeUndefined();

    // Growth is not gated on the farm being worthless: a starved action must
    // be able to open room even once the farm is earning. The opportunity
    // cost is reported rather than used as a veto.
    const profitable = broker.arena(hosts(), STARVATION_MS, 100);
    expect(profitable.targetGb).toBeCloseTo(needed);
    expect(profitable.farmCostPerSec).toBeGreaterThan(0);

    // Served: the queue drains, starvation ends, the arena collapses back to
    // its floor and the batcher gets the host back.
    broker.drain(hosts(), starved, STARVATION_MS);
    expect(broker.arena(hosts(), STARVATION_MS + 1, 0).reserves)
      .toEqual({ home: HANDOFF_HOME_RESERVE_GB, n00dles: 4 });
    expect(broker.largestMeasured(10 * 60_000)).toBeCloseTo(5, 1);
  });

  test('foodnstuff promotion follows pooling with demotion hysteresis', () => {
    const broker = new RamBroker();
    broker.observePooling(false, 1);
    expect(broker.arena(hosts(), 0, 1).promoted).toBe(false);
    broker.observePooling(true, 2);
    const promoted = broker.arena(hosts(), 1, 1);
    expect(promoted.promoted).toBe(true);
    expect(promoted.reserves).toEqual({ home: HANDOFF_HOME_RESERVE_GB, n00dles: 4, foodnstuff: 16 });
    broker.observePooling(false, 3);
    expect(broker.arena(hosts(), 2, 1).promoted).toBe(true);
    broker.observePooling(false, 4);
    expect(broker.arena(hosts(), 3, 1).promoted).toBe(true);
    broker.observePooling(false, 5);
    expect(broker.arena(hosts(), 4, 1).promoted).toBe(false);
  });

  test('repeated readings of ONE planner pass do not spend the demotion window', () => {
    // The controller builds several arenas per tick — gate, probe, feature
    // pass, one per worker wake — and every one of them reads the same
    // `dispatch.pooling`, which only changes when a pump reruns planFarm.
    // Counting those repeats demoted after a single tick and made the
    // foodnstuff reserve flap at wake cadence.
    const broker = new RamBroker();
    broker.observePooling(true, 1);
    expect(broker.arena(hosts(), 0, 1).promoted).toBe(true);
    for (let reading = 0; reading < 12; reading++) {
      broker.observePooling(false, 2);
      expect(broker.arena(hosts(), 1, 1).promoted).toBe(true);
    }
    broker.observePooling(false, 3);
    broker.observePooling(false, 4);
    expect(broker.arena(hosts(), 2, 1).promoted).toBe(false);
  });
});

describe('RamBroker queue', () => {
  const floor = (): ArenaPlan => new RamBroker().arena(hosts(), 0, 1);

  test('orders by priority, then age, and never spends a block twice', () => {
    const broker = new RamBroker();
    const arena = floor();
    broker.request(request('old-low', 5, 10), hosts(false), arena, 0);
    broker.request(request('old-high', 5, 20), hosts(false), arena, 1);
    broker.request(request('new-high', 5, 20), hosts(false), arena, 2);

    const oneBlock = hosts(false);
    oneBlock[3]!.freeGb = STUB_BASE_GB + 5;
    expect(broker.drain(oneBlock, arena, 10).map((decision) => decision.request.id)).toEqual(['old-high']);
    expect(broker.snapshot(10).waits.map((waiting) => waiting.id)).toEqual(['new-high', 'old-low']);
  });

  test('reports starvation at exactly five seconds and the executable need', () => {
    const broker = new RamBroker();
    const arena = floor();
    broker.request(request('waiting', 8), hosts(false), arena, 100);
    expect(broker.snapshot(100 + STARVATION_MS - 1).starvation).toHaveLength(0);
    const snapshot = broker.snapshot(100 + STARVATION_MS);
    expect(snapshot.starvation.map((waiting) => waiting.id)).toEqual(['waiting']);
    expect(snapshot.neededForLargestWaitingGb).toBe(8 + STUB_BASE_GB);
  });

  test('deduplicates requester ids while retaining original queue age', () => {
    const broker = new RamBroker();
    const arena = floor();
    broker.request(request('same', 5), hosts(false), arena, 10);
    broker.request(request('same', 6), hosts(false), arena, 100);
    const snapshot = broker.snapshot(200);
    expect(snapshot.queueDepth).toBe(1);
    expect(snapshot.waits[0]).toMatchObject({ id: 'same', gb: 6, enqueuedAt: 10, waitMs: 190 });
  });
});

describe('RamBroker reclamation ladder', () => {
  const blockedHost: BrokerHost = {
    hostname: 'omega-net', maxRam: 32, freeGb: 0, rooted: true, deployed: true,
  };

  test('rung 1 releases only sufficient share and the queued request is then placed', () => {
    const broker = new RamBroker();
    const arena = new RamBroker().arena(hosts(), 0, 0);
    const wanted = request('share-beneficiary', 5);
    expect(broker.request(wanted, [blockedHost], arena, 0).status).toBe('queued');

    const plan = planReclamation(wanted, [blockedHost], [
      { workerId: 1, hostname: 'omega-net', gb: 7.2, stopping: false },
      { workerId: 2, hostname: 'omega-net', gb: 19.2, stopping: false },
    ], [], 0);
    expect(plan).toMatchObject({
      action: 'release-share',
      shareWorkerIds: [1],
      shareGb: 7.2,
      neededGb: STUB_BASE_GB + 5,
    });

    const released = [{ ...blockedHost, freeGb: 7.2 }];
    expect(broker.drain(released, arena, 1)).toEqual([
      expect.objectContaining({ status: 'placed', host: 'omega-net', request: wanted }),
    ]);
  });

  test('rung 2 lets install-freeze work preempt the least-value worker that unblocks it', () => {
    const wanted = request('install', 8, FARM_PREEMPTION_PRIORITY);
    const plan = planReclamation(wanted, [{ ...blockedHost, freeGb: 1 }], [], [
      {
        workerId: 10, opId: 100, hostname: 'omega-net', kind: 'hack',
        segment: 'farm', gb: 10, landing: 1_001, active: true,
      },
      {
        workerId: 11, opId: 101, hostname: 'omega-net', kind: 'weaken',
        segment: 'farm', gb: 10, landing: 1_000, active: true,
      },
    ], 900);
    expect(plan).toMatchObject({
      action: 'preempt',
      threshold: FARM_PREEMPTION_PRIORITY,
      reason: 'priority-at-or-above-install-freeze',
      victim: { workerId: 11, kind: 'weaken' },
    });
  });

  test('rung 3 never preempts below install-freeze and leaves the request queued', () => {
    const broker = new RamBroker();
    const arena = new RamBroker().arena(hosts(), 0, 0);
    const wanted = request('ordinary-probe', 8, FARM_PREEMPTION_PRIORITY - 1);
    broker.request(wanted, [blockedHost], arena, 0);
    const plan = planReclamation(wanted, [blockedHost], [], [{
      workerId: 10, opId: 100, hostname: 'omega-net', kind: 'grow',
      segment: 'farm', gb: 32, landing: 2_000, active: true,
    }], 1_000);
    expect(plan).toMatchObject({
      action: 'wait',
      reason: 'priority-below-threshold',
      threshold: FARM_PREEMPTION_PRIORITY,
    });
    expect(broker.snapshot(1_000).waits.map((entry) => entry.id)).toEqual(['ordinary-probe']);
  });
});

describe('RamBroker placement', () => {
  const plan = (): ArenaPlan => ({
    reserves: { foodnstuff: 16 },
    hosts: ['foodnstuff'],
    targetGb: 16,
    arenaGb: 16,
    guaranteedDynamicGb: 16 - STUB_BASE_GB,
    promoted: false,
    measuredDynamicGb: 0,
    farmCostPerSec: 0,
  });

  test('chooses an arena host before a tighter non-arena fit', () => {
    const broker = new RamBroker();
    const available = hosts(false);
    available[2]!.freeGb = 16;
    available[3]!.freeGb = 7;
    expect(broker.request(request('arena-first', 5), available, plan(), 0))
      .toMatchObject({ status: 'placed', host: 'foodnstuff' });
  });

  test('falls back to the best-fit deployed non-arena host', () => {
    const broker = new RamBroker();
    const available: BrokerHost[] = [
      { hostname: 'large', maxRam: 32, freeGb: 20, rooted: true, deployed: true },
      { hostname: 'tight', maxRam: 16, freeGb: 8, rooted: true, deployed: true },
      { hostname: 'missing-stub', maxRam: 8, freeGb: 8, rooted: true, deployed: false },
    ];
    expect(broker.request(request('fallback', 5), available, plan(), 0))
      .toMatchObject({ status: 'placed', host: 'tight' });
  });

  test('keeps a concurrent long-lane dodge off home when a fleet host fits', () => {
    const broker = new RamBroker();
    const available: BrokerHost[] = [
      { hostname: 'home', maxRam: 32, freeGb: 8, rooted: true, deployed: true },
      { hostname: 'foodnstuff', maxRam: 16, freeGb: 8, rooted: true, deployed: true },
    ];
    expect(broker.request({ ...request('go-turn', 5), lane: 'long' }, available, plan(), 0))
      .toMatchObject({ status: 'placed', host: 'foodnstuff' });
  });

  test('queues the long lane rather than borrowing home when the fleet is full', () => {
    const broker = new RamBroker();
    const home: BrokerHost = {
      hostname: 'home', maxRam: 32, freeGb: 32, rooted: true, deployed: true,
    };
    expect(broker.request({ ...request('go-waits', 5), lane: 'long' }, [home], plan(), 0))
      .toMatchObject({ status: 'queued' });
  });
});

describe('DodgeBrokerDriver ready leases', () => {
  test('drops an unclaimed ready placement after its lease window', () => {
    const driver = new DodgeBrokerDriver();
    const heap = new Heap();
    for (const host of hosts()) heap.upsert(host.hostname, host.maxRam, host.maxRam);
    const arena = driver.broker.arena(hosts(false), 0, 0);
    driver.request(request('stale', 5), hosts(false), heap, arena, 0);

    const available = hosts(false);
    available[3]!.freeGb = 32;
    heap.resync('omega-net', 0);
    expect(driver.drain(available, heap, arena, 10)).toHaveLength(1);
    expect(heap.freeOn('omega-net', true)).toBeCloseTo(32 - 5 - STUB_BASE_GB);

    driver.drain(hosts(false), heap, arena, 1_010);
    expect(heap.freeOn('omega-net', true)).toBe(32);
    expect(driver.snapshot(1_010).queueDepth).toBe(0);
  });
});

import { describe, expect, test } from 'bun:test';
import { BOOTSTRAP_RESIDENT_SLICE_GB, HOME_RESERVE_GB,
  ramArena,
  RESIDENT_BASE_GB,
  type BrokerHost,
  type ResidentAsk, } from '../shared/ram/broker.ts';

const hosts = (): BrokerHost[] => [
  { hostname: 'home', maxRam: 8, freeGb: 4.4, rooted: true, deployed: true },
  { hostname: 'n00dles', maxRam: 4, freeGb: 4, rooted: true, deployed: true },
  { hostname: 'foodnstuff', maxRam: 16, freeGb: 16, rooted: true, deployed: true },
  { hostname: 'omega-net', maxRam: 32, freeGb: 32, rooted: true, deployed: true },
];

const resident = (over: Partial<ResidentAsk> = {}): ResidentAsk => ({ gb: 16, wantGb: 16, ...over });

describe('the arena floor', () => {
  test('home holds its full reserve at all times — cold or swept', () => {
    const cold = ramArena([hosts()[0]!], [], 0);
    expect(cold.reserves).toEqual({ home: HOME_RESERVE_GB });
    expect(cold.guaranteedDynamicGb).toBeCloseTo(HOME_RESERVE_GB - RESIDENT_BASE_GB);

    // Keep enough home reserve for the boot-path sweep even after another host is rooted.
    expect(ramArena(hosts(), [], 1).reserves.home).toBe(HOME_RESERVE_GB);
  });

  test('the bootstrap host holds a Go-sized slice BEFORE any resident stands on it', () => {
    // game/lib/bootstrap.ts places the first resident blind, on foodnstuff or
    // n00dles. If the farm may take the slice first there is nowhere to boot
    // to — but only the slice: the rest of the host farms, and Go must be
    // servable from the first placement (its node-power rewards compound for
    // the whole run).
    expect(ramArena(hosts(), [], 0).reserves).toEqual({
      home: HOME_RESERVE_GB,
      foodnstuff: BOOTSTRAP_RESIDENT_SLICE_GB,
    });
  });

  test('n00dles stands in only until foodnstuff is rooted', () => {
    const early: BrokerHost[] = [
      { hostname: 'home', maxRam: 8, freeGb: 4.4, rooted: true, deployed: true },
      { hostname: 'n00dles', maxRam: 4, freeGb: 4, rooted: true, deployed: true },
      { hostname: 'foodnstuff', maxRam: 16, freeGb: 16, rooted: false, deployed: false },
    ];
    expect(ramArena(early, [], 0).reserves).toEqual({ home: HOME_RESERVE_GB, n00dles: 4 });
  });
});

describe('the resident carve', () => {
  test('a resident is reserved its own host at the size it asks for', () => {
    const arena = ramArena(hosts(), [resident({ host: 'omega-net', gb: 8, wantGb: 20 })], 0);
    expect(arena.reserves['omega-net']).toBe(20);
    expect(arena.targetGb).toBe(20);
    expect(arena.guaranteedDynamicGb).toBeCloseTo(20 - RESIDENT_BASE_GB);
  });

  test('a want its own host cannot hold carves the SMALLEST host that fits', () => {
    // The pre-SF4-level-3 singularity reads price at 48-80 GB and exceed every
    // static host, so the resident has to be given somewhere to grow into.
    // Smallest that fits, so the largest contiguous hack block survives.
    const fleet: BrokerHost[] = [
      ...hosts(),
      { hostname: 'mid', maxRam: 64, freeGb: 0, rooted: true, deployed: true },
      { hostname: 'huge', maxRam: 256, freeGb: 0, rooted: true, deployed: true },
    ];
    const arena = ramArena(fleet, [resident({ host: 'foodnstuff', gb: 16, wantGb: 49.6 })], 0);
    // What it already holds stays held, so the respawn is not evicted from
    // under itself while it waits for the bigger block.
    expect(arena.reserves.foodnstuff).toBe(16);
    expect(arena.reserves.mid).toBe(49.6);
    expect(arena.reserves.huge).toBeUndefined();
  });

  test('a resident between placements still carves, since that is the stall', () => {
    // A grow-respawn that cannot find room holds nothing at all and spins on
    // `proxy.slow`. The ask is the only evidence there is, and it has to be
    // enough — nothing queues on its behalf any more.
    const arena = ramArena(hosts(), [{ gb: 0, wantGb: 30 }], 0);
    expect(arena.reserves['omega-net']).toBe(30);
  });

  test('a want below what is already granted never shrinks the reservation', () => {
    const arena = ramArena(hosts(), [resident({ host: 'omega-net', gb: 24, wantGb: 4 })], 0);
    expect(arena.reserves['omega-net']).toBe(24);
  });

  test('the carve collapses as soon as the resident stops asking', () => {
    const grown = ramArena(hosts(), [resident({ host: 'foodnstuff', gb: 16, wantGb: 30 })], 0);
    expect(grown.reserves['omega-net']).toBe(30);
    const settled = ramArena(hosts(), [resident({ host: 'foodnstuff', gb: 16, wantGb: 16 })], 0);
    expect(settled.reserves).toEqual({ home: HOME_RESERVE_GB, foodnstuff: 16 });
  });

  test('nothing in the fleet can hold the want — the arena stays at its floor', () => {
    const arena = ramArena(hosts(), [{ gb: 0, wantGb: 1_000 }], 0);
    expect(arena.reserves).toEqual({
      home: HOME_RESERVE_GB,
      foodnstuff: BOOTSTRAP_RESIDENT_SLICE_GB,
    });
  });
});

describe('what the arena costs the farm', () => {
  test('opportunity cost is REPORTED, never a veto on growing', () => {
    // A resident that must grow has to be able to open room even once the farm
    // is earning: the call it is blocked on cannot run any other way.
    const arena = ramArena(hosts(), [resident({ host: 'foodnstuff', gb: 16, wantGb: 30 })], 100);
    expect(arena.reserves['omega-net']).toBe(30);
    expect(arena.arenaGb).toBeCloseTo(HOME_RESERVE_GB + 16 + 30);
    expect(arena.farmCostPerSec).toBeCloseTo(100 * arena.arenaGb);
    expect(arena.hosts).toEqual(['foodnstuff', 'home', 'omega-net']);
  });

  test('unrooted and undeployed hosts are not reserved and cannot be carved', () => {
    const fleet: BrokerHost[] = [
      { hostname: 'home', maxRam: 8, freeGb: 8, rooted: true, deployed: true },
      { hostname: 'unrooted', maxRam: 64, freeGb: 64, rooted: false, deployed: false },
      { hostname: 'no-payload', maxRam: 64, freeGb: 64, rooted: true, deployed: false },
    ];
    expect(ramArena(fleet, [{ gb: 0, wantGb: 40 }], 0).reserves).toEqual({ home: HOME_RESERVE_GB });
  });
});

import { describe, expect, test } from 'bun:test';
import {
  DNET_PRIORITY,
  strategicQueueDepth,
  canPreempt,
  choosePreemptionVantage,
  compareQueuedDnetWork,
  isSameTurn,
} from '../shared/strategy/dnet/priority.ts';
import { preemptionCandidateFromHandle } from '../game/dnet/priority.ts';
import type { AgentHandle, AgentIo, Order } from '../game/dnet/shared.ts';

const NOW = 100_000;

describe('darknet cancellation policy', () => {
  test('zero-delay work queues before blocking priority without gaining preemption', () => {
    const work = [
      { id: 'walk:lab', kind: 'walk', priority: DNET_PRIORITY.walk },
      { id: 'inventory:dn-1', kind: 'inventory', priority: DNET_PRIORITY.inventory },
      { id: 'plant:dn-2', kind: 'plant', priority: DNET_PRIORITY.plant },
      { id: 'relaunchProbe:dn-1', kind: 'relaunchProbe', priority: DNET_PRIORITY.relaunchProbe },
    ].sort(compareQueuedDnetWork);

    expect(work.map((entry) => entry.kind)).toEqual([
      'relaunchProbe',
      'inventory',
      'walk',
      'plant',
    ]);
    expect(isSameTurn('inventory')).toBe(true);
    expect(isSameTurn('relaunchProbe')).toBe(true);
    expect(canPreempt('inventory', 'promote')).toBe(false);
    expect(canPreempt('relaunchProbe', 'promote')).toBe(false);
    expect(canPreempt('plant', 'promote')).toBe(true);
    expect(strategicQueueDepth(work)).toBe(2);
  });

  test('an idle eligible worker always avoids cancellation', () => {
    expect(choosePreemptionVantage('plant', [
      { host: 'busy', activeKind: 'promote', activePriority: DNET_PRIORITY.promote },
      { host: 'idle', usableGb: 16 },
    ], NOW)).toEqual({ vantage: 'idle', preempt: false });
  });

  test('the lowest-value job is cancelled before considering elapsed work', () => {
    expect(choosePreemptionVantage('plant', [
      {
        host: 'valuable',
        activeKind: 'reclaim',
        activePriority: DNET_PRIORITY.reclaim,
        activeExpectedDoneAt: NOW + 90_000,
      },
      {
        host: 'filler',
        activeKind: 'promote',
        activePriority: DNET_PRIORITY.promote,
        activeExpectedDoneAt: NOW + 1_000,
      },
    ], NOW)).toEqual({ vantage: 'filler', preempt: true });
  });

  test('greater remaining time breaks equal-priority victim ties', () => {
    expect(choosePreemptionVantage('attempt', [
      {
        host: 'almost-done',
        activeKind: 'phish',
        activePriority: DNET_PRIORITY.phish,
        activeExpectedDoneAt: NOW + 1_000,
      },
      {
        host: 'mostly-left',
        activeKind: 'phish',
        activePriority: DNET_PRIORITY.phish,
        activeExpectedDoneAt: NOW + 20_000,
      },
    ], NOW)).toEqual({ vantage: 'mostly-left', preempt: true });
  });

  test('estimated and unknown remaining branches are reached through adopted handle wiring', () => {
    const handle = (host: string, startedAt: number): AgentHandle => {
      const order: Order = {
        id: `phish:${host}`, kind: 'phish', host, from: host, ramOverrideGb: 4,
        threads: 1, priority: DNET_PRIORITY.phish, longLived: false, label: 'phish', startedAt,
      };
      return {
        pid: 1, order, startedAt, beatAt: startedAt, armored: true,
        done: Promise.resolve({ id: order.id, kind: order.kind, host, from: host, ok: true }),
        settle: () => {},
      };
    };
    const estimated = handle('estimated', NOW - 20_000);
    const unknown = handle('unknown', NOW - 1_000);
    const adopted = { agent: estimated };
    const io = {
      setExpectedDoneAt: (at: number | undefined) => {
        if (adopted.agent !== estimated) return;
        estimated.beatAt = NOW;
        if (at === undefined) delete estimated.order.expectedDoneAt;
        else estimated.order.expectedDoneAt = at;
      },
    } as AgentIo;
    io.setExpectedDoneAt(NOW + 5_000);

    expect(choosePreemptionVantage('attempt', [
      preemptionCandidateFromHandle('estimated', estimated),
      preemptionCandidateFromHandle('unknown', unknown),
    ], NOW)).toEqual({ vantage: 'estimated', preempt: true });

    io.setExpectedDoneAt(undefined);
    expect(choosePreemptionVantage('attempt', [
      preemptionCandidateFromHandle('estimated', estimated),
      preemptionCandidateFromHandle('unknown', unknown),
    ], NOW)).toEqual({ vantage: 'unknown', preempt: true });
  });

  test('one selected cancellation can carry another directly chained job', () => {
    expect(choosePreemptionVantage('plant', [
      {
        host: 'already-yielding',
        activeKind: 'phish',
        activePriority: DNET_PRIORITY.phish,
        cancelling: true,
        assigned: 1,
      },
      { host: 'protected', activeKind: 'pin', activePriority: DNET_PRIORITY.pin },
    ], NOW)).toEqual({ vantage: 'already-yielding', preempt: false });
  });

  test('heartbleed is the non-preempting boundary and atomic work is protected', () => {
    expect(canPreempt('bleed', 'promote')).toBe(false);
    expect(canPreempt('attempt', 'promote')).toBe(true);
    expect(canPreempt('walk', 'pin')).toBe(false);
    expect(canPreempt('plant', 'storm')).toBe(false);
  });

  test('a discovered cache outranks strategic and farm work', () => {
    expect(DNET_PRIORITY.inventory).toBeLessThan(DNET_PRIORITY.cache);
    expect(DNET_PRIORITY.cache).toBeLessThan(DNET_PRIORITY.pin);
    expect(DNET_PRIORITY.cache).toBeLessThan(DNET_PRIORITY.attempt);
    expect(canPreempt('cache', 'reclaim')).toBe(true);
    expect(canPreempt('cache', 'phish')).toBe(true);
  });
});

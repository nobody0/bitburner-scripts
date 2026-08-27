import { makeOrder } from './support/dnet-order.ts';
import { describe, expect, test } from 'bun:test';
import { choosePreemptionVantage, compareQueuedDnetWork } from '../shared/strategy/dnet/priority.ts';
import { canPreempt, isSameTurn, priorityOf } from '../shared/strategy/dnet/jobs.ts';
import { preemptionCandidateFromHandle } from '../game/dnet/priority.ts';
import type { AgentHandle, AgentIo, Order } from '../game/dnet/shared.ts';

const NOW = 100_000;

describe('darknet cancellation policy', () => {
  test('zero-delay work queues before blocking priority without gaining preemption', () => {
    const work = [
      { id: 'walk:lab', kind: 'walk', priority: priorityOf('walk') },
      { id: 'inventory:dn-1', kind: 'inventory', priority: priorityOf('inventory') },
      { id: 'plant:dn-2', kind: 'plant', priority: priorityOf('plant') },
      { id: 'relaunchProbe:dn-1', kind: 'relaunchProbe', priority: priorityOf('relaunchProbe') },
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
  });

  test('an idle eligible worker always avoids cancellation', () => {
    expect(choosePreemptionVantage('plant', [
      { host: 'busy', activeKind: 'promote', activePriority: priorityOf('promote') },
      { host: 'idle', usableGb: 16 },
    ], NOW)).toEqual({ vantage: 'idle', preempt: false });
  });

  test('the lowest-value job is cancelled before considering elapsed work', () => {
    expect(choosePreemptionVantage('plant', [
      {
        host: 'valuable',
        activeKind: 'reclaim',
        activePriority: priorityOf('reclaim'),
        activeExpectedDoneAt: NOW + 90_000,
      },
      {
        host: 'filler',
        activeKind: 'promote',
        activePriority: priorityOf('promote'),
        activeExpectedDoneAt: NOW + 1_000,
      },
    ], NOW)).toEqual({ vantage: 'filler', preempt: true });
  });

  test('greater remaining time breaks equal-priority victim ties', () => {
    expect(choosePreemptionVantage('attempt', [
      {
        host: 'almost-done',
        activeKind: 'phish',
        activePriority: priorityOf('phish'),
        activeExpectedDoneAt: NOW + 1_000,
      },
      {
        host: 'mostly-left',
        activeKind: 'phish',
        activePriority: priorityOf('phish'),
        activeExpectedDoneAt: NOW + 20_000,
      },
    ], NOW)).toEqual({ vantage: 'mostly-left', preempt: true });
  });

  test('estimated and unknown remaining branches are reached through adopted handle wiring', () => {
    const handle = (host: string, startedAt: number): AgentHandle => {
      const order = makeOrder('phish', { host, priority: priorityOf('phish'), startedAt }, {});
      return {
        pid: 1, order, startedAt, beatAt: startedAt,
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

  test('a busy lane is a queue, not a refusal: the soonest-free worker takes it', () => {
    // There is no queue-depth cap. When nobody is idle and nothing here may be
    // displaced, the job still has to land somewhere — on whichever worker
    // reaches it first. Refusing instead simply left the work unfiled, and one
    // busy agent could hold up every host it was the only route into.
    const busy = (host: string, readyInMs: number) => ({
      host,
      activeKind: 'walk',
      activePriority: priorityOf('walk'),
      readyInMs,
    });

    expect(choosePreemptionVantage('attempt', [
      busy('later', 30_000),
      busy('sooner', 4_000),
    ], NOW)).toEqual({ vantage: 'sooner', preempt: false });

    // Unknown readiness is not zero: a worker we cannot time never wins the
    // tier by looking free.
    expect(choosePreemptionVantage('attempt', [
      { host: 'untimed', activeKind: 'walk', activePriority: priorityOf('walk') },
    ], NOW)).toBeUndefined();

    // Preemption still outranks queueing — waiting behind work a plant may
    // simply displace would be slower, not politer.
    expect(choosePreemptionVantage('plant', [
      busy('quick-walk', 1_000),
      { host: 'displaceable', activeKind: 'bleed', activePriority: priorityOf('bleed'), readyInMs: 60_000 },
    ], NOW)).toEqual({ vantage: 'displaceable', preempt: true });
  });

  test('one selected cancellation can carry another directly chained job', () => {
    expect(choosePreemptionVantage('plant', [
      {
        host: 'already-yielding',
        activeKind: 'phish',
        activePriority: priorityOf('phish'),
        cancelling: true,
        assigned: 1,
      },
      { host: 'protected', activeKind: 'pin', activePriority: priorityOf('pin') },
    ], NOW)).toEqual({ vantage: 'already-yielding', preempt: false });
  });

  test('heartbleed is the non-preempting boundary and atomic work is protected', () => {
    expect(canPreempt('bleed', 'promote')).toBe(false);
    expect(canPreempt('attempt', 'promote')).toBe(true);
    expect(canPreempt('walk', 'pin')).toBe(false);
    expect(canPreempt('plant', 'storm')).toBe(false);
  });

  test('a discovered cache queues near the front but cancels nothing', () => {
    // Queue order is unchanged: a cache still sorts ahead of a pin, an attempt
    // and every farm kind, so it takes the next free slot on its vantage.
    expect(priorityOf('inventory')).toBeLessThan(priorityOf('cache'));
    expect(priorityOf('cache')).toBeLessThan(priorityOf('pin'));
    expect(priorityOf('cache')).toBeLessThan(priorityOf('attempt'));

    // But it may not DISPLACE, and that is a rule about farm work rather than
    // about caches. The controller files farm work only onto a host that is
    // already spare, so a cache that preempts cancels an order it cannot then
    // replace — and because non-farm work is filed FIRST, the attempt it just
    // killed retakes the freed slot before the farm pass looks at all. The
    // cache cancels it again next pass, forever. Observed in play: thousands
    // of spawns, an `attempt` killed ~1ms after adopting every time, and the
    // cache never ran once.
    expect(canPreempt('cache', 'attempt')).toBe(false);
    expect(canPreempt('cache', 'reclaim')).toBe(false);
    expect(canPreempt('cache', 'phish')).toBe(false);
    // The kinds that may preempt are exactly those the controller will file
    // onto a busy host.
    expect(canPreempt('plant', 'attempt')).toBe(true);
    expect(canPreempt('attempt', 'phish')).toBe(true);
  });
});

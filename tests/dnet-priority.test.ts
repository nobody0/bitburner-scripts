import { describe, expect, test } from 'bun:test';
import {
  DNET_PRIORITY,
  canPreempt,
  choosePreemptionVantage,
} from '../shared/strategy/dnet/priority.ts';

const NOW = 100_000;

describe('darknet cancellation policy', () => {
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

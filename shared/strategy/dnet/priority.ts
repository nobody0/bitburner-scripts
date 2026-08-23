/** One authority for queue order and displacement policy.
 *
 * Lower numbers run first. The gaps are intentional: attempts retain their
 * depth/model offsets without crossing a kind boundary. Probe repair and
 * inventory are admission work, not strategic competitors, but still need
 * deterministic queue positions. */
export const DNET_PRIORITY = {
  walk: -2_000,
  relaunchProbe: -1_900,
  plant: -1_800,
  inventory: -1_700,
  cache: -1_650,
  pin: -1_600,
  storm: -1_500,
  attempt: 0,
  bleed: 100,
  reclaim: 300,
  induce: 400,
  phish: 500,
  promote: 600,
} as const;

export type PriorityKind = keyof typeof DNET_PRIORITY;

const PREEMPTING: ReadonlySet<string> = new Set(['walk', 'plant', 'cache', 'pin', 'attempt']);
const PROTECTED_ACTIVE: ReadonlySet<string> = new Set(['walk', 'pin', 'storm']);

export function priorityOf(kind: string): number {
  return DNET_PRIORITY[kind as PriorityKind] ?? Number.POSITIVE_INFINITY;
}

/** Whether newly-ready work may displace active work on the same worker. */
export function canPreempt(incoming: string, active: string): boolean {
  if (!PREEMPTING.has(incoming) || incoming === active) return false;
  if (PROTECTED_ACTIVE.has(active)) return false;
  return priorityOf(incoming) < priorityOf(active);
}

export interface PreemptionCandidate {
  host: string;
  activeKind?: string;
  activePriority?: number;
  activeStartedAt?: number;
  activeExpectedDoneAt?: number;
  usableGb?: number;
  /** A cancellation already selected in this scheduling transaction. */
  cancelling?: boolean;
  /** Jobs already assigned here in this scheduling transaction. */
  assigned?: number;
}

export interface PreemptionChoice {
  vantage: string;
  preempt: boolean;
}

/** Choose the cheapest eligible worker for an urgent job.
 *
 * Reusing an already-selected worker lets one cancellation service several
 * direct-chained jobs. Otherwise idle workers win. A victim is selected by
 * lowest-value active work first and greatest remaining time second; RAM and
 * hostname make the result fast and deterministic. */
export function choosePreemptionVantage(
  incomingKind: string,
  candidates: readonly PreemptionCandidate[],
  now: number,
): PreemptionChoice | undefined {
  const remaining = (candidate: PreemptionCandidate): number => {
    const end = candidate.activeExpectedDoneAt;
    if (end !== undefined) return Math.max(0, end - now);
    return Math.max(0, now - (candidate.activeStartedAt ?? now));
  };
  const byCapacityAndName = (a: PreemptionCandidate, b: PreemptionCandidate): number =>
    (b.usableGb ?? 0) - (a.usableGb ?? 0)
    || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);

  const idle = candidates
    .filter((candidate) => candidate.activeKind === undefined)
    .sort((a, b) => (a.assigned ?? 0) - (b.assigned ?? 0) || byCapacityAndName(a, b));
  if (idle.length > 0) return { vantage: idle[0]!.host, preempt: false };

  const reusable = candidates
    .filter((candidate) => candidate.cancelling === true)
    .sort((a, b) => (a.assigned ?? 0) - (b.assigned ?? 0) || byCapacityAndName(a, b));
  if (reusable.length > 0) return { vantage: reusable[0]!.host, preempt: false };

  const victims = candidates
    .filter((candidate) => candidate.activeKind !== undefined && canPreempt(incomingKind, candidate.activeKind))
    .sort((a, b) =>
      (b.activePriority ?? priorityOf(b.activeKind!)) - (a.activePriority ?? priorityOf(a.activeKind!))
      || remaining(b) - remaining(a)
      || byCapacityAndName(a, b));
  if (victims.length === 0) return undefined;
  return { vantage: victims[0]!.host, preempt: true };
}

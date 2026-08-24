/** One authority for queue order and displacement policy.
 *
 * Queue lane and strategic priority are deliberately separate. Zero-delay
 * work runs first once an agent is free because it does not occupy the lane;
 * numeric priority decides only among work that can block. Preemption is a
 * third, explicit permission below — front-of-queue never implies cancellation.
 *
 * Lower numbers run first within one lane. The gaps are intentional: attempts
 * retain their depth/model offsets without crossing a kind boundary. */
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

/** Operational housekeeping which settles synchronously or through launch
 * microtasks only. Once admitted it is not a competitor for agent time.
 *
 * This is deliberately narrower than "every synchronous API": cache and storm
 * calls are instant too, but their strategic ordering and world effects are
 * policy. They remain in the blocking/strategic lane. */
const SAME_TURN: ReadonlySet<string> = new Set([
  "inventory",
  "relaunchProbe",
]);

export function isSameTurn(kind: string): boolean {
  return SAME_TURN.has(kind);
}

export function strategicQueueDepth(work: readonly { kind: string }[]): number {
  let depth = 0;
  for (const entry of work) if (!isSameTurn(entry.kind)) depth++;
  return depth;
}

export interface QueuedDnetWork {
  kind: string;
  priority: number;
  id: string;
}

/** Same-turn lane first; strategic priority and stable id within a lane. */
export function compareQueuedDnetWork(a: QueuedDnetWork, b: QueuedDnetWork): number {
  const lane = Number(!isSameTurn(a.kind)) - Number(!isSameTurn(b.kind));
  return lane || a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Cancellation policy is independent of queue order. In particular,
 * inventory and prober repair wait for a free slot even though they queue at
 * the front. */
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
    // No completion estimate: elapsed time is the only signal, and MORE of it
    // means LESS left. Negated so the one descending sort below still prefers
    // the victim with the most work still ahead of it — returning raw elapsed
    // here cancelled the job that had run the LONGEST, throwing away the most
    // work rather than the least.
    return -Math.max(0, now - (candidate.activeStartedAt ?? now));
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

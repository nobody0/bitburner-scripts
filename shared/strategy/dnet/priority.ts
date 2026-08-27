import { canPreempt, isSameTurn, priorityOf } from "./jobs.ts";

/** Queue order and displacement policy.
 *
 * The per-kind FACTS live in `jobs.ts`; this file is the two decisions built
 * out of them. Queue lane and strategic priority are deliberately separate:
 * zero-delay work runs first once an agent is free because it does not occupy
 * the lane, and numeric priority decides only among work that can block.
 * Preemption is a third, explicit permission — front-of-queue never implies
 * cancellation. */

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
  /** How long until this worker could START new work: what is left of its
   *  active order plus everything already queued ahead. Absent means unknown,
   *  which is not the same as zero and never wins the last tier below. */
  readyInMs?: number;
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
 * hostname make the result fast and deterministic. When no worker is free and
 * none may be displaced, the busiest lane is still not a dead end — the job
 * queues on whichever worker will reach it soonest. */
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
  if (victims.length > 0) return { vantage: victims[0]!.host, preempt: true };

  // Nobody is free and nothing here may be displaced, so the question stops
  // being WHO and becomes WHEN: queue on the worker that will reach this
  // soonest. Returning nothing instead was a refusal to schedule at all, and
  // the work simply went unfiled — one busy agent could hold up a whole region
  // it happened to be the only route into.
  const soonest = candidates
    .filter((candidate) => candidate.readyInMs !== undefined)
    .sort((a, b) => a.readyInMs! - b.readyInMs!
      || (a.assigned ?? 0) - (b.assigned ?? 0)
      || byCapacityAndName(a, b));
  if (soonest.length > 0) return { vantage: soonest[0]!.host, preempt: false };
  return undefined;
}

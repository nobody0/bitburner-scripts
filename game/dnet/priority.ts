import type { PreemptionCandidate } from "../../shared/strategy/dnet/priority.ts";
import type { AgentHandle } from "./shared.ts";

/** Project the adopted execution authority into the pure priority input. */
export function preemptionCandidateFromHandle(
  host: string,
  handle: AgentHandle | undefined,
  extra: Omit<PreemptionCandidate, "host" | "activeKind" | "activePriority" | "activeStartedAt" | "activeExpectedDoneAt"> = {},
): PreemptionCandidate {
  // No handle means no active work, which is what makes the host a free
  // worker rather than a preemption victim. (There used to be an `=== "idle"`
  // test beside this; no order is ever built with that kind.)
  if (handle === undefined) return { host, ...extra };
  return {
    host,
    ...extra,
    activeKind: handle.order.kind,
    activePriority: handle.order.priority,
    activeStartedAt: handle.startedAt,
    ...(handle.order.expectedDoneAt !== undefined ? { activeExpectedDoneAt: handle.order.expectedDoneAt } : {}),
  };
}

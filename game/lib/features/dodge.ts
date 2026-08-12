import type { NS } from "@ns";
import type { FeatureId } from "../../../shared/features/ids.ts";
import { grantFor, PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { dodge, DodgeExecError, priceCalls } from "../dodge.ts";
import { goDodge } from "../go-dodge.ts";
import { recordProbeSkip } from "../state.ts";
import type { ClaimContext, DriverContext } from "./index.ts";

/** The only path a feature driver may use to launch a dodge.
 *
 * The claim id is checked as well as the feature id: a grant for one action
 * must never authorise a different action whose method set happens to cost the
 * same. The heap lease then makes the launch visible to the HWGW dispatcher
 * for the lifetime of the stub. */
export type FeatureDodgeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function featureDodge<T>(
  ctx: DriverContext,
  by: FeatureId,
  claimId: string,
  methods: readonly string[],
  body: (stubNs: NS) => T | Promise<T>,
): Promise<FeatureDodgeResult<T>> {
  const budgetGb = priceCalls(ctx.ns, methods);
  const grant = grantFor(ctx.grants.result, by, claimId);
  if (!grant || grant.resource !== "ram" || grant.amount < budgetGb) {
    const detail = grant ? `granted ${grant.resource}:${grant.amount}` : "no grant";
    return { ok: false, reason: `RAM claim ${by}:${claimId} was not granted ${budgetGb.toFixed(1)}GB (${detail})` };
  }

  const lease = ctx.acquireDodge(budgetGb);
  if (!lease) {
    // Feed the SAME starvation signal probes use: the demand-driven fleet
    // reserve engages on state.probeSkips, and an action dodge that cannot
    // find a host is the identical starvation — measured: a granted
    // action:backdoor retried silently every 10s for 30 minutes while the
    // farm kept every block full, because only probe skips could summon the
    // reserve.
    recordProbeSkip(ctx.state, `action:${by}:${claimId}`, budgetGb, 0);
    return { ok: false, reason: `no host can serve a ${budgetGb.toFixed(1)}GB dodge` };
  }
  delete ctx.state.probeSkips[`action:${by}:${claimId}`];
  try {
    return { ok: true, value: await dodge(ctx.ns, body, budgetGb, { host: lease.host }) };
  } catch (error) {
    // Exec failure = the host was not actually free (heap drift, a race with
    // a just-launched batch). That is a RETRYABLE refusal, not an outcome of
    // the action — one such throw used to latch a backdoor as "attempted"
    // forever and cost a whole join. It also feeds the starvation signal so
    // the fleet reserve can open room. Body throws keep propagating.
    if (error instanceof DodgeExecError) {
      recordProbeSkip(ctx.state, `action:${by}:${claimId}`, budgetGb, 0);
      return { ok: false, reason: String(error) };
    }
    throw error;
  } finally {
    lease.release();
  }
}

/** Go variant of featureDodge. Its worker has a separate rendezvous lane, so
 * waiting for the opponent does not block unrelated probes or actions. */
export async function featureGoDodge<T>(
  ctx: DriverContext,
  claimId: string,
  methods: readonly string[],
  body: (stubNs: NS) => T | Promise<T>,
): Promise<FeatureDodgeResult<T>> {
  const budgetGb = priceCalls(ctx.ns, methods);
  const grant = grantFor(ctx.grants.result, "go", claimId);
  if (!grant || grant.resource !== "ram" || grant.amount < budgetGb) {
    const detail = grant ? `granted ${grant.resource}:${grant.amount}` : "no grant";
    return { ok: false, reason: `RAM claim go:${claimId} was not granted ${budgetGb.toFixed(1)}GB (${detail})` };
  }
  const lease = ctx.acquireDodge(budgetGb);
  if (!lease) {
    recordProbeSkip(ctx.state, `action:go:${claimId}`, budgetGb, 0);
    return { ok: false, reason: `no host can serve a ${budgetGb.toFixed(1)}GB Go worker` };
  }
  delete ctx.state.probeSkips[`action:go:${claimId}`];
  try {
    return { ok: true, value: await goDodge(ctx.ns, body, budgetGb, lease.host) };
  } catch (error) {
    if (error instanceof DodgeExecError) {
      recordProbeSkip(ctx.state, `action:go:${claimId}`, budgetGb, 0);
      return { ok: false, reason: String(error) };
    }
    throw error;
  } finally {
    lease.release();
  }
}

/** Exact action-RAM claim, priced from the same method list execution uses. */
export function actionRamClaim(
  ctx: ClaimContext,
  by: FeatureId,
  claimId: string,
  methods: readonly string[],
  why: string,
  priority: number = PRIORITY["probe:detail"],
): Claim {
  return {
    by,
    id: claimId,
    resource: "ram",
    amount: ctx.ramPrice(methods),
    priority,
    mode: "spend",
    why,
  };
}

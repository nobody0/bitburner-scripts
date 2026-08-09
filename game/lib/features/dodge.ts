import type { NS } from "@ns";
import type { FeatureId } from "../../../shared/features/ids.ts";
import { grantFor, PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { dodge, priceCalls } from "../dodge.ts";
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
  if (!lease) return { ok: false, reason: `no host can serve a ${budgetGb.toFixed(1)}GB dodge` };
  try {
    return { ok: true, value: await dodge(ctx.ns, body, budgetGb, { host: lease.host }) };
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
): Claim {
  return {
    by,
    id: claimId,
    resource: "ram",
    amount: ctx.ramPrice(methods),
    priority: PRIORITY["probe:detail"],
    mode: "spend",
    why,
  };
}

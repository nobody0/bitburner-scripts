import type { NS } from '@ns';
import type { FeatureId } from '../../../shared/features/ids.ts';
import { PRIORITY } from '../../../shared/strategy/arbiter.ts';
import { dodge, DodgeExecError, priceCalls } from '../dodge.ts';
import type { ClaimContext, DriverContext } from './index.ts';
import type { RamClaim } from "./claims.ts";

/** The only path a feature driver may use to launch a dodge. The broker is
 * the sole admission gate; its Heap lease remains held for the stub lifetime. */
export type FeatureDodgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; queued: true; reason: string }
  | { ok: false; queued: false; reason: string };

export async function featureDodge<T>(
  ctx: DriverContext,
  by: FeatureId,
  claimId: string,
  methods: readonly string[],
  body: (stubNs: NS) => T | Promise<T>,
): Promise<FeatureDodgeResult<T>> {
  const budgetGb = priceCalls(ctx.ns, methods);
  const priority = ctx.grants.ramClaims.get(claimId)?.priority ?? PRIORITY['probe:detail'];
  const lease = ctx.acquireDodge(budgetGb, {
    by,
    id: claimId,
    lane: 'default',
    priority,
  });
  if (lease.status === 'queued') {
    return { ok: false, queued: true, reason: `queued ${by}:${claimId} (${budgetGb.toFixed(1)}GB)` };
  }
  try {
    return { ok: true, value: await dodge(ctx.ns, body, budgetGb, { host: lease.host }) };
  } catch (error) {
    if (error instanceof DodgeExecError) return { ok: false, queued: false, reason: String(error) };
    throw error;
  } finally {
    lease.release();
  }
}

/** A dodge that must run on ONE named host.
 *
 * The only caller is the darknet seed, and the reason is a check order in the
 * engine rather than a preference: `ns.exec` evaluates its direct-connection
 * requirement BEFORE the `darkweb` early-out, and only `home` holds the TOR edge
 * to `darkweb`. A stub the broker placed on a purchased server would `scp` its
 * payloads happily and then get a silent `0` from `exec` — indistinguishable
 * from a full host, and so a bug that reads as a RAM shortage for ever.
 *
 * Pinned through the broker rather than around it, so home's RAM is still
 * accounted in the heap. If home has no room the request queues, exactly as any
 * other would. */
export async function featureDodgeOn<T>(
  ctx: DriverContext,
  by: FeatureId,
  claimId: string,
  methods: readonly string[],
  pinHost: string,
  body: (stubNs: NS) => T | Promise<T>,
): Promise<FeatureDodgeResult<T>> {
  const budgetGb = priceCalls(ctx.ns, methods);
  const priority = ctx.grants.ramClaims.get(claimId)?.priority ?? PRIORITY['probe:detail'];
  const lease = ctx.acquireDodge(budgetGb, { by, id: claimId, lane: 'default', priority, pinHost });
  if (lease.status === 'queued') {
    return { ok: false, queued: true, reason: `queued ${by}:${claimId} on ${pinHost} (${budgetGb.toFixed(1)}GB)` };
  }
  try {
    return { ok: true, value: await dodge(ctx.ns, body, budgetGb, { host: lease.host }) };
  } catch (error) {
    if (error instanceof DodgeExecError) return { ok: false, queued: false, reason: String(error) };
    throw error;
  } finally {
    lease.release();
  }
}

/** Go uses the broker's separate long lane, so an opponent wait cannot block
 * ordinary probes or feature actions. */
export async function featureGoDodge<T>(
  ctx: DriverContext,
  claimId: string,
  methods: readonly string[],
  body: (stubNs: NS) => T | Promise<T>,
): Promise<FeatureDodgeResult<T>> {
  const budgetGb = priceCalls(ctx.ns, methods);
  const lease = ctx.acquireDodge(budgetGb, {
    by: 'go',
    id: claimId,
    lane: 'long',
    priority: ctx.grants.ramClaims.get(claimId)?.priority ?? PRIORITY['probe:detail'],
  });
  if (lease.status === 'queued') {
    return { ok: false, queued: true, reason: `queued go:${claimId} (${budgetGb.toFixed(1)}GB)` };
  }
  try {
    return { ok: true, value: await dodge(ctx.ns, body, budgetGb, { host: lease.host, lane: 'long' }) };
  } catch (error) {
    if (error instanceof DodgeExecError) return { ok: false, queued: false, reason: String(error) };
    throw error;
  } finally {
    lease.release();
  }
}

/** Declare a continuously brokered RAM claimant. */
export function actionRamClaim(
  ctx: ClaimContext,
  by: FeatureId,
  claimId: string,
  methods: readonly string[],
  priority: number = PRIORITY['probe:detail'],
): RamClaim {
  return {
    by,
    id: claimId,
    resource: 'ram',
    amount: ctx.ramPrice(methods),
    priority,
  };
}

import type { Order, OrderBase, OrderPayloads } from "../../game/dnet/shared.ts";
import type { TaskKind } from "../../shared/strategy/dnet/jobs.ts";

/** Build one order for a body test.
 *
 * Four test files each carried their own copy of this, and each copy drifted:
 * one defaulted `needsRing`, another did not, and none of them could say which
 * payload fields a kind actually needs. There is one now, and the payload is a
 * REQUIRED argument typed by the kind — so a test cannot build a `cache` order
 * without a filename, which is the same guarantee the controller has. */
export function makeOrder<K extends TaskKind>(
  kind: K,
  over: Partial<OrderBase> & { host: string },
  payload: OrderPayloads[K],
): Order<K> {
  return {
    id: `${kind}:${over.host}`,
    ramOverrideGb: 4,
    threads: 1,
    priority: 0,
    longLived: kind === "walk",
    label: "test",
    // The target and the vantage are the same for every kind but `induce`.
    from: over.host,
    ...over,
    kind,
    payload,
  } as Order<K>;
}

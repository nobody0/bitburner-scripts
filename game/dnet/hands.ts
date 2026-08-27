import type { NS } from "@ns";
import { captureLaunch } from "../lib/launch-shared.ts";
import type { DnetHandsLaunch } from "./launch.ts";
import { dnetRealm, live } from "./shared.ts";

/** The controller's hands: ONE process, for the whole net, that owns the calls
 * the controller cannot own itself.
 *
 * The controller is the only darknet process that blocks — it parks in
 * `dnet.nextMutation` for ever — so it may own no other call: while
 * `env.runningFn` is set, a second call of its own would throw. Everything it
 * does is therefore borrowed from a process that is NOT blocked, through that
 * process's `ns`. Every script shares one JS realm, so an `ns` is a live object
 * bound to its owner, and a call made through it is billed to that owner's
 * `ramOverride`.
 *
 * Two kinds of call, two kinds of lender, and the split is the whole point:
 *
 * - **Host-BOUND** — `dnet.probe` scans from the calling host, `exec` reaches
 *   only self and connected. Those can only come from a process standing on
 *   that host, which is what the prober is for.
 * - **Global** — `getServerDetails`, `dnsLookup`, `getServerMaxRam`, `kill`.
 *   These work on any host from anywhere, so exactly one process needs to be
 *   able to make them. That is this one.
 *
 * Putting the global surface on the prober instead would have charged **every
 * host in the net, for ever**, for calls the controller makes centrally. Here
 * it is one process, once, on home.
 *
 * It parks on a plain unresolved Promise, never `ns.asleep`: sleeping is itself
 * a Netscript call and would hold `env.runningFn`, making the lent `ns` throw
 * CONCURRENCY ERROR for every borrower. That single line is what the whole
 * arrangement rests on — see `HostEntry.ns` for the same rule on the prober.
 *
 * A dodge would also work and costs nothing while idle, but it is a process
 * per batch and its closure must be synchronous and self-contained. A warm
 * lender lets the controller read the way it always did — synchronously, at
 * the point it needs the fact — which is what keeps `fileWork` and the plant
 * handshake synchronous. The RAM is the price of that ergonomics, and it is
 * paid once rather than per host.
 *
 * Like the prober it references no billable member of its own: its budget is
 * the `ramOverride` its launcher declares, pinned by
 * `tests/ram-budget.test.ts`. */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetHandsLaunch>("dnet-hands", ns.args[0]);
  if (!launch) return;

  // CHECK OUT before checking in, so the ordering cannot be forgotten. `atExit`
  // runs on a kill as well as a clean exit, which makes it the only place that
  // can promise the lent `ns` is retracted the moment it stops being callable.
  // Identity-guarded: a replacement may already have published its own, and
  // this one must not retract that.
  ns.atExit(() => {
    const realm = dnetRealm();
    if (realm.dnet_hands === ns) delete realm.dnet_hands;
    live()?.wake("hands-died");
  }, "dnet-hands-checkout");

  dnetRealm().dnet_hands = ns;
  live()?.wake("hands-standing");

  // Nothing else, for ever. Not `ns.asleep`: see above.
  await new Promise<never>(() => {});
}

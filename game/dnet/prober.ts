import type { NS } from "@ns";
import { captureLaunch } from "../lib/launch-shared.ts";
import type { DnetProberLaunch } from "./launch.ts";
import { live } from "./shared.ts";

/** The prober: the one darknet process that MUST stand on its host, and the
 * host's whole standing cost.
 *
 * It does not act. It LENDS.
 *
 * Every Bitburner script runs in one JS realm, so an `ns` is a live object
 * bound to its owning process and a call made through it is billed to that
 * process's `ramOverride`. So this process publishes its own `ns` into the
 * host's entry and then does nothing at all: the controller decides, and this
 * allocation pays for the two calls that cannot be made from anywhere else.
 *
 * - `dnet.probe` scans from the CALLING host, so adjacency can only be learned
 *   by a process standing here.
 * - `exec` reaches only self and connected, so a worker on this host can only
 *   be launched from here (or from a neighbour — `exec` takes its target as an
 *   argument, which is what makes recovery possible when this process dies).
 *
 * Everything else the controller needs is global — `kill` by pid,
 * `getServerDetails`, `dnsLookup`, `getServerMaxRam` — and is dodged for the
 * length of one batch rather than reserved on every host forever.
 *
 * **It must hold no Netscript call of its own.** Bitburner allows one per
 * script: while `env.runningFn` is set, every borrowed call would throw
 * CONCURRENCY ERROR. So it parks on a plain unresolved Promise, which is not a
 * call and holds nothing. NEVER `ns.asleep` — that is a call, and it would make
 * the lent `ns` useless while looking perfectly idle. This is the single line
 * the whole design rests on.
 *
 * `atExit` clears the lent `ns` and wakes the controller. The controller
 * launches replacements through neighbours; the prober never revives itself.
 *
 * The one rule it shares with `agent.ts`: no billable `ns` member beyond
 * `PROBER_CALLS` (`dnet.probe`, `exec`), because its cost is the `ramOverride`
 * its launcher declares, pinned by `tests/ram-budget.test.ts`. Note that it
 * REFERENCES neither — they are called through the lent object by someone
 * else — so the budget is a promise this file cannot keep on its own. */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetProberLaunch>("dnet-prober", ns.args[0]);
  if (!launch) return;
  const host = launch.host;

  const controller = live();
  if (!controller) return;
  // CHECK OUT before checking in, so the ordering cannot be forgotten: the
  // engine runs `atExit` on a kill as well as a clean exit, which makes this
  // the only place that can promise the lent `ns` is retracted the moment it
  // stops being callable. Guarded on identity — a replacement prober may
  // already have published its own, and this one must not retract that.
  ns.atExit(() => {
    const held = live()?.hosts.get(host);
    if (held?.ns === ns) held.ns = undefined;
    live()?.wake("prober-died");
  }, "dnet-prober-checkout");

  // CHECK IN. The controller probes through the lent `ns` inside this call, so
  // a freshly planted host is on the map before this line returns — which is
  // what the plant's first-probe barrier is waiting for.
  controller.lend(host, ns, ns.pid, launch.refresh);

  // Nothing else, for ever. Not `ns.asleep`: see above.
  await new Promise<never>(() => {});
}

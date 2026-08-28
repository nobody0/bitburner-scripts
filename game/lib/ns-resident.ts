import type { NS } from "@ns";
import type { ProxyLaunch } from "./ns-proxy-shared.ts";
import { captureLaunch } from "./launch-shared.ts";

/** The ns resident. Synced as lib/ns-resident.js; launched by createNsProxy
 * via ns.exec with a ramOverride sized to the budget it is to hold.
 *
 * It does not act. It LENDS — the same design the darknet prober runs on
 * (game/dnet/prober.ts), generalised to the whole home-side automation. This
 * process publishes its own `ns` and then does nothing at all, so every call
 * the proxy makes through that object is billed to THIS allocation instead of
 * to main.js. A function's cost is charged once per running script, so a
 * resident that has already paid for `singularity.getOwnedAugmentations` runs
 * it free for the rest of its life.
 *
 * **It must hold no Netscript call of its own.** Bitburner allows one per
 * script: while `env.runningFn` is set every borrowed call throws CONCURRENCY
 * ERROR. So it parks on `launch.stop`, a plain JS promise, which is not a call
 * and holds nothing. NEVER `ns.asleep` — that is a call, and it would make the
 * lent `ns` useless while looking perfectly idle.
 *
 * Keep this file free of value imports beyond `captureLaunch` and of any
 * billable ns reference, so its static base stays 1.6 GB and the whole
 * allocation belongs to the proxy's budget. */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<ProxyLaunch>("ns-proxy", ns.args[0]);
  // Missing rendezvous happens after a game restart; die quietly.
  if (!launch) return;

  // CHECK OUT before checking in, so the ordering cannot be forgotten: the
  // engine runs atExit on a kill as well as a clean exit, which makes this the
  // only place that can promise the proxy hears about a resident that stopped
  // being callable — and the only signal that says the RAM is actually back.
  ns.atExit(() => launch.gone(), "ns-resident-exit");

  launch.publish(ns);

  // Nothing else, until the proxy asks. Not `ns.asleep`: see above.
  await launch.stop;
}

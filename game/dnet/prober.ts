import type { NS } from "@ns";
import { captureExecLaunch, captureSpawnLaunch, offerSpawnLaunch, temporaryRunOptions } from "../lib/launch-shared.ts";
import type { DnetProberLaunch } from "./launch.ts";
import { live, PROBER_GB } from "./shared.ts";

/** This file, as the engine names it. A `spawn` takes a path, not a module. */
const PROBER_FILE = "dnet/prober.js";

/** Any non-zero delay dodges the restart sweep; this is the smallest one that
 *  does, so the host is dark for as little time as possible. */
const ARMOUR_SPAWN_DELAY_MS = 1;

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
 * launches replacements through neighbours — except when this launch was
 * ARMOURED, which is the one case the prober does revive itself, because a host
 * restart is the one death no neighbour can beat. See the armour hook below.
 *
 * The one rule it shares with `agent.ts`: no billable `ns` member beyond what
 * its launcher sized it for, because its cost is the `ramOverride` that launcher
 * declares, pinned by `tests/ram-budget.test.ts`. There are two sizes:
 * `PROBER_CALLS` (`dnet.probe`, `exec`, `dnet.connectToSession`) at
 * `PROBER_GB`, and `PROBER_ARMOURED_CALLS` — the same plus `spawn` — at
 * `PROBER_ARMOURED_GB`. A stasis launch pays only for `dnet.probe`; its
 * controller-managed agents are started by an atomic ns-proxy lease. The
 * armour hook is the only place this file calls
 * anything billable, and it is gated on `launch.armoured` for exactly that
 * reason: a prober that spawned without having been sized for it would be
 * killed mid-call by the engine's dynamic RAM check. Everything else here is
 * called through the lent object by someone else, so the rest of the budget is
 * a promise this file cannot keep on its own. */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const entity = captureExecLaunch<DnetProberLaunch>(ns, "dnet-prober")
    ?? captureSpawnLaunch<DnetProberLaunch>(ns, "dnet-prober", ns.args[0]);
  if (!entity) return;
  const launch = entity.descriptor;
  const host = launch.host;

  const controller = live();
  if (!controller) return;
  // CHECK OUT before checking in, so the ordering cannot be forgotten: the
  // engine runs `atExit` on a kill as well as a clean exit, which makes this
  // the only place that can promise the lent `ns` is retracted the moment it
  // stops being callable. Guarded on identity — a replacement prober may
  // already have published its own, and this one must not retract that.

  // ARMOUR, when this launch paid for it. Registered AFTER the checkout hook so
  // the lent `ns` is retracted first and the successor cannot race a stale one.
  //
  // `exec` cannot save this host. `killServerScripts` drives ONE live iterator
  // across the host's running-script map and runs each `atExit` synchronously
  // inside that loop, so a replacement started here is appended to the map
  // being walked and killed by the same sweep. `spawn` with a non-zero delay is
  // the only way out: upstream registers its `setTimeout` before killing the
  // caller and never cancels it, so the successor lands as a macrotask, after
  // the whole restart transaction. One millisecond is enough — the number does
  // not matter, only that it is not zero.
  //
  // The throw is expected: `spawn` raises ScriptDeath so nothing after it runs.
  // The engine wraps EACH handler in its own try/catch, so this cannot stop the
  // checkout hook above from running.
  if (launch.armoured === true) {
    ns.atExit(() => {
      const g = live();
      if (!g) return;
      // The successor comes back UNARMOURED, because armour is a fuse rather
      // than a coat: it has just been spent, and it cannot be needed again for
      // the same event. `mutationLock` freezes the ordinary clock for the whole
      // burst and `restartAllDarknetServers` walks the fleet once, so no host is
      // restarted twice by one storm. And if this was the ordinary per-tick
      // draw instead, the restart cleared the backdoor that justified the armour
      // — so `planArmour` would not ask for it again either.
      //
      // The controller re-arms through `resizeProber` if it still wants to, at
      // an order boundary and out of a smaller allocation than the 5.15 GB this
      // process was holding.
      const offer = offerSpawnLaunch<DnetProberLaunch>({ kind: "dnet-prober", host });
      // The controller is the only thing that knows whether this death was
      // ordered. A deliberate kill must not respawn, or every replacement and
      // every resize becomes a respawn loop.
      if (!g.announceProberRespawn(host, ns.pid, offer.ticket, offer.withdraw)) {
        offer.withdraw();
        return;
      }
      ns["spawn"](
        PROBER_FILE,
        temporaryRunOptions({ threads: 1, ramOverride: PROBER_GB, spawnDelay: ARMOUR_SPAWN_DELAY_MS }),
        offer.ticket,
      );
    }, "dnet-prober-armour");
  }

  // CHECK IN. The controller probes through the lent `ns` inside this call, so
  // a freshly planted host is on the map before this line returns — which is
  // what the plant's first-probe barrier is waiting for.
  controller.lend(host, ns, entity, launch.refresh, launch.armoured === true);
  entity.ready.resolve();

  // Nothing else, for ever. Not `ns.asleep`: see above.
  await new Promise<never>(() => {});
}

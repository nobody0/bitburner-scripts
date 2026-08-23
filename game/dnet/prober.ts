import type { NS } from "@ns";
import { captureLaunch } from "../lib/launch-shared.ts";
import type { DnetProberLaunch } from "./launch.ts";
import { live } from "./shared.ts";

/** The prober: the one darknet process that MUST stand on its host.
 *
 * `probe()` is host-local — it returns the neighbours of the calling script's own
 * host and nothing else (`spec/dnet.md`) — so adjacency can only be learned by a
 * process standing there. Everything else about a host (its model, RAM, caches)
 * the overseer reads for itself from darkweb with no connection, so this process
 * does that ONE thing and nothing more: on boot, and on every net mutation, it
 * probes and files the result to the overseer, then blocks on the mutation clock.
 *
 * It never competes with the worker for the host's single job slot, which is the
 * whole point — while the worker is seconds deep in an `authenticate`, this keeps
 * the map's adjacency current the instant the net changes.
 *
 * **No safety net — 1.8 GB flat.** Unlike the resident, the prober carries no
 * `spawn` (2 GB) and no `getServerMaxRam`: its whole cost is `SCRIPT_BASE_GB` +
 * `probe` = 1.8 GB, the fixed reserve every host holds for it (`proberReserveGb`).
 * So it cannot revive itself, and it does not try — it has no atExit at all. Its
 * report stamps a timestamp into the shared `probes` map every mutation; when a
 * host RESTART kills it, that stamp simply stops advancing, and the overseer
 * reads the stale `at`, sees the prober is gone, and re-`exec`s a fresh one
 * through the host's worker (a max-priority `relaunchProbe` job). A host DELETE or
 * a prestige destroys the host outright, and the successor overseer never
 * re-plants a host that no longer exists. Death is an ABSENCE, not an event.
 *
 * The one rule it shares with `agent.ts`: no billable `ns` member beyond
 * `PROBER_METHODS` (`probe`, `nextMutation`), because its cost is the
 * `ramOverride` its launcher declares, pinned by `tests/ram-budget.test.ts`. */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const launch = captureLaunch<DnetProberLaunch>("dnet-prober");
  if (!launch) return;
  const host = launch.host;

  // Probe once immediately (a freshly planted host must appear on the map now,
  // not at the next mutation), then on every mutation. Each report stamps this
  // host's neighbours, the time, and OUR pid — the pid so the overseer can kill
  // us if this host becomes a lab walker.
  let first = true;
  for (;;) {
    // Resolved from the LIVE rendezvous every pass, never held across the await:
    // an overseer dies with darkweb and a re-seed installs a fresh one of the
    // same generation. A gap between the two is "not yet", not "never" — skip the
    // report and try again after the next mutation. The prober keeps running
    // across a re-seed untouched, so the successor overseer just starts receiving
    // its reports again; no death, no revival.
    const controller = live();
    if (controller) {
      controller.reportProbe(host, ns.dnet.probe(), Date.now(), ns.pid);
      if (first) {
        first = false;
        launch.firstReport?.();
      }
    }
    // Block until the net changes. 0 GB, and a kill delivered while awaiting is a
    // clean ScriptDeath — the loop just ends. The controller notices the stale
    // stamp and re-establishes us through the agent.
    await ns.dnet.nextMutation();
    // All waiters resolving in this engine turn observe the same realm time;
    // the controller coalesces them before the next topology report.
    live()?.noteMutation(Date.now());
  }
}

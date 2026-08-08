import type { Server } from "@ns";
import type { Heap } from "../../shared/ram/heap.ts";
import { dodgeHost, STUB_BASE_GB, type HostRam } from "../../shared/ram/placement.ts";

/** Game-side glue between the live RAM ledgers and the pure placement policy
 * (shared/ram/placement.ts). No ns calls: everything here reads the sweep
 * snapshot and the dispatcher's heap, both of which the controller already
 * holds.
 *
 * Which ledger to trust is the whole content of this file:
 *
 *  - **the heap**, when it knows the host. It is updated the instant the
 *    dispatcher reserves, so it already accounts for ops that have been
 *    allocated but not yet `exec`d. Placing a dodge on the scan's view instead
 *    would race the dispatcher and take RAM an HWGW batch was counting on.
 *  - **the scan snapshot**, otherwise. A host the heap has never seen carries
 *    no reservations, so its observed usage is the truth.
 *
 * Home asks with its reserve INCLUDED, because the home reserve is exactly
 * what a dodge stub is meant to spend. Fleet hosts ask without: nothing is
 * reserved there, and if something ever is, it is not ours. */
export function dodgeHosts(
  servers: Record<string, Server>,
  deployed: ReadonlySet<string>,
  heap?: Heap,
): HostRam[] {
  const hosts: HostRam[] = [];
  for (const server of Object.values(servers)) {
    if (!server.hasAdminRights) continue;
    const isHome = server.hostname === "home";
    const known = heap?.host(server.hostname) !== undefined;
    const freeGb = known
      ? heap!.freeOn(server.hostname, isHome)
      : Math.max(0, server.maxRam - server.ramUsed);
    hosts.push({
      hostname: server.hostname,
      freeGb,
      // Home always holds the stub — it is where the build pushes to. A fleet
      // host holds it only once the sweep has scp'd this session.
      hasStub: isHome || deployed.has(server.hostname),
    });
  }
  return hosts;
}

/** A dodge's hold on its host's RAM, for the duration of the stub. */
export interface DodgeLease {
  host: string;
  release(): void;
}

/** Pick a host for a dodge AND take the heap lease for it, atomically.
 *
 * These are one operation on purpose. Choosing a host and then reserving it
 * as two steps leaves a window in which the dispatcher can take the RAM in
 * between, and the failure mode is invisible: `ns.exec` returns 0, the dodge
 * burns its retries, and the probe reports as unaffordable on a host that had
 * room a microsecond earlier.
 *
 * `undefined` means nothing in the realm can host this dodge right now — a
 * real answer the caller reports as a skip with the price that did not fit. */
export function acquireDodge(
  hosts: readonly HostRam[],
  heap: Heap | undefined,
  budgetGb: number,
): DodgeLease | undefined {
  const host = dodgeHost(hosts, budgetGb);
  if (host === undefined) return undefined;

  // A host the heap has never seen has no competing reservations on it, so
  // there is nothing to coordinate with and the lease is a no-op. This case is
  // NOT hypothetical and getting it wrong is expensive: the heap is empty on
  // the very first sweep, and a host only enters it once the dispatcher has
  // planned against it. Treating "unknown to the heap" as "cannot place here"
  // made every probe on a cold boot report itself skipped at a price the
  // budget plainly covered.
  if (!heap || heap.host(host) === undefined) return { host, release: () => {} };

  const lease = heap.reserveOn(host, STUB_BASE_GB + budgetGb, host === "home");
  // The heap knows this host and says it is fuller than the snapshot placement
  // was built from. Rather than guess a different host, decline: the next
  // sweep rebuilds placement from the fresher ledger.
  if (!lease) return undefined;
  return { host, release: () => lease.release() };
}

import { fleetPayloadScripts } from "./fleet-payload.ts";
import { hackingState } from "./features/hacking.ts";
import { fixedHostPlacer, nsp, recycleResidents, setProxyPlacer } from "./proxies.ts";

/** Stand the ns residents somewhere worth standing, before anything else runs.
 *
 * This is the whole reason `start.js` can cost 2.9 GB. It owns `ns.exec` and
 * nothing else, so it cannot scan, cannot root and cannot copy — every one of
 * those is a billable member. What it CAN do is exec a resident onto home
 * blind, on the arithmetic that a fresh game has 8 GB of home RAM and
 * `start.js` takes 2.9 of it (`HOME_BOOTSTRAP_EXECUTABLE_GB`). That first
 * resident is small and temporary, and its only job is this function.
 *
 * The two targets are hardcoded, and that is the point. `n00dles` and
 * `foodnstuff` exist in every BitNode, need hacking level 1, and need zero
 * open ports — so they can be rooted with `nuke` alone, on the first tick of a
 * fresh game, with no fleet knowledge whatsoever. Discovering that by scanning
 * would need the very resident we are trying to place. `foodnstuff` is tried
 * first because its 16 GB is what the main resident wants; `n00dles` (4 GB) is
 * the fallback, and both are near-worthless to the batcher, so parking a
 * resident there costs the farm almost nothing.
 *
 * Once one of them holds the payload the residents are recycled onto it, which
 * kills the temporary home resident and hands its 5.1 GB back. From here the
 * automation is entirely proxied, and the controller later swaps in a
 * fleet-wide placer that can grow the resident onto something bigger.
 *
 * Returns the host the residents were moved to, or undefined if neither could
 * be secured — in which case they stay on home and the ordinary fleet sweep
 * picks the problem up. */
export const BOOTSTRAP_HOSTS = ["foodnstuff", "n00dles"] as const;

export async function bootstrapResidentHost(): Promise<string | undefined> {
  const call = nsp;
  const payload = fleetPayloadScripts();

  for (const host of BOOTSTRAP_HOSTS) {
    try {
      // `nuke` throws if the host is already rooted, so ask first. A rooted
      // host on a fresh game means a handoff or a reload, not an error.
      if (!await call("hasRootAccess", host)) await call("nuke", host);
      if (!await call("hasRootAccess", host)) continue;
      if (!await call("scp", payload, host)) continue;

      // Measured rather than hardcoded: 0.05 GB, and a purchased-server rename
      // or a modded node would make a literal wrong for no benefit.
      const capacityGb = await call("getServerMaxRam", host);
      if (capacityGb <= 0) continue;

      // REGISTER IT AS DEPLOYED, or the farm eats it before the reserve lands.
      //
      // The arena only reserves a host it can see as rooted AND deployed, and
      // `deployed` is the fleet sweep's record of where it has copied the
      // payload. This function just did that copy, so saying so is simply the
      // truth — but the TIMING is the point: without it the host stays
      // unreserved until the first sweep, the dispatcher packs all of it in
      // the meantime, and the reserve then lands against a host whose `used`
      // is already full. A reserve blocks new allocations; it does not evict
      // running HGW workers, so the resident is exiled to whatever is left
      // (measured: back to home, permanently).
      hackingState().deployed.add(host);

      // Order matters: point the placer FIRST, then kill the residents. The
      // next proxied call respawns them on the new host, and the temporary
      // home resident's RAM is released as part of that recycle.
      setProxyPlacer(fixedHostPlacer(host, capacityGb));
      await recycleResidents();
      return host;
    } catch {
      // A refusal here is not fatal: the other candidate may work, and failing
      // both only leaves the residents on home, which already works.
      continue;
    }
  }
  return undefined;
}

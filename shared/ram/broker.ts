/** Every script's static base, which a resident's `ramOverride` must cover on
 * top of the budget it is to spend. It lives here rather than beside the proxy
 * because the arena reserves EXECUTABLE blocks — base plus budget — and the
 * two numbers must be the same one.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L10-L29 */
export const RESIDENT_BASE_GB = 1.6;

/** Home keeps this much farm-free at ALL times.
 *
 * It is the floor `placeResident` falls back to when the fleet view cannot
 * place a resident at all: the view is itself built BY a proxied call, so on a
 * cold boot there is none, and after one there is a snapshot that still counts
 * the process the respawn just killed. Held unconditionally, because the old
 * split (4.1 cold, 3.6 once n00dles was rooted) left the boot-path sweep's
 * 4.1 GB exec racing the farm on home. It also exceeds the 3.6 GB a build
 * handoff briefly needs for two `start.js` instances. */
export const HOME_RESERVE_GB = 4.1;

/** The bootstrap host's reserved SLICE: ONE resident at Go-turn size.
 *
 * Go is the first feature that must run the moment a resident stands — its
 * node-power rewards compound for the whole run — and its dearest calls
 * (`go.makeMove`, `go.getBoardState`) price at 4 GB, so the guaranteed floor
 * is base 1.6 + 4 = 5.6 GB. One slot, not two: the residents do not need
 * simultaneous guarantees — the second stands in ordinary free RAM (the
 * unreserved rest of this host, n00dles, anything rooted), and if the farm
 * ever squeezes it out its standing ask re-carves room. The REST of the
 * bootstrap host and all of n00dles belong to the batcher: reserving both
 * hosts whole withheld 20 GB from an 8 GB-home cold start.
 *
 * Growth beyond the slice is the resident ask-carve's job, and the static
 * network supplies the ladder (worst-case skill rolls, vendored metadata):
 * neo-net (32 GB, skill <= 50, 1 port), zer0 (32 GB, 75), iron-gym (32 GB,
 * 100), silver-helix (64 GB, 150, 2 ports — fits the singularity-era ~61 GB
 * ask). A grown ask lands on the smallest rooted host that fits, so the
 * upgrade happens the moment the sweep roots the next rung. */
export const BOOTSTRAP_RESIDENT_SLICE_GB = RESIDENT_BASE_GB + 4;

export interface BrokerHost {
  hostname: string;
  maxRam: number;
  freeGb: number;
  rooted: boolean;
  deployed: boolean;
}

/** One resident's standing claim on the fleet: where it is now, the executable
 * block it holds, and the block it will ask for at its next respawn.
 *
 * `host` is absent while a resident is between placements — which is exactly
 * the case the reserve exists for, since a resident that cannot find room
 * spins in `#respawn` holding nothing at all. */
export interface ResidentAsk {
  host?: string;
  /** Executable GB currently granted; 0 before the first placement. */
  gb: number;
  /** Executable GB the next respawn will ask for. */
  wantGb: number;
}

export interface ArenaPlan {
  reserves: Record<string, number>;
  hosts: string[];
  /** Largest reserved contiguous executable block. */
  targetGb: number;
  arenaGb: number;
  /** The largest single ns call the arena can serve: `targetGb` less a
   * resident's own base cost. */
  guaranteedDynamicGb: number;
  farmCostPerSec: number;
}

/** The RAM the farm may not have.
 *
 * Pure: it never leases anything. The controller commits nothing from this —
 * the reserves are PUBLISHED, and the farm planner reads them to keep that RAM
 * farm-free and to cooperatively stop share workers where a reserve outgrew
 * free RAM (`shared/strategy/dispatch.ts`). That is the arena's whole job now
 * that nothing queues for it.
 *
 * Three sources, in order:
 *
 *   - **home**, `HOME_RESERVE_GB`, always. It is the placer's last resort and
 *     the boot path's only ground.
 *   - **the bootstrap host** — `foodnstuff`, else `n00dles` — a Go-sized
 *     SLICE (`BOOTSTRAP_RESIDENT_SLICE_GB`), held as a floor BEFORE any
 *     resident stands on it. Both root on the first tick of a fresh game
 *     (0 ports, skill 1), so the bootstrap can count on the slice being free
 *     when it places the first resident (game/lib/bootstrap.ts). The rest of
 *     the host and all of n00dles farm.
 *   - **each resident's own ask**, which is the carve. A resident whose budget
 *     must GROW — the pre-SF4-level-3 singularity reads price at 48-80 GB and
 *     exceed every static host — needs a block big enough to respawn into, and
 *     if the farm has packed the fleet it will spin on `proxy.slow` for ever.
 *     So the arena reserves `max(held, wanted)` on the host it stands on, and
 *     where the want does not fit there, the SMALLEST host that can hold it —
 *     smallest so the largest contiguous hack block survives. This replaces
 *     the dodger's starvation carve, which had to wait five seconds for a
 *     queue entry to prove its need; a resident's ask is a standing fact and
 *     needs no such evidence. */
export function ramArena(
  hosts: readonly BrokerHost[],
  residents: readonly ResidentAsk[],
  moneyPerSecPerGb: number,
): ArenaPlan {
  const usable = hosts.filter((host) => host.rooted && host.deployed && host.maxRam > 0);
  const byName = new Map(usable.map((host) => [host.hostname, host]));
  const reserves: Record<string, number> = {};
  const hold = (hostname: string, gb: number): void => {
    reserves[hostname] = Math.max(reserves[hostname] ?? 0, gb);
  };

  const home = byName.get('home');
  if (home) hold('home', Math.min(home.maxRam, HOME_RESERVE_GB));
  const bootstrap = byName.get('foodnstuff') ?? byName.get('n00dles');
  if (bootstrap) hold(bootstrap.hostname, Math.min(bootstrap.maxRam, BOOTSTRAP_RESIDENT_SLICE_GB));

  for (const resident of residents) {
    const wantGb = Math.max(resident.gb, resident.wantGb);
    const standing = resident.host === undefined ? undefined : byName.get(resident.host);
    if (standing && standing.maxRam >= wantGb) {
      hold(standing.hostname, Math.min(standing.maxRam, wantGb));
      continue;
    }
    // The resident cannot grow where it is. Keep what it already holds there
    // so the respawn is not evicted from under itself, and open the smallest
    // host that can take the size it wants.
    if (standing) hold(standing.hostname, Math.min(standing.maxRam, resident.gb));
    const candidate = usable
      .filter((host) => host.maxRam >= wantGb)
      .sort((a, b) => a.maxRam - b.maxRam || a.hostname.localeCompare(b.hostname))[0];
    if (candidate) hold(candidate.hostname, wantGb);
  }

  const arenaGb = Object.values(reserves).reduce((sum, gb) => sum + gb, 0);
  const targetGb = Math.max(0, ...Object.values(reserves));
  return {
    reserves,
    hosts: Object.keys(reserves).sort(),
    targetGb,
    arenaGb,
    guaranteedDynamicGb: Math.max(0, targetGb - RESIDENT_BASE_GB),
    farmCostPerSec: Math.max(0, moneyPerSecPerGb) * arenaGb,
  };
}

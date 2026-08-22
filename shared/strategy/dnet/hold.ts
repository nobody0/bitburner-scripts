/** What to hold, what to expose, and what to push around.
 *
 * Spreading and cracking are unbounded — we authenticate everything we can
 * reach, because an attempt costs only time and a wrong guess is not even
 * punished. These three are the exceptions, the only darknet actions with a real
 * price, and each is priced differently:
 *
 * - **A backdoor** buys remote `exec` and costs global authentication slowdown
 *   past a free allowance.
 * - **A stasis link** buys immortality for one host and costs one of at most
 *   four slots in the entire run.
 * - **An induced migration** buys a re-roll of one host's position and costs a
 *   long charge — and, in the worst case, the host.
 *
 * Everything here is a pure function of what we believe. The jobs that carry the
 * decisions out live in `game/dnet/jobs.ts`.
 *
 * ## A stasis link is strictly better than a backdoor, and the reason is subtle
 *
 * It is easy — this file did it, and said so confidently — to conclude that a
 * stasis link does not grant remote `exec`. The reasoning looks airtight: the
 * gate tests `backdoorBypasses && backdoorInstalled` and nothing else
 * (`offlineServerHandling.ts:82-97`), and `hasStasisLink` appears in exactly
 * three semantic places, none of them a reachability check.
 *
 * Every step of that is true and the conclusion is still wrong, because it only
 * ever looked at the CONSUMER. The producer settles it:
 *
 * ```ts
 * // effects.ts:233-234
 * server.hasStasisLink = shouldLink;
 * server.backdoorInstalled = shouldLink;   // <- both, every time
 * ```
 *
 * Pinning a host installs a backdoor on it, so the gate passes for the ordinary
 * reason. Releasing the link takes the backdoor away again. Upstream's error
 * message and doc comment were right; the lesson is that verifying every reader
 * of a flag proves nothing until you have also read every writer.
 *
 * The consequence is that these are not a trade-off at all. On the same host a
 * stasis link gives everything a backdoor gives, plus immunity from move, delete
 * and restart, AND costs no instability — because `getBackdooredDarknetServers`
 * filters `!hasStasisLink` (`darknetNetworkUtils.ts:90`) and the surplus counts
 * only that pool. A pinned host is a backdoor that is invisible to the tax and
 * cannot be restarted out from under us. The only thing rationing it is that
 * there are at most four, ever.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/effects.ts:91-97 (the instability allowance), :211-216
 *   src/DarkNet/effects/effects.ts:245-262 (chargeServerMigration)
 *   src/DarkNet/controllers/NetworkMovement.ts:230-260 (moveDarknetServer)
 *   src/DarkNet/controllers/NetworkGenerator.ts:203-231 (addServerToNetwork)
 *   src/DarkNet/utils/darknetNetworkUtils.ts:16-34, 69-78, 90 */

import { NET_WIDTH } from "./rates.ts";

/** What every policy here needs to know about one host. All of it is already in
 * the knowledge fold; none of it is a credential. */
export interface HoldHost {
  hostname: string;
  /** Current row. */
  depth?: number;
  /** Original row, and the thing migration is anchored on. Also what decides
   *  RAM: `baseRam = 16 * 2 ** floor(difficulty / 6)`. */
  difficulty?: number;
  maxRam?: number;
  freeGb?: number;
  blockedRam?: number;
  /** A resident of ours is standing here. */
  agentAlive: boolean;
  /** We hold this host's password. */
  hasCredential: boolean;
  /** Hosts we believe are adjacent to it. */
  neighbours?: string[];
  isStationary?: boolean;
  backdoored?: boolean;
  stasisLinked?: boolean;
  /** It is running something we could not rebuild — today, the maze walker. */
  irreplaceable?: boolean;
  gone?: boolean;
}

export interface HoldView {
  hosts: readonly HoldHost[];
  /** `getNetDepth()`. The bottom row is `netDepth - 1`. */
  netDepth: number;
  /** `getStasisLinkLimit()`: `1 + TheBrokenWings + TheHammer + TheStaff`, so 1
   *  until the labyrinth starts paying out. */
  stasisLimit: number;
  charisma: number;
  /** `getDarknetInstability().authenticationDurationMultiplier`. Anything above
   *  1 means we are already past the free allowance. */
  authDurationMultiplier: number;
}

export interface HoldRefusal {
  hostname: string;
  why: string;
  detail: string;
}

// --- backdoors ---------------------------------------------------------------

/** How many backdoors are free.
 *
 * `max(rootedMovable / (NET_WIDTH * 3), 2)` (`effects.ts:91-97`), where
 * `rootedMovable` counts movable servers with admin rights. Two are always free,
 * and the allowance grows as we root more of the net — so this is one of the few
 * places where breadth pays for depth. */
export function freeBackdoorAllowance(rootedMovable: number): number {
  return Math.max(rootedMovable / (NET_WIDTH * 3), 2);
}

export interface BackdoorPlan {
  install: string[];
  refused: HoldRefusal[];
  allowance: number;
}

/** Spend only the free allowance, and only where a backdoor buys something.
 *
 * A backdoor is worth having on a host that is a VANTAGE — one whose adjacency
 * we would otherwise lose when the net rearranges — and worth nothing on a host
 * we hold no credential for, because `exec` still checks the session.
 *
 * A stasis-linked host never reaches the ranking: pinning sets
 * `backdoorInstalled`, so it is already backdoored and filtered out. It does not
 * consume the allowance either, because `getBackdooredDarknetServers` excludes
 * it from the pool the surplus is counted over — which is why `held` below
 * counts only the taxed ones. */
export function planBackdoors(view: HoldView, ceiling = 1.0): BackdoorPlan {
  const refused: HoldRefusal[] = [];
  const live = view.hosts.filter((host) => !host.gone);
  const rootedMovable = live.filter((host) => host.hasCredential && !host.isStationary).length;
  const allowance = freeBackdoorAllowance(rootedMovable);
  // Only the TAXED pool: `getBackdooredDarknetServers` excludes stasis-linked
  // hosts, so a pinned host's backdoor is free and must not eat the allowance.
  const held = live.filter((host) => host.backdoored && !host.stasisLinked).length;

  const refuse = (hostname: string, why: string, detail: string): void => {
    refused.push({ hostname, why, detail });
  };

  // Instability above 1 means the slowdown is already biting every
  // authentication in the run, which is a tax on the thing we do most.
  if (view.authDurationMultiplier > ceiling) {
    for (const host of live) {
      if (!host.backdoored) refuse(host.hostname, "unstable", `authentication already costs x${view.authDurationMultiplier.toFixed(2)}`);
    }
    return { install: [], refused, allowance };
  }

  const ranked = live
    .filter((host) => {
      if (host.backdoored) return false;
      if (host.isStationary) {
        // darkweb and the labyrinth. `exec` onto darkweb already works from
        // home, and the labyrinth is not somewhere we run anything.
        refuse(host.hostname, "stationary", "a stationary host is already where it will always be");
        return false;
      }
      if (!host.hasCredential) {
        // The gate bypass only covers the CONNECTION requirement; the session
        // check is still there, so a backdoor without a credential buys nothing.
        refuse(host.hostname, "no-credential", "a backdoor bypasses the connection check, not the session check");
        return false;
      }
      if (!host.agentAlive && (host.neighbours?.length ?? 0) === 0) {
        refuse(host.hostname, "not-a-vantage", "nothing runs here and nothing is reached through it");
        return false;
      }
      return true;
    })
    .map((host) => ({
      host,
      // What we lose if this host's edges move: everything standing on it, plus
      // everything we reach through it.
      reach: (host.agentAlive ? 1 : 0) + (host.neighbours?.length ?? 0),
    }))
    // No stasis-linked host can appear here: pinning one sets `backdoorInstalled`
    // (see the header), so it is filtered out by the `host.backdoored` check
    // above. An earlier version sorted them first as "free"; that branch could
    // never fire.
    .sort((a, b) => b.reach - a.reach || (a.host.hostname < b.host.hostname ? -1 : 1));

  const install: string[] = [];
  for (const entry of ranked) {
    if (held + install.length >= allowance) {
      refuse(entry.host.hostname, "allowance-spent", `${allowance.toFixed(1)} free backdoors are already held`);
      continue;
    }
    install.push(entry.host.hostname);
  }
  return { install, refused, allowance };
}

// --- stasis ------------------------------------------------------------------

export interface StasisPlan {
  pin: string[];
  release: string[];
  refused: HoldRefusal[];
}

/** Rank by what dies with the host.
 *
 * A link buys two things at once — reach, because pinning sets
 * `backdoorInstalled`, and immunity from move, delete and restart — and the
 * first is available more cheaply from an ordinary backdoor. So what should
 * decide the ranking is the half a backdoor CANNOT give: a pinned host is worth
 * exactly as much as the thing standing on it is hard to replace.
 *
 * The maze walker is the extreme case and the reason this exists. Its position
 * is keyed by PID (`DarknetState.labLocations[pid]`), so a restart does not cost
 * it a few minutes, it costs the entire walk with no way to resume — and the
 * deep labs are hours long. Nothing else in the feature has that property.
 *
 * With a limit of 1 before the labyrinth pays out, this is usually a
 * one-element decision, and stating that plainly is more useful than a ranking
 * that pretends otherwise. */
export function planStasis(view: HoldView): StasisPlan {
  const refused: HoldRefusal[] = [];
  const live = view.hosts.filter((host) => !host.gone);
  const linked = live.filter((host) => host.stasisLinked);

  const value = (host: HoldHost): number => {
    if (host.irreplaceable) return 1000;
    // A block we have already ground down is sunk cost we would pay again.
    const ground = (host.maxRam ?? 0) - (host.blockedRam ?? 0);
    return (host.backdoored ? 50 : 0) + (host.agentAlive ? 10 : 0) + Math.min(ground / 16, 20);
  };

  const candidates = live
    .filter((host) => {
      if (host.stasisLinked) return false;
      if (host.isStationary) {
        // Already outside every mutation branch's victim pool; a link would buy
        // nothing and consume a slot we cannot spare.
        refuse(refused, host, "already-immune", "a stationary host is never moved, deleted or restarted");
        return false;
      }
      if (!host.agentAlive) {
        // `setStasisLink` takes no host: it pins the CALLING script's own
        // server, so pinning anything requires already standing there.
        refuse(refused, host, "nobody-there", "setStasisLink pins the calling host, so a resident must be standing on it");
        return false;
      }
      return true;
    })
    .sort((a, b) => value(b) - value(a) || (a.hostname < b.hostname ? -1 : 1));

  const spare = Math.max(0, view.stasisLimit - linked.length);
  const pin = candidates.slice(0, spare).map((host) => host.hostname);
  for (const host of candidates.slice(spare)) {
    refuse(refused, host, "no-slot", `all ${view.stasisLimit} stasis links are spent`);
  }

  // Recycle a link whose host no longer carries anything irreplaceable, but only
  // when something better is waiting — a released link costs the same 12 GB and
  // 30 s to re-apply, so churning them is worse than holding one badly.
  const release: string[] = [];
  if (spare === 0 && candidates.length > 0) {
    const worstHeld = [...linked].sort((a, b) => value(a) - value(b))[0];
    const best = candidates[0]!;
    if (worstHeld && value(worstHeld) < value(best)) release.push(worstHeld.hostname);
  }
  return { pin, release, refused };
}

function refuse(into: HoldRefusal[], host: HoldHost, why: string, detail: string): void {
  into.push({ hostname: host.hostname, why, detail });
}

// --- induced migration -------------------------------------------------------

/** The charge one call adds, from `chargeServerMigration` (`effects.ts:245-251`):
 * `((charisma + 500) / (difficulty * 200 + 1000)) * 0.01 * threads`. The host
 * moves when the accumulated charge reaches 1. */
export function migrationChargePerCall(difficulty: number, charisma: number, threads = 1): number {
  return ((charisma + 500) / (difficulty * 200 + 1000)) * 0.01 * threads;
}

/** Calls to move one host, at a fixed thread count. Each carries a hardcoded 6 s
 * delay (`NetscriptFunctions/Darknet.ts:443`). */
export function migrationCalls(difficulty: number, charisma: number, threads = 1): number {
  const per = migrationChargePerCall(difficulty, charisma, threads);
  return per > 0 ? Math.ceil(1 / per) : Infinity;
}

/** Whether a host's migration band can even reach the bottom row.
 *
 * **This is the fact the whole idea turns on.** `induceServerMigration` resolves
 * to `moveDarknetServer(server, 2, 4)`, and that function's `startingDepth`
 * defaults to **`server.difficulty`, not `server.depth`**
 * (`NetworkMovement.ts:230-234`). So every migration re-rolls the host inside
 * `[difficulty - 2, difficulty + 4]`, anchored on where it ORIGINALLY sat.
 *
 * A host cannot therefore be walked progressively deeper: charging a shallow
 * server a hundred times leaves it shallow. To land on the bottom row it must
 * already satisfy `difficulty + 4 >= netDepth - 1`.
 *
 * Which is why "use a big server" is the right instinct for a better reason than
 * size: `maxRam` is a function of difficulty, so the biggest hosts are exactly
 * the ones whose band reaches the bottom. */
export function canReachBottomRow(difficulty: number, netDepth: number): boolean {
  return difficulty + 4 >= netDepth - 1;
}

export interface InducePlan {
  /** The host to push, and the neighbour that must do the pushing —
   *  `induceServerMigration` cannot target its own host. */
  push?: { host: string; from: string; expectedCalls: number; reason: string };
  refused: HoldRefusal[];
}

/** Pick a host to push toward the bottom row, so that it lands adjacent to the
 * labyrinth.
 *
 * Adjacency is not something we steer toward: `addServerToNetwork` connects any
 * server landing at `depth === netDepth - 1` to the lab automatically
 * (`NetworkGenerator.ts:225-230`). So the whole problem is "land on the bottom
 * row", and the whole lever is a re-roll inside the host's band.
 *
 * Three things make this worth doing at all, and one makes it dangerous:
 *
 * - A move does NOT kill processes, sessions or admin rights — only restart and
 *   delete do — so our resident, its session and its solver state ride along.
 * - Each call pays `charisma_exp * 5 * threads * difficulty`, which on a deep
 *   host is competitive with phishing as a charisma engine. The charge is never
 *   wasted even when the landing is wrong.
 * - Once it lands, a stasis link makes the edge PERMANENT: the lab is
 *   `isStationary` and a pinned host is excluded from `getAllMovableDarknetServers`,
 *   so neither endpoint can ever be chosen by `disconnectRandomServer`.
 *
 * The danger: if `getAllOpenPositions` finds nothing, `moveDarknetServer`
 * DELETES the host rather than leaving it floating (`NetworkMovement.ts:246-250`).
 * That is rarer than it looks — the function widens its band recursively until
 * it finds a slot (`darknetNetworkUtils.ts:30-32`), so it only empties when the
 * whole net is full — but the loss is total, so anything irreplaceable is never
 * pushed. */
export function planInduce(view: HoldView): InducePlan {
  const refused: HoldRefusal[] = [];
  const bottom = view.netDepth - 1;
  const live = view.hosts.filter((host) => !host.gone);

  const candidates = live.filter((host) => {
    if (host.isStationary) {
      refuse(refused, host, "stationary", "upstream throws rather than moving a stationary host");
      return false;
    }
    if (host.stasisLinked) {
      refuse(refused, host, "pinned", "a stasis link is what stops it moving; pushing it would undo the point");
      return false;
    }
    if (host.irreplaceable) {
      refuse(refused, host, "irreplaceable", "a failed migration deletes the host, and this one carries work we cannot rebuild");
      return false;
    }
    if (host.depth === bottom) {
      refuse(refused, host, "already-there", "already on the bottom row, so already connected to the labyrinth");
      return false;
    }
    if (host.difficulty === undefined) {
      refuse(refused, host, "unknown-band", "migration is anchored on difficulty, which has not been observed");
      return false;
    }
    if (!canReachBottomRow(host.difficulty, view.netDepth)) {
      // The correction that kills the naive plan: this is not "not yet", it is
      // "never". No quantity of charge moves this host past difficulty + 4.
      refuse(
        refused,
        host,
        "band-too-shallow",
        `difficulty ${host.difficulty} bands it to depth ${host.difficulty + 4} at best, short of row ${bottom}`,
      );
      return false;
    }
    return true;
  });

  // Biggest first, because RAM is a function of difficulty and the walker needs
  // room for a 12 GB stasis job as well as itself. Ties by the deeper band,
  // which is also the better chance of landing on the bottom row: the band is
  // clipped at the net floor, so a higher difficulty means a smaller band with
  // the bottom row a larger fraction of it.
  const ranked = [...candidates].sort((a, b) =>
    (b.maxRam ?? 0) - (a.maxRam ?? 0)
    || (b.difficulty ?? 0) - (a.difficulty ?? 0)
    || (a.hostname < b.hostname ? -1 : 1));

  for (const host of ranked) {
    // Somebody adjacent has to do the pushing, and it cannot be the host itself.
    const pusher = live.find((other) =>
      other.hostname !== host.hostname
      && other.agentAlive
      && (other.neighbours?.includes(host.hostname) ?? false));
    if (!pusher) {
      refuse(refused, host, "no-pusher", "induceServerMigration cannot target its own host, and no neighbour of ours is standing next to it");
      continue;
    }
    const calls = migrationCalls(host.difficulty!, view.charisma);
    return {
      push: {
        host: host.hostname,
        from: pusher.hostname,
        expectedCalls: calls,
        reason:
          `${(host.maxRam ?? 0)}GB at difficulty ${host.difficulty}, band reaches row ${bottom}`
          + ` — ~${calls} calls at 1 thread`,
      },
      refused,
    };
  }
  return { refused };
}

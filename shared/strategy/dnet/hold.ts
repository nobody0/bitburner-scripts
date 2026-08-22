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

import { fresh, type DarknetHostKnowledge, type ExpiryOpts } from "./knowledge.ts";
import { isOnAirGap, NET_WIDTH } from "./rates.ts";

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
  /** What ONE THREAD of an induce job costs. The migration charge is linear in
   *  the calling script's threads while the 6 s wait is constant, so threads
   *  divide the calls-to-move directly — the difference between a hopeless
   *  project and an afternoon. Omitted, pushes are priced at one thread. */
  induceGbPerThread?: number;
  /** Whether one stasis slot must be HELD BACK for the maze walker's vantage.
   *
   *  The walker is the one thing in the feature that cannot be rebuilt — its
   *  position is keyed by PID, and the deep labs are hours long — so a run that
   *  spent every link on spare coverage and then found the walk's vantage
   *  unpinnable has traded the critical thing for a nice one. Set by the
   *  overseer while the labyrinth still needs walking; the reservation stands
   *  down on its own the moment an irreplaceable host is linked or is being
   *  pinned this pass, because that IS the walker's slot being spent. */
  reserveForWalker?: boolean;
  /** Where the SPARE links should sit — `stasisTargetDepths`' output, computed
   *  by the caller because the spare count depends on whether a walker slot
   *  exists in this world at all. Absent or empty means no spare is ever
   *  admitted, which is the pre-lab default: the limit is 1 and the one slot
   *  is the walker's. */
  spareTargets?: readonly number[];
  /** Whether the labyrinth still needs a bottom-row vantage minted for it —
   *  the walk has not finished and no walk is holding one. Gates `planInduce`'s
   *  `lab` purpose: with the walk done (or no lab in the world) a push to the
   *  bottom row buys nothing, and the same big hosts serve the spare seats
   *  instead. Absent reads as true, today's behaviour. */
  needLabVantage?: boolean;
}

export interface HoldRefusal {
  hostname: string;
  why: string;
  detail: string;
}

/** The shared core of a `HoldHost`, projected from one knowledge record.
 *
 * The overseer and home each build these from the same fold but see different
 * extras — the overseer spreads in `difficulty`/`maxRam`/`freeGb`/
 * `irreplaceable`, home spreads in `backdoored` — so this covers only what both
 * derive identically: the fresh facts, and the three flags the caller already
 * holds. Fields stay ABSENT rather than `undefined` when unknown; the planners
 * branch on `!== undefined` and the tests pin the difference. */
export function holdHostFrom(
  standing: DarknetHostKnowledge,
  opts: {
    at: number;
    expiry: ExpiryOpts;
    agentAlive: boolean;
    hasCredential: boolean;
    stasisLinked: boolean;
  },
): HoldHost {
  const depth = fresh<number>(standing, "depth", opts.at, opts.expiry);
  const neighbours = fresh<string[]>(standing, "neighbours", opts.at, opts.expiry);
  return {
    hostname: standing.hostname,
    ...(depth !== undefined ? { depth } : {}),
    agentAlive: opts.agentAlive,
    hasCredential: opts.hasCredential,
    ...(neighbours !== undefined ? { neighbours } : {}),
    ...(fresh<boolean>(standing, "isStationary", opts.at, opts.expiry) === true ? { isStationary: true } : {}),
    ...(opts.stasisLinked ? { stasisLinked: true } : {}),
    ...(standing.goneAt !== undefined ? { gone: true } : {}),
  };
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

/** How far from its target depth a spare may sit and still claim it.
 *
 * One row: a pin's post-storm catchment spans its own row and the rows beside
 * it, so a one-row miss barely moves the coverage — while insisting on the
 * exact row multiplies the migration re-rolls needed to seat one (a push is a
 * RANDOM re-roll inside the host's band, so a three-row window is roughly
 * three times fewer full charges than one row). The WALKER gets no slack: its
 * admission is `irreplaceable`, on `planWalk`'s say-so, and its row is the
 * lab's by construction. */
export const STASIS_TARGET_SLACK = 1;

/** Where the spare links should sit: depth-weighted equipartition.
 *
 * Spares exist to REPOPULATE the net after a webstorm. A pinned host keeps its
 * cell while everything around it re-rolls, and it keeps RECEIVING edges — the
 * wiring pass of every added or moved server treats it as a normal endpoint —
 * so each pin is a beachhead the fresh net wires itself back onto. Three facts
 * about that wiring decide the placement (`NetworkGenerator.ts:178-201`):
 *
 * - **Coverage is local**: a pin can only ever be wired to by arrivals in its
 *   own row and the rows beside it. Stacking pins on adjacent rows buys the
 *   same catchment twice.
 * - **Deep pins are edge-poor**: the vertical connection roll is divided by
 *   the NEIGHBOUR's depth + 1 (`Math.abs(neighbor.depth ?? x - x) + 1` — the
 *   `??` binds last, so the "distance" is the neighbour's own depth), so a
 *   depth-10 pin sees ~2.5% per vertical arrival against ~45% per lateral
 *   one. Density has to compensate where the odds are worst.
 * - **Deep rows are the slow half of a reconquest**: `darkweb` re-covers row 0
 *   for free (every depth-0 arrival wires to it), while reaching the bottom
 *   from the top again is the whole crawl. A surviving deep vantage saves the
 *   most wall clock — the same reason the walker's own row is the prize.
 *
 * So the targets are the equal-mass centers under a weight that grows with
 * depth (w(d) = d + 1): evenly spread by MASS, which is denser toward the
 * bottom by construction. The walker's row and the row beside it are excluded
 * — the walker's pin already covers them — and air-gap rows, which can hold
 * nothing, shift a target one row up.
 *
 * In a LAB-LESS world (program-only access never generates a labyrinth) there
 * is no walker, so the deepest anchor — the bottom row itself — is a spare's,
 * and the rest spread above it. The limit can never grow there (the +1s are
 * labyrinth augmentations), so in practice that world has exactly one link,
 * and it sits at the bottom. */
export function stasisTargetDepths(netDepth: number, spares: number, labExpected = true): number[] {
  if (spares <= 0) return [];
  const targets: number[] = [];
  const claim = (depth: number): void => {
    let d = Math.max(0, Math.min(depth, netDepth - 1));
    // An air-gap row holds nothing, and two targets on one row are one target.
    // Deeper targets are claimed first, so a collision steps SHALLOWER — into
    // the half where coverage is cheaper to concede.
    while (d >= 0 && (isOnAirGap(d) || targets.includes(d))) d--;
    if (d >= 0) targets.push(d);
  };
  let remaining = spares;
  if (!labExpected) {
    claim(netDepth - 1);
    remaining--;
  }
  // Rows 0..top: everything below the walker's row and its immediate
  // neighbour, which the walker's own pin already covers.
  const top = netDepth - 3;
  if (top >= 0 && remaining > 0) {
    for (let i = remaining; i >= 1; i--) {
      // Centers of equal-mass bands under w(d) = d + 1: the cumulative mass to
      // x is proportional to x², so band i's center sits at sqrt((i - ½) / k).
      const x = (top + 1) * Math.sqrt((i - 0.5) / remaining);
      claim(Math.round(x - 0.5));
    }
  }
  return targets.sort((a, b) => b - a);
}

/** Whether a host at this depth serves this target. */
function nearTarget(depth: number | undefined, target: number): boolean {
  return depth !== undefined && Math.abs(depth - target) <= STASIS_TARGET_SLACK;
}

/** The spare targets no held link serves yet, deepest first.
 *
 * Shared by `planStasis`, which pins toward them, and `planInduce`, which
 * pushes big hosts into their windows. A held link within slack of several
 * targets serves the DEEPEST one, matching the order pins are assigned in. */
export function openSpareTargets(view: Pick<HoldView, "hosts" | "spareTargets">): number[] {
  const open = [...(view.spareTargets ?? [])].sort((a, b) => b - a);
  for (const held of view.hosts) {
    if (held.gone || held.stasisLinked !== true || held.irreplaceable) continue;
    const index = open.findIndex((target) => nearTarget(held.depth, target));
    if (index >= 0) open.splice(index, 1);
  }
  return open;
}

/** Pin what survives the storm.
 *
 * Two different questions share the four slots, and they are answered in
 * order:
 *
 * 1. **The walker.** Its position is keyed by PID
 *    (`DarknetState.labLocations[pid]`), so a restart does not cost it a few
 *    minutes, it costs the entire walk with no way to resume — and the deep
 *    labs are hours long. Nothing else in the feature has that property, so
 *    its host is admitted on `planWalk`'s say-so (`irreplaceable`), outranks
 *    every spare, and holds a reservation while the walk is still ahead.
 * 2. **The spares** claim `spareTargets`, deepest target first; per target the
 *    BIGGEST measured host within `STASIS_TARGET_SLACK` wins (RAM is the
 *    durable vantage's whole worth: threads for attempts, room for jobs), ties
 *    to the deeper host, then the name. A host near no open target is refused
 *    by name rather than pinned somewhere clever — coverage that drifts from
 *    the targets is exactly what the targets exist to prevent, and
 *    `planInduce`'s `seat` purpose is how an empty window gets filled.
 *
 * Releases are churn-averse — a re-apply costs the same 12 GB and 30 s — so a
 * held link is only recycled when something strictly more important is waiting:
 * the walker evicts anything ordinary, and a spare candidate on an open target
 * evicts only a held link that serves NO target at all. */
export function planStasis(view: HoldView): StasisPlan {
  const refused: HoldRefusal[] = [];
  const live = view.hosts.filter((host) => !host.gone);
  const linked = live.filter((host) => host.stasisLinked);
  const open = openSpareTargets(view);

  const walkers: HoldHost[] = [];
  const spareable: HoldHost[] = [];
  for (const host of live) {
    if (host.stasisLinked) continue;
    if (host.isStationary) {
      // Already outside every mutation branch's victim pool; a link would buy
      // nothing and consume a slot we cannot spare.
      refuse(refused, host, "already-immune", "a stationary host is never moved, deleted or restarted");
      continue;
    }
    if (!host.agentAlive) {
      // `setStasisLink` takes no host: it pins the CALLING script's own
      // server, so pinning anything requires already standing there.
      refuse(refused, host, "nobody-there", "setStasisLink pins the calling host, so a resident must be standing on it");
      continue;
    }
    // The walker's vantage is admitted on `planWalk`'s say-so — it was
    // collected as a host ADJACENT to the lab this pass. Everything else is a
    // spare, and a spare is held to the target standard.
    if (host.irreplaceable === true) walkers.push(host);
    else spareable.push(host);
  }
  walkers.sort((a, b) => (a.hostname < b.hostname ? -1 : 1));

  // Spares claim the open targets, deepest first; per target the biggest
  // measured host within slack wins. A loser may still win a shallower
  // target, so refusals are settled only after every target has chosen.
  const taken = new Set<string>();
  const spares: HoldHost[] = [];
  for (const target of open) {
    const winner = spareable
      .filter((host) => !taken.has(host.hostname)
        && host.maxRam !== undefined && nearTarget(host.depth, target))
      .sort((a, b) =>
        (b.maxRam! - a.maxRam!)
        || (b.depth! - a.depth!)
        || (a.hostname < b.hostname ? -1 : 1))[0];
    if (!winner) continue;
    taken.add(winner.hostname);
    spares.push(winner);
  }
  for (const host of spareable) {
    if (taken.has(host.hostname)) continue;
    if (host.depth === undefined || host.maxRam === undefined) {
      refuse(refused, host, "spare-unmeasured", "a spare is placed by depth and sized by RAM, and one of the two has not been believably observed");
    } else if (open.some((target) => nearTarget(host.depth, target))) {
      refuse(refused, host, "spare-outranked", `a bigger host claimed the open target near depth ${host.depth}`);
    } else {
      refuse(
        refused,
        host,
        "spare-off-target",
        open.length === 0
          ? "every spare target is already served by a held link"
          : `no open target within ${STASIS_TARGET_SLACK} of depth ${host.depth}; open targets sit at ${open.join(", ")}`,
      );
    }
  }

  // THE WALKER'S SLOT. While the labyrinth still needs walking, one free slot
  // is held back from the spares: the walk's vantage must be pinnable when the
  // walk starts, and a link released costs 12 GB and 30 s that a mutation may
  // not grant. The reservation stands down by itself when an irreplaceable
  // host is already linked or is among this pass's candidates — that is the
  // walker's slot being spent on the walker.
  const candidates = [...walkers, ...spares];
  const walkerCovered = linked.some((host) => host.irreplaceable) || walkers.length > 0;
  const reserved = view.reserveForWalker === true && !walkerCovered ? 1 : 0;
  const spareSlots = Math.max(0, view.stasisLimit - linked.length);
  const usable = Math.max(0, spareSlots - reserved);
  const pin = candidates.slice(0, usable).map((host) => host.hostname);
  candidates.slice(usable).forEach((host, index) => {
    // The first displaced candidates lost their slot to the reservation, not to
    // the limit; the distinction is the difference between "wait for the walk"
    // and "the run is out of links".
    if (usable + index < spareSlots) {
      refuse(refused, host, "reserved-for-walker", "the last free stasis link is held for the maze walker's vantage");
    } else {
      refuse(refused, host, "no-slot", `all ${view.stasisLimit} stasis links are spent`);
    }
  });

  // Releases, churn-averse: worst held first, and "worst" is off-target, then
  // shallow, then small. The walker evicts anything ordinary — its slot is the
  // one thing more important than coverage — while a displaced spare evicts
  // only a link that serves NO target, so an on-target link is never churned
  // for a same-shaped rival.
  const release: string[] = [];
  const evictable = linked
    .filter((host) => !host.irreplaceable)
    .sort((a, b) =>
      Number((view.spareTargets ?? []).some((target) => nearTarget(a.depth, target)))
      - Number((view.spareTargets ?? []).some((target) => nearTarget(b.depth, target)))
      || (a.depth ?? -1) - (b.depth ?? -1)
      || (a.maxRam ?? 0) - (b.maxRam ?? 0)
      || (a.hostname < b.hostname ? -1 : 1));
  if (spareSlots === 0) {
    if (walkers.length > 0 && evictable.length > 0) {
      release.push(evictable[0]!.hostname);
    } else if (spares.length > 0) {
      const offTarget = evictable.find((host) =>
        !(view.spareTargets ?? []).some((target) => nearTarget(host.depth, target)));
      if (offTarget) release.push(offTarget.hostname);
    }
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

/** Why a push was chosen, because four different questions share the one
 *  call: seat a lab candidate on the bottom row, clear a stranger OFF the
 *  bottom row so a candidate can land, seat a big host inside an open stasis
 *  target's window, or just deepen the net's frontier. */
export type InducePurpose = "free-slot" | "lab" | "seat" | "frontier";

export interface InducePlan {
  /** The host to push, and the neighbour that must do the pushing —
   *  `induceServerMigration` cannot target its own host. */
  push?: {
    host: string;
    from: string;
    /** Sized from the PUSHER's free RAM: the charge each call adds is linear
     *  in the calling script's threads. */
    threads: number;
    expectedCalls: number;
    reason: string;
    purpose: InducePurpose;
  };
  refused: HoldRefusal[];
}

/** Pick ONE host to push, for the best of three purposes.
 *
 * Every migration is a re-roll inside `[difficulty - 2, difficulty + 4]` (see
 * `canReachBottomRow` — the band is anchored on DIFFICULTY, never on where the
 * host currently sits), and `addServerToNetwork` connects any server landing
 * at `depth === netDepth - 1` to the lab automatically
 * (`NetworkGenerator.ts:225-230`). Three distinct things a re-roll can buy:
 *
 * 1. **`free-slot`** — the bottom row holds `NET_WIDTH` seats, and a landing
 *    needs an open one. When the row looks full and a lab candidate is
 *    waiting, the best push is a STRANGER already sitting down there: re-roll
 *    it away and its seat opens. The one push that wants a small, uncracked
 *    host rather than a big authenticated one.
 * 2. **`lab`** — the biggest authenticated host whose band reaches the bottom
 *    row, pushed whatever its current depth: every roll is a fresh chance to
 *    land at `netDepth - 1`, and the landing is the walker's future vantage.
 *    Only while `needLabVantage` — with the walk finished, or no lab in the
 *    world, the bottom row buys nothing and the same hosts serve the seats.
 * 3. **`seat`** — the biggest authenticated host whose band covers an OPEN
 *    spare-stasis target (`openSpareTargets`), pushed until a roll lands it
 *    inside the target's `STASIS_TARGET_SLACK` window, where `planStasis`
 *    pins it. A host already standing inside an open window is never pushed —
 *    a re-roll is the one thing that could move it OUT.
 * 4. **`frontier`** — with nothing to seat, general movement down. The band's
 *    centre is `difficulty + 1`, so a host at or above that depth moves DEEPER
 *    on average; one at or below it is as likely to bounce up, and is left
 *    alone (`no-gain`). Biggest first — RAM still ranks, it just stopped
 *    being an entry requirement.
 *
 * Three things make this worth paying for at all, and one makes it dangerous:
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
 * pushed. (For an evictee the danger inverts: a stranger deleted is a seat
 * freed with the files we could never read anyway.) */
export function planInduce(view: HoldView): InducePlan {
  const refused: HoldRefusal[] = [];
  const bottom = view.netDepth - 1;
  const live = view.hosts.filter((host) => !host.gone);

  const labPool: HoldHost[] = [];
  const seatPool: HoldHost[] = [];
  /** Which open target each seat push aims for, for the reason line. */
  const seatTargetFor = new Map<string, number>();
  const frontierPool: HoldHost[] = [];
  const evictPool: HoldHost[] = [];
  const openTargets = openSpareTargets(view);
  const bottomCount = live.filter((host) => host.depth === bottom).length;
  // As observed — knowledge may be missing seats we have never seen, so this
  // errs toward NOT evicting, which is the direction that spends nothing.
  const bottomFull = bottomCount >= NET_WIDTH;

  for (const host of live) {
    if (host.isStationary) {
      refuse(refused, host, "stationary", "upstream throws rather than moving a stationary host");
      continue;
    }
    if (host.stasisLinked) {
      refuse(refused, host, "pinned", "a stasis link is what stops it moving; pushing it would undo the point");
      continue;
    }
    if (host.irreplaceable) {
      refuse(refused, host, "irreplaceable", "a failed migration deletes the host, and this one carries work we cannot rebuild");
      continue;
    }
    if (host.difficulty === undefined) {
      refuse(refused, host, "unknown-band", "migration is anchored on difficulty, which has not been observed");
      continue;
    }
    if (host.depth === bottom) {
      // Ours are exactly where we want them — lab-adjacent — and are left
      // alone. A stranger down there is a SEAT, and goes in the eviction pool;
      // whether it is actually pushed is decided below, and one that is not
      // gets the same refusal as ours.
      if (!host.hasCredential && !host.agentAlive) evictPool.push(host);
      else refuse(refused, host, "already-there", "already on the bottom row, so already connected to the labyrinth");
      continue;
    }
    if (!host.hasCredential) {
      // The one refusal that fixes itself: a push moves the host wherever it
      // lands, but only a host we have AUTHENTICATED carries anything of ours
      // when it does — the session and any resident ride the move. The answer
      // is the cracking queue, not more charge.
      refuse(refused, host, "not-ours", "only an authenticated host is worth pushing; crack it first");
      continue;
    }
    if (view.needLabVantage !== false && canReachBottomRow(host.difficulty, view.netDepth)) {
      labPool.push(host);
      continue;
    }
    // Standing inside an open stasis window: `planStasis` pins it where it is,
    // and a re-roll is the one thing that could move it OUT.
    if (openTargets.some((target) => nearTarget(host.depth, target))) {
      refuse(refused, host, "on-target", "already inside an open stasis target's window; pinning it beats re-rolling it");
      continue;
    }
    // A seat push: the band covers an open target the host is not in yet.
    const seatTarget = openTargets.find((target) =>
      host.difficulty! - 2 <= target && target <= host.difficulty! + 4);
    if (seatTarget !== undefined) {
      seatPool.push(host);
      seatTargetFor.set(host.hostname, seatTarget);
      continue;
    }
    // The band's centre is difficulty + 1: at or above it a re-roll moves the
    // host deeper on average, below it the same roll is as likely to lift it.
    if (host.depth !== undefined && host.depth <= host.difficulty + 1) {
      frontierPool.push(host);
      continue;
    }
    refuse(
      refused,
      host,
      "no-gain",
      `difficulty ${host.difficulty} bands it to ${host.difficulty + 4} at best (short of row ${bottom}),`
      + ` and at depth ${host.depth ?? "unplaced"} a re-roll around ${host.difficulty + 1} is as likely to lift it`,
    );
  }

  // Biggest first for the seats we want FILLED — RAM is a function of
  // difficulty, and the walker needs room for a 12 GB stasis job as well as
  // itself. Ties by the deeper band: it is clipped at the net floor, so higher
  // difficulty means the bottom row is a larger fraction of it.
  labPool.sort((a, b) =>
    (b.maxRam ?? 0) - (a.maxRam ?? 0)
    || (b.difficulty ?? 0) - (a.difficulty ?? 0)
    || (a.hostname < b.hostname ? -1 : 1));
  // Biggest first for the seats too, ties by the DEEPER target — a contested
  // push serves the depth where surviving coverage is worth most.
  seatPool.sort((a, b) =>
    (b.maxRam ?? 0) - (a.maxRam ?? 0)
    || (seatTargetFor.get(b.hostname) ?? 0) - (seatTargetFor.get(a.hostname) ?? 0)
    || (a.hostname < b.hostname ? -1 : 1));
  // Biggest first, ties by how far below the band's centre the host sits —
  // the expected depth gained by one landing.
  frontierPool.sort((a, b) =>
    (b.maxRam ?? 0) - (a.maxRam ?? 0)
    || ((b.difficulty ?? 0) + 1 - (b.depth ?? 0)) - ((a.difficulty ?? 0) + 1 - (a.depth ?? 0))
    || (a.hostname < b.hostname ? -1 : 1));
  // SMALLEST first for the seat we want EMPTIED: the worst stranger is the
  // cheapest loss and the same one seat.
  evictPool.sort((a, b) =>
    (a.maxRam ?? 0) - (b.maxRam ?? 0)
    || (a.hostname < b.hostname ? -1 : 1));

  const attempt = (
    pool: readonly HoldHost[],
    purpose: InducePurpose,
    reasonFor: (host: HoldHost, calls: number) => string,
  ): InducePlan["push"] | undefined => {
    for (const host of pool) {
      // Somebody adjacent has to do the pushing, and it cannot be the host
      // itself.
      const pusher = live.find((other) =>
        other.hostname !== host.hostname
        && other.agentAlive
        && (other.neighbours?.includes(host.hostname) ?? false));
      if (!pusher) {
        refuse(refused, host, "no-pusher", "induceServerMigration cannot target its own host, and no neighbour of ours is standing next to it");
        continue;
      }
      // Threads come from the PUSHER: the charge is linear in the calling
      // script's threads and the 6 s wait is constant, so every thread the
      // pusher's RAM affords divides the project's call count directly. No
      // ceiling — the per-thread price reserves base and spawn, and RAM is the
      // only bound.
      const threads = view.induceGbPerThread !== undefined && view.induceGbPerThread > 0
        ? Math.max(1, Math.floor((pusher.freeGb ?? 0) / view.induceGbPerThread))
        : 1;
      const calls = migrationCalls(host.difficulty!, view.charisma, threads);
      return {
        host: host.hostname,
        from: pusher.hostname,
        threads,
        expectedCalls: calls,
        reason: reasonFor(host, calls) + (threads !== 1 ? ` on ${threads} threads` : ""),
        purpose,
      };
    }
    return undefined;
  };

  let push: InducePlan["push"] | undefined;
  // Eviction only while a candidate is actually waiting for the seat: an empty
  // lab pool makes a freed slot a slot freed for nobody.
  if (bottomFull && labPool.length > 0) {
    push = attempt(evictPool, "free-slot", (host, calls) =>
      `bottom row full (${bottomCount}/${NET_WIDTH}): re-roll the ${(host.maxRam ?? 0)}GB stranger`
      + ` off row ${bottom} to free a seat for a lab candidate — ~${calls} calls`);
  }
  push ??= attempt(labPool, "lab", (host, calls) =>
    `${(host.maxRam ?? 0)}GB at difficulty ${host.difficulty}, band reaches row ${bottom}`
    + ` — ~${calls} calls`);
  push ??= attempt(seatPool, "seat", (host, calls) =>
    `${(host.maxRam ?? 0)}GB at depth ${host.depth ?? "unplaced"}, band covers the open`
    + ` stasis target at row ${seatTargetFor.get(host.hostname)} — ~${calls} calls a roll`);
  push ??= attempt(frontierPool, "frontier", (host, calls) =>
    `${(host.maxRam ?? 0)}GB at depth ${host.depth}, expected landing ${host.difficulty! + 1}`
    + ` — deeper on average; ~${calls} calls`);

  // An evictee left standing is a bottom-row host like any other.
  for (const host of evictPool) {
    if (push?.host === host.hostname) continue;
    refuse(refused, host, "already-there", "already on the bottom row, so already connected to the labyrinth");
  }
  return { ...(push !== undefined ? { push } : {}), refused };
}

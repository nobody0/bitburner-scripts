import { STORM_PHISH_OVERLAP_MS, STORM_QUIET_MS } from "./rates.ts";

/** When to fire the storm — the endgame cache farm, and the one decision in the
 * feature that destroys most of what we know on purpose.
 *
 * `unleashStormSeed` fires `STORM_SEED.exe` from the host holding it and
 * discharges the whole mutation clock in one ~30-second burst: ~60% of movable
 * servers deleted, the survivors moved and restarted, forty fresh ones added.
 * Every fresh server is a new first-authentication cache roll AND a new blocked
 * block whose clearing mints a guaranteed `.cache` — which is why a reroll beats
 * phishing's one `.d.cache` per three net-wide minutes. Only stationary hosts
 * (darkweb, the labyrinth) and stasis-linked hosts survive, keeping their
 * files, sessions, residents and running scripts.
 *
 * The seed itself is not ours to schedule: it is a `memoryReallocation` reward
 * (a 15% roll per block cleared to zero, only while no seed exists among the
 * movable servers, only 30+ minutes after the last storm), it lands in the
 * cleared server's program list, and `scp` cannot move it — the fire job must
 * run on the holding host. What IS ours to schedule is WHEN, and that is this
 * module: pure, deterministic, refusing by name like `farm.ts` and `hold.ts`.
 *
 * ## The gates, and what each one protects
 *
 * A storm is only worth firing into a net we are DONE with and ready to
 * reconquer fast. The gates encode that in order of certainty:
 *
 * 1. `storm-in-flight` — our own quiet window. The engine consumes the seed and
 *    stamps its clock BEFORE checking the mutation lock, so a second fire
 *    during a burst burns the seed for nothing.
 * 2. `no-seed` — a fresh sighting of `STORM_SEED.exe` on a live host.
 * 3. `seed-unreachable` — the holder needs a live resident; the call takes no
 *    target and the file cannot be moved. `planSpread` plants one in time.
 * 4. `links-unspent` — every stasis slot deployed and no pin still pending.
 *    The links are the half of the net that survives: the new net is conquered
 *    from the top (darkweb) and from the pinned giants at the bottom at once.
 *    What makes a link's target "valuable" is `planStasis`'s own standard
 *    (irreplaceable walker first, then the biggest hosts on the depth-weighted
 *    coverage targets — `stasisTargetDepths`) — this module does not re-argue
 *    it, it waits for it to be met.
 * 5. `walker-unpinned` — a finisher walk in flight on an unpinned host is hours
 *    of PID-keyed progress one restart away from zero. Once its host is linked
 *    the storm cannot touch it — a storm mid-walk is safe, and the walk's own
 *    cache needs no gate here either: the lab is stationary, its cache survives
 *    any storm, and the `cache-lab-deferred` rule in `farm.ts` already holds it
 *    until home says the last augmentation purchase is made.
 * 6. `phish-window-open` — fire only just after a `.d.cache` landed, so the
 *    storm's downtime sits inside the three dead minutes of the net-wide
 *    phishing cooldown and displaces no cache we could have rolled for.
 *
 * There is deliberately NO lab gate. A lab-less world (program-only access
 * never generates a labyrinth) has no walk to protect, so gate 5 never binds
 * there and links-spent is the whole preparation — `stasisTargetDepths` hands
 * the bottom-row anchor to the spares there, so the links are spendable.
 *
 * All gates green admits exactly one task: fire from the holder, on the holder. */

/** One host as the trigger policy needs to see it — projected from the same
 * fold the other planners read, fresh facts only. */
export interface StormHost {
  hostname: string;
  /** A believable sighting of `STORM_SEED.exe` in this host's program list.
   *  Explicit `false` is a look that found nothing; absent is not-looked or
   *  stale, and neither admits. */
  stormSeed?: boolean;
  /** A resident stands here — the fire job can only run on the holder. */
  agentAlive: boolean;
  isStationary?: boolean;
  hasCredential?: boolean;
  blockedRam?: number;
  caches?: readonly string[];
  harvestBusy?: boolean;
  stasisLinked?: boolean;
  gone?: boolean;
}

export interface StormView {
  hosts: readonly StormHost[];
  now: number;
  /** `getStasisLinkLimit()` — 1 to 4, raised only by labyrinth augmentations. */
  stasisLimit: number;
  /** Links actually applied, from the newest complete stasis snapshot. */
  stasisLinked: number;
  /** A pin task filed or in flight this pass: a slot is being spent RIGHT NOW,
   *  and firing under it would waste the 12 GB + wait already committed. */
  pinsPending: boolean;
  /** The lab walker is active. */
  walkInFlight: boolean;
  /** The finisher's host is in the linked set. Meaningless unless
   *  `walkInFlight`. */
  walkerPinned: boolean;
  /** The vault holds the labyrinth's password — the walk is over and the
   *  walker-protection gate retires itself. */
  labWalked: boolean;
  /** When a `.d.cache` was last seen to land, same evidence `farm.ts` uses. */
  lastPhishCacheAt?: number;
  /** Our own stamp of the last fire, taken pessimistically at claim time. */
  lastStormFiredAt?: number;
}

export type StormRefusalReason =
  | "storm-in-flight"
  | "no-seed"
  | "seed-unreachable"
  | "harvest-incomplete"
  | "links-unspent"
  | "walker-unpinned"
  | "phish-window-open";

export interface StormRefusal {
  hostname: string;
  why: StormRefusalReason;
  detail: string;
}

export interface StormPlan {
  /** The one admitted fire, when every gate is green. `from` is always the
   *  holder itself — the call takes no target. */
  fire?: { host: string; from: string; reason: string };
  refused: StormRefusal[];
}

/** The net-wide gates refuse against this pseudo-host, so the panel has one row
 * to hang them on even when no seed has ever been sighted. */
const NET = "(net)";

export function planStorm(view: StormView): StormPlan {
  const refused: StormRefusal[] = [];
  const refuse = (hostname: string, why: StormRefusalReason, detail: string): void => {
    refused.push({ hostname, why, detail });
  };

  // 1. Never fire into our own storm. The engine consumes the seed and stamps
  // `lastStormTime` before it checks the lock, so this would burn it outright.
  if (view.lastStormFiredAt !== undefined && view.now - view.lastStormFiredAt < STORM_QUIET_MS) {
    const left = STORM_QUIET_MS - (view.now - view.lastStormFiredAt);
    refuse(NET, "storm-in-flight", `our own storm fired ${Math.round((view.now - view.lastStormFiredAt) / 1000)}s ago; quiet for ${Math.round(left / 1000)}s more`);
    return { refused };
  }

  // 2. A seed, freshly seen, on a live host. Upstream mints at most one among
  // the movables, but a pinned host can hold a second — be total: prefer the
  // stasis-linked holder (storm-proof, so the movable one should burn first is
  // the WRONG instinct — the pinned seed is the one we can always still fire),
  // then name order, so the choice never moves under the panel.
  const holders = view.hosts
    .filter((host) => host.gone !== true && host.stormSeed === true)
    .sort((a, b) => {
      const aPinned = a.stasisLinked === true ? 0 : 1;
      const bPinned = b.stasisLinked === true ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      return a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0;
    });
  if (holders.length === 0) {
    refuse(NET, "no-seed", "no fresh STORM_SEED.exe sighting on any live host");
    return { refused };
  }
  const holder = holders[0]!;

  // 3. The fire job runs ON the holder; the file cannot be scp'd off it.
  if (!holder.agentAlive) {
    refuse(holder.hostname, "seed-unreachable", "the seed's host has no resident, and the seed cannot be moved; waiting for a plant");
    return { refused };
  }

  const incomplete = view.hosts.find((host) => host.gone !== true && host.isStationary !== true && (
    host.hasCredential !== true
    || host.blockedRam === undefined
    || host.blockedRam > 0
    || host.caches === undefined
    || host.caches.length > 0
    || host.harvestBusy === true
  ));
  if (incomplete !== undefined) {
    const detail = incomplete.hasCredential !== true
      ? "first authentication has not been completed"
      : incomplete.blockedRam === undefined
        ? "blocked RAM has not been freshly observed"
        : incomplete.blockedRam > 0
          ? `${incomplete.blockedRam.toFixed(2)}GB blocked RAM remains`
          : incomplete.caches === undefined
            ? "the cache listing has not been freshly observed"
            : incomplete.caches.length > 0
              ? `${incomplete.caches.length} cache file(s) remain unopened`
              : "authentication, reclaim, or cache work is still active";
    refuse(incomplete.hostname, "harvest-incomplete", detail);
    return { refused };
  }

  // 4. Every slot spent, none mid-spend. The links ARE the preparation: what
  // survives is what we reconquer from.
  if (view.stasisLinked < view.stasisLimit || view.pinsPending) {
    refuse(
      holder.hostname,
      "links-unspent",
      view.pinsPending
        ? `a stasis pin is in flight (${view.stasisLinked}/${view.stasisLimit} linked); the storm waits for it to land`
        : `${view.stasisLinked}/${view.stasisLimit} stasis links deployed; the survivors are the reconquest`,
    );
    return { refused };
  }

  // 5. A finisher mid-walk must be pinned before anything reroll-shaped runs.
  // Retired once the lab is walked: there is no finisher left to protect.
  if (!view.labWalked && view.walkInFlight && !view.walkerPinned) {
    refuse(holder.hostname, "walker-unpinned", "a finisher is mid-walk on an unpinned host; a restart costs the whole walk");
    return { refused };
  }

  // 6. Fire into the dead phish window, not across an open one. Never having
  // seen a `.d.cache` reads as open — the conservative side, and it corrects
  // itself within one cache.
  if (view.lastPhishCacheAt === undefined || view.now - view.lastPhishCacheAt > STORM_PHISH_OVERLAP_MS) {
    refuse(
      holder.hostname,
      "phish-window-open",
      view.lastPhishCacheAt === undefined
        ? "no .d.cache ever sighted; waiting to fire just after one lands"
        : `last .d.cache landed ${Math.round((view.now - view.lastPhishCacheAt) / 1000)}s ago; firing only within ${Math.round(STORM_PHISH_OVERLAP_MS / 1000)}s of one`,
    );
    return { refused };
  }

  return {
    fire: {
      host: holder.hostname,
      from: holder.hostname,
      reason: "unleash STORM_SEED.exe: reroll the net inside the dead phish window",
    },
    refused,
  };
}

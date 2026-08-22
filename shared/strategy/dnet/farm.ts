import { compareDepthDesc } from "./knowledge.ts";
import {
  PHISH_CACHE_COOLDOWN_MS,
  phishWaitMs,
  promoteWaitMs,
  ramBlockRemoved,
  rawRamBlockRemoved,
  reclaimWaitMs,
} from "./rates.ts";

/** What a resident does with a host once the host has stopped teaching us
 * anything — the leftovers, and the only part of the darknet that PAYS.
 *
 * Three calls, and none of them needs a credential or a neighbour: `openCache`,
 * `memoryReallocation` and `phishingAttack` all act on the host the script is
 * already standing on. (`memoryReallocation` reaches an adjacent host too, but
 * only a rooted one — and the self case is free, because `isDirectConnected` is
 * true for self and the self early-out at `offlineServerHandling.ts:98-101`
 * returns before the admin-rights check. So a resident grinds its OWN block
 * open, which is the fact the whole ladder rests on.)
 *
 * ## A strict ladder, not a weighting
 *
 * The three payoffs are not commensurable — a cache is a one-shot draw off an
 * ordered reward table, a reclaim is RAM plus a guaranteed cache at the end of a
 * long grind, and a phish is charisma with a money tail — so anything that
 * scored them against each other would be inventing an exchange rate. They are
 * ordered instead, and the order is argued rather than tuned:
 *
 * 1. **`cache`.** One call, and its reward ladder walks the program list up to
 *    `Formulas.exe` ($5b on the dark web) before it falls through to money. It
 *    lands on **home**, permanently, so it is the only thing here that survives
 *    the host — and it DIES WITH THE HOST if we leave it, because a delete takes
 *    the files with it. Everything else can wait; this cannot.
 * 2. **`reclaim`**, while there is a block and the grind is worth its wall
 *    clock. RAM is the binding constraint on every other job out there.
 * 3. **`phish`** with what is left. Charisma is the feature's master resource
 *    (it gates `heartbleed` outright and taxes every `authenticate`), and every
 *    call pays it — a quarter rate even on the failure path.
 *
 * 4. **`promote`**, and only on a symbol home has named. It pays nothing on its
 *    own — propaganda raises VOLATILITY, not forecast, so it is symmetric —
 *    and its charges decay 0.4x per 75-tick market cycle, which makes it a
 *    maintenance RATE rather than a purchase. It is the bottom rung because it
 *    is the only one whose value is decided somewhere else entirely: without a
 *    symbol from `shared/strategy/stock/` it is refused by name, which will be
 *    the usual answer. What it is good for is the host that cannot afford a
 *    phish — 6.15 GB against 6.35 — or whose phish is already running.
 *
 * ## Named refusals, and they are PUBLISHED
 *
 * Same contract as `spread.ts`, for the reason `spread.ts` proved by omission:
 * its refusals were computed and thrown away for months, so a planner that had
 * run out of work looked exactly like one that had stopped working. Every rung
 * this ladder declines produces a refusal by name, including the rungs a host
 * fell THROUGH on its way to the rung it was admitted on — "phishing, because
 * there is no cache to open and no block to grind" is the whole answer, and half
 * of it is the two refusals. */

/** The three farm calls. `TaskKind` in `queue.ts` carries the same three names,
 * because a farm task is a task like any other once it has been decided. */
export type FarmKind = "cache" | "reclaim" | "phish" | "promote";

export const FARM_KINDS: readonly FarmKind[] = ["cache", "reclaim", "phish", "promote"];

/** Every reason a rung can decline, and every one of them is a fact about the
 * host in front of us or about a call's own gate. Prefixed by rung, because the
 * panel shows them in one table and `no-room` means three different things. */
export type FarmRefusalReason =
  | "gone"
  | "cache-none"
  | "cache-lab-deferred"
  | "cache-in-flight"
  | "cache-no-room"
  | "reclaim-no-block"
  | "reclaim-grind-stalled"
  | "reclaim-not-needed"
  | "reclaim-in-flight"
  | "reclaim-no-room"
  | "phish-in-flight"
  | "phish-no-room"
  | "promote-no-symbol"
  | "promote-in-flight"
  | "promote-no-room";

export interface FarmRefusal {
  host: string;
  why: FarmRefusalReason;
  detail: string;
}

/** One host with a live resident, as the ladder needs to see it. */
export interface FarmHost {
  host: string;
  /** Believable depth. Absent is not zero: it is what makes a phish's money
   *  term unknown, and the ordering below sorts an unplaced host last. */
  depth?: number;
  /** Believable difficulty, which is what scales the reclaim grind. Absent
   *  means we cannot price the grind, and an unpriced grind is refused. */
  difficulty?: number;
  blockedRam?: number;
  /** What a JOB would get here: the resident's measured free RAM plus the
   *  allocation the resident hands back when it spawns. */
  freeGb: number;
  /** `.cache` files `ls` reported, believable. */
  caches?: readonly string[];
  /** The labyrinth's own host. Its cache is the deferred one. */
  isLab?: boolean;
  goneAt?: number;
  /** Farm work a live process is already doing to this host. */
  busy?: ReadonlySet<FarmKind>;
}

export interface FarmInputs {
  now: number;
  charisma: number;
  /** What ONE THREAD of each kind costs. `ramOverride` is per thread, so a
   *  two-thread phish needs twice this — which is why the ceiling below is
   *  usually RAM and not policy. */
  gbPerThread: Readonly<Record<FarmKind, number>>;
  /** RAM we want a host to end up holding — the heaviest job we would like to
   *  be able to file there. It is what turns "this host is cramped" into a
   *  reason to grind rather than a preference. */
  wantedGb: number;
  /** When a `.d.cache` was last seen to land, from anywhere. The cooldown is
   *  net-wide engine state we cannot read, so this is our own best evidence;
   *  absent means "assume the window is open", which costs a failed roll and
   *  never costs a call — the call happens either way. */
  lastPhishCacheAt?: number;
  /** Home's permission to open the labyrinth cache. False, or absent, means the
   *  lab's cache is left where it is — see the deferral note below. */
  openLabCache?: boolean;
  /** Ceiling on phishing threads however much RAM is free. */
  maxPhishThreads?: number;
  /** The same for propaganda. */
  maxPromoteThreads?: number;
  /** Symbols home says are worth promoting, best first.
   *
   *  Propaganda is the one farm call whose value cannot be seen from the
   *  darknet at all: it moves a stock's volatility, and only home holds the
   *  market. An empty list — the usual case — is not a missing input, it is the
   *  answer, and the ladder refuses by name on it. */
  promoteSymbols?: readonly string[];
  /** The same ceiling for the grind. Separate from the phishing one because the
   *  two are limited by different things: a phish is capped by a cache window
   *  there is only one of, while a grind is capped only by not wanting one host
   *  to sit in a forty-second batch on every gigabyte it owns. */
  maxReclaimThreads?: number;
}

export interface FarmTask {
  kind: FarmKind;
  /** The host, which is also the vantage: all three calls are self-host. */
  host: string;
  threads: number;
  /** The `.cache` file to open, for a `cache` task and nothing else. */
  filename?: string;
  /** The symbol to promote, for a `promote` task and nothing else. A job never
   *  invents one: nothing on the darknet can see the market. */
  symbol?: string;
  /** One line, for the panel and the failure line. */
  reason: string;
}

export interface FarmPlan {
  tasks: FarmTask[];
  refused: FarmRefusal[];
  /** The resident elected to carry the phishing cache window, when there is
   *  one. Published so the panel can say WHICH host is the hunter rather than
   *  leaving the thread counts to be reverse-engineered. */
  cacheHunter?: string;
}

/** Below this a `memoryReallocation` call frees literally nothing.
 *
 * Not a taste threshold — `getRamBlockRemoved` passes through `roundToTwo`, so
 * any per-call figure under 0.005 GB rounds to exactly 0 and the grind is an
 * infinite loop that pays only charisma. At difficulty 20 that is charisma ~64;
 * below it the host has to wait for the career to catch up. */
export const RECLAIM_MIN_PER_CALL_GB = 0.005;

/** How long we will spend clearing a block outright for the free `.cache` at
 * the end of it, when we do not otherwise need the RAM. Ten minutes is about
 * ninety calls at default charisma, and the host's own expected lifetime is a
 * few times that. */
export const RECLAIM_CLEAR_BUDGET_MS = 10 * 60 * 1000;

const DEFAULT_MAX_PHISH_THREADS = 4;

/** Ceiling on propaganda threads. Charges are linear in threads and the wait is
 * not, so this is the same shape as the grind — but low, because the charge
 * curve saturates and the decay is what actually has to be outrun. */
const DEFAULT_MAX_PROMOTE_THREADS = 4;

/** Ceiling on grind threads.
 *
 * `getRamBlockRemoved` is LINEAR in threads and the wait is not, so threads are
 * the only lever this rung has: at one thread a call frees a hundredth of a
 * gigabyte for six seconds of wall clock and the grind is hopeless on anything
 * but the shallowest host. Eight is where the RAM runs out first on every host
 * a resident actually stands on — a `reclaim` job is over 5 GB a thread, so
 * eight of them is 43 GB — which is the honest way to say "this is not the
 * binding constraint, RAM is". */
const DEFAULT_MAX_RECLAIM_THREADS = 8;

/** Whether the net-wide phishing cache window is believed open.
 *
 * The engine keeps `lastPhishingCacheTime` on `DarknetState` and exposes it
 * nowhere, so this is inference from our own sightings: a `.d.cache` we saw land
 * closed the window, and three minutes later it is open again. Never having seen
 * one reads as OPEN, which is the direction that costs nothing — the call is
 * made either way and a closed window merely falls through to the money roll. */
export function phishWindowOpen(inputs: Pick<FarmInputs, "now" | "lastPhishCacheAt">): boolean {
  if (inputs.lastPhishCacheAt === undefined) return true;
  return inputs.now - inputs.lastPhishCacheAt > PHISH_CACHE_COOLDOWN_MS;
}

/** Which resident carries the window.
 *
 * There is exactly ONE cache every three minutes for the whole net, and the roll
 * that claims it scales with threads — so spreading threads evenly across every
 * phisher buys nothing at all, while concentrating them on one host buys the
 * whole window. The deepest resident is elected because depth is also the money
 * term (`0.1 + depth * 0.05`), so the same host is the best one to be spending
 * threads on when the window is shut. Ties by free RAM, then by name, so the
 * election is deterministic and does not move under the panel.
 *
 * `eligible` is how a caller says which hosts can actually SPEND the window.
 * Without it the ladder elected the deepest resident whatever its state, and
 * threads are handed to the hunter and to nobody else — so electing a host that
 * cannot afford a `phishingAttack` left the entire net rolling at one thread for
 * the whole three-minute window the election exists to win. */
export function electCacheHunter(
  hosts: readonly FarmHost[],
  eligible?: (host: FarmHost) => boolean,
): string | undefined {
  const pool = hosts.filter((host) =>
    host.goneAt === undefined && host.isLab !== true && (eligible?.(host) ?? true));
  if (pool.length === 0) return undefined;
  const best = [...pool].sort((a, b) => {
    const byDepth = compareDepthDesc(a.depth, b.depth);
    if (byDepth !== 0) return byDepth;
    if (a.freeGb !== b.freeGb) return b.freeGb - a.freeGb;
    return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
  })[0]!;
  return best.host;
}

/** What one `memoryReallocation` frees here, and how long the whole block would
 * take. Exported because the refusal detail quotes both, and a refusal that
 * cannot show its arithmetic is a refusal nobody can argue with. */
export function reclaimForecast(
  host: Pick<FarmHost, "difficulty" | "blockedRam">,
  charisma: number,
  threads = 1,
): { perCallGb: number; rawPerCallGb: number; waitMs: number; clearMs: number } | undefined {
  if (host.difficulty === undefined || host.blockedRam === undefined) return undefined;
  const perCallGb = ramBlockRemoved(host.difficulty, host.blockedRam, threads, charisma);
  // The UNROUNDED figure, because `perCallGb` has already been through
  // `roundToTwo` and so is only ever 0 or at least 0.01. The stall test below
  // asks how far short a call falls, and the rounded number cannot say.
  const rawPerCallGb = rawRamBlockRemoved(host.difficulty, threads, charisma);
  const waitMs = reclaimWaitMs(charisma);
  const clearMs = perCallGb <= 0 ? Infinity : (host.blockedRam / perCallGb) * waitMs;
  return { perCallGb, rawPerCallGb, waitMs, clearMs };
}

/** The ladder, once per host with a resident.
 *
 * Deterministic: hosts are walked deepest-first, matching `planSpread`, so two
 * derivations of the same knowledge produce the same plan. */
export function planFarm(hosts: readonly FarmHost[], inputs: FarmInputs): FarmPlan {
  const tasks: FarmTask[] = [];
  const refused: FarmRefusal[] = [];
  // Only among hosts that could actually spend the window: a hunter with no room
  // for a `phishingAttack` is a window nobody rolls for.
  const hunter = electCacheHunter(hosts, (host) => host.freeGb >= inputs.gbPerThread.phish);
  const windowOpen = phishWindowOpen(inputs);
  const maxPhishThreads = inputs.maxPhishThreads ?? DEFAULT_MAX_PHISH_THREADS;
  /** How many hosts have been given propaganda this pass, which is what spreads
   *  them across the named symbols. */
  let promoted = 0;

  const ordered = [...hosts].sort((a, b) => {
    const byDepth = compareDepthDesc(a.depth, b.depth);
    if (byDepth !== 0) return byDepth;
    return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
  });

  for (const host of ordered) {
    const refuse = (why: FarmRefusalReason, detail: string): void => {
      refused.push({ host: host.host, why, detail });
    };
    const busy = host.busy ?? new Set<FarmKind>();

    if (host.goneAt !== undefined) {
      refuse("gone", "the host is offline; darknet hosts go permanently");
      continue;
    }

    // --- 1. cache ---------------------------------------------------------
    //
    // First, always, and the argument is not that it pays most: it is that it is
    // the only rung whose payoff can be LOST. A cache file lives on the host,
    // and a delete takes the host's files with it.
    const caches = [...(host.caches ?? [])].sort();
    let admitted = false;
    if (caches.length === 0) {
      refuse("cache-none", "no .cache file here; ls reported none");
    } else if (host.isLab === true && inputs.openLabCache !== true) {
      // THE DEFERRAL. A labyrinth cache calls `getLabReward`, which queues an
      // augmentation directly — and the generic price multiplier is
      // `1.9 ^ (queued non-SoA augmentations)`, applied to every augmentation
      // bought after it. Opening one mid-shopping-trip multiplies the rest of
      // the cycle's bill by 1.9x AND invalidates the drain order the factions
      // planner froze, because the price context moved under it. So it waits for
      // home to say the last purchase has been made. The lab is `isStationary`,
      // so unlike every other cache this one cannot be lost by waiting.
      refuse("cache-lab-deferred", "a labyrinth cache queues an augmentation; held until the last purchase is made");
    } else if (busy.has("cache")) {
      refuse("cache-in-flight", "a job is already opening a cache here");
    } else if (host.freeGb < inputs.gbPerThread.cache) {
      refuse("cache-no-room", `${host.freeGb.toFixed(2)}GB free, an openCache job needs ${inputs.gbPerThread.cache.toFixed(2)}GB`);
    } else {
      tasks.push({
        kind: "cache",
        host: host.host,
        threads: 1,
        filename: caches[0]!,
        reason: `open ${caches[0]!}${caches.length > 1 ? ` (+${caches.length - 1} more)` : ""}`,
      });
      admitted = true;
    }
    if (admitted) continue;

    // --- 2. reclaim -------------------------------------------------------
    //
    // THE THREAD COUNT COMES FIRST, and it is not a detail of the task: it is a
    // term in both of the refusals below. `getRamBlockRemoved` is linear in
    // threads while the wait is not, so a grind that is hopeless at one thread
    // can be routine at eight — and pricing the rung at one thread and then
    // running it at eight would refuse work that was affordable all along.
    // Everything that does not depend on the count is asked first, so the
    // affordability question is answered before it is spent.
    const blocked = host.blockedRam ?? 0;
    const grindable = Math.floor(host.freeGb / inputs.gbPerThread.reclaim);
    const reclaimThreads = Math.max(
      1,
      Math.min(grindable, inputs.maxReclaimThreads ?? DEFAULT_MAX_RECLAIM_THREADS),
    );
    const forecast = reclaimForecast(host, inputs.charisma, reclaimThreads);
    if (blocked <= 0) {
      refuse("reclaim-no-block", "no owner-blocked RAM left to liberate");
    } else if (forecast === undefined) {
      refuse("reclaim-grind-stalled", "difficulty unknown, so the grind cannot be priced; survey it first");
    } else if (busy.has("reclaim")) {
      refuse("reclaim-in-flight", "a job is already grinding this block");
    } else if (grindable < 1) {
      refuse(
        "reclaim-no-room",
        `${host.freeGb.toFixed(2)}GB free, a memoryReallocation job needs ${inputs.gbPerThread.reclaim.toFixed(2)}GB`
        + " — the block is holding its own cure hostage",
      );
    } else if (forecast.rawPerCallGb < RECLAIM_MIN_PER_CALL_GB) {
      // roundToTwo takes anything under 0.005 to exactly zero, so this is not a
      // slow grind — it is a loop that frees nothing and only pays charisma.
      // Quoted from the RAW figure: `perCallGb` is already rounded, so it would
      // print 0.000 here every time and say nothing about how short we are. And
      // quoted at the threads we could actually afford, because that is the
      // figure the call would have.
      refuse(
        "reclaim-grind-stalled",
        `one call at ${reclaimThreads} thread${reclaimThreads === 1 ? "" : "s"} would free `
        + `${forecast.rawPerCallGb.toFixed(4)}GB, which rounds to zero; charisma has to catch up first`,
      );
    } else if (host.freeGb >= inputs.wantedGb && forecast.clearMs > RECLAIM_CLEAR_BUDGET_MS) {
      // Two ways a grind earns its wall clock, and this is the refusal when
      // neither holds: the host already has room for the heaviest job we would
      // file here, AND clearing the block outright — which is what mints the
      // free `.cache` — is further away than we are willing to spend, even at
      // every thread the host can hold.
      refuse(
        "reclaim-not-needed",
        `${host.freeGb.toFixed(2)}GB free already, and clearing ${blocked.toFixed(2)}GB would take `
        + `${Math.round(forecast.clearMs / 60_000)} minutes at ${forecast.perCallGb.toFixed(2)}GB a call`
        + ` on ${reclaimThreads} thread${reclaimThreads === 1 ? "" : "s"}`,
      );
    } else {
      tasks.push({
        kind: "reclaim",
        host: host.host,
        threads: reclaimThreads,
        reason: host.freeGb < inputs.wantedGb
          ? `${forecast.perCallGb.toFixed(2)}GB a call on ${reclaimThreads} thread${reclaimThreads === 1 ? "" : "s"}`
            + ` against ${blocked.toFixed(2)}GB blocked; the host is cramped`
          : `${blocked.toFixed(2)}GB blocked clears in ~${Math.round(forecast.clearMs / 60_000)} min`
            + ` on ${reclaimThreads} thread${reclaimThreads === 1 ? "" : "s"}, and a cleared block drops a .cache`,
      });
      admitted = true;
    }
    if (admitted) continue;

    // --- 3. phish ---------------------------------------------------------
    if (busy.has("phish")) {
      refuse("phish-in-flight", "a job is already phishing here");
    } else if (host.freeGb < inputs.gbPerThread.phish) {
      refuse(
        "phish-no-room",
        `${host.freeGb.toFixed(2)}GB free, a phishingAttack job needs ${inputs.gbPerThread.phish.toFixed(2)}GB`,
      );
    } else {
      // Threads are the only lever on the cache roll, and RAM is charged per
      // thread. So they are spent on the elected hunter and on nobody else: the
      // window is one cache for the whole net, and two hosts rolling at one
      // thread each is strictly worse than one host rolling at two.
      const isHunter = host.host === hunter;
      const affordable = Math.max(1, Math.floor(host.freeGb / inputs.gbPerThread.phish));
      const threads = isHunter && windowOpen ? Math.min(affordable, maxPhishThreads) : 1;
      tasks.push({
        kind: "phish",
        host: host.host,
        threads,
        reason: isHunter
          ? (windowOpen
            ? `cache hunter, window open: ${threads} thread${threads === 1 ? "" : "s"} on the roll`
            : "cache hunter, window shut: charisma and money until it reopens")
          : "charisma every call, money by depth",
      });
      admitted = true;
    }
    if (admitted) continue;

    // --- 4. promote -------------------------------------------------------
    //
    // The bottom rung, and the only one whose worth is decided off the net. A
    // host reaches it when it cannot afford a phish or is already running one,
    // and it is admitted only when home has named a symbol — propaganda on a
    // symbol with no edge moves volatility in both directions for nothing.
    const symbols = inputs.promoteSymbols ?? [];
    if (symbols.length === 0) {
      refuse("promote-no-symbol", "no symbol home names has an edge; propaganda is symmetric and pays nothing alone");
      continue;
    }
    if (busy.has("promote")) {
      refuse("promote-in-flight", "a job is already spreading propaganda here");
      continue;
    }
    if (host.freeGb < inputs.gbPerThread.promote) {
      refuse(
        "promote-no-room",
        `${host.freeGb.toFixed(2)}GB free, a promoteStock job needs ${inputs.gbPerThread.promote.toFixed(2)}GB`,
      );
      continue;
    }
    // Hosts are spread across the named symbols rather than piled onto the
    // first: the charge curve saturates (two exponentials approaching 4x), so
    // the second symbol's first charge is worth more than the first symbol's
    // hundredth. Indexed by the host's ORDER in this pass, which is
    // deterministic, so the assignment does not move under the panel.
    const symbol = symbols[promoted % symbols.length]!;
    promoted++;
    const promoteThreads = Math.max(
      1,
      Math.min(
        Math.floor(host.freeGb / inputs.gbPerThread.promote),
        inputs.maxPromoteThreads ?? DEFAULT_MAX_PROMOTE_THREADS,
      ),
    );
    tasks.push({
      kind: "promote",
      host: host.host,
      threads: promoteThreads,
      symbol,
      reason: `propaganda for ${symbol}: volatility only, and it decays 0.4x a market cycle`,
    });
  }

  return { tasks, refused, ...(hunter !== undefined ? { cacheHunter: hunter } : {}) };
}

/** How long one bounded farm batch should keep calling.
 *
 * Every farm job runs a BATCH rather than one call, because the alternative is
 * paying the 2.0 GB spawn back and a full overseer tick for a 6-second wait.
 * It is bounded rather than long-lived so that `longLived` — and the beat that
 * goes with it — ends up with exactly one user, the maze walker, and so that a
 * host is never held away from a plant or an attempt for longer than an attempt
 * job would hold it anyway. */
export const FARM_BATCH_MS = 40_000;

/** Whether another call fits inside the batch. Checked BEFORE the call rather
 * than after, because the wait is known in advance and a job that starts a
 * ten-second phish with two seconds left has overrun by design. */
export function batchHasRoom(kind: FarmKind, startedAt: number, now: number, charisma: number): boolean {
  const waitMs = kind === "phish"
    ? phishWaitMs(charisma)
    : kind === "promote"
      ? promoteWaitMs(charisma)
      : reclaimWaitMs(charisma);
  return now + waitMs <= startedAt + FARM_BATCH_MS;
}

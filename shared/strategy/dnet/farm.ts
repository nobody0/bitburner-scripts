import { compareDepthDesc } from "./host.ts";
import type { FarmKind } from "./jobs.ts";
import {
  PHISH_CACHE_COOLDOWN_MS,
  phishExpectedRates,
  promoteExpectedCharismaExpPerSec,
  promoteWaitMs,
  ramBlockRemoved,
  rawRamBlockRemoved,
  reclaimWaitMs,
} from "./rates.ts";

/** Resident farm policy.
 *
 * Cache and reclaim stay above the earn comparison because they preserve
 * losable files and unlock RAM. Phish/promote share the bottom rung and are
 * compared through the arbiter's cash/XP prices; promotion's stock value is a
 * proxy, never reported income.
 *
 * During an open global cache window one difficulty >3 resident is pinned to
 * phishing. Low-difficulty hosts prefer promotion but may fall back to phish;
 * the quality preference must never create idle RAM. */

export type { FarmKind };


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
  /** Believable adjacency, for the remote-reclaim election: a helper must be
   *  DIRECTLY connected to the host whose block it grinds. Absent means we
   *  cannot prove the edge, so this host helps nobody. */
  neighbours?: readonly string[];
  /** We hold this host's password. Cross-host `memoryReallocation` passes the
   *  admin-rights check only on an authenticated target — the self case dodges
   *  it — so a host without a credential can only ever grind itself. */
  hasCredential?: boolean;
}

export interface FarmEconomics {
  bestMoneyPerSec?: number;
  bestCharismaExpPerSec?: number;
  moneyWorthSec?: number;
  charismaWorthSec?: number;
  charismaExpMult?: number;
  crimeMoneyMult?: number;
  dnetMoneyMult?: number;
  nodeMoneyMult?: number;
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
  /** Symbols home says are worth promoting, best first, each carrying home's
   *  expected profit for the position — the promote side of the earn
   *  comparison's exchange rate.
   *
   *  Propaganda is the one farm call whose value cannot be seen from the
   *  darknet at all: it moves a stock's volatility, and only home holds the
   *  market. An empty list — the usual case — is not a missing input, it is the
   *  answer, and the ladder refuses by name on it. */
  promoteSymbols?: readonly PromoteSymbol[];
  /** The player's crime success multiplier, a term in both phishing chances.
   *  Absent means 1. */
  crimeSuccessMult?: number;
  /** Arbiter prices and player multipliers supplied by home. Rates are per
   * second; worth is BN-seconds for a full relative-rate contribution. */
  economics?: FarmEconomics;
  /** The same ceiling for the grind. Separate from the phishing one because the
   *  two are limited by different things: a phish is capped by a cache window
   *  there is only one of, while a grind is capped only by not wanting one host
   *  to sit in a forty-second batch on every gigabyte it owns. */
  maxReclaimThreads?: number;
  /** The controller wants a `STORM_SEED.exe` and none exists: every block cleared
   *  to zero is a 15% seed roll, so the `reclaim-not-needed` budget stands down
   *  and blocks keep getting ground outright however long they take. Set only
   *  while the storm's other gates are already met and the engine could
   *  actually mint one (30+ minutes since the last storm) — otherwise the lift
   *  buys rolls that cannot pay. */
  seedHunt?: boolean;
  /** ONE host whose block is ground by EVERY able grinder at once — self plus
   *  each adjacent credentialed neighbour with room, one task per vantage.
   *  `getRamBlockRemoved` is linear in threads and the charge is per call, so
   *  N grinders clear it ~N× faster; the same per-vantage treatment `induce`
   *  has always had. Meant for the lab candidate, whose block is the last gate
   *  before the walker starts — the budget refusal does not apply to it. */
  walkerCandidate?: string;
}

export interface FarmTask {
  kind: FarmKind;
  /** The target. Also the vantage, for everything but a remote reclaim. */
  host: string;
  /** The vantage, when it is not the target: the neighbour elected to grind a
   *  cramped host's block remotely. Absent means self-host. */
  from?: string;
  /** A gang grinder: one of SEVERAL concurrent reclaims on the same target.
   *  The queue must dedup these per (target, vantage), not per target. */
  gang?: true;
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
  /** Forward rates from the admitted earn tasks. Promotion's stock proxy is
   * deliberately excluded from cash; it is utility, not player income. */
  expectedMoneyPerSec: number;
  expectedCharismaExpPerSec: number;
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

/** One symbol home names as worth promoting, with the expected profit of the
 * position it protects — the only number that can price a promote at all. */
export interface PromoteSymbol {
  symbol: string;
  expectedProfit: number;
}

/** How much of a symbol's `expectedProfit` one promote batch is credited with,
 * in the earn comparison. THE ONE INVENTED NUMBER IN THIS FILE: no engine
 * formula relates propaganda to realised profit — promote moves volatility,
 * not forecast, the trader earns `expectedProfit` with or without help, and a
 * batch's charge decays 0.4x a market cycle — so this is a judgment call, kept
 * deliberately small and in one place. At 1e-6 the break-even against a
 * shallow host's phish sits near a ~$13m position and near ~$70m against the
 * deepest, so promote wins only behind an edge big enough that amplifying its
 * volatility plausibly beats pocket change. Calibrate against `sim/` rather
 * than by argument. */
export const PROMOTE_PROFIT_SHARE = 1e-6;

/** Phish's thumb on the earn scale: every call pays charisma exp (a quarter
 * rate even on failure), and charisma gates `heartbleed` and taxes every
 * `authenticate` — value the $/ms figure cannot see. */
export const FARM_NOMINAL_CHANNEL_WORTH_SEC = 300;

/** No default thread ceiling on any farm call. A resident runs one job at a
 * time, so RAM the job does not take is idle; money, charisma and block-clear
 * are all linear in threads; and the batch is TIME-bounded so threads never
 * extend how long a host is held. The per-thread price already reserves the
 * script base and the `spawn` the atExit respawn needs, and the engine charges
 * per thread, so `floor(freeGb / gbPerThread)` fills the host exactly. Callers
 * may still pass an explicit ceiling (`maxPhishThreads` &c.) to constrain a
 * particular run, but the default is RAM. `Infinity` is the "no cap" value —
 * `Math.min(x, Infinity) === x`. */
const DEFAULT_MAX_PHISH_THREADS = Infinity;
const DEFAULT_MAX_PROMOTE_THREADS = Infinity;
const DEFAULT_MAX_RECLAIM_THREADS = Infinity;

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

/** Which resident is guaranteed to keep rolling for the window.
 *
 * There is exactly ONE cache every three minutes for the whole net. Every
 * phisher now runs at full threads (see the phish rung), so the election no
 * longer rations threads — what it decides is which host keeps PHISHING while
 * the window is open instead of being diverted to a higher-EV promote. One
 * host is pinned to the cache roll; the rest optimise their own earn. The
 * deepest resident is elected because depth is also the money term
 * (`0.1 + depth * 0.05`). Free RAM, then name, break ties so the election is
 * deterministic.
 *
 * `eligible` is how a caller says which hosts can actually SPEND the window: a
 * hunter with no room for a `phishingAttack` is a host pinned to a roll it
 * cannot make, leaving nobody guaranteed to chase the cache.
 */
export function electCacheHunter(
  hosts: readonly FarmHost[],
  eligible?: (host: FarmHost) => boolean,
): string | undefined {
  const pool = hosts.filter((host) =>
    host.goneAt === undefined && host.isLab !== true && (eligible?.(host) ?? true));
  if (pool.length === 0) return undefined;
  const best = [...pool].sort((a, b) => {
    const primary = compareDepthDesc(a.depth, b.depth) || b.freeGb - a.freeGb;
    if (primary !== 0) return primary;
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
  const windowOpen = phishWindowOpen(inputs);
  const maxPhishThreads = inputs.maxPhishThreads ?? DEFAULT_MAX_PHISH_THREADS;
  const eligibleHunters = hosts.filter((host) =>
    host.goneAt === undefined && host.isLab !== true && host.freeGb >= inputs.gbPerThread.phish);
  const preferredHunters = eligibleHunters.filter((host) => (host.difficulty ?? -Infinity) > 3);
  const hunterPool = preferredHunters.length > 0 ? preferredHunters : eligibleHunters;
  const hunter = electCacheHunter(hunterPool);
  const avoidingLowDifficulty = windowOpen && preferredHunters.length > 0;
  const economics = inputs.economics ?? {};
  const moneyWorthSec = economics.moneyWorthSec ?? FARM_NOMINAL_CHANNEL_WORTH_SEC;
  const charismaWorthSec = economics.charismaWorthSec ?? FARM_NOMINAL_CHANNEL_WORTH_SEC;
  const symbols = inputs.promoteSymbols ?? [];

  const candidateRates = (host: FarmHost): {
    phish: { threads: number; moneyPerSec: number; charismaExpPerSec: number };
    promote: { threads: number; moneyPerSec: number; charismaExpPerSec: number };
  } => {
    const phishThreads = Math.min(
      Math.max(0, Math.floor(host.freeGb / inputs.gbPerThread.phish)),
      maxPhishThreads,
    );
    const promoteThreads = Math.min(
      Math.max(0, Math.floor(host.freeGb / inputs.gbPerThread.promote)),
      inputs.maxPromoteThreads ?? DEFAULT_MAX_PROMOTE_THREADS,
    );
    const phish = phishExpectedRates({
      depth: host.depth ?? 0,
      threads: phishThreads,
      charisma: inputs.charisma,
      cacheWindowOpen: windowOpen && host.isLab !== true,
      crimeSuccessMult: inputs.crimeSuccessMult,
      charismaExpMult: economics.charismaExpMult,
      crimeMoneyMult: economics.crimeMoneyMult,
      dnetMoneyMult: economics.dnetMoneyMult,
      nodeMoneyMult: economics.nodeMoneyMult,
    });
    return {
      phish: { threads: phishThreads, moneyPerSec: phish.moneyPerSec, charismaExpPerSec: phish.charismaExpPerSec },
      promote: {
        threads: promoteThreads,
        moneyPerSec: symbols.length > 0
          ? symbols[0]!.expectedProfit * PROMOTE_PROFIT_SHARE / (promoteWaitMs(inputs.charisma) / 1_000)
          : 0,
        charismaExpPerSec: promoteExpectedCharismaExpPerSec(
          promoteThreads,
          inputs.charisma,
          economics.charismaExpMult,
        ),
      },
    };
  };
  const ratesByHost = new Map(hosts.map((host) => [host.host, candidateRates(host)]));
  let maximumFleetMoney = 0;
  let maximumFleetCharisma = 0;
  for (const host of hosts) {
    if (host.goneAt !== undefined || host.isLab === true) continue;
    const rates = ratesByHost.get(host.host)!;
    maximumFleetMoney += Math.max(rates.phish.moneyPerSec, rates.promote.moneyPerSec);
    maximumFleetCharisma += Math.max(rates.phish.charismaExpPerSec, rates.promote.charismaExpPerSec);
  }
  const moneyReference = Math.max(economics.bestMoneyPerSec ?? 0, maximumFleetMoney, 1e-9);
  const charismaReference = Math.max(economics.bestCharismaExpPerSec ?? 0, maximumFleetCharisma, 1e-9);
  const valueOf = (rates: { moneyPerSec: number; charismaExpPerSec: number }): number =>
    moneyWorthSec * rates.moneyPerSec / moneyReference
    + charismaWorthSec * rates.charismaExpPerSec / charismaReference;
  let expectedMoneyPerSec = 0;
  let expectedCharismaExpPerSec = 0;
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
    // can be routine at several — and pricing the rung at one thread and then
    // running it at what fits would refuse work that was affordable all along.
    // Everything that does not depend on the count is asked first, so the
    // affordability question is answered before it is spent.
    const blocked = host.blockedRam ?? 0;
    const grindable = Math.floor(host.freeGb / inputs.gbPerThread.reclaim);
    const maxReclaim = inputs.maxReclaimThreads ?? DEFAULT_MAX_RECLAIM_THREADS;
    const selfThreads = Math.min(grindable, maxReclaim);
    // THE GANG. The named host's block is the last gate before the walker
    // starts, so EVERY able grinder takes it at once — one task per vantage,
    // deduped per vantage by the queue, budget refusal not consulted. The
    // in-flight set still suppresses re-filing per vantage downstream.
    if (host.host === inputs.walkerCandidate && blocked > 0 && host.difficulty !== undefined) {
      const grinders: { from?: string; threads: number }[] = [];
      if (selfThreads >= 1) grinders.push({ threads: selfThreads });
      if (host.hasCredential === true) {
        for (const other of hosts) {
          if (other.host === host.host || other.goneAt !== undefined || other.isLab === true) continue;
          if (!(other.neighbours?.includes(host.host) ?? false)) continue;
          const threads = Math.min(Math.floor(other.freeGb / inputs.gbPerThread.reclaim), maxReclaim);
          if (threads >= 1) grinders.push({ from: other.host, threads });
        }
      }
      // Each grinder's call is priced at ITS OWN threads, and a call whose
      // freed RAM rounds to zero frees nothing while still paying the wait.
      // Without this the gang re-files a full-thread grind from every
      // credentialed neighbour every pass, for ever, against a block that
      // never moves.
      const able = grinders.filter((grinder) =>
        (reclaimForecast(host, inputs.charisma, grinder.threads)?.rawPerCallGb ?? 0) >= RECLAIM_MIN_PER_CALL_GB);
      if (grinders.length === 0) {
        refuse("reclaim-no-room", "the gang target has no able grinder: no room on it and no roomy authenticated neighbour");
      } else if (able.length === 0) {
        const most = Math.max(...grinders.map((grinder) => grinder.threads));
        refuse(
          "reclaim-grind-stalled",
          `one gang call at ${most} thread${most === 1 ? "" : "s"} would free `
          + `${(reclaimForecast(host, inputs.charisma, most)?.rawPerCallGb ?? 0).toFixed(4)}GB, `
          + "which rounds to zero; charisma has to catch up first",
        );
      } else {
        for (const grinder of able) {
          tasks.push({
            kind: "reclaim",
            host: host.host,
            ...(grinder.from !== undefined ? { from: grinder.from } : {}),
            threads: grinder.threads,
            gang: true,
            reason: `gang grind: ${blocked.toFixed(2)}GB blocks the walker`
              + (grinder.from !== undefined ? `, ground from ${grinder.from}` : ""),
          });
        }
      }
      continue;
    }
    // THE HELPER. `memoryReallocation` reaches an authenticated, directly
    // connected neighbour, so a block the host cannot afford to grind itself —
    // or can only grind at fewer threads than a roomy neighbour would — is
    // ground from next door instead. Gated on the vault because the cross-host
    // call is the one that pays the admin-rights check, and on the HELPER's own
    // fresh adjacency because that is the edge the call will actually test.
    // Election is deterministic: most free RAM, ties by name. The lab never
    // helps — its host is reserved for the walk.
    const helper = host.hasCredential === true
      ? [...hosts]
        .filter((other) =>
          other.host !== host.host
          && other.goneAt === undefined
          && other.isLab !== true
          && (other.neighbours?.includes(host.host) ?? false)
          && Math.floor(other.freeGb / inputs.gbPerThread.reclaim) >= 1)
        .sort((a, b) => b.freeGb - a.freeGb || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))[0]
      : undefined;
    const helperThreads = helper === undefined
      ? 0
      : Math.min(Math.floor(helper.freeGb / inputs.gbPerThread.reclaim), maxReclaim);
    // Self wins ties: it is the free case (no admin check) and the old shape.
    const remote = helper !== undefined && helperThreads > selfThreads;
    const reclaimThreads = Math.max(1, remote ? helperThreads : selfThreads);
    const forecast = reclaimForecast(host, inputs.charisma, reclaimThreads);
    if (blocked <= 0) {
      refuse("reclaim-no-block", "no owner-blocked RAM left to liberate");
    } else if (forecast === undefined) {
      refuse("reclaim-grind-stalled", "difficulty unknown, so the grind cannot be priced; survey it first");
    } else if (busy.has("reclaim")) {
      refuse("reclaim-in-flight", "a job is already grinding this block");
    } else if (!remote && grindable < 1) {
      refuse(
        "reclaim-no-room",
        `${host.freeGb.toFixed(2)}GB free, a memoryReallocation job needs ${inputs.gbPerThread.reclaim.toFixed(2)}GB`
        + " — the block is holding its own cure hostage"
        + (host.hasCredential === true
          ? ", and no authenticated neighbour has room to grind it remotely"
          : ", and without its password no neighbour can grind it remotely"),
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
    } else if (
      host.freeGb >= inputs.wantedGb
      && forecast.clearMs > RECLAIM_CLEAR_BUDGET_MS
      && inputs.seedHunt !== true
    ) {
      // Two ways a grind earns its wall clock, and this is the refusal when
      // neither holds: the host already has room for the heaviest job we would
      // file here, AND clearing the block outright — which is what mints the
      // free `.cache` — is further away than we are willing to spend, even at
      // every thread the host can hold. A seed hunt suspends the budget: while
      // the controller wants a `STORM_SEED.exe` and one could be minted, every
      // cleared block is a 15% roll and the grind pays in rolls, not RAM.
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
        ...(remote ? { from: helper!.host } : {}),
        threads: reclaimThreads,
        reason: (remote ? `ground remotely from ${helper!.host}: ` : "")
          + (host.freeGb < inputs.wantedGb
            ? `${forecast.perCallGb.toFixed(2)}GB a call on ${reclaimThreads} thread${reclaimThreads === 1 ? "" : "s"}`
              + ` against ${blocked.toFixed(2)}GB blocked; the host is cramped`
            : `${blocked.toFixed(2)}GB blocked clears in ~${Math.round(forecast.clearMs / 60_000)} min`
              + ` on ${reclaimThreads} thread${reclaimThreads === 1 ? "" : "s"}, and a cleared block drops a .cache`
              + (inputs.seedHunt === true ? " and rolls for a storm seed" : "")),
      });
      admitted = true;
    }
    if (admitted) continue;

    // --- 3./4. earn: phish or promote, whichever pays better ---------------
    //
    // The one place the ladder becomes an exchange rate; the header argues it.
    // Both rungs are tried in arbiter-priced cash-plus-XP order, and the loser
    // still runs
    // when the winner refuses on its own gate — no room and in-flight are
    // reasons to fall through, not to idle. The hunter with an open window
    // bypasses the arithmetic entirely: the net-wide cache roll is worth more
    // than either figure.
    const isHunter = host.host === hunter;
    const rates = ratesByHost.get(host.host)!;
    const phishValue = valueOf(rates.phish);
    const promoteValue = valueOf(rates.promote);

    const tryPhish = (): boolean => {
      if (busy.has("phish")) {
        refuse("phish-in-flight", "a job is already phishing here");
        return false;
      }
      if (host.freeGb < inputs.gbPerThread.phish) {
        refuse(
          "phish-no-room",
          `${host.freeGb.toFixed(2)}GB free, a phishingAttack job needs ${inputs.gbPerThread.phish.toFixed(2)}GB`,
        );
        return false;
      }
      // EVERY phisher runs at what its own RAM affords: money and charisma are
      // linear in threads, the batch is TIME-bounded so threads never extend
      // how long the host is held, and a resident runs one job at a time so
      // the RAM would otherwise sit idle. The hunter election survives as the
      // panel's answer to "who claims the window" — the deepest host is still
      // the one whose calls pay most — but it no longer rations anyone else's
      // threads.
      const threads = rates.phish.threads;
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
      expectedMoneyPerSec += rates.phish.moneyPerSec;
      expectedCharismaExpPerSec += rates.phish.charismaExpPerSec;
      return true;
    };

    const tryPromote = (): boolean => {
      // Admitted only when home has named a symbol — propaganda on a symbol
      // with no edge moves volatility in both directions for nothing.
      if (symbols.length === 0) {
        refuse("promote-no-symbol", "no symbol home names has an edge; propaganda is symmetric and pays nothing alone");
        return false;
      }
      if (busy.has("promote")) {
        refuse("promote-in-flight", "a job is already spreading propaganda here");
        return false;
      }
      if (host.freeGb < inputs.gbPerThread.promote) {
        refuse(
          "promote-no-room",
          `${host.freeGb.toFixed(2)}GB free, a promoteStock job needs ${inputs.gbPerThread.promote.toFixed(2)}GB`,
        );
        return false;
      }
      // Hosts are spread across the named symbols rather than piled onto the
      // first: the charge curve saturates (two exponentials approaching 4x), so
      // the second symbol's first charge is worth more than the first symbol's
      // hundredth. Indexed by the host's ORDER in this pass, which is
      // deterministic, so the assignment does not move under the panel.
      const symbol = symbols[promoted % symbols.length]!.symbol;
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
      expectedCharismaExpPerSec += rates.promote.charismaExpPerSec;
      return true;
    };

    const lowDifficultySoftAvoid = avoidingLowDifficulty && (host.difficulty ?? -Infinity) <= 3;
    const phishFirst = (isHunter && windowOpen)
      || (!lowDifficultySoftAvoid && phishValue >= promoteValue);
    if (phishFirst) {
      if (!tryPhish()) tryPromote();
    } else if (!tryPromote()) {
      tryPhish();
    }
  }

  return {
    tasks,
    refused,
    expectedMoneyPerSec,
    expectedCharismaExpPerSec,
    ...(hunter !== undefined ? { cacheHunter: hunter } : {}),
  };
}

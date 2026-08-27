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
 * decisions out live in `game/dnet/orders.ts`.
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

import { reclaimForecast } from "./farm.ts";
import { fresh, type DnetHost, type ExpiryOpts } from "./host.ts";
import type { LabRouteBias } from "./maze.ts";
import { INDUCE_WAIT_MS, isLabyrinth, isOnAirGap, labStage, NET_WIDTH } from "./rates.ts";

/** What every policy here needs to know about one host. All of it is already in
 * the knowledge fold; none of it is a credential. */
export interface HoldHost {
  hostname: string;
  /** Identity model, for spotting the labyrinth among the projected hosts. */
  modelId?: string;
  /** Current row. */
  depth?: number;
  /** Original row, and the thing migration is anchored on. Also what decides
   *  RAM: `baseRam = 16 * 2 ** floor(difficulty / 6)`. */
  difficulty?: number;
  maxRam?: number;
  freeGb?: number;
  /** Fresh owner-blocked RAM. A recycler target must have paid this down. */
  blockedRam?: number;
  /** Fresh file-list facts. Empty is observed-empty; absent is unknown/stale. */
  caches?: readonly string[];
  contracts?: readonly string[];
  stormSeed?: boolean;
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
  /** Home-side equivalent of irreplaceable, derived from the drained walker. */
  protected?: boolean;
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
  /** How many rows off a spare target a host may sit and still claim it.
   *  Absent: `STASIS_TARGET_SLACK`. A wider slack trades placement precision
   *  for candidate quality — the fix for a tiny on-target host beating a
   *  giant one row outside the window. */
  spareSlack?: number;
  /** How a spare target's window is won: `"ram"` (biggest maxRam — shipped)
   *  or `"ramPerDistance"` (maxRam halved per row off target, so a 4x bigger
   *  host wins from up to two rows further away). */
  spareScoring?: "ram" | "ramPerDistance";
  /** Our per-target estimate of `DarknetState.migrationInductionServers` —
   *  the engine's accumulated charge, which no ns member reads back but whose
   *  every `induceServerMigration` response REPORTS ("Migration prep is now
   *  at X.XX%"). With it, `assign` sizes each target's pushers to reach 100%
   *  in ONE wave and no further: the charge is additive and calls resolve one
   *  at a time, so threads past the remainder are pure overshoot. Absent, a
   *  target is assumed uncharged and gets one full wave's worth. */
  migrationCharge?: ReadonlyMap<string, number>;
  /** Hard override on pushers per target, ON TOP of the charge budget.
   *  Normally unnecessary — the charge budget is the cap. */
  maxPushersPerTarget?: number;
  /** How many lab candidates the race may staff at once. Absent: as many as
   *  the leftover pushers can fully power, most promising first. */
  maxLabCandidates?: number;
  /** How many hosts may be ferried into ONE unconquered band at once. Absent:
   *  as many as the leftover pushers can power — a landing is a uniform
   *  re-roll, so racing several carriers multiplies the per-wave chance of
   *  actually crossing, the same argument as the lab race. */
  maxFerriesPerBand?: number;
  /** Hosts whose NEXT authenticate is their last remaining candidate — the
   *  crack is one in-flight call away — mapped to the milliseconds LEFT on
   *  that authenticate. They are admitted to the push pools early
   *  (`induceServerMigration` needs only a direct connection, not the
   *  credential) and charge at full speed; the only discipline is TIMING:
   *  while the auth's remaining time exceeds `INDUCE_WAIT_MS -
   *  PRECHARGE_MARGIN_MS`, the wave stops one landing short of 100%, because
   *  a landing re-rolls the host's edges and would kill the in-flight call.
   *  Once the remainder fits inside a charge call's own 6 s flight, the
   *  closing call fires and its landing arrives after the auth (and the
   *  instant plant behind it) by construction. */
  aboutToCrack?: ReadonlyMap<string, number>;
  /** How many frontier targets a pass may push. Absent: every candidate that
   *  passes the PROGRESS criterion (its band reaches strictly deeper than our
   *  deepest agent) — which is what retired the old random-walk pump: a band
   *  we already cover admits no push at all. */
  maxFrontierTargets?: number;
  /** Whether one stasis slot must be HELD BACK for the maze walker's vantage.
   *
   *  The walker is the one thing in the feature that cannot be rebuilt — its
   *  position is keyed by PID, and the deep labs are hours long — so a run that
   *  spent every link on spare coverage and then found the walk's vantage
   *  unpinnable has traded the critical thing for a nice one. Set by the
   *  controller while the labyrinth still needs walking; the reservation stands
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
 * The controller and home each build these from the same fold but see different
 * extras — the controller spreads in `difficulty`/`maxRam`/`freeGb`/
 * `irreplaceable`, home spreads in `backdoored` — so this covers only what both
 * derive identically: the fresh facts, and the three flags the caller already
 * holds. Fields stay ABSENT rather than `undefined` when unknown; the planners
 * branch on `!== undefined` and the tests pin the difference. */
export function holdHostFrom(
  standing: DnetHost,
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
  const modelId = fresh<string>(standing, "modelId", opts.at, opts.expiry);
  return {
    hostname: standing.hostname,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(depth !== undefined ? { depth } : {}),
    agentAlive: opts.agentAlive,
    hasCredential: opts.hasCredential,
    ...(neighbours !== undefined ? { neighbours } : {}),
    ...(fresh<boolean>(standing, "isStationary", opts.at, opts.expiry) === true ? { isStationary: true } : {}),
    ...(opts.stasisLinked ? { stasisLinked: true } : {}),
    ...(standing.goneAt !== undefined ? { gone: true } : {}),
  };
}

/** Inputs for the total-time vantage score — see `chooseLabVantage`. */
export interface LabVantageScoring {
  charisma: number;
  /** One walker thread's allocation, for the thread count RAM buys. */
  walkGb: number;
  /** One reclaim thread's allocation, for the grind-time estimate. */
  reclaimGb: number;
  /** Expected walk length in attempts; the lab lane's planner mean. */
  walkAttempts?: number;
  /** One attempt's cost at ONE thread, before the thread factor. */
  attemptMsAt1Thread?: number;
}

const DEFAULT_WALK_ATTEMPTS = 120;
const DEFAULT_ATTEMPT_MS = 4_000;

/** Estimated time from HERE to a walked lab through this candidate: grind its
 * block clear, then walk at the threads its RAM buys. The two terms pull in
 * opposite directions — a big host walks faster but may block longer — and
 * raw `maxRam` sees only one of them. */
export function labVantageTotalMs(host: HoldHost, scoring: LabVantageScoring): number {
  const grindThreads = Math.max(1, Math.floor((host.freeGb ?? 0) / scoring.reclaimGb));
  const forecast = reclaimForecast(host, scoring.charisma, grindThreads);
  const grindMs = (host.blockedRam ?? 0) <= 0 ? 0 : forecast?.clearMs ?? Infinity;
  const walkThreads = Math.max(1, Math.floor((host.maxRam ?? 0) / scoring.walkGb));
  const walkMs = (scoring.walkAttempts ?? DEFAULT_WALK_ATTEMPTS)
    * (scoring.attemptMsAt1Thread ?? DEFAULT_ATTEMPT_MS)
    / (1 + 0.2 * (walkThreads - 1));
  return grindMs + walkMs;
}

/** Choose the one host that will become the lab walker.
 *
 * Once a candidate has been stasis-linked it is a commitment: switching to a
 * larger unlinked neighbour would strand the first link and restart the whole
 * preparation sequence. Among equally committed candidates: with `scoring`,
 * the least TOTAL time to a walked lab wins (grind + walk — a big host with a
 * huge owner block can lose to a clean smaller one); without it, raw RAM wins
 * because every remaining gigabyte becomes an authenticate thread. */
export function chooseLabVantage(
  candidates: readonly HoldHost[],
  scoring?: LabVantageScoring,
): HoldHost | undefined {
  return [...candidates].sort((a, b) =>
    Number(b.stasisLinked === true) - Number(a.stasisLinked === true)
    || (scoring !== undefined
      ? labVantageTotalMs(a, scoring) - labVantageTotalMs(b, scoring)
      : (b.maxRam ?? 0) - (a.maxRam ?? 0))
    || (b.maxRam ?? 0) - (a.maxRam ?? 0)
    || (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0))[0];
}

// --- the walk / pins / hold orchestration ------------------------------------
//
// Extracted from the controller's closure so the maze-vantage and pin
// decisions are a pure function of a projected view, testable without a game.
// The controller projects `HoldHost[]` (live handles, RAM, credentials), hands
// over the few scalars it alone knows, and applies the returned tasks.

/** One admitted hold action, in the exact shape `DeriveOptions.hold` accepts. */
export interface HoldTask {
  kind: "pin" | "induce" | "walk" | "storm";
  host: string;
  from: string;
  threads?: number;
  reason: string;
  /** Pins only: the neighbour this pin exists to keep — the lab. */
  edge?: string;
  /** Pins only: release the link instead. */
  unpin?: boolean;
  /** Walks only: the macro-route this walker's prior commits to. The finisher
   *  stays unbiased; a scout is worth most on the route the finisher is not
   *  on. */
  route?: LabRouteBias;
  /** Walks only: a MORTAL scout — a second, unpinned walker. Never stamped
   *  irreplaceable, never reserves a stasis slot, keeps its prober, and its
   *  death costs a re-plant rather than the walk (the shared field survives). */
  scout?: true;
}

export interface HoldPlanInputs {
  /** Projected hosts. MUTATED: the walk's vantage is stamped `irreplaceable`
   *  in place so `planStasis` sees the same commitment the controller does. */
  hosts: HoldHost[];
  netDepth: number;
  stasisLimit: number;
  /** Links actually held right now — the controller's own count. */
  stasisLinkedCount: number;
  /** Whether this world still expects a labyrinth to walk. */
  labExpected: boolean;
  charisma: number;
  /** The vantage the FINISHER walk is already running or staged from, if any. */
  walkerAt?: string;
  /** The vantages mortal scouts already walk from, if any. */
  scoutsAt?: ReadonlySet<string>;
  /** Field mortal scouts beside the finisher when further lab-adjacent
   *  staffed vantages exist. The party benchmark's finding: a second PID in
   *  the same maze shares the field and the charisma pool, either finishing
   *  roots the lab, and even a short-lived scout beats solo (0.905x; two
   *  scouts 0.854x). */
  scoutWalker?: boolean;
  /** How many scouts may walk at once. Defaults to 1 when `scoutWalker`. */
  maxScouts?: number;
  /** One walker thread's allocation; undefined refuses the walk on room. */
  walkGb?: number;
  /** One pin job's allocation. */
  pinGb: number;
  induceGbPerThread?: number;
  /** One reclaim thread's allocation. With `vantageScoring: "totalTime"` the
   *  lab vantage is chosen by estimated grind+walk time instead of raw RAM. */
  reclaimGb?: number;
  vantageScoring?: "maxRam" | "totalTime";
  /** Induce dials — see `HoldView`. */
  migrationCharge?: ReadonlyMap<string, number>;
  maxPushersPerTarget?: number;
  maxFrontierTargets?: number;
  maxLabCandidates?: number;
  maxFerriesPerBand?: number;
  aboutToCrack?: ReadonlyMap<string, number>;
  /** Spare-placement dials — see `HoldView`. */
  spareSlack?: number;
  spareScoring?: "ram" | "ramPerDistance";
}

export interface HoldPlan {
  tasks: HoldTask[];
  refused: HoldRefusal[];
  /** The labyrinth's password is held: the walk is over. */
  labWalked: boolean;
  labCandidate?: string;
  /** The maze's charisma gate when it refused the walk. */
  charismaNeeded?: number;
}

interface WalkPlan {
  lab?: HoldHost;
  candidate?: string;
  tasks: HoldTask[];
  charismaNeeded?: number;
}

/** Whether and where the maze walk can run, and every named reason it cannot.
 *
 * The refusal sequence is the preparation checklist in order: a vantage, its
 * pin, fresh blocked RAM, a zero block, a resident, and room for one legal
 * walker thread. Each stops the walk and names the one thing to fix next. */
export function planWalk(
  inputs: Pick<HoldPlanInputs, "hosts" | "charisma" | "walkerAt" | "scoutsAt" | "scoutWalker" | "maxScouts" | "walkGb" | "reclaimGb" | "vantageScoring">,
  refuse: (host: string, why: string, detail: string) => void,
): WalkPlan {
  const lab = inputs.hosts.find((h) => isLabyrinth(h.hostname, h.modelId) && h.gone !== true);
  if (lab === undefined) return { tasks: [] };
  if (lab.hasCredential) {
    refuse(lab.hostname, "lab-walked", "we already hold this lab's password, so its maze has been finished");
    return { lab, tasks: [] };
  }
  const needed = labStage(lab.hostname)?.cha;
  if (needed !== undefined && inputs.charisma < needed) {
    refuse(lab.hostname, "charisma", `the maze needs charisma ${needed}, and every move below it answers 451`);
    return { lab, tasks: [], charismaNeeded: needed };
  }
  let walkerAt = inputs.walkerAt;
  const tasks: HoldTask[] = [];
  if (walkerAt === undefined) {
    // Only worth choosing when no walk is in flight: for the whole multi-minute
    // walk this filter-and-sort would otherwise run every tick for nothing.
    const scoring = inputs.vantageScoring === "totalTime"
      && inputs.walkGb !== undefined && inputs.reclaimGb !== undefined
      ? { charisma: inputs.charisma, walkGb: inputs.walkGb, reclaimGb: inputs.reclaimGb }
      : undefined;
    const vantageHost = chooseLabVantage(inputs.hosts.filter((h) =>
      (h.agentAlive || h.stasisLinked === true)
      && h.neighbours?.includes(lab.hostname) === true
      && h.hasCredential), scoring);
    const vantage = vantageHost?.hostname;
    if (vantage === undefined) {
      refuse(lab.hostname, "no-vantage", "nothing of ours is standing next to the labyrinth with room for a walker");
      return { lab, tasks };
    }
    const standing = inputs.hosts.find((h) => h.hostname === vantage);
    if (standing?.stasisLinked !== true) {
      refuse(vantage, "walker-unpinned", "the lab candidate must be in position and stasis-linked before preparation finishes");
      return { lab, candidate: vantage, tasks };
    }
    if (standing.blockedRam === undefined) {
      refuse(vantage, "ram-unknown", "the lab candidate's blocked RAM is not fresh");
      return { lab, candidate: vantage, tasks };
    }
    if (standing.blockedRam > 0) {
      refuse(vantage, "ram-blocked", `${standing.blockedRam.toFixed(2)}GB remains before the lab walker can start`);
      return { lab, candidate: vantage, tasks };
    }
    if (!standing.agentAlive) {
      refuse(vantage, "walker-unstaffed", "the pinned lab candidate is being reclaimed or awaiting its resident");
      return { lab, candidate: vantage, tasks };
    }
    const maxRam = standing.maxRam ?? 0;
    if (inputs.walkGb === undefined || maxRam < inputs.walkGb) {
      refuse(vantage, "no-room", "the lab candidate cannot fit one legal walker thread");
      return { lab, candidate: vantage, tasks };
    }
    tasks.push({ kind: "walk", host: lab.hostname, from: vantage, threads: Math.floor(maxRam / inputs.walkGb), reason: `walk the maze from ${vantage}` });
    walkerAt = vantage;
  }
  // THE MORTAL SCOUTS: once a finisher walks, up to `maxScouts` more
  // lab-adjacent staffed vantages may join it — unpinned, opportunistic
  // (their absence refuses nothing), each biased to a route the unbiased
  // finisher tends away from. A scout keeps its prober, so its threads come
  // from FREE room, not the whole host.
  if (inputs.scoutWalker === true && walkerAt !== undefined && inputs.walkGb !== undefined) {
    const SCOUT_ROUTES: readonly LabRouteBias[] = ["southern", "eastern"];
    const scoutsAt = inputs.scoutsAt ?? new Set<string>();
    const taken = new Set([walkerAt, ...scoutsAt]);
    let seat = scoutsAt.size;
    const cap = Math.min(Math.max(0, inputs.maxScouts ?? 1), SCOUT_ROUTES.length);
    while (seat < cap) {
      const scout = chooseLabVantage(inputs.hosts.filter((h) =>
        !taken.has(h.hostname)
        && h.agentAlive
        && h.gone !== true
        // A pinned host is never a scout's seat: `chooseLabVantage` ranks
        // stasis-linked candidates FIRST, so without this the sacrificial
        // walker would preferentially settle on the one link this world can
        // least afford to spend on something whose death is priced in.
        && h.stasisLinked !== true
        && h.neighbours?.includes(lab.hostname) === true
        && h.hasCredential
        && (h.freeGb ?? 0) >= inputs.walkGb!));
      if (scout === undefined) break;
      taken.add(scout.hostname);
      tasks.push({
        kind: "walk",
        host: lab.hostname,
        from: scout.hostname,
        threads: Math.max(1, Math.floor((scout.freeGb ?? 0) / inputs.walkGb)),
        route: SCOUT_ROUTES[seat % SCOUT_ROUTES.length]!,
        scout: true,
        reason: `mortal scout from ${scout.hostname}`,
      });
      seat++;
    }
  }
  return { lab, ...(walkerAt !== undefined ? { candidate: walkerAt } : {}), tasks };
}

/** Turn a stasis planner's pin/release name list into admitted pin tasks.
 *
 * Two gates: room for the 12 GB `setStasisLink` beside whatever the host is
 * doing, and a way BACK — a credential for the post-pin remote plant (a pin
 * job ends with the host empty), or for a release, a neighbour able to
 * re-plant it once the link's backdoor is gone. */
export function admitPins(
  hosts: readonly HoldHost[],
  pin: readonly string[],
  pinGb: number,
  refuse: (host: string, why: string, detail: string) => void,
  labHost?: string,
  remoteAfter = true,
): HoldTask[] {
  const tasks: HoldTask[] = [];
  for (const hostname of pin) {
    const standing = hosts.find((h) => h.hostname === hostname);
    const free = standing?.freeGb ?? 0;
    if (standing?.agentAlive === true && pinGb > free) {
      refuse(hostname, "no-room", `a 12 GB setStasisLink needs ${pinGb.toFixed(2)}GB and ${free.toFixed(2)}GB is free`);
      continue;
    }
    const replanter = hosts.some((other) =>
      other.hostname !== hostname && other.agentAlive && other.neighbours?.includes(hostname) === true);
    if ((!remoteAfter && !replanter) || standing?.hasCredential !== true) {
      refuse(hostname, "no-replanter", remoteAfter
        ? "the host has no credential for its post-pin remote plant"
        : "releasing the link would leave no neighbour able to re-plant this host");
      continue;
    }
    tasks.push({ kind: "pin", host: hostname, from: hostname, reason: "pin the host nothing can replace", ...(labHost !== undefined ? { edge: labHost } : {}) });
  }
  return tasks;
}

/** The whole hold decision: walk, then stasis pins and releases, then the
 * migration pushes — every task and every named refusal, from one projected
 * view. The controller's only jobs are projecting the view and filing the
 * tasks. */
export function planHold(inputs: HoldPlanInputs): HoldPlan {
  const refused: HoldRefusal[] = [];
  const refuse = (hostname: string, why: string, detail: string): void => {
    refused.push({ hostname, why, detail });
  };
  const tasks: HoldTask[] = [];
  const view: HoldView = {
    hosts: inputs.hosts,
    netDepth: inputs.netDepth,
    stasisLimit: inputs.stasisLimit,
    spareTargets: stasisTargetDepths(
      inputs.netDepth,
      inputs.labExpected ? inputs.stasisLimit - 1 : inputs.stasisLimit,
      inputs.labExpected,
    ),
    charisma: inputs.charisma,
    authDurationMultiplier: 1,
    ...(inputs.spareSlack !== undefined ? { spareSlack: inputs.spareSlack } : {}),
    ...(inputs.spareScoring !== undefined ? { spareScoring: inputs.spareScoring } : {}),
  };
  const walk = planWalk(inputs, refuse);
  const labCandidate = inputs.hosts.find((h) => h.hostname === walk.candidate);
  if (labCandidate) labCandidate.irreplaceable = true;
  for (const task of walk.tasks) {
    tasks.push(task);
    // The scout is deliberately NOT irreplaceable: it never reserves a stasis
    // slot and its death is priced in — the shared field survives it.
    if (task.scout === true) continue;
    const standing = inputs.hosts.find((h) => h.hostname === task.from);
    if (standing) standing.irreplaceable = true;
  }
  const labWalked = walk.lab !== undefined && walk.lab.hasCredential;
  const stasis = planStasis({ ...view, reserveForWalker: !labWalked && inputs.labExpected });
  for (const refusal of stasis.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
  for (const task of admitPins(inputs.hosts, stasis.release, inputs.pinGb, refuse, undefined, false)) {
    tasks.push({ ...task, unpin: true, reason: "release a link its host no longer earns" });
  }
  const walkerPin = (name: string): boolean =>
    inputs.hosts.find((e) => e.hostname === name)?.irreplaceable === true;
  tasks.push(...admitPins(inputs.hosts, stasis.pin.filter(walkerPin), inputs.pinGb, refuse, walk.lab?.hostname));
  tasks.push(...admitPins(inputs.hosts, stasis.pin.filter((name) => !walkerPin(name)), inputs.pinGb, refuse));
  const lab = walk.lab;
  const spareLinks = Math.max(0, inputs.stasisLimit - inputs.stasisLinkedCount);
  const labNeed = lab !== undefined && !lab.hasCredential && walk.candidate === undefined;
  const ferryWanted = unconqueredBands(view).length > 0;
  if (!labNeed && spareLinks === 0 && !ferryWanted) {
    if (lab !== undefined) refuse(lab.hostname, "push-not-needed", "the labyrinth is reachable, every stasis link is spent, and every band holds a resident");
  } else {
    const induce = planInduce({
      ...view,
      induceGbPerThread: inputs.induceGbPerThread,
      needLabVantage: labNeed,
      ...(inputs.migrationCharge !== undefined ? { migrationCharge: inputs.migrationCharge } : {}),
      ...(inputs.maxPushersPerTarget !== undefined ? { maxPushersPerTarget: inputs.maxPushersPerTarget } : {}),
      ...(inputs.maxFrontierTargets !== undefined ? { maxFrontierTargets: inputs.maxFrontierTargets } : {}),
      ...(inputs.maxLabCandidates !== undefined ? { maxLabCandidates: inputs.maxLabCandidates } : {}),
      ...(inputs.maxFerriesPerBand !== undefined ? { maxFerriesPerBand: inputs.maxFerriesPerBand } : {}),
      ...(inputs.aboutToCrack !== undefined ? { aboutToCrack: inputs.aboutToCrack } : {}),
    });
    for (const refusal of induce.refused) refuse(refusal.hostname, refusal.why, refusal.detail);
    for (const push of induce.pushes) tasks.push({ kind: "induce", host: push.host, from: push.from, threads: push.threads, reason: push.reason });
  }
  return {
    tasks,
    refused,
    labWalked,
    ...(walk.candidate !== undefined ? { labCandidate: walk.candidate } : {}),
    ...(walk.charismaNeeded !== undefined ? { charismaNeeded: walk.charismaNeeded } : {}),
  };
}

// --- backdoors ---------------------------------------------------------------

/** Two recycler slots avoid the third backdoor's global 3% timeout chance. */
export const BACKDOOR_RECYCLER_LIMIT = 2;

/** Engine authentication-duration allowance. Kept for fidelity/tests; the
 * recycler deliberately ignores growth beyond two because timeout chance starts
 * at the third ordinary backdoor regardless of this allowance. */
export function freeBackdoorAllowance(rootedMovable: number): number {
  return Math.max(rootedMovable / (NET_WIDTH * 3), 2);
}

/** The unmutated RAM for a host's immutable generation difficulty.
 * Upstream then chooses one of [0.5, 1, 1, 1.15, 1.4], with a 16 GB floor. */
export function normalRamForDifficulty(difficulty: number): number {
  return Math.max(16, 16 * 2 ** Math.floor(difficulty / 6));
}

export interface BackdoorPlan {
  install: string[];
  refused: HoldRefusal[];
  allowance: number;
}

/** Keep two expendable backdoors on the worst fully-harvested hosts.
 *
 * Restarts remove the backdoor but preserve root, files and cleared RAM.
 * Deletion removes the identity, letting a later population addition mint a
 * fresh first-auth cache roll and a fresh block with its guaranteed clear
 * cache. Missing resource facts refuse rather than masquerading as empty. */
export function planBackdoors(view: HoldView): BackdoorPlan {
  const refused: HoldRefusal[] = [];
  const live = view.hosts.filter((host) => !host.gone);
  const allowance = BACKDOOR_RECYCLER_LIMIT;
  // Only the TAXED pool: `getBackdooredDarknetServers` excludes stasis-linked
  // hosts, so a pinned host's backdoor is free and must not eat the allowance.
  const held = live.filter((host) => host.backdoored && !host.stasisLinked).length;

  const refuse = (hostname: string, why: string, detail: string): void => {
    refused.push({ hostname, why, detail });
  };

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
        refuse(host.hostname, "no-credential", "the first-authentication reward has not been claimed");
        return false;
      }
      if (host.protected || host.irreplaceable) {
        refuse(host.hostname, "protected", "an irreplaceable labyrinth walk is running here");
        return false;
      }
      if (host.difficulty === undefined || host.maxRam === undefined) {
        refuse(host.hostname, "ram-unknown", "difficulty or maximum RAM is missing or stale");
        return false;
      }
      if (host.blockedRam === undefined || host.caches === undefined
        || host.contracts === undefined || host.stormSeed === undefined) {
        refuse(host.hostname, "harvest-unknown", "blocked RAM or the file listing is missing or stale");
        return false;
      }
      if (host.blockedRam > 0) {
        refuse(host.hostname, "ram-blocked", `${host.blockedRam.toFixed(2)}GB remains to reclaim`);
        return false;
      }
      if (host.caches.length > 0) {
        refuse(host.hostname, "cache-held", `${host.caches.length} cache file${host.caches.length === 1 ? " is" : "s are"} unopened`);
        return false;
      }
      if (host.contracts.length > 0) {
        refuse(host.hostname, "contract-held", `${host.contracts.length} coding contract${host.contracts.length === 1 ? " is" : "s are"} uncollected`);
        return false;
      }
      if (host.stormSeed) {
        refuse(host.hostname, "seed-held", "STORM_SEED.exe would be destroyed by deletion");
        return false;
      }
      return true;
    })
    .map((host) => ({
      host,
      ratio: host.maxRam! / normalRamForDifficulty(host.difficulty!),
    }))
    // True 0.5x generation outliers lead. If there are fewer than two, the same
    // order deliberately falls back through the worst normal hosts.
    .sort((a, b) => a.ratio - b.ratio
      || a.host.maxRam! - b.host.maxRam!
      || (a.host.hostname < b.host.hostname ? -1 : 1));

  const install: string[] = [];
  for (const entry of ranked) {
    if (held + install.length >= allowance) {
      refuse(entry.host.hostname, "slots-filled", `${allowance} recycler backdoors are already held or planned`);
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
 * And a fourth, STRUCTURAL fact outranks all three: the air-gap rows (every
 * 8th depth) are permanently empty and wiring reaches only ±1 row, so the net
 * is cut into BANDS no edge ever crosses. After a storm, a pin inside a band
 * is the only surviving foothold there — `darkweb` can only re-crawl the top
 * band, and nothing walks across a gap. So the placement is per band: the
 * spares are allocated across the bands by depth mass (deeper bands are
 * heavier, so deep fills first), and sit at even centers WITHIN their band —
 * one spare lands at the band's middle, and centers keep clear of the
 * gap-adjacent edge rows, whose upper or lower catchment is a row that can
 * never hold a server. The walker's row and the row beside it are excluded —
 * the walker's pin already anchors the deepest band's floor.
 *
 * In a LAB-LESS world (program-only access never generates a labyrinth) there
 * is no walker, so the deepest anchor — the bottom row itself — is a spare's,
 * and the rest spread above it. The limit can never grow there (the +1s are
 * labyrinth augmentations), so in practice that world has exactly one link,
 * and it sits at the bottom. */
export function stasisTargetDepths(netDepth: number, spares: number, labExpected = true): number[] {
  if (spares <= 0) return [];
  const targets: number[] = [];
  let remaining = spares;
  if (!labExpected) {
    // No walker owns the bottom row there; the deepest anchor is a spare's.
    targets.push(netDepth - 1);
    remaining--;
  }
  // Eligible rows: never a gap, never the bottom anchor's own coverage —
  // whether that anchor is the walker's pin or the lab-less bottom spare.
  const bands = depthBands(netDepth, netDepth - 3);
  // d'Hondt by depth mass: each spare goes to the band maximizing
  // mass / (allocated + 1), ties to the DEEPER band, quota capped at the
  // band's row count. Depth weighting makes deep bands heavy, so deep fills
  // first and densest without a special case.
  const quota = bands.map(() => 0);
  for (let spare = 0; spare < remaining; spare++) {
    let best = -1;
    let bestScore = -1;
    for (let index = 0; index < bands.length; index++) {
      if (quota[index]! >= bands[index]!.rows.length) continue;
      const score = bands[index]!.mass / (quota[index]! + 1);
      // Bands are listed shallow-first, so >= hands ties to the deeper one.
      if (score >= bestScore) {
        bestScore = score;
        best = index;
      }
    }
    if (best < 0) break;
    quota[best]!++;
  }
  // Even centers within each band: j spares in n rows sit at the centers of j
  // equal slices — one spare is the band middle, and no center touches an
  // edge row unless the band is too small to avoid it.
  for (let index = 0; index < bands.length; index++) {
    const rows = bands[index]!.rows;
    for (let i = 1; i <= quota[index]!; i++) {
      const at = Math.min(
        rows.length - 1,
        Math.max(0, Math.round(((i - 0.5) / quota[index]!) * rows.length - 0.5)),
      );
      const depth = rows[at]!;
      if (!targets.includes(depth)) targets.push(depth);
    }
  }
  return targets.sort((a, b) => b - a);
}

/** The contiguous non-gap row runs of `[0 .. through]`, shallow-first, each
 * with its depth mass (Σ d+1) — the denominator of the spare allocation and
 * the unit the ferry conquers. */
function depthBands(netDepth: number, through: number): { rows: number[]; mass: number }[] {
  const bands: { rows: number[]; mass: number }[] = [];
  const top = Math.min(through, netDepth - 1);
  for (let depth = 0; depth <= top; depth++) {
    if (isOnAirGap(depth)) continue;
    const current = bands[bands.length - 1];
    if (current !== undefined && current.rows[current.rows.length - 1] === depth - 1) {
      current.rows.push(depth);
      current.mass += depth + 1;
    } else {
      bands.push({ rows: [depth], mass: depth + 1 });
    }
  }
  return bands;
}

/** The bands (over the WHOLE net this time, bottom row included) where no
 * resident of ours is standing — the ferry's destinations, deepest first.
 *
 * No edge ever crosses an air gap, and a leaked password is unusable across
 * one (`connectToSession` needs the host already rooted, `authenticate` a
 * direct connection) — so pushing a credentialed host with its resident
 * riding is the ONLY deliberate way into an unconquered band. A band we have
 * never even observed still counts: pushing in is also how we look. */
export function unconqueredBands(view: Pick<HoldView, "hosts" | "netDepth">): number[][] {
  return depthBands(view.netDepth, view.netDepth - 1)
    .filter((band) => !view.hosts.some((host) =>
      host.gone !== true && host.agentAlive
      && host.depth !== undefined && band.rows.includes(host.depth)))
    .map((band) => band.rows)
    .sort((a, b) => b[0]! - a[0]!);
}

/** Whether a host at this depth serves this target. */
function nearTarget(depth: number | undefined, target: number, slack = STASIS_TARGET_SLACK): boolean {
  return depth !== undefined && Math.abs(depth - target) <= slack;
}

/** The spare targets no held link serves yet, deepest first.
 *
 * Shared by `planStasis`, which pins toward them, and `planInduce`, which
 * pushes big hosts into their windows. A held link within slack of several
 * targets serves the DEEPEST one, matching the order pins are assigned in. */
export function openSpareTargets(view: Pick<HoldView, "hosts" | "spareTargets" | "spareSlack">): number[] {
  const slack = view.spareSlack ?? STASIS_TARGET_SLACK;
  const open = [...(view.spareTargets ?? [])].sort((a, b) => b - a);
  for (const held of view.hosts) {
    if (held.gone || held.stasisLinked !== true || held.irreplaceable) continue;
    const index = open.findIndex((target) => nearTarget(held.depth, target, slack));
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
    if (host.irreplaceable === true) {
      walkers.push(host);
    } else spareable.push(host);
  }
  walkers.sort((a, b) => (a.hostname < b.hostname ? -1 : 1));

  // Spares claim the open targets, deepest first; per target the biggest
  // measured host within slack wins. A loser may still win a shallower
  // target, so refusals are settled only after every target has chosen.
  const slack = view.spareSlack ?? STASIS_TARGET_SLACK;
  const spareScore = (host: HoldHost, target: number): number =>
    view.spareScoring === "ramPerDistance"
      ? host.maxRam! / 2 ** Math.abs((host.depth ?? target) - target)
      : host.maxRam!;
  const taken = new Set<string>();
  const spares: HoldHost[] = [];
  for (const target of open) {
    const winner = spareable
      .filter((host) => !taken.has(host.hostname)
        && host.maxRam !== undefined && nearTarget(host.depth, target, slack))
      .sort((a, b) =>
        (spareScore(b, target) - spareScore(a, target))
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
    } else if (open.some((target) => nearTarget(host.depth, target, slack))) {
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
      Number((view.spareTargets ?? []).some((target) => nearTarget(a.depth, target, slack)))
      - Number((view.spareTargets ?? []).some((target) => nearTarget(b.depth, target, slack)))
      || (a.depth ?? -1) - (b.depth ?? -1)
      || (a.maxRam ?? 0) - (b.maxRam ?? 0)
      || (a.hostname < b.hostname ? -1 : 1));
  if (spareSlots === 0) {
    if (walkers.length > 0 && evictable.length > 0) {
      release.push(evictable[0]!.hostname);
    } else if (spares.length > 0) {
      const offTarget = evictable.find((host) =>
        !(view.spareTargets ?? []).some((target) => nearTarget(host.depth, target, slack)));
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
function migrationChargePerCall(difficulty: number, charisma: number, threads = 1): number {
  return ((charisma + 500) / (difficulty * 200 + 1000)) * 0.01 * threads;
}

/** Calls to move one host, at a fixed thread count. Each carries a hardcoded 6 s
 * delay (`NetscriptFunctions/Darknet.ts:443`). */
export function migrationCalls(difficulty: number, charisma: number, threads = 1): number {
  const per = migrationChargePerCall(difficulty, charisma, threads);
  return per > 0 ? Math.ceil(1 / per) : Infinity;
}

/** How long after the authenticate's expected completion the wave-closing
 * landing must arrive. The landing re-rolls the host's edges, and an
 * authenticate still in flight across one of them would die 351 — but a
 * charge call is 6 s long, so "close after the auth" is pure scheduling: the
 * closing call may FIRE the moment the auth's remaining time fits inside the
 * call's own flight minus this margin. */
export const PRECHARGE_MARGIN_MS = 200;

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

/** Why a push was chosen, because five different questions share the one
 *  call: seat a lab candidate on the bottom row, clear a stranger OFF the
 *  bottom row so a candidate can land, seat a big host inside an open stasis
 *  target's window, ferry a resident-carrying host across an air gap into an
 *  unconquered band, or just deepen the net's frontier. */
export type InducePurpose = "free-slot" | "lab" | "seat" | "ferry" | "frontier";

export interface InducePlan {
  /** Every admitted push: one per PUSHER, any number per TARGET. The charge
   *  accumulates on the TARGET (`DarknetState.migrationInductionServers`), so
   *  several adjacent agents charging one host move it ~N× faster —
   *  `induceServerMigration` cannot target its own host, so each entry names
   *  the neighbour doing the pushing. */
  pushes: {
    host: string;
    from: string;
    /** Sized from the PUSHER's free RAM: the charge each call adds is linear
     *  in the calling script's threads. */
    threads: number;
    expectedCalls: number;
    reason: string;
    purpose: InducePurpose;
  }[];
  refused: HoldRefusal[];
}

/** Every push worth making this pass, one per available pusher.
 *
 * Every migration is a re-roll inside `[difficulty - 2, difficulty + 4]` (see
 * `canReachBottomRow` — the band is anchored on DIFFICULTY, never on where the
 * host currently sits), and `addServerToNetwork` connects any server landing
 * at `depth === netDepth - 1` to the lab automatically
 * (`NetworkGenerator.ts:225-230`). Five distinct things a re-roll can buy, in
 * priority order:
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
 * 4. **`ferry`** — the biggest authenticated host WITH A RESIDENT whose band
 *    reaches into an unconquered band (`unconqueredBands`). No edge ever
 *    crosses an air gap and a leaked password is unusable across one, so this
 *    is the only deliberate way in — and the resident IS the payload, riding
 *    the move to become the far side's first vantage. A ferried host cannot
 *    be released again until a neighbour can re-plant it; while pinned, its
 *    stasis backdoor permits a remote plant from any live resident.
 * 5. **`frontier`** — with nothing to seat or ferry, general movement down.
 *    The band's centre is `difficulty + 1`, so a host at or above that depth
 *    moves DEEPER on average; one at or below it is as likely to bounce up,
 *    and is left alone (`no-gain`). Biggest first — RAM still ranks, it just
 *    stopped being an entry requirement.
 *
 * One push per PUSHER, any number per TARGET: the charge accumulates on the
 * target, so every unused adjacent agent joins the highest-priority target it
 * can reach — adjacency keeps the pile-on local — while free-slot, lab, seat
 * and ferry each cap their TARGETS (one evictee, one lab candidate, one host
 * per window, one per band): racing two hosts toward the same landing wastes
 * one of them. The queue's per-agent priorities (induce below survey, attempt
 * and reclaim; above phish and promote) then run each push exactly when that
 * agent has nothing better to do — induce is exploration's last step, and
 * money is the filler behind it.
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
  const ferryPool: HoldHost[] = [];
  /** Which unconquered band each ferry crosses into. */
  const ferryBandFor = new Map<string, readonly number[]>();
  const frontierPool: HoldHost[] = [];
  const evictPool: HoldHost[] = [];
  const openTargets = openSpareTargets(view);
  const unconquered = unconqueredBands(view);
  const bottomCount = live.filter((host) => host.depth === bottom).length;
  // As observed — knowledge may be missing seats we have never seen, so this
  // errs toward NOT evicting, which is the direction that spends nothing.
  const bottomFull = bottomCount >= NET_WIDTH;
  // The frontier's PROGRESS criterion: our deepest standing agent, and how
  // deep a host's migration band can actually reach (air-gap rows hold
  // nothing). A push only counts as frontier work when the band reaches
  // STRICTLY past the coverage — a band we already stand at the bottom of is
  // a random walk, not progress, and pushing it was the old pump.
  const deepestCovered = live.reduce(
    (held, host) => (host.agentAlive && host.depth !== undefined && host.depth > held ? host.depth : held),
    -1,
  );
  /** Targets whose last authenticate still has more time left than a charge
   * call's flight — `assign` charges them flat out but holds the CLOSING
   * landing until the remainder fits. */
  const holdClosing = new Set<string>();
  const bandDeepest = (difficulty: number): number => {
    for (let row = Math.min(difficulty + 4, view.netDepth - 1); row >= Math.max(0, difficulty - 2); row--) {
      if (!isOnAirGap(row)) return row;
    }
    return -1;
  };

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
    const preCracking = view.aboutToCrack?.has(host.hostname) === true && !host.hasCredential;
    if (!host.hasCredential && !preCracking) {
      // The one refusal that fixes itself: a push moves the host wherever it
      // lands, but only a host we have AUTHENTICATED carries anything of ours
      // when it does — the session and any resident ride the move. The answer
      // is the cracking queue, not more charge. EXCEPT a host one candidate
      // from cracked: `induceServerMigration` needs only the direct edge, so
      // its wave PRE-CHARGES to the ceiling while the last authenticate is in
      // flight, and closes the moment the credential and plant land.
      refuse(refused, host, "not-ours", "only an authenticated host is worth pushing; crack it first");
      continue;
    }
    if (preCracking
      && view.aboutToCrack!.get(host.hostname)! > INDUCE_WAIT_MS - PRECHARGE_MARGIN_MS) {
      holdClosing.add(host.hostname);
    }
    if (view.needLabVantage !== false && canReachBottomRow(host.difficulty, view.netDepth)) {
      labPool.push(host);
      continue;
    }
    // Standing inside an open stasis window: `planStasis` pins it where it is,
    // and a re-roll is the one thing that could move it OUT.
    if (openTargets.some((target) => nearTarget(host.depth, target, view.spareSlack ?? STASIS_TARGET_SLACK))) {
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
    // A ferry: the band reaches into a band no resident of ours stands in.
    // The resident IS the payload, so only a host carrying one qualifies —
    // or one about to: a pre-charging candidate's plant lands with its crack,
    // before the wave is allowed to close.
    const ferryBand = host.agentAlive || preCracking
      ? unconquered.find((band) => band.some((row) =>
        host.difficulty! - 2 <= row && row <= host.difficulty! + 4))
      : undefined;
    if (ferryBand !== undefined) {
      ferryPool.push(host);
      ferryBandFor.set(host.hostname, ferryBand);
      continue;
    }
    // Frontier PROGRESS: the band must reach strictly past our deepest
    // standing agent, or a re-roll cannot extend the conquest at all — it
    // only shuffles rows we already reach, which is the retired pump.
    if (host.depth !== undefined && bandDeepest(host.difficulty!) > deepestCovered) {
      frontierPool.push(host);
      continue;
    }
    refuse(
      refused,
      host,
      "no-gain",
      `difficulty ${host.difficulty} bands it to row ${bandDeepest(host.difficulty!)} at best,`
      + ` and our coverage already stands at row ${deepestCovered} — a re-roll cannot extend the conquest`,
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
  // Biggest first for the ferries, ties by the DEEPER destination band — the
  // far side of the deepest gap is the foothold worth the most.
  ferryPool.sort((a, b) =>
    (b.maxRam ?? 0) - (a.maxRam ?? 0)
    || (ferryBandFor.get(b.hostname)?.[0] ?? 0) - (ferryBandFor.get(a.hostname)?.[0] ?? 0)
    || (a.hostname < b.hostname ? -1 : 1));
  // Deepest REACH first — the band that extends the conquest furthest is the
  // push worth the pushers — then biggest RAM, then the name.
  frontierPool.sort((a, b) =>
    bandDeepest(b.difficulty ?? 0) - bandDeepest(a.difficulty ?? 0)
    || (b.maxRam ?? 0) - (a.maxRam ?? 0)
    || (a.hostname < b.hostname ? -1 : 1));
  // SMALLEST first for the seat we want EMPTIED: the worst stranger is the
  // cheapest loss and the same one seat.
  evictPool.sort((a, b) =>
    (a.maxRam ?? 0) - (b.maxRam ?? 0)
    || (a.hostname < b.hostname ? -1 : 1));

  // One push per PUSHER, any number per TARGET — up to the CHARGE BUDGET: the
  // engine's migration charge is additive on the target and resets at 1, so
  // the useful allocation per target is exactly the threads that take the
  // believed remaining charge to 100% in one 6 s wave. Threads past that are
  // overshoot the reset throws away; threads short of it just take more
  // waves, which is fine — a pusher spent here is unavailable for the next
  // target, and THAT is what makes the purpose order below a real priority.
  const pushes: InducePlan["pushes"] = [];
  /** Threads a pusher still has to give. A pusher is not binary: its RAM is a
   * pool, and a wave that needs less than the pool leaves the rest for the
   * NEXT target, whose push queues behind the first on the same vantage. At
   * most two targets per pusher, so one host cannot absorb the whole plan. */
  const pusherPool = new Map<string, { threads: number; targets: number }>();
  const poolFor = (pusher: HoldHost): { threads: number; targets: number } => {
    let held = pusherPool.get(pusher.hostname);
    if (held === undefined) {
      const affordable = view.induceGbPerThread !== undefined && view.induceGbPerThread > 0
        ? Math.max(1, Math.floor((pusher.freeGb ?? 0) / view.induceGbPerThread))
        : 1;
      held = { threads: affordable, targets: 0 };
      pusherPool.set(pusher.hostname, held);
    }
    return held;
  };
  const assign = (
    host: HoldHost,
    purpose: InducePurpose,
    reasonFor: (host: HoldHost, calls: number) => string,
  ): boolean => {
    // Somebody adjacent has to do the pushing, and it cannot be the host
    // itself. Roomiest remaining pool first: threads come from the pusher,
    // so its RAM is the charge rate.
    const pushers = live
      .filter((other) =>
        other.hostname !== host.hostname
        && other.agentAlive
        && poolFor(other).threads >= 1
        && poolFor(other).targets < 2
        && (other.neighbours?.includes(host.hostname) ?? false))
      .sort((a, b) => poolFor(b).threads - poolFor(a).threads || (a.hostname < b.hostname ? -1 : 1));
    if (pushers.length === 0) {
      refuse(refused, host, "no-pusher", "induceServerMigration cannot target its own host, and no free neighbour of ours is standing next to it");
      return false;
    }
    // The wave budget: threads needed to close the believed remaining charge.
    // A held-closing target (its last authenticate still flying longer than a
    // charge call's flight) charges flat out but stops ONE LANDING short of
    // 100% — total assigned charge stays under the close however the threads
    // split across pushers' calls — and the closing call fires on a later
    // pass, once the auth's remainder fits inside the call's own 6 s.
    const perThread = migrationChargePerCall(host.difficulty!, view.charisma, 1);
    const charge = Math.min(1, Math.max(0, view.migrationCharge?.get(host.hostname) ?? 0));
    const fullWave = perThread > 0 ? Math.ceil((1 - charge) / perThread) : 1;
    let neededThreads = holdClosing.has(host.hostname) ? Math.max(0, fullWave - 1) : fullWave;
    if (neededThreads <= 0) {
      // A held-closing target whose whole wave is a single call: the one call
      // left IS the close, and it is being held for the in-flight
      // authenticate. Refused by name rather than dropped, or the host would
      // vanish from both the plan and the ledger that explains it.
      refuse(
        refused,
        host,
        "charge-held",
        "one call from a completed migration, and that closing landing is held until the in-flight authenticate lands",
      );
      return false;
    }
    const pusherCap = view.maxPushersPerTarget ?? pushers.length;
    let admitted = false;
    for (const pusher of pushers.slice(0, Math.max(1, pusherCap))) {
      if (neededThreads <= 0) break;
      // Threads come from the PUSHER's remaining pool: the charge is linear
      // in the calling script's threads and the 6 s wait is constant. Capped
      // at what the wave still needs, so a giant pusher does not overshoot
      // the reset — and what it does not spend here stays in its pool for
      // the next target.
      const pool = poolFor(pusher);
      const threads = Math.min(pool.threads, neededThreads);
      if (threads < 1) continue;
      pool.threads -= threads;
      pool.targets += 1;
      neededThreads -= threads;
      admitted = true;
      const calls = migrationCalls(host.difficulty!, view.charisma, threads);
      pushes.push({
        host: host.hostname,
        from: pusher.hostname,
        threads,
        expectedCalls: calls,
        reason: reasonFor(host, calls) + (threads !== 1 ? ` on ${threads} threads` : ""),
        purpose,
      });
    }
    return admitted;
  };

  // Eviction only while a candidate is actually waiting for the seat — an
  // empty lab pool makes a freed slot a slot freed for nobody — and only ONE
  // evictee: one seat is all the landing needs.
  if (bottomFull && labPool.length > 0) {
    for (const evictee of evictPool) {
      if (assign(evictee, "free-slot", (host, calls) =>
        `bottom row full (${bottomCount}/${NET_WIDTH}): re-roll the ${(host.maxRam ?? 0)}GB stranger`
        + ` off row ${bottom} to free a seat for a lab candidate — ~${calls} calls`)) break;
    }
  }
  // RACE the lab candidates, most promising first (the pool is sorted RAM
  // then difficulty): each `assign` consumes only the pushers its wave needs,
  // so once the best candidate's induce is fully powered there is no reason
  // not to spend the LEFTOVER pushers racing the next — a landing is a
  // uniform re-roll inside the band, and at depth 36 minting that last
  // bottom-row vantage is the dominant term of the whole conquest. Pusher
  // depletion is the limiter; `maxLabCandidates` caps it for the benchmark's
  // single-candidate arm.
  let labRaced = 0;
  for (const host of labPool) {
    if (labRaced >= (view.maxLabCandidates ?? Infinity)) {
      refuse(refused, host, "push-covered", "the lab race is already fully staffed");
      continue;
    }
    if (assign(host, "lab", (chosen, calls) =>
      `${(chosen.maxRam ?? 0)}GB at difficulty ${chosen.difficulty}, band reaches row ${bottom}`
      + ` — ~${calls} calls`)) labRaced++;
  }
  const seatCovered = new Set<number>();
  for (const host of seatPool) {
    const target = seatTargetFor.get(host.hostname)!;
    if (seatCovered.has(target)) {
      refuse(refused, host, "push-covered", `a bigger host is already being pushed toward the stasis target at row ${target}`);
      continue;
    }
    if (assign(host, "seat", (chosen, calls) =>
      `${(chosen.maxRam ?? 0)}GB at depth ${chosen.depth ?? "unplaced"}, band covers the open`
      + ` stasis target at row ${target} — ~${calls} calls a roll`)) seatCovered.add(target);
  }
  // RACE the ferries too, biggest carrier first: a crossing is a uniform
  // re-roll into the band, so N carriers charging at once multiply the
  // per-wave chance of an actual landing — the same argument as the lab race,
  // and crossing an air gap is the trickiest hop of the whole conquest.
  const ferried = new Map<number, number>();
  for (const host of ferryPool) {
    const band = ferryBandFor.get(host.hostname)!;
    const label = `${band[0]}-${band[band.length - 1]}`;
    if ((ferried.get(band[0]!) ?? 0) >= (view.maxFerriesPerBand ?? Infinity)) {
      refuse(refused, host, "push-covered", `the ferry race into rows ${label} is already fully staffed`);
      continue;
    }
    if (assign(host, "ferry", (chosen, calls) =>
      `${(chosen.maxRam ?? 0)}GB with a resident riding, band crosses the air gap into unconquered`
      + ` rows ${label} — ~${calls} calls a roll`)) ferried.set(band[0]!, (ferried.get(band[0]!) ?? 0) + 1);
  }
  let frontierPushed = 0;
  for (const host of frontierPool) {
    if (frontierPushed >= (view.maxFrontierTargets ?? Infinity)) {
      refuse(refused, host, "push-covered", "the pass's frontier push budget is spent");
      continue;
    }
    if (assign(host, "frontier", (chosen, calls) =>
      `${(chosen.maxRam ?? 0)}GB at depth ${chosen.depth}, expected landing ${chosen.difficulty! + 1}`
      + ` — deeper on average; ~${calls} calls`)) frontierPushed++;
  }

  // An evictee left standing is a bottom-row host like any other.
  for (const host of evictPool) {
    if (pushes.some((entry) => entry.host === host.hostname)) continue;
    refuse(refused, host, "already-there", "already on the bottom row, so already connected to the labyrinth");
  }

  // OVERSCALE: a pusher whose pool outlived every target's wave hands the
  // surplus to its own push anyway. The overshoot past 100% is thrown away by
  // the reset, but every thread still pays charisma exp (5 x threads x
  // difficulty per call, granted before the clamp) — strictly better than
  // idle RAM. Never onto a held-closing target: extra threads there could
  // close the wave under the in-flight authenticate.
  for (const push of pushes) {
    const pool = pusherPool.get(push.from);
    if (pool === undefined || pool.threads < 1) continue;
    if (holdClosing.has(push.host)) continue;
    push.threads += pool.threads;
    pool.threads = 0;
  }
  return { pushes, refused };
}

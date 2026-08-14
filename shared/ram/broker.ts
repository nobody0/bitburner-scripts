import { roundSigFigs } from '../format.ts';
import { PRIORITY } from '../strategy/arbiter.ts';

export const STUB_BASE_GB = 1.6;
export const COLD_HOME_ARENA_GB = 4.1;
export const HANDOFF_HOME_RESERVE_GB = 3.6;
export const STARVATION_MS = 5_000;
/** Sentinel for "no planner pass observed yet". Real pass ids start at 1, so
 * the first observation is never mistaken for a repeat of this one. */
const NO_POOLING_PASS = 0;
/** Only run-defining irreversible work may discard an in-flight farm op. The
 * threshold is the arbiter's existing final-install freeze, not a second RAM-
 * specific priority scale. */
export const FARM_PREEMPTION_PRIORITY = PRIORITY['progression:install-freeze'];
const DEMAND_HALF_LIFE_MS = 10 * 60_000;
const POOLING_DEMOTION_OBSERVATIONS = 3;

export type DodgeLane = 'default' | 'long';
export type RequestClass = 'instant' | 'deferrable';

export interface BrokerRequest {
  by: string;
  id: string;
  /** Dynamic priceCalls cost; the broker adds STUB_BASE_GB itself. */
  gb: number;
  priority: number;
  lane: DodgeLane;
  class: RequestClass;
}

export interface BrokerHost {
  hostname: string;
  maxRam: number;
  freeGb: number;
  rooted: boolean;
  deployed: boolean;
}

export interface ArenaPlan {
  reserves: Record<string, number>;
  hosts: string[];
  /** Largest guaranteed contiguous executable block. */
  targetGb: number;
  arenaGb: number;
  guaranteedDynamicGb: number;
  promoted: boolean;
  measuredDynamicGb: number;
  farmCostPerSec: number;
}

export type BrokerDecision =
  | { status: 'placed'; host: string; request: BrokerRequest }
  | { status: 'queued'; request: BrokerRequest; enqueuedAt: number };

export interface WaitingRequest extends BrokerRequest {
  enqueuedAt: number;
  waitMs: number;
  starved: boolean;
}

export interface BrokerSnapshot {
  queueDepth: number;
  waits: WaitingRequest[];
  starvation: WaitingRequest[];
  largestWaitingGb: number;
  neededForLargestWaitingGb: number;
  demand: Record<string, number>;
}

export interface ReclaimableShareWorker {
  workerId: number;
  hostname: string;
  gb: number;
  stopping: boolean;
}

export interface PreemptibleFarmWorker {
  /** Process/worker id used by the game adapter. */
  workerId: number;
  /** In-flight dispatcher op. Absent for an idle pooled worker. */
  opId?: number;
  hostname: string;
  kind: 'hack' | 'grow' | 'weaken';
  segment: 'farm' | 'prep';
  gb: number;
  landing?: number;
  active: boolean;
}

export type ReclamationPlan =
  | {
      action: 'release-share';
      request: BrokerRequest;
      neededGb: number;
      shareWorkerIds: number[];
      shareGb: number;
      reason: 'share-first';
    }
  | {
      action: 'preempt';
      request: BrokerRequest;
      neededGb: number;
      shareWorkerIds: number[];
      shareGb: number;
      victim: PreemptibleFarmWorker;
      threshold: number;
      reason: 'priority-at-or-above-install-freeze';
    }
  | {
      action: 'wait';
      request: BrokerRequest;
      neededGb: number;
      threshold: number;
      reason: 'share-exit-pending' | 'priority-below-threshold' | 'no-single-victim-unblocks';
    };

interface Queued {
  request: BrokerRequest;
  enqueuedAt: number;
  sequence: number;
}

interface Demand {
  gb: number;
  at: number;
}

function key(request: Pick<BrokerRequest, 'by' | 'id' | 'lane'>): string {
  return `${request.by}\0${request.id}\0${request.lane}`;
}

function executableGb(request: BrokerRequest): number {
  return STUB_BASE_GB + request.gb;
}

/** Pure escalation ladder for one queued request. Share is evaluated first,
 * per host, because the dodge needs one contiguous executable block. */
export function planReclamation(
  request: BrokerRequest,
  hosts: readonly BrokerHost[],
  shareWorkers: readonly ReclaimableShareWorker[],
  farmWorkers: readonly PreemptibleFarmWorker[],
  now: number,
): ReclamationPlan {
  const neededGb = executableGb(request);
  const usable = hosts.filter((host) => host.rooted && host.deployed && host.maxRam >= neededGb);
  const sharesByHost = groupByHost(shareWorkers);

  let bestShare: ShareChoice | undefined;
  let pendingCouldPlace = false;
  for (const host of usable) {
    const shares = sharesByHost.get(host.hostname) ?? [];
    const pendingGb = shares.filter((worker) => worker.stopping).reduce((sum, worker) => sum + worker.gb, 0);
    const deficit = neededGb - host.freeGb - pendingGb;
    if (deficit <= 1e-9) {
      if (pendingGb > 0) pendingCouldPlace = true;
      continue;
    }
    const choice = chooseShareWorkers(shares.filter((worker) => !worker.stopping), deficit);
    if (choice && betterShareChoice(choice, bestShare)) bestShare = choice;
  }
  if (bestShare) {
    return {
      action: 'release-share',
      request,
      neededGb,
      shareWorkerIds: bestShare.workers.map((worker) => worker.workerId),
      shareGb: bestShare.gb,
      reason: 'share-first',
    };
  }
  if (pendingCouldPlace) {
    return { action: 'wait', request, neededGb, threshold: FARM_PREEMPTION_PRIORITY, reason: 'share-exit-pending' };
  }
  if (request.priority < FARM_PREEMPTION_PRIORITY) {
    return { action: 'wait', request, neededGb, threshold: FARM_PREEMPTION_PRIORITY, reason: 'priority-below-threshold' };
  }

  const candidates: { victim: PreemptibleFarmWorker; share: ShareChoice }[] = [];
  for (const victim of farmWorkers) {
    const host = usable.find((candidate) => candidate.hostname === victim.hostname);
    if (!host) continue;
    const shares = sharesByHost.get(host.hostname) ?? [];
    const pendingGb = shares.filter((worker) => worker.stopping).reduce((sum, worker) => sum + worker.gb, 0);
    const shareDeficit = Math.max(0, neededGb - host.freeGb - pendingGb - victim.gb);
    const share = shareDeficit <= 1e-9
      ? { workers: [], gb: 0 }
      : chooseShareWorkers(shares.filter((worker) => !worker.stopping), shareDeficit);
    if (share) candidates.push({ victim, share });
  }
  candidates.sort((a, b) => compareVictims(a.victim, b.victim, now)
    || a.share.gb - b.share.gb
    || a.share.workers.length - b.share.workers.length
    || a.victim.hostname.localeCompare(b.victim.hostname)
    || a.victim.workerId - b.victim.workerId);
  const selected = candidates[0];
  if (!selected) {
    return { action: 'wait', request, neededGb, threshold: FARM_PREEMPTION_PRIORITY, reason: 'no-single-victim-unblocks' };
  }
  return {
    action: 'preempt',
    request,
    neededGb,
    shareWorkerIds: selected.share.workers.map((worker) => worker.workerId),
    shareGb: selected.share.gb,
    victim: selected.victim,
    threshold: FARM_PREEMPTION_PRIORITY,
    reason: 'priority-at-or-above-install-freeze',
  };
}

interface ShareChoice {
  workers: ReclaimableShareWorker[];
  gb: number;
}

function groupByHost(workers: readonly ReclaimableShareWorker[]): Map<string, ReclaimableShareWorker[]> {
  const grouped = new Map<string, ReclaimableShareWorker[]>();
  for (const worker of workers) {
    const group = grouped.get(worker.hostname) ?? [];
    group.push(worker);
    grouped.set(worker.hostname, group);
  }
  return grouped;
}

/** Select the smallest sufficient host-local share set, then remove any
 * redundant block instead of stopping every share worker. */
function chooseShareWorkers(workers: readonly ReclaimableShareWorker[], deficit: number): ShareChoice | undefined {
  const ordered = [...workers].sort((a, b) => a.gb - b.gb || a.workerId - b.workerId);
  const single = ordered.find((worker) => worker.gb + 1e-9 >= deficit);
  let selected: ReclaimableShareWorker[] = single ? [single] : [];
  let gb = single?.gb ?? Infinity;
  const accumulated: ReclaimableShareWorker[] = [];
  let accumulatedGb = 0;
  for (const worker of ordered) {
    accumulated.push(worker);
    accumulatedGb += worker.gb;
    if (accumulatedGb + 1e-9 < deficit) continue;
    if (accumulatedGb < gb - 1e-9) {
      selected = accumulated;
      gb = accumulatedGb;
    }
    break;
  }
  if (!Number.isFinite(gb)) return undefined;
  for (let index = selected.length - 1; index >= 0; index--) {
    const worker = selected[index]!;
    if (gb - worker.gb + 1e-9 < deficit) continue;
    selected.splice(index, 1);
    gb -= worker.gb;
  }
  return { workers: selected, gb };
}

function betterShareChoice(choice: ShareChoice, incumbent: ShareChoice | undefined): boolean {
  return incumbent === undefined
    || choice.gb < incumbent.gb - 1e-9
    || (Math.abs(choice.gb - incumbent.gb) <= 1e-9 && choice.workers.length < incumbent.workers.length)
    || (Math.abs(choice.gb - incumbent.gb) <= 1e-9
      && choice.workers.length === incumbent.workers.length
      && choice.workers.map((worker) => worker.workerId).join(',') < incumbent.workers.map((worker) => worker.workerId).join(','));
}

/** Fewest discarded ops first (idle pooled worker = zero), then support ops
 * before the money-carrying hack. Within a class, a later landing has less
 * elapsed in-flight value; only then do we minimize released RAM. */
function compareVictims(a: PreemptibleFarmWorker, b: PreemptibleFarmWorker, now: number): number {
  const active = Number(a.active) - Number(b.active);
  if (active !== 0) return active;
  const value = Number(a.kind === 'hack') - Number(b.kind === 'hack');
  if (value !== 0) return value;
  const aRemaining = a.landing === undefined ? Infinity : Math.max(0, a.landing - now);
  const bRemaining = b.landing === undefined ? Infinity : Math.max(0, b.landing - now);
  if (aRemaining !== bRemaining) return bRemaining - aRemaining;
  return a.gb - b.gb;
}

/** Pure owner of dodge placement, measured demand, and queue ordering. It
 * never leases RAM itself: the game adapter commits each returned placement
 * to the shared Heap, while tests and the simulator exercise plain values. */
export class RamBroker {
  #queue = new Map<string, Queued>();
  #demand = new Map<string, Demand>();
  #sequence = 0;
  #promoted = false;
  #poolingMisses = 0;
  #poolingPass = NO_POOLING_PASS;

  /** Demotion hysteresis counts PLANNER PASSES, not readings.
   *
   * `dispatch.pooling` is recomputed once per `planFarm` (reset at the top,
   * OR-ed per farm segment), and the controller reads that one value several
   * times per tick — the sweep's gate arena, the probe arena and the feature
   * pass all sample it with no pump in between. Counting those as independent
   * observations spent the whole three-pass window inside a single tick, so
   * the first non-pooling pass demoted immediately and the `foodnstuff`
   * reserve flapped at tick cadence. `pass` is the pump counter, so repeat
   * reads of one pass are ignored and the window means what it says. */
  observePooling(pooling: boolean, pass: number): void {
    if (pass === this.#poolingPass) return;
    this.#poolingPass = pass;
    if (pooling) {
      this.#promoted = true;
      this.#poolingMisses = 0;
      return;
    }
    if (!this.#promoted) return;
    this.#poolingMisses++;
    if (this.#poolingMisses >= POOLING_DEMOTION_OBSERVATIONS) {
      this.#promoted = false;
      this.#poolingMisses = 0;
    }
  }

  /** Build the arena ladder: a guaranteed floor, plus growth that is
   * DEMAND-PROVEN rather than speculative.
   *
   * The floor is the bootstrap ladder — home while nothing else is rooted,
   * then n00dles (always rootable: 0 ports, skill 1), then foodnstuff once
   * pooling means workers stop dying and their RAM stops coming back.
   *
   * Growth above the floor keys off ACTUAL starvation, not measured demand.
   * Sizing the arena to the largest recent request instead reserved a whole
   * extra host during bootstrap — where income is 0, so no ROI test could
   * veto it — taxing the batcher exactly while it was trying to compound.
   * Growing only for a request that has genuinely waited past STARVATION_MS
   * preserves farm capacity while retaining the feedback loop the old
   * demand-driven fleet reserve provided. That loop is not
   * optional: once pooling keeps workers alive, transient blocks stop
   * appearing, and a large deferrable dodge (contracts 10 GB, graft 7.5 GB,
   * destroyW0r1dD43m0n 32 GB) would otherwise queue forever with nothing
   * able to open room for it. */
  arena(hosts: readonly BrokerHost[], now: number, moneyPerSecPerGb: number): ArenaPlan {
    const usable = hosts.filter((host) => host.rooted && host.deployed && host.maxRam > 0);
    const byName = new Map(usable.map((host) => [host.hostname, host]));
    const reserves: Record<string, number> = {};

    const home = byName.get('home');
    const noodles = byName.get('n00dles');
    if (noodles) {
      reserves[noodles.hostname] = noodles.maxRam;
      // A build handoff briefly needs two 3.6 GB start.js instances. Keeping
      // that much farm-free makes the successor launch deterministic instead
      // of hoping a home worker happens to finish between 200 ms retries.
      if (home) reserves.home = Math.min(home.maxRam, HANDOFF_HOME_RESERVE_GB);
    } else if (home) {
      reserves.home = Math.min(home.maxRam, COLD_HOME_ARENA_GB);
    }

    if (this.#promoted) {
      const food = byName.get('foodnstuff');
      if (food) reserves[food.hostname] = food.maxRam;
    }

    const measuredDynamicGb = this.largestMeasured(now);
    let guaranteed = Math.max(0, ...Object.values(reserves));

    // Smallest host that fits, matching the old placement policy: carving the
    // reserve out of the biggest host shrinks the largest contiguous block
    // every hack solve depends on.
    const starvedGb = this.starvedExecutableGb(now);
    if (starvedGb > guaranteed) {
      const candidate = usable
        .filter((host) => host.maxRam >= starvedGb)
        .sort((a, b) => a.maxRam - b.maxRam || a.hostname.localeCompare(b.hostname))[0];
      if (candidate) {
        reserves[candidate.hostname] = Math.max(reserves[candidate.hostname] ?? 0, starvedGb);
        guaranteed = Math.max(guaranteed, starvedGb);
      }
    }

    const arenaGb = Object.values(reserves).reduce((sum, gb) => sum + gb, 0);
    return {
      reserves,
      hosts: Object.keys(reserves).sort(),
      targetGb: guaranteed,
      arenaGb,
      guaranteedDynamicGb: Math.max(0, guaranteed - STUB_BASE_GB),
      promoted: this.#promoted,
      measuredDynamicGb,
      farmCostPerSec: Math.max(0, moneyPerSecPerGb) * arenaGb,
    };
  }

  /** Executable footprint of the largest request that has ACTUALLY starved.
   * Zero while nothing is starving, so the arena collapses back to its floor
   * and the batcher gets the RAM back as soon as the pressure ends. */
  starvedExecutableGb(now: number): number {
    let largest = 0;
    for (const queued of this.#queue.values()) {
      if (now - queued.enqueuedAt < STARVATION_MS) continue;
      largest = Math.max(largest, executableGb(queued.request));
    }
    return largest;
  }

  classify(gb: number, arena: ArenaPlan): RequestClass {
    return gb <= arena.guaranteedDynamicGb ? 'instant' : 'deferrable';
  }

  request(request: BrokerRequest, hosts: readonly BrokerHost[], arena: ArenaPlan, now: number): BrokerDecision {
    this.#measure(request, now);
    const existing = this.#queue.get(key(request));
    if (existing) {
      existing.request = request;
      return { status: 'queued', request, enqueuedAt: existing.enqueuedAt };
    }
    const host = chooseHost(hosts, arena, executableGb(request), request.lane);
    if (host) return { status: 'placed', host, request };
    return this.enqueue(request, now);
  }

  enqueue(request: BrokerRequest, now: number): Extract<BrokerDecision, { status: 'queued' }> {
    this.#measure(request, now);
    const requestKey = key(request);
    const existing = this.#queue.get(requestKey);
    if (existing) {
      existing.request = request;
      return { status: 'queued', request, enqueuedAt: existing.enqueuedAt };
    }
    const queued = { request, enqueuedAt: now, sequence: this.#sequence++ };
    this.#queue.set(requestKey, queued);
    return { status: 'queued', request, enqueuedAt: now };
  }

  drain(hosts: readonly BrokerHost[], arena: ArenaPlan, now: number): Extract<BrokerDecision, { status: 'placed' }>[] {
    const free = hosts.map((host) => ({ ...host }));
    const ordered = [...this.#queue.values()].sort(
      (a, b) => b.request.priority - a.request.priority || a.enqueuedAt - b.enqueuedAt || a.sequence - b.sequence,
    );
    const placed: Extract<BrokerDecision, { status: 'placed' }>[] = [];
    const lanes = new Set<DodgeLane>();
    for (const queued of ordered) {
      if (lanes.has(queued.request.lane)) continue;
      const host = chooseHost(free, arena, executableGb(queued.request), queued.request.lane);
      if (!host) continue;
      const entry = free.find((candidate) => candidate.hostname === host)!;
      entry.freeGb -= executableGb(queued.request);
      this.#queue.delete(key(queued.request));
      this.#measure(queued.request, now);
      lanes.add(queued.request.lane);
      placed.push({ status: 'placed', host, request: queued.request });
    }
    return placed;
  }

  snapshot(now: number): BrokerSnapshot {
    const waits = [...this.#queue.values()]
      .sort((a, b) => b.request.priority - a.request.priority || a.enqueuedAt - b.enqueuedAt || a.sequence - b.sequence)
      .map(({ request, enqueuedAt }) => {
        const waitMs = Math.max(0, now - enqueuedAt);
        return { ...request, enqueuedAt, waitMs, starved: waitMs >= STARVATION_MS };
      });
    const starvation = waits.filter((request) => request.starved);
    const largestWaitingGb = waits.reduce((largest, request) => Math.max(largest, request.gb), 0);
    const demand: Record<string, number> = {};
    for (const [requester, measured] of this.#demand) {
      const value = decayed(measured, now);
      if (value >= 0.01) demand[requester] = roundSigFigs(value, 3);
    }
    return {
      queueDepth: waits.length,
      waits,
      starvation,
      largestWaitingGb,
      neededForLargestWaitingGb: largestWaitingGb > 0 ? largestWaitingGb + STUB_BASE_GB : 0,
      demand,
    };
  }

  largestMeasured(now: number): number {
    let largest = 0;
    for (const measured of this.#demand.values()) largest = Math.max(largest, decayed(measured, now));
    return largest;
  }

  #measure(request: BrokerRequest, now: number): void {
    const requestKey = key(request);
    const previous = this.#demand.get(requestKey);
    this.#demand.set(requestKey, { gb: Math.max(request.gb, previous ? decayed(previous, now) : 0), at: now });
  }
}

function decayed(demand: Demand, now: number): number {
  const age = Math.max(0, now - demand.at);
  return demand.gb * 2 ** (-age / DEMAND_HALF_LIFE_MS);
}

function chooseHost(
  hosts: readonly BrokerHost[],
  arena: ArenaPlan,
  neededGb: number,
  lane: DodgeLane,
): string | undefined {
  const arenaSet = new Set(arena.hosts);
  const candidates = hosts.filter((host) => host.rooted && host.deployed && host.freeGb >= neededGb);
  // The long Go lane may overlap the controller/default lane. Keep it off
  // home unconditionally, so it cannot consume the direct sweep's home floor
  // while that independent lane is entering its stub; it queues when the
  // fleet has no suitable block.
  const nonHome = lane === 'long' ? candidates.filter((host) => host.hostname !== 'home') : [];
  const laneCandidates = lane === 'long' ? nonHome : candidates;
  const compare = (a: BrokerHost, b: BrokerHost): number => a.freeGb - b.freeGb || a.hostname.localeCompare(b.hostname);
  return laneCandidates.filter((host) => arenaSet.has(host.hostname)).sort(compare)[0]?.hostname
    ?? laneCandidates.filter((host) => !arenaSet.has(host.hostname)).sort(compare)[0]?.hostname;
}

/** Hacking feature — the network farm. Problem: maximise $/sec/GB across the
 * rooted fleet by choosing a target, holding it at min security / max money,
 * and spending every free gigabyte on it. */

/** Per-kind figures, in the order the ops run. */
export interface FarmByKind {
  hack: number;
  grow: number;
  weaken: number;
}

/** One ACTIVE pipeline the dispatcher is running.
 *
 * Deliberately an array rather than the historical `target` / `prepTarget`
 * pair. Those two scalars encode an assumption the dispatcher has already
 * outgrown — that there is exactly one farm and exactly one prep, each with a
 * fixed shape — and every new pipeline (a secondary prep, a second farm) would
 * otherwise need both a new field here and a new hardcoded panel in the
 * viewer. A pipeline describes itself instead: what it is, what it is running,
 * and how far along it is. */
export interface FarmPipeline {
  host: string;
  /** What this pipeline is FOR. Open-ended on purpose. */
  role: "farm" | "prep";
  /** The scheduling shape actually in use — hwgw, hgw, shotgun for a farm;
   * absent for a prep wave, which has no repeating cycle. */
  mode?: string;
  /** RAM segment funding it, and the GB that segment holds right now. */
  segment: string;
  gb: number;
  inFlight: FarmByKind;
  /** Vitals for the progress meters, from the sweep snapshot. */
  money?: number;
  moneyMax?: number;
  security?: number;
  minSecurity?: number;
  /** The cycle solve's chosen thread counts (farm only). The ratio the farm
   * is AIMING at, so the observed allocation has something to be wrong
   * against. Weaken is the sum of both weaken roles. */
  planThreads?: FarmByKind;
  moneyPerSecPerGb?: number;
  /** Op durations at the current skill, so the panel can say how long a batch
   * takes without recomputing the formulas against a stale player record. */
  hackTimeMs?: number;
  weakenTimeMs?: number;
  /** Prep only: when this host becomes farmable.
   *
   * `seconds` is the estimate, `bound` says which constraint set it — a prep
   * with infinite RAM still takes one weaken ("latency"), while a starved one
   * is waiting on GB ("ram"). Those are different problems and the fix for
   * one does nothing for the other. */
  eta?: {
    seconds: number;
    bound: "latency" | "ram";
    prepped: boolean;
    /** Fraction of the prep's RAM·seconds already spent. */
    progress?: number;
  };
}

/** Work done by one class of batch, summed over the run.
 *
 * A batch is the unit the farm actually reasons in — a HWGW cycle, an HGW
 * cycle, a shotgun cycle, a prep wave — and they are not interchangeable: a
 * prep wave is a hundred grow threads that steal nothing, a farm cycle is
 * four ops that do. Adding their op counts together yields a number that
 * describes neither, which is what a global counter had been doing.
 *
 * Cumulative, like every other counter here, so the viewer differentiates for
 * a rate rather than the rollup guessing at a window. */
export interface BatchAggregateReport {
  batches: number;
  ops: number;
  landed: number;
  threads: FarmByKind;
  /** One-core GB committed across every op of every batch of this kind. */
  gb: number;
  moneyEarned: number;
  hacks: number;
  /** Summed start-to-settle spans; divide by `batches` for a mean duration. */
  spanMs: number;
  /** Batches that had a landing grid at all, and so could be graded. A kind
   * that mis-ordered every batch reads `inOrder: 0` exactly like a kind that
   * never lands on a grid; this separates them. */
  graded?: number;
  /** Batches whose effects landed in the planned order. Only a batch with a
   * landing grid contributes — a prep wave has no intended internal order. */
  inOrder: number;
  /** Batches that settled having never launched a hack. */
  noHack: number;
  /** Batches EVICTED without ever settling, and the work they took with them.
   *
   * Where op loss actually shows up. A batch settles only once its last op
   * arrives, so a settled batch has `landed === ops` by construction — which is
   * why the old "settled with fewer landings" counter could never fire, and why
   * `launched` against `landed` per kind was two copies of one curve. A batch
   * that loses an op never settles and is evicted instead; that eviction is now
   * counted here.
   *
   * `abandonedOps - abandonedLanded` is the ops paid for that never arrived.
   *
   * Optional because runs recorded before this existed have no value for it,
   * and zero would assert a healthy farm rather than an unmeasured one. */
  abandoned?: number;
  abandonedOps?: number;
  abandonedLanded?: number;
}

/** One settled batch, kept as an example. The aggregates say whether the farm
 * is healthy; these say which batch was not. */
export interface SettledBatchReport {
  id: number;
  kind: string;
  target: string;
  at: number;
  spanMs: number;
  ops: number;
  landed: number;
  threads: FarmByKind;
  gb: number;
  moneyEarned: number;
  order?: string;
  planned?: string;
}

/** 1 Hz dispatcher rollup — the ONLY steady-state farm telemetry (per-op
 * events would be ~3/16ms at scale and are never emitted; transitions get
 * their own rare events). Optional fields fill in as the dispatcher lands. */
export interface FarmRollup {
  target?: string;
  /** Whether the target's integer batch solve exhausted its whole domain. */
  targetSolveExact?: boolean;
  /** Current target's expected $/sec/GB, used to price added fleet RAM. */
  moneyPerSecPerGb?: number;
  /** The same $/sec/GB with the stock-manipulation term removed — what a
   * money PURCHASE may be priced from when the live solve is absent. The
   * blended score above stays correct for RAM allocation (allocating consumes
   * no capital), but a purchase priced with capital-coupled manipulation
   * income double-counts the bankroll it would spend. */
  moneyPerSecPerGbCapitalIndependent?: number;
  prepTarget?: string;
  /** Current demand-driven reservation for the executable prep wave. */
  prepBudgetGb?: number;
  segOrder?: string[];
  /** Every pipeline currently running. Supersedes `target`/`prepTarget` for
   * display; those stay because goal evaluation and the infrastructure
   * valuation read them. */
  pipelines?: FarmPipeline[];
  /** Farm scheduling mode (hwgw | hgw | shotgun). */
  mode?: string;
  inFlight?: { hack: number; grow: number; weaken: number };
  launched?: { hack: number; grow: number; weaken: number };
  landed?: { hack: number; grow: number; weaken: number };
  /** EMAs of what the farm has REALIZED. Lagging by construction: a farm whose
   *  first batch has not landed has earned nothing and is still about to be the
   *  best producer in the run. */
  moneyRate?: number;
  expRate?: number;
  /** What the COMMITTED solution will produce once it lands, at the RAM the
   *  farm segment actually holds. This is what other features are priced
   *  against — see `game/lib/income.ts#announcedRates`. */
  predicted?: { moneyPerSec: number; expPerSec: number };
  security?: number;
  minSecurity?: number;
  money?: number;
  moneyMax?: number;
  ramPie?: { farm: number; prep: number; charge?: number; share: number; free: number; reserve: number };
  allocFails?: number;
  allocFailsByPhase?: { jit: number; prep: number; eager: number };
  /** Fresh processes started (one-shots + pool spawns). Pooling keeps this
   * flat while `launched` climbs — the browser-RAM churn figure. */
  execs?: number;
  /** Resident serve-mode processes. Jobs can outnumber these over time; that
   * gap is the process-churn reduction pooling exists to create. */
  pool?: { workers: number; busy: number };
  /** Existing dispatch pressure signal consumed by RAM-arena promotion. */
  pooling?: boolean;
  /** Ops launched with a `{stock:true}` influence flag — the observable link
   * between manipulation intent and nudges actually rolled. */
  stockOps?: number;
  /** The current farm target's pipeline demand ceiling in GB (one batch per
   * interval for one weakenTime). Infrastructure valuation reads it so RAM
   * beyond saturation prices at its true ~0 marginal income. */
  depthCapGb?: number;
  /** Change-filtered, sig3 evidence behind the marginal share cutover. */
  shareDecision?: {
    threads: number;
    bonus: number;
    cutoverGb: number;
    allotmentGb: number;
    hackMarginal: number;
    shareMarginal: number;
    /** Share is running on the free tail because the ACTIVE work earns
     * faction rep, independent of the route pricing rep as critical. */
    freeTail?: boolean;
  };
  /** Current one-shot Stanek charge decision and live occupancy. */
  chargeDecision?: {
    fragmentId: number;
    threads: number;
    allotmentGb: number;
    valueSeconds: number;
    opportunitySeconds: number;
  };
  /** additionalMsec actually carried by launched ops: mean and worst. The
   * launch guard should be tuned down until `maxMs` nears it and misses start,
   * since every padded millisecond is RAM held doing no native work. */
  padding?: { meanMs: number; maxMs: number };
  /** Observed minus planned landing time, in ms, signed. The measurement that
   * makes the landing grid falsifiable in the live game rather than only in the
   * simulator: `maxAbsMs` above one landing gap means effects are reordering,
   * and a mean far from zero means the duration model is biased. */
  landingError?: { meanMs: number; minMs: number; maxMs: number; maxAbsMs: number };
  /** The same distribution per op kind. A correction has to act at this
   * granularity: a systematically late hack reorders a batch against its own
   * cover, a late weaken only over-covers, and the aggregate cannot tell those
   * apart. Only present for kinds that have actually landed. */
  landingErrorByKind?: Partial<Record<"hack" | "grow" | "weaken", {
    meanMs: number;
    minMs: number;
    maxMs: number;
    maxAbsMs: number;
  }>>;
  execFails?: number;
  /** Launch lateness past startAt by JIT role — names the delayed role behind
   * mis-ordered landings directly. */
  launchLate?: Partial<Record<"h" | "w1" | "g" | "w2",
    { n: number; meanMs: number; maxMs: number; overWindow: number }>>;
  /** Launches deferred by a full role quota, keyed phase:role. */
  quotaSkips?: Record<string, number>;
  batchesSkipped?: number;
  /** `batchesSkipped` split by cause, so the scalar can be read as the several
   * distinct phenomena it pools. Same keys as `missedWindow`, different
   * question: these count skips (parts sum to the whole), that one counts
   * batches that missed (deduped per batch). */
  batchesSkippedBy?: {
    deadline: number;
    "arrival-security": number;
    "arrival-money": number;
    placement: number;
  };
  /** Completions from workers this dispatcher never launched — processes that
   * outlived an install or a reload. Excluded from `landed` so that counter
   * stays comparable with `launched`; reported because their RAM is being
   * paid for by a controller that cannot steer them. */
  orphanLandings?: number;
  /** Cumulative cause-labelled outcomes. Rounded to three significant digits
   * at publication so a high-volume run does not churn the change filter. */
  missedWindow?: {
    deadline: number;
    "arrival-security": number;
    "arrival-money": number;
    placement: number;
  };
  /** Did each batch's effects land in the order the cycle planned?
   *
   * Landings run at roughly one per 20 ms at scale, so the per-op event that
   * would answer this directly is exactly the thing telemetry may not send.
   * The question survives aggregation intact: each batch reduces to ONE
   * signature (the order its roles landed in), and a healthy run is a single
   * signature with a large count. A reorder — the `h-h-g-w2` case, two hacks
   * landing before their cover — appears as a second key, with examples. */
  landingOrder?: {
    /** COMPLETE hack-bearing batches verified. */
    batches: number;
    /** Batches whose observed signature matched that batch's own plan. */
    inOrder: number;
    /** Batches that landed having never launched a hack — support paid for
     * with nothing stolen. Kept out of `observed` so it cannot dilute the
     * "landed as planned" share; it is a different, costlier failure. */
    incomplete?: number;
    /** Planned/observed pairs. Plans remain attached to the batches that used
     * them, so a legitimate split weaken is not compared with a later shape. */
    patterns: { planned: string; observed: string; batches: number }[];
    otherBatches?: number;
    /** The most recent mis-ordered batches, for inspection. Bounded, and
     * naturally small — an anomaly rate high enough to fill it is itself the
     * finding. */
    anomalies: { at: number; observed: string; planned: string; target: string }[];
  };
  /** Per-batch work, keyed by batch kind (hwgw | hgw | shotgun | prep).
   *
   * Every launch group carries a batch id and every completion is attributed
   * back to it through the `opId` it already echoes — so nothing was added to
   * the worker protocol to make this possible. What arrives here is the sum,
   * because a record per batch is no more sendable than a record per op. */
  batches?: Record<string, BatchAggregateReport>;
  /** The most recently settled batches, newest last. Bounded and small. */
  recentBatches?: SettledBatchReport[];
  /** Launched threads and the one-core-equivalent effect they bought, split by
   * segment and kind. The RATIO between the three kinds is the farm's
   * allocation; the ratio between effect and raw threads is what the cores
   * are worth. Cumulative, so the viewer differentiates for a rate. */
  allocation?: {
    threads: Record<string, FarmByKind>;
    effectThreads: Record<string, FarmByKind>;
  };
  ramWork?: {
    /** Cumulative scheduled work; padding is deliberately separate because
     * every GB·ms held by additionalMsec is idle, not native HGW work. */
    nativeGbMs: number;
    paddingGbMs: number;
    nativeGbMsByKind: { hack: number; grow: number; weaken: number };
    paddingGbMsByKind: { hack: number; grow: number; weaken: number };
    nativeGbMsBySegment: { farm: number; prep: number; charge?: number; share: number };
    paddingGbMsBySegment: { farm: number; prep: number; charge?: number; share: number };
    /** The cross product. `nativeGbMsByKind` folds a prep wave's grows in with
     * the farm's, which is precisely when the farm's own split matters most. */
    nativeGbMsBySegmentKind?: Record<string, FarmByKind>;
    paddingGbMsBySegmentKind?: Record<string, FarmByKind>;
  };
  pumpMaxMs?: number;
  /** Planner ms per ms of wall clock over the rollup window.
   *
   * The reading whose absence let a planner at ~100% occupancy pass for
   * healthy: `pumpMaxMs` alone cannot distinguish one expensive pass from a
   * thread that has been taken over. Past a fifth of wall time the game's own
   * setTimeout engine and every in-flight `netscriptDelay` start missing their
   * deadlines; a healthy run sits near 5%. */
  pumpOccupancy?: number;
  /** Per-pass cost over the same window. `maxMs` repeats `pumpMaxMs`, which
   * stays where it is so records written before this field still compare. */
  pumpMs?: { meanMs: number; maxMs: number; count: number };
  /** Cumulative early pumps triggered by worker completions (the
   * weaken-landing wake) rather than the 200 ms tick. */
  wakePumps?: number;
  /** `wakePumps` as a per-second rate over the window — the cumulative counter
   * has been published since the wake path existed and rendered nowhere. */
  wakePumpRate?: number;
  /** Wake pumps refused, by which throttle refused them. */
  wakePumpsSkipped?: { gap: number; frame: number };
  /** Minimum-security weaken windows that bypassed both throttles. */
  weakenWindow?: { pumps: number };
  /** How late the controller's own timer reached its absolute deadline. The
   * engine cycle rides the same timer queue, so this is the ground truth for
   * main-thread starvation — and it leads `landingError` by a weaken-time. */
  engineLatenessMs?: { meanMs: number; maxMs: number };
  /** In-flight depth: the independent variable of the planner's cost curve. */
  ledger?: { tracked: number; pendingBatches: number; pendingOps: number; onTarget: number };
  /** Cumulative — goal evaluation reads these (replaces per-op hack.done). */
  totals: { moneyEarned: number; hacks: number };
}

/** Fleet capacity and script income. Cheap enough to sample every sweep;
 * complements `servers` (which carries per-host detail) with the aggregates
 * the Hacking tab shows as tiles. */
export interface FleetRollup {
  /** Rooted, non-purchased hosts with RAM. */
  rootedHosts: number;
  totalHosts: number;
  maxRam: number;
  usedRam: number;
  /** Purchased ("cloud") servers. count/totalRam come from the sweep snapshot;
   *  limit and maxRamPerServer need ns.cloud and fill in when it is probed. */
  purchased: { count: number; totalRam: number; limit?: number; maxRamPerServer?: number };
  /** Port-opener programs owned, inferred from the highest `openPortCount`
   *  seen on the network — a lower bound until the first rooting sweep, exact
   *  after it. Free, unlike asking the game for home's file list. */
  portOpeners?: number;
  /** Positive evidence that TOR is owned. Absent means unknown, never false. */
  hasTor?: boolean;
  /** Economic value of the next port opener, refreshed from the real target
   * solver. Null explicitly clears a plan after the observed world changes. */
  openerPlan?: {
    program: string;
    targetOpeners: number;
    cost: number;
    addedMoneyPerSec: number;
    addedHackingExpPerSec: number;
  } | null;
  home: { maxRam: number; usedRam: number; cores: number };
  /** Singularity quote; absent when home upgrades are not scriptable. */
  homeRamUpgradeCost?: number;
  homeCoreUpgradeCost?: number;
  /** Authoritative one-step cloud quotes. Hacknet servers are player-owned
   * but deliberately absent: they have their own upgrade economy. */
  infrastructureOptions?: {
    kind: "buyServer" | "upgradeServer";
    cost: number;
    addedRam: number;
    host?: string;
    targetRam: number;
  }[];
  homeRamPlan?: {
    cost: number;
    addedRam: number;
    incomePerSec: number;
    paybackSec: number;
    netOverHorizon: number;
    worthBuying: boolean;
    lastResult?: { ok: boolean; detail: string; at: number };
  };
  infrastructurePlan?: {
    /** Inputs captured with the decision, so an offline analysis does not
     * have to time-join independently sampled player/farm topics. */
    evaluatedAt: number;
    horizonSec: number;
    moneyAvailable: number;
    moneyGranted: number;
    incomePerSecPerGb: number;
    reinvestmentReturnPerDollarSec?: number;
    buy?: { kind: string; cost: number; host?: string; targetRam?: number };
    /** True candidate count; `ranked` is a bounded display/telemetry digest. */
    rankedTotal: number;
    ranked: {
      kind: string;
      host?: string;
      targetRam?: number;
      addedRam: number;
      cost: number;
      incomePerSec: number;
      returnPerDollarSec: number;
      paybackSec: number;
      netOverHorizon: number;
      worthBuying: boolean;
      selected: boolean;
    }[];
    lastResult?: { action: string; ok: boolean; detail: string; at: number };
  };
  /** ns.getTotalScriptIncome() -> [current live-script $/sec, $/sec since aug install]. */
  scriptIncome?: [number, number];
  scriptExpGain?: number;
  sharePower?: number;
}

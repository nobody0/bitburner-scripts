import type { Player, Server } from "@ns";
import { unknownCapabilities, type Capabilities } from "../../shared/features/unlock.ts";
import type { DebugRecord, EventRecord, LogRecord } from "../../shared/telemetry/schema.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";
import type { ContractFailure } from "../../shared/telemetry/topics/side.ts";
import type { FarmRollup, SettledBatchReport } from "../../shared/telemetry/topics/hacking.ts";
import type { ExperimentIdentity } from "../../shared/experiment.ts";

/** The viewer's projection of a record stream.
 *
 * Deliberately separate from shared/goals/evaluate.ts (spec/telemetry.md): the
 * goal reducer keeps only what a predicate needs, while the UI retains raw
 * server fields, the event feed and every feature topic. Same stream, two
 * consumers with different retention.
 *
 * The fold is INCREMENTAL. A live run streams for hours, and re-folding every
 * record on every frame is O(run length) per animation frame — which is what
 * made the viewer degrade the longer it was left open. `appendRecords` folds
 * only what has arrived since the last call; the whole-history `project` path
 * survives for replay scrubbing, where the cutoff genuinely moves backwards. */

export type Topics = { [K in StateKey]?: StateMap[K] };

export interface SimRunMeta {
  goal?: string;
  label?: string;
  seed?: number;
  driver?: string;
  scenario?: string;
  scenarioFingerprint?: string;
  experiment?: ExperimentIdentity;
  bitnode?: number;
  features?: string;
  profile?: string;
  save?: string;
}

export interface SimRunResult {
  reached?: boolean;
  timeToGoalMs?: number;
  stoppedBecause?: string;
  validity?: "valid" | "partial" | "invalid-for-goal";
  scenario?: string;
  engineCycles?: number;
  unmodeled?: Record<string, number>;
  crashes?: { pid: number; filename: string; error: string }[];
}

/** Discrete records retained for the event feed. The feed shows the last 200;
 * keeping an unbounded array of everything a 12-hour run emitted just to slice
 * the tail off it is how a viewer tab reaches a gigabyte. */
export const EVENT_RING = 500;

/** Points retained for the money chart. The canvas is ~1200 px wide and is
 * redrawn on every hover, so anything past a couple of thousand points costs
 * time without being visible. Downsampling keeps the extremes, so a spike is
 * never smoothed away. */
export const SERIES_LIMIT = 2_000;

/** One curve per op kind, plotted together. */
export interface OpKindSeries {
  hack: [number, number][];
  grow: [number, number][];
  weaken: [number, number][];
}

/** The cumulative figures one rollup carried, kept to difference the next. */
export interface FarmSample {
  t: number;
  /** Global op counters. Nothing is plotted from these any more — the panel
   * reads launched against landed per BATCH KIND — but they are the most
   * reliably present monotonic counter the dispatcher sends, so they stay as
   * the sentinel that detects a reset. */
  launched: { hack: number; grow: number; weaken: number };
  landed: { hack: number; grow: number; weaken: number };
  threads: { hack: number; grow: number; weaken: number };
  /** Per batch KIND, from `FarmRollup.batches`. Cumulative like the rest, and
   * carried on the SAME ring so it inherits the reset detection and the
   * window baseline rather than needing a second copy of both. */
  byKind: Record<string, BatchCounters>;
}

/** The four cumulative figures a batch kind's series are built from. */
export interface BatchCounters {
  batches: number;
  /** Ops LAUNCHED by settled batches of this kind. */
  ops: number;
  landed: number;
  moneyEarned: number;
}

/** One batch kind's curves.
 *
 * The launched/landed pair is deliberately a RUNNING TOTAL rather than the
 * rate its op-counter equivalent uses. The quantity being watched is the BAND
 * between the two — ops that were dispatched and never arrived — and
 * differentiating both curves is precisely the operation that destroys it: two
 * rates that differ by a hundredth are indistinguishable, while two totals that
 * differ by a hundred separate visibly and stay separated. */
export interface BatchKindSeries {
  launched: [number, number][];
  landed: [number, number][];
  /** Batches SETTLED per second, over `farmWindowMs`. A rate belongs here and
   * not on the op counters: a batch is a discrete completion, so its rate is a
   * throughput, where an op backlog is a level. */
  perSec: [number, number][];
  /** Mean money one batch of this kind earned across the window. Says whether
   * the target is drying out, which a batch count alone never shows. */
  moneyPerBatch: [number, number][];
}

export interface ProjectedState {
  runId: string | null;
  src: "game" | "sim" | null;
  live: boolean;
  t0: number | null;
  lastT: number;
  player: Player | null;
  servers: Map<string, Server>;
  topics: Topics;
  caps: Capabilities;
  /** State records are folded into `topics`; only the discrete records reach
   *  the feed, so this is never a StateRecord. */
  events: (EventRecord | DebugRecord)[];
  /** Latest full contract replay. Held separately from the bounded event feed
   * so ordinary debug traffic cannot evict the actionable failure details. */
  contractReplay: ContractFailure | null;
  /** Run-level simulator records must outlive the bounded event feed. */
  simMeta: SimRunMeta | null;
  simResult: SimRunResult | null;
  simGapDetails: Map<string, { kind: string; name: string; detail?: string }>;
  /** Money earned by hacking and successful hack count. */
  earned: number;
  hacks: number;
  /** True when totals come from a `farm` rollup rather than hack.done events.
   *  When neither source is present the tiles show "–" instead of a wrong 0. */
  hasTotals: boolean;
  moneySeries: [number, number][];
  /** The install-cadence decision over time, from progression state records:
   *  accrued reset value vs the renewal threshold it must clear. Two series
   *  because they cross — the crossing IS the install decision. */
  cadenceAccrued: [number, number][];
  cadenceThreshold: [number, number][];
  /** Farm-segment thread allocation as a share of total farm threads, so the
   * three curves sum to 1 and the hack:grow:weaken ratio reads directly. */
  allocShare: OpKindSeries;
  /** One entry per batch kind the run has settled (hwgw | hgw | shotgun |
   * prep). Keyed by the string the dispatcher sent rather than by a union, so
   * a kind this viewer has never heard of still draws. */
  batchSeries: Record<string, BatchKindSeries>;
  /** Settled batches accumulated across the whole run, oldest first.
   *
   * The rollup's `recentBatches` is an eight-entry ring — enough to name a bad
   * batch, not enough to be a history. But every entry carries the monotonic
   * id the dispatcher already assigns, so successive rollups overlap and
   * deduping on that id recovers the full sequence for no telemetry at all. */
  batchHistory: SettledBatchReport[];
  /** Recent cumulative samples, so a rate can be taken over a WINDOW rather
   * than between two adjacent rollups. See `foldFarmRates`. A counter that
   * moved backwards means a reset (an install wipes the topic), and the ring
   * is dropped rather than differenced into a negative rate. */
  farmSamples: FarmSample[];
  /** The averaging window the current rate points were taken over, in ms, so
   * the panel can say what it averaged instead of implying "per second,
   * instantaneously". */
  farmWindowMs: number;
  /** Running totals behind `earned`/`hacks` when the farm rollup is absent.
   *  Held on the state so an incremental fold can continue them. */
  hackDoneEarned: number;
  hackDoneCount: number;
  sawHackDone: boolean;
  /** Set when the run was served compacted: history before the tail is gone,
   *  so the scrubber is meaningless and says so instead of lying. */
  compacted: boolean;
}

export function emptyState(): ProjectedState {
  return {
    runId: null,
    src: null,
    live: false,
    t0: null,
    lastT: 0,
    player: null,
    servers: new Map(),
    topics: {},
    caps: unknownCapabilities(),
    events: [],
    contractReplay: null,
    simMeta: null,
    simResult: null,
    simGapDetails: new Map(),
    earned: 0,
    hacks: 0,
    hasTotals: false,
    moneySeries: [],
    cadenceAccrued: [],
    cadenceThreshold: [],
    allocShare: { hack: [], grow: [], weaken: [] },
    batchSeries: {},
    batchHistory: [],
    farmSamples: [],
    farmWindowMs: DEFAULT_RATE_WINDOW_MS,
    hackDoneEarned: 0,
    hackDoneCount: 0,
    sawHackDone: false,
    compacted: false,
  };
}

export interface RunMeta {
  id: string | null;
  src: "game" | "sim" | null;
  live: boolean;
  t0: number | null;
  compacted?: boolean;
}

/** Halve a series by dropping every other point, keeping the first and last.
 *
 * Uniform decimation rather than a windowed min/max because the money series
 * is a slow-moving cumulative curve: neighbouring points differ by fractions
 * of a percent, so dropping alternates is visually lossless, and the endpoints
 * are what the axis labels are drawn from. */
function decimate(series: [number, number][]): void {
  const kept: [number, number][] = [];
  for (let i = 0; i < series.length; i += 2) kept.push(series[i]!);
  const last = series[series.length - 1]!;
  if (kept[kept.length - 1] !== last) kept.push(last);
  series.length = 0;
  series.push(...kept);
}

/** Fold one record into an existing state. Returns false when the record is
 *  past the replay cutoff and was therefore skipped. */
function foldOne(state: ProjectedState, record: LogRecord, cutoff: number): boolean {
  if (record.t > cutoff) return false;
  // Monotonic: a span-closing record written by the hub when the span ended
  // carries an older `t` than records already folded, and "latest observation"
  // must not go backwards because of one.
  if (record.t > state.lastT) state.lastT = record.t;

  if (record.kind === "state") {
    // The money chart must follow whichever player source the emitter uses:
    // the `getPlayer` auto-mirror (game) or the `player` topic (sim).
    if (record.key === "getPlayer" || record.key === "player") {
      state.player = record.data as Player;
      const money = (record.data as Player | undefined)?.money;
      if (typeof money === "number") {
        state.moneySeries.push([record.t, money]);
        if (state.moneySeries.length > SERIES_LIMIT) decimate(state.moneySeries);
      }
    } else if (record.key === "progression") {
      const decision = (record.data as { plan?: { installDecision?: { resetValueMult?: number; threshold?: number } } } | undefined)
        ?.plan?.installDecision;
      if (typeof decision?.resetValueMult === "number") {
        state.cadenceAccrued.push([record.t, Math.max(0, decision.resetValueMult)]);
        if (state.cadenceAccrued.length > SERIES_LIMIT) decimate(state.cadenceAccrued);
      }
      if (typeof decision?.threshold === "number") {
        state.cadenceThreshold.push([record.t, decision.threshold]);
        if (state.cadenceThreshold.length > SERIES_LIMIT) decimate(state.cadenceThreshold);
      }
    } else if (record.key === "farm") {
      foldFarmSeries(state, record.t, record.data as FarmRollup | undefined);
      foldBatchHistory(state, (record.data as FarmRollup | undefined)?.recentBatches);
    } else if (record.key.startsWith("getServer:")) {
      state.servers.set(record.key.slice("getServer:".length), record.data as Server);
    } else if (record.key === "servers" && record.data) {
      for (const [host, server] of Object.entries(record.data as Record<string, Server>)) {
        state.servers.set(host, server);
      }
    } else if (record.key === "capabilities") {
      state.caps = record.data as Capabilities;
    }
    // Every state key is retained as a topic, including the three above, so
    // tabs can read `topics.servers` or `topics.player` directly too.
    (state.topics as Record<string, unknown>)[record.key] = record.data;
    return true;
  }

  if (record.kind === "event" && record.name === "hack.done") {
    const data = record.data as { success?: boolean; moneyGained?: number } | undefined;
    state.sawHackDone = true;
    if (data?.success) {
      state.hackDoneEarned += data.moneyGained ?? 0;
      state.hackDoneCount++;
    }
  }
  if (record.kind === "event" && record.name === "contract.quarantined") {
    state.contractReplay = record.data as ContractFailure;
  }
  if (record.kind === "event" && record.name === "sim.meta") {
    state.simMeta = record.data as SimRunMeta;
  }
  if (record.kind === "event" && record.name === "sim.result") {
    state.simResult = record.data as SimRunResult;
  }
  if (record.kind === "event" && record.name === "sim.unmodeled") {
    const gap = record.data as { kind?: string; name?: string; detail?: string } | undefined;
    if (gap?.name) {
      const kind = gap.kind ?? "ns";
      state.simGapDetails.set(`${kind} ${gap.name}`, {
        kind,
        name: gap.name,
        ...(gap.detail ? { detail: gap.detail } : {}),
      });
    }
  }
  state.events.push(record);
  if (state.events.length > EVENT_RING) state.events.splice(0, state.events.length - EVENT_RING);
  return true;
}

const KINDS = ["hack", "grow", "weaken"] as const;

/** Averaging window used when the batch period is not known yet. */
export const DEFAULT_RATE_WINDOW_MS = 30_000;
/** Bounds on the batch-derived window. Below the floor the curve is noise
 * again; above the ceiling it stops responding to anything. */
export const MIN_RATE_WINDOW_MS = 15_000;
export const MAX_RATE_WINDOW_MS = 300_000;
/** Samples retained to difference against; one rollup per second. */
const SAMPLE_RING = 400;

/** Turn the farm rollup's cumulative counters into the tab's curves.
 *
 * Two kinds of curve come out of here, and the difference is the whole design:
 *
 *  - TOTALS, pushed as they arrive: launched against landed, per batch kind.
 *    The finding is the BAND between the two, and differentiating both is the
 *    one operation guaranteed to destroy it.
 *  - WINDOWED quantities — the allocation share, the batch settle rate — which
 *    are differenced against a sample one batch period old rather than against
 *    the previous rollup. The farm publishes at 1 Hz but its cycle is one
 *    weakenTime, minutes against a real target, so an adjacent-sample
 *    difference asks "how many batches settled during this particular second",
 *    whose honest answer is almost always exactly zero. Measured on a live run:
 *    the allocation shares swung between 0% and 100% because each one-second
 *    bucket happened to contain launches of exactly one kind. That was not a
 *    fault in the farm; it was the wrong resolution.
 *
 * The window follows the target's weaken time, which IS the batch period, and
 * is reported on the state so the panel can say what it averaged over.
 *
 * A counter that moved BACKWARDS is a reset — an install wipes the topic and
 * the next rollup restarts from zero — so the ring is dropped and rebuilt
 * rather than differenced into a large negative spike. */
function foldFarmSeries(state: ProjectedState, t: number, farm: FarmRollup | undefined): void {
  const launched = farm?.launched;
  const landed = farm?.landed;
  if (!launched || !landed) return;
  const farmThreads = farm.allocation?.threads?.["farm"];
  const byKind: Record<string, BatchCounters> = {};
  for (const [kind, entry] of Object.entries(farm.batches ?? {})) {
    byKind[kind] = {
      batches: entry.batches,
      ops: entry.ops,
      landed: entry.landed,
      moneyEarned: entry.moneyEarned,
    };
  }
  const sample: FarmSample = {
    t,
    launched: { ...launched },
    landed: { ...landed },
    threads: farmThreads ? { ...farmThreads } : { hack: 0, grow: 0, weaken: 0 },
    byKind,
  };
  const samples = state.farmSamples;
  const previous = samples[samples.length - 1];
  const reset = previous !== undefined && (
    KINDS.some(
      (kind) => sample.launched[kind] < previous.launched[kind] || sample.landed[kind] < previous.landed[kind],
    ) ||
    // The batch counters live in the same DispatchMemory, so they reset with
    // everything else — but a kind can vanish from the rollup on its own (only
    // kinds with batches > 0 are published), which is not a reset.
    Object.entries(previous.byKind).some(([kind, before]) => {
      const now = sample.byKind[kind];
      return now !== undefined && (now.batches < before.batches || now.ops < before.ops);
    })
  );
  if (reset) {
    samples.length = 0;
    state.batchSeries = {};
    state.batchHistory = [];
  }
  samples.push(sample);
  if (samples.length > SAMPLE_RING) samples.splice(0, samples.length - SAMPLE_RING);

  const cycleMs = farm.pipelines?.find((entry) => entry.role === "farm")?.weakenTimeMs;
  state.farmWindowMs = cycleMs === undefined
    ? DEFAULT_RATE_WINDOW_MS
    : Math.min(MAX_RATE_WINDOW_MS, Math.max(MIN_RATE_WINDOW_MS, cycleMs));

  const base = baselineFor(samples, t - state.farmWindowMs);
  if (!base) return;
  const dtSec = (t - base.t) / 1_000;
  if (dtSec <= 0) return;

  // Share of the threads the farm launched across the window. A window with no
  // launches at all contributes no point rather than a 0/0 — the ratio is
  // undefined there, and plotting it as zero would read as "the farm stopped
  // allocating to hack", which is a claim about a decision.
  let threadTotal = 0;
  for (const kind of KINDS) threadTotal += sample.threads[kind] - base.threads[kind];
  if (threadTotal > 0) {
    for (const kind of KINDS) {
      push(state.allocShare[kind], t, (sample.threads[kind] - base.threads[kind]) / threadTotal);
    }
  }

  for (const [kind, now] of Object.entries(sample.byKind)) {
    const series = state.batchSeries[kind] ?? (state.batchSeries[kind] = {
      launched: [],
      landed: [],
      perSec: [],
      moneyPerBatch: [],
    });
    // Totals, pushed as they arrive. No differencing: see BatchKindSeries.
    push(series.launched, t, now.ops);
    push(series.landed, t, now.landed);
    // A kind absent from the baseline is one that settled its first batch
    // inside this window, so zero is its true starting point rather than a gap.
    const before = base.byKind[kind] ?? { batches: 0, ops: 0, landed: 0, moneyEarned: 0 };
    const settled = now.batches - before.batches;
    push(series.perSec, t, settled / dtSec);
    // 0/0 is not 0. A window that settled nothing has no money-per-batch, and
    // plotting zero there would read as "a batch now earns nothing".
    if (settled > 0) push(series.moneyPerBatch, t, (now.moneyEarned - before.moneyEarned) / settled);
  }
}

/** Accumulate the rollup's bounded recent-batch ring into a full history.
 *
 * Ids come from a single `nextBatchId++`, so they are monotonic within a run
 * and "newer than the newest kept" is a sound dedupe across the overlapping
 * rings successive rollups carry. An id going BACKWARDS is an install wiping
 * the dispatcher, and the history is dropped rather than interleaved — the two
 * sequences would otherwise share ids that mean different batches. */
function foldBatchHistory(state: ProjectedState, batches: readonly SettledBatchReport[] | undefined): void {
  if (!batches || batches.length === 0) return;
  // The ring is newest-last, so its final id is the highest the dispatcher has
  // settled. Below what we already hold, that id can only mean the counter
  // restarted.
  const newest = batches[batches.length - 1]!.id;
  const held = state.batchHistory[state.batchHistory.length - 1];
  if (held !== undefined && newest < held.id) state.batchHistory = [];
  const floor = state.batchHistory[state.batchHistory.length - 1]?.id ?? -1;
  for (const batch of batches) {
    if (batch.id > floor) state.batchHistory.push(batch);
  }
  if (state.batchHistory.length > SERIES_LIMIT) {
    state.batchHistory.splice(0, state.batchHistory.length - SERIES_LIMIT);
  }
}

/** The oldest retained sample at or before `from` — the baseline a full-window
 * rate differences against.
 *
 * Early in a run the ring is shorter than the window. Rather than emit nothing
 * until it fills, the oldest sample is used and the rate is simply averaged
 * over a shorter span; the alternative is no curve at all for the first few
 * minutes of a long-cycle target, which is exactly the phase worth watching. */
function baselineFor(samples: readonly FarmSample[], from: number): FarmSample | undefined {
  if (samples.length < 2) return undefined;
  let base = samples[0]!;
  for (const sample of samples) {
    if (sample.t > from) break;
    base = sample;
  }
  // Never difference a sample against itself.
  return base === samples[samples.length - 1] ? samples[samples.length - 2] : base;
}

function push(series: [number, number][], t: number, value: number): void {
  series.push([t, value]);
  if (series.length > SERIES_LIMIT) decimate(series);
}

/** Recompute the derived totals. Cheap, and it has to run after any fold
 * because the `farm` rollup can appear at any point in the stream. */
function settle(state: ProjectedState): ProjectedState {
  // The `farm` rollup is authoritative when present: it is cumulative and it
  // is the only totals source once per-op events are compiled out (which is
  // the steady state for both game and non-verbose sim runs).
  const farm = state.topics.farm;
  if (farm?.totals) {
    state.earned = farm.totals.moneyEarned;
    state.hacks = farm.totals.hacks;
    state.hasTotals = true;
  } else if (state.sawHackDone) {
    state.earned = state.hackDoneEarned;
    state.hacks = state.hackDoneCount;
    state.hasTotals = true;
  } else {
    state.earned = 0;
    state.hacks = 0;
    state.hasTotals = false;
  }
  return state;
}

/** Fold newly-arrived records into an existing state, in place.
 *
 * This is the live path: cost is proportional to what arrived, not to how long
 * the run has been open. */
export function appendRecords(state: ProjectedState, records: readonly LogRecord[]): ProjectedState {
  for (const record of records) {
    if (state.t0 === null) state.t0 = record.t;
    foldOne(state, record, Infinity);
  }
  return settle(state);
}

/** Fold the (optionally truncated) record list into one renderable state.
 *
 * The whole-history path, used when the record list is authoritative rather
 * than incremental: loading a stored run, and every move of the replay
 * scrubber (where the cutoff can go backwards, so nothing can be reused). */
export function project(records: LogRecord[], cutoff: number, meta: RunMeta): ProjectedState {
  const state = emptyState();
  state.runId = meta.id;
  state.src = meta.src;
  state.live = meta.live;
  state.t0 = meta.t0;
  state.compacted = meta.compacted ?? false;

  // SKIPPED, not stopped at. The file is very nearly ordered by `t` but not
  // exactly: the hub collapses a run of identical state into its first and last
  // record, and that closing record is written when the span ENDS, so it
  // trails records carrying a later timestamp. Breaking on the first
  // out-of-range record would silently truncate the projection at the first
  // such trailer. The scan is bounded anyway — a file too large to hold whole
  // is served compacted, and this path only ever sees one small enough.
  for (const record of records) foldOne(state, record, cutoff);

  return settle(state);
}

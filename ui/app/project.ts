import type { Player, Server } from "@ns";
import { unknownCapabilities, type Capabilities } from "../../shared/features/unlock.ts";
import type { DebugRecord, EventRecord, LogRecord } from "../../shared/telemetry/schema.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";
import type { ContractFailure } from "../../shared/telemetry/topics/side.ts";
import type { FarmRollup, FleetRollup, SettledBatchReport } from "../../shared/telemetry/topics/hacking.ts";
import type { StockState } from "../../shared/telemetry/topics/stock.ts";
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

/** Episodes retained in the arbiter decision log. Small on purpose — an
 * episode is a coalesced RUN of identical outcomes, not one event, so 120 of
 * them cover far more wall clock than the event ring ever holds. */
export const DECISION_LOG_LIMIT = 120;

export type DecisionRankedOption = NonNullable<FleetRollup["infrastructurePlan"]>["ranked"][number];

/** One coalesced run of identical investment decisions or results.
 *
 * Kept OUTSIDE the event ring on purpose: the ring is shared with probe and
 * debug traffic, so on a busy run a decision is evicted within minutes — and
 * the arbiter's history is exactly the thing worth keeping longer than that.
 * Coalescing happens here rather than at render time for the same reason: a
 * refusal repeated every pass must occupy one episode, not one ring slot each. */
export interface DecisionEpisode {
  subsystem: string;
  kind: "decision" | "result";
  /** `t` of the first and last occurrence folded into this episode. */
  firstT: number;
  lastT: number;
  count: number;
  /** What the plan chose: buy kind, spend/reserve name, entry side+sym,
   * unlock type — or "hold". For a result, the action that ran. */
  choice: string;
  /** The arbiter's verdict on OUR claim. Absent when no digest rode along or
   * the subsystem made no claim this pass. */
  funded?: boolean;
  wanted?: number;
  granted?: number;
  available?: number;
  denialReason?: string;
  /** Grants that are NOT ours — where the money went instead. */
  winners?: { by: string; id: string; amount: number }[];
  /** Ranked alternatives captured with the decision, newest occurrence wins. */
  ranked?: DecisionRankedOption[];
  rankedTotal?: number;
  /** Result rows only. */
  ok?: boolean;
  detail?: string;
}

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

/** The cumulative figures a batch kind's series are differenced from. */
export interface BatchCounters {
  batches: number;
  /** Ops launched by settled batches of this kind. Kept for the reset test —
   * a counter moving backwards is an install — not for a curve: the matching
   * `landed` is equal to it by construction and used to be retained beside it
   * for a band that could never open. */
  ops: number;
  moneyEarned: number;
  /** Summed start-to-settle spans, and the graded / in-order counts, retained
   * so the health card's span and in-order curves can be DIFFERENCED like
   * every other rate here.
   *
   * They have to be, because the producer never resets them: `settleBatch`
   * accumulates into `memory.stats.batchesByKind` for the dispatcher's whole
   * life. Pushing `spanMs / batches` straight off one rollup therefore drew a
   * LIFETIME mean on the card whose whole claim is "is this getting worse" —
   * after an hour the denominator is tens of thousands of batches, so a
   * pipeline that starts slipping now cannot visibly move the curve.
   *
   * Deliberately NOT added to the reset sentinel that `ops` serves: `graded` is
   * optional on the wire and a kind can drop out of a rollup on its own, so a
   * record that simply omits one would read as an install and wipe the ring. */
  spanMs: number;
  graded: number;
  inOrder: number;
  noHack: number;
}

/** One batch kind's curves.
 *
 * There is deliberately no launched-against-landed pair here. It used to carry
 * one, as running totals, on the reasoning that the BAND between the two was
 * the ops that never arrived and that differentiating both would destroy it.
 * The band does not exist: a batch settles only once its last op lands, so the
 * per-kind sums of `ops` and `landed` are equal in every run, and the chart
 * built on them drew one curve twice for a long time without anyone noticing.
 *
 * Op loss is `abandoned`/`abandonedOps` on the aggregate — a batch that loses
 * an op never settles and is evicted instead — and the run-level residual in
 * `FarmHealthSeries.opsLost`. Both are real and both open. */
export interface BatchKindSeries {
  /** Batches SETTLED per second, differenced against the oldest sample at or
   * before the requested window — so the span these were averaged over is
   * `farmWindowActualMs`, which is `farmWindowMs` only once the ring is that
   * deep. A rate belongs here and not on the op counters: a batch is a
   * discrete completion, so its rate is a throughput, where an op backlog is a
   * level. */
  perSec: [number, number][];
  /** Mean money one batch of this kind earned across the window. Says whether
   * the target is drying out, which a batch count alone never shows. */
  moneyPerBatch: [number, number][];
}

/** The market's capital and earnings over time, for one install.
 *
 * One install, because one artifact IS one install — the run file is keyed on
 * the install id and a prestige starts a new one — so no curve here can ever
 * span an install boundary and none of them is ever dropped mid-stream. See
 * `foldStockSeries`, which used to drop them on a signal that meant something
 * else entirely.
 *
 * The pairing is the same idea as `BatchKindSeries`: what is being read is the
 * BAND between two levels, not either level's rate. `value` against `cost` is
 * unrealised P/L and the crossing is the book going underwater; `realized`
 * against `unlockSpend` is whether the market has yet earned back the
 * $200m/$5b/$25b it cost to get in, which is the quantity the whole unlock-ROI
 * ladder argues about. */
export interface StockSeries {
  /** `portfolioValue` — the book marked at bid/ask. */
  value: [number, number][];
  /** `portfolioCost` — capital deployed. Moves only when a trade moves it. */
  cost: [number, number][];
  /** `tradeCashFlow + max(0, portfolioCost)` — realised net, exactly as
   * game/lib/income.ts defines cumulative stock earnings.
   *
   * Cost basis and NOT mark-to-market on purpose: the curve is then unmoved by
   * opening a position and unmoved by price wobble, so it is monotone except
   * for genuinely realised losses — which is the shape a cumulative earnings
   * figure claims to have. The two inputs arrive from different probes, but
   * they are coherent because the driver merges both in the same call after a
   * trade and cost basis only moves when a trade moves it. */
  realized: [number, number][];
  /** Cumulative WSE/TIX/4S spend — a step function, and the cost of admission
   * `realized` has to clear. Excluded from `realized` because a purchase is
   * not a trading loss. */
  unlockSpend: [number, number][];
}

export function emptyStockSeries(): StockSeries {
  return { value: [], cost: [], realized: [], unlockSpend: [] };
}

/** One settled batch, with the size-normalised figures the per-batch view
 * compares on. Derived once when the batch is folded in rather than on every
 * frame: the panel re-renders twice a second, the batch never changes again.
 *
 * Size normalisation is the point. Batches are not comparable as they come —
 * a prep wave is ~100 grow threads that steal nothing and a HWGW cycle is four
 * ops that do — so a raw `moneyEarned` column ranks by batch size and a
 * per-kind mean hides the spread entirely. `moneyPerGbSec` is what one batch
 * earned per GB it occupied per second it held it, which is the same question
 * asked of both. */
export interface SettledBatchView extends SettledBatchReport {
  /** Threads across all three ops. */
  totalThreads: number;
  /** Money earned per GB-second committed. Zero when the batch stole nothing
   * (a prep wave) or occupied nothing measurable. */
  moneyPerGbSec: number;
  /** Had a landing grid and did NOT land in the planned order. */
  misordered: boolean;
}

/** Dispatcher health as curves rather than the latest scalar.
 *
 * Every one of these was already on the wire and rendered as a single number in
 * a table, which cannot answer the only question worth asking of them — is this
 * getting worse? `pumpOccupancy` in particular is the leading indicator the
 * hacking tab's own comments name: past a fifth of wall time the game's own
 * timers start missing deadlines, and the landing error that follows is what
 * the operator eventually notices instead. */
export interface FarmHealthSeries {
  /** Ops launched that are neither in flight nor landed — the ops that were
   * paid for and never arrived.
   *
   * `launched - landed` alone is NOT loss: at steady state most of that gap is
   * simply in flight. Subtracting the in-flight gauge leaves the residual, and
   * a residual that climbs is the farm losing work. This is the loss curve the
   * per-kind launched/landed pair was always meant to be and structurally
   * could not be — those two are equal by construction. */
  opsLost: [number, number][];
  /** Planner cost as a share of wall clock. Healthy sits near 5%; past ~20%
   * the engine starves. */
  pumpOccupancy: [number, number][];
  /** Observed-minus-planned landing time, signed mean and worst absolute,
   * SINCE THE INSTALL rather than over the window — `accumulateLandingError`
   * keeps a running count/sum and a monotone max, and nothing resets them.
   * The names carry that because it cannot be fixed here: only the mean is on
   * the wire, and a windowed version would need `sumMs`/`count` published raw
   * (the rollup's `roundSigFigs` on a run-long sum would quantize away exactly
   * the deltas it would be differenced from). A panel drawing these beside the
   * windowed curves has to say which is which. */
  landingErrorMeanSinceInstallMs: [number, number][];
  landingErrorMaxAbsSinceInstallMs: [number, number][];
  /** Main-thread starvation, which leads landing error by a weaken time. */
  engineLatenessMs: [number, number][];
  /** Mean start-to-settle span of the batches that settled IN THE WINDOW:
   * summed span deltas over summed batch deltas. Rising span is a pipeline
   * slipping and it moves before income does — a claim only the windowed form
   * can support, which is why this is folded with the rates and not with the
   * gauges. */
  batchSpanMs: [number, number][];
  /** Share of the batches GRADED IN THE WINDOW that landed in the planned
   * order, 0..1. Anchored near 1.0 in a healthy run, which is why its chart
   * needs a y floor. Windowed for the same reason as the span. */
  inOrderShare: [number, number][];
  /** Share of graded batches that actually launched a hack. Kept separate
   * from ordering: support-only settlement is waste, not a reorder. */
  hackLaunchedShare: [number, number][];
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
  /** Money-arbitrated decisions and their results, coalesced into episodes.
   * See DecisionEpisode for why this is not read off `events`. */
  decisionLog: DecisionEpisode[];
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
  /** Settled batches accumulated across the whole run, in the order they
   * settled.
   *
   * The rollup's `recentBatches` is a bounded ring — enough to name a bad
   * batch, not enough to be a history. Every entry carries the id the
   * dispatcher assigns, so successive rollups overlap and deduping on that id
   * recovers the sequence for no extra telemetry at all. */
  batchHistory: SettledBatchView[];
  /** Batch ids already folded into `batchHistory`.
   *
   * A SET, not a high-water mark. Ids are assigned when a batch OPENS and the
   * ring is ordered by when it SETTLED, from one counter shared by prep waves
   * and farm cycles — and a prep wave spans minutes while farm batches settle
   * continuously, so a low id routinely arrives after many higher ones. A
   * watermark dropped exactly those batches, and when one landed last in the
   * ring it read as a counter restart and discarded the entire history. */
  batchSeen: Set<number>;
  /** Session origin for batch timestamps, in the DISPATCHER's clock domain
   * (`performance.now()`), derived as the earliest batch start seen. Batch
   * charts and prose subtract this, never `t0` — `t0` is wall-clock epoch ms
   * and the two domains must NEVER be compared or mixed. */
  batchT0: number | null;
  /** Dispatcher health, as curves. */
  farmHealth: FarmHealthSeries;
  /** Recent cumulative samples, so a rate can be taken over a WINDOW rather
   * than between two adjacent rollups. See `foldFarmRates`. A counter that
   * moved backwards means a reset (an install wipes the topic), and the ring
   * is dropped rather than differenced into a negative rate. */
  farmSamples: FarmSample[];
  /** The averaging window the rate points were REQUESTED over, in ms: the
   * target's weakenTime, which is the batch period, clamped. A decision, not a
   * measurement — what was actually averaged is `farmWindowActualMs`. */
  farmWindowMs: number;
  /** The span the newest rate points were actually differenced over, in ms.
   *
   * A separate field because the two genuinely diverge and the panel used to
   * print the requested one as though it were this one. `baselineFor`
   * deliberately falls back to the oldest sample it holds, so early against a
   * long-cycle target the real span is seconds under a caption claiming
   * minutes; and a gap in the rollup stream — a stalled emitter, or a replay of
   * a file whose identical spans the hub collapsed — makes it longer instead.
   *
   * Absent until a second rollup has been folded, and cleared on a counter
   * reset, so a panel says it is waiting rather than captioning a fresh run's
   * first points with the previous run's window. */
  farmWindowActualMs?: number;
  /** The stock market's capital and earnings curves for this install. */
  stockSeries: StockSeries;
  /** `t` of the first trade the viewer WATCHED land, and the only honest
   * denominator for a measured $/sec.
   *
   * Null is not "no trade yet" on its own — read it with `sawStockLedgerOpen`.
   * Null with that flag set is a market that has genuinely not traded; null
   * with it clear is an attach (or a compacted replay) that arrived after the
   * ledger was already running, where the denominator is not on the wire at
   * all: the driver holds `tradeFlowSince` privately and does not
   * publish it. A panel has to say so rather than divide a whole install's
   * realised P/L by the age of the attach, which is what the previous
   * "first record I happened to see" arming did. */
  stockRateSince: number | null;
  /** Whether an explicit `tradeCashFlow === 0` was ever observed — i.e. whether
   * this viewer saw the ledger before its first trade. An ABSENT ledger is not
   * the same evidence; see `foldStockSeries`. */
  sawStockLedgerOpen: boolean;
  /** Running totals behind `earned`/`hacks` when the farm rollup is absent.
   *  Held on the state so an incremental fold can continue them. */
  hackDoneEarned: number;
  hackDoneCount: number;
  sawHackDone: boolean;
  /** Set when the run was served compacted: history before the tail is gone,
   *  so the scrubber is meaningless and says so instead of lying. */
  compacted: boolean;
}

function emptyFarmHealth(): FarmHealthSeries {
  return {
    opsLost: [],
    pumpOccupancy: [],
    landingErrorMeanSinceInstallMs: [],
    landingErrorMaxAbsSinceInstallMs: [],
    engineLatenessMs: [],
    batchSpanMs: [],
    inOrderShare: [],
    hackLaunchedShare: [],
  };
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
    decisionLog: [],
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
    batchSeen: new Set(),
    batchT0: null,
    farmHealth: emptyFarmHealth(),
    farmSamples: [],
    farmWindowMs: DEFAULT_RATE_WINDOW_MS,
    stockSeries: emptyStockSeries(),
    stockRateSince: null,
    sawStockLedgerOpen: false,
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
    } else if (record.key === "stock") {
      foldStockSeries(state, record.t, record.data as StockState | undefined);
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
  if (record.kind === "event") foldDecisionLog(state, record);
  state.events.push(record);
  if (state.events.length > EVENT_RING) state.events.splice(0, state.events.length - EVENT_RING);
  return true;
}

/** Which feature's arbitration claims belong to each investment subsystem, so
 * the fold can tell OUR grant/denial from the winners that beat us. The id
 * prefix narrows hacking's claims to the fleet one — its opener claims are a
 * different purchase with a different history. */
const DECISION_OWNERS: Record<string, { by: string; idPrefix?: string }> = {
  infrastructure: { by: "hacking", idPrefix: "infrastructure:" },
  hacknet: { by: "hacknet" },
  stock: { by: "stock" },
};

/** The wire shapes foldDecisionLog reads. Loose on purpose: each subsystem's
 * plan is its own type and only these fields are shared enough to fold. */
interface DecisionEventData {
  subsystem?: string;
  plan?: {
    moneyAvailable?: number;
    moneyGranted?: number;
    buy?: { kind?: string; cost?: number };
    candidate?: { kind?: string; cost?: number };
    spend?: { name?: string };
    reserve?: { name?: string };
    /** `stock`'s selection is a position, not a purchase: it names a symbol
     * and a side rather than a `kind` or a `name`, and its `reserve` is
     * `{amount, ratePerSec}` with no name at all — so without these two the
     * whole subsystem falls through to the "hold" default and every trade it
     * ever made reads as an idle tick. */
    entry?: { sym?: string; side?: string };
    unlock?: { type?: string };
    ranked?: DecisionRankedOption[];
    rankedTotal?: number;
  };
  result?: { action?: string; ok?: boolean; detail?: string };
  /** hash.result carries the result fields at the top level. */
  action?: string;
  ok?: boolean;
  detail?: string;
  arbitration?: {
    grants?: { by: string; id: string; amount: number; wanted?: number }[];
    denied?: { by: string; id?: string; reason: string; wanted?: number; available?: number }[];
  };
}

/** The coalescing key. Amounts and free-running numbers are excluded ON
 * PURPOSE — they drift every pass, and their drift is the churn this log
 * exists to remove; the newest occurrence's figures overwrite the episode's.
 * Only the tail is ever compared against, so an interleaved episode from
 * another subsystem breaks the run: interleaving is real ordering information. */
function decisionSignature(episode: DecisionEpisode): string {
  const funded = episode.funded === undefined ? "-" : episode.funded ? "y" : "n";
  const detail = (episode.detail ?? "").replace(/\$?\d[\d.,]*(?:e[+-]?\d+)?[a-z%]*/gi, "#");
  return [episode.subsystem, episode.kind, episode.choice, funded, episode.denialReason ?? "", detail].join("|");
}

/** Fold one investment/hash decision or result into the coalesced log. */
function foldDecisionLog(state: ProjectedState, record: EventRecord): void {
  const kind =
    record.name === "investment.decision" || record.name === "hash.decision"
      ? ("decision" as const)
      : record.name === "investment.result" || record.name === "hash.result"
        ? ("result" as const)
        : undefined;
  if (!kind) return;
  const data = record.data as DecisionEventData | undefined;
  // Hash spending is hacknet's second economy — real decisions, but the money
  // arbiter never sees them, so they carry no arbitration columns.
  const subsystem = record.name.startsWith("hash.") ? "hashes" : (data?.subsystem ?? "unknown");

  const episode: DecisionEpisode = { subsystem, kind, firstT: record.t, lastT: record.t, count: 1, choice: "" };
  if (kind === "result") {
    const result = data?.result ?? data;
    episode.choice = result?.action ?? "";
    if (typeof result?.ok === "boolean") episode.ok = result.ok;
    episode.detail = result?.detail ?? "";
  } else {
    const plan = data?.plan;
    episode.choice =
      plan?.spend?.name ??
      plan?.reserve?.name ??
      plan?.buy?.kind ??
      plan?.candidate?.kind ??
      (plan?.entry ? `${plan.entry.side ?? ""} ${plan.entry.sym ?? ""}`.trim() || undefined : undefined) ??
      plan?.unlock?.type ??
      "hold";
    if (plan?.ranked?.length) {
      episode.ranked = plan.ranked;
      episode.rankedTotal = plan.rankedTotal ?? plan.ranked.length;
    }
    const owner = DECISION_OWNERS[subsystem];
    const arbitration = data?.arbitration;
    if (arbitration && owner) {
      const ours = (id: string | undefined) => !owner.idPrefix || (id ?? "").startsWith(owner.idPrefix);
      const denial = arbitration.denied?.find((entry) => entry.by === owner.by && ours(entry.id));
      const grant = arbitration.grants?.find((entry) => entry.by === owner.by && ours(entry.id));
      const winners = (arbitration.grants ?? [])
        .filter((entry) => entry.by !== owner.by || !ours(entry.id))
        .map((entry) => ({ by: entry.by, id: entry.id, amount: entry.amount }));
      if (winners.length) episode.winners = winners;
      if (denial) {
        episode.funded = false;
        episode.denialReason = denial.reason;
        if (typeof denial.wanted === "number") episode.wanted = denial.wanted;
        if (typeof denial.available === "number") episode.available = denial.available;
      } else if (grant) {
        episode.funded = true;
        episode.granted = grant.amount;
        if (typeof grant.wanted === "number") episode.wanted = grant.wanted;
      }
    }
    // Plan-level figures fill whatever the digest could not say: the producers
    // sign `funded` as moneyGranted >= cost (game/lib/telemetry-sink.ts), so
    // the same reading here cannot disagree with the emitted transition.
    if (episode.wanted === undefined) episode.wanted = plan?.buy?.cost ?? plan?.candidate?.cost;
    if (episode.granted === undefined && typeof plan?.moneyGranted === "number") episode.granted = plan.moneyGranted;
    if (episode.available === undefined && typeof plan?.moneyAvailable === "number") episode.available = plan.moneyAvailable;
    if (episode.funded === undefined && episode.wanted !== undefined && typeof plan?.moneyGranted === "number") {
      episode.funded = plan.moneyGranted >= episode.wanted;
    }
  }

  const log = state.decisionLog;
  const last = log[log.length - 1];
  if (last && decisionSignature(last) === decisionSignature(episode)) {
    // Same outcome again: one episode, latest figures, longer span. REPLACE
    // the tail rather than merging into it — Object.assign never deletes, so
    // optional fields absent on the newest occurrence (winners, ranked,
    // granted, available, ok) survived a merge and rendered stale facts.
    episode.firstT = last.firstT;
    episode.count = last.count + 1;
    log[log.length - 1] = episode;
    return;
  }
  log.push(episode);
  if (log.length > DECISION_LOG_LIMIT) log.splice(0, log.length - DECISION_LOG_LIMIT);
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

/** Turn the stock topic into the tab's capital and earnings curves.
 *
 * ABSENCE IS NOT ZERO. `portfolioValue`/`portfolioCost` come from the 3-second
 * `stock.tick` probe, while `tradeCashFlow`/`unlockSpend` are written only by
 * the driver's `execute()` — so they are genuinely missing until this install's
 * first trade, and plotting a missing ledger as $0 would draw a run that broke
 * even when in fact it had not yet traded. Each series is pushed only when its
 * OWN inputs are present.
 *
 * NOTHING IS DROPPED HERE, and that is a correction. This fold used to close
 * out a "previous install" mid-stream, on two sentinels that cannot mean an
 * install: one artifact IS one install. `ui/store.ts` keys the run file on
 * `hello.identity.install.id`, that id is keyed on `lastAugReset` and is stable
 * across controller restarts, and the simulator rotates the
 * JSONL on prestige — so an install boundary is a different file, loaded as a
 * different run, and cannot appear inside one record stream at all.
 *
 * What CAN appear mid-stream is a controller restart, and both old sentinels
 * were restart signals:
 *  - `market.tick` is `memory.history.tick` off a module-level `let`, so it
 *    restarts at 0 whenever a build push replaces the module instance;
 *  - the ledger vanishing is the same event seen from the other side — the
 *    rebuilt topic starts empty and `tradeCashFlow` is merged again only by the
 *    next `execute()`.
 * Neither is an install boundary. Treating either as one threw away the live
 * install's capital history, so the curves remain part of the same run artifact
 * across a controller restart. */
function foldStockSeries(state: ProjectedState, t: number, stock: StockState | undefined): void {
  if (!stock) return;
  const series = state.stockSeries;
  if (typeof stock.portfolioValue === "number") push(series.value, t, stock.portfolioValue);
  if (typeof stock.portfolioCost === "number") push(series.cost, t, stock.portfolioCost);
  if (typeof stock.unlockSpend === "number") push(series.unlockSpend, t, stock.unlockSpend);
  if (typeof stock.tradeCashFlow === "number") {
    // The measured-rate clock is armed only by having WATCHED the ledger open.
    // An explicit zero proves this emitter has not traded yet. An absent ledger
    // proves nothing because the driver publishes it only when it executes.
    //
    // Arming on the first non-zero figure the viewer happened to see divided a
    // whole install's realised P/L by the age of the ATTACH: a live attach
    // folds the hub snapshot plus a 2 MB tail, and a compacted replay keeps one
    // record per state key, so its single `stock` record sits seconds from
    // `lastT`. Left null, the panel has to admit it has no denominator.
    if (stock.tradeCashFlow === 0) state.sawStockLedgerOpen = true;
    else if (state.sawStockLedgerOpen && state.stockRateSince === null) state.stockRateSince = t;
    push(series.realized, t, stock.tradeCashFlow + Math.max(0, stock.portfolioCost ?? 0));
  }
}

/** Turn the farm rollup's cumulative counters into the tab's curves.
 *
 * Two kinds of curve come out of here, and the difference is the whole design:
 *
 *  - GAUGES, pushed as they arrive: occupancy, engine lateness, the ops-adrift
 *    residual, the since-install landing error. Folded BEFORE the windowing
 *    below, deliberately — making them wait for a baseline a full window old
 *    left every health curve empty for the first thirty seconds of a run, and
 *    permanently on a short one.
 *  - WINDOWED quantities — the allocation share, the batch settle rate, the
 *    mean batch span and the in-order share — which are differenced against a
 *    sample one batch period old rather than against the previous rollup.
 *    The last two used to be folded with the gauges, which quietly made them
 *    lifetime means: their denominators are cumulative for the dispatcher's
 *    whole life, so the card built to answer "is it getting worse" could not.
 *    See `BatchCounters`. The farm publishes at 1 Hz but its cycle is one
 *    weakenTime, minutes against a real target, so an adjacent-sample
 *    difference asks "how many batches settled during this particular second",
 *    whose honest answer is almost always exactly zero. Measured on a live run:
 *    the allocation shares swung between 0% and 100% because each one-second
 *    bucket happened to contain launches of exactly one kind. That was not a
 *    fault in the farm; it was the wrong resolution.
 *
 * There used to be a third: per-kind `ops` against `landed` as running totals,
 * kept undifferenced to preserve the band between them. See `BatchKindSeries`
 * for why that band never existed.
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
      moneyEarned: entry.moneyEarned,
      spanMs: entry.spanMs,
      graded: entry.graded ?? 0,
      inOrder: entry.inOrder,
      noHack: entry.noHack,
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
    state.batchSeen.clear();
    // performance.now() restarts with the game, so the old origin is garbage.
    state.batchT0 = null;
    state.farmHealth = emptyFarmHealth();
    // Including the measured span: a span left over from the previous run would
    // caption this one's first points with the old one's window.
    delete state.farmWindowActualMs;
  }
  samples.push(sample);
  if (samples.length > SAMPLE_RING) samples.splice(0, samples.length - SAMPLE_RING);

  // Before the windowing below, deliberately. These are gauges read straight
  // off each rollup, not rates differenced against a baseline, so making them
  // wait for a sample a full window old would leave every health curve empty
  // for the first thirty seconds of a run — and permanently on a short one.
  foldFarmHealth(state, t, farm);

  const cycleMs = farm.pipelines?.find((entry) => entry.role === "farm")?.weakenTimeMs;
  state.farmWindowMs = cycleMs === undefined
    ? DEFAULT_RATE_WINDOW_MS
    : Math.min(MAX_RATE_WINDOW_MS, Math.max(MIN_RATE_WINDOW_MS, cycleMs));

  const base = baselineFor(samples, t - state.farmWindowMs);
  if (!base) return;
  const dtSec = (t - base.t) / 1_000;
  if (dtSec <= 0) return;
  // After the guards, not beside `base`: both of them return without pushing a
  // point, and a span recorded there would caption points that do not exist.
  state.farmWindowActualMs = t - base.t;

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

  // Summed across kinds, for the two health curves below: summed numerators
  // over summed denominators, not a mean of means, because the kinds settle at
  // wildly different rates and averaging their averages would weight a rare
  // prep wave the same as thousands of farm cycles.
  let settledAll = 0;
  let spanDelta = 0;
  let gradedDelta = 0;
  let inOrderDelta = 0;
  let noHackDelta = 0;
  for (const [kind, now] of Object.entries(sample.byKind)) {
    const series = state.batchSeries[kind] ?? (state.batchSeries[kind] = {
      perSec: [],
      moneyPerBatch: [],
    });
    // A kind absent from the baseline is one that settled its first batch
    // inside this window, so zero is its true starting point rather than a gap.
    const before = base.byKind[kind] ?? { batches: 0, ops: 0, moneyEarned: 0, spanMs: 0, graded: 0, inOrder: 0, noHack: 0 };
    const settled = now.batches - before.batches;
    push(series.perSec, t, settled / dtSec);
    // 0/0 is not 0. A window that settled nothing has no money-per-batch, and
    // plotting zero there would read as "a batch now earns nothing".
    if (settled > 0) push(series.moneyPerBatch, t, (now.moneyEarned - before.moneyEarned) / settled);
    settledAll += settled;
    spanDelta += now.spanMs - before.spanMs;
    gradedDelta += now.graded - before.graded;
    inOrderDelta += now.inOrder - before.inOrder;
    noHackDelta += now.noHack - before.noHack;
  }
  // Same "0/0 is not 0" rule: a window that settled nothing has no mean span,
  // and one that graded nothing has no in-order share. A negative graded delta
  // is a rollup that stopped reporting `graded` (it is optional on the wire),
  // which is also not a share.
  if (settledAll > 0) push(state.farmHealth.batchSpanMs, t, spanDelta / settledAll);
  const hackBearingDelta = gradedDelta - noHackDelta;
  if (hackBearingDelta > 0) push(state.farmHealth.inOrderShare, t, inOrderDelta / hackBearingDelta);
  if (gradedDelta > 0) push(state.farmHealth.hackLaunchedShare, t, hackBearingDelta / gradedDelta);
}

/** Dispatcher health curves, from fields that were already on the wire.
 *
 * All of these were published and rendered as a single latest value in a table.
 * A gauge with no history cannot say whether it is getting worse, which is the
 * only thing an operator wants from it.
 *
 * Only true gauges belong here. The mean batch span and the in-order share used
 * to be pushed from this function and are now differenced in `foldFarmSeries`:
 * their denominators are cumulative for the dispatcher's whole life, so read
 * straight off a rollup they were lifetime means wearing a trend's caption. */
function foldFarmHealth(state: ProjectedState, t: number, farm: FarmRollup): void {
  const health = state.farmHealth;

  // Ops launched that are neither in flight nor landed. The in-flight term is
  // what makes this loss rather than backlog: without it the curve just tracks
  // pipeline depth and never returns to zero on a healthy farm.
  const launched = farm.launched;
  const landed = farm.landed;
  const inFlight = farm.inFlight;
  if (launched && landed) {
    let lost = 0;
    for (const kind of KINDS) lost += launched[kind] - landed[kind] - (inFlight?.[kind] ?? 0);
    push(health.opsLost, t, Math.max(0, lost));
  }

  if (typeof farm.pumpOccupancy === "number") push(health.pumpOccupancy, t, farm.pumpOccupancy);
  // A gauge only in the sense that it is read straight off the rollup: the
  // dispatcher accumulates count/sum and a monotone max for the whole install
  // and never resets them, so these two are since-install statistics that
  // cannot be differenced from what is on the wire. The names carry that.
  if (farm.landingError) {
    push(health.landingErrorMeanSinceInstallMs, t, farm.landingError.meanMs);
    push(health.landingErrorMaxAbsSinceInstallMs, t, farm.landingError.maxAbsMs);
  }
  if (farm.engineLatenessMs) push(health.engineLatenessMs, t, farm.engineLatenessMs.meanMs);
}

/** Accumulate the rollup's bounded recent-batch ring into a full history.
 *
 * Successive rollups overlap — the ring holds the last N settled batches and is
 * read once a second — so the same batch arrives several times and has to be
 * deduped. The dedupe is a SET of ids, and that is load-bearing.
 *
 * The obvious cheaper test, "id greater than the newest one held", is wrong
 * here. Ids are assigned when a batch OPENS (`nextBatchId++`) while the ring is
 * ordered by when each batch SETTLED, and one counter is shared by prep waves
 * and farm cycles. A prep wave spans a whole grow, so its low id settles after
 * many higher ones — which a watermark silently discards, and which, when that
 * batch happens to land last in the ring, reads as a restarted counter and
 * throws away the entire accumulated history.
 *
 * An install genuinely does restart the counter, but that is detected where it
 * is unambiguous — `foldFarmSeries` sees the cumulative counters move backwards
 * and clears the history and this set together — not by inferring it from the
 * arrival order of a ring that is legitimately out of order. */
function foldBatchHistory(state: ProjectedState, batches: readonly SettledBatchReport[] | undefined): void {
  if (!batches || batches.length === 0) return;
  for (const batch of batches) {
    if (state.batchSeen.has(batch.id)) continue;
    state.batchSeen.add(batch.id);
    // `at - spanMs` is the batch's START; the ratcheting min stays stable
    // under the ring's legitimately out-of-order settle times.
    state.batchT0 = Math.min(state.batchT0 ?? Infinity, batch.at - batch.spanMs);
    state.batchHistory.push(view(batch));
  }
  if (state.batchHistory.length > SERIES_LIMIT) {
    // The set has to shed exactly what the array does, or it grows without
    // bound across a long run. Re-adding an evicted id would only append a
    // batch older than everything kept, so forgetting it is safe.
    const dropped = state.batchHistory.splice(0, state.batchHistory.length - SERIES_LIMIT);
    for (const batch of dropped) state.batchSeen.delete(batch.id);
  }
}

/** Derive the size-normalised figures once, when the batch is first seen. */
function view(batch: SettledBatchReport): SettledBatchView {
  const totalThreads = batch.threads.hack + batch.threads.grow + batch.threads.weaken;
  // RAM-time actually occupied when the dispatcher reported it; runs recorded
  // before `gbMs` existed fall back to charging every op for the whole span.
  const gbSec = (batch.gbMs ?? batch.gb * batch.spanMs) / 1_000;
  return {
    ...batch,
    totalThreads,
    moneyPerGbSec: gbSec > 0 ? batch.moneyEarned / gbSec : 0,
    misordered: batch.order !== undefined && batch.order !== batch.planned,
  };
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

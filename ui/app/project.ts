import type { Player, Server } from "@ns";
import { unknownCapabilities, type Capabilities } from "../../shared/features/unlock.ts";
import type { DebugRecord, EventRecord, LogRecord } from "../../shared/telemetry/schema.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";
import type { ContractFailure } from "../../shared/telemetry/topics/side.ts";

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
 *  past the cutoff, which lets the caller stop early on an ordered stream. */
function foldOne(state: ProjectedState, record: LogRecord, cutoff: number): boolean {
  if (record.t > cutoff) return false;
  state.lastT = record.t;

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

  for (const record of records) {
    if (!foldOne(state, record, cutoff)) break;
  }

  return settle(state);
}

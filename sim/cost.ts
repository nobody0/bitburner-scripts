import { processRssBytes, realNowMs } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { formatHeapCensus, heapCensus } from "./heap-census.ts";

/** Host cost of a simulation run, measured in REAL time.
 *
 * Everything else the simulator reports — `timeToGoalMs`, `engineCycles`,
 * `noteTickLateness` — is virtual. That answers "how fast did the player get
 * there", never "how long did I sit here waiting". This module answers the
 * second question, and every clock it touches comes from `realNowMs()`
 * (sim/clock.ts), because sim/realm/timers.ts has replaced `performance.now`
 * and `Date.now` with virtual time by the time a run is pumping.
 *
 * The headline number is **virtual hours per wall minute**: how much game the
 * host buys per unit of real time. A change is an improvement iff that goes up.
 *
 * The periodic samples matter as much as the totals. spec/simulator.md's
 * "Run-length pathologies" section records the failure mode this harness exists
 * for: the 2-hour factions-join profile was unfinishable at 40+ minutes a seed
 * while 10-minute profiles ran in a second. Nothing was hot — the run was
 * re-deciding a throwing action at frame rate and re-running a planner at 5 Hz,
 * so cost grew with elapsed time. A flat CPU profile cannot show that shape;
 * a throughput curve shows nothing else. */

/** Per-name call counters, populated only while a meter is armed. Module-level
 * because the counting hooks sit deep in the ns proxy (sim/ns/api.ts) where
 * threading a meter through would mean widening signatures on the hottest path
 * in the simulator — and because a process already hosts exactly one run, the
 * same constraint that makes `currentNodeMults` and the patched timers module
 * state. Left `undefined` when cost reporting is off, so an uninstrumented run
 * pays one null check per ns call and nothing else. */
const CALL_COUNTS = new Map<string, number>();
/** Points at {@link CALL_COUNTS} while a meter is armed, `undefined` otherwise.
 * Arming and disarming move this reference rather than allocating or dropping a
 * map, and both ends clear it, so a finished run retains nothing and a second
 * run in the same process cannot inherit the first one's counts. */
let buckets: Map<string, number> | undefined;

/** Count one call against `name`. Hot: called once per Netscript call.
 *
 * A Map rather than a plain object: the keys are Netscript paths coming from a
 * Proxy, so a plain object would inherit `constructor` and friends from its
 * prototype and count `ns.toString` against `Object.prototype.toString`. Map
 * also keeps its shape as names accumulate, where a growing object literal
 * forces the engine to rebuild hidden classes on the hottest path here. */
export function countCall(name: string): void {
  if (buckets !== undefined) buckets.set(name, (buckets.get(name) ?? 0) + 1);
}

export interface CostSample {
  /** Real milliseconds since the pump started. */
  wallMs: number;
  /** Virtual milliseconds the run has advanced. */
  virtualMs: number;
  events: number;
  /** Scheduled events still heaped, and the lazy-deletion backlog inside it. */
  heap: number;
  cancelled: number;
  engineCycles: number;
  records: number;
  nsCalls: number;
  /** Resident set size of the whole process, in bytes.
   *
   * The other half of "cost grows with run length". Throughput decay says the
   * host is doing more work per virtual second; RSS says the host is HOLDING
   * more, and only the second one ends in a segfault. A 24h leg run has died
   * at 58.69 GB (sim/tests/baselines/bn4.json,
   * openDefects/memory-blowup-on-long-runs), which no throughput curve
   * showed, because the run was still fast right up to the kill. */
  rssBytes: number;
  /** The run's own scale: live processes and known servers.
   *
   * Beside RSS because they are the first thing to check against it. A run
   * whose memory climbs while these stay flat is holding garbage; a run whose
   * memory climbs BECAUSE these climb is holding a world that grew, and the
   * two have nothing in common as defects. Absent when the caller supplied no
   * probe (the planner driver owns no process table). */
  processes?: number;
  servers?: number;
  /** Virtual hours bought per wall minute, over this sample's interval alone.
   * Falling across samples is the signature of a run-length pathology. */
  throughput: number;
}

export interface CostReport {
  wallMs: number;
  virtualMs: number;
  /** Virtual hours per wall minute across the whole window. Not the mean of
   * the samples: those are per-interval, and a decaying run's mean sample would
   * flatter it. */
  throughput: number;
  events: number;
  eventsPerWallSecond: number;
  /** Real microseconds of host time per virtual event. */
  usPerEvent: number;
  /** Virtual milliseconds bought per event — the other half of usPerEvent. A
   * run can be slow because each event is expensive, or because it needs a
   * great many events per virtual second. These two numbers separate those. */
  virtualMsPerEvent: number;
  heap: number;
  cancelled: number;
  engineCycles: number;
  records: number;
  nsCalls: number;
  /** RSS at the final sample, and the highest any sample saw. Peak is the one
   * that matters: the collector can give memory back between samples, but the
   * kernel killed the process at the peak. */
  rssBytes: number;
  peakRssBytes: number;
  samples: CostSample[];
  /** Call counts by name, descending. */
  calls: { name: string; count: number; perVirtualHour: number }[];
}

export interface CostMeterOptions {
  clock: Clock;
  /** Real milliseconds between samples. */
  sampleEveryMs?: number;
  /** Live probes into run state the meter does not own. */
  engineCycles: () => number;
  records: () => number;
  /** Optional world-scale probes; see `CostSample.processes`. */
  processes?: () => number;
  servers?: () => number;
  /** Emitted as each sample is taken, so a long run reports as it goes rather
   * than only at the end — the whole point of bounding a run is that you may
   * never see its natural exit. */
  onSample?: (sample: CostSample, report: string) => void;
  /** Arm the per-name Netscript call counters. Off by default, because the
   * meter now runs on EVERY game-driver run to feed the progress heartbeat and
   * `countCall` is one `Map.set` per Netscript call — a cost the samples
   * themselves do not need. `--cost` and `SIM_COST_DETAIL` turn it on; without
   * it `nsCalls` and the report's call table read zero. */
  countCalls?: boolean;
}

const MS_PER_VIRTUAL_HOUR = 3_600_000;

/** Bytes as GB, for report lines and for the CLI's own memory messages. */
export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

export class CostMeter {
  #clock: Clock;
  #sampleEveryMs: number;
  #engineCycles: () => number;
  #records: () => number;
  #processes: (() => number) | undefined;
  #servers: (() => number) | undefined;
  #onSample: ((sample: CostSample, report: string) => void) | undefined;
  #startWall = realNowMs();
  #lastWall = this.#startWall;
  #lastVirtual = 0;
  #samples: CostSample[] = [];
  #peakRss = 0;

  constructor(options: CostMeterOptions) {
    this.#clock = options.clock;
    this.#sampleEveryMs = options.sampleEveryMs ?? 10_000;
    this.#engineCycles = options.engineCycles;
    this.#records = options.records;
    this.#processes = options.processes;
    this.#servers = options.servers;
    this.#onSample = options.onSample;
    CALL_COUNTS.clear();
    if (options.countCalls) buckets = CALL_COUNTS;
    else buckets = undefined;
  }

  /** Number of ns calls counted so far. */
  get nsCalls(): number {
    let total = 0;
    if (buckets !== undefined) for (const count of buckets.values()) total += count;
    return total;
  }

  /** Take a sample if the interval has elapsed. Called from the pump guard,
   * which already holds a fresh `realNowMs()` — passing it in keeps this off
   * the syscall path. */
  tick(wallNow: number): void {
    if (wallNow - this.#lastWall < this.#sampleEveryMs) return;
    this.#push(wallNow);
  }

  /** Final sample and the assembled report. */
  finish(): CostReport {
    const wallNow = realNowMs();
    // Only close out the tail if it is a big enough slice to mean anything. A
    // run stopped a second after a sample would otherwise append a one-second
    // interval whose throughput is mostly noise, and that sample is the one
    // `formatReport` reads to decide whether throughput is decaying.
    if (wallNow - this.#lastWall >= this.#sampleEveryMs / 2) this.#push(wallNow);
    const nsCalls = this.nsCalls;
    const rss = processRssBytes();
    if (rss > this.#peakRss) this.#peakRss = rss;
    const stats = this.#clock.stats();
    const wallMs = wallNow - this.#startWall;
    const virtualMs = this.#clock.now();
    const virtualHours = virtualMs / MS_PER_VIRTUAL_HOUR;
    const calls: CostReport["calls"] = [];
    if (buckets !== undefined) {
      for (const [name, count] of buckets) {
        calls.push({ name, count, perVirtualHour: virtualHours > 0 ? count / virtualHours : 0 });
      }
      calls.sort((a, b) => b.count - a.count);
    }
    // Disarm the hook — `countCall` costs one null check per Netscript call
    // once a run is over — and release what the counters held.
    buckets = undefined;
    CALL_COUNTS.clear();
    return {
      wallMs,
      virtualMs,
      throughput: throughputOf(virtualMs, wallMs),
      events: stats.events,
      eventsPerWallSecond: wallMs > 0 ? (stats.events * 1000) / wallMs : 0,
      usPerEvent: stats.events > 0 ? (wallMs * 1000) / stats.events : 0,
      virtualMsPerEvent: stats.events > 0 ? virtualMs / stats.events : 0,
      heap: stats.heap,
      cancelled: stats.cancelled,
      engineCycles: this.#engineCycles(),
      records: this.#records(),
      nsCalls,
      rssBytes: rss,
      peakRssBytes: this.#peakRss,
      samples: this.#samples,
      calls,
    };
  }

  /** Diagnosis-only per-sample detail, appended to the sample line when
   * `SIM_COST_DETAIL=<n>` is set: the heap census, and the Netscript calls
   * made SINCE THE PREVIOUS SAMPLE.
   *
   * The delta is the half that names a spin. Cumulative totals are dominated
   * by whatever the run did most of over its whole life, so a subsystem that
   * starts re-deciding at frame rate three hours in is invisible in them and
   * unmissable here. Off by default: it is diagnosis, and the totals table at
   * the end of the run is what a benchmark needs. */
  #detailLimit = (() => {
    const raw = Number(globalThis.process?.env?.["SIM_COST_DETAIL"]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  })();
  /** Call counts as of the previous sample, for the delta above. */
  #lastCalls = new Map<string, number>();

  #callDelta(): string {
    if (this.#detailLimit === 0 || buckets === undefined) return "";
    const deltas: { name: string; count: number }[] = [];
    for (const [name, count] of buckets) {
      const delta = count - (this.#lastCalls.get(name) ?? 0);
      if (delta > 0) deltas.push({ name, count: delta });
      this.#lastCalls.set(name, count);
    }
    if (deltas.length === 0) return "";
    deltas.sort((a, b) => b.count - a.count);
    const top = deltas.slice(0, this.#detailLimit).map((entry) => `${entry.name}=${entry.count}`);
    return `\n  calls this interval: ${top.join(" ")}`;
  }

  #census(): string {
    if (this.#detailLimit === 0) return "";
    // NO forced collection. A census that collects first would report the heap
    // it just cleaned, and — worse — would bound the very accumulation it was
    // turned on to observe, so switching the instrument on would make the
    // defect go away. `capacityBytes` and `extraBytes` do not need a sweep.
    const census = heapCensus(this.#detailLimit, false);
    return census ? `\n  ${formatHeapCensus(census)}` : "";
  }

  #push(wallNow: number): void {
    const stats = this.#clock.stats();
    const virtualMs = this.#clock.now();
    const rssBytes = processRssBytes();
    if (rssBytes > this.#peakRss) this.#peakRss = rssBytes;
    const sample: CostSample = {
      wallMs: wallNow - this.#startWall,
      virtualMs,
      events: stats.events,
      heap: stats.heap,
      cancelled: stats.cancelled,
      engineCycles: this.#engineCycles(),
      records: this.#records(),
      nsCalls: this.nsCalls,
      rssBytes,
      ...(this.#processes ? { processes: this.#processes() } : {}),
      ...(this.#servers ? { servers: this.#servers() } : {}),
      throughput: throughputOf(virtualMs - this.#lastVirtual, wallNow - this.#lastWall),
    };
    this.#lastWall = wallNow;
    this.#lastVirtual = virtualMs;
    this.#samples.push(sample);
    this.#onSample?.(sample, formatSample(sample) + this.#census() + this.#callDelta());
  }
}

function throughputOf(virtualMs: number, wallMs: number): number {
  return wallMs > 0 ? virtualMs / MS_PER_VIRTUAL_HOUR / (wallMs / 60_000) : 0;
}

/** Whether throughput is trending down, compared as first half against second
 * half rather than first sample against last. Per-interval throughput is noisy
 * — a single interval that happened to catch a quiet stretch swings the
 * endpoints by 2x — and the endpoints are exactly the two least reliable
 * samples: the first carries JIT warm-up, the last is a partial interval. */
export function throughputDrift(
  samples: readonly CostSample[],
): { first: number; last: number; pct: number; decaying: boolean } | undefined {
  if (samples.length < 2) return undefined;
  const mid = Math.floor(samples.length / 2);
  const mean = (slice: readonly CostSample[]): number =>
    slice.reduce((sum, sample) => sum + sample.throughput, 0) / slice.length;
  const first = mean(samples.slice(0, mid));
  const last = mean(samples.slice(mid));
  const pct = first > 0 ? (last / first - 1) * 100 : 0;
  // Four samples is two per half: below that the halves are single readings and
  // the comparison is no more robust than the endpoints it replaced.
  return { first, last, pct, decaying: samples.length >= 4 && pct < -20 };
}

/** How fast the run is ACCUMULATING, in bytes of RSS per virtual hour.
 *
 * Measured as first half against second half rather than first sample against
 * last, so one collection landing next to the last sample cannot report a
 * leaking run as flat. `growing` is deliberately about the RATE and not
 * about a threshold in absolute bytes: a run that adds a gigabyte per virtual
 * hour is a leak whether it has reached 4 GB or 40 GB, and the whole point of
 * the number is to catch it at 4. */
export function rssGrowth(
  samples: readonly CostSample[],
): { firstBytes: number; lastBytes: number; perVirtualHour: number; growing: boolean } | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  // First half against second half, exactly as `throughputDrift` compares its
  // own series and for the same reason: the endpoints are the two least
  // reliable samples. A forced collection landing beside the last one gives
  // back whatever it swept, and an endpoint difference would read that single
  // step as the run's whole trend — the case this function exists to survive.
  // A least-squares fit would not survive it either: a terminal outlier is a
  // high-leverage point. Halved means give one sample one vote.
  const mid = Math.floor(samples.length / 2);
  const meanOf = (
    slice: readonly CostSample[],
    of: (sample: CostSample) => number,
  ): number => slice.reduce((sum, sample) => sum + of(sample), 0) / slice.length;
  const early = samples.slice(0, mid);
  const late = samples.slice(mid);
  const hourSpan = meanOf(late, (sample) => sample.virtualMs / MS_PER_VIRTUAL_HOUR)
    - meanOf(early, (sample) => sample.virtualMs / MS_PER_VIRTUAL_HOUR);
  const byteRise = meanOf(late, (sample) => sample.rssBytes) - meanOf(early, (sample) => sample.rssBytes);
  const perVirtualHour = hourSpan > 0 ? byteRise / hourSpan : 0;
  return {
    firstBytes: first.rssBytes,
    lastBytes: last.rssBytes,
    perVirtualHour,
    // 256 MB per virtual hour puts a 24-hour leg over 6 GB of pure growth,
    // which is already the shape that ends in a kill.
    growing: samples.length >= 4 && perVirtualHour > 256 * 1024 ** 2,
  };
}

export function formatSample(sample: CostSample): string {
  return (
    `cost ${(sample.wallMs / 1000).toFixed(0).padStart(4)}s real  ` +
    `${(sample.virtualMs / MS_PER_VIRTUAL_HOUR).toFixed(2).padStart(7)}h virtual  ` +
    `${sample.throughput.toFixed(2).padStart(6)} vh/min  ` +
    `events=${sample.events}  heap=${sample.heap}  cancelled=${sample.cancelled}  ` +
    `cycles=${sample.engineCycles}  ns=${sample.nsCalls}  records=${sample.records}  ` +
    `rss=${formatBytes(sample.rssBytes)}` +
    (sample.processes === undefined ? "" : `  procs=${sample.processes}`) +
    (sample.servers === undefined ? "" : `  servers=${sample.servers}`)
  );
}

/** Human-readable summary. `topCalls` bounds the ns table; the full list stays
 * on the report for tooling. */
export function formatReport(report: CostReport, topCalls = 20): string {
  const lines = [
    `cost: ${(report.wallMs / 1000).toFixed(1)}s real bought ` +
      `${(report.virtualMs / MS_PER_VIRTUAL_HOUR).toFixed(2)}h virtual ` +
      `(${report.throughput.toFixed(2)} virtual-hours per wall-minute)`,
    `  events=${report.events} (${report.eventsPerWallSecond.toFixed(0)}/s real, ` +
      `${report.usPerEvent.toFixed(1)}us each, ${report.virtualMsPerEvent.toFixed(1)}ms virtual each)`,
    `  queue: heap=${report.heap} cancelled=${report.cancelled}` +
      `   engineCycles=${report.engineCycles}  records=${report.records}  nsCalls=${report.nsCalls}`,
  ];
  const drift = throughputDrift(report.samples);
  if (drift) {
    lines.push(
      `  throughput ${drift.first.toFixed(2)} -> ${drift.last.toFixed(2)} vh/min ` +
        `(first vs last half of ${report.samples.length} samples, ${drift.pct >= 0 ? "+" : ""}${drift.pct.toFixed(0)}%)` +
        (drift.decaying ? "  <- cost grows with run length; suspect frame-rate churn" : ""),
    );
  }
  lines.push(
    `  memory: rss ${formatBytes(report.rssBytes)}, peak ${formatBytes(report.peakRssBytes)}`,
  );
  const growth = rssGrowth(report.samples);
  if (growth) {
    lines.push(
      `  rss ${formatBytes(growth.firstBytes)} -> ${formatBytes(growth.lastBytes)} ` +
        `(${growth.perVirtualHour >= 0 ? "+" : ""}${formatBytes(growth.perVirtualHour)} per virtual hour)` +
        (growth.growing ? "  <- memory grows with run length; the run will not survive a long horizon" : ""),
    );
  }
  if (report.calls.length > 0) {
    lines.push(`  ns calls by name (count, per virtual hour):`);
    for (const call of report.calls.slice(0, topCalls)) {
      lines.push(`    ${call.name.padEnd(34)} ${String(call.count).padStart(9)}  ${call.perVirtualHour.toFixed(0).padStart(9)}/vh`);
    }
    if (report.calls.length > topCalls) lines.push(`    ... ${report.calls.length - topCalls} more`);
  }
  return lines.join("\n");
}

export type StopReason = "goal" | "budget" | "memory";

/** The pump's per-event guard: goal check, wall-clock budget, memory budget and
 * cost sampling in one predicate, because `Clock.runAsync` calls `until`
 * exactly once per event and that is the only hook the pump offers.
 *
 * `realNowMs()` and the RSS probe are read once every `CHECK_EVERY` events
 * rather than every event. At the event rates this harness exists to measure, a
 * clock read per event is itself a measurable slice of the profile — the
 * instrument would become part of what it reports. */
const CHECK_EVERY = 0x3ff;

export function pumpGuard(options: {
  goalDone: () => boolean;
  wallBudgetMs?: number;
  /** Stop the pump when the process holds more than this, rather than letting
   * the host's OOM killer or a segfault end the run with nothing written.
   * Per PROCESS: a multi-seed profile fans out to one child per seed, so the
   * host total is seeds x budget. */
  memoryBudgetBytes?: number;
  meter?: CostMeter;
  /** Injectable for tests, exactly as `CollectionPacer` takes them. */
  rssBytes?: () => number;
  collect?: (force: boolean) => void;
}): { until: () => boolean; stoppedBy: () => StopReason; stoppedAtBytes: () => number } {
  const { goalDone, wallBudgetMs, memoryBudgetBytes, meter } = options;
  const readRss = options.rssBytes ?? processRssBytes;
  const collect = options.collect
    ?? (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
  const deadline = wallBudgetMs === undefined ? undefined : realNowMs() + wallBudgetMs;
  const sampling = deadline !== undefined || memoryBudgetBytes !== undefined || meter !== undefined;
  let stopped: StopReason = "goal";
  let stoppedAt = 0;
  let events = 0;

  return {
    until: () => {
      if (((events++ & CHECK_EVERY) === 0) && sampling) {
        const wallNow = realNowMs();
        meter?.tick(wallNow);
        if (deadline !== undefined && wallNow >= deadline) {
          stopped = "budget";
          return true;
        }
        if (memoryBudgetBytes !== undefined && readRss() >= memoryBudgetBytes) {
          // Collect once and look again before killing a healthy run. The
          // collection pacer only forces a sweep on 512 MB of GROWTH, so a
          // reading over the budget may be garbage that nothing has swept yet
          // — and a budget that stopped runs on uncollected garbage would be a
          // worse instrument than no budget at all. One collection, one
          // re-read, then decide; never a loop.
          collect?.(true);
          const after = readRss();
          if (after >= memoryBudgetBytes) {
            stopped = "memory";
            stoppedAt = after;
            return true;
          }
        }
      }
      return goalDone();
    },
    stoppedBy: () => stopped,
    stoppedAtBytes: () => stoppedAt,
  };
}

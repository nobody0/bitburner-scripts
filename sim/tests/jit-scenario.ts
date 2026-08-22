import { runGame, type GameRunOptions, type GameRunResult } from "../game-run.ts";
import { AGGREGATE_GO_MODEL } from "../fidelity.ts";

export interface LandingErrorSample {
  meanMs: number;
  minMs: number;
  maxMs: number;
  maxAbsMs: number;
}

export interface JitSample {
  atMs: number;
  target?: string;
  segOrder: string[];
  farmGb: number;
  prepGb: number;
  shareGb: number;
  freeGb: number;
  reserveGb: number;
  allocFails: number;
  allocFailsByPhase: { jit: number; prep: number; eager: number };
  batchesSkipped: number;
  missedWindow: { deadline: number; "arrival-security": number; "arrival-money": number; placement: number };
  /** Observed minus planned landing, ms. Absent until an op has landed. */
  landingError?: LandingErrorSample;
  /** The same distribution split by kind. The aggregate cannot tell "one role
   * is systematically off" from "everything jitters", and those have opposite
   * causes. A multiplier step is the sharpest example: grow and weaken are 3.2x
   * and 4x the hack time, so planning on a stale `speedDenom` moves a weaken
   * FOUR TIMES as far as its own batch's hack, which shears the landing order
   * apart. Aggregate mean hides it; this split is the signature. */
  landingErrorByKind?: Partial<Record<"hack" | "grow" | "weaken", LandingErrorSample>>;
  inFlightHack: number;
  inFlightGrow: number;
  inFlightWeaken: number;
  launchedHack: number;
  landedHack: number;
  earned: number;
  fleetGb: number;
  homeGb: number;
  depthCapGb: number;
  security?: number;
  minSecurity?: number;
  money?: number;
  moneyMax?: number;
}

export interface SkillSample {
  atMs: number;
  hacking: number;
  exp: number;
  hackingSpeed: number;
  hackingLevel: number;
}

export interface TargetSwitch {
  atMs: number;
  from: string;
  to: string;
  before?: JitSample;
}

export interface InfrastructureChange {
  atMs: number;
  kind: "buyServer" | "upgradeServer" | "upgradeHomeRam";
  ram: number;
  launchedHack: number;
}

export interface GoGame {
  atMs: number;
  opponent: string;
  won: boolean;
}

export interface JitRun {
  result: GameRunResult;
  samples: JitSample[];
  switches: TargetSwitch[];
  infrastructure: InfrastructureChange[];
  skills: SkillSample[];
  goGames: GoGame[];
}

export interface JitMetrics {
  medianIdleShare: number;
  windowCompletion: number;
  moneyPerSec: number;
  launchedHacks: number;
  landedHacks: number;
  steadySamples: number;
}

type JitRunOptions = Omit<GameRunOptions, "telemetry" | "onRecord">;

/** Collect only state the real controller already publishes. Telemetry must be
 * enabled: with the sink disabled, farm/fleet records never reach a scenario. */
export async function runJitScenario(options: JitRunOptions): Promise<JitRun> {
  const samples: JitSample[] = [];
  const switches: TargetSwitch[] = [];
  const infrastructure: InfrastructureChange[] = [];
  const skills: SkillSample[] = [];
  const goGames: GoGame[] = [];
  let fleetGb = 0;
  let homeGb = options.homeRam ?? 0;
  let last: JitSample | undefined;

  const result = await runGame({
    // Collapse Go to its seeded aggregate outcome unless a scenario asks
    // otherwise. `action-exact` (the runGame default) drives the real V9
    // policy through a browser Worker doing WebGPU inference, which does not
    // exist under Bun: the worker never answers, `neuralRuntime.install`
    // never settles, and the Go feature retries every five seconds for the
    // whole run without ever making a move. A fixture whose premise is a Go
    // reward then fails on a premise that never fired, and every other
    // fixture pays the stalled turn as wall-clock.
    //
    // This is the documented division of labour, not a workaround:
    // sim/fidelity.ts states that full-route simulations collapse the
    // trained policy's per-move interior to a seeded outcome calibrated by
    // GO_REWARD_RULES, while exact action parity and WebGPU strength belong
    // to the arena lane. `sim/run.ts` already passes this for every profile
    // run; the scenario harness simply never did.
    goFidelity: AGGREGATE_GO_MODEL,
    ...options,
    telemetry: true,
    onRecord: (line: string) => {
      let record: {
        kind?: string;
        key?: string;
        name?: string;
        t?: number;
        data?: Record<string, unknown>;
      };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        return;
      }
      const atMs = record.t ?? 0;
      if (record.kind === "event" && record.name === "go.game") {
        const opponent = typeof record.data?.opponent === "string" ? record.data.opponent : "";
        const won = record.data?.won === true;
        goGames.push({ atMs, opponent, won });
        return;
      }
      if (record.kind === "event" && record.name === "farm.targetSwitch") {
        const from = typeof record.data?.from === "string" ? record.data.from : "";
        const to = typeof record.data?.to === "string" ? record.data.to : "";
        if (from && to && from !== to) switches.push({ atMs, from, to, ...(last ? { before: last } : {}) });
        return;
      }
      if (
        record.kind === "event"
        && (record.name === "buyServer" || record.name === "upgradeServer" || record.name === "upgradeHomeRam")
      ) {
        const data = record.data ?? {};
        const ram = typeof data.ram === "number"
          ? data.ram
          : typeof data.maxRam === "number"
            ? data.maxRam
            : 0;
        infrastructure.push({
          atMs,
          kind: record.name,
          ram,
          launchedHack: last?.launchedHack ?? 0,
        });
        return;
      }
      if (record.kind !== "state") return;
      if (record.key === "getPlayer") {
        const data = record.data as {
          skills?: { hacking?: number };
          exp?: { hacking?: number };
          mults?: { hacking_speed?: number; hacking?: number };
        } | undefined;
        const hacking = data?.skills?.hacking;
        const exp = data?.exp?.hacking;
        const hackingSpeed = data?.mults?.hacking_speed ?? 1;
        const hackingLevel = data?.mults?.hacking ?? 1;
        if (typeof hacking === "number" && typeof exp === "number") {
          const previous = skills.at(-1);
          if (!previous || previous.hacking !== hacking || previous.exp !== exp
            || previous.hackingSpeed !== hackingSpeed || previous.hackingLevel !== hackingLevel) {
            skills.push({ atMs, hacking, exp, hackingSpeed, hackingLevel });
          }
        }
        return;
      }
      if (record.key === "fleet") {
        if (typeof record.data?.maxRam === "number") fleetGb = record.data.maxRam;
        const home = record.data?.home as { maxRam?: number } | undefined;
        if (typeof home?.maxRam === "number") homeGb = home.maxRam;
        return;
      }
      if (record.key !== "farm") return;
      const data = record.data as {
        target?: string;
        segOrder?: string[];
        ramPie?: { farm?: number; prep?: number; share?: number; free?: number; reserve?: number };
        allocFails?: number;
        allocFailsByPhase?: { jit?: number; prep?: number; eager?: number };
        batchesSkipped?: number;
        missedWindow?: { deadline?: number; "arrival-security"?: number; "arrival-money"?: number; placement?: number };
        landingError?: { meanMs?: number; minMs?: number; maxMs?: number; maxAbsMs?: number };
        landingErrorByKind?: Partial<Record<"hack" | "grow" | "weaken", {
          meanMs?: number; minMs?: number; maxMs?: number; maxAbsMs?: number;
        }>>;
        inFlight?: { hack?: number; grow?: number; weaken?: number };
        launched?: { hack?: number };
        landed?: { hack?: number };
        totals?: { moneyEarned?: number };
        depthCapGb?: number;
        security?: number;
        minSecurity?: number;
        money?: number;
        moneyMax?: number;
      } | undefined;
      if (!data) return;
      last = {
        atMs,
        target: data.target ?? last?.target,
        segOrder: data.segOrder ?? last?.segOrder ?? [],
        farmGb: data.ramPie?.farm ?? last?.farmGb ?? 0,
        prepGb: data.ramPie?.prep ?? last?.prepGb ?? 0,
        shareGb: data.ramPie?.share ?? last?.shareGb ?? 0,
        freeGb: data.ramPie?.free ?? last?.freeGb ?? 0,
        reserveGb: data.ramPie?.reserve ?? last?.reserveGb ?? 0,
        allocFails: data.allocFails ?? last?.allocFails ?? 0,
        allocFailsByPhase: {
          jit: data.allocFailsByPhase?.jit ?? last?.allocFailsByPhase.jit ?? 0,
          prep: data.allocFailsByPhase?.prep ?? last?.allocFailsByPhase.prep ?? 0,
          eager: data.allocFailsByPhase?.eager ?? last?.allocFailsByPhase.eager ?? 0,
        },
        batchesSkipped: data.batchesSkipped ?? last?.batchesSkipped ?? 0,
        missedWindow: {
          deadline: data.missedWindow?.deadline ?? last?.missedWindow.deadline ?? 0,
          "arrival-security": data.missedWindow?.["arrival-security"] ?? last?.missedWindow["arrival-security"] ?? 0,
          "arrival-money": data.missedWindow?.["arrival-money"] ?? last?.missedWindow["arrival-money"] ?? 0,
          placement: data.missedWindow?.placement ?? last?.missedWindow.placement ?? 0,
        },
        ...(data.landingError
          ? { landingError: {
              meanMs: data.landingError.meanMs ?? 0,
              minMs: data.landingError.minMs ?? 0,
              maxMs: data.landingError.maxMs ?? 0,
              maxAbsMs: data.landingError.maxAbsMs ?? 0,
            } }
          : last?.landingError !== undefined ? { landingError: last.landingError } : {}),
        ...(data.landingErrorByKind
          ? { landingErrorByKind: Object.fromEntries(
              (["hack", "grow", "weaken"] as const)
                .map((kind) => [kind, data.landingErrorByKind?.[kind]] as const)
                .filter((entry): entry is readonly [typeof entry[0], NonNullable<typeof entry[1]>] =>
                  entry[1] !== undefined)
                .map(([kind, d]) => [kind, {
                  meanMs: d.meanMs ?? 0,
                  minMs: d.minMs ?? 0,
                  maxMs: d.maxMs ?? 0,
                  maxAbsMs: d.maxAbsMs ?? 0,
                }]),
            ) }
          : last?.landingErrorByKind !== undefined
            ? { landingErrorByKind: last.landingErrorByKind }
            : {}),
        inFlightHack: data.inFlight?.hack ?? last?.inFlightHack ?? 0,
        inFlightGrow: data.inFlight?.grow ?? last?.inFlightGrow ?? 0,
        inFlightWeaken: data.inFlight?.weaken ?? last?.inFlightWeaken ?? 0,
        launchedHack: data.launched?.hack ?? last?.launchedHack ?? 0,
        landedHack: data.landed?.hack ?? last?.landedHack ?? 0,
        earned: data.totals?.moneyEarned ?? last?.earned ?? 0,
        fleetGb,
        homeGb,
        depthCapGb: data.depthCapGb ?? last?.depthCapGb ?? 0,
        ...(data.security !== undefined ? { security: data.security } : last?.security !== undefined ? { security: last.security } : {}),
        ...(data.minSecurity !== undefined ? { minSecurity: data.minSecurity } : last?.minSecurity !== undefined ? { minSecurity: last.minSecurity } : {}),
        ...(data.money !== undefined ? { money: data.money } : last?.money !== undefined ? { money: last.money } : {}),
        ...(data.moneyMax !== undefined ? { moneyMax: data.moneyMax } : last?.moneyMax !== undefined ? { moneyMax: last.moneyMax } : {}),
      };
      samples.push(last);
    },
  });

  return { result, samples, switches, infrastructure, skills, goGames };
}

export function peakUsableGb(samples: readonly JitSample[]): number {
  return Math.max(0, ...samples.map((sample) =>
    sample.farmGb + sample.prepGb + sample.shareGb + sample.freeGb
  ));
}

export interface JitPressure {
  peakUsableGb: number;
  summedTargetDemandGb: number;
  demandByTarget: Map<string, number>;
}

export function observedTargetDemand(
  samples: readonly JitSample[],
  fromMs = 0,
): Map<string, number> {
  const demand = new Map<string, number>();
  for (const sample of samples) {
    if (sample.atMs < fromMs || !sample.target || sample.depthCapGb <= 0) continue;
    demand.set(sample.target, Math.min(demand.get(sample.target) ?? Infinity, sample.depthCapGb));
  }
  return demand;
}

export function jitPressure(samples: readonly JitSample[], fromMs = 0): JitPressure {
  const steady = samples.filter((sample) => sample.atMs >= fromMs);
  const demandByTarget = observedTargetDemand(steady);
  return {
    peakUsableGb: peakUsableGb(steady),
    summedTargetDemandGb: [...demandByTarget.values()].reduce((sum, gb) => sum + gb, 0),
    demandByTarget,
  };
}

export function formatJitPressure(name: string, pressure: JitPressure): string {
  const demand = [...pressure.demandByTarget]
    .map(([target, gb]) => target + "=" + gb.toFixed(1) + "GB")
    .join(",");
  return "[" + name + "] demand={" + demand + "} sum="
    + pressure.summedTargetDemandGb.toFixed(1) + "GB peak-usable="
    + pressure.peakUsableGb.toFixed(1) + "GB";
}

/** Score all three dimensions together. Idle RAM alone is not success: a JIT
 * batch commits future launch windows before all of its RAM is resident, so a
 * non-yielding tenant can look busy while destroying completion and income.
 * Completion uses cumulative landed/launched hacks; income uses only the
 * explicit steady window so startup prep cannot disguise a flat tail. */
export function jitMetrics(samples: readonly JitSample[], steadyFromMs: number): JitMetrics {
  const steady = samples.filter((sample) => sample.atMs >= steadyFromMs);
  if (steady.length < 2) throw new Error(`steady window has only ${steady.length} farm samples`);
  const idleShares = steady.map((sample) => {
    const usable = sample.farmGb + sample.prepGb + sample.shareGb + sample.freeGb;
    return usable > 0 ? sample.freeGb / usable : 0;
  }).sort((a, b) => a - b);
  const first = steady[0]!;
  const final = steady[steady.length - 1]!;
  const elapsedSec = (final.atMs - first.atMs) / 1_000;
  return {
    medianIdleShare: idleShares[Math.floor(idleShares.length / 2)] ?? 1,
    windowCompletion: final.launchedHack > 0 ? final.landedHack / final.launchedHack : 0,
    moneyPerSec: elapsedSec > 0 ? (final.earned - first.earned) / elapsedSec : 0,
    launchedHacks: final.launchedHack,
    landedHacks: final.landedHack,
    steadySamples: steady.length,
  };
}

export function formatJitMetrics(name: string, metrics: JitMetrics): string {
  return [
    `[${name}]`,
    `idle=${metrics.medianIdleShare.toFixed(6)}`,
    `windows=${metrics.windowCompletion.toFixed(6)} (${metrics.landedHacks}/${metrics.launchedHacks})`,
    `money/sec=$${metrics.moneyPerSec.toExponential(6)}`,
    `samples=${metrics.steadySamples}`,
  ].join(" ");
}

/* ------------------------------------------------------------------------ *
 * THE BASELINE RATCHET
 *
 * The recorded numbers in sim/tests/baselines/jit.json are the proof that each
 * step along the way actually moved the needle. This is the machinery that
 * makes them behave like a ratchet instead of like six hand-maintained magic
 * constants: a regression fails and says which metric moved and by how much,
 * an improvement passes and prints exactly what to record.
 * ------------------------------------------------------------------------ */

export interface JitBaseline {
  medianIdleShare: number;
  windowCompletion: number;
  moneyPerSec: number;
  /** Only the target-switch fixture measures this. */
  switchIncomeRetention?: number;
  /** Per-scenario slack, overriding the file default metric by metric. A
   * fixture whose horizon truncates in-flight hacks legitimately needs a
   * different window tolerance than one that runs to steady state. */
  tolerances?: Partial<JitTolerances> & { switchIncomeRetention?: number };
  note?: string;
}

export interface JitTolerances {
  /** Absolute slack on the two share metrics. */
  idleShare: number;
  windowCompletion: number;
  /** Fractional slack on money: 0.05 allows landing 5% under the record. */
  moneyFraction: number;
  /** Absolute slack on the target-switch retention metric. */
  switchIncomeRetention?: number;
  /** Fractional slack on skipped batches, for fixtures that ratchet it. */
  batchesSkippedFraction?: number;
}

export interface JitBaselineFile {
  provenance: {
    simulatorModelVersion: number;
    vendorCommit: string;
    recordedAt: string;
  };
  tolerances: JitTolerances;
  scenarios: Record<string, JitBaseline>;
}

/** Whether a metric is better when it rises or when it falls. Idle RAM is the
 * odd one out and getting its direction wrong would silently invert the whole
 * ratchet, so the direction is data rather than a sign convention. */
const DIRECTION = {
  medianIdleShare: "lower",
  windowCompletion: "higher",
  moneyPerSec: "higher",
  switchIncomeRetention: "higher",
  // Only meaningful where a fixture is deliberately over-subscribed. There,
  // refusing to launch a batch that will not fit is CORRECT back-pressure
  // (`allocFails` stays the atomicity invariant), so the count belongs on the
  // ratchet — it must never grow — rather than pinned to a constant that only
  // ever held for an uncontended world.
  batchesSkipped: "lower",
} as const;

export interface BaselineVerdict {
  /** Metrics that fell outside tolerance. Empty means the run held the line. */
  regressions: string[];
  /** Metrics that beat the record outright, with the values to record. */
  improvements: { metric: string; from: number; to: number }[];
}

/** Compare a run against its recorded best. Pure: it decides nothing about
 * failing, so a caller can report every metric at once rather than aborting on
 * the first bad one. */
export function compareToBaseline(
  observed: Record<string, number | undefined>,
  baseline: JitBaseline,
  tolerances: JitTolerances,
): BaselineVerdict {
  const regressions: string[] = [];
  const improvements: { metric: string; from: number; to: number }[] = [];

  for (const [metric, direction] of Object.entries(DIRECTION)) {
    const record = (baseline as unknown as Record<string, number | undefined>)[metric];
    const value = observed[metric];
    if (record === undefined || value === undefined) continue;

    // A scenario's own tolerance wins over the file default, metric by metric.
    const limits: JitTolerances = { ...tolerances, ...baseline.tolerances };
    const slack = metric === "moneyPerSec"
      ? Math.abs(record) * limits.moneyFraction
      : metric === "medianIdleShare"
        ? limits.idleShare
        : metric === "switchIncomeRetention"
          ? limits.switchIncomeRetention ?? limits.windowCompletion
          : metric === "batchesSkipped"
            ? Math.abs(record) * (limits.batchesSkippedFraction ?? limits.moneyFraction)
            : limits.windowCompletion;

    if (direction === "lower") {
      if (value > record + slack) {
        regressions.push(
          `${metric}: ${value.toPrecision(6)} is worse than the recorded ${record.toPrecision(6)}`
          + ` by ${(value - record).toPrecision(3)} (tolerance ${slack.toPrecision(3)})`,
        );
      } else if (value < record) {
        improvements.push({ metric, from: record, to: value });
      }
    } else {
      if (value < record - slack) {
        regressions.push(
          `${metric}: ${value.toPrecision(6)} is worse than the recorded ${record.toPrecision(6)}`
          + ` by ${(record - value).toPrecision(3)} (tolerance ${slack.toPrecision(3)})`,
        );
      } else if (value > record) {
        improvements.push({ metric, from: record, to: value });
      }
    }
  }
  return { regressions, improvements };
}

/** Refuse to compare numbers measured under different simulator semantics. A
 * model-version or vendor bump changes what the simulator DOES, so the old
 * records stop meaning anything; saying so is far better than reporting a
 * regression that is really a change of measuring instrument. */
export function assertBaselineProvenance(
  file: JitBaselineFile,
  modelVersion: number,
  vendorCommit: string,
): void {
  const drift: string[] = [];
  if (file.provenance.simulatorModelVersion !== modelVersion) {
    drift.push(
      `simulator model version ${file.provenance.simulatorModelVersion} -> ${modelVersion}`,
    );
  }
  if (file.provenance.vendorCommit !== vendorCommit) {
    drift.push(`vendor commit ${file.provenance.vendorCommit} -> ${vendorCommit}`);
  }
  if (drift.length === 0) return;
  throw new Error(
    `sim/tests/baselines/jit.json was recorded under different simulator semantics (${drift.join("; ")}).\n`
    + "Those numbers are no longer comparable. Re-measure every JIT scenario and "
    + "update both the scenario rows and `provenance` in the same commit.",
  );
}

/** What to change in the ledger after a genuine improvement. Only the metrics
 * that actually moved: the prose around them (`what`, `history`, `note`) is
 * hand-written context that a machine has no business regenerating. */
export function formatBaselineUpdate(
  scenario: string,
  improvements: BaselineVerdict["improvements"],
): string {
  const lines = improvements.map(
    ({ metric, from, to }) => `    ${metric}: ${from} -> ${to}`,
  );
  return [
    `[${scenario}] IMPROVED -- update these in sim/tests/baselines/jit.json:`,
    ...lines,
    "    ...and add a history line saying what earned it.",
  ].join("\n");
}

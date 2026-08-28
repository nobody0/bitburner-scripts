import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { makeHackContext } from "../../shared/formulas.ts";
import { staticsFromRolls } from "../../shared/strategy/bounds.ts";
import { solveCycle } from "../../shared/strategy/targeting.ts";
import { HWGW_MIN_INTERVAL_MS, MINIMUM_LANDING_GAP_MS } from "../../shared/strategy/jit.ts";
import { calculateExp } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { SIMULATOR_MODEL_VERSION, SIMULATOR_VENDOR_COMMIT } from "../fidelity.ts";
import type { GameRunOptions } from "../game-run.ts";
import {
  assertBaselineProvenance,
  compareToBaseline,
  formatBaselineUpdate,
  formatJitMetrics,
  formatJitPressure,
  jitMetrics,
  jitPressure,
  runJitScenario,
  type JitBaselineFile,
  type JitMetrics,
  type JitPressure,
  type JitRun,
  type JitSample,
} from "./jit-scenario.ts";
import BASELINES from "./baselines/jit.json" with { type: "json" };

/** THE JIT SCENARIO LADDER.
 *
 * Each row drives the REAL controller through virtual game time against a
 * hand-built world, then measures how well it farmed. Unlike the correctness
 * suite these do not ask "is this function right" — they ask "did we get
 * faster", which is a question only a full run can answer.
 *
 * These were six near-identical files, each carrying its own copy of the run
 * boilerplate and its own hand-maintained RECORDED block. The fixtures and the
 * assertions are unchanged; what moved is the bookkeeping. The recorded numbers
 * now live in `baselines/jit.json` as one ledger, and the comparison runs once
 * here instead of being retyped per file:
 *
 *   - a regression fails and names the metric and the size of the drop;
 *   - an improvement passes and prints exactly what to write into the ledger;
 *   - a scenario with no record yet prints its numbers so the first run
 *     establishes the baseline instead of asserting a guess.
 *
 * That is the workflow the numbers exist for: every change re-runs the ladder
 * and either proves a gain or is caught giving one back. Which is also why the
 * ledger is never edited to make a red lane green — see the rules in the JSON.
 *
 * PROCESS ISOLATION IS PRESERVED. `tools/test-lanes.ts` spawns one Bun process
 * per registered lane CASE, not per file, and each row below calls
 * `scenarioDescribe` separately — so `bun run long --list` reports the same
 * case count as the six files did, and a blown soak still costs exactly that
 * soak. Run them with `bun run long hacking --file scenario-`. */

const baselines = BASELINES as unknown as JitBaselineFile;
assertBaselineProvenance(baselines, SIMULATOR_MODEL_VERSION, SIMULATOR_VENDOR_COMMIT);

/* -------------------------------------------------------------------------- *
 * Shared measurement helpers.
 * -------------------------------------------------------------------------- */

/** Dollars per second earned between two sample times. */
function moneyRate(samples: readonly JitSample[], fromMs: number, toMs: number): number {
  const window = samples.filter((sample) => sample.atMs >= fromMs && sample.atMs <= toMs);
  const first = window[0];
  const last = window.at(-1);
  if (!first || !last || last.atMs <= first.atMs) return 0;
  return (last.earned - first.earned) / ((last.atMs - first.atMs) / 1_000);
}

function sampleAtOrBefore(samples: readonly JitSample[], atMs: number): JitSample | undefined {
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]!;
    if (sample.atMs <= atMs) return sample;
  }
  return undefined;
}

interface SpecLike {
  hostname: string;
  hackDifficulty: number;
  moneyAvailable: number;
  requiredHackingSkill: number;
  serverGrowth: number;
}

/** Solve a fixture's steady-state batch the way the evaluator would, so a
 * scenario can compare what we ACHIEVED against what we PREDICTED. */
function solved(target: SpecLike, skill: number, bitnode: number) {
  const node = getBitNodeMultipliers(bitnode, 1);
  const ctx = makeHackContext({
    skill,
    intelligence: 0,
    mults: {
      hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1,
    },
  }, node);
  const statics = staticsFromRolls(
    target.hostname,
    {
      money: target.moneyAvailable,
      sec: target.hackDifficulty,
      skill: target.requiredHackingSkill,
      growth: target.serverGrowth,
    },
    { ServerMaxMoney: node.ServerMaxMoney, ServerStartingSecurity: node.ServerStartingSecurity },
  );
  return solveCycle(ctx, statics);
}

const shareYields = (run: JitRun): { yielded: number; reclaimed: number } => {
  const shares = run.samples.map((sample) => sample.shareGb);
  const farms = run.samples.map((sample) => sample.farmGb);
  const yielded = shares.filter((share, index) =>
    index > 0 && share < shares[index - 1]! - 1e-9 && farms[index]! > farms[index - 1]! + 1e-9
  ).length;
  const reclaimed = shares.filter((share, index) =>
    index > 0 && share > shares[index - 1]! + 1e-9 && farms[index]! < farms[index - 1]! - 1e-9
  ).length;
  return { yielded, reclaimed };
};

/* -------------------------------------------------------------------------- *
 * The table driver.
 * -------------------------------------------------------------------------- */

interface Scenario {
  /** Ledger key in baselines/jit.json, and the log prefix. */
  id: string;
  /** Lane case name — this is what the runner spawns a process for. */
  title: string;
  what: string;
  /** When the pipeline has reached steady state and metrics start counting. */
  steadyFromMs: number;
  /** Where the PRESSURE window starts. Several fixtures deliberately measure
   * demand earlier than income: demand is a premise check ("is this fixture
   * actually contended?") and is most honest while the fleet is still small,
   * whereas income needs the pipeline settled first. Defaults to steadyFromMs. */
  pressureFromMs?: number;
  timeoutMs: number;
  options: Omit<GameRunOptions, "telemetry" | "onRecord">;
  /** The facts that make THIS fixture the thing it claims to be. Returns any
   *  extra measured values to compare against the ledger. */
  structural: (
    run: JitRun,
    metrics: JitMetrics,
    pressure: JitPressure,
  ) => Record<string, number | undefined> | void;
  /** Set when the scenario documents a gap rather than asserting behaviour. */
}

/** SEED SWEEP MODE. The fixtures pin one seed each, which is the right default:
 * a ratchet needs the same world every run. But a single seed cannot tell a real
 * regression from compounding chaos -- the ledger says so itself, in
 * jit-share-churn history -- so this hook re-runs any case on another seed.
 *
 * It is inert unless BB_JIT_SEED is set, and it can never move a baseline: on a
 * swept seed the run prints its metrics and returns BEFORE compareToBaseline,
 * because a record measured on seed X says nothing about seed Y in either
 * direction. BB_RECORD_BASELINES remains the only path that emits a ledger
 * block, and the sweep path never reaches it. Structural assertions DO still
 * run and still fail -- they are the fixture's premises rather than its
 * ratchet -- but the sweep line is printed before the failure escapes. */
const SWEEP_SEED: number | undefined = (() => {
  const raw = process.env.BB_JIT_SEED;
  if (raw === undefined || raw === "") return undefined;
  const seed = Number(raw);
  if (!Number.isFinite(seed)) throw new Error(`BB_JIT_SEED is not a number: ${raw}`);
  return seed;
})();

function runScenario(scenario: Scenario): void {
  scenarioDescribe(scenario.title, () => {
    const body = async (): Promise<void> => {
      const run = await runJitScenario(
        SWEEP_SEED === undefined ? scenario.options : { ...scenario.options, seed: SWEEP_SEED },
      );
      const metrics = jitMetrics(run.samples, scenario.steadyFromMs);
      const pressure = jitPressure(run.samples, scenario.pressureFromMs ?? scenario.steadyFromMs);

      console.info(formatJitMetrics(scenario.id, metrics));
      console.info(formatJitPressure(scenario.id, pressure));

      // An unmodelled ns path would silently change what we just measured, so
      // this is checked before any number is believed.
      expect(run.result.validity).not.toBe("invalid-for-goal");

      // Reported in a `finally` because several fixtures assert premises that
      // only hold on their pinned seed (a fleet rung reached, a migration
      // happening). On a swept seed those throw, and the sweep line is the one
      // thing the run existed to produce -- so it is printed either way, and
      // the failure still propagates.
      let extra: Record<string, number | undefined> = {};
      try {
        extra = scenario.structural(run, metrics, pressure) ?? {};
      } finally {
        if (SWEEP_SEED !== undefined) {
          // Off-record seed: report, do not ratchet. See SWEEP_SEED above.
          console.info(
            `[${scenario.id}] SEED SWEEP seed=${SWEEP_SEED} `
            + JSON.stringify({
              medianIdleShare: metrics.medianIdleShare,
              windowCompletion: metrics.windowCompletion,
              moneyPerSec: metrics.moneyPerSec,
              ...extra,
            }),
          );
        }
      }

      const observed = {
        medianIdleShare: metrics.medianIdleShare,
        windowCompletion: metrics.windowCompletion,
        moneyPerSec: metrics.moneyPerSec,
        ...extra,
      };

      if (SWEEP_SEED !== undefined) return;

      const baseline = baselines.scenarios[scenario.id];
      const recorded = baseline !== undefined
        && (baseline.moneyPerSec !== undefined || baseline.medianIdleShare !== undefined);
      if (!recorded) {
        // Nothing to ratchet against yet. Print, do not invent a threshold:
        // a made-up baseline is worse than an honest blank one.
        console.info(
          `[${scenario.id}] NO BASELINE RECORDED YET -- put these in sim/tests/baselines/jit.json:\n`
          + `  ${JSON.stringify(observed, null, 2).replaceAll("\n", "\n  ")}`,
        );
        return;
      }

      const verdict = compareToBaseline(observed, baseline, baselines.tolerances);
      if (verdict.improvements.length > 0) {
        console.info(formatBaselineUpdate(scenario.id, verdict.improvements));
        if (process.env.BB_RECORD_BASELINES === "1") {
          console.info(`[${scenario.id}] BB_RECORD_BASELINES=1 -- copy the block above into the ledger.`);
        }
      }
      // Reported together: knowing that two metrics moved is worth far more
      // than being told about the first one and having to re-run for the rest.
      expect(verdict.regressions.join("\n")).toBe("");
    };

    test(scenario.what, body, scenario.timeoutMs);
  });
}

/* -------------------------------------------------------------------------- *
 * Fixtures.
 * -------------------------------------------------------------------------- */

const org = "scenario";

const SMALL_FLEET = {
  earner: {
    hostname: "smallfleet-earner", organizationName: org,
    hackDifficulty: 1, currentDifficulty: 1,
    moneyAvailable: 200_000, currentMoney: 5_000_000,
    requiredHackingSkill: 1, serverGrowth: 3_000, numOpenPortsRequired: 0, maxRam: 0,
  },
  rival: {
    hostname: "smallfleet-rival", organizationName: org,
    hackDifficulty: 10, moneyAvailable: 2_000_000,
    requiredHackingSkill: 1, serverGrowth: 5, numOpenPortsRequired: 0, maxRam: 16,
  },
  prep: {
    hostname: "smallfleet-prep", organizationName: org,
    hackDifficulty: 20, moneyAvailable: 500_000_000,
    requiredHackingSkill: 1, serverGrowth: 100, numOpenPortsRequired: 0, maxRam: 16,
  },
} as const;

const COMPACT = {
  hostname: "stress-compact", organizationName: org,
  hackDifficulty: 2, moneyAvailable: 1e8,
  requiredHackingSkill: 1, serverGrowth: 20, numOpenPortsRequired: 0,
  maxRam: 4_096, currentDifficulty: 1, currentMoney: 2.5e9,
} as const;
/** The migration prize. Two properties make it one, and both are load-bearing.
 *
 * SKILL GATE. `requiredHackingSkill` sits ABOVE the fixture's starting skill,
 * so at t=0 it is not merely worse — it is ineligible, and the run is forced to
 * open on the compact server. It unlocks a few levels later from the compact
 * farm's own experience, which is how a real BN1 acquires a better target.
 *
 * A GENUINE PRIZE. Its money is large enough that once eligible it wins the
 * ranking outright rather than by a hair. A near-tie made the migration a
 * coin-flip on the exp term: an earlier fixture sat at 0.90x the compact score
 * at skill 250 and only 1.66x at 300, which the composite runtime rate (income
 * PLUS experience, and this server yields 0.59x the exp) never cleared. The
 * scenario then silently measured a farm that never moved.
 *
 * The high required skill is also what makes the batch WIDE: at these levels
 * one batch is ~35x the compact server's, so the migration re-shapes every
 * worker in flight — which is the fragmentation this ladder exists to stress. */
const WIDE = {
  hostname: "stress-wide", organizationName: org,
  hackDifficulty: 2, moneyAvailable: 5e9,
  requiredHackingSkill: 260, serverGrowth: 500, numOpenPortsRequired: 0,
  maxRam: 0, currentDifficulty: 1, currentMoney: 1.25e11,
} as const;
const WIDE_TWIN = { ...WIDE, hostname: "stress-wide-twin" } as const;

const FRAG_PRIMARY = { ...COMPACT, hostname: "fragmentation-compact" } as const;
/** Deliberately LEANER than the stress rival, and the difference is the whole
 * point of this fixture. At the stress server's money the ranking crosses the
 * moment the skill gate opens, so the farm moves at ~1.5 min with barely a
 * pipeline to re-shape. Trimmed to this, the compact server holds the slot for
 * ten minutes of compounding first, and the migration then has to re-shape a
 * mature pipeline — 81 GB workers to ~2.9 TB ones — against a fleet whose slabs
 * fit the earlier shape. That is the fragmentation being measured, and
 * it is why this row costs minutes of wall clock where the others cost seconds. */
const FRAG_RIVAL = { ...WIDE, hostname: "fragmentation-wide", moneyAvailable: 4e9, currentMoney: 1e11 } as const;

const JUMP_PRIMARY = {
  hostname: "skill-jump-primary", organizationName: org,
  hackDifficulty: 30, moneyAvailable: 1e8,
  requiredHackingSkill: 1, serverGrowth: 100, numOpenPortsRequired: 0,
  maxRam: 8_192, currentDifficulty: 10, currentMoney: 2.5e9,
} as const;
const JUMP_SECONDARY = { ...JUMP_PRIMARY, hostname: "skill-jump-secondary" } as const;
const JUMP_AWARD = {
  hostname: "skill-jump-award", organizationName: org,
  hackDifficulty: 20, moneyAvailable: 1e12,
  requiredHackingSkill: 1_000, serverGrowth: 100, numOpenPortsRequired: 0,
  maxRam: 0, currentDifficulty: 6.67, currentMoney: 2.5e13,
} as const;

const SWITCH_PRIMARY = {
  hostname: "switch-primary", organizationName: org,
  hackDifficulty: 2, moneyAvailable: 500,
  requiredHackingSkill: 1, serverGrowth: 200, numOpenPortsRequired: 0,
  // A fixed slab supplies the whole run; low target money prevents purchases.
  maxRam: 3_072, currentDifficulty: 1, currentMoney: 12_500,
} as const;
const SWITCH_RIVAL = {
  hostname: "switch-rival", organizationName: org,
  hackDifficulty: 2, moneyAvailable: 800,
  requiredHackingSkill: 1, serverGrowth: 200, numOpenPortsRequired: 0,
  maxRam: 0, currentDifficulty: 1,
  // The simulator derives max money as 25x moneyAvailable: 15k/20k is cold.
  currentMoney: 15_000,
} as const;

const CHURN_TARGET = {
  hostname: "share-churn-target", organizationName: org,
  hackDifficulty: 3, currentDifficulty: 1,
  moneyAvailable: 1e8, currentMoney: 2.5e9,
  requiredHackingSkill: 1, serverGrowth: 100, numOpenPortsRequired: 0, maxRam: 0,
} as const;

const SOLO = {
  hostname: "solo-target", organizationName: org,
  hackDifficulty: 3, currentDifficulty: 1,
  moneyAvailable: 1e8, currentMoney: 2.5e9,
  requiredHackingSkill: 1, serverGrowth: 100, numOpenPortsRequired: 0, maxRam: 0,
} as const;

const star = (...hosts: { hostname: string }[]): Record<string, readonly string[]> => ({
  home: hosts.map((host) => host.hostname),
  ...Object.fromEntries(hosts.map((host) => [host.hostname, ["home"]])),
});
/* -------------------------------------------------------------------------- *
 * The ladder.
 * -------------------------------------------------------------------------- */

/** SMALL FLEET — the early BN1 scheduling regime. One atomic farm block is a
 * material fraction of the 32 GB home, infrastructure grows through small
 * rungs, and prep plus the dodge arena contend with farm for the same
 * executable slabs. The full share-capable feature set is enabled, but its
 * measured allotment stays zero here exactly as it does in BN1 seed 1, so the
 * fixture does not fabricate share pressure. */
runScenario({
  id: "jit-small-fleet",
  title: "scenario: JIT on a small contended fleet",
  what: "keeps current farm windows alive while the fleet compounds",
  steadyFromMs: 10 * 60_000,
  timeoutMs: 180_000,
  options: {
    goal: parseGoals(["rep:CyberSec:1e12", "earn:1e30"]),
    seed: 1,
    horizonMs: 45 * 60_000,
    bitnode: 1,
    homeRam: 32,
    startingMoney: 1_000_000,
    person: { skills: { hacking: 127 }, exp: { hacking: calculateExp(127) } },
    playerState: { factions: ["CyberSec"], ownedSourceFiles: { "4": 3 } },
    factions: { CyberSec: { rep: 0, favor: 0 } },
    features: only("hacking", "factions", "career", "progression", "go", "hacknet", "stock"),
    network: [SMALL_FLEET.earner, SMALL_FLEET.rival, SMALL_FLEET.prep] as never,
    topology: star(SMALL_FLEET.earner, SMALL_FLEET.rival, SMALL_FLEET.prep),
  },
  structural: (run, metrics) => {
    const final = run.samples.at(-1)!;
    const positiveFleet = run.samples.map((sample) => sample.fleetGb).filter((gb) => gb > 0);
    const minFleetGb = Math.min(...positiveFleet);
    const peakFleetGb = Math.max(...run.samples.map((sample) => sample.fleetGb));
    const maxShareGb = Math.max(...run.samples.map((sample) => sample.shareGb));
    const maxPrepGb = Math.max(...run.samples.map((sample) => sample.prepGb));
    const maxReserveGb = Math.max(...run.samples.map((sample) => sample.reserveGb));
    const farmAndPrep = run.samples.some((sample) => sample.farmGb > 0 && sample.prepGb > 0);

    console.info(
      `[jit-small-fleet] home=${final.homeGb}GB fleet=${minFleetGb}..${peakFleetGb}GB`
      + ` infrastructure=${run.infrastructure.length} prep-max=${maxPrepGb}GB`
      + ` share-max=${maxShareGb}GB arena-max=${maxReserveGb}GB`
      + ` segOrder=${final.segOrder.join(">")} allocFails=${final.allocFails}`
      + ` batchesSkipped=${final.batchesSkipped}`,
    );
    console.info(
      `[jit-small-fleet] DIAG target=${final.target} depthCap=${final.depthCapGb.toFixed(1)}GB`
      + ` missed=${JSON.stringify(final.missedWindow)}`
      + ` allocFailsByPhase=${JSON.stringify(final.allocFailsByPhase)}`
      + ` launched=${final.launchedHack} landed=${final.landedHack}`
      + ` farm=${final.farmGb.toFixed(1)} prep=${final.prepGb.toFixed(1)}`
      + ` free=${final.freeGb.toFixed(1)} reserve=${final.reserveGb.toFixed(1)}`
      + ` infra=${run.infrastructure.map((event) => `${event.kind}:${event.ram}`).join(",")}`,
    );

    expect(run.infrastructure.length).toBeGreaterThan(0);
    expect(minFleetGb).toBeLessThanOrEqual(128);
    expect(peakFleetGb).toBeGreaterThan(128);
    expect(maxPrepGb).toBeGreaterThan(0);
    expect(maxShareGb).toBe(0);
    expect(maxReserveGb).toBeGreaterThan(0);
    expect(farmAndPrep).toBe(true);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(final.batchesSkipped).toBeLessThanOrEqual(4);
  },
});

/** STRESS — target, share and fleet all moving at once. */
runScenario({
  id: "jit-stress",
  title: "scenario: JIT under combined stress",
  what: "holds utilisation, windows, and income while target, share, and fleet move",
  steadyFromMs: 10 * 60_000,
  pressureFromMs: 60_000,
  timeoutMs: 180_000,
  options: {
    goal: parseGoals(["rep:CyberSec:1e12", "earn:1e30"]),
    seed: 1,
    horizonMs: 30 * 60_000,
    bitnode: 4,
    homeRam: 128,
    startingMoney: 5e7,
    person: { skills: { hacking: 250 }, exp: { hacking: 6_250_000 } },
    playerState: { factions: ["CyberSec"] },
    factions: { CyberSec: { rep: 0, favor: 0 } },
    features: only("hacking", "factions", "career", "progression"),
    network: [COMPACT, WIDE, WIDE_TWIN] as never,
    topology: star(COMPACT, WIDE, WIDE_TWIN),
  },
  structural: (run, metrics, pressure) => {
    const final = run.samples.at(-1)!;
    const switched = run.switches.find((event) =>
      event.from === COMPACT.hostname
      && (event.to === WIDE.hostname || event.to === WIDE_TWIN.hostname)
    );
    const postLaunch = run.infrastructure.filter((event) => event.launchedHack > 0);
    const { yielded, reclaimed } = shareYields(run);
    const maxShareGb = Math.max(...run.samples.map((sample) => sample.shareGb));
    const wideDemand = Math.max(
      pressure.demandByTarget.get(WIDE.hostname) ?? 0,
      pressure.demandByTarget.get(WIDE_TWIN.hostname) ?? 0,
    );
    const offeredDemandGb = pressure.summedTargetDemandGb + wideDemand;
    const starved = run.samples.filter(
      (sample) => sample.atMs >= 10 * 60_000 && sample.farmGb === 0,
    );

    console.info(
      `[jit-stress] offered-demand=${offeredDemandGb.toFixed(1)}GB`
      + ` switch=${(switched?.atMs ?? 0) / 1_000}s share=0..${maxShareGb}GB`
      + ` yielded=${yielded} reclaimed=${reclaimed}`
      + ` infrastructure=${run.infrastructure.length} post-launch=${postLaunch.length}`
      + ` fleet=${final.fleetGb}GB allocFails=${final.allocFails}`,
    );

    expect(switched).toBeDefined();
    expect(postLaunch.some(
      (event) => event.kind === "buyServer" || event.kind === "upgradeServer",
    )).toBe(true);
    expect(postLaunch.some((event) => event.kind === "upgradeHomeRam")).toBe(true);
    expect(maxShareGb).toBeGreaterThan(0);
    expect(yielded).toBeGreaterThan(0);
    expect(reclaimed).toBeGreaterThan(0);
    expect(starved).toHaveLength(0);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(wideDemand).toBeGreaterThan(0);
    expect(offeredDemandGb).toBeGreaterThan(pressure.peakUsableGb);
    expect(final.allocFails).toBeLessThanOrEqual(1);
  },
});

/** FRAGMENTATION — retargeting across different worker shapes while the fleet's
 * slab structure changes underneath the pipeline. */
runScenario({
  id: "jit-fragmentation",
  title: "scenario: JIT fragmentation",
  what: "retargets across different worker shapes while fleet slabs change",
  steadyFromMs: 5 * 60_000,
  pressureFromMs: 60_000,
  // The mid-run retarget makes this a long-running fragmentation case.
  timeoutMs: 600_000,
  options: {
    goal: parseGoals(["earn:1e30"]),
    seed: 23,
    horizonMs: 20 * 60_000,
    bitnode: 4,
    homeRam: 128,
    startingMoney: 5e7,
    person: { skills: { hacking: 250 }, exp: { hacking: 6_250_000 } },
    features: only("hacking", "progression"),
    network: [FRAG_PRIMARY, FRAG_RIVAL] as never,
    topology: star(FRAG_PRIMARY, FRAG_RIVAL),
  },
  structural: (run, metrics, pressure) => {
    const final = run.samples.at(-1)!;
    const switched = run.switches.find(
      (event) => event.from === FRAG_PRIMARY.hostname && event.to === FRAG_RIVAL.hostname,
    );
    const postLaunch = run.infrastructure.filter((event) => event.launchedHack > 0);
    const finalSkill = run.skills.at(-1)?.hacking ?? 250;
    const compactBatchGb = solved(FRAG_PRIMARY, finalSkill, 4)?.ramPerBatch ?? 0;
    const wideBatchGb = solved(FRAG_RIVAL, finalSkill, 4)?.ramPerBatch ?? 0;
    const batchShapeRatio = compactBatchGb > 0 ? wideBatchGb / compactBatchGb : 0;

    console.info(
      `[jit-fragmentation] switch=${(switched?.atMs ?? 0) / 1_000}s skill=${finalSkill}`
      + ` batch=${compactBatchGb.toFixed(1)}->${wideBatchGb.toFixed(1)}GB`
      + ` ratio=${batchShapeRatio.toFixed(3)} fleet=${final.fleetGb}GB home=${final.homeGb}GB`
      + ` allocFails=${final.allocFails} batchesSkipped=${final.batchesSkipped}`,
    );

    expect(switched).toBeDefined();
    expect(batchShapeRatio).toBeGreaterThanOrEqual(1.5);
    expect(postLaunch.some(
      (event) => event.kind === "buyServer" || event.kind === "upgradeServer",
    )).toBe(true);
    expect(postLaunch.some((event) => event.kind === "upgradeHomeRam")).toBe(true);
    expect(final.fleetGb).toBeGreaterThan(128);
    expect(final.homeGb).toBeGreaterThan(128);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(pressure.demandByTarget.has(FRAG_PRIMARY.hostname)).toBe(true);
    expect(pressure.demandByTarget.has(FRAG_RIVAL.hostname)).toBe(true);
    expect(pressure.summedTargetDemandGb).toBeGreaterThan(pressure.peakUsableGb);
    // Atomic placement is the defining invariant. Known-bad counts belong in
    // ledger notes, not hidden by widening a performance tolerance.
    expect(final.allocFails).toBeLessThanOrEqual(1);
    // Skipped batches are NOT pinned to a constant here, and deliberately so:
    // this fixture asserts on the line above that demand exceeds usable RAM, so
    // declining a batch that cannot be placed atomically is the correct
    // response, not a defect. It rides the ledger ratchet instead — the count
    // may fall, never rise.
    return { batchesSkipped: final.batchesSkipped };
  },
});

/** HACKING_SPEED STEP — the disturbance case. `runGame` exposes no supported
 * mid-run person mutation, so rather than editing state the fixture uses a real
 * unpredictable duration change: it starts one experience point below level 250
 * and lets a modelled Go win against Illuminati raise `hacking_speed` while a
 * healthy pipeline has calls in flight. Nothing is fabricated; the question is
 * purely how cleanly we recover when every in-flight duration shifts at once.
 *
 * The `jit-skill-jump` id below is the ledger key, kept for baseline
 * continuity. It is a misnomer: the level boundary only makes the run's
 * *timing* unpredictable, and every recorded run has raised hacking_speed
 * without the raw skill moving at all. What this row measures is an IPvGO
 * reward landing on a running batcher. */
runScenario({
  id: "jit-skill-jump",
  // The lane case name, unlike the ledger id above, is free to say what this
  // actually is. Illuminati Node Power multiplies `hacking_speed`
  // (Go/effects/effect.ts calculateMults); the locked skill-1000 target is what
  // creates the hacking-speed demand that makes Go choose that reward.
  title: "scenario: JIT mid-batch hacking_speed step (IPvGO / Illuminati)",
  what: "recovers target state, window completion, and income after durations shift",
  steadyFromMs: 2 * 60_000,
  // Measured 79.6s and 80.4s wall-clock when it passes, but this fixture also
  // timed out at 120s three times in the same session on IDENTICAL code, and
  // on a clean 831e2505 worktree with none of the surrounding work applied --
  // so the flake is the budget, not the scenario. The same machine ran
  // jit-one-server at 187s and at 341s on identical code, i.e. wall-clock here
  // varies about 1.8x, which 1.5x of headroom cannot absorb. Budgeted at 3.7x
  // the observed passing time. A budget, not a threshold: this case FAILS its
  // assertions when it is wrong, and a timeout reports neither pass nor fail.
  timeoutMs: 300_000,
  options: {
    goal: parseGoals(["earn:1e30"]),
    seed: 41,
    horizonMs: 12 * 60_000,
    bitnode: 4,
    homeRam: 256,
    startingMoney: 0,
    person: { skills: { hacking: 249 }, exp: { hacking: calculateExp(250) - 1 } },
    features: only("hacking", "progression", "go"),
    network: [JUMP_PRIMARY, JUMP_SECONDARY, JUMP_AWARD] as never,
    topology: star(JUMP_PRIMARY, JUMP_SECONDARY, JUMP_AWARD),
  },
  structural: (run, _metrics, pressure) => {
    const jumps = run.skills.slice(1).map((sample, index) => {
      const previous = run.skills[index]!;
      return {
        ...sample,
        from: previous.hacking,
        delta: sample.hacking - previous.hacking,
        speedDelta: sample.hackingSpeed - previous.hackingSpeed,
        levelDelta: sample.hackingLevel - previous.hackingLevel,
      };
    });
    const jump = jumps.find((sample) =>
      sample.atMs >= 30_000 && (sample.speedDelta > 0 || sample.levelDelta > 0)
    );
    const before = jump ? sampleAtOrBefore(run.samples, jump.atMs) : undefined;
    const final = run.samples.at(-1);
    // PRIMARY and SECONDARY have identical statics and therefore identical
    // pipeline demand; both are prepared and eligible throughout the run.
    const offeredDemandGb = pressure.summedTargetDemandGb * 2;
    const postRate = jump ? moneyRate(run.samples, jump.atMs + 60_000, jump.atMs + 180_000) : 0;
    const postLaunches = before && final ? final.launchedHack - before.launchedHack : 0;
    const postLandings = before && final ? final.landedHack - before.landedHack : 0;
    const postCompletion = postLaunches > 0 ? postLandings / postLaunches : 0;
    const securityGap = final?.security !== undefined && final.minSecurity !== undefined
      ? final.security - final.minSecurity
      : Infinity;
    const moneyShare = final?.money !== undefined && final.moneyMax
      ? final.money / final.moneyMax
      : 0;

    // The signature of a step planned on a STALE multiplier, and the reason
    // this fixture reads the by-kind split rather than the aggregate. Grow and
    // weaken are 3.2x and 4x the hack time, so a duration model that is wrong
    // by a ratio is wrong by four times as much on a weaken as on that same
    // batch's hack: the batch does not shift, it shears, and the aggregate mean
    // -- which averages the two -- is the one number that cannot see it.
    const byKind = final?.landingErrorByKind;
    const meanOf = (kind: "hack" | "grow" | "weaken"): number => byKind?.[kind]?.meanMs ?? 0;
    const shearMs = Math.abs(meanOf("weaken") - meanOf("hack"));
    const skipped = final?.batchesSkipped ?? 0;

    console.info(
      `[jit-skill-jump] jump=${jump?.from ?? 0}->${jump?.hacking ?? 0}`
      + ` speed=${(jump?.hackingSpeed ?? 1).toFixed(6)} at=${(jump?.atMs ?? 0) / 1_000}s`
      + ` post-windows=${postCompletion.toFixed(6)} post-money/sec=$${postRate.toExponential(6)}`
      + ` final-security-gap=${securityGap.toFixed(6)} final-money-share=${moneyShare.toFixed(6)}`
      + ` landing-error-ms h=${meanOf("hack").toFixed(4)} g=${meanOf("grow").toFixed(4)}`
      + ` w=${meanOf("weaken").toFixed(4)} shear=${shearMs.toFixed(4)} skipped=${skipped}`,
    );

    expect(pressure.demandByTarget.size).toBeGreaterThan(0);
    expect(offeredDemandGb).toBeGreaterThan(pressure.peakUsableGb);
    expect(jump).toBeDefined();
    expect(run.goGames.some((game) => game.won)).toBe(true);
    expect(jump!.speedDelta > 0 || jump!.levelDelta > 0).toBe(true);
    expect(before!.launchedHack).toBeGreaterThan(0);
    expect(before!.inFlightHack + before!.inFlightGrow + before!.inFlightWeaken).toBeGreaterThan(0);
    expect(securityGap).toBeLessThanOrEqual(1);
    expect(moneyShare).toBeGreaterThanOrEqual(0.9);
    expect(postLaunches).toBeGreaterThan(0);
    expect(postCompletion).toBeGreaterThanOrEqual(0.8);
    expect(postRate).toBeGreaterThan(0);
    // The step must not separate a batch's own effects by even one landing gap.
    // Below that the roles cannot be reordered, which is the only thing the
    // grid has to guarantee.
    //
    // Compare within-batch geometry rather than income because multiplier
    // changes may also lead the runs into different fleet shapes.
    //
    // Asserted present first: `meanOf` reads 0 for a kind the telemetry never
    // reported, so an emitter that stopped publishing the split would make the
    // shear below exactly 0 and this row would pass while measuring nothing.
    expect(byKind?.hack).toBeDefined();
    expect(byKind?.weaken).toBeDefined();
    expect(shearMs).toBeLessThan(MINIMUM_LANDING_GAP_MS);
    // `skipped` is reported, not ratcheted: it varied 6762 / 7164 / 8487 across
    // three runs whose fleet trajectories differed, which is wider than the
    // ledger's default 5% slack, so a record on one seed would fail honest runs.
    //
    // This row currently PRINTS an improvement it has deliberately not recorded
    // (medianIdleShare 0.655907 -> 0.4116, moneyPerSec 1.62e7 -> 1.4486e8), and
    // that is not an oversight. Two reasons, both measured rather than assumed:
    //
    //   1. The gain is not this change's. The same row on the commit before the
    //      post-game player publish earns MORE, $1.6199e8/s, so recording
    //      $1.4486e8 would pin the record BELOW what the tree already achieves
    //      -- the exact inversion the ledger exists to prevent.
    //   2. Neither figure is trustworthy on its own. That earlier run FAILED
    //      this row's own contention premise (offered 112346.7 GB against
    //      peak-usable 133236.2 GB), and the harness checks premises before
    //      believing any number it measured.
    //
    // What that leaves is a real question -- whether publishing the snapshot
    // earlier costs this fixture income, or whether the two runs simply bought
    // different fleets -- which one seed cannot answer either way. BB_JIT_SEED
    // is the hook for answering it; until someone does, the honest record is
    // the old one.
  },
});

/** TARGET SWITCH — a retarget with ops still in flight. */
runScenario({
  id: "jit-target-switch",
  title: "scenario: JIT target switch",
  what: "keeps utilisation, windows, and income across an in-flight retarget",
  steadyFromMs: 60_000,
  timeoutMs: 120_000,
  options: {
    goal: parseGoals(["earn:1e30"]),
    seed: 17,
    horizonMs: 6 * 60_000,
    bitnode: 1,
    homeRam: 256,
    startingMoney: 0,
    person: { skills: { hacking: 250 }, exp: { hacking: 6_250_000 } },
    features: only("hacking", "progression"),
    network: [SWITCH_PRIMARY, SWITCH_RIVAL] as never,
    topology: star(SWITCH_PRIMARY, SWITCH_RIVAL),
  },
  structural: (run, metrics, pressure) => {
    const switched = run.switches.find(
      (event) => event.from === SWITCH_PRIMARY.hostname && event.to === SWITCH_RIVAL.hostname,
    );
    const switchAt = switched?.atMs ?? 0;
    const beforeRate = moneyRate(run.samples, switchAt - 30_000, switchAt);
    const afterRate = moneyRate(run.samples, switchAt, switchAt + 30_000);
    const switchIncomeRetention = beforeRate > 0 ? afterRate / beforeRate : 0;
    const stranded = switched?.before
      ? switched.before.inFlightHack + switched.before.inFlightGrow + switched.before.inFlightWeaken
      : 0;

    console.info(
      `[jit-target-switch] switch=${switchAt / 1_000}s stranded=${stranded}`
      + ` income-retention=${switchIncomeRetention.toFixed(6)}`,
    );

    expect(switched).toBeDefined();
    expect(stranded).toBeGreaterThan(0);
    expect(run.infrastructure).toHaveLength(0);
    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(pressure.summedTargetDemandGb).toBeGreaterThan(pressure.peakUsableGb);
    return { switchIncomeRetention };
  },
});

/** SHARE CHURN — share and farm trading the same RAM back and forth. */
runScenario({
  id: "jit-share-churn",
  title: "scenario: JIT share churn",
  what: "share yields and reclaims RAM without losing farm windows",
  steadyFromMs: 3 * 60_000,
  timeoutMs: 120_000,
  options: {
    goal: parseGoals(["rep:CyberSec:1e12", "earn:1e30"]),
    seed: 7,
    horizonMs: 15 * 60_000,
    bitnode: 4,
    homeRam: 256,
    startingMoney: 1e6,
    person: { skills: { hacking: 1_000 }, exp: { hacking: 100_000_000 } },
    playerState: { factions: ["CyberSec"] },
    factions: { CyberSec: { rep: 0, favor: 0 } },
    features: only("hacking", "factions", "career", "progression"),
    network: [CHURN_TARGET] as never,
    topology: star(CHURN_TARGET),
  },
  structural: (run, metrics) => {
    const final = run.samples.at(-1)!;
    const maxShareGb = Math.max(...run.samples.map((sample) => sample.shareGb));
    const maxFleetGb = Math.max(...run.samples.map((sample) => sample.fleetGb));
    const { yielded, reclaimed } = shareYields(run);

    console.info(
      `[jit-share-churn] share=0..${maxShareGb}GB yielded=${yielded} reclaimed=${reclaimed}`
      + ` fleet=${maxFleetGb}GB allocFails=${final.allocFails}`
      + ` landingError=${final.landingError
        ? `mean${final.landingError.meanMs}ms max|${final.landingError.maxAbsMs}|ms`
        : "none"}`,
    );

    expect(maxShareGb).toBeGreaterThan(0);
    expect(maxShareGb).toBeLessThan(maxFleetGb);
    expect(yielded).toBeGreaterThan(0);
    expect(reclaimed).toBeGreaterThan(0);
    expect(metrics.launchedHacks).toBeGreaterThan(0);

    // Premise check, measured EARLY on purpose. The point of this lane is share
    // churn under contention, and the fleet is only smaller than the target's
    // pipeline demand while it is still compounding: by the end of the run the
    // farm has bought its way past this target's demand entirely. Asserting on
    // the whole-run peak would therefore fail for the best possible reason,
    // which is not a useful tripwire.
    const early = jitPressure(
      run.samples.filter((sample) => sample.atMs <= 8 * 60_000),
      3 * 60_000,
    );
    expect(early.summedTargetDemandGb).toBeGreaterThan(early.peakUsableGb);
  },
});

/** ONE SERVER — the base case. A single target and RAM to spare, so nothing
 * competes and nothing fragments. The point is not throughput for its own sake
 * but HONESTY: `solveCycle` predicts a steady-state $/sec for this target, and
 * a realized rate far below it means our own model of the batch is wrong, which
 * would quietly corrupt every ranking decision built on top of it. */
runScenario({
  id: "jit-one-server",
  title: "scenario: one server, nothing else",
  what: "realizes close to the steady-state rate the solver predicted",
  steadyFromMs: 5 * 60_000,
  // The deepest pipeline in the ladder: skill 1000 against a
  // requiredHackingSkill-1 target on a 2 TB home, so hack time collapses and
  // the landing grid carries the most operations per virtual second of any
  // fixture here. This is a wall-clock budget, not a correctness threshold.
  timeoutMs: 900_000,
  options: {
    goal: parseGoals(["earn:1e30"]),
    seed: 3,
    horizonMs: 20 * 60_000,
    bitnode: 1,
    homeRam: 2_048,
    startingMoney: 0,
    person: { skills: { hacking: 1_000 }, exp: { hacking: calculateExp(1_000) } },
    features: only("hacking"),
    network: [SOLO] as never,
    topology: star(SOLO),
  },
  structural: (run, metrics) => {
    const solution = solved(SOLO, run.skills.at(-1)?.hacking ?? 1_000, 1)!;
    const fleetGb = Math.max(...run.samples.map((sample) => sample.fleetGb));
    // Steady-state ceiling: income per batch over the batch period, where the
    // period is whichever binds -- RAM or the depth of the landing pipeline.
    // The steady-state rate is bounded by BOTH constraints, exactly as
    // solveCycle bounds it (`period = max(ramSec/farmGb, jointPeriod,
    // interval)` -- a max of periods is a min of rates). The RAM-seconds term
    // alone prices a cadence the game forbids: `solved()` deliberately solves
    // uncapped, so `score` is income per RAM-second with no landing interval in
    // it. The prediction must therefore also apply the minimum landing-gap
    // ceiling.
    const perBatchSolved = solution.incomePerBatch + solution.stockIncomePerBatch;
    const cadenceCeilingPerSec = (1_000 / HWGW_MIN_INTERVAL_MS) * perBatchSolved;
    const ramBoundPerSec = solution.score * Math.min(fleetGb, solution.jitSaturationGb ?? fleetGb);
    const predictedPerSec = Math.min(ramBoundPerSec, cadenceCeilingPerSec);
    const realizedShare = predictedPerSec > 0 ? metrics.moneyPerSec / predictedPerSec : 0;

    console.info(
      `[jit-one-server] fleet=${fleetGb}GB predicted=$${predictedPerSec.toExponential(6)}/s`
      + ` realized=$${metrics.moneyPerSec.toExponential(6)}/s share=${realizedShare.toFixed(4)}`,
    );

    // WHERE THE MISSING THIRD GOES. `realizedShare` says the batch model is
    // optimistic but not WHY, and the two candidate causes want opposite
    // fixes: landing fewer batches than the cadence predicts is a dispatcher
    // problem, while landing the predicted number for less money each is a
    // model problem. Decompose it rather than guess.
    const steady = run.samples.filter((sample) => sample.atMs >= 5 * 60_000);
    // A run that ended before steady state has nothing to decompose, and the
    // assertions below say so far more usefully than a crash on an empty slice.
    const firstSteady = steady[0];
    const lastSteady = steady.at(-1);
    const elapsedSec = firstSteady === undefined || lastSteady === undefined
      ? 0
      : (lastSteady.atMs - firstSteady.atMs) / 1_000;
    const landedPerSec = elapsedSec > 0
      ? (lastSteady!.landedHack - firstSteady!.landedHack) / elapsedSec
      : 0;
    const perBatch = perBatchSolved;
    const predictedPerSecBatches = perBatch > 0 ? predictedPerSec / perBatch : 0;
    const realizedPerBatch = landedPerSec > 0 ? metrics.moneyPerSec / landedPerSec : 0;
    console.info(
      `[jit-one-server] DECOMPOSE batches/sec realized=${landedPerSec.toFixed(3)}`
      + ` predicted=${predictedPerSecBatches.toFixed(3)}`
      + ` ratio=${predictedPerSecBatches > 0 ? (landedPerSec / predictedPerSecBatches).toFixed(4) : "n/a"}`
      + ` | $/batch realized=${realizedPerBatch.toExponential(4)}`
      + ` predicted=${perBatch.toExponential(4)}`
      + ` ratio=${(perBatch > 0 ? realizedPerBatch / perBatch : 0).toFixed(4)}`
      + ` | chance=${solution.chance.toFixed(4)} hackThreads=${solution.hackThreads}`,
    );

    expect(metrics.launchedHacks).toBeGreaterThan(0);
    expect(metrics.moneyPerSec).toBeGreaterThan(0);
    // Deliberately loose in both directions. Below: chance is a coin flip per
    // hack, so a finite window scatters. Above: exceeding the prediction by a
    // wide margin means the model UNDER-states the batch, which is just as
    // wrong and would show up as systematically bad target ranking.
    expect(realizedShare).toBeGreaterThan(0.5);
    expect(realizedShare).toBeLessThan(2.0);
    return { realizedShare };
  },
});

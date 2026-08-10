import type { NS } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { formatMoney } from "../../../shared/format.ts";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { stepCareer, TRAINING_FUND_WINDOW_SEC, type CareerDecision, type CareerPriorityBand, type CareerView } from "../../../shared/strategy/career/decide.ts";
import type { CrimeStats } from "../../../shared/strategy/career/crimes.ts";
import {
  careerSchedule,
  careerWorkMode,
  progressLockUntil,
  updateActivityRate,
  type ActivityRateSample,
  type CareerWorkMode,
} from "../../../shared/strategy/career/schedule.ts";
import { PORT_OPENER_PROGRAMS, programCreateTimeMs } from "../../../shared/strategy/career/programs.ts";
import { rateFraction, slotPriority } from "../../../shared/strategy/income.ts";
import { isScriptDeath } from "../errors.ts";
import { bestIncomePerSec, careerBestPerSec } from "../income.ts";
import { merge, type GameState } from "../state.ts";
import {
  armWorkCompletion,
  consumeWorkCompletion,
  consumeWorkChanged,
  disarmWorkCompletion,
  peekWorkCompletion,
  resetWorkCompletion,
  workCompletionArmed,
  workChangedPending,
  workDetail,
  type WorkCompletionNotice,
  type WorkTaskLike,
} from "../work-completion.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

/** The career driver.
 *
 * Career is the needs board's main consumer: it satisfies other features'
 * karma, kill, stat, charisma and city thresholds, and doubles as the
 * early-game income floor when nothing is outstanding.
 *
 * It also shares the single `Player.currentWork` slot with `factions`, which makes
 * it the arbiter's primary test case. `career:blocking-need` (95) can PREEMPT faction
 * work. The INCOME band no longer has a fixed answer: it is scored against the best
 * earning rate anyone announced, so crime outranks reputation work exactly when it is
 * genuinely our best earner, and loses when it is not. See
 * `shared/strategy/income.ts`.
 *
 * Pinned upstream work-start and administrative call contracts:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L226-L405
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L668-L746
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L965-L1065 */

/** commitCrime + getCrimeStats + getCrimeChance, all SingularityFn3-ish. */
const PEAK_STEP_GB = 12;
const JOB_FIELDS = [
  "Software", "IT", "Network Engineer", "Security Engineer",
  "Business", "Software Consultant", "Business Consultant",
  "Security", "Agent", "Employee", "Part-time Employee",
  "Waiter", "Part-time Waiter",
] as const;
const TRAVEL_COST = 200_000;

let lastDecision: CareerDecision | undefined;
let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
let lastReviewedAt: number | undefined;
let lastWorkMode: CareerWorkMode | undefined;
let lastCompletion: WorkCompletionNotice | undefined;
const companyRates = new Map<string, ActivityRateSample>();
/** action key -> earliest retry time, latched when EXECUTING that action
 * THREW. The idle wake keeps this driver hot at frame rate so a freed slot is
 * consumed immediately — but the same heat turns one throwing call into five
 * stub spawns per second, forever (measured: 1,389 applyToCompany throws in
 * five minutes against a world that refuses the call). A throw is not a
 * refusal the next frame can cure; it gets a cool-down. Dodge refusals
 * (no grant, no host) are NOT backed off — the next pass may fund them. */
const executeBackoff = new Map<string, number>();
export const EXECUTE_BACKOFF_MS = 30_000;
/** The running course's $/sec, latched when the class/gym claim is first
 * posted so the STANDING reserve stays correctly sized for the course's
 * whole life (the ranked option that priced it is only in scope at start). */
let trainingCostPerSec = 0;

export function resetCareerState(): void {
  trainingCostPerSec = 0;
  lastDecision = undefined;
  lastResult = undefined;
  lastReviewedAt = undefined;
  lastWorkMode = undefined;
  lastCompletion = undefined;
  companyRates.clear();
  executeBackoff.clear();
  resetWorkCompletion();
}

function buildCareerView(
  state: GameState,
  holdsWorkSlot: boolean,
  moneyGranted: number,
  allowProgressSwitch = false,
): CareerView | undefined {
  const player = state.topics.player;
  const career = state.topics.career;
  if (!player) return undefined;

  const mults = (player.mults ?? {}) as unknown as Record<string, number>;
  const progression = state.topics.progression;
  const nodeMults = effectiveBitNodeMultipliers(
    progression?.bitNode,
    progression?.sourceFiles["12"] ?? 0,
    progression?.multipliers,
  ) ?? {};
  const skills = { ...(player.skills ?? {}) } as unknown as Record<string, number>;
  const classExp = nodeMults["ClassGymExpGain"] ?? 1;
  // ClassWork applies the location multiplier, the matching Hacknet hash
  // multiplier, and a 10% cost discount when the location's server is
  // backdoored. These are the exact Rothman/Powerhouse base rates after that
  // overlay, not unconditional constants.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Formulas.ts#L99-L121
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/HashManager.ts#L34-L58
  const hashLevel = (name: string): number => state.topics.hacknet?.hashUpgrades?.find((upgrade) => upgrade.name === name)?.level ?? 0;
  const studyMult = 1 + 0.2 * hashLevel("Improve Studying");
  const gymMult = 1 + 0.2 * hashLevel("Improve Gym Training");
  const rothmanCostMult = state.topics.servers?.["rothman-uni"]?.backdoorInstalled ? 0.9 : 1;
  const powerhouseCostMult = state.topics.servers?.["powerhouse-fitness"]?.backdoorInstalled ? 0.9 : 1;
  const courses = String(player.city ?? "Sector-12") === "Sector-12"
    ? [
        { name: "Algorithms", skill: "hacking", expPerSec: 8 * studyMult * (mults["hacking_exp"] ?? 1) * classExp, costPerSec: 960 * rothmanCostMult, location: "Rothman University" },
        { name: "Leadership", skill: "charisma", expPerSec: 8 * studyMult * (mults["charisma_exp"] ?? 1) * classExp, costPerSec: 960 * rothmanCostMult, location: "Rothman University" },
        ...(["strength", "defense", "dexterity", "agility"] as const).map((skill) => ({
          name: skill,
          skill,
          expPerSec: 10 * gymMult * (mults[`${skill}_exp`] ?? 1) * classExp,
          costPerSec: 2_400 * powerhouseCostMult,
          location: "Powerhouse Gym",
        })),
      ]
    : [];
  const intelligence = skills["intelligence"] ?? 0;
  const sf11Level = progression?.sourceFiles["11"] ?? 0;
  const sf15Level = progression?.sourceFiles["15"] ?? 0;
  const charisma = skills["charisma"] ?? 0;
  const sf15SalaryMult = sf15Level > 1
    ? 1 + 0.5 * (1 - Math.exp(-0.0002 * charisma)) + 0.9 * (1 - Math.exp(-0.00004 * charisma))
    : 1;
  const ownedOpeners = state.topics.fleet?.portOpeners ?? 0;
  const programs = PORT_OPENER_PROGRAMS.slice(ownedOpeners)
    .map((program) => ({ ...program, timeMs: programCreateTimeMs(program, skills["hacking"] ?? 0, intelligence) }))
    .filter((program) => Number.isFinite(program.timeMs));
  const factionWorkType = state.topics.factions?.plan?.action.workType;
  const fallbackCandidates = factionWorkType === "security"
    ? ["hacking", "strength", "defense", "dexterity", "agility"]
    : factionWorkType === "field"
      ? ["hacking", "strength", "defense", "dexterity", "agility", "charisma"]
      : ["hacking"];
  const defaultSkill = [...fallbackCandidates].sort((a, b) =>
    (skills[a] ?? 0) - (skills[b] ?? 0)
    || (a < b ? -1 : 1)
  )[0] ?? "hacking";

  // Crime stats come from the game, never a hardcoded table — and the game's
  // own success chance comes with them, so the strategy never has to recompute
  // a number it can simply be told.
  const crimes: CrimeStats[] = (career?.crimes ?? []).map((crime) => ({
    type: crime.name,
    timeMs: crime.timeMs,
    money: crime.money,
    difficulty: crime.difficulty ?? 1,
    // The probe reports karma as the game does (negative for the player);
    // the strategy wants the positive magnitude that gets subtracted.
    karma: Math.abs(crime.karma),
    kills: crime.kills ?? 0,
    weights: crime.weights ?? {},
    exp: crime.exp ?? {},
    chance: crime.chance,
    gainsAreEffective: crime.gainsAreEffective,
  }));

  return {
    time: Date.now(),
    person: {
      skills,
      mults: {
        crime_success: mults["crime_success"] ?? 1,
        crime_money: mults["crime_money"] ?? 1,
        hacking_exp: mults["hacking_exp"] ?? 1,
        strength_exp: mults["strength_exp"] ?? 1,
        defense_exp: mults["defense_exp"] ?? 1,
        dexterity_exp: mults["dexterity_exp"] ?? 1,
        agility_exp: mults["agility_exp"] ?? 1,
        charisma_exp: mults["charisma_exp"] ?? 1,
      },
    },
    crimeContext: {
      crimeSuccessRate: nodeMults["CrimeSuccessRate"] ?? 1,
      crimeMoney: nodeMults["CrimeMoney"] ?? 1,
      crimeExp: nodeMults["CrimeExpGain"] ?? 1,
    },
    crimes,
    courses,
    programs,
    karma: player.karma ?? 0,
    numPeopleKilled: player.numPeopleKilled ?? 0,
    skills: { ...(player.skills ?? {}) } as unknown as Record<string, number>,
    city: String(player.city ?? "Sector-12"),
    jobs: Object.fromEntries(Object.entries(player.jobs ?? {}).map(([company, job]) => [String(company), String(job)])),
    companies: Object.entries(career?.companies ?? {}).map(([name, company]) => ({
      name,
      rep: company.rep,
      ...(companyRates.get(name)?.perSec !== undefined ? { repPerSec: companyRates.get(name)!.perSec } : {}),
      ...(company.salaryPerCycle !== undefined
        ? {
            moneyPerSec: company.salaryPerCycle * 5
              * (sf11Level > 0 ? 1 + company.favor / 100 : 1)
              * (mults["work_money"] ?? 1)
              * sf15SalaryMult
              * (nodeMults["CompanyWorkMoney"] ?? 1),
          }
        : {}),
    })),
    holdsWorkSlot,
    ...(career?.currentWork
      ? {
          currentWork: {
            kind: String(career.currentWork.type).toLowerCase(),
            subject: career.currentWork.detail,
          },
        }
      : {}),
    ...(allowProgressSwitch ? { allowProgressSwitch: true } : {}),
    moneyGranted,
    externalIncomePerSec: state.topics.farm?.moneyRate ?? 0,
    defaultSkill,
  };
}

function sampleCompanyRates(state: GameState, now: number): void {
  const current = state.topics.career?.currentWork;
  for (const [name, company] of Object.entries(state.topics.career?.companies ?? {})) {
    const active = current?.type === "COMPANY" && current.detail === name;
    companyRates.set(name, updateActivityRate(companyRates.get(name), company.rep, now, active));
  }
}

interface WorkStartResult<T> {
  value: T;
  currentWork: NonNullable<NonNullable<GameState["topics"]["career"]>["currentWork"]> | null;
}

function taskDigest(task: ((Record<string, unknown> & WorkTaskLike) | null)): WorkStartResult<unknown>["currentWork"] {
  if (!task) return null;
  return {
    type: String(task.type),
    detail: workDetail(task) ?? "",
    ...(task.factionWorkType !== undefined ? { workType: String(task.factionWorkType) } : {}),
    cyclesWorked: typeof task.cyclesWorked === "number" ? task.cyclesWorked : 0,
    observedAt: Date.now(),
  };
}

async function execute(_ns: NS, ctx: DriverContext, decision: CareerDecision): Promise<boolean> {
  const at = Date.now();
  const record = (ok: boolean, detail: string): void => {
    lastResult = { action: decision.action.type, ok, detail, at };
  };

  const refused = Symbol("feature dodge refused");
  const run = async <T>(methods: readonly string[], body: (stubNs: NS) => T | Promise<T>): Promise<T | typeof refused> => {
    const outcome = await featureDodge(ctx, "career", actionClaimId(decision.action.type), methods, body);
    if (!outcome.ok) {
      record(false, outcome.reason);
      return refused;
    }
    return outcome.value;
  };

  const replaceWork = async <T>(
    methods: readonly string[],
    body: (stubNs: NS) => T,
  ): Promise<WorkStartResult<T> | typeof refused> => {
    const result = await run([...methods, "singularity.getCurrentWork"], (stubNs: NS) => {
      disarmWorkCompletion();
      const value = body(stubNs);
      const task = stubNs["singularity"]["getCurrentWork"]() as (Record<string, unknown> & WorkTaskLike) | null;
      if (task) armWorkCompletion(task);
      return { value, currentWork: taskDigest(task) };
    });
    if (result !== refused) merge(ctx.state, "career", { currentWork: result.currentWork });
    return result;
  };

  switch (decision.action.type) {
    case "idle":
      return false;
    case "continue": {
      const result = await run(["singularity.getCurrentWork"], (stubNs: NS) => {
        const task = stubNs["singularity"]["getCurrentWork"]() as (Record<string, unknown> & WorkTaskLike) | null;
        if (task) armWorkCompletion(task);
        return taskDigest(task);
      });
      if (result === refused) return false;
      merge(ctx.state, "career", { currentWork: result });
      record(result !== null, result ? `continuing ${decision.action.subject}` : "work ended before it could be re-armed");
      return true;
    }
    case "crime": {
      // A valid crime starts unconditionally and returns its duration; invalid
      // enum input throws before this point.
      // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L1037-L1065
      const result = await replaceWork(["singularity.commitCrime"], (stubNs: NS) =>
        stubNs["singularity"]["commitCrime"](decision.action.subject as never, decision.action.focus),
      );
      if (result === refused) return false;
      const ms = result.value;
      record(Boolean(ms), ms ? `committing ${decision.action.subject}` : "crime refused");
      return true;
    }
    case "gym": {
      const result = await replaceWork(["singularity.gymWorkout"], (stubNs: NS) =>
        stubNs["singularity"]["gymWorkout"](decision.action.location as never, decision.action.subject as never, true),
      );
      if (result === refused) return false;
      const ok = result.value;
      record(Boolean(ok), ok ? `training ${decision.action.subject}` : "training refused");
      return true;
    }
    case "class": {
      const result = await replaceWork(["singularity.universityCourse"], (stubNs: NS) =>
        stubNs["singularity"]["universityCourse"](decision.action.location as never, decision.action.subject as never, true),
      );
      if (result === refused) return false;
      const ok = result.value;
      record(Boolean(ok), ok ? `studying ${decision.action.subject}` : "course refused");
      return true;
    }
    case "program": {
      const result = await replaceWork(["singularity.createProgram", "ls"], (stubNs: NS) => {
        const started = stubNs["singularity"]["createProgram"](decision.action.subject as never, decision.action.focus);
        const files = new Set(stubNs["ls"]("home", ".exe"));
        return { started, openers: PORT_OPENER_PROGRAMS.filter((program) => files.has(program.name)).length };
      });
      if (result === refused) return false;
      merge(ctx.state, "fleet", { portOpeners: result.value.openers });
      record(Boolean(result.value.started), result.value.started ? `writing ${decision.action.subject}` : "program already present or creation refused");
      return true;
    }
    case "travel": {
      if (ctx.grants.money < TRAVEL_COST) {
        record(false, `waiting for ${formatMoney(TRAVEL_COST)} travel grant`);
        return false;
      }
      const result = await replaceWork(["singularity.travelToCity"], (stubNs: NS) =>
        stubNs["singularity"]["travelToCity"](decision.action.subject as never),
      );
      if (result === refused) return false;
      const ok = result.value;
      record(Boolean(ok), ok ? `travelled to ${decision.action.subject}` : "travel refused");
      return true;
    }
    case "company": {
      const result = await replaceWork(["singularity.workForCompany"], (stubNs: NS) =>
        stubNs["singularity"]["workForCompany"](decision.action.subject as never, true),
      );
      if (result === refused) return false;
      const ok = result.value;
      record(Boolean(ok), ok ? `working for ${decision.action.subject}` : "company work refused");
      return true;
    }
    case "apply": {
      // Preference order: productive specialist tracks first, universal
      // fallback jobs last. Stop at the first accepted application.
      const result = await replaceWork(["singularity.applyToCompany"], (stubNs: NS) => {
        for (const field of JOB_FIELDS) {
          const job = stubNs["singularity"]["applyToCompany"](decision.action.subject as never, field as never);
          if (job) return String(job);
        }
        return "";
      });
      if (result === refused) return false;
      record(result.value !== "", result.value ? `hired as ${result.value} at ${decision.action.subject}` : "no eligible position");
      return true;
    }
    case "promote": {
      // Applying for a promotion is administrative and does not consume the
      // work slot. Never turn a failed promotion into company work here: that
      // would silently cancel an in-progress crime even though the pure
      // strategy correctly classified `promote` as slot-free.
      const result = await replaceWork(["singularity.applyToCompany"], (stubNs: NS) => ({
        job: stubNs["singularity"]["applyToCompany"](decision.action.subject as never, decision.action.field as never),
      }));
      if (result === refused) return false;
      const { job } = result.value;
      record(
        Boolean(job),
        job
          ? `promoted to ${job} at ${decision.action.subject}`
          : `not yet promotable on the ${decision.action.field} track`,
      );
      return true;
    }
    case "quit": {
      const result = await replaceWork(["singularity.quitJob"], (stubNs: NS) =>
        stubNs["singularity"]["quitJob"](decision.action.subject as never),
      );
      if (result === refused) return false;
      record(true, `left ${decision.action.subject}`);
      return true;
    }
  }
}

const driver: FeatureDriver = {
  id: "career",
  everyMs: 5_000,
  // Progress completions bypass the wall-clock cadence. An idle decision also
  // stays hot so a newly available slot is consumed on the next 200 ms frame.
  wake: () => workChangedPending() || peekWorkCompletion() !== undefined || lastWorkMode === "idle",
  async tick(ctx: DriverContext) {
    consumeWorkChanged();
    const now = Date.now();
    const completion = peekWorkCompletion();
    const schedule = careerSchedule({
      now,
      ...(lastReviewedAt !== undefined ? { lastReviewedAt } : {}),
      currentWorkType: ctx.state.topics.career?.currentWork?.type,
      completionPending: completion !== undefined,
    });
    if (!schedule.due) return;

    // nextCompletion also resolves when a task is cancelled. Re-observe the
    // live slot before treating the notice as a banked progress boundary; this
    // prevents a manual replacement from being immediately cancelled using a
    // stale CRIME digest. A repeating crime remains present with the same
    // detail, while completed one-shot work leaves the slot empty.
    let completionBoundary = false;
    if (completion) {
      const observed = await observeAndArm(ctx);
      if (!observed) return;
      const current = ctx.state.topics.career?.currentWork;
      completionBoundary = current === null || (
        current !== undefined &&
        current.type === completion.type &&
        (completion.detail === undefined || current.detail === completion.detail)
      );
      if (!completionBoundary) {
        lastCompletion = completion;
        lastReviewedAt = now;
        lastWorkMode = careerWorkMode(current?.type);
        consumeWorkCompletion();
        return;
      }
    }

    sampleCompanyRates(ctx.state, now);
    const view = buildCareerView(ctx.state, ctx.grants.slot, ctx.grants.money, completionBoundary);
    if (!view) return;
    const decision = stepCareer(view, ctx.board);
    lastDecision = decision;
    lastReviewedAt = now;
    lastWorkMode = schedule.mode;
    if (completion) lastCompletion = completion;

    const next = careerSchedule({
      now,
      lastReviewedAt: now,
      currentWorkType: ctx.state.topics.career?.currentWork?.type,
      completionPending: false,
    });

    merge(ctx.state, "career", {
      plan: {
        action: {
          type: decision.action.type,
          ...(decision.action.subject !== undefined ? { subject: decision.action.subject } : {}),
          ...(decision.action.field !== undefined ? { field: decision.action.field } : {}),
        },
        incomeFallback: decision.incomeFallback,
        priority: { band: decision.workPriority, value: priorityForBand(decision.workPriority, ctx.state) },
        schedule: {
          mode: schedule.mode,
          reason: schedule.reason ?? "initial",
          reviewedAt: now,
          ...(next.nextReviewAt !== undefined ? { nextReviewAt: next.nextReviewAt } : {}),
          ...(lastCompletion ? { lastCompletion } : {}),
        },
        ranked: decision.ranked.slice(0, 8).map((entry) => ({
          label: `${entry.action.type}: ${entry.action.subject ?? ""}`,
          score: entry.score,
          moneyPerSec: entry.moneyPerSec,
          priority: entry.priority,
          contributions: entry.contributions,
        })),
        serving: decision.serving.map((need) => ({
          ...(need.by !== undefined ? { by: need.by } : {}),
          kind: need.kind,
          ...(need.subject !== undefined ? { subject: need.subject } : {}),
          ...(need.target !== undefined ? { target: need.target } : {}),
          ...(need.have !== undefined ? { have: need.have } : {}),
          weight: need.weight,
          ...(need.urgency !== undefined ? { urgency: need.urgency } : {}),
          progress: need.progress,
        })),
        ...(lastResult ? { lastResult } : {}),
      },
    });

    const actionKey = `${decision.action.type}:${decision.action.subject ?? ""}:${decision.action.field ?? ""}`;
    try {
      let handled = false;
      if (!completion && decision.action.type === "idle" && needsCompletionWatcher(ctx.state) && !workCompletionArmed()) {
        handled = await observeAndArm(ctx);
      }
      if (decision.action.type !== "idle" && (executeBackoff.get(actionKey) ?? 0) <= now) {
        handled = (await execute(ctx.ns, ctx, decision)) || handled;
      }
      if (handled) lastWorkMode = careerWorkMode(ctx.state.topics.career?.currentWork?.type);
      if (completion && (handled || !ctx.grants.slot)) consumeWorkCompletion();
    } catch (error) {
      if (isScriptDeath(error)) throw error;
      executeBackoff.set(actionKey, Date.now() + EXECUTE_BACKOFF_MS);
      lastResult = { action: decision.action.type, ok: false, detail: String(error), at: Date.now() };
    }
  },
};

/** Career posts no needs of its own — it consumes the requests other features
 * queue on the needs board. */
function claims(ctx: ClaimContext): Claim[] {
  const out: Claim[] = [];
  const completion = peekWorkCompletion();
  const schedule = careerSchedule({
    now: ctx.now,
    ...(lastReviewedAt !== undefined ? { lastReviewedAt } : {}),
    currentWorkType: ctx.state.topics.career?.currentWork?.type,
    completionPending: completion !== undefined,
  });

  let candidate = lastDecision;
  if (schedule.due) {
    const view = buildCareerView(ctx.state, true, ctx.state.topics.player?.money ?? 0, completion !== undefined);
    if (view) candidate = stepCareer(view, ctx.board);
  }

  const actionType = schedule.due ? candidate?.action.type : undefined;
  const methods = careerMethods(actionType);
  if (actionType && methods.length > 0) {
    out.push(actionRamClaim(ctx, "career", actionClaimId(actionType), methods, `career ${actionType}`));
  }
  if (actionType === "travel") {
    out.push({
      by: "career",
      id: "travel-fund",
      resource: "money",
      amount: TRAVEL_COST,
      priority: priorityForBand(candidate?.workPriority ?? "wanted", ctx.state),
      mode: "spend",
      divisible: false,
      why: `travel costs ${formatMoney(TRAVEL_COST)}`,
    });
  }
  if (actionType === "class" || actionType === "gym") {
    const option = candidate?.ranked.find((entry) => entry.action === candidate?.action);
    const costPerSec = Math.max(0, -(option?.moneyPerSec ?? 0));
    if (costPerSec > 0) {
      trainingCostPerSec = costPerSec;
      out.push({
        by: "career",
        id: "training-fund",
        resource: "money",
        amount: costPerSec * TRAINING_FUND_WINDOW_SEC,
        priority: priorityForBand(candidate?.workPriority ?? "income", ctx.state),
        mode: "reserve",
        divisible: false,
        why: "fund the next training window",
      });
    }
  } else if (ctx.state.topics.career?.currentWork?.type === "CLASS" && trainingCostPerSec > 0) {
    // A RUNNING course drains money continuously ($960-2,400/s), and the old
    // claim existed only on the pass the course STARTED — the steady-state
    // spend was invisible to the arbiter, silently eating other features'
    // reservations. Standing reserve for one window, at the latched rate.
    out.push({
      by: "career",
      id: "training-fund",
      resource: "money",
      amount: trainingCostPerSec * TRAINING_FUND_WINDOW_SEC,
      priority: priorityForBand(candidate?.workPriority ?? "income", ctx.state),
      mode: "reserve",
      divisible: false,
      why: "an active course drains continuously; keep its window funded",
    });
  } else if (ctx.state.topics.career?.currentWork?.type !== "CLASS") {
    trainingCostPerSec = 0;
  }
  // At a completion boundary another feature may win the work slot before
  // career ticks. Keep a separately-priced observation available even when
  // career also has a candidate action, so it records the replacement work
  // rather than retaining a stale CRIME digest until the 30-second probe.
  if (needsCompletionWatcher(ctx.state) && !workCompletionArmed() && (completion !== undefined || methods.length === 0)) {
    out.push(actionRamClaim(ctx, "career", "watch:completion", ["singularity.getCurrentWork"], "arm exact work completion wakeup"));
  }

  // Queue bands are deliberately spaced around faction work: blocking can
  // preempt it, wanted/nice cannot, and income is the floor.
  const band = candidate?.workPriority ?? "income";

  // A task with unbanked progress gets an administrative lock, bounded by the
  // moment that progress banks — see `progressLockUntil` for why an unbounded one
  // wedged the whole run. Before the boundary the lock is absolute: cancelling a
  // crime at 99% throws the entire thing away. At the boundary career drops back to
  // its ordinary band, so the end of a crime is a fair re-evaluation of what to work
  // rather than an automatic renewal — which is what let a 10-minute Heist hold the
  // slot against faction work indefinitely.
  const lockUntil = progressLockUntil({
    mode: careerWorkMode(ctx.state.topics.career?.currentWork?.type),
    totalMs: progressTotalMs(ctx.state),
    cyclesWorked: ctx.state.topics.career?.currentWork?.cyclesWorked,
    observedAt: ctx.state.topics.career?.currentWork?.observedAt,
    repeating: ctx.state.topics.career?.currentWork?.type?.toUpperCase() === "CRIME",
    completionPending: completion !== undefined,
    now: ctx.now,
  });
  out.push({
    by: "career",
    id: "work",
    resource: "time",
    amount: 1,
    priority: lockUntil !== undefined ? PRIORITY["career:progress-lock"] : priorityForBand(band, ctx.state),
    mode: "spend",
    ...(lockUntil !== undefined ? { holdUntil: lockUntil } : {}),
    why: lockUntil !== undefined
      ? `unbanked progress banks in ${Math.max(0, Math.round((lockUntil - ctx.now) / 1_000))}s`
      : band === "income"
        ? "early-game income"
        : `${band} career request selected from the queue`,
  });
  return out;
}

function actionClaimId(type: string): string {
  return `action:${type}`;
}

function careerMethods(type: string | undefined): readonly string[] {
  switch (type) {
    case "crime": return ["singularity.commitCrime", "singularity.getCurrentWork"];
    case "gym": return ["singularity.gymWorkout", "singularity.getCurrentWork"];
    case "class": return ["singularity.universityCourse", "singularity.getCurrentWork"];
    case "company": return ["singularity.workForCompany", "singularity.getCurrentWork"];
    case "apply": return ["singularity.applyToCompany", "singularity.getCurrentWork"];
    case "promote": return ["singularity.applyToCompany", "singularity.getCurrentWork"];
    case "quit": return ["singularity.quitJob", "singularity.getCurrentWork"];
    case "travel": return ["singularity.travelToCity", "singularity.getCurrentWork"];
    case "continue": return ["singularity.getCurrentWork"];
    case "program": return ["singularity.createProgram", "singularity.getCurrentWork", "ls"];
    default: return [];
  }
}

/** How long the progress task in flight runs for, from whichever table describes
 * it. Crimes are career's own; a graft is bought and timed by `factions`, and
 * `Player.currentWork` reports GRAFTING for it because it occupies the same slot.
 *
 * `undefined` when the activity cannot be identified — before the table is probed,
 * or a progress kind we do not model. `progressLockUntil` treats that as "no lock"
 * on purpose. */
function progressTotalMs(state: GameState): number | undefined {
  const work = state.topics.career?.currentWork;
  if (!work?.detail) return undefined;
  switch (work.type?.toUpperCase()) {
    case "CRIME":
      return state.topics.career?.crimes?.find((crime) => crime.name === work.detail)?.timeMs;
    case "GRAFTING":
      return state.topics.factions?.graftable?.find((offer) => offer.name === work.detail)?.timeMs;
    default:
      return undefined;
  }
}

/** What career's claim on the work slot is worth.
 *
 * The three REQUEST bands keep their fixed priorities: they are about unblocking
 * another feature, and their worth is the urgency of that need rather than anything
 * earned per second.
 *
 * The INCOME band is scored instead of fixed. A flat `career:income` said the same
 * thing whether crime out-earned the hacking farm ten times over or was a rounding
 * error beside it, so the slot could not be allocated on merit. It is now career's
 * best money rate as a fraction of the best rate anyone announced, times
 * `MONEY_SPAN` — the top earner is worth the full span, half as good is worth half.
 * See `shared/strategy/income.ts`, including why that span exceeds reputation's. */
function priorityForBand(band: CareerPriorityBand, state: GameState): number {
  switch (band) {
    case "blocking": return PRIORITY["career:blocking-need"];
    case "wanted": return PRIORITY["career:wanted-request"];
    case "nice": return PRIORITY["career:nice-request"];
    case "income":
      return slotPriority({
        moneyFraction: rateFraction(careerBestPerSec(state), bestIncomePerSec(state)),
      });
  }
}

function needsCompletionWatcher(state: GameState): boolean {
  return careerWorkMode(state.topics.career?.currentWork?.type) === "progress";
}

async function observeAndArm(ctx: DriverContext): Promise<boolean> {
  const outcome = await featureDodge(
    ctx,
    "career",
    "watch:completion",
    ["singularity.getCurrentWork"],
    (stubNs: NS) => {
      const task = stubNs["singularity"]["getCurrentWork"]() as (Record<string, unknown> & WorkTaskLike) | null;
      if (task) armWorkCompletion(task);
      return taskDigest(task);
    },
  );
  if (!outcome.ok) return false;
  merge(ctx.state, "career", { currentWork: outcome.value });
  return true;
}

export const careerModule: FeatureModule = {
  driver,
  reset: (state) => {
    resetCareerState();
    // Jobs, work state and crime stats from the ended node.
    delete state.topics.career;
  },
  claims,
  peakStepGb: PEAK_STEP_GB,
};

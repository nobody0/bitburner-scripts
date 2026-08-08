import type { NS } from "@ns";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { stepCareer, type CareerDecision, type CareerPriorityBand, type CareerView } from "../../../shared/strategy/career/decide.ts";
import type { CrimeStats } from "../../../shared/strategy/career/crimes.ts";
import {
  careerSchedule,
  careerWorkMode,
  updateActivityRate,
  type ActivityRateSample,
  type CareerWorkMode,
} from "../../../shared/strategy/career/schedule.ts";
import { isScriptDeath } from "../errors.ts";
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
 * It also shares the single `Player.currentWork` slot with `factions`, which
 * makes it the arbiter's primary test case: `career:blocking-need` (75) can
 * PREEMPT `factions:work` (60), while `career:income` (30) cannot. */

/** commitCrime + getCrimeStats + getCrimeChance, all SingularityFn3-ish. */
const PEAK_STEP_GB = 12;
const JOB_FIELDS = [
  "Software", "IT", "Network Engineer", "Security Engineer",
  "Business", "Software Consultant", "Business Consultant",
  "Security", "Agent", "Employee", "Part-time Employee",
  "Waiter", "Part-time Waiter",
] as const;

let lastDecision: CareerDecision | undefined;
let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
let lastReviewedAt: number | undefined;
let lastWorkMode: CareerWorkMode | undefined;
let lastCompletion: WorkCompletionNotice | undefined;
const companyRates = new Map<string, ActivityRateSample>();

export function resetCareerState(): void {
  lastDecision = undefined;
  lastResult = undefined;
  lastReviewedAt = undefined;
  lastWorkMode = undefined;
  lastCompletion = undefined;
  companyRates.clear();
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
  const nodeMults = state.topics.progression?.multipliers ?? {};

  // Crime stats come from the game, never a hardcoded table — and the game's
  // own success chance comes with them, so the strategy never has to recompute
  // a number it can simply be told.
  const crimes: CrimeStats[] = (career?.crimes ?? []).map((crime) => ({
    type: crime.name,
    timeMs: crime.timeMs,
    money: crime.money,
    difficulty: 1,
    // The probe reports karma as the game does (negative for the player);
    // the strategy wants the positive magnitude that gets subtracted.
    karma: Math.abs(crime.karma),
    kills: crime.kills ?? 0,
    weights: {},
    exp: crime.exp ?? {},
    chance: crime.chance,
  }));

  return {
    time: Date.now(),
    person: {
      skills: { ...(player.skills ?? {}) } as unknown as Record<string, number>,
      mults: { crime_success: mults["crime_success"] ?? 1, crime_money: mults["crime_money"] ?? 1 },
    },
    crimeContext: {
      crimeSuccessRate: nodeMults["CrimeSuccessRate"] ?? 1,
      crimeMoney: nodeMults["CrimeMoney"] ?? 1,
    },
    crimes,
    courses: [],
    karma: player.karma ?? 0,
    numPeopleKilled: player.numPeopleKilled ?? 0,
    skills: { ...(player.skills ?? {}) } as unknown as Record<string, number>,
    city: String(player.city ?? "Sector-12"),
    jobs: Object.fromEntries(Object.entries(player.jobs ?? {}).map(([company, job]) => [String(company), String(job)])),
    companies: Object.entries(career?.companies ?? {}).map(([name, company]) => ({
      name,
      rep: company.rep,
      ...(companyRates.get(name)?.perSec !== undefined ? { repPerSec: companyRates.get(name)!.perSec } : {}),
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
      // commitCrime returns the crime's duration in ms, or 0 when refused.
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
        stubNs["singularity"]["gymWorkout"]("Powerhouse Gym" as never, decision.action.subject as never, true),
      );
      if (result === refused) return false;
      const ok = result.value;
      record(Boolean(ok), ok ? `training ${decision.action.subject}` : "training refused");
      return true;
    }
    case "class": {
      const result = await replaceWork(["singularity.universityCourse"], (stubNs: NS) =>
        stubNs["singularity"]["universityCourse"]("Rothman University" as never, decision.action.subject as never, true),
      );
      if (result === refused) return false;
      const ok = result.value;
      record(Boolean(ok), ok ? `studying ${decision.action.subject}` : "course refused");
      return true;
    }
    case "travel": {
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
      const result = await replaceWork(["singularity.applyToCompany", "singularity.workForCompany"], (stubNs: NS) => {
        const job = stubNs["singularity"]["applyToCompany"](decision.action.subject as never, decision.action.field as never);
        const working = job
          ? false
          : stubNs["singularity"]["workForCompany"](decision.action.subject as never, true);
        return { job, working };
      });
      if (result === refused) return false;
      const { job, working } = result.value;
      record(
        Boolean(job || working),
        job
          ? `promoted to ${job} at ${decision.action.subject}`
          : working
            ? `not yet promotable on the ${decision.action.field} track; building company progress`
            : `not eligible to work on the ${decision.action.field} track`,
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

    sampleCompanyRates(ctx.state, now);
    const view = buildCareerView(ctx.state, ctx.grants.slot, ctx.grants.money, completion !== undefined);
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
          why: decision.action.why,
        },
        why: decision.why,
        incomeFallback: decision.incomeFallback,
        priority: { band: decision.workPriority, value: priorityForBand(decision.workPriority) },
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
          why: entry.action.why,
        })),
        serving: decision.serving,
        ...(lastResult ? { lastResult } : {}),
      },
    });

    try {
      let handled = false;
      if (decision.action.type === "idle" && needsCompletionWatcher(ctx.state) && !workCompletionArmed()) {
        handled = await observeAndArm(ctx);
      }
      if (decision.action.type !== "idle") handled = (await execute(ctx.ns, ctx, decision)) || handled;
      if (handled) lastWorkMode = careerWorkMode(ctx.state.topics.career?.currentWork?.type);
      if (completion && (handled || !ctx.grants.slot)) consumeWorkCompletion();
    } catch (error) {
      if (isScriptDeath(error)) throw error;
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
  // At a completion boundary another feature may win the work slot before
  // career ticks. Keep a separately-priced observation available even when
  // career also has a candidate action, so it records the replacement work
  // rather than retaining a stale CRIME digest until the 30-second probe.
  if (needsCompletionWatcher(ctx.state) && !workCompletionArmed() && (completion !== undefined || methods.length === 0)) {
    out.push(actionRamClaim(ctx, "career", "watch:completion", ["singularity.getCurrentWork"], "arm exact work completion wakeup"));
  }

  // Queue bands are deliberately spaced around faction work: blocking can
  // preempt it, wanted/nice cannot, and income is the floor.
  const progressLocked = careerWorkMode(ctx.state.topics.career?.currentWork?.type) === "progress" && completion === undefined;
  const band = candidate?.workPriority ?? "income";

  // A completable task gets an administrative lock until its authoritative
  // completion promise fires. Number.MAX_SAFE_INTEGER is intentional: the
  // event removes the lock; a guessed wall-clock deadline cannot do so safely.
  out.push({
    by: "career",
    id: "work",
    resource: "time",
    amount: 1,
    priority: progressLocked ? PRIORITY["career:progress-lock"] : priorityForBand(band),
    mode: "spend",
    ...(progressLocked ? { holdUntil: Number.MAX_SAFE_INTEGER } : {}),
    why: progressLocked
      ? "unbanked progress is in flight; wait for Task.nextCompletion"
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
    case "promote": return ["singularity.applyToCompany", "singularity.workForCompany", "singularity.getCurrentWork"];
    case "quit": return ["singularity.quitJob", "singularity.getCurrentWork"];
    case "travel": return ["singularity.travelToCity", "singularity.getCurrentWork"];
    case "continue": return ["singularity.getCurrentWork"];
    default: return [];
  }
}

function priorityForBand(band: CareerPriorityBand): number {
  switch (band) {
    case "blocking": return PRIORITY["career:blocking-need"];
    case "wanted": return PRIORITY["career:wanted-request"];
    case "nice": return PRIORITY["career:nice-request"];
    case "income": return PRIORITY["career:income"];
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

export function careerDecision(): CareerDecision | undefined {
  return lastDecision;
}

export const careerModule: FeatureModule = {
  driver,
  reset: resetCareerState,
  claims,
  peakStepGb: PEAK_STEP_GB,
};

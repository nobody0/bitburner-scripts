import type { NS } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { formatMoney } from "../../../shared/format.ts";
import { PRIORITY } from "../../../shared/strategy/arbiter.ts";
import { stepCareer, TRAINING_FUND_WINDOW_SEC, type CareerDecision, type CareerPriorityBand, type CareerView } from "../../../shared/strategy/career/decide.ts";
import type { CrimeStats } from "../../../shared/strategy/career/crimes.ts";
import { trainingBackdoorSavedRate } from "../../../shared/strategy/access/value.ts";
import type { Need, NeedBoard } from "../../../shared/strategy/needs.ts";
import { COMPANY_POSITIONS } from "../../../shared/features/companies.ts";
import { applyOutcomes, companyRepPerSec, trackFieldFor } from "../../../shared/strategy/career/company.ts";
import {
  careerSchedule,
  careerWorkMode,
  progressLockUntil,
  updateActivityRate,
  type ActivityRateSample,
  type CareerWorkMode,
} from "../../../shared/strategy/career/schedule.ts";
import { PORT_OPENER_PROGRAMS, programCreateTimeMs } from "../../../shared/strategy/career/programs.ts";
import { nodeHorizonSec } from "../../../shared/strategy/progression/forecast.ts";
import { CAREER_TRAINING_OPTIONS } from "../../../shared/strategy/career/training.ts";
import { isScriptDeath } from "../errors.ts";
import { moneyRateValue, slotRates } from "../income.ts";
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
import type { FeatureClaim } from "./claims.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** The career driver.
 *
 * Career is the needs board's main consumer: it satisfies other features'
 * karma, kill, stat, charisma and city thresholds, and doubles as the
 * early-game income floor when nothing is outstanding.
 *
 * It also shares the single `Player.currentWork` slot with `factions`, which makes
 * it the arbiter's primary test case. `career:blocking-need` can preempt faction
 * work. The income band has no fixed answer: it is scored against the best
 * earning rate anyone announced, so crime outranks reputation work exactly when it is
 * genuinely our best earner, and loses when it is not. See
 * `shared/strategy/income.ts`.
 *
 * Pinned upstream work-start and administrative call contracts:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L226-L405
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L668-L746
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L965-L1065 */

/** commitCrime + getCrimeStats + getCrimeChance, all SingularityFn3-ish. */
const JOB_FIELDS = [
  "Software", "IT", "Network Engineer", "Security Engineer",
  "Business", "Software Consultant", "Business Consultant",
  "Security", "Agent", "Employee", "Part-time Employee",
  "Waiter", "Part-time Waiter",
] as const;
const TRAVEL_COST = 200_000;

let lastDecision: CareerDecision | undefined;
let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
let actionQueued = false;
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
/** Where that course runs, latched with it: a backdoor on the location's
 * server discounts the drain 10%, and the needs producer below asks for one
 * while a paid course is planned or running. */
let trainingLocation: string | undefined;

/** The game's location -> server binding for the two paid training venues.
 * A transcription, not a heuristic: the gym's server organization is
 * "Powerhouse Fitness" while its location is "Powerhouse Gym", so an
 * organizationName match cannot recover this. Matches the hostnames the
 * discount read in buildCareerView already uses.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Locations/data/LocationsMetadata.ts */
const TRAINING_LOCATION_SERVERS: Record<string, string> = {
  "Rothman University": "rothman-uni",
  "Powerhouse Gym": "powerhouse-fitness",
};
/** The pure view that produced lastDecision. Claims run much more frequently
 * than career's five-second review; rebuilding every crime/course/company
 * option merely to re-price the same slot claim is wasted planner time. */
let lastView: CareerView | undefined;

export function resetCareerState(): void {
  trainingCostPerSec = 0;
  trainingLocation = undefined;
  lastDecision = undefined;
  lastView = undefined;
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
  board: NeedBoard,
  holdsWorkSlot: boolean,
  moneyGranted: number,
  horizonSec: number,
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
    ? CAREER_TRAINING_OPTIONS.map((option) => ({
        name: option.name,
        skill: option.skill,
        expPerSec: option.expPerSec
          * (option.kind === "gym" ? gymMult : studyMult)
          * (mults[`${option.skill}_exp`] ?? 1)
          * classExp,
        costPerSec: option.costPerSec * (option.kind === "gym" ? powerhouseCostMult : rothmanCostMult),
        location: option.location,
      }))
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
  const companyWork = companyModelInputs(state)!;
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
    rates: slotRates(state, board),
    planningHorizonSec: horizonSec,
    city: String(player.city ?? "Sector-12"),
    jobs: Object.fromEntries(Object.entries(player.jobs ?? {}).map(([company, job]) => [String(company), String(job)])),
    companies: Object.entries(career?.companies ?? {}).map(([name, company]) => ({
      name,
      rep: company.rep,
      favor: company.favor,
      ...(companyRates.get(name)?.perSec !== undefined ? { repPerSec: companyRates.get(name)!.perSec } : {}),
      ...(() => {
        const title = (player.jobs as Record<string, string> | undefined)?.[name];
        const held = title !== undefined ? COMPANY_POSITIONS[String(title)] : undefined;
        return held
          ? { estimatedRepPerSec: companyRepPerSec(companyWork.person, held, company.favor, companyWork.ctx) }
          : {};
      })(),
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
    // The crime table is the menu's other half and arrives from a five-minute
    // dodged probe, one dodged probe per pass — so the first commitments of a
    // run are made before it exists. Reporting its absence lets the planner
    // hold off on anything that would occupy the slot, rather than concluding
    // from an empty menu that nothing else was worth doing.
    menuComplete: career?.crimes !== undefined,
    ...(career?.currentWork
      ? {
          currentWork: {
            kind: String(career.currentWork.type).toLowerCase(),
            subject: career.currentWork.detail,
            // Cycles are 200 ms, plus the drift since the observation, the same
            // reconstruction `progressLockUntil` does. A part-finished program
            // write is charged only the time it has LEFT, so a write that starts
            // can finish instead of being re-judged against its full cost every
            // pass. The game recomputes the write rate as hacking rises, so wall
            // clock slightly UNDER-states progress on a levelling player — that
            // over-charges the write, which is the safe direction.
            elapsedSec: ((career.currentWork.cyclesWorked ?? 0) * 200
              + Math.max(0, Date.now() - (career.currentWork.observedAt ?? Date.now()))) / 1_000,
          },
        }
      : {}),
    ...(allowProgressSwitch ? { allowProgressSwitch: true } : {}),
    moneyGranted,
    companyWork,
  };
}

/** Work-line model inputs: exact v3.0.1 position formulas, so companies we
 * have never measured still rank by a real rate instead of the neutral
 * exploration constant. Career starts company work focused, so no 0.8. */
function companyModelInputs(state: GameState): NonNullable<CareerView["companyWork"]> | undefined {
  const player = state.topics.player;
  if (!player) return undefined;
  const mults = (player.mults ?? {}) as unknown as Record<string, number>;
  const progression = state.topics.progression;
  const nodeMults = effectiveBitNodeMultipliers(
    progression?.bitNode,
    progression?.sourceFiles["12"] ?? 0,
    progression?.multipliers,
  ) ?? {};
  const skills = { ...(player.skills ?? {}) } as unknown as Record<string, number>;
  const charisma = skills["charisma"] ?? 0;
  const sf15SalaryMult = (progression?.sourceFiles["15"] ?? 0) > 1
    ? 1 + 0.5 * (1 - Math.exp(-0.0002 * charisma)) + 0.9 * (1 - Math.exp(-0.00004 * charisma))
    : 1;
  return {
    person: {
      skills,
      mults: {
        company_rep: mults["company_rep"] ?? 1,
        work_money: mults["work_money"] ?? 1,
      },
    },
    ctx: {
      companyWorkRepGain: nodeMults["CompanyWorkRepGain"] ?? 1,
      companyWorkMoney: nodeMults["CompanyWorkMoney"] ?? 1,
      focusMult: 1,
      sf11SalaryFavor: (progression?.sourceFiles["11"] ?? 0) > 0,
      sf15SalaryMult,
    },
  };
}

/** Whether any server the game attributes to this company is backdoored. The
 * game discounts every position's reputation requirement by 25% while one is,
 * so a model that ignores it under-reports the rung the player qualifies for —
 * and `promotionField` then declines to ask for a promotion the game would
 * grant on the spot. */
function companyBackdoored(state: GameState, company: string): boolean {
  for (const server of Object.values(state.topics.servers ?? {})) {
    if (server.organizationName === company && server.backdoorInstalled) return true;
  }
  return false;
}

/** The field to re-apply on when a better position than the held one is
 * qualified right now, else undefined. */
function promotionField(state: GameState, company: string | undefined): string | undefined {
  if (company === undefined) return undefined;
  const work = companyModelInputs(state);
  const held = (state.topics.player?.jobs as Record<string, string> | undefined)?.[company];
  if (!work || held === undefined) return undefined;
  // Strictly WITHIN the held track. `applyToCompany` assigns whatever rung the
  // requested field resolves to, higher or lower, so following a cross-field
  // rate comparison here would silently drop the current title — including one
  // a jobTitle objective is mid-climb toward (the strategy's chosen track
  // arrives through the `apply`/`promote` actions, which carry their field).
  const field = trackFieldFor(String(held));
  if (field === undefined) return undefined;
  const standing = state.topics.career?.companies?.[company];
  const ctx = { ...work.ctx, backdoored: companyBackdoored(state, company) };
  const best = applyOutcomes(company, work.person, standing?.rep ?? 0, standing?.favor ?? 0, ctx)
    .find((outcome) => outcome.field === field);
  return best !== undefined && best.position !== String(held) ? best.field : undefined;
}

/** Application field order: qualified tracks best-rate-first from the position
 * table, the strategy's explicit field (title paths) up front, and the blind
 * preference sweep only when the model sees nothing. */
function applyFieldOrder(state: GameState, company: string | undefined, preferred: string | undefined): string[] {
  const work = company !== undefined ? companyModelInputs(state) : undefined;
  const standing = company !== undefined ? state.topics.career?.companies?.[company] : undefined;
  const ranked = work && company !== undefined
    ? applyOutcomes(
        company,
        work.person,
        standing?.rep ?? 0,
        standing?.favor ?? 0,
        { ...work.ctx, backdoored: companyBackdoored(state, company) },
      )
        .sort((a, b) => b.repPerSec - a.repPerSec || b.salaryPerSec - a.salaryPerSec)
        .map((outcome) => outcome.field)
    : [];
  const fields = ranked.length > 0 ? ranked : [...JOB_FIELDS];
  return preferred !== undefined ? [preferred, ...fields.filter((field) => field !== preferred)] : fields;
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
  actionQueued = false;
  const at = Date.now();
  const record = (ok: boolean, detail: string): void => {
    lastResult = { action: decision.action.type, ok, detail, at };
  };

  const refused = Symbol("feature dodge refused");
  const run = async <T>(methods: readonly string[], body: (stubNs: NS) => T | Promise<T>): Promise<T | typeof refused> => {
    const outcome = await featureDodge(ctx, "career", actionClaimId(decision.action.type), methods, body);
    if (!outcome.ok) {
      if (outcome.queued) actionQueued = true;
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
    case "stop": {
      // The only path that gives the slot back. `idle` deliberately does not:
      // it means "leave the current work alone", and three separate branches
      // emit it to mean exactly that. Stopping is a different statement, and
      // it needs its own action or work the planner has abandoned runs until
      // the game itself ends it.
      const result = await replaceWork(["singularity.stopAction"], (stubNs: NS) =>
        stubNs["singularity"]["stopAction"](),
      );
      if (result === refused) return false;
      record(Boolean(result.value), result.value ? `stopped ${decision.action.subject ?? "work"}` : "nothing was running");
      return true;
    }
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
      // Promotion is free value on the same call budget: the game's apply
      // takes the highest qualified rung, so when the work-line model says a
      // better position than the held one is qualified, re-apply before
      // starting the work. A null return (nothing better) is harmless.
      const promotion = promotionField(ctx.state, decision.action.subject);
      const result = await replaceWork(
        promotion ? ["singularity.applyToCompany", "singularity.workForCompany"] : ["singularity.workForCompany"],
        (stubNs: NS) => {
          if (promotion) stubNs["singularity"]["applyToCompany"](decision.action.subject as never, promotion as never);
          return stubNs["singularity"]["workForCompany"](decision.action.subject as never, true);
        },
      );
      if (result === refused) return false;
      const ok = result.value;
      record(Boolean(ok), ok ? `working for ${decision.action.subject}` : "company work refused");
      return true;
    }
    case "apply": {
      // Field order comes from the position table: only tracks whose entry
      // rung this company offers and this player qualifies for, best rep rate
      // first. The blind full-list sweep (which threw for every field the
      // company lacks) remains only as the fallback when the model sees no
      // qualified track — the game is authoritative, so one last sweep is
      // cheaper than wrongly recording "no eligible position".
      const fields = applyFieldOrder(ctx.state, decision.action.subject, decision.action.field);
      const result = await replaceWork(["singularity.applyToCompany"], (stubNs: NS) => {
        for (const field of fields) {
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
  // Every action this driver can execute is a Singularity call. `career` is
  // conceptually always useful (and stays visible as a strategy feature), but
  // automation is impossible on a fresh character until BN4/SF4 unlocks the
  // same API surface that powers `factions`. Without this dependency a cold
  // BN1 controller repeatedly bid for 40.5 GB university stubs and the shared
  // work slot even though every call was guaranteed to throw.
  requires: "factions",
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
    const view = buildCareerView(ctx.state, ctx.board, ctx.grants.slot, ctx.grants.money, nodeHorizonSec(ctx.horizons.node), completionBoundary);
    if (!view) return;
    const decision = stepCareer(view, ctx.board);
    lastDecision = decision;
    lastView = view;
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
        priority: { band: decision.workPriority, value: decision.ranked[0]?.score ?? 0 },
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
          deliveryFraction: entry.deliveryFraction,
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
      // Per-PASS state, not per-execute: `execute` is skipped entirely on an
      // idle decision or while the action is backed off, and a stale `true`
      // left over from an earlier pass then blocks `consumeWorkCompletion`
      // forever — career keeps re-deciding against a completion that already
      // happened for as long as it stays idle.
      actionQueued = false;
      if (!completion && decision.action.type === "idle" && needsCompletionWatcher(ctx.state) && !workCompletionArmed()) {
        handled = await observeAndArm(ctx);
      }
      if (decision.action.type !== "idle" && (executeBackoff.get(actionKey) ?? 0) <= now) {
        handled = (await execute(ctx.ns, ctx, decision)) || handled;
      }
      if (handled) lastWorkMode = careerWorkMode(ctx.state.topics.career?.currentWork?.type);
      if (completion && !actionQueued && (handled || !ctx.grants.slot)) consumeWorkCompletion();
    } catch (error) {
      if (isScriptDeath(error)) throw error;
      executeBackoff.set(actionKey, Date.now() + EXECUTE_BACKOFF_MS);
      lastResult = { action: decision.action.type, ok: false, detail: String(error), at: Date.now() };
    }
  },
};

/** Career posts no needs of its own — it consumes the requests other features
 * queue on the needs board. */
function claims(ctx: ClaimContext): FeatureClaim[] {
  const out: FeatureClaim[] = [];
  const completion = peekWorkCompletion();
  const schedule = careerSchedule({
    now: ctx.now,
    ...(lastReviewedAt !== undefined ? { lastReviewedAt } : {}),
    currentWorkType: ctx.state.topics.career?.currentWork?.type,
    completionPending: completion !== undefined,
  });

  let candidate = lastDecision;
  let candidateView = lastView;
  if (schedule.due) {
    candidateView = buildCareerView(ctx.state, ctx.board, true, ctx.state.topics.player?.money ?? 0, nodeHorizonSec(ctx.horizons.node), completion !== undefined);
    if (candidateView) candidate = stepCareer(candidateView, ctx.board);
  }
  // What the slot claim ANNOUNCES: the rates the selected option would produce.
  // `ranked[0]` is the option the slot would actually run — the emitted action
  // can be idle or continue because work is already in flight or the slot is
  // held elsewhere, and neither of those changes what career is bidding to do.
  const candidateProduces = candidate?.ranked[0]?.produces ?? {};
  // ...and how much of that the slot actually DELIVERS. Career ranks its own
  // options against each other before bidding the winner here, so a discount
  // applied only inside that ranking would be re-inflated the moment the bid met
  // another feature's claim — an eight-hour write would still outbid faction
  // reputation at full worth. Absent means 1; only a bounded option sets it.
  const candidateDelivery = candidate?.ranked[0]?.deliveryFraction;
  // Money and dodge RAM are still banded — neither is auctioned on rates — and
  // both take the urgency of the request career is serving. An income-fallback
  // course scored into the blocking band would reserve tuition above
  // `factions:aug-fund`, which is why this is the plain band and not the bid.
  const bandPriority = priorityForBand(candidate?.workPriority ?? "income");

  const actionType = schedule.due ? candidate?.action.type : undefined;
  // The same signal the dodge uses, so the reservation matches what the stub
  // can actually spend.
  const methods = careerMethods(
    actionType,
    actionType === "company" && promotionField(ctx.state, candidate?.action.subject) !== undefined,
  );
  if (actionType && methods.length > 0) {
    // Player time and the dodge that STARTS that work are one atomic action —
    // the same rule factions applies to its work RAM. Left at the probe band,
    // career could win the slot at `career:blocking-need` and then lose the RAM
    // to factions' route work at 91, holding `Player.currentWork` without ever
    // being able to call commitCrime/universityCourse.
    out.push(actionRamClaim(ctx, "career", actionClaimId(actionType), methods, bandPriority));
  }
  if (actionType === "travel") {
    out.push({
      by: "career",
      id: "travel-fund",
      resource: "money",
      amount: TRAVEL_COST,
      priority: bandPriority,
      mode: "spend",
      shape: "step",
      pricing: "hard",
      value: { state: "unknown", reason: "hard-priority atomic claim" },
    });
  }
  if (actionType === "class" || actionType === "gym") {
    const option = candidate?.ranked.find((entry) => entry.action === candidate?.action);
    const costPerSec = Math.max(0, -(option?.moneyPerSec ?? 0));
    if (costPerSec > 0) {
      trainingCostPerSec = costPerSec;
      trainingLocation = option?.action.location ?? trainingLocation;
      out.push({
        by: "career",
        id: "training-fund",
        resource: "money",
        amount: costPerSec * TRAINING_FUND_WINDOW_SEC,
        priority: bandPriority,
        mode: "reserve",
        shape: "step",
        pricing: "hard",
        value: { state: "unknown", reason: "hard-priority atomic claim" },
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
      priority: bandPriority,
      mode: "reserve",
      shape: "step",
      pricing: "hard",
      value: { state: "unknown", reason: "hard-priority atomic claim" },
    });
  } else if (ctx.state.topics.career?.currentWork?.type !== "CLASS") {
    trainingCostPerSec = 0;
    trainingLocation = undefined;
  }
  // At a completion boundary another feature may win the work slot before
  // career ticks. Keep a separately-priced observation available even when
  // career also has a candidate action, so it records the replacement work
  // rather than retaining a stale CRIME digest until the 30-second probe.
  if (needsCompletionWatcher(ctx.state) && !workCompletionArmed() && (completion !== undefined || methods.length === 0)) {
    out.push(actionRamClaim(ctx, "career", "watch:completion", ["singularity.getCurrentWork"]));
  }

  // A task with unbanked progress gets an administrative lock, bounded by the
  // moment that progress banks — see `progressLockUntil` for why an unbounded one
  // wedged the whole run. Before the boundary the lock is absolute: cancelling a
  // crime at 99% throws the entire thing away. At the boundary the claim drops back
  // to its PRICED form, so the end of a crime is a fair re-evaluation of what to
  // work rather than an automatic renewal — which is what let a 10-minute Heist
  // hold the slot against faction work indefinitely.
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
    shape: "step",
    pricing: "hard",
    value: { state: "unknown", reason: "a time claim is priced by `produces`, not by this field" },
    // The lock is a HARD claim (no `produces`): it is not asserting that crime
    // is worth more than reputation, only that throwing away an unbanked unit
    // costs more than the few remaining seconds are worth to anyone else. Off
    // the lock the band is reported but not consulted — the bid is `produces`.
    priority: lockUntil !== undefined ? PRIORITY["career:progress-lock"] : PRIORITY["career:income"],
    mode: "spend",
    ...(lockUntil !== undefined
      ? { holdUntil: lockUntil }
      : {
          produces: candidateProduces,
          ...(candidateDelivery !== undefined && candidateDelivery < 1
            ? { deliveryFraction: candidateDelivery }
            : {}),
        }),
  });
  return out;
}

function actionClaimId(type: string): string {
  return `action:${type}`;
}

function careerMethods(type: string | undefined, promotion = false): readonly string[] {
  switch (type) {
    case "crime": return ["singularity.commitCrime", "singularity.getCurrentWork"];
    case "gym": return ["singularity.gymWorkout", "singularity.getCurrentWork"];
    case "class": return ["singularity.universityCourse", "singularity.getCurrentWork"];
    // applyToCompany rides along ONLY when a promotion is actually due, exactly
    // as the dodge decides it. Pricing it unconditionally over-reserved 3 GB on
    // every ordinary work start — 12 GB at SF4 level 2, 48 at level 0, since the
    // singularity multiplier scales it.
    case "company": return promotion
      ? ["singularity.workForCompany", "singularity.applyToCompany", "singularity.getCurrentWork"]
      : ["singularity.workForCompany", "singularity.getCurrentWork"];
    case "apply": return ["singularity.applyToCompany", "singularity.getCurrentWork"];
    case "promote": return ["singularity.applyToCompany", "singularity.getCurrentWork"];
    case "quit": return ["singularity.quitJob", "singularity.getCurrentWork"];
    case "travel": return ["singularity.travelToCity", "singularity.getCurrentWork"];
    case "continue": return ["singularity.getCurrentWork"];
    // Giving the slot back is an action like any other and needs its RAM
    // claimed the same way: without an entry here no claim is posted, the
    // dodge is refused for want of a lease, and the work it was meant to end
    // keeps running — the exact failure this action exists to fix.
    case "stop": return ["singularity.stopAction", "singularity.getCurrentWork"];
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

/** What career's MONEY claims are banded at.
 *
 * Money claims — tuition, a travel fare — are still ordered by the lattice:
 * they are one-off spends whose worth is the urgency of the need they unblock,
 * and the money pool has its own economic layer for everything continuous.
 *
 * The WORK SLOT is no longer banded here at all. It carries what it produces
 * and is priced against the field (`shared/strategy/income.ts`); the whole
 * `priorityForDecision` special case for Algorithms went with it, because that
 * function was a hand-rolled instance of exactly this arithmetic — course
 * experience as a fraction of the fleet's, times what hacking time is worth —
 * applied to one hardcoded course name. */
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

export const careerModule: FeatureModule = {
  driver,
  reset: (state) => {
    resetCareerState();
    // Jobs, work state and crime stats from the ended node.
    delete state.topics.career;
  },
  claims,
  // While a PAID course is planned or running, a backdoor on the venue's
  // server is worth 10% of the drain. Posted as "nice" with the measured
  // BN-second value of that saved rate: it accelerates training, it gates
  // nothing, and it disappears the moment training stops. hacking owns the
  // `backdoor` kind and decides when the install is worth its RAM.
  needs: (ctx: NeedContext): Need[] => {
    if (!(trainingCostPerSec > 0) || trainingLocation === undefined) return [];
    const host = TRAINING_LOCATION_SERVERS[trainingLocation];
    const server = host !== undefined ? ctx.state.topics.servers?.[host] : undefined;
    if (!server || server.backdoorInstalled) return [];
    const value = moneyRateValue(ctx.state, trainingBackdoorSavedRate(trainingCostPerSec), ctx.now);
    return [{
      by: "career",
      kind: "backdoor",
      subject: server.hostname,
      target: 1,
      have: 0,
      weight: 1,
      ...(value.state === "measured" && value.value > 0 ? { valueSec: value.value } : {}),
      urgency: "nice",
    }];
  },
};

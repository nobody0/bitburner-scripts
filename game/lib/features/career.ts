import type { NS } from "@ns";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { stepCareer, type CareerDecision, type CareerView } from "../../../shared/strategy/career/decide.ts";
import type { CrimeStats } from "../../../shared/strategy/career/crimes.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { isScriptDeath } from "../errors.ts";
import { merge, type GameState } from "../state.ts";
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

let lastDecision: CareerDecision | undefined;
let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;

export function resetCareerState(): void {
  lastDecision = undefined;
  lastResult = undefined;
}

function buildCareerView(ctx: DriverContext): CareerView | undefined {
  const player = ctx.state.topics.player;
  const career = ctx.state.topics.career;
  if (!player) return undefined;

  const mults = (player.mults ?? {}) as unknown as Record<string, number>;
  const nodeMults = ctx.state.topics.progression?.multipliers ?? {};

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
    holdsWorkSlot: ctx.grants.slot,
    ...(career?.currentWork
      ? {
          currentWork: {
            kind: String(career.currentWork.type).toLowerCase(),
            subject: career.currentWork.detail,
          },
        }
      : {}),
    moneyGranted: ctx.grants.money,
  };
}

async function execute(ns: NS, ctx: DriverContext, decision: CareerDecision): Promise<void> {
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

  switch (decision.action.type) {
    case "idle":
      return;
    case "crime": {
      // commitCrime returns the crime's duration in ms, or 0 when refused.
      const ms = await run(["singularity.commitCrime"], (stubNs: NS) =>
        stubNs["singularity"]["commitCrime"](decision.action.subject as never, decision.action.focus),
      );
      if (ms === refused) return;
      record(Boolean(ms), ms ? `committing ${decision.action.subject}` : "crime refused");
      return;
    }
    case "gym": {
      const ok = await run(["singularity.gymWorkout"], (stubNs: NS) =>
        stubNs["singularity"]["gymWorkout"]("Powerhouse Gym" as never, decision.action.subject as never, true),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `training ${decision.action.subject}` : "training refused");
      return;
    }
    case "class": {
      const ok = await run(["singularity.universityCourse"], (stubNs: NS) =>
        stubNs["singularity"]["universityCourse"]("Rothman University" as never, decision.action.subject as never, true),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `studying ${decision.action.subject}` : "course refused");
      return;
    }
    case "travel": {
      const ok = await run(["singularity.travelToCity"], (stubNs: NS) =>
        stubNs["singularity"]["travelToCity"](decision.action.subject as never),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `travelled to ${decision.action.subject}` : "travel refused");
      return;
    }
    case "company":
      record(false, "company work is not implemented yet");
      return;
  }
}

const driver: FeatureDriver = {
  id: "career",
  everyMs: 10_000,
  async tick(ctx: DriverContext) {
    const view = buildCareerView(ctx);
    if (!view) return;
    const decision = stepCareer(view, ctx.board);
    lastDecision = decision;

    merge(ctx.state, "career", {
      plan: {
        action: { type: decision.action.type, ...(decision.action.subject !== undefined ? { subject: decision.action.subject } : {}), why: decision.action.why },
        why: decision.why,
        incomeFallback: decision.incomeFallback,
        ranked: decision.ranked.slice(0, 8).map((entry) => ({
          label: `${entry.action.type}: ${entry.action.subject ?? ""}`,
          score: entry.score,
          moneyPerSec: entry.moneyPerSec,
          why: entry.action.why,
        })),
        serving: decision.serving,
        ...(lastResult ? { lastResult } : {}),
      },
    });

    try {
      await execute(ctx.ns, ctx, decision);
    } catch (error) {
      if (isScriptDeath(error)) throw error;
      lastResult = { action: decision.action.type, ok: false, detail: String(error), at: Date.now() };
    }
  },
};

/** Career posts no needs of its own today — it is the board's consumer, not a
 * requester. When company work lands it will want money for travel. */
function claims(ctx: ClaimContext): Claim[] {
  const out: Claim[] = [];
  const actionType = ctx.state.topics.career?.plan?.action.type;
  const methods = careerMethods(actionType);
  if (actionType && methods.length > 0) {
    out.push(actionRamClaim(ctx, "career", actionClaimId(actionType), methods, `career ${actionType}`));
  }

  // The arbiter's primary test case. A BLOCKING need outranks ordinary faction
  // work by more than PREEMPT_MARGIN, so career can take the slot mid-session
  // to clear something another feature is stuck on; with nothing outstanding
  // it bids `career:income`, which deliberately CANNOT preempt.
  const serving = ctx.board.open.some((need) => need.urgency === "blocking" && careerCanServe(need));

  // A crime already in flight HOLDS the slot until it completes.
  //
  // Without this the arbiter hands the slot to `factions` (60) the moment
  // career drops to `career:income` (30), and the next `workForFaction`
  // CANCELS the crime outright — the game does not queue work, it replaces
  // it. A Heist is ten minutes; losing one at 1.5% done costs more than any
  // reputation the preemption could have bought. `holdUntil` is precisely the
  // mechanism for "do not interrupt this yet".
  const running = runningCrimeEndsAt(ctx.state, ctx.now);
  out.push({
    by: "career",
    id: "work",
    resource: "time",
    amount: 1,
    priority: serving ? PRIORITY["career:blocking-need"] : PRIORITY["career:income"],
    mode: "spend",
    ...(running !== undefined ? { holdUntil: running } : {}),
    why: serving
      ? "clearing a blocking need from the board"
      : running !== undefined
        ? "a crime is in flight and would be cancelled by a switch"
        : "early-game income",
  });
  return out;
}

function actionClaimId(type: string): string {
  return `action:${type}`;
}

function careerMethods(type: string | undefined): readonly string[] {
  switch (type) {
    case "crime": return ["singularity.commitCrime"];
    case "gym": return ["singularity.gymWorkout"];
    case "class": return ["singularity.universityCourse"];
    case "travel": return ["singularity.travelToCity"];
    default: return [];
  }
}

/** When the in-flight crime finishes, or undefined if none is running.
 *
 * Read from the store rather than tracked here, so a crime the player started
 * by hand is respected exactly like one this driver started. */
function runningCrimeEndsAt(state: GameState, now: number): number | undefined {
  const work = state.topics.career?.currentWork;
  if (!work || String(work.type).toUpperCase() !== "CRIME") return undefined;
  const crime = (state.topics.career?.crimes ?? []).find((entry) => entry.name === work.detail);
  if (!crime) return undefined;
  // REMAINING time, from the cycles already worked — not the full duration.
  //
  // Recomputing `now + timeMs` every tick would extend the hold indefinitely
  // and career would never release the slot at all, which is exactly as broken
  // as releasing it mid-crime: `factions` could never work again.
  const elapsedMs = (work.cyclesWorked ?? 0) * 200;
  const remainingMs = crime.timeMs - elapsedMs;
  return remainingMs > 0 ? now + remainingMs : undefined;
}

function careerCanServe(need: Need): boolean {
  return ["karma", "kills", "combatSkills", "charisma", "skill", "money", "city"].includes(need.kind);
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

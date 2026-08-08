import type { NeedBoard, NeedKind } from "../needs.ts";
import { needKey } from "../needs.ts";
import {
  expPerSec,
  karmaPerSec,
  killsPerSec,
  moneyPerSec,
  successChance,
  type CrimeContext,
  type CrimePerson,
  type CrimeStats,
} from "./crimes.ts";

/** The career decision.
 *
 * This is the CONSUMER SIDE of the needs board, and the whole reason the board
 * exists. `factions` posts `{kind:"karma", target:-45}` — an outcome — and
 * says nothing about how. Career reads the board, folds it into objective
 * weights, and decides for itself whether that is Mug or Homicide, or whether
 * a gym session serves more posted needs per second.
 *
 * The objective is literally `Σ needWeight_k · progress_k/sec`: every action is
 * scored by how fast it moves the outcomes somebody is actually blocked on.
 * A need nobody posted is worth zero, so career does not grind karma nobody
 * wants — it falls back to income.
 *
 * The action set is TINY (12 crimes, 4 classes, a gym, company work), so
 * ranking it exhaustively is not a heuristic: for a fixed stat vector this is
 * the provable optimum over the available actions. */

export type CareerActionType = "crime" | "class" | "gym" | "company" | "travel" | "idle";

export interface CareerAction {
  type: CareerActionType;
  /** Crime type, course name, gym stat, company name, city. */
  subject?: string;
  focus?: boolean;
  why: string;
}

export interface ScoredAction {
  action: CareerAction;
  /** Σ needWeight · progress/sec — the objective. */
  score: number;
  /** Money per second, reported separately: it is the fallback objective when
   *  no need is outstanding, and always worth showing. */
  moneyPerSec: number;
  /** Per-outcome contributions, for the UI's "why this action" column. */
  contributions: { kind: NeedKind; subject?: string; perSec: number; weight: number }[];
}

export interface CareerView {
  time: number;
  person: CrimePerson;
  crimeContext: CrimeContext;
  /** Crime stats from ns.singularity.getCrimeStats — never hardcoded here. */
  crimes: CrimeStats[];
  /** Courses available, with their cost and stat. */
  courses: { name: string; skill: string; expPerSec: number; costPerSec: number }[];
  karma: number;
  numPeopleKilled: number;
  skills: Record<string, number>;
  city: string;
  /** Whether this feature holds Player.currentWork this tick. */
  holdsWorkSlot: boolean;
  currentWork?: { kind: string; subject?: string };
  /** Money the arbiter granted, for paid courses. */
  moneyGranted: number;
}

export interface CareerDecision {
  action: CareerAction;
  /** Everything considered, best first. Rendered so a choice can be argued. */
  ranked: ScoredAction[];
  /** Needs this feature is currently serving. */
  serving: { kind: NeedKind; subject?: string; weight: number; progress: number }[];
  /** True when the chosen action is income rather than a posted need. */
  incomeFallback: boolean;
  why: string;
}

/** Kinds career can actually deliver. Anything else on the board belongs to
 * another feature and is ignored here rather than scored at zero — the
 * distinction matters for the UI, which shows who owns what. */
export const CAREER_KINDS: readonly NeedKind[] = [
  "karma",
  "kills",
  "combatSkills",
  "charisma",
  "skill",
  "money",
  "companyRep",
  "jobTitle",
  "employment",
  "quitCompany",
  "city",
];

/** How much a unit of progress on each outstanding need is worth.
 *
 * Only UNSATISFIED needs contribute — that is what stops career grinding karma
 * it has already delivered. The weight is normalised by what remains, so a
 * need that is 1% short is worth far more per unit than one that is 99% short:
 * finishing something unblocks a whole feature, while inching toward a distant
 * threshold does not. */
export function needValues(board: NeedBoard): Map<string, { kind: NeedKind; subject?: string; weight: number; remaining: number }> {
  const out = new Map<string, { kind: NeedKind; subject?: string; weight: number; remaining: number }>();
  for (const need of board.open) {
    if (!CAREER_KINDS.includes(need.kind)) continue;
    const key = needKey(need);
    const remaining = Math.abs(need.target - need.have);
    const existing = out.get(key);
    if (existing) {
      existing.weight += need.weight;
      existing.remaining = Math.min(existing.remaining, remaining);
      continue;
    }
    out.set(key, {
      kind: need.kind,
      ...(need.subject !== undefined ? { subject: need.subject } : {}),
      weight: need.weight,
      remaining: Math.max(1e-9, remaining),
    });
  }
  return out;
}

function scoreCrime(
  crime: CrimeStats,
  view: CareerView,
  values: ReturnType<typeof needValues>,
): ScoredAction {
  const contributions: ScoredAction["contributions"] = [];
  let score = 0;

  const add = (kind: NeedKind, perSec: number, subject?: string): void => {
    if (perSec <= 0) return;
    const value = values.get(needKey({ kind, subject }));
    if (!value) return;
    // Fraction of the remaining gap closed per second, times its worth.
    const contribution = (perSec / value.remaining) * value.weight;
    score += contribution;
    contributions.push({ kind, ...(subject !== undefined ? { subject } : {}), perSec, weight: value.weight });
  };

  add("karma", karmaPerSec(crime, view.person, view.crimeContext));
  add("kills", killsPerSec(crime, view.person, view.crimeContext));
  const money = moneyPerSec(crime, view.person, view.crimeContext);
  add("money", money);

  const exp = expPerSec(crime, view.person, view.crimeContext);
  // Combat needs are satisfied by the WEAKEST of the four, so a crime that
  // trains only one of them barely helps — scoring by the minimum is what
  // makes the planner prefer balanced crimes when combat is what is wanted.
  const combat = Math.min(
    exp["strength"] ?? 0,
    exp["defense"] ?? 0,
    exp["dexterity"] ?? 0,
    exp["agility"] ?? 0,
  );
  add("combatSkills", combat);
  add("charisma", exp["charisma"] ?? 0);
  for (const [skill, rate] of Object.entries(exp)) add("skill", rate, skill);

  return {
    action: {
      type: "crime",
      subject: crime.type,
      focus: true,
      why: `${(successChance(crime, view.person, view.crimeContext) * 100).toFixed(0)}% success, $${Math.round(money)}/sec`,
    },
    score,
    moneyPerSec: money,
    contributions,
  };
}

function scoreCourse(
  course: CareerView["courses"][number],
  view: CareerView,
  values: ReturnType<typeof needValues>,
): ScoredAction {
  const contributions: ScoredAction["contributions"] = [];
  let score = 0;
  const add = (kind: NeedKind, perSec: number, subject?: string): void => {
    if (perSec <= 0) return;
    const value = values.get(needKey({ kind, subject }));
    if (!value) return;
    score += (perSec / value.remaining) * value.weight;
    contributions.push({ kind, ...(subject !== undefined ? { subject } : {}), perSec, weight: value.weight });
  };
  add("skill", course.expPerSec, course.skill);
  if (course.skill === "charisma") add("charisma", course.expPerSec);
  if (["strength", "defense", "dexterity", "agility"].includes(course.skill)) {
    // A gym trains ONE stat, and a combat need is gated by the weakest — so
    // training the strongest stat contributes nothing to it.
    const weakest = Math.min(
      view.skills["strength"] ?? 0,
      view.skills["defense"] ?? 0,
      view.skills["dexterity"] ?? 0,
      view.skills["agility"] ?? 0,
    );
    if ((view.skills[course.skill] ?? 0) <= weakest) add("combatSkills", course.expPerSec);
  }
  return {
    action: {
      type: course.costPerSec > 0 ? "class" : "gym",
      subject: course.name,
      focus: true,
      why: `${course.expPerSec.toFixed(1)} ${course.skill} exp/sec at $${Math.round(course.costPerSec)}/sec`,
    },
    // Courses COST money, so a course competes with the income it forgoes.
    score,
    moneyPerSec: -course.costPerSec,
    contributions,
  };
}

export function stepCareer(view: CareerView, board: NeedBoard): CareerDecision {
  const values = needValues(board);
  const ranked: ScoredAction[] = [];

  for (const crime of view.crimes) ranked.push(scoreCrime(crime, view, values));
  for (const course of view.courses) {
    // Never start a course we cannot pay for.
    if (course.costPerSec > 0 && view.moneyGranted <= 0) continue;
    ranked.push(scoreCourse(course, view, values));
  }

  const serving = [...values.values()].map((value) => ({
    kind: value.kind,
    ...(value.subject !== undefined ? { subject: value.subject } : {}),
    weight: value.weight,
    progress: 0,
  }));

  if (ranked.length === 0) {
    return {
      action: { type: "idle", why: "no actions available (needs BN4 or SF4 for crime stats)" },
      ranked,
      serving,
      incomeFallback: false,
      why: "nothing to rank",
    };
  }

  // No outstanding need career can serve: fall back to INCOME. This is the
  // early-game income floor the feature is also responsible for, and it is a
  // genuine objective rather than a filler — crime is how a fresh run pays for
  // its first port opener.
  const anyNeed = ranked.some((entry) => entry.score > 0);
  const key = anyNeed ? (entry: ScoredAction) => entry.score : (entry: ScoredAction) => entry.moneyPerSec;
  ranked.sort((a, b) => {
    const diff = key(b) - key(a);
    if (diff !== 0) return diff;
    // Deterministic: never depend on the order the crime table arrived in.
    return a.action.subject! < b.action.subject! ? -1 : 1;
  });

  const best = ranked[0]!;
  if (!view.holdsWorkSlot) {
    return {
      action: { type: "idle", why: "another feature holds Player.currentWork" },
      ranked,
      serving,
      incomeFallback: !anyNeed,
      why: "no work slot this tick",
    };
  }

  // Continuation guard, same reasoning as factions: committing a crime
  // CANCELS whatever is running, so re-issuing the same crime every tick would
  // restart it forever and never bank a single completion.
  if (view.currentWork?.kind === "crime" && view.currentWork.subject === best.action.subject) {
    return {
      action: { type: "idle", why: `already committing ${best.action.subject}` },
      ranked,
      serving,
      incomeFallback: !anyNeed,
      why: "continuing",
    };
  }

  return {
    action: best.action,
    ranked,
    serving,
    incomeFallback: !anyNeed,
    why: anyNeed
      ? `best Σ needWeight·progress/sec (${best.score.toExponential(2)})`
      : `no posted need career can serve — maximising income at $${Math.round(best.moneyPerSec)}/sec`,
  };
}

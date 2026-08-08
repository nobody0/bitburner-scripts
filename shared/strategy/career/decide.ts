import type { Need, NeedBoard, NeedKind, NeedUrgency } from "../needs.ts";
import { needKey, needProgress, URGENCY_ORDER } from "../needs.ts";
import { careerWorkMode } from "./schedule.ts";
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
 * The action set is tiny, so every available option is ranked explicitly for
 * a fixed view. The score itself remains the policy: exhaustive enumeration
 * prevents search shortcuts from obscuring which option won. */

export type CareerActionType = "crime" | "class" | "gym" | "company" | "apply" | "promote" | "quit" | "travel" | "continue" | "idle";
export type CareerPriorityBand = NeedUrgency | "income";

export interface CareerAction {
  type: CareerActionType;
  /** Crime type, course name, gym stat, company name, city. */
  subject?: string;
  /** Job field for an application/promotion. */
  field?: string;
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
  contributions: { kind: NeedKind; subject?: string; perSec: number; weight: number; score: number }[];
  /** Queue band assigned from the highest-urgency request this option serves. */
  priority: CareerPriorityBand;
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
  jobs?: Record<string, string>;
  companies?: { name: string; rep: number; repPerSec?: number }[];
  /** Whether this feature holds Player.currentWork this tick. */
  holdsWorkSlot: boolean;
  currentWork?: { kind: string; subject?: string };
  /** True only on the engine tick reported by Task.nextCompletion. */
  allowProgressSwitch?: boolean;
  /** Money the arbiter granted, for paid courses. */
  moneyGranted: number;
}

export interface CareerDecision {
  action: CareerAction;
  /** Everything considered, best first. Rendered so a choice can be argued. */
  ranked: ScoredAction[];
  /** Needs this feature is currently serving. */
  serving: (Pick<Need, "by" | "kind" | "subject" | "target" | "have" | "weight" | "urgency" | "why"> & { progress: number })[];
  /** Arbiter band for the selected option. Numeric policy lives in arbiter.ts. */
  workPriority: CareerPriorityBand;
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
interface NeedValue {
  kind: NeedKind;
  subject?: string;
  weight: number;
  remaining: number;
  urgency: NeedUrgency;
}

export function needValues(board: NeedBoard): Map<string, NeedValue> {
  const out = new Map<string, NeedValue>();
  for (const need of board.open) {
    if (!CAREER_KINDS.includes(need.kind)) continue;
    const key = needKey(need);
    const remaining = Math.abs(need.target - need.have);
    const existing = out.get(key);
    if (existing) {
      existing.weight += need.weight;
      existing.remaining = Math.min(existing.remaining, remaining);
      if (URGENCY_ORDER[need.urgency] > URGENCY_ORDER[existing.urgency]) existing.urgency = need.urgency;
      continue;
    }
    out.set(key, {
      kind: need.kind,
      ...(need.subject !== undefined ? { subject: need.subject } : {}),
      weight: need.weight,
      remaining: Math.max(1e-9, remaining),
      urgency: need.urgency,
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
    contributions.push({ kind, ...(subject !== undefined ? { subject } : {}), perSec, weight: value.weight, score: contribution });
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
    priority: priorityFor(contributions, values),
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
    const contribution = (perSec / value.remaining) * value.weight;
    score += contribution;
    contributions.push({ kind, ...(subject !== undefined ? { subject } : {}), perSec, weight: value.weight, score: contribution });
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
    priority: priorityFor(contributions, values),
  };
}

/** Company reputation is directly observable but its gain formula is not
 * available before Formulas.exe. An unmeasured company gets a deliberately
 * neutral exploration rate of one rep/sec; after one sample the measured rate
 * replaces it. This affects ordering only and is called out in the option's
 * explanation rather than presented as a measured prediction. */
function scoreCompany(
  company: NonNullable<CareerView["companies"]>[number],
  values: ReturnType<typeof needValues>,
): ScoredAction {
  const value = values.get(needKey({ kind: "companyRep", subject: company.name }));
  const rate = company.repPerSec !== undefined && company.repPerSec > 0 ? company.repPerSec : 1;
  const score = value ? (rate / value.remaining) * value.weight : 0;
  const contributions: ScoredAction["contributions"] = value
    ? [{ kind: "companyRep", subject: company.name, perSec: rate, weight: value.weight, score }]
    : [];
  return {
    action: {
      type: "company",
      subject: company.name,
      focus: true,
      why: company.repPerSec !== undefined
        ? `${company.repPerSec.toFixed(2)} measured company rep/sec`
        : "company reputation requested; measuring its rate",
    },
    score,
    moneyPerSec: 0,
    contributions,
    priority: priorityFor(contributions, values),
  };
}

function scoreInstant(
  action: CareerAction,
  value: NeedValue,
): ScoredAction {
  // Instant calls land within one 200 ms controller/engine cycle. Expressing
  // that as five completed gaps/sec makes an immediately-cleared blocker rank
  // ahead of a slow grind without inventing an in-game production rate.
  const perSec = 5 * value.remaining;
  const score = (perSec / value.remaining) * value.weight;
  const contributions: ScoredAction["contributions"] = [{
    kind: value.kind,
    ...(value.subject !== undefined ? { subject: value.subject } : {}),
    perSec,
    weight: value.weight,
    score,
  }];
  return { action, score, moneyPerSec: 0, contributions, priority: value.urgency };
}

function priorityFor(
  contributions: ScoredAction["contributions"],
  values: ReturnType<typeof needValues>,
): CareerPriorityBand {
  let best: NeedUrgency | undefined;
  for (const contribution of contributions) {
    const urgency = values.get(needKey(contribution))?.urgency;
    if (urgency && (best === undefined || URGENCY_ORDER[urgency] > URGENCY_ORDER[best])) best = urgency;
  }
  return best ?? "income";
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

  const jobs = view.jobs ?? {};
  for (const company of view.companies ?? []) {
    if (Object.hasOwn(jobs, company.name)) ranked.push(scoreCompany(company, values));
  }
  for (const value of values.values()) {
    if (value.kind === "employment" && value.subject && !Object.hasOwn(jobs, value.subject)) {
      ranked.push(scoreInstant({ type: "apply", subject: value.subject, why: `apply for the best eligible job at ${value.subject}` }, value));
    } else if (value.kind === "quitCompany" && value.subject && Object.hasOwn(jobs, value.subject)) {
      ranked.push(scoreInstant({ type: "quit", subject: value.subject, why: `leave ${value.subject} to clear the request` }, value));
    } else if (value.kind === "city" && value.subject && view.city !== value.subject) {
      ranked.push(scoreInstant({ type: "travel", subject: value.subject, why: `travel to requested city ${value.subject}` }, value));
    } else if (value.kind === "jobTitle" && value.subject) {
      const company = [...(view.companies ?? [])]
        .filter((entry) => Object.hasOwn(jobs, entry.name))
        .sort((a, b) => b.rep - a.rep || (a.name < b.name ? -1 : 1))[0];
      if (company) {
        const field = jobFieldForTitle(value.subject);
        ranked.push(scoreInstant({
          type: "promote",
          subject: company.name,
          field,
          why: `seek ${value.subject} through the ${field} track at highest-reputation employer ${company.name}`,
        }, value));
      }
    }
  }

  const serving = board.open.filter((need) => CAREER_KINDS.includes(need.kind)).map((need) => ({
    by: need.by,
    kind: need.kind,
    ...(need.subject !== undefined ? { subject: need.subject } : {}),
    target: need.target,
    have: need.have,
    weight: need.weight,
    urgency: need.urgency,
    why: need.why,
    progress: needProgress(need),
  }));

  if (ranked.length === 0) {
    return {
      action: { type: "idle", why: "no actions available (needs BN4 or SF4 for crime stats)" },
      ranked,
      serving,
      workPriority: "income",
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
      workPriority: best.priority,
      incomeFallback: !anyNeed,
      why: "no work slot this tick",
    };
  }

  // A repeatable task has already restarted itself at the completion boundary.
  // If it remains the best option, only re-arm the nextCompletion promise;
  // reissuing commitCrime here could throw away the first new 200 ms cycle.
  if (sameWork(view.currentWork, best.action) && view.allowProgressSwitch) {
    return {
      action: { type: "continue", subject: best.action.subject, why: `keep ${best.action.subject} and watch its next completion` },
      ranked,
      serving,
      workPriority: best.priority,
      incomeFallback: !anyNeed,
      why: "same option remains best at the completion boundary",
    };
  }
  // Reissuing the same work cancels and restarts it. At an ordinary review,
  // continuation is always the correct no-op; at an exact completion boundary
  // allowProgressSwitch deliberately bypasses this guard.
  if (sameWork(view.currentWork, best.action) && !view.allowProgressSwitch) {
    return {
      action: { type: "idle", why: `already committing ${best.action.subject}` },
      ranked,
      serving,
      workPriority: best.priority,
      incomeFallback: !anyNeed,
      why: "continuing",
    };
  }

  // Progress work is a transaction: until the completion promise resolves,
  // changing it destroys the partial unit. The arbiter also protects the slot,
  // but this strategy-side guard is the final defence against any stale grant.
  if (careerWorkMode(view.currentWork?.kind) === "progress" && !view.allowProgressSwitch) {
    return {
      action: { type: "idle", why: `waiting for ${view.currentWork?.subject ?? view.currentWork?.kind ?? "progress work"} to complete` },
      ranked,
      serving,
      workPriority: best.priority,
      incomeFallback: !anyNeed,
      why: "progress is protected until Task.nextCompletion",
    };
  }

  return {
    action: best.action,
    ranked,
    serving,
    workPriority: best.priority,
    incomeFallback: !anyNeed,
    why: anyNeed
      ? `best Σ needWeight·progress/sec (${best.score.toExponential(2)})`
      : `no posted need career can serve — maximising income at $${Math.round(best.moneyPerSec)}/sec`,
  };
}

function jobFieldForTitle(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("technology") || lower.includes("software") || lower.includes("cto")) return "Software";
  if (lower.includes("financial") || lower.includes("business") || lower.includes("cfo")) return "Business";
  // CEO is reachable from the two executive tracks; software is preferred for
  // an automation player whose hacking skill is normally its strongest stat.
  return "Software";
}

function sameWork(current: CareerView["currentWork"], action: CareerAction): boolean {
  if (!current) return false;
  const kind = current.kind.toLowerCase();
  if (action.type === "crime") return kind === "crime" && current.subject === action.subject;
  if (action.type === "company") return kind === "company" && current.subject === action.subject;
  if (action.type === "class" || action.type === "gym") return kind === "class" && current.subject === action.subject;
  return false;
}

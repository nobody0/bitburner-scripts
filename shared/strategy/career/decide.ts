import { formatMoney, formatScientific } from "../../format.ts";
import {
  channelForNeed,
  channelWorth,
  compareSlotValues,
  deliveryFraction,
  raiseBest,
  scaleSlotValue,
  slotValue,
  type ChannelWorth,
  type RateChannel,
  type SlotValue,
} from "../income.ts";
import { DEFAULT_PLANNING_HORIZON_SEC } from "../progression/forecast.ts";
import type { MeasuredMarginal } from "../progression/marginal.ts";
import type { Need, NeedBoard, NeedKind, NeedUrgency } from "../needs.ts";
import { needKey, needProgress, URGENCY_ORDER } from "../needs.ts";
import { COMPANIES } from "../../features/companies.ts";
import { bestTitlePath, trackFieldFor, type CompanyPerson, type CompanyWorkContext } from "./company.ts";
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
 * The objective is `Σ_channel (our rate / the best rate) × what that channel is
 * worth`, in BN-seconds off the route — the same arithmetic the arbiter prices
 * career's claim on the work slot with (`../income.ts`). An option is worth
 * what it DELIVERS, measured against whoever else could deliver the same thing.
 *
 * It used to be `Σ needWeight_k · progress_k/sec`, and the difference is the
 * denominator. That form scored a rate against a need's remaining gap while
 * ignoring who else was closing it, so a crime paying $1.8e4/s against a $1e11
 * gate the farm was closing at $3.25e8/s scored as though it were the only
 * thing moving — and, because the band came from the need's urgency rather
 * than the size of the contribution, took the exclusive work slot for six
 * hours to deliver four ten-thousandths of the progress.
 *
 * A need nobody posted is worth nothing, so career does not grind karma nobody
 * wants; a channel nobody has priced yet leaves the option unpriced, and those
 * fall back to money, which is what matters before a route exists.
 *
 * The action set is tiny, so every available option is ranked explicitly for
 * a fixed view. The score itself remains the policy: exhaustive enumeration
 * prevents search shortcuts from obscuring which option won. */

export type CareerActionType = "crime" | "class" | "gym" | "company" | "program" | "apply" | "promote" | "quit" | "travel" | "continue" | "idle" | "stop";
export type CareerPriorityBand = NeedUrgency | "income";

export interface CareerAction {
  type: CareerActionType;
  /** Crime type, course name, gym stat, company name, city. */
  subject?: string;
  /** Job field for an application/promotion. */
  field?: string;
  /** Exact university/gym used for a class action. */
  location?: string;
  focus?: boolean;
  why: string;
}

/** One rate an option produces, in the board's own vocabulary. Kept alongside
 *  the priced channels because a consumer wants "companyRep at MegaCorp", not
 *  the flattened channel key. */
export interface ProducedRate {
  kind: NeedKind;
  subject?: string;
  perSec: number;
}

export interface ScoredAction {
  action: CareerAction;
  /** BN-seconds saved by giving this option the slot — `value.valueSec`. THE
   *  objective, and the same number the arbiter scores the claim with. */
  score: number;
  /** The full valuation, including the `unpriced` state that puts the option
   *  back on the bootstrap money rule. */
  value: SlotValue;
  /** Everything this option produces, by channel — what the claim announces. */
  produces: Record<RateChannel, number>;
  rates: ProducedRate[];
  /** Money per second, reported separately: it is the bootstrap objective
   *  before the route is priced, and always worth showing. */
  moneyPerSec: number;
  /** Per-outcome contributions, for the UI's "why this action" column. */
  contributions: { kind: NeedKind; subject?: string; perSec: number; worthSec: number; valueSec: number }[];
  /** Queue band assigned from the highest-urgency request this option serves.
   *  REPORTING ONLY: career's money claims still use it, but the work slot is
   *  allocated on `score`, never on the band. */
  priority: CareerPriorityBand;
  /** Best progress among the needs this option serves, as a tie-break. */
  progress: number;
  /** How much of this option's worth lands inside the planning horizon. 1 for
   *  continuous work, which produces for as long as it holds the slot; below 1
   *  for an option that must OCCUPY the slot before it delivers anything, and
   *  0 for one that would still be occupying it when the node is expected to
   *  end. `score` already has it applied — this is reported so the claim can
   *  carry the same discount into the arbiter's auction. */
  deliveryFraction: number;
}

export interface CareerView {
  time: number;
  person: CrimePerson;
  crimeContext: CrimeContext;
  /** Crime stats from ns.singularity.getCrimeStats — never hardcoded here.
   * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L1068-L1090 */
  crimes: CrimeStats[];
  /** Courses available, with their cost and stat. */
  courses: { name: string; skill: string; expPerSec: number; costPerSec: number; location: string }[];
  /** Creatable programs requested by another feature. */
  programs?: { name: string; timeMs: number; purchaseCost: number }[];
  karma: number;
  numPeopleKilled: number;
  skills: Record<string, number>;
  city: string;
  jobs?: Record<string, string>;
  companies?: {
    name: string;
    rep: number;
    favor?: number;
    repPerSec?: number;
    moneyPerSec?: number;
    /** Formula prior for an unmeasured company (see career/company.ts). */
    estimatedRepPerSec?: number;
  }[];
  /** Person + node context for the company work-line model. Enables
   * table-driven title paths; without it the title fallback uses held jobs. */
  companyWork?: { person: CompanyPerson; ctx: CompanyWorkContext };
  /** The alternatives table and what each channel is worth, so career ranks
   *  its own options with the SAME arithmetic the arbiter prices its claim
   *  with. Absent leaves every option unpriced, which ranks by money — the
   *  deliberate bootstrap rule (see `../income.ts`). */
  rates?: {
    best: ReadonlyMap<RateChannel, MeasuredMarginal>;
    worth: ChannelWorth;
  };
  /** Seconds of run left to plan against, from the node forecast. Divides the
   *  occupancy of any option that blocks the slot before it delivers. Absent
   *  falls back to `DEFAULT_PLANNING_HORIZON_SEC`, the same conservative window
   *  the investment gate uses when no forecast is usable. */
  planningHorizonSec?: number;
  /** Whether this feature holds Player.currentWork this tick. */
  holdsWorkSlot: boolean;
  /** False while an input the menu depends on has not arrived yet.
   *
   * The crime table comes from a dodged probe on a five-minute cadence, and the
   * runner admits ONE dodged probe per pass, so at a cold start every crime is
   * missing for the first passes — which is exactly when career makes its first
   * commitment. An option that must OCCUPY the slot cannot be judged against a
   * menu that is still filling: "nothing else is worth anything" and "nothing
   * else has been measured yet" are not the same statement. */
  menuComplete?: boolean;
  /** `elapsedSec` is how long the current work has already run. A part-finished
   *  write is charged only the time it has LEFT: the elapsed part is sunk, and
   *  charging it again would mean a write that cannot start can never accumulate
   *  the progress that would let it start. */
  currentWork?: { kind: string; subject?: string; elapsedSec?: number };
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
  /** Band for career's MONEY and dodge-RAM claims — the urgency of the request
   *  the selected option serves. The work slot itself is priced, not banded. */
  workPriority: CareerPriorityBand;
  /** True when the CHOSEN option serves no posted need. Reported, not acted
   *  on: the option won on the rates it produces either way. */
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
  "file",
];

/** The outstanding needs career can serve, merged per outcome.
 *
 * Only UNSATISFIED needs are here — that is what stops career grinding karma it
 * has already delivered. What each outcome is WORTH is not: that comes from
 * `channelWorth`, which prices the same board once for career and for the
 * arbiter. This carries only what career needs on top of the price — the
 * distance left (an instant action clears it whatever the rate), the urgency it
 * reports, and how close it already is, as a tie-break. */
interface NeedValue {
  kind: NeedKind;
  subject?: string;
  /** Distance to the NEAREST posted threshold: clearing that one unblocks a
   *  feature, and a further threshold behind it does not change the action. */
  remaining: number;
  urgency: NeedUrgency;
  /** How close the need already is, in [0, 1]. A tie-break only. */
  progress: number;
}

export function needValues(board: NeedBoard): Map<string, NeedValue> {
  const out = new Map<string, NeedValue>();
  for (const need of board.open) {
    if (!CAREER_KINDS.includes(need.kind)) continue;
    const key = needKey(need);
    const remaining = Math.abs(need.target - need.have);
    const existing = out.get(key);
    if (existing) {
      existing.remaining = Math.min(existing.remaining, remaining);
      existing.progress = Math.max(existing.progress, needProgress(need));
      if (URGENCY_ORDER[need.urgency] > URGENCY_ORDER[existing.urgency]) existing.urgency = need.urgency;
      continue;
    }
    out.set(key, {
      kind: need.kind,
      ...(need.subject !== undefined ? { subject: need.subject } : {}),
      remaining: Math.max(1e-9, remaining),
      urgency: need.urgency,
      progress: needProgress(need),
    });
  }
  return out;
}

/** Collect the raw rates an option produces, keyed by the channel each is
 * priced in. No board filtering and no normalisation: an option produces what
 * it produces, and what that is WORTH is decided once, by `slotValue`, against
 * the same table the arbiter uses.
 *
 * The predecessor folded the board in here, as `(perSec / remaining) * weight`.
 * Two things were wrong with it and both bit. It scored a rate against a need's
 * remaining gap while ignoring who else was closing that gap — so career scored
 * its $1.8e4/s crime against a $1e11 target the farm was closing at $3.25e8/s,
 * and took the work slot for four ten-thousandths of the progress. And the
 * skill variant divided by remaining EXPERIENCE, clamped at 1e-9, so one
 * mis-derived multiplier turned a routine strength need into a score of 6.3e8
 * and silently decided every career ranking in the run. */
function collectRates(entries: readonly ProducedRate[]): {
  rates: ProducedRate[];
  produces: Record<RateChannel, number>;
} {
  const rates: ProducedRate[] = [];
  const produces: Record<RateChannel, number> = {};
  for (const entry of entries) {
    if (!(entry.perSec > 0)) continue;
    rates.push(entry);
    const channel = channelForNeed(entry);
    produces[channel] = (produces[channel] ?? 0) + entry.perSec;
  }
  return { rates, produces };
}

/** An option before it is priced: what it is, and what it would produce. */
interface PendingAction {
  action: CareerAction;
  rates: readonly ProducedRate[];
  moneyPerSec: number;
  /** Seconds of exclusive slot time this option must burn BEFORE it delivers
   *  anything. Absent means continuous production — it delivers for as long as
   *  it holds the slot, which is every option but a program write.
   *
   *  A planner states the duration and nothing else; `priceAction` owns the
   *  arithmetic that turns it into a discount, so no planner can invent its own. */
  occupiesSec?: number;
}

/** Price one option: what it produces, against the field, in BN-seconds. */
function priceAction(
  entry: { option: PendingAction; rates: ProducedRate[]; produces: Record<RateChannel, number> },
  best: ReadonlyMap<RateChannel, MeasuredMarginal>,
  worth: ChannelWorth,
  values: ReturnType<typeof needValues>,
  horizonSec: number,
): ScoredAction {
  const { rates, produces } = entry;
  // Rate share first, occupancy second. They are different questions — "how much
  // of this channel's output is ours" and "how much of the run is left once we
  // have paid for it" — and the second CANNOT be folded into the rates: the field
  // is raised to our own announced rate, so a multiplier there divides back out.
  // See `deliveryFraction` in `../income.ts`.
  const fraction = entry.option.occupiesSec === undefined
    ? 1
    : deliveryFraction(entry.option.occupiesSec, horizonSec);
  const value = scaleSlotValue(slotValue({ produces, best, worth }), fraction);
  // Built from the SCALED channels so the reported contributions add up to the
  // reported score.
  const byChannel = new Map(value.channels.map((channel) => [channel.channel, channel]));
  const contributions: ScoredAction["contributions"] = [];
  let progress = 0;
  for (const rate of rates) {
    const need = values.get(needKey({ kind: rate.kind, subject: rate.subject }));
    if (need) progress = Math.max(progress, need.progress);
    const channel = byChannel.get(channelForNeed(rate));
    if (!channel) continue;
    contributions.push({
      kind: rate.kind,
      ...(rate.subject !== undefined ? { subject: rate.subject } : {}),
      perSec: rate.perSec,
      worthSec: channel.worthSec,
      valueSec: channel.valueSec,
    });
  }
  return {
    action: entry.option.action,
    score: value.valueSec,
    value,
    produces,
    rates,
    moneyPerSec: entry.option.moneyPerSec,
    contributions,
    priority: priorityFor(rates, values),
    progress,
    deliveryFraction: fraction,
  };
}

function planCrime(crime: CrimeStats, view: CareerView): PendingAction {
  const money = moneyPerSec(crime, view.person, view.crimeContext);
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
  return {
    action: {
      type: "crime",
      subject: crime.type,
      focus: true,
      why: `${(successChance(crime, view.person, view.crimeContext) * 100).toFixed(0)}% success, ${formatMoney(money)}/sec`,
    },
    rates: [
      { kind: "karma", perSec: karmaPerSec(crime, view.person, view.crimeContext) },
      { kind: "kills", perSec: killsPerSec(crime, view.person, view.crimeContext) },
      { kind: "money", perSec: money },
      { kind: "combatSkills", perSec: combat },
      { kind: "charisma", perSec: exp["charisma"] ?? 0 },
      ...Object.entries(exp).map(([skill, rate]): ProducedRate => ({ kind: "skill", subject: skill, perSec: rate })),
    ],
    moneyPerSec: money,
  };
}

function planCourse(course: CareerView["courses"][number], view: CareerView): PendingAction {
  const rates: ProducedRate[] = [{ kind: "skill", subject: course.skill, perSec: course.expPerSec }];
  if (course.skill === "charisma") rates.push({ kind: "charisma", perSec: course.expPerSec });
  if (["strength", "defense", "dexterity", "agility"].includes(course.skill)) {
    // A gym trains ONE stat, and a combat need is gated by the weakest — so
    // training the strongest stat contributes nothing to it.
    const weakest = Math.min(
      view.skills["strength"] ?? 0,
      view.skills["defense"] ?? 0,
      view.skills["dexterity"] ?? 0,
      view.skills["agility"] ?? 0,
    );
    if ((view.skills[course.skill] ?? 0) <= weakest) rates.push({ kind: "combatSkills", perSec: course.expPerSec });
  }
  return {
    action: {
      type: course.location.includes("Gym") ? "gym" : "class",
      subject: course.name,
      location: course.location,
      focus: true,
      why: `${course.expPerSec.toFixed(1)} ${course.skill} exp/sec at ${formatMoney(course.costPerSec)}/sec`,
    },
    rates: rates,
    moneyPerSec: // Courses COST money, so a course competes with the income it forgoes.
    -course.costPerSec,
  };
}

/** Company reputation is directly observable but its gain formula is not
 * available before Formulas.exe. An unmeasured company gets a deliberately
 * neutral exploration rate of one rep/sec; after one sample the measured rate
 * replaces it. This affects ordering only and is called out in the option's
 * explanation rather than presented as a measured prediction.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Formulas.ts#L449-L461 */
function planCompany(company: NonNullable<CareerView["companies"]>[number]): PendingAction {
  const rate = company.repPerSec !== undefined && company.repPerSec > 0
    ? company.repPerSec
    : company.estimatedRepPerSec !== undefined && company.estimatedRepPerSec > 0
      ? company.estimatedRepPerSec
      : 1;
  return {
    action: {
      type: "company",
      subject: company.name,
      focus: true,
      why: company.repPerSec !== undefined
        ? `${company.repPerSec.toFixed(2)} measured company rep/sec`
        : company.estimatedRepPerSec !== undefined
          ? `${company.estimatedRepPerSec.toFixed(2)} estimated company rep/sec from the position formula`
          : "company reputation requested; measuring its rate",
    },
    rates: [
      { kind: "companyRep", subject: company.name, perSec: rate },
      { kind: "money", perSec: company.moneyPerSec ?? 0 },
    ],
    moneyPerSec: company.moneyPerSec ?? 0,
  };
}

function planProgram(
  program: NonNullable<CareerView["programs"]>[number],
  values: ReturnType<typeof needValues>,
  view: CareerView,
): PendingAction {
  const value = values.get(needKey({ kind: "file", subject: program.name }));
  const seconds = Math.max(0.001, program.timeMs / 1_000);
  // "One file per however long it takes" — the honest production rate, and what
  // the arbiter's alternatives table consumes. It is NOT where duration is
  // priced: a program is the only producer of its own `file:` channel, so this
  // rate is also the best rate and the fraction is always 1. The duration is
  // charged as `occupiesSec` below, outside the rate, for exactly that reason.
  const perSec = value ? value.remaining / seconds : 0;
  // The elapsed part of a write in progress is SUNK. Charging the full write
  // every pass is not merely pessimistic, it is self-fulfilling: a program whose
  // best alternative ever beats its discounted value would never start, and
  // because it never starts it never accumulates the progress that would let it.
  // Bitburner banks partial progress across a stop, so the marginal cost of
  // continuing really is only the time left.
  const elapsedSec = view.currentWork?.kind === "create_program" && view.currentWork.subject === program.name
    ? Math.max(0, view.currentWork.elapsedSec ?? 0)
    : 0;
  return {
    action: {
      type: "program",
      subject: program.name,
      focus: true,
      why: `write in ${Math.ceil(seconds)}s instead of spending ${formatMoney(program.purchaseCost)}`,
    },
    rates: [{ kind: "file", subject: program.name, perSec }],
    moneyPerSec: -program.purchaseCost / seconds,
    occupiesSec: Math.max(0, seconds - elapsedSec),
  };
}

function planInstant(action: CareerAction, value: NeedValue): PendingAction {
  // Instant calls land within one 200 ms controller/engine cycle. Expressing
  // that as five completed gaps/sec makes an immediately-cleared blocker rank
  // ahead of a slow grind without inventing an in-game production rate.
  return {
    action,
    rates: [{ kind: value.kind, ...(value.subject !== undefined ? { subject: value.subject } : {}), perSec: 5 * value.remaining }],
    moneyPerSec: 0,
  };
}

/** The highest urgency among the needs an option touches.
 *
 * REPORTING, and career's own MONEY claims. It is deliberately no longer the
 * work-slot priority: urgency says how badly somebody wants an outcome, not how
 * much of it this option delivers, and treating the two as the same thing is
 * what let a crime contributing 1e-6 of a money need outrank the only source of
 * reputation in the run. */
function priorityFor(
  rates: readonly ProducedRate[],
  values: ReturnType<typeof needValues>,
): CareerPriorityBand {
  let best: NeedUrgency | undefined;
  for (const rate of rates) {
    const urgency = values.get(needKey({ kind: rate.kind, subject: rate.subject }))?.urgency;
    if (urgency && (best === undefined || URGENCY_ORDER[urgency] > URGENCY_ORDER[best])) best = urgency;
  }
  return best ?? "income";
}

/** Seconds of a course's continuous drain one training-fund reserve covers —
 * both the claim size (game driver) and the admission bar here, so the two
 * cannot drift. */
export const TRAINING_FUND_WINDOW_SEC = 30;

export function stepCareer(view: CareerView, board: NeedBoard): CareerDecision {
  const values = needValues(board);
  const options: PendingAction[] = [];

  for (const crime of view.crimes) options.push(planCrime(crime, view));
  for (const course of view.courses) {
    // Never start a course we cannot pay for — a full funding window, not
    // merely "any positive grant": the course drains continuously, and a $1
    // grant used to admit a $2,400/s class.
    if (course.costPerSec > 0 && view.moneyGranted < course.costPerSec * TRAINING_FUND_WINDOW_SEC) continue;
    options.push(planCourse(course, view));
  }
  for (const program of view.programs ?? []) {
    // Only what was ASKED for. `CareerView.programs` is documented as
    // "requested by another feature", but the driver offered every creatable
    // opener, and an unrequested one produces nothing the board prices: its
    // `file:` rate is zero, `collectRates` drops it, and it arrives at the
    // ranking as `unpriced/0`. Two such options then decided the slot on the
    // money tie-break — where a program's `moneyPerSec` is
    // `-purchaseCost / seconds`, so the LONGEST, most expensive write looks
    // cheapest. Measured: a save with hacking 78 and intelligence 355 (which
    // halves relaySMTP's level requirement to 72.5, making a 2h14m write
    // eligible) chose it over a 29-minute FTPCrack, re-affirmed it every five
    // seconds, and resumed it after every reload.
    if (!values.has(needKey({ kind: "file", subject: program.name }))) continue;
    options.push(planProgram(program, values, view));
  }

  const jobs = view.jobs ?? {};
  for (const company of view.companies ?? []) {
    if (Object.hasOwn(jobs, company.name)) options.push(planCompany(company));
  }
  for (const value of values.values()) {
    if (value.kind === "employment" && value.subject && !Object.hasOwn(jobs, value.subject)) {
      options.push(planInstant({ type: "apply", subject: value.subject, why: `apply for the best eligible job at ${value.subject}` }, value));
    } else if (
      value.kind === "companyRep" && value.subject && !Object.hasOwn(jobs, value.subject)
      // An `employment` request at the same company already produced the
      // identical apply action above; two copies would only crowd the ranked
      // list (and `careerAlternative` reads ranked[0]).
      && !values.has(needKey({ kind: "employment", subject: value.subject }))
    ) {
      // A reputation request at a company we do not work for is served by
      // hiring on first — the chain is self-sequencing even when both the
      // employment and rep blockers are on the board at once.
      options.push(planInstant({ type: "apply", subject: value.subject, why: `hire on at ${value.subject} to serve its reputation request` }, value));
    } else if (value.kind === "quitCompany" && value.subject && Object.hasOwn(jobs, value.subject)) {
      options.push(planInstant({ type: "quit", subject: value.subject, why: `leave ${value.subject} to clear the request` }, value));
    } else if (value.kind === "city" && value.subject && view.city !== value.subject) {
      options.push(planInstant({ type: "travel", subject: value.subject, why: `travel to requested city ${value.subject}` }, value));
    } else if (value.kind === "jobTitle" && value.subject) {
      const title = value.subject;
      // The title's track comes from the position table, never from string
      // matching — the old heuristic routed "Chief Executive Officer" onto
      // the Software track, which terminates at CTO and can never satisfy it.
      const field = trackFieldFor(title);
      if (field !== undefined) {
        const held = [...(view.companies ?? [])].filter((entry) => Object.hasOwn(jobs, entry.name));
        const path = view.companyWork
          ? bestTitlePath(
              [title],
              [
                ...held.map((entry) => ({
                  name: entry.name,
                  rep: entry.rep,
                  favor: entry.favor ?? 0,
                  ...(entry.repPerSec !== undefined ? { measuredRepPerSec: entry.repPerSec } : {}),
                })),
                ...Object.keys(COMPANIES)
                  .filter((name) => !Object.hasOwn(jobs, name))
                  .map((name) => ({ name, rep: 0, favor: 0 })),
              ],
              view.companyWork.person,
              view.companyWork.ctx,
            )
          : undefined;
        const company = path?.company
          ?? held
            .filter((entry) => titleOffered(entry.name, title))
            .sort((a, b) => b.rep - a.rep || (a.name < b.name ? -1 : 1))[0]?.name;
        if (company !== undefined) {
          options.push(planInstant(
            Object.hasOwn(jobs, company)
              ? { type: "promote", subject: company, field, why: `seek ${title} through the ${field} track at ${company}` }
              : { type: "apply", subject: company, field, why: `${company} is the cheapest reachable path to ${title} (${field} track)` },
            value,
          ));
        }
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

  // PRICE THE WHOLE MENU AT ONCE. The alternatives table has to include career's
  // own options before any of them can be scored as a fraction of the best.
  const worth = view.rates?.worth ?? channelWorth(board);
  const menu = options.map((option) => ({ option, ...collectRates(option.rates) }));
  const field = raiseBest(view.rates?.best ?? new Map(), menu.map((entry) => entry.produces));
  // The fallback lives here rather than at the game boundary so a pure test with
  // no forecast still gets the documented conservative window.
  const horizonSec = view.planningHorizonSec ?? DEFAULT_PLANNING_HORIZON_SEC;
  const ranked: ScoredAction[] = menu.map((entry) => priceAction(entry, field, worth, values, horizonSec));

  // WHAT WINS THE SLOT is `slotValue`: BN-seconds saved, summed over everything
  // the option produces, each channel scored as our rate over the best rate
  // anyone can manage. Urgency bands no longer sort this list — an option that
  // touches a blocking need but delivers a ten-thousandth of its closure rate
  // is worth a ten-thousandth, and says so.
  const servesNeed = (entry: ScoredAction): boolean =>
    entry.rates.some((rate) => values.has(needKey({ kind: rate.kind, subject: rate.subject })));
  // NO PHASE RULE. There used to be one here: "if nothing is posted and the
  // background out-earns crime, study the route's skill instead" — a hand-made
  // approximation of a comparison the valuation now makes properly, since a
  // course's experience is priced against the fleet's on the same channel. Its
  // one remaining job was covering the window where nothing had a price at all,
  // and that window closed when the board became a source of channel worth: a
  // posted skill gate prices the course whether or not a forecast exists yet.
  ranked.sort((a, b) => {
    const value = compareSlotValues(a.value, b.value);
    if (value !== 0) return value;
    // Equal worth: finish what is nearly finished. Proximity is a tie-break
    // rather than a term in the score, because how much a need is worth is the
    // POSTER's statement (`Need.valueSec`), not something to re-derive here.
    if (a.progress !== b.progress) return b.progress - a.progress;
    // ...then prefer the option that ties the slot up for less of the run.
    // `deliveryFraction` is 1 for anything continuous and below 1 exactly in
    // proportion to the occupancy an option demands, so this is the same
    // statement the value already makes — it just has to be made again where
    // the values are equal. Without it the money tie-break below ranks two
    // unpriced programs by amortised purchase cost, which REWARDS the longest
    // write, and a 2h14m commitment beats a 29-minute one on the strength of
    // being more expensive.
    if (a.deliveryFraction !== b.deliveryFraction) return b.deliveryFraction - a.deliveryFraction;
    // ...then earn. A priced-at-ZERO money channel is a real answer — mid-run
    // the farm clears every money gate, so no crime saves the route a second —
    // and it makes every crime tie. Without this the list fell through to the
    // alphabetical guard and picked Assassination over an earner ten times
    // better, which is the exact failure the packed-score comparator was
    // rewritten to stop. Dollars only ever break a tie between equal seconds,
    // so they never outrank the objective.
    if (a.moneyPerSec !== b.moneyPerSec) return b.moneyPerSec - a.moneyPerSec;
    // Deterministic: never depend on the order the crime table arrived in.
    return a.action.subject! < b.action.subject! ? -1 : 1;
  });

  // ABANDONED WORK. Everything below assumes the slot's occupant is one of the
  // options being ranked; when it is not, no branch below ever touches it, and
  // career has no other stop path — so the game keeps running it forever. That
  // is how a program the planner would no longer choose survived both the
  // decision that dropped it and every subsequent restart: the game persists
  // `Player.currentWork` across a script reload, and "not choosing it again" is
  // not the same as stopping it.
  //
  // Only ever fired while career holds the slot, so another feature's work is
  // never cancelled from here — and only when nothing is about to replace it:
  // issuing any slot-using action already cancels and replaces the current
  // work, so stopping first would spend a whole pass doing nothing.
  const current = view.currentWork;
  if (
    current
    && view.holdsWorkSlot
    && careerWorkMode(current.kind) !== "progress"
    && !ranked.some((entry) => sameWork(current, entry.action))
    && !(ranked[0] && actionUsesWorkSlot(ranked[0].action))
  ) {
    return {
      action: {
        type: "stop",
        ...(current.subject !== undefined ? { subject: current.subject } : {}),
        why: `${current.subject ?? current.kind} is no longer worth the slot`,
      },
      ranked,
      serving,
      workPriority: ranked[0]?.priority ?? "income",
      incomeFallback: false,
      why: "the slot's occupant is not on the menu",
    };
  }

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

  const best = ranked[0]!;
  const needsSlot = actionUsesWorkSlot(best.action);
  if (needsSlot && !view.holdsWorkSlot) {
    return {
      action: { type: "idle", why: "another feature holds Player.currentWork" },
      ranked,
      serving,
      workPriority: best.priority,
      incomeFallback: !servesNeed(best),
      why: "no work slot this tick",
    };
  }
  // Do not START a commitment against a menu that is still filling. Only
  // options that OCCUPY the slot before delivering anything are held back —
  // `deliveryFraction < 1` is exactly that set — and only when they are not
  // already running, so a write in progress is never interrupted by a late
  // probe. Continuous work is unaffected: it can be swapped the moment
  // something better arrives, so starting it costs nothing to be wrong about.
  if (
    needsSlot
    && view.menuComplete === false
    && best.deliveryFraction < 1
    && !sameWork(view.currentWork, best.action)
  ) {
    return {
      action: { type: "idle", why: `waiting for the rest of the menu before committing ${Math.round((1 - best.deliveryFraction) * 100)}% of the run` },
      ranked,
      serving,
      workPriority: best.priority,
      incomeFallback: !servesNeed(best),
      why: "menu incomplete",
    };
  }

  // A repeatable task has already restarted itself at the completion boundary.
  // If it remains the best option, only re-arm the nextCompletion promise;
  // reissuing commitCrime here could throw away the first new 200 ms cycle.
  if (needsSlot && sameWork(view.currentWork, best.action) && view.allowProgressSwitch) {
    return {
      action: { type: "continue", subject: best.action.subject, why: `keep ${best.action.subject} and watch its next completion` },
      ranked,
      serving,
      workPriority: best.priority,
      incomeFallback: !servesNeed(best),
      why: "same option remains best at the completion boundary",
    };
  }
  // Reissuing the same work cancels and restarts it. At an ordinary review,
  // continuation is always the correct no-op; at an exact completion boundary
  // allowProgressSwitch deliberately bypasses this guard.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObjectWorkMethods.ts#L5-L22
  if (needsSlot && sameWork(view.currentWork, best.action) && !view.allowProgressSwitch) {
    return {
      action: { type: "idle", why: `already committing ${best.action.subject}` },
      ranked,
      serving,
      workPriority: best.priority,
      incomeFallback: !servesNeed(best),
      why: "continuing",
    };
  }

  // Progress work is a transaction: until the completion promise resolves,
  // changing it destroys the partial unit. The arbiter also protects the slot,
  // but this strategy-side guard is the final defence against any stale grant.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Work.ts#L7-L22
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObjectWorkMethods.ts#L5-L22
  if (needsSlot && careerWorkMode(view.currentWork?.kind) === "progress" && !view.allowProgressSwitch) {
    return {
      action: { type: "idle", why: `waiting for ${view.currentWork?.subject ?? view.currentWork?.kind ?? "progress work"} to complete` },
      ranked,
      serving,
      workPriority: best.priority,
      incomeFallback: !servesNeed(best),
      why: "progress is protected until Task.nextCompletion",
    };
  }

  return {
    action: best.action,
    ranked,
    serving,
    workPriority: best.priority,
    incomeFallback: !servesNeed(best),
    why: best.value.state === "priced"
      ? `best Σ (rate/best) × BN-seconds saved (${formatScientific(best.score)}s)`
      : `no channel career produces is priced yet — maximising income at ${formatMoney(best.moneyPerSec)}/sec`,
  };
}

/** Calls that start player work consume the singleton slot. Administrative
 * actions and player travel do not replace current work in v3.0.1.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L226-L405
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L668-L746 */
export function actionUsesWorkSlot(action: Pick<CareerAction, "type">): boolean {
  return action.type === "crime" || action.type === "class" || action.type === "gym" || action.type === "company" || action.type === "program";
}


/** Whether a company's ladder contains the title at all (offering the rung is
 * necessary, not sufficient — requirements are the walker's job). */
function titleOffered(company: string, title: string): boolean {
  return COMPANIES[company]?.positions.includes(title) ?? false;
}

function sameWork(current: CareerView["currentWork"], action: CareerAction): boolean {
  if (!current) return false;
  const kind = current.kind.toLowerCase();
  if (action.type === "crime") return kind === "crime" && current.subject === action.subject;
  if (action.type === "company") return kind === "company" && current.subject === action.subject;
  if (action.type === "program") return kind === "create_program" && current.subject === action.subject;
  if (action.type === "class" || action.type === "gym") return kind === "class" && current.subject === action.subject;
  return false;
}

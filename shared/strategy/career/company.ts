import { COMPANIES, COMPANY_POSITIONS, JOB_TRACKS, type CompanyInfo, type CompanyPositionInfo } from "../../features/companies.ts";
import { MAX_SKILL_LEVEL } from "./crimes.ts";

/** Company work-line model.
 *
 * Prices company work from per-position reputation and salary rates in the
 * pinned v3.0.1 formula and walks actual promotion ladders, so company work can
 * be compared with every other use of the work slot on equal terms.
 *
 * Formula source: `bitburner-src v3.0.1 src/Work/CompanyWork.ts` /
 * `src/Company/CompanyPosition.ts` (mirrored by `sim/features/companies.ts`,
 * which is parity-tested against upstream). Skills are treated as static
 * within a walk: promotion ETAs are coarse-but-honest lower-frequency
 * estimates, and measured rates override them wherever a rate has actually
 * been observed. */

/** CONSTANTS.CompanyRequiredReputationMultiplier @ v3.0.1 — backdoored
 * company servers discount every position's reputation requirement. */
export const BACKDOOR_REQUIRED_REP_MULT = 0.75;

/** Game cycles per second (200 ms cycle). */
const CYCLES_PER_SEC = 5;

export interface CompanyPerson {
  /** Effective skill levels, including intelligence. */
  skills: Record<string, number>;
  mults: {
    company_rep?: number;
    work_money?: number;
  };
}

export interface CompanyWorkContext {
  /** currentNodeMults.CompanyWorkRepGain. */
  companyWorkRepGain: number;
  /** currentNodeMults.CompanyWorkMoney. */
  companyWorkMoney: number;
  /** 1 focused / part-time / Neuroreceptor Management Implant, else 0.8. */
  focusMult?: number;
  /** SF11 grants the favor multiplier on salary as well. */
  sf11SalaryFavor?: boolean;
  /** SF15.2 charisma salary multiplier, precomputed by the caller. */
  sf15SalaryMult?: number;
  /** Company server backdoored: reputation requirements are discounted. */
  backdoored?: boolean;
}

export function companyInfo(name: string): CompanyInfo | undefined {
  return COMPANIES[name];
}

export function positionInfo(name: string): CompanyPositionInfo | undefined {
  return COMPANY_POSITIONS[name];
}

/** Base requirement + the company's per-stat offset (zero stays zero). */
export function requiredSkillsAt(company: CompanyInfo, position: CompanyPositionInfo): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [skill, base] of Object.entries(position.reqSkills ?? {})) {
    out[skill] = base > 0 ? base + company.statReqOffset : 0;
  }
  return out;
}

export function requiredReputationAt(position: CompanyPositionInfo, ctx: Pick<CompanyWorkContext, "backdoored">): number {
  return position.reqRep * (ctx.backdoored ? BACKDOOR_REQUIRED_REP_MULT : 1);
}

export function qualifiedFor(
  company: CompanyInfo,
  position: CompanyPositionInfo,
  person: CompanyPerson,
  companyRep: number,
  ctx: Pick<CompanyWorkContext, "backdoored">,
): boolean {
  for (const [skill, needed] of Object.entries(requiredSkillsAt(company, position))) {
    if ((person.skills[skill] ?? 0) < needed) return false;
  }
  return companyRep >= requiredReputationAt(position, ctx);
}

/** Reputation per second at a position — exact v3.0.1 rate. */
export function companyRepPerSec(
  person: CompanyPerson,
  position: CompanyPositionInfo,
  favor: number,
  ctx: CompanyWorkContext,
): number {
  let weightedSkill = 0;
  for (const [skill, effectiveness] of Object.entries(position.effectiveness)) {
    weightedSkill += effectiveness * (person.skills[skill] ?? 0) / 100;
  }
  const performance = position.repMult * weightedSkill / MAX_SKILL_LEVEL
    + (person.skills["intelligence"] ?? 0) / MAX_SKILL_LEVEL;
  return performance * (person.mults.company_rep ?? 1) * (1 + favor / 100)
    * ctx.companyWorkRepGain * (ctx.focusMult ?? 1) * CYCLES_PER_SEC;
}

/** Salary per second at a position — exact v3.0.1 rate. */
export function companySalaryPerSec(
  person: CompanyPerson,
  company: CompanyInfo,
  position: CompanyPositionInfo,
  favor: number,
  ctx: CompanyWorkContext,
): number {
  const sf11Mult = ctx.sf11SalaryFavor ? 1 + favor / 100 : 1;
  return position.salary * company.salaryMult * sf11Mult * ctx.companyWorkMoney
    * (person.mults.work_money ?? 1) * (ctx.sf15SalaryMult ?? 1) * (ctx.focusMult ?? 1) * CYCLES_PER_SEC;
}

export interface PositionChoice {
  position: string;
  field: string;
  repPerSec: number;
  salaryPerSec: number;
}

/** The game's `applyToCompany` walks a track from its entry rung and hires at
 * the highest qualified rung. Enumerate that outcome for every track the
 * company actually offers, so the caller can pick a field by value instead of
 * by a fixed preference order (big physical stats really do make the Security
 * line beat Software where it is offered). */
export function applyOutcomes(
  companyName: string,
  person: CompanyPerson,
  companyRep: number,
  favor: number,
  ctx: CompanyWorkContext,
): PositionChoice[] {
  const company = COMPANIES[companyName];
  if (!company) return [];
  const outcomes: PositionChoice[] = [];
  for (const [field, track] of Object.entries(JOB_TRACKS)) {
    let best: { name: string; position: CompanyPositionInfo } | undefined;
    for (const name of track) {
      if (!company.positions.includes(name)) break;
      const position = COMPANY_POSITIONS[name];
      if (!position || !qualifiedFor(company, position, person, companyRep, ctx)) break;
      best = { name, position };
    }
    if (!best) continue;
    outcomes.push({
      position: best.name,
      field,
      repPerSec: companyRepPerSec(person, best.position, favor, ctx),
      salaryPerSec: companySalaryPerSec(person, company, best.position, favor, ctx),
    });
  }
  return outcomes;
}

/** Best position reachable right now, ranked by reputation rate (the scarce
 * resource company work is bought for), salary as the tie-break. */
export function bestPositionAt(
  companyName: string,
  person: CompanyPerson,
  companyRep: number,
  favor: number,
  ctx: CompanyWorkContext,
): PositionChoice | undefined {
  return applyOutcomes(companyName, person, companyRep, favor, ctx)
    .sort((a, b) => b.repPerSec - a.repPerSec || b.salaryPerSec - a.salaryPerSec)[0];
}

export interface LadderEta {
  seconds: number;
  /** The rung sequence walked, entry rung first. */
  path: string[];
  /** The rung held when the target is reached. */
  finalPosition: string;
}

/** Time to reach `repTarget` company reputation (or `titleTarget`, whichever
 * is given) working the best available line, promoting at each rep gate.
 *
 * Skills are static within the walk; a stat-gated rung stops promotion but
 * not rep accrual (we keep grinding the best held rung), so a rep target is
 * always reachable while a title behind a stat gate is not (Infinity). A
 * measured rate, when supplied, overrides the formula for the currently held
 * position only — later rungs have never been observed. */
export function promotionAwareEtaSec(
  companyName: string,
  person: CompanyPerson,
  startRep: number,
  favor: number,
  ctx: CompanyWorkContext,
  target: { repTarget?: number; titleTarget?: string },
  measuredRepPerSec?: number,
): LadderEta | undefined {
  const company = COMPANIES[companyName];
  if (!company) return undefined;
  const titleTarget = target.titleTarget;
  let track: readonly string[] | undefined;
  if (titleTarget !== undefined) {
    const wanted = COMPANY_POSITIONS[titleTarget];
    if (!wanted || !company.positions.includes(titleTarget)) return undefined;
    track = JOB_TRACKS[trackFieldFor(titleTarget) ?? ""];
    if (!track) return undefined;
  } else {
    // Rep target: walk whichever line yields the best rate today. A line
    // that starts ahead can in principle be overtaken later, but comparing
    // full walks per line buys little at this estimate's precision.
    const start = bestPositionAt(companyName, person, startRep, favor, ctx);
    if (!start) return undefined;
    track = JOB_TRACKS[start.field];
    if (!track) return undefined;
  }

  let rep = startRep;
  let seconds = 0;
  const path: string[] = [];
  let held: CompanyPositionInfo | undefined;
  // The measurement belongs to the rung actually WORKED today. The walk always
  // replays the track from its entry rung, and every rung the player already
  // qualifies for is crossed at zero cost — so the rung held when the first
  // PAYING segment begins is the current one, and that is the only segment the
  // measured rate may override. Keying on `path.length <= 1` instead meant the
  // override landed on the free entry-rung segment and was silently discarded
  // for every player who has ever been promoted.
  let measuredSpent = false;
  const rateAt = (position: CompanyPositionInfo): number => {
    if (!measuredSpent && measuredRepPerSec !== undefined && measuredRepPerSec > 0) {
      measuredSpent = true;
      return measuredRepPerSec;
    }
    return companyRepPerSec(person, position, favor, ctx);
  };
  for (const name of track) {
    if (!company.positions.includes(name)) break;
    const position = COMPANY_POSITIONS[name];
    if (!position) break;
    const statGated = Object.entries(requiredSkillsAt(company, position))
      .some(([skill, needed]) => (person.skills[skill] ?? 0) < needed);
    if (statGated) break;
    const gate = requiredReputationAt(position, ctx);
    // A rep target inside this rung's gate is reached before the promotion:
    // never grind toward gates beyond the target.
    if (titleTarget === undefined && target.repTarget !== undefined && gate >= target.repTarget) break;
    if (rep < gate) {
      if (!held) return undefined; // cannot even enter the track
      const rate = rateAt(held);
      if (!(rate > 0)) return undefined;
      seconds += (gate - rep) / rate;
      rep = gate;
    }
    held = position;
    path.push(name);
    if (titleTarget !== undefined && name === titleTarget) {
      return finish();
    }
  }
  if (titleTarget !== undefined) return undefined; // title stat-gated or not offered
  if (!held) return undefined;
  return finish();

  function finish(): LadderEta {
    const repTarget = target.repTarget;
    if (repTarget !== undefined && rep < repTarget) {
      const rate = rateAt(held!);
      if (!(rate > 0)) return { seconds: Infinity, path, finalPosition: path[path.length - 1]! };
      seconds += (repTarget - rep) / rate;
    }
    return { seconds, path, finalPosition: path[path.length - 1]! };
  }
}

/** The track a title belongs to (titles are globally unique across tracks). */
export function trackFieldFor(title: string): string | undefined {
  return COMPANY_POSITIONS[title]?.field;
}

export interface TitlePathOption {
  company: string;
  title: string;
  etaSec: number;
  field: string;
}

/** Cheapest way to satisfy a disjunctive title requirement (e.g. Silhouette's
 * "CTO, CFO, or CEO of a company"): every acceptable title × every candidate
 * company, priced by the promotion walker. Titles come from the requirement
 * data — nothing here assumes which titles a faction wants. */
export function bestTitlePath(
  titles: readonly string[],
  companies: readonly { name: string; rep: number; favor: number; measuredRepPerSec?: number; backdoored?: boolean }[],
  person: CompanyPerson,
  ctx: CompanyWorkContext,
): TitlePathOption | undefined {
  let best: TitlePathOption | undefined;
  for (const title of titles) {
    for (const candidate of companies) {
      const eta = promotionAwareEtaSec(
        candidate.name,
        person,
        candidate.rep,
        candidate.favor,
        { ...ctx, backdoored: candidate.backdoored },
        { titleTarget: title },
        candidate.measuredRepPerSec,
      );
      if (!eta || !Number.isFinite(eta.seconds)) continue;
      if (!best || eta.seconds < best.etaSec) {
        best = { company: candidate.name, title, etaSec: eta.seconds, field: trackFieldFor(title)! };
      }
    }
  }
  return best;
}

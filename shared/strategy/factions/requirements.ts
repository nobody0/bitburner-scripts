import type { PlayerRequirement } from "@ns";
import type { FeatureId } from "../../features/ids.ts";
import type { NeedKind } from "../needs.ts";
import { COMPANIES } from "../../features/companies.ts";
import {
  applyOutcomes,
  bestTitlePath,
  promotionAwareEtaSec,
  type CompanyPerson,
  type CompanyWorkContext,
} from "../career/company.ts";

/** Interpreter for the game's own `PlayerRequirement` tree.
 *
 * Requirements are read at RUNTIME from
 * `ns.singularity.getFactionInviteRequirements(name)`, which works for any
 * faction, and `ns.enums.FactionName` (a 0 GB property) enumerates them all.
 * So **no faction table is hardcoded in shared/** — this module interprets
 * whatever the game hands back, and the vendored table
 * (sim/vendor/.../FactionTable.ts) exists only so the SIMULATOR can answer the
 * same query.
 *
 * The output is a list of `Blocker`s: what is missing, how close we are, and —
 * the load-bearing part — WHICH FEATURE can deliver it. That owner map is the
 * whole cross-feature contract; the driver turns it straight into `Need`
 * records for the board.
 *
 * Each supported requirement returns either no blockers or explicit blockers.
 * Infiltration is reported as manual-only until its invitation is observed.
 *
 * Upstream requirement predicates and serialized shapes (pinned v3.0.1):
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionJoinCondition.ts#L45-L381 */

/** Everything a requirement can be evaluated against. Flat and plain so the
 * strategy stays pure — the driver assembles it from GameState. */
export interface RequirementView {
  money: number;
  skills: Record<string, number>;
  /** Negative and decreasing. */
  karma: number;
  numPeopleKilled: number;
  /** Installed augmentations, which positive `numAugmentations` targets count. */
  augCount: number;
  /** Installed or queued non-NeuroFlux augmentations. Upstream uses this only
   * for the special zero-augmentation predicate. */
  purchasedAugCount?: number;
  /** Company name -> job title. */
  jobs: Record<string, string>;
  /** Company name -> reputation. */
  companyRep: Record<string, number>;
  /** Job titles held at any company, for `jobTitle`. */
  jobTitles: string[];
  city: string;
  location: string;
  backdoored: ReadonlySet<string>;
  /** Observed access gates for servers named by backdoor requirements. These
   * are ranking inputs only: the actual requirement remains satisfied solely
   * by `backdoored`. Keeping the estimate here prevents every server from
   * looking like the same 300-second task while preserving pure strategy. */
  backdoorAccess?: Readonly<Record<string, {
    requiredHackingSkill: number;
    numOpenPortsRequired: number;
    openPortCount: number;
    /** Driver-precomputed hackTime/4 at the skill the install will run at
     * (shared/strategy/access/value.ts backdoorCostSeconds). Optional so the
     * interpreter degrades to the coarse constants when the driver has not
     * priced the host. */
    installSec?: number;
    /** Driver-precomputed seconds until the skill requirement is met, from
     * the measured fleet exp rate. */
    skillWaitSec?: number;
  }>>;
  /** Port-opening programs observed by the fleet sweep. */
  portOpeners?: number;
  files: ReadonlySet<string>;
  hacknetRam: number;
  hacknetCores: number;
  hacknetLevels: number;
  bitNode: number;
  sourceFiles: Record<string, number>;
  bladeburnerRank: number;
  numInfiltrations: number;
  /** Inputs for pricing company blockers (`employment`, `companyRep`,
   * `jobTitle`) with the work-line model instead of nominal per-unit rates.
   * Optional so the evaluator remains usable without a player snapshot. */
  companyWork?: {
    person: CompanyPerson;
    ctx: CompanyWorkContext;
    /** Company name -> favor (salary and rep rates scale with it). */
    favor: Readonly<Record<string, number>>;
    /** Company name -> measured rep/sec for the position actually worked. */
    measuredRepPerSec?: Readonly<Record<string, number>>;
    /** Companies whose server is backdoored (reputation gates discounted). */
    backdooredCompanies?: ReadonlySet<string>;
  };
}

/** Blocker kinds extend the need kinds with three that no feature can deliver
 * inside a run. They are still reported — "you are in the wrong BitNode" is
 * useful — but they never become `Need`s, because there is nobody to ask. */
export type BlockerKind = NeedKind | "location" | "bitNode" | "sourceFile" | "infiltrations";

export interface Blocker {
  kind: BlockerKind;
  /** Company / hostname / skill name / city / file, when the kind needs one. */
  subject?: string;
  target: number;
  have: number;
  /** How close, in [0, 1]. Sortable, so "nearly there" outranks "barely
   *  started" when two blockers are otherwise equal. */
  progress: number;
  /** The feature that can deliver this. The cross-feature contract. */
  owner: FeatureId;
  /** False when nothing can satisfy it inside this run — a negated karma
   *  requirement (karma only ever decreases), or the wrong BitNode. An
   *  unreachable blocker makes the whole faction unreachable, which is a
   *  decision input, not an error. */
  reachable: boolean;
  /** True when the requirement is that this NOT hold. Only ever set for the
   *  revocable kinds, since those are the only ones De Morgan can act on. */
  negated?: boolean;
  /** Optional observation-aware ranking estimate. It never substitutes for
   * the requirement predicate and is not presented as a route forecast. */
  etaSec?: number;
}

/** Which feature can deliver each outcome. Changing an entry here re-routes a
 * requirement to a different feature's driver, and nothing else changes. */
const OWNER: Record<BlockerKind, FeatureId> = {
  money: "hacking",
  karma: "career",
  kills: "career",
  skill: "hacking",
  combatSkills: "career",
  charisma: "career",
  companyRep: "career",
  factionRep: "factions",
  jobTitle: "career",
  employment: "career",
  quitCompany: "career",
  city: "career",
  location: "career",
  root: "hacking",
  backdoor: "hacking",
  file: "hacking",
  hacknetRam: "hacknet",
  hacknetCores: "hacknet",
  hacknetLevels: "hacknet",
  bladeburnerRank: "bladeburner",
  infiltrations: "side",
  augCount: "factions",
  bitNode: "progression",
  sourceFile: "progression",
};

/** Combat skills, as `haveCombatSkills` expands them. */
export const COMBAT_SKILLS = ["strength", "defense", "dexterity", "agility"] as const;

function ratio(have: number, target: number): number {
  if (target === 0) return have === 0 ? 1 : 0;
  // Same-sign ratio only. Karma heading from 0 to -45 has made no progress,
  // and a signed ratio would report a negative fraction.
  if (Math.sign(have) !== Math.sign(target)) return 0;
  const value = have / target;
  return value <= 0 ? 0 : Math.min(1, value);
}

function blocker(
  kind: BlockerKind,
  target: number,
  have: number,
  extra: Partial<Blocker> = {},
): Blocker {
  return { kind, target, have, progress: ratio(have, target), owner: OWNER[kind], reachable: true, ...extra };
}

/** Push `not` inward by De Morgan until it sits on a leaf.
 *
 * Doing this FIRST is what makes negation tractable: `not(A and B)` becomes
 * `(not A) or (not B)`, so the OR branch-picking below handles it, and the
 * only remaining question is whether a negated LEAF is revocable. */
export function negate(requirement: PlayerRequirement): PlayerRequirement {
  switch (requirement.type) {
    case "not":
      return requirement.condition;
    case "someCondition":
      return { type: "everyCondition", conditions: requirement.conditions.map(negate) };
    case "everyCondition":
      return { type: "someCondition", conditions: requirement.conditions.map(negate) };
    default:
      return { type: "not", condition: requirement };
  }
}

/** Blockers for one requirement. An empty array means satisfied. */
export function evaluate(requirement: PlayerRequirement, view: RequirementView): Blocker[] {
  switch (requirement.type) {
    case "money":
      return view.money >= requirement.money
        ? []
        : [blocker("money", requirement.money, view.money)];

    case "skills": {
      const out: Blocker[] = [];
      const entries = Object.entries(requirement.skills) as [string, number][];
      // `haveCombatSkills(n)` emits all four at once. Recognising that shape
      // lets career treat it as ONE goal ("train combat to n") instead of four
      // competing ones, which is how the game actually presents it.
      const combat = entries.filter(([skill]) => (COMBAT_SKILLS as readonly string[]).includes(skill));
      const isCombatSet =
        combat.length === COMBAT_SKILLS.length && new Set(combat.map(([, level]) => level)).size === 1;
      if (isCombatSet) {
        const target = combat[0]![1];
        const have = Math.min(...COMBAT_SKILLS.map((skill) => view.skills[skill] ?? 0));
        if (have < target) out.push(blocker("combatSkills", target, have));
        return out;
      }
      for (const [skill, target] of entries) {
        const have = view.skills[skill] ?? 0;
        if (have >= target) continue;
        const kind: BlockerKind = skill === "charisma" ? "charisma" : "skill";
        out.push(blocker(kind, target, have, { subject: skill }));
      }
      return out;
    }

    case "karma":
      // Karma requirements are UPPER bounds on a negative number.
      return view.karma <= requirement.karma
        ? []
        : [blocker("karma", requirement.karma, view.karma)];

    case "numPeopleKilled":
      return view.numPeopleKilled >= requirement.numPeopleKilled
        ? []
        : [blocker("kills", requirement.numPeopleKilled, view.numPeopleKilled)];

    case "file":
      return view.files.has(requirement.file)
        ? []
        : [blocker("file", 1, 0, { subject: requirement.file })];

    case "numAugmentations": {
      // Zero is special: installed + queued, excluding NeuroFlux. Positive
      // targets count installed augmentations only.
      // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionJoinCondition.ts#L119-L132
      const counted = requirement.numAugmentations === 0 ? (view.purchasedAugCount ?? view.augCount) : view.augCount;
      if (requirement.numAugmentations === 0) {
        return counted === 0 ? [] : [blocker("augCount", 0, counted)];
      }
      // A goal, never "unachievable": this is exactly how Daedalus is planned
      // toward, and treating "not yet" as impossible removes the endgame.
      return counted >= requirement.numAugmentations
        ? []
        : [blocker("augCount", requirement.numAugmentations, counted)];
    }

    case "employedBy": {
      if (Object.hasOwn(view.jobs, requirement.company)) return [];
      // Hiring is instant once a track's entry rung is qualified; the walkers
      // below price the grind that follows. Stat-gated hiring keeps the
      // nominal estimate — training time belongs to a different owner.
      const work = view.companyWork;
      const hirable = work
        ? applyOutcomes(
            requirement.company,
            work.person,
            view.companyRep[requirement.company] ?? 0,
            work.favor[requirement.company] ?? 0,
            companyCtx(work, requirement.company),
          ).length > 0
        : false;
      return [blocker("employment", 1, 0, {
        subject: requirement.company,
        ...(hirable ? { etaSec: 60 } : {}),
      })];
    }

    case "companyReputation": {
      const have = view.companyRep[requirement.company] ?? 0;
      if (have >= requirement.reputation) return [];
      const work = view.companyWork;
      const walk = work
        ? promotionAwareEtaSec(
            requirement.company,
            work.person,
            have,
            work.favor[requirement.company] ?? 0,
            companyCtx(work, requirement.company),
            { repTarget: requirement.reputation },
            work.measuredRepPerSec?.[requirement.company],
          )
        : undefined;
      return [
        blocker("companyRep", requirement.reputation, have, {
          subject: requirement.company,
          ...(walk && Number.isFinite(walk.seconds) ? { etaSec: walk.seconds } : {}),
        }),
      ];
    }

    case "jobTitle": {
      if (view.jobTitles.includes(requirement.jobTitle)) return [];
      // Price the title across every company that offers its track, from the
      // reputation already held there. The someCondition combiner then picks
      // the genuinely cheapest of alternative titles — nothing here assumes
      // which title, track or company a faction wants.
      const work = view.companyWork;
      const path = work
        ? bestTitlePath(
            [requirement.jobTitle],
            Object.keys(COMPANIES).map((name) => ({
                name,
                rep: view.companyRep[name] ?? 0,
                favor: work.favor[name] ?? 0,
                measuredRepPerSec: work.measuredRepPerSec?.[name],
                backdoored: work.backdooredCompanies?.has(name) ?? false,
              })),
            work.person,
            work.ctx,
          )
        : undefined;
      return [blocker("jobTitle", 1, 0, {
        subject: requirement.jobTitle,
        ...(path ? { etaSec: path.etaSec } : {}),
      })];
    }

    case "city":
      return view.city === requirement.city
        ? []
        : [blocker("city", 1, 0, { subject: requirement.city })];

    case "location":
      return view.location === requirement.location
        ? []
        : [blocker("location", 1, 0, { subject: requirement.location })];

    case "backdoorInstalled": {
      if (view.backdoored.has(requirement.server)) return [];
      const access = view.backdoorAccess?.[requirement.server];
      if (!access) {
        return [blocker("backdoor", 1, 0, { subject: requirement.server })];
      }
      const skillGap = Math.max(0, access.requiredHackingSkill - (view.skills.hacking ?? 0));
      const usableOpeners = Math.max(access.openPortCount, view.portOpeners ?? 0);
      const portGap = Math.max(0, access.numOpenPortsRequired - usableOpeners);
      // Prefer the driver's priced estimate (hackTime/4 at the acting skill,
      // measured exp rate for the wait); degrade per COMPONENT to the coarse
      // constants, so a partially-priced view is never worse than unpriced.
      const installSec = access.installSec ?? NOMINAL_SEC_PER_UNIT.backdoor;
      const skillWaitSec = access.skillWaitSec ?? skillGap * NOMINAL_SEC_PER_UNIT.skill;
      return [blocker("backdoor", 1, 0, {
        subject: requirement.server,
        // Ranking economics: skill and program acquisition precede the
        // terminal/backdoor action. The live hacking planner owns both.
        etaSec: installSec + skillWaitSec + portGap * NOMINAL_SEC_PER_UNIT.file,
      })];
    }

    case "hacknetRAM":
      return view.hacknetRam >= requirement.hacknetRAM
        ? []
        : [blocker("hacknetRam", requirement.hacknetRAM, view.hacknetRam)];

    case "hacknetCores":
      return view.hacknetCores >= requirement.hacknetCores
        ? []
        : [blocker("hacknetCores", requirement.hacknetCores, view.hacknetCores)];

    case "hacknetLevels":
      return view.hacknetLevels >= requirement.hacknetLevels
        ? []
        : [blocker("hacknetLevels", requirement.hacknetLevels, view.hacknetLevels)];

    case "bladeburnerRank":
      return view.bladeburnerRank >= requirement.bladeburnerRank
        ? []
        : [blocker("bladeburnerRank", requirement.bladeburnerRank, view.bladeburnerRank)];

    case "numInfiltrations":
      return view.numInfiltrations >= requirement.numInfiltrations
        ? []
        : [blocker("infiltrations", requirement.numInfiltrations, view.numInfiltrations, { reachable: false })];

    case "bitNodeN":
      // Nothing inside a run changes the node.
      return view.bitNode === requirement.bitNodeN
        ? []
        : [blocker("bitNode", requirement.bitNodeN, view.bitNode, { reachable: false })];

    case "sourceFile":
      return (view.sourceFiles[String(requirement.sourceFile)] ?? 0) > 0
        ? []
        : [blocker("sourceFile", requirement.sourceFile, 0, { reachable: false })];

    case "not":
      return evaluateNot(requirement.condition, view);

    case "everyCondition": {
      // AND: the union of every unmet branch.
      const out: Blocker[] = [];
      for (const condition of requirement.conditions) out.push(...evaluate(condition, view));
      return out;
    }

    case "someCondition": {
      // OR: satisfied the moment ANY branch is, and otherwise the CHEAPEST
      // reachable branch — reporting all of them would make an alternative
      // look like a conjunction and inflate every ETA.
      const branches = requirement.conditions.map((condition) => evaluate(condition, view));
      if (branches.some((blockers) => blockers.length === 0)) return [];
      const reachable = branches.filter((blockers) => blockers.every((entry) => entry.reachable));
      if (reachable.length === 0) {
        // Every branch is impossible, so the OR is. Report the shortest for
        // explanation, marked unreachable.
        const shortest = branches.reduce((best, next) => (next.length < best.length ? next : best), branches[0]!);
        return shortest.map((entry) => ({ ...entry, reachable: false }));
      }
      return reachable.reduce((best, next) => (cheapness(next) < cheapness(best) ? next : best), reachable[0]!);
    }
  }
}

/** Per-company work context: the shared fields plus this company's backdoor
 * discount. */
function companyCtx(work: NonNullable<RequirementView["companyWork"]>, company: string): CompanyWorkContext {
  return { ...work.ctx, backdoored: work.backdooredCompanies?.has(company) ?? false };
}

/** Rank OR branches: fewer blockers first, then furthest-along, then — only
 * as the tie-break between structurally identical branches — total attached
 * ETA. That last term is what picks the cheapest of Silhouette's alternative
 * executive titles once jobTitle blockers carry real ladder estimates. A
 * blocker WITHOUT an estimate counts as more expensive than any estimated
 * one (no ladder was reachable, or nobody priced it), and the whole term is
 * scaled below BOTH structural terms — a 0.9-magnitude term would have
 * outranked almost any furthest-along difference, which is not a tie-break. */
function cheapness(blockers: Blocker[]): number {
  const remaining = blockers.reduce((sum, entry) => sum + (1 - entry.progress), 0);
  const etaSec = blockers.reduce((sum, entry) => sum + (entry.etaSec ?? 1e9), 0);
  return blockers.length * 10 + remaining + Math.min(etaSec / 1e9, 0.9) * 1e-3;
}

/** A negated leaf. Only three things are REVOCABLE — employment, city and
 * location — because everything else in the game only ever accumulates. */
function evaluateNot(condition: PlayerRequirement, view: RequirementView): Blocker[] {
  // Push the negation into `condition`. NOTE the argument: it is `condition`,
  // not `{type:"not", condition}` — negate() UNWRAPS a `not`, so passing the
  // wrapper would hand back the bare condition and evaluate it POSITIVELY,
  // inverting the meaning of every negated requirement.
  const pushed = negate(condition);
  if (pushed.type !== "not") return evaluate(pushed, view);
  const leaf = pushed.condition;

  switch (leaf.type) {
    case "employedBy":
      return Object.hasOwn(view.jobs, leaf.company)
        ? [blocker("quitCompany", 0, 1, { subject: leaf.company, negated: true })]
        : [];

    case "city":
      return view.city === leaf.city
        ? [blocker("city", 0, 1, { subject: leaf.city, negated: true })]
        : [];

    case "location":
      return view.location === leaf.location
        ? [blocker("location", 0, 1, { subject: leaf.location, negated: true })]
        : [];

    default: {
      // Not revocable. If it is currently UNsatisfied then the negation holds
      // and there is nothing to do; if it is satisfied, nothing can undo it.
      const unmet = evaluate(leaf, view);
      if (unmet.length > 0) return [];
      return [
        {
          kind: kindOf(leaf),
          target: 0,
          have: 1,
          progress: 0,
          owner: OWNER[kindOf(leaf)],
          reachable: false,
          negated: true,
        },
      ];
    }
  }
}

function kindOf(requirement: PlayerRequirement): BlockerKind {
  switch (requirement.type) {
    case "money":
      return "money";
    case "karma":
      return "karma";
    case "numPeopleKilled":
      return "kills";
    case "skills":
      return "skill";
    case "numAugmentations":
      return "augCount";
    case "companyReputation":
      return "companyRep";
    case "jobTitle":
      return "jobTitle";
    case "employedBy":
      return "employment";
    case "city":
      return "city";
    case "location":
      return "location";
    case "backdoorInstalled":
      return "backdoor";
    case "file":
      return "file";
    case "hacknetRAM":
      return "hacknetRam";
    case "hacknetCores":
      return "hacknetCores";
    case "hacknetLevels":
      return "hacknetLevels";
    case "bladeburnerRank":
      return "bladeburnerRank";
    case "numInfiltrations":
      return "infiltrations";
    case "bitNodeN":
      return "bitNode";
    case "sourceFile":
      return "sourceFile";
    default:
      return "money";
  }
}

/** Blockers for a whole requirement list (what the ns API returns), which is
 * an implicit AND. */
export function evaluateAll(requirements: readonly PlayerRequirement[], view: RequirementView): Blocker[] {
  return evaluate({ type: "everyCondition", conditions: [...requirements] }, view);
}

/** Can this faction be joined at all in this run? */
export function isReachable(blockers: readonly Blocker[]): boolean {
  return blockers.every((entry) => entry.reachable);
}

/** Aggregate ETA across blockers.
 *
 * SUM within one owner, MAX across owners — one feature has one time slot and
 * must do its blockers in sequence, while different features genuinely run in
 * parallel. Summing everything would triple-count a faction blocked on career
 * AND hacknet; taking the max everywhere would under-count two career goals. */
export function combinedEtaSec(blockers: readonly Blocker[], etaSec: (blocker: Blocker) => number): number {
  const perOwner = new Map<FeatureId, number>();
  for (const entry of blockers) {
    perOwner.set(entry.owner, (perOwner.get(entry.owner) ?? 0) + etaSec(entry));
  }
  let worst = 0;
  for (const total of perOwner.values()) if (total > worst) worst = total;
  return worst;
}

/** Rates used to turn a blocker into an ETA, in "seconds per unit of the
 * blocker's own target".
 *
 * These are COARSE and deliberately so. The exact rate for karma belongs to
 * `career` and for hacknet RAM to `hacknet`; until those features can quote
 * their own delivery rate through the needs board, the planner still has to
 * rank "one cheap backdoor" against "thirty augmentations", and doing that
 * with no time dimension at all is what makes a planner commit to Daedalus
 * over CyberSec on a fresh run and then idle for hours.
 *
 * They are used only for RANKING, never reported as a prediction. */
const NOMINAL_SEC_PER_UNIT: Record<BlockerKind, number> = {
  money: 0, // computed from measured income instead
  karma: 10,
  kills: 120,
  skill: 30,
  combatSkills: 60,
  charisma: 60,
  companyRep: 0.1,
  factionRep: 0.1,
  jobTitle: 600,
  employment: 600,
  quitCompany: 0,
  city: 60,
  location: 30,
  root: 300,
  backdoor: 300,
  file: 600,
  hacknetRam: 60,
  hacknetCores: 300,
  hacknetLevels: 20,
  bladeburnerRank: 60,
  infiltrations: 300,
  augCount: 1800,
  bitNode: Infinity,
  sourceFile: Infinity,
};

/** Coarse seconds-to-satisfy for one blocker. `incomePerSec` is the one rate
 * the planner genuinely measures, so money uses it. */
export function estimateBlockerSec(blocker: Blocker, incomePerSec: number): number {
  if (!blocker.reachable) return Infinity;
  if (blocker.etaSec !== undefined) return Math.max(0, blocker.etaSec);
  const remaining = Math.abs(blocker.target - blocker.have);
  if (remaining === 0) return 0;
  if (blocker.kind === "money") return remaining / Math.max(1, incomePerSec);
  return remaining * NOMINAL_SEC_PER_UNIT[blocker.kind];
}

export { OWNER as BLOCKER_OWNERS };

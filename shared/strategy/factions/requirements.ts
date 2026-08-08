import type { PlayerRequirement } from "@ns";
import type { FeatureId } from "../../features/ids.ts";
import type { NeedKind } from "../needs.ts";

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
 * The predecessor scripts got four of these cases wrong in ways that silently
 * made whole branches of the game unreachable, and each is a named test here:
 *
 *  - their `not` case returns `false` whether the inner call succeeded or not,
 *    because an EMPTY ARRAY is truthy in JS — so every `notEmployedBy` faction
 *    (the entire criminal ladder) was permanently unreachable;
 *  - `someCondition` returns `false` unconditionally after its success loop, so
 *    a satisfiable OR reports as impossible;
 *  - `numAugmentations` treats "not yet" as unachievable rather than emitting a
 *    goal, so Daedalus can never be planned toward;
 *  - `hacknetRAM`/`Cores`/`Levels`, `bladeburnerRank` and `numInfiltrations`
 *    are `return false` TODOs, so Netburners, Bladeburners and Shadows of
 *    Anarchy are unreachable. */

/** Everything a requirement can be evaluated against. Flat and plain so the
 * strategy stays pure — the driver assembles it from GameState. */
export interface RequirementView {
  money: number;
  skills: Record<string, number>;
  /** Negative and decreasing. */
  karma: number;
  numPeopleKilled: number;
  /** Installed OR queued — what `numAugmentations` counts. */
  augCount: number;
  /** Company name -> job title. */
  jobs: Record<string, string>;
  /** Company name -> reputation. */
  companyRep: Record<string, number>;
  /** Job titles held at any company, for `jobTitle`. */
  jobTitles: string[];
  city: string;
  location: string;
  backdoored: ReadonlySet<string>;
  files: ReadonlySet<string>;
  hacknetRam: number;
  hacknetCores: number;
  hacknetLevels: number;
  bitNode: number;
  sourceFiles: Record<string, number>;
  bladeburnerRank: number;
  numInfiltrations: number;
}

/** Blocker kinds extend the need kinds with three that no feature can deliver
 * inside a run. They are still reported — "you are in the wrong BitNode" is
 * useful — but they never become `Need`s, because there is nobody to ask. */
export type BlockerKind = NeedKind | "location" | "bitNode" | "sourceFile";

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
  why: string;
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
  jobTitle: "career",
  employment: "career",
  quitCompany: "career",
  city: "career",
  location: "career",
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
  why: string,
  extra: Partial<Blocker> = {},
): Blocker {
  return { kind, target, have, progress: ratio(have, target), owner: OWNER[kind], reachable: true, why, ...extra };
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

/** Blockers for one requirement. An EMPTY array means satisfied — which is the
 * distinction the predecessor scripts got wrong, since `[]` is truthy. */
export function evaluate(requirement: PlayerRequirement, view: RequirementView): Blocker[] {
  switch (requirement.type) {
    case "money":
      return view.money >= requirement.money
        ? []
        : [blocker("money", requirement.money, view.money, `needs $${requirement.money.toLocaleString()}`)];

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
        if (have < target) out.push(blocker("combatSkills", target, have, `needs all combat skills at ${target}`));
        return out;
      }
      for (const [skill, target] of entries) {
        const have = view.skills[skill] ?? 0;
        if (have >= target) continue;
        const kind: BlockerKind = skill === "charisma" ? "charisma" : "skill";
        out.push(blocker(kind, target, have, `needs ${skill} ${target}`, { subject: skill }));
      }
      return out;
    }

    case "karma":
      // Karma requirements are UPPER bounds on a negative number.
      return view.karma <= requirement.karma
        ? []
        : [blocker("karma", requirement.karma, view.karma, `needs karma <= ${requirement.karma}`)];

    case "numPeopleKilled":
      return view.numPeopleKilled >= requirement.numPeopleKilled
        ? []
        : [
            blocker(
              "kills",
              requirement.numPeopleKilled,
              view.numPeopleKilled,
              `needs ${requirement.numPeopleKilled} kills`,
            ),
          ];

    case "file":
      return view.files.has(requirement.file)
        ? []
        : [blocker("file", 1, 0, `needs the file ${requirement.file}`, { subject: requirement.file })];

    case "numAugmentations":
      // A goal, never "unachievable": this is exactly how Daedalus is planned
      // toward, and treating "not yet" as impossible removes the endgame.
      return view.augCount >= requirement.numAugmentations
        ? []
        : [
            blocker(
              "augCount",
              requirement.numAugmentations,
              view.augCount,
              `needs ${requirement.numAugmentations} augmentations`,
            ),
          ];

    case "employedBy":
      return Object.hasOwn(view.jobs, requirement.company)
        ? []
        : [blocker("employment", 1, 0, `needs a job at ${requirement.company}`, { subject: requirement.company })];

    case "companyReputation": {
      const have = view.companyRep[requirement.company] ?? 0;
      return have >= requirement.reputation
        ? []
        : [
            blocker("companyRep", requirement.reputation, have, `needs ${requirement.company} reputation`, {
              subject: requirement.company,
            }),
          ];
    }

    case "jobTitle":
      return view.jobTitles.includes(requirement.jobTitle)
        ? []
        : [blocker("jobTitle", 1, 0, `needs the job title ${requirement.jobTitle}`, { subject: requirement.jobTitle })];

    case "city":
      return view.city === requirement.city
        ? []
        : [blocker("city", 1, 0, `needs to be in ${requirement.city}`, { subject: requirement.city })];

    case "location":
      return view.location === requirement.location
        ? []
        : [blocker("location", 1, 0, `needs to be at ${requirement.location}`, { subject: requirement.location })];

    case "backdoorInstalled":
      return view.backdoored.has(requirement.server)
        ? []
        : [blocker("backdoor", 1, 0, `needs a backdoor on ${requirement.server}`, { subject: requirement.server })];

    case "hacknetRAM":
      return view.hacknetRam >= requirement.hacknetRAM
        ? []
        : [blocker("hacknetRam", requirement.hacknetRAM, view.hacknetRam, `needs ${requirement.hacknetRAM}GB hacknet RAM`)];

    case "hacknetCores":
      return view.hacknetCores >= requirement.hacknetCores
        ? []
        : [
            blocker(
              "hacknetCores",
              requirement.hacknetCores,
              view.hacknetCores,
              `needs ${requirement.hacknetCores} hacknet cores`,
            ),
          ];

    case "hacknetLevels":
      return view.hacknetLevels >= requirement.hacknetLevels
        ? []
        : [
            blocker(
              "hacknetLevels",
              requirement.hacknetLevels,
              view.hacknetLevels,
              `needs ${requirement.hacknetLevels} hacknet levels`,
            ),
          ];

    case "bladeburnerRank":
      return view.bladeburnerRank >= requirement.bladeburnerRank
        ? []
        : [
            blocker(
              "bladeburnerRank",
              requirement.bladeburnerRank,
              view.bladeburnerRank,
              `needs Bladeburner rank ${requirement.bladeburnerRank}`,
            ),
          ];

    case "numInfiltrations":
      return view.numInfiltrations >= requirement.numInfiltrations
        ? []
        : [
            blocker(
              "infiltrations",
              requirement.numInfiltrations,
              view.numInfiltrations,
              `needs ${requirement.numInfiltrations} infiltrations`,
            ),
          ];

    case "bitNodeN":
      // Nothing inside a run changes the node.
      return view.bitNode === requirement.bitNodeN
        ? []
        : [
            blocker("bitNode", requirement.bitNodeN, view.bitNode, `only in BitNode ${requirement.bitNodeN}`, {
              reachable: false,
            }),
          ];

    case "sourceFile":
      return (view.sourceFiles[String(requirement.sourceFile)] ?? 0) > 0
        ? []
        : [
            blocker("sourceFile", requirement.sourceFile, 0, `needs Source-File ${requirement.sourceFile}`, {
              reachable: false,
            }),
          ];

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

/** Rank OR branches: fewer blockers first, then furthest-along. Deliberately
 * crude — a real ETA needs each owner's delivery rate, which lives in the
 * driver, so this is only the structural tie-break. */
function cheapness(blockers: Blocker[]): number {
  const remaining = blockers.reduce((sum, entry) => sum + (1 - entry.progress), 0);
  return blockers.length * 10 + remaining;
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
        ? [
            blocker("quitCompany", 0, 1, `must not be employed by ${leaf.company}`, {
              subject: leaf.company,
              negated: true,
            }),
          ]
        : [];

    case "city":
      return view.city === leaf.city
        ? [blocker("city", 0, 1, `must not be in ${leaf.city}`, { subject: leaf.city, negated: true })]
        : [];

    case "location":
      return view.location === leaf.location
        ? [blocker("location", 0, 1, `must not be at ${leaf.location}`, { subject: leaf.location, negated: true })]
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
          why: `must NOT satisfy ${leaf.type}, which cannot be undone`,
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
  jobTitle: 600,
  employment: 600,
  quitCompany: 0,
  city: 60,
  location: 30,
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
  const remaining = Math.abs(blocker.target - blocker.have);
  if (remaining === 0) return 0;
  if (blocker.kind === "money") return remaining / Math.max(1, incomePerSec);
  return remaining * NOMINAL_SEC_PER_UNIT[blocker.kind];
}

export { OWNER as BLOCKER_OWNERS };

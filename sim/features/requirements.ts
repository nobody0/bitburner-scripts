import type { PlayerRequirement } from "@ns";
import type { SimPlayer } from "../core/player.ts";
import type { SimServer } from "../core/effects.ts";
import type { Person } from "@ns";

/** Does the player satisfy a requirement RIGHT NOW?
 *
 * Deliberately separate from `shared/strategy/factions/requirements.ts`, and
 * the duplication is the point. That one is the PLANNER's interpreter: it
 * answers "what is missing, who can fix it, how close are we". This one is the
 * GAME's check: a plain boolean, transcribed from
 * `src/Faction/FactionJoinCondition.ts`'s `isSatisfied` methods.
 *
 * Sharing an implementation would let a planner bug and a world bug cancel
 * out — the run would look correct while both were wrong. Keeping them apart
 * means the simulator can genuinely disagree with the strategy, which is the
 * only way the simulator can catch anything. */

export interface SatisfyContext {
  player: SimPlayer;
  person: Person;
  servers: Map<string, SimServer>;
  factionRep: (name: string) => number;
  companyRep: (name: string) => number;
  bitNode: number;
  hacknet: { ram: number; cores: number; levels: number };
  bladeburnerRank: number;
  numInfiltrations: number;
  files: ReadonlySet<string>;
}

export function satisfies(requirement: PlayerRequirement, ctx: SatisfyContext): boolean {
  const { player, person } = ctx;
  switch (requirement.type) {
    case "money":
      return player.money >= requirement.money;

    case "skills":
      return Object.entries(requirement.skills).every(
        ([skill, level]) => (person.skills as unknown as Record<string, number>)[skill]! >= (level as number),
      );

    // Karma requirements are UPPER bounds on a negative number.
    case "karma":
      return player.karma <= requirement.karma;

    case "numPeopleKilled":
      return player.numPeopleKilled >= requirement.numPeopleKilled;

    case "file":
      return ctx.files.has(requirement.file);

    // Positive gates (including Daedalus) count INSTALLED augmentations only.
    // The zero gate is the upstream exception: queued non-NeuroFlux augs also
    // prevent joining the Church of the Machine God.
    case "numAugmentations": {
      if (requirement.numAugmentations > 0) {
        return player.augmentationCount(false) >= requirement.numAugmentations;
      }
      const installed = [...player.augmentations.keys()].filter((name) => name !== "NeuroFlux Governor").length;
      const queued = [...player.queuedAugmentations]
        .filter(([name]) => name !== "NeuroFlux Governor")
        .reduce((sum, [, levels]) => sum + levels, 0);
      return installed + queued === 0;
    }

    case "employedBy":
      return Object.hasOwn(player.jobs, requirement.company);

    case "companyReputation":
      return ctx.companyRep(requirement.company) >= requirement.reputation;

    case "jobTitle":
      return Object.values(player.jobs).includes(requirement.jobTitle);

    case "city":
      return player.city === requirement.city;

    case "location":
      return player.location === requirement.location;

    case "backdoorInstalled":
      return ctx.servers.get(requirement.server)?.backdoorInstalled === true;

    case "hacknetRAM":
      return ctx.hacknet.ram >= requirement.hacknetRAM;

    case "hacknetCores":
      return ctx.hacknet.cores >= requirement.hacknetCores;

    case "hacknetLevels":
      return ctx.hacknet.levels >= requirement.hacknetLevels;

    case "bitNodeN":
      return ctx.bitNode === requirement.bitNodeN;

    case "sourceFile":
      return (player.sourceFiles[String(requirement.sourceFile)] ?? 0) > 0;

    case "bladeburnerRank":
      return ctx.bladeburnerRank >= requirement.bladeburnerRank;

    case "numInfiltrations":
      return ctx.numInfiltrations >= requirement.numInfiltrations;

    case "not":
      return !satisfies(requirement.condition, ctx);

    case "someCondition":
      return requirement.conditions.some((condition) => satisfies(condition, ctx));

    case "everyCondition":
      return requirement.conditions.every((condition) => satisfies(condition, ctx));
  }
}

export function satisfiesAll(requirements: readonly PlayerRequirement[], ctx: SatisfyContext): boolean {
  return requirements.every((requirement) => satisfies(requirement, ctx));
}

import type { Need } from "../needs.ts";
import { installHorizonSec, type PlanningHorizons } from "../progression/forecast.ts";
import type { GoRewardOpponent } from "./decide.ts";
import type { GoEtaDemand } from "./rewards.ts";

export interface GoDemandView {
  horizons: PlanningHorizons;
  sinceInstall?: { total: number; hacking: number; hacknet: number };
  openNeeds: readonly Need[];
  /** Forecasts can include future route phases whose producing subsystem is
   * unavailable on this save. They are diagnostic, not actionable demand. */
  canEarnFactionRep: boolean;
  canRunBladeburner: boolean;
}

function opponentFor(value: "hacknet" | "crime" | "money" | "combat" | "reputation" | "speed" | "level"): GoRewardOpponent {
  return ({
    hacknet: "Netburners",
    crime: "Slum Snakes",
    money: "The Black Hand",
    combat: "Tetrads",
    reputation: "Daedalus",
    speed: "Illuminati",
    level: "????????????",
  } as const)[value];
}

function addDemand(
  demands: Partial<Record<GoRewardOpponent, GoEtaDemand>>,
  opponent: GoRewardOpponent,
  seconds: number,
  share: number,
  why: string,
): void {
  if (!(seconds > 0) || !(share > 0)) return;
  const previous = demands[opponent];
  const effective = seconds * Math.min(1, share) + (previous?.seconds ?? 0) * (previous?.share ?? 0);
  demands[opponent] = {
    seconds: effective,
    share: 1,
    why: previous ? `${previous.why}; ${why}` : why,
  };
}

/** Needs are qualitative fallback evidence. If the ETA has already priced the
 * same reward, append the provenance without charging the blocker twice. */
function addNeedDemand(
  demands: Partial<Record<GoRewardOpponent, GoEtaDemand>>,
  opponent: GoRewardOpponent,
  seconds: number,
  why: string,
): void {
  const previous = demands[opponent];
  if (!previous) {
    addDemand(demands, opponent, seconds, 1, why);
    return;
  }
  demands[opponent] = { ...previous, why: `${previous.why}; ${why}` };
}

/** Translate progression's actual critical path into the resource-specific
 * work each Go reward can shorten. This deliberately consumes typed resource
 * identities rather than matching human-facing ETA labels. */
export function goDemands(view: GoDemandView): Partial<Record<GoRewardOpponent, GoEtaDemand>> {
  const demands: Partial<Record<GoRewardOpponent, GoEtaDemand>> = {};
  // Go power is wiped by augmentation prestige. Use the same bounded
  // install-lifetime horizon as every other transient investment.
  const runway = installHorizonSec(view.horizons);
  const sources = view.sinceInstall;
  const positiveTotal = sources ? Math.max(0, sources.total) : 0;
  const hackingShare = positiveTotal > 0 ? Math.max(0, sources!.hacking) / positiveTotal : 0.5;
  const hacknetShare = positiveTotal > 0 ? Math.max(0, sources!.hacknet) / positiveTotal : 0;

  // One money bottleneck can have several alternative producers. Attribute it
  // using observed source shares: yield and speed both affect hacking, Hacknet
  // power affects Hacknet. Crime income is deliberately absent: an observed
  // income share does not reveal whether crime success is below its cap.
  const addMoneyDemand = (seconds: number, why: string) => {
    addDemand(demands, opponentFor("money"), seconds, hackingShare, `${why}; measured hacking share`);
    addDemand(demands, opponentFor("speed"), seconds, hackingShare, `${why}; measured hacking share`);
    addDemand(demands, opponentFor("hacknet"), seconds, hacknetShare, `${why}; measured Hacknet share`);
  };

  if (view.horizons.install.state === "estimated") {
    for (const part of view.horizons.install.components.filter((part) => part.critical)) {
      if (part.resource === "reputation") {
        addDemand(demands, opponentFor("reputation"), part.sec, 1, `install component: ${part.what}`);
      } else if (part.resource === "money") {
        addMoneyDemand(part.sec, `install component: ${part.what}`);
      }
    }
  }
  if (view.horizons.node.state === "estimated") {
    for (const part of view.horizons.node.components.filter((part) => part.critical)) {
      // Node power is erased by augmentation prestige. Later route phases are
      // real ETA, but this game's transient reward cannot survive to affect
      // them (notably BN1's post–Red Pill hacking regrow).
      if (part.resource === "install") break;
      if (part.resource === "money") {
        addMoneyDemand(part.sec, `node route component: ${part.what}`);
      } else if (part.resource === "hacking") {
        addDemand(demands, opponentFor("speed"), part.sec, 1, `node route component: ${part.what}`);
        addDemand(demands, opponentFor("level"), part.sec, 1, `node route component: ${part.what}`);
      } else if (part.resource === "reputation" && view.canEarnFactionRep) {
        addDemand(demands, opponentFor("reputation"), part.sec, 1, `node route component: ${part.what}`);
      } else if (part.resource === "combat" && view.canRunBladeburner) {
        addDemand(demands, opponentFor("combat"), part.sec, 1, `node route component: ${part.what}`);
      }
    }
  }
  for (const need of view.openNeeds) {
    const seconds = runway * Math.min(1, Math.max(0.1, need.weight / 10));
    if (need.kind === "money") addMoneyDemand(seconds, need.why);
    else if (need.kind === "karma" || need.kind === "kills") addNeedDemand(demands, opponentFor("crime"), seconds, need.why);
    else if (need.kind === "combatSkills" || need.kind === "bladeburnerRank") {
      addNeedDemand(demands, opponentFor("combat"), seconds, need.why);
    } else if (need.kind === "companyRep" || need.kind === "factionRep") {
      addNeedDemand(demands, opponentFor("reputation"), seconds, need.why);
    } else if (need.kind === "hacknetRam" || need.kind === "hacknetCores" || need.kind === "hacknetLevels") {
      addNeedDemand(demands, opponentFor("hacknet"), seconds, need.why);
    } else if (need.kind === "skill" && ["strength", "defense", "dexterity", "agility"].includes(need.subject ?? "")) {
      addNeedDemand(demands, opponentFor("combat"), seconds, need.why);
    } else if (need.kind === "backdoor" || need.kind === "skill" && need.subject === "hacking") {
      addNeedDemand(demands, opponentFor("speed"), seconds, need.why);
      addNeedDemand(demands, opponentFor("level"), seconds, need.why);
    }
  }
  return demands;
}

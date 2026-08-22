import type { Server } from "@ns";
import type { HackContext } from "../../formulas.ts";
import { capitalIndependentScore, farmExperienceRate, farmIncomeRate, type FarmRateModel } from "../economics.ts";
import { PORT_OPENER_PROGRAMS } from "../career/programs.ts";
import { TOR_COST } from "../dnet/rates.ts";
import { solveCycle, type CycleSolution } from "../targeting.ts";

export interface NextOpenerView {
  servers: readonly Server[];
  hackingSkill: number;
  hackContext: HackContext;
  fleetGb: number;
  ownedOpeners: number;
  /** Positive evidence, not a guess. */
  hasTor: boolean;
  currentFarm?: { solution: CycleSolution };
}

export interface NextOpenerInvestment {
  program: string;
  targetOpeners: number;
  cost: number;
  addedMoneyPerSec: number;
  addedHackingExpPerSec: number;
}

/** Remove stock-manipulation income from a farm model used to justify spending
 * the bankroll. The market separately bids for that same capital. */
function moneyFarmModel(solution: CycleSolution): FarmRateModel {
  const money = Math.max(0, solution.incomePerBatch);
  const stock = Math.max(0, solution.stockIncomePerBatch);
  const moneyShare = money + stock > 0 ? money / (money + stock) : 1;
  return {
    score: capitalIndependentScore(solution),
    ramPerBatch: solution.ramPerBatch,
    weakenTimeS: solution.weakenTimeS,
    ...(solution.jitSaturationGb !== undefined ? { jitSaturationGb: solution.jitSaturationGb } : {}),
    ...(solution.maximumIncomePerSec !== undefined
      ? { maximumIncomePerSec: solution.maximumIncomePerSec * moneyShare }
      : {}),
    experienceScore: solution.experienceScore,
  };
}

/** Price exactly the next port-opener tier from the world it unlocks now.
 *
 * Every newly rootable host contributes worker RAM; every profitable one is
 * also solved as a possible farm target. A later tier is deliberately ignored
 * until the preceding file exists, so each indivisible purchase is re-priced
 * against its own marginal world change. */
export function planNextOpener(view: NextOpenerView): NextOpenerInvestment | undefined {
  const program = PORT_OPENER_PROGRAMS[view.ownedOpeners];
  if (!program) return undefined;
  const targetOpeners = view.ownedOpeners + 1;
  const unlocked = view.servers.filter((server) =>
    !server.hasAdminRights
    && !server.purchasedByPlayer
    && server.hostname !== "home"
    && (server.requiredHackingSkill ?? Infinity) <= view.hackingSkill
    && (server.numOpenPortsRequired ?? 0) > view.ownedOpeners
    && (server.numOpenPortsRequired ?? 0) <= targetOpeners
  );
  if (unlocked.length === 0) return undefined;

  const fleetGb = Math.max(0, view.fleetGb);
  const afterGb = fleetGb + unlocked.reduce((sum, server) => sum + Math.max(0, server.maxRam), 0);
  const currentSolution = view.currentFarm?.solution;
  const currentMoney = currentSolution ? farmIncomeRate(moneyFarmModel(currentSolution), fleetGb) : 0;
  const currentExp = currentSolution ? farmExperienceRate(currentSolution, fleetGb) : 0;
  let bestMoney = currentSolution ? farmIncomeRate(moneyFarmModel(currentSolution), afterGb) : 0;
  let bestExp = currentSolution ? farmExperienceRate(currentSolution, afterGb) : 0;

  for (const server of unlocked) {
    const moneyMax = server.moneyMax ?? 0;
    const serverGrowth = server.serverGrowth ?? 0;
    if (!(moneyMax > 0) || !(serverGrowth > 0)) continue;
    const solution = solveCycle(view.hackContext, {
      hostname: server.hostname,
      minDifficulty: server.minDifficulty ?? 1,
      moneyMax,
      requiredHackingSkill: server.requiredHackingSkill ?? Infinity,
      serverGrowth,
      baseDifficulty: server.baseDifficulty ?? 1,
    });
    if (!solution) continue;
    const money = farmIncomeRate(moneyFarmModel(solution), afterGb);
    const exp = farmExperienceRate(solution, afterGb);
    if (money > bestMoney || (money === bestMoney && exp > bestExp)) {
      bestMoney = money;
      bestExp = exp;
    }
  }

  const addedMoneyPerSec = Math.max(0, bestMoney - currentMoney);
  const addedHackingExpPerSec = Math.max(0, bestExp - currentExp);
  if (!(addedMoneyPerSec > 0) && !(addedHackingExpPerSec > 0)) return undefined;
  const cost = program.purchaseCost + (view.hasTor ? 0 : TOR_COST);
  return {
    program: program.name,
    targetOpeners,
    cost,
    addedMoneyPerSec,
    addedHackingExpPerSec,
  };
}

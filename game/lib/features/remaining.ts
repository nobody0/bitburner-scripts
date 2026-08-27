import type { NS } from "@ns";
import { realmSleep } from "../wake.ts";
import { AUGMENTATIONS } from "../../../shared/features/augmentations.ts";
import { effectiveBitNodeMultipliers, WORLD_DAEMON_BASE_SKILL } from "../../../shared/features/bitnode.ts";
import { BLADEBURNER_RANK_CHANNEL, currencyWorth } from "../../../shared/strategy/income.ts";
import { careerBestPerSec, earnedSinceInstall, incomeShares } from "../income.ts";
import { blindBankrollRatePerSec } from "../../../shared/strategy/stock/decide.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { disabledByProfile } from "../../../shared/features/profile.ts";
import { PRIORITY, type Claim, type ClaimValueCurve } from "../../../shared/strategy/arbiter.ts";
import { stepBladeburner } from "../../../shared/strategy/bladeburner/decide.ts";
import { successChance, type CrimeStats } from "../../../shared/strategy/career/crimes.ts";
import { stepCorp } from "../../../shared/strategy/corp/stages.ts";
import {
  DARKSCAPE_EARLY_BN1_ROUTE_SECONDS,
  DARKSCAPE_TOTAL_COST,
  stepDarkscape,
} from "../../../shared/strategy/dnet/unlock.ts";
import {
  augCost,
  isSoA,
  NEUROFLUX,
  nextPurchasableAugmentation,
  scoreAugMults,
  weightsFromMarginals,
} from "../../../shared/strategy/factions/augs.ts";
import { workRepPerSec, type WorkType } from "../../../shared/strategy/factions/rep.ts";
import { stepGang } from "../../../shared/strategy/gang/decide.ts";
import { goDemands } from "../../../shared/strategy/go/demand.ts";
import {
  goNeuralPositionIdentity,
  type GoWorkerPlaybookAction,
} from "../../../shared/strategy/go/neural/worker-protocol.ts";
import { GO_OPPONENT_MODEL } from "../../../shared/strategy/go/opponent.ts";
import { GO_REWARD_RULES, goFavorRepCap, rankGoGames, type GoRewardView } from "../../../shared/strategy/go/rewards.ts";
import { goRamPricingCandidate, planGoSchedule } from "../../../shared/strategy/go/schedule.ts";
import { GO_ENGINE_CYCLE_MS, goAiWaitMs } from "../../../shared/strategy/go/rng.ts";
import {
  applyGoCheat,
  GO_CHEAT_LIMITS_BY_SIZE,
  GO_OPPONENTS,
  GO_REWARD_OPPONENTS,
  territory as goTerritory,
  isGoCheatAction,
  isGoRewardOpponent,
  playMove,
  scoreBoard,
  type GoAction,
  type GoDecision,
  type GoObservedBoardSize,
  type GoPlayingAction,
  type GoRewardOpponent,
  type GoView,
} from "../../../shared/strategy/go/rules.ts";
import {
  GO_DISPATCH_GUARD_MS,
  goChooseSeedTarget,
  goDispatchLatency,
  goPhaseAgrees,
  goPredictedPlaytime,
  type GoSeedTarget,
  type GoTickPhase,
} from "../../../shared/strategy/go/tick.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import {
  countClosureAffordable,
  countSlotValueFor,
  fundedActivationBatch,
  routeCountVerdict,
} from "../../../shared/strategy/progression/activation.ts";
import { bankedFavorActivationValue, chooseNextBitNode, dwellInstallVerdict, INSTALL_VERDICT_OVERHEAD_SEC, installCadencePushRate, installCadenceRemainingSec, installVerdict, stepProgression } from "../../../shared/strategy/progression/decide.ts";
import { STALL_BITNODE_COMPLETION } from "../../../shared/strategy/progression/bitnode-order.ts";
import {
  DAEDALUS_COMBAT,
  daedalusAugsRequired,
  GANG_FACTIONS,
  GANG_KARMA,
  RED_PILL,
  stepEndgame,
  type EndgameView,
  type RouteId,
} from "../../../shared/strategy/progression/endgame.ts";
import {
  chooseRoute,
  FALLBACK_MONEY_PER_SEC,
  regrowInstallOverride,
  routeEtas,
  type RouteChoice,
  type RouteRates,
} from "../../../shared/strategy/progression/eta.ts";
import {
  forecastAt,
  IMMINENT_INSTALL_SEC,
  installForecast,
  installHorizonSec,
  nodeForecast,
  shouldReforecast,
  usableForecastSec,
  type PlanningHorizons,
} from "../../../shared/strategy/progression/forecast.ts";
import { progressionMarginals } from "../../../shared/strategy/progression/marginal.ts";
import {
  augmentationAcquisitionRate,
  cycleProgressExponent,
  retainCycleCurve,
  type AugmentationCycle,
  type CyclePoint,
} from "../../../shared/strategy/progression/regrowth.ts";
import { stepSleeves, type SleevesView, type SleeveTask } from "../../../shared/strategy/sleeves/decide.ts";
import { packFragments } from "../../../shared/strategy/stanek/pack.ts";
import type {
  GoActionDigest,
  GoPlan,
  GoTurnPrediction,
  GoResponse,
  GoTurnResult,
} from "../../../shared/telemetry/topics/go.ts";
import type { CrimeOption } from "../../../shared/telemetry/topics/career.ts";
import type { ProgressionPlan, RouteEtaDigest } from "../../../shared/telemetry/topics/progression.ts";
import { isScriptDeath } from "../errors.ts";
import { goNeuralWorkerRuntime, resetGoNeuralWorkerRuntime, type GoNeuralRuntime } from "../go-neural-worker.ts";
import { runGoNeuralSeedDispatch } from "../go-neural.ts";
import { priceCall } from "../ns-proxy.ts";
import { RESIDENT_BASE_GB } from "../../../shared/ram/broker.ts";
import { resetGateSignal, signalGateRecheck } from "../gate-signal.ts";
import { resetInstallSignal, takeInstallSignal } from "../install-signal.ts";
import { armSleeveCompletion, consumeSleeveCompletion, pendingSleeveCompletions, resetSleeveCompletions } from "../sleeve-completion.ts";
import { merge, set, type GameState } from "../state.ts";
import type { WorkTaskLike } from "../work-completion.ts";
import { dnetLabCacheDeferral } from "./dnet.ts";
import { liquidatableValue } from "./factions.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** Drivers for the features whose game-side work is a thin execution layer
 * over a pure strategy that lives in shared/strategy/.
 *
 * They share a file because they share a SHAPE, not because they are small:
 * build a view from the store, call one pure `step*`, execute at most one
 * action per tick through the ns proxy, and write the decision digest back. Any
 * one of them can move to its own file the moment it needs more than that —
 * `factions`, `career`, `hacknet`, `stock` and `dnet` already have. */

/** Go's pure ROI policy needs a cold estimate before a runtime request exists;
 * this is not used for broker sizing or placement. */
const GO_ESTIMATED_GB = 4;
// This is far beyond the useful portion of the rapidly decaying chance curve
// and keeps the worker independent of Netscript throughout practical games.
const GO_CHEAT_CHANCE_SAMPLES = 1_024;
const GO_MAX_FLEET_SHARE = 0.01;
/** A filler game must finish this comfortably inside the preferred entry
 * window — overrunning forfeits the aligned start and re-plans onto the next
 * recurrence of the route. */
const GO_FILLER_MARGIN = 1.25;
/** Reset dispatch plus first-turn planning allowance for a filler game. */
const GO_FILLER_OVERHEAD_SEC = 10;
const BLADES_SIMULACRUM = "The Blade's Simulacrum";
/** Slack over base + the priced call when clearing room for a world-ender, so
 * a rounding difference between our sum and the engine's does not leave the
 * cleared host one decimal short of the resident it was cleared for. */
const CRITICAL_HEADROOM_GB = 1;

type Result = { action: string; ok: boolean; detail: string; at: number } | undefined;
const results: Record<string, Result> = {};

function record(id: string, action: string, ok: boolean, detail: string): void {
  results[id] = { action, ok, detail, at: Date.now() };
}

function requireResult(id: string): NonNullable<Result> {
  const result = results[id];
  if (!result) throw new Error(`missing ${id} action result`);
  return result;
}

/** Clear room for a world-ender before the proxy asks for it.
 *
 * `installAugmentations` and `destroyW0r1dD43m0n` are the two calls priced far
 * above the resident's standing budget, so each forces a respawn onto a host
 * that fits base + the call. If the fleet has no such block the resident just
 * retries, and the run would sit there for ever waiting on a hacking farm that
 * is about to be soft-reset out of existence anyway. Killing workers to make
 * the room costs nothing at this exact moment, which is what `critical` meant
 * on the dodge this replaced. Best effort: the controller may not have
 * supplied the escape hatch, and the placer is free to find room elsewhere. */
function clearForCritical(ctx: DriverContext, path: string): void {
  ctx.freeCriticalRam?.(RESIDENT_BASE_GB + priceCall(path) + CRITICAL_HEADROOM_GB);
}

/** Run one feature action and record its outcome.
 *
 * The body reaches the game through `ctx.nsp` / `ctx.nspLong`, which price
 * and bill themselves (game/lib/ns-proxy.ts) — there is no budget to declare
 * here and nothing that can drift from the calls actually made. A `false`
 * return is an OUTCOME, never an exception; a throw is recorded as a failed
 * action so one refused call cannot take the controller down with it. */
async function act<T>(
  id: string,
  action: string,
  body: () => Promise<T>,
  describe: (value: T) => { ok: boolean; detail: string },
): Promise<T | undefined> {
  try {
    const value = await body();
    const { ok, detail } = describe(value);
    record(id, action, ok, detail);
    return value;
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    record(id, action, false, String(error));
  }
}

// --- gang -------------------------------------------------------------------

const gang: FeatureDriver = {
  id: "gang",
  everyMs: 10_000,
  requires: "gang",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.gang;
    if (!topic) return;

    const members = (topic.members ?? []).map((member) => ({
      name: member.name,
      task: member.task,
      skills: member.skills,
      ascMults: member.ascMults,
      earnedRespect: member.earnedRespect,
      upgrades: member.upgrades,
    }));
    // Task rates come from the game per member; without them the strategy
    // would be scoring invented numbers.
    const taskOptions = (member: (typeof members)[number]) =>
      (topic.taskRates?.[member.name] ?? []).map((rate) => ({
        name: rate.name,
        respectGain: rate.respect,
        moneyGain: rate.money,
        wantedGain: rate.wanted,
        training: rate.name.startsWith("Train"),
      }));

    const decision = stepGang({
      faction: topic.faction,
      isHacking: topic.isHacking,
      respect: topic.respect,
      wantedLevel: topic.wantedLevel,
      wantedPenalty: topic.wantedPenalty,
      territory: topic.territory,
      territoryClashChance: topic.territoryClashChance,
      territoryWarfareEngaged: topic.territoryWarfareEngaged,
      members,
      taskOptions,
      ascensionGain: (member) => topic.ascensionGain?.[member.name] ?? 0,
      respectForNextRecruit: topic.respectForNextRecruit,
      canRecruit: topic.canRecruit,
      clashChances: topic.clashChances ?? {},
      // Gang respect is the direct input to gang-faction reputation. When BN2
      // selected this route, make that terminal objective dominate equipment
      // money; on other routes retain the balanced standing policy.
      weights: ctx.route === "gang"
        ? { respect: 10, money: 1e-8 }
        : { respect: 1, money: 1e-6 },
    });

    merge(ctx.state, "gang", {
      plan: {
        actions: decision.actions.map((action) => ({
          type: action.type,
          ...("member" in action ? { member: action.member } : {}),
          ...("task" in action ? { task: action.task } : {}),
          ...("engage" in action ? { engage: action.engage } : {}),
        })),
        assignment: {
          total: decision.assignment.total,
          approximated: decision.assignment.approximated,
          choices: decision.assignment.choices.map((choice) => ({
            member: choice.agent.name,
            task: choice.task.name,
            score: choice.score,
          })),
        },
        ...(results["gang"] ? { lastResult: results["gang"] } : {}),
      },
    });

    const next = decision.actions.find((action) => action.type !== "idle");
    if (!next) return;
    await act(
      "gang",
      next.type,
      async () => {
        switch (next.type) {
          case "recruit":
            return await ctx.nsp("gang.recruitMember", `m-${Date.now() % 100000}`);
          case "assign":
            return await ctx.nsp("gang.setMemberTask", next.member, next.task);
          case "ascend":
            return await ctx.nsp("gang.ascendMember", next.member) !== undefined;
          case "warfare":
            await ctx.nsp("gang.setTerritoryWarfare", next.engage);
            return true;
          default:
            return false;
        }
      },
      (value) => ({ ok: Boolean(value), detail: Boolean(value) ? `${next.type} ok` : `${next.type} refused` }),
    );
  },
};

// --- corp -------------------------------------------------------------------

const corp: FeatureDriver = {
  id: "corp",
  everyMs: 30_000,
  requires: "corp",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.corp;
    if (!topic) return;
    const decision = stepCorp({
      hasCorporation: true,
      funds: topic.funds,
      revenue: topic.revenue,
      expenses: topic.expenses,
      public: topic.public,
      divisions: (topic.divisions ?? []).map((entry) => ({
        name: entry.name,
        industry: entry.industry,
        cities: entry.cities,
        researchPoints: entry.researchPoints,
        products: entry.products,
        maxProducts: entry.maxProducts,
        offices: entry.offices ?? [],
        warehouses: entry.warehouses ?? [],
      })),
      ...(topic.investmentOffer ? { investmentOffer: topic.investmentOffer } : {}),
      moneyGranted: ctx.grants.money,
    });

    merge(ctx.state, "corp", {
      plan: {
        action: {
          type: decision.action.type,
          ...(decision.action.type === "expandIndustry" ? { industry: decision.action.industry, division: decision.action.division } : {}),
          ...("division" in decision.action ? { division: decision.action.division } : {}),
          ...("city" in decision.action ? { city: decision.action.city } : {}),
          ...("size" in decision.action ? { size: decision.action.size } : {}),
          ...("job" in decision.action ? { job: decision.action.job } : {}),
          ...("material" in decision.action ? { material: decision.action.material } : {}),
          ...("round" in decision.action ? { round: decision.action.round } : {}),
          ...("name" in decision.action ? { name: decision.action.name } : {}),
        },
        stage: decision.stage,
        completed: decision.completed,
        ...(results["corp"] ? { lastResult: results["corp"] } : {}),
      },
    });
    // Execution of the corporation API is deliberately not wired yet: every
    // stage's action is a distinct multi-argument call, and issuing them
    // against an unmodelled world would be the one thing this project refuses
    // to do. The stage machine and its digest are testable without it.
    record("corp", decision.action.type, false, "corporation actions are not executed yet (see spec/progress.md)");
  },
};

// --- bladeburner ------------------------------------------------------------

const bladeburner: FeatureDriver = {
  id: "bladeburner",
  everyMs: 5_000,
  requires: "bladeburner",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.bladeburner;
    if (!topic) return;
    const decision = stepBladeburner({
      rank: topic.rank,
      skillPoints: topic.skillPoints,
      stamina: topic.stamina,
      city: topic.city,
      chaos: topic.cities?.find((city) => city.name === topic.city)?.chaos ?? 0,
      actions: (topic.actions ?? []).map((action) => ({
        type: action.type as "general" | "contract" | "operation" | "blackop",
        name: action.name,
        chance: action.chance,
        timeMs: action.timeMs,
        countRemaining: action.countRemaining ?? Infinity,
        level: action.level ?? 1,
        // v3.0.1 exposes the level-adjusted base rank gain directly; action
        // completion applies its random offset around that base.
        // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L165-L171
        rankGain: action.rankGain ?? 0,
        rankLoss: action.rankLoss ?? 0,
        ...(action.rankNeeded !== undefined ? { rankNeeded: action.rankNeeded } : {}),
      })),
      skills: topic.skills ?? {},
      ...(topic.current ? { current: { type: topic.current.type, name: topic.current.name } } : {}),
    });

    merge(ctx.state, "bladeburner", {
      plan: {
        action: {
          type: decision.action.type,
          ...(decision.action.type === "act" ? { actionType: decision.action.actionType, name: decision.action.name } : {}),
          ...(decision.action.type === "upgrade" ? { skill: decision.action.skill } : {}),
        },
        ranked: decision.ranked.slice(0, 8).map((entry) => ({
          name: entry.name,
          actionType: entry.actionType,
          rankPerSec: entry.rankPerSec,
          chanceLow: entry.chanceLow,
        })),
        ...(results["bladeburner"] ? { lastResult: results["bladeburner"] } : {}),
      },
    });

    if (decision.action.type === "continue") return;
    const hasSimulacrum = (ctx.state.topics.progression?.ownedAugs?.[BLADES_SIMULACRUM] ?? 0) > 0;
    if (decision.action.type === "act" && !hasSimulacrum && !ctx.grants.slot) {
      // Starting a Bladeburner action cancels Player.currentWork unless the
      // installed Blade's Simulacrum exempts it. Wait for the arbiter's slot.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Bladeburner/Bladeburner.ts#L173-L182
      record("bladeburner", "act", false, "waiting for Player.currentWork slot");
      return;
    }
    await act(
      "bladeburner",
      decision.action.type,
      async () => {
        const action = decision.action;
        if (action.type === "stop") {
          // Stopping is a separate API call; merely declining to start a new
          // action leaves the current Bladeburner action running.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L108-L124
          await ctx.nsp("bladeburner.stopBladeburnerAction");
          return true;
        }
        if (action.type === "upgrade") return await ctx.nsp("bladeburner.upgradeSkill", action.skill as never, 1);
        if (action.type === "act") {
          return await ctx.nsp("bladeburner.startAction", action.actionType as never, action.name as never);
        }
        return false;
      },
      (value) => ({ ok: Boolean(value), detail: Boolean(value) ? "started" : "refused" }),
    );
  },
};

// --- sleeves ----------------------------------------------------------------

export function sleeveView(state: GameState): SleevesView | undefined {
  const topic = state.topics.sleeves;
  if (!topic) return undefined;
  const completed = pendingSleeveCompletions();
  const sleeves = (topic.sleeves ?? []).map((sleeve) => ({
    index: sleeve.index,
    shock: sleeve.shock,
    sync: sleeve.sync,
    city: sleeve.city,
    skills: sleeve.skills as unknown as Record<string, number>,
    ...(sleeve.task
      ? {
          task: {
            type: sleeve.task.type,
            detail: sleeve.task.detail,
            ...(sleeve.task.workType !== undefined ? { workType: sleeve.task.workType } : {}),
          },
        }
      : {}),
    ...(completed.has(sleeve.index) ? { allowCrimeSwitch: true } : {}),
  }));
  const progression = state.topics.progression;
  const node = effectiveBitNodeMultipliers(
    progression?.bitNode,
    sfLevel(progression?.sourceFiles, 12),
    progression?.multipliers,
  ) ?? {};
  const playerMults = (state.topics.player?.mults ?? {}) as unknown as Record<string, number>;
  // This per-run option zeros every sleeve experience field in
  // calculateCrimeWorkStats/calculateFactionExp, but leaves money, reputation,
  // karma, and kills intact.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Formulas.ts#L24-L35
  const sleeveExpEnabled = state.topics.capabilities?.restrictions.disableSleeveExpAndAugmentation !== true;
  const crimes = state.topics.career?.crimes ?? [];
  const tasks: SleeveTask[] = [
    { type: "recovery", outcomes: [{ rates: {}, moneyPerSec: 0 }] },
    { type: "synchro", outcomes: [{ rates: {}, moneyPerSec: 0 }] },
  ];
  for (const crime of crimes) {
    // getCrimeStats replaces the base money/experience with gains calculated
    // for the current PLAYER. Undo those factors before applying each sleeve's
    // own multipliers; otherwise player augmentations are counted once and
    // sleeve augmentations a second time.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L1068-L1090
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Formulas.ts#L58-L79
    const baseGain = (value: number, factor: number): number =>
      crime.gainsAreEffective ? (factor > 0 ? value / factor : 0) : value;
    const baseMoney = baseGain(
      crime.money,
      (playerMults["crime_money"] ?? 1) * (node["CrimeMoney"] ?? 1),
    );
    const baseExp = Object.fromEntries(Object.entries(crime.exp ?? {}).map(([skill, value]) => [
      skill,
      baseGain(
        value,
        (skill === "intelligence" ? 1 : (playerMults[`${skill}_exp`] ?? 1)) * (node["CrimeExpGain"] ?? 1),
      ),
    ]));
    const outcomes = (topic.sleeves ?? []).map((sleeve) => {
      const mults = sleeve.mults ?? {};
      const stats: CrimeStats = {
        type: crime.name,
        timeMs: crime.timeMs,
        money: baseMoney,
        difficulty: crime.difficulty ?? 1,
        karma: Math.abs(crime.karma),
        kills: crime.kills ?? 0,
        weights: crime.weights ?? {},
        exp: baseExp,
      };
      const chance = successChance(
        stats,
        { skills: sleeve.skills as unknown as Record<string, number>, mults: { crime_success: mults["crime_success"] ?? 1, crime_money: mults["crime_money"] ?? 1 } },
        { crimeSuccessRate: node["CrimeSuccessRate"] ?? 1, crimeMoney: node["CrimeMoney"] ?? 1 },
      );
      const seconds = crime.timeMs / 1_000;
      const sync = sleeve.sync / 100;
      const expectedExp = 0.25 + 0.75 * chance;
      const exp = baseExp;
      const expRate = (skill: string): number =>
        sleeveExpEnabled
          ? expectedExp * sync * (exp[skill] ?? 0) * (mults[`${skill}_exp`] ?? 1) * (node["CrimeExpGain"] ?? 1) / seconds
          : 0;
      const rates = {
        combatSkills: Math.min(expRate("strength"), expRate("defense"), expRate("dexterity"), expRate("agility")),
        charisma: expRate("charisma"),
      };
      const contributions = Object.keys(exp)
        .map((skill) => ({ kind: "skill" as const, subject: skill, perSec: expRate(skill) }))
        .filter((entry) => entry.perSec > 0);
      // SleeveCrimeWork changes karma/kills directly. Neither is multiplied by
      // shock; karma is multiplied by sync, while kills are not.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts#L37-L50
      const shockExemptRates = {
        karma: chance * Math.abs(crime.karma) * sync / seconds,
        kills: chance * (crime.kills ?? 0) / seconds,
      };
      // Outcomes are deliberately pre-shock: stepSleeves applies shock once
      // while comparing every task. SleeveCrimeWork shocks these WorkStats
      // before paying them, while only karma/kills bypass that scaling.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts#L31-L50
      const moneyPerSec = chance * baseMoney * (mults["crime_money"] ?? 1) * (node["CrimeMoney"] ?? 1) / seconds;
      return { sleeve: sleeve.index, rates, contributions, shockExemptRates, moneyPerSec };
    });
    tasks.push({
      type: "crime",
      detail: crime.name,
      outcomes,
    });
  }

  // The current faction reputation breakpoint is an outcome sleeves can
  // advance in parallel with Player.currentWork. Each faction is capacity-one
  // in the game, while crime remains freely repeatable across sleeves.
  const factionTopic = state.topics.factions;
  const repTarget = factionTopic?.plan?.until;
  if (repTarget?.kind === "rep" && repTarget.faction && factionTopic?.joined.includes(repTarget.faction)) {
    const standing = factionTopic.standings?.find((entry) => entry.name === repTarget.faction);
    const offered = factionTopic.workTypes?.[repTarget.faction] ?? [];
    const sourceFiles = state.topics.progression?.sourceFiles ?? {};
    for (const workType of ["hacking", "field", "security"] as const) {
      if (!offered.includes(workType)) continue;
      const outcomes = (topic.sleeves ?? []).map((sleeve) => {
        const mults = sleeve.mults ?? {};
        const contributions = [{
          kind: "factionRep" as const,
          subject: repTarget.faction,
          // Outcomes are pre-shock; stepSleeves applies the exact shock factor
          // once. Sleeve faction reputation is not scaled by sync.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveFactionWork.ts#L30-L38
          perSec: workRepPerSec(
            workType as WorkType,
            {
              skills: {
                hacking: sleeve.skills.hacking,
                strength: sleeve.skills.strength,
                defense: sleeve.skills.defense,
                dexterity: sleeve.skills.dexterity,
                agility: sleeve.skills.agility,
                charisma: sleeve.skills.charisma,
                intelligence: sleeve.skills.intelligence ?? 0,
              },
              mults: { faction_rep: mults["faction_rep"] ?? 1 },
            },
            standing?.favor ?? 0,
            {
              factionWorkRepGain: node["FactionWorkRepGain"] ?? 1,
              shareBonus: state.topics.fleet?.sharePower ?? 1,
              sf15Level: sfLevel(sourceFiles, 15),
              hasFocusAug: true,
            },
            true,
          ),
        }];
        return { sleeve: sleeve.index, rates: {}, contributions, moneyPerSec: 0 };
      });
      tasks.push({
        type: "faction",
        detail: repTarget.faction,
        workType,
        exclusiveKey: `faction:${repTarget.faction}`,
        outcomes,
      });
    }
  }
  return { sleeves, tasks, shockCeiling: 50, syncFloor: 50 };
}

const sleeves: FeatureDriver = {
  id: "sleeves",
  everyMs: 30_000,
  wake: () => pendingSleeveCompletions().size > 0,
  requires: "sleeves",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.sleeves;
    const view = sleeveView(ctx.state);
    if (!topic || !view) return;
    const decision = stepSleeves(view, ctx.board);

    merge(ctx.state, "sleeves", {
      plan: {
        assignments: decision.assignments.map((entry) => ({
          index: entry.index,
          task: `${entry.task.type}${entry.task.detail ? `:${entry.task.detail}` : ""}${entry.task.workType ? `:${entry.task.workType}` : ""}`,
        })),
        selection: decision.assignment.choices.map((entry) => ({
          index: entry.agent.index,
          task: `${entry.task.type}${entry.task.detail ? `:${entry.task.detail}` : ""}${entry.task.workType ? `:${entry.task.workType}` : ""}`,
          score: entry.score,
        })),
        totalScore: decision.assignment.total,
        ...(results["sleeves"] ? { lastResult: results["sleeves"] } : {}),
      },
    });

    const completed = [...pendingSleeveCompletions()];
    if (decision.assignments.length === 0 && completed.length === 0) return;

    // Plain sequential setters. These used to be grouped by task type and
    // split across one dodge per group, because a stub had to be allocated for
    // the SUM of its calls and a six-type batch demanded 4x(6+1) + 2.1 =
    // 30.1 GB of contiguous RAM on one host. The resident prices each call for
    // itself and recycles when it must, so the peak is one sleeve call and the
    // grouping bought nothing.
    //
    // The setters are independent writes on distinct sleeve indices; the
    // getTask pass is a read-back that arms completions — sleeves.core performs
    // the identical read every 30 s — not an atomicity requirement.
    const changed: number[] = [];
    for (const next of decision.assignments) {
      let ok = false;
      if (next.task.type === "recovery") ok = await ctx.nsp("sleeve.setToShockRecovery", next.index);
      else if (next.task.type === "synchro") ok = await ctx.nsp("sleeve.setToSynchronize", next.index);
      else if (next.task.type === "crime") ok = await ctx.nsp("sleeve.setToCommitCrime", next.index, next.task.detail as never);
      else if (next.task.type === "gym") {
        ok = await ctx.nsp("sleeve.setToGymWorkout", next.index, "Powerhouse Gym" as never, next.task.detail as never);
      } else if (next.task.type === "class") {
        ok = await ctx.nsp("sleeve.setToUniversityCourse", next.index, "Rothman University" as never, next.task.detail as never);
      } else if (next.task.type === "faction") {
        ok = Boolean(await ctx.nsp("sleeve.setToFactionWork", next.index, next.task.detail as never, next.task.workType as never));
      }
      if (ok) changed.push(next.index);
    }
    // A sleeve the game refused stays on its previous task and is retried next
    // pass; the ones that did land are still worth reading back.
    const refused = decision.assignments.length - changed.length;

    const observed = new Map<number, { type: string; detail?: string; workType?: string } | undefined>();
    for (const sleeve of topic.sleeves ?? []) {
      const task = await ctx.nsp("sleeve.getTask", sleeve.index) as (WorkTaskLike & Record<string, unknown>) | null;
      armSleeveCompletion(sleeve.index, task);
      if (!task) observed.set(sleeve.index, undefined);
      else {
        const detail = task.factionName ?? task.companyName ?? task.crimeType ?? task.classType;
        observed.set(sleeve.index, {
          type: String(task.type),
          ...(detail !== undefined ? { detail: String(detail) } : {}),
          ...(task.factionWorkType !== undefined ? { workType: String(task.factionWorkType) } : {}),
        });
      }
    }
    for (const index of completed) consumeSleeveCompletion(index);
    merge(ctx.state, "sleeves", {
      sleeves: (topic.sleeves ?? []).map((sleeve) => {
        const task = observed.get(sleeve.index);
        return task === undefined ? { ...sleeve, task: undefined } : { ...sleeve, task };
      }),
    });
    results["sleeves"] = {
      action: "batch",
      ok: refused === 0,
      detail: refused === 0
        ? `updated ${changed.length} sleeves`
        : `updated ${changed.length} sleeves; the game refused ${refused} assignments`,
      at: Date.now(),
    };
  },
};

// --- go ---------------------------------------------------------------------

function goActionDigest(action: GoAction): GoActionDigest {
  switch (action.type) {
    case "move": return { type: action.type, x: action.x, y: action.y };
    case "cheatTwoMoves": return {
      type: action.type, x1: action.x1, y1: action.y1, x2: action.x2, y2: action.y2,
    };
    case "cheatRemoveRouter":
    case "cheatDestroyNode":
    case "cheatRepairNode": return { type: action.type, x: action.x, y: action.y };
    case "newGame": return { type: action.type, opponent: action.opponent, boardSize: action.boardSize };
    case "pass":
    case "resume": return { type: action.type };
  }
}

export function goFactionFavor(ctx: DriverContext): GoRewardView["factionFavor"] {
  const result: GoRewardView["factionFavor"] = {};
  const joined = new Set(ctx.state.topics.factions?.joined ?? []);
  // The committed intent is the only concurrent faction farm, but favor
  // persists through installs, so its value is ALSO the reachable ladder
  // work over the remaining node (favorValue model) — including the
  // donation-gate crossing. Without the node-scoped term, an imminent
  // install priced every favor event at zero and Go idled on a finished
  // board (screenshot 2026-08-18).
  const intent = ctx.state.topics.factions?.plan?.objective?.intent;
  // READ, do not recompute. Deriving this here meant rebuilding the whole
  // augmentation catalogue and re-walking every joined faction's rep ladder
  // on each five-second Go tick; the factions driver publishes the same
  // numbers as a by-product of the view it already builds.
  const pointValues = ctx.state.topics.factions?.favorPointValues;
  const standings = new Map((ctx.state.topics.factions?.standings ?? []).map((standing) => [standing.name, standing]));
  for (const opponent of GO_OPPONENTS) {
    if (!joined.has(opponent)) continue;
    const standing = standings.get(opponent);
    if (!standing) continue;
    const pointValue = pointValues?.[opponent];
    result[opponent] = {
      favor: standing.favor,
      remainingWorkSec: Math.max(
        intent?.faction === opponent ? Math.max(0, intent.repSec) : 0,
        pointValue?.remainingWorkSec ?? 0,
      ),
      ...(pointValue
        ? { pointValue: { donationUnlockSec: pointValue.donationUnlockSec, donateThreshold: pointValue.donateThreshold } }
        : {}),
    };
  }
  return result;
}

function observedGoBoardSize(board: readonly string[]): GoObservedBoardSize {
  const size = board.length;
  if ((size !== 5 && size !== 7 && size !== 9 && size !== 13 && size !== 19)
    || board.some((column) => column.length !== size)) {
    throw new Error(`unexpected Go reset board dimensions ${size}x${board[0]?.length ?? 0}`);
  }
  return size;
}

type RawGoResponse = Awaited<ReturnType<NS["go"]["makeMove"]>>;
type GoActionOutcome = {
  response?: RawGoResponse;
  player?: ReturnType<NS["getPlayer"]>;
  playerObservedAt?: number;
  action?: GoPlayingAction;
  decision?: GoDecision;
  prediction?: GoTurnPrediction;
  predictionParentId?: string;
  responseReadyAt?: number;
};

function normalizeGoResponse(response: RawGoResponse): GoResponse {
  if (response.type === "move") {
    if (response.x === null || response.y === null) throw new Error("Go move response omitted its coordinates");
    return { type: "move", x: response.x, y: response.y };
  }
  if (response.x !== null || response.y !== null) throw new Error(`Go ${response.type} response carried coordinates`);
  return { type: response.type, x: null, y: null };
}

/** Successful turns chain immediately; five seconds is the failure retry. */
let goContinuationReady = false;
let goCompletionReady = false;
let goTurnRunning = false;
/** Planning is asynchronous (including the GPU batch), so the
 * turn-running flag alone no longer covers the whole tick: a controller-cadence
 * pass can arrive while the detached continuation is still preparing. Two
 * concurrent planners would interleave into the engine's single packing buffer
 * and dispatch two turns for one position. */
let goPlanning = false;
let goGeneration = 0;
/** Large worker-only chance table. Keeping it out of the telemetry topic avoids
 * sending 1,024 redundant values on every Go update. */
let goCheatSuccessByCount: number[] | undefined;
/** Parent commit accepted by the worker for the board expected on the next
 * Black turn. A mismatching public board falls back to a full install. */
let goPredictionParent: string | undefined;
/** Exact on chained turns (the opponent promise resolution); cold starts use
 * the first actionable Black-turn observation. */
let goTurnReadyAt: number | undefined;

/** Certified playbook lines in live play.
 *
 * The playbook is consulted for every 5x5 opponent it covers: a certified hit
 * is a proven move and a miss costs one table lookup, so mid-game consultation
 * is free upside (measured: never below the neural baseline, +3 games for
 * Tetrads).
 *
 * `maxWaitPhases` is separate and expensive. A certified line is only entered
 * from a phase-aligned game start, so the controller must defer the game until
 * the route's entry phase, playing no Go at all meanwhile. That is worth doing
 * only where the certified line beats ordinary neural play by enough to pay
 * for the wait. Per-opponent results from one 3,072-game combined arena
 * (2026-08-18, `go:combined:arena --games 3072 --unrouted-baseline`, 512 games
 * each), certified-root routing versus the neural baseline on ordinary phases:
 *
 * | Opponent | routed line | neural, unrouted |
 * |---|---:|---:|
 * | Illuminati | 505/512 | 364/512 |
 * | Tetrads | 512/512 | 487/512 |
 * | Daedalus | 512/512 | 490/512 |
 * | The Black Hand | 512/512 | 507/512 |
 * | Netburners | 512/512 | 511/512 |
 * | Slum Snakes | 512/512 | 511/512 |
 *
 * So Illuminati justifies a long wait, Daedalus and Tetrads a short one, and
 * the remaining three justify none — their certified lines win no games the
 * network does not already win.
 *
 * Cheat-unlocked games always consult the playbook now, with the certified
 * move overriding an engine cheat by default: the 2026-08-22 combined arena
 * (512 games/arm, installed merged playbook, random timing) measured
 * playbook-with-off-line-cheats at 500/512 for Illuminati against 466/512
 * (91.0%) for the pure neural+cheat play cheat games used to fall back to.
 *
 * `cheatSeedFromTurn` additionally allows the engine, from that Black turn
 * on, to play a double-move cheat whose first stone is the certified move —
 * deliberately leaving the line (fully neural afterwards). Same runs:
 *
 * | Opponent | combined (no cheat) | off-line cheats | seeded from 0 |
 * |---|---:|---:|---:|
 * | Illuminati | 504/512, 31.1 pw/turn | 500/512, 32.9 | 468/512, 29.2 |
 * | Daedalus | 512/512, 5.90 | 504/512, 5.93 | 511/512, 7.34 |
 * | Tetrads | 512/512, 5.82 | 508/512, 6.21 | 512/512, 7.69 |
 *
 * Seeding always pays for Daedalus/Tetrads (+24%/+32% node power per turn at
 * no win cost) and hurts Illuminati, whose neural baseline is too weak to
 * leave the certified line early. Delaying Illuminati's seeding was benched
 * too (same corpus, `--cheat-late`): from turn 4 still loses (477/512), and
 * from turn 8 (499/512, 32.98 pw/turn) is statistically identical to never
 * seeding (500/512, 32.89) — the line is spent by then — so Illuminati keeps
 * no threshold. Set one only where an arena run justifies it, recording the
 * run here. */
const GO_PLAYBOOK_OPPONENTS: Readonly<Record<string, {
  maxWaitPhases: number;
  /** Black turn index from which an on-line cheat may be seeded from the
   * certified move; absent = never seed (certified always overrides). */
  cheatSeedFromTurn?: number;
}>> = {
  Illuminati: { maxWaitPhases: 5_000 },
  Daedalus: { maxWaitPhases: 900, cheatSeedFromTurn: 0 },
  Tetrads: { maxWaitPhases: 900, cheatSeedFromTurn: 0 },
  "The Black Hand": { maxWaitPhases: 0 },
  Netburners: { maxWaitPhases: 0 },
  "Slum Snakes": { maxWaitPhases: 0 },
};
/** Proceed with the aligned reset once the route entry is this close: the
 * remaining seconds are absorbed tick-exactly by the first move's dispatch
 * target. Must exceed the driver's 5 s go cadence so an approaching window
 * cannot fall between two passes, and cover reset plus first-turn planning. */
const GO_PLAYBOOK_START_SLACK_PHASES = 30;
/** A certified sleep longer than this abandons the line instead of holding
 * the controller's turn loop mid-game. */
const GO_PLAYBOOK_MAX_SLEEP_PHASES = 25;
/** Alignment credit for the certified line of the active game (mirrors the
 * standalone combined driver's per-game credit). */
let goPlaybookCredit = 0;
/** Credit grant that becomes effective once the engine clock reaches the
 * given tick — the controller-shaped form of the standalone driver sleeping
 * an align/sleep entry before continuing the line. */
let goPlaybookPendingCredit: { atPlaytime: number; credit: number } | undefined;
/** Committed phase-aligned game start; consumed by the first Black move. */
let goPlaybookEntry: { opponent: string; entryPlaytime: number } | undefined;

function resetGoPlaybookLine(): void {
  goPlaybookCredit = 0;
  goPlaybookPendingCredit = undefined;
}

type GoPlaybookMoveOrPass = { type: "move"; x: number; y: number } | { type: "pass" };

/** Precedence between the exact neural decision and the certified playbook
 * action for the same tick. When the evaluation was SEEDED (the certified
 * move rode in as the double-move's first stone), an engine-chosen cheat
 * wins: by construction it beat the force-retained certified move
 * head-to-head in the same value batch, and it deliberately leaves the
 * certified line. On an unseeded evaluation the certified action overrides
 * everything — including an engine cheat, which would derail the line with
 * nothing banked (measured 2026-08-22: 91.0% for cheat-first Illuminati
 * against 97.7% certified-first). `seeded` therefore means the evaluation was
 * ASKED to seed AND the engine did not report the benchmark dropped
 * (decision.preferredFirstMoveRetained !== false): a cheat from an evaluation
 * whose certified benchmark never competed must not displace the certified
 * move. The provisional path and the seed-exact dispatch path MUST both route
 * through this helper, or the published plan digest and the dispatched action
 * could diverge. */
function resolveGoExactAction(
  exact: GoAction,
  playbookAction: GoPlaybookMoveOrPass | undefined,
  seeded: boolean,
): GoAction {
  return seeded && isGoCheatAction(exact) ? exact : playbookAction ?? exact;
}

/** The certified playbook lookup's action in the driver's move/pass shape;
 * align/sleep (and misses) carry no dispatchable move. Shared by the
 * provisional and seed-exact dispatch paths so the two cannot drift. */
function goPlaybookMoveOrPass(action: GoWorkerPlaybookAction | undefined): GoPlaybookMoveOrPass | undefined {
  return action?.kind === "move"
    ? { type: "move", x: action.x, y: action.y }
    : action?.kind === "pass"
      ? { type: "pass" }
      : undefined;
}

/** The certified move rides into the evaluation only from the opponent's
 * cheatSeedFromTurn threshold on: it seeds the double-move family's first
 * stone and forces the plain certified move into the value batch as the
 * benchmark the seeded cheat has to beat. Below the threshold (or with none)
 * the evaluation is unseeded and the certified move overrides whatever the
 * engine picks. Shared by both dispatch paths so the gate cannot drift. */
function goCheatSeedMove(
  view: GoView,
  playbookAction: GoPlaybookMoveOrPass | undefined,
  cheatSeedTurn: number | undefined,
): { x: number; y: number } | undefined {
  return view.cheat?.unlocked === true
    && playbookAction?.type === "move"
    && cheatSeedTurn !== undefined
    && goBlackTurnIndex(view) >= cheatSeedTurn
    ? { x: playbookAction.x, y: playbookAction.y }
    : undefined;
}

/** Black turn index of the current decision: the move history holds one
 * entry per move and Black moves first, so k full Black/White rounds leave
 * 2k entries. Cheats record no history, but the index only gates seeding
 * while the game is still ON the certified line, where every prior turn was
 * an ordinary move. Passes record no history either, so a line containing a
 * pass makes this a LOWER bound on the true Black turn — seeding then starts
 * late, never early, which is the safe direction for a threshold. */
function goBlackTurnIndex(view: GoView): number {
  return Math.floor(view.previousBoards.length / 2);
}

/** The held board is a LOCAL SIMULATION, advanced by applying our move and the
 * AI's reply with this repo's own rules. It is trustworthy only between the
 * moment the game's own rows were read and the moment we dispatch the next
 * board-changing call.
 *
 * SET AT DISPATCH, cleared only by proof (the post-turn verification), a
 * rebuild (hydrate), or an authoritative rows return (resetBoardState). That
 * ordering is the whole design: every way a turn can fail after the call was
 * issued — a refusal, a rules-drift throw, an unsettled lane promise, a
 * resident recycled after makeMove already resolved in-game — leaves this set,
 * so the next pass rebuilds. None of them is classified by its error text, because the last
 * of them records no text at all. */
let goRehydrate = false;
let goRehydrateReason: string | undefined;

function invalidateGoMirror(reason: string): void {
  goRehydrate = true;
  goRehydrateReason = reason;
}

const GO_DISPATCH_UNMERGED = "a turn was dispatched and its outcome never merged";

let testGoRuntime: GoNeuralRuntime | undefined;

function goNeuralRuntime(): GoNeuralRuntime {
  return testGoRuntime ?? goNeuralWorkerRuntime();
}

/** Replace the browser worker only for Bun controller/simulator tests. The
 * production bundle imports no direct V9 engine or model weights on the main
 * thread; those exist solely inside the embedded worker source. */
export function setGoNeuralRuntimeForTest(runtime?: GoNeuralRuntime): void {
  if (typeof Bun === "undefined") throw new Error("Go backend test injection is only available under Bun");
  testGoRuntime?.dispose();
  testGoRuntime = runtime;
}

export function setGoCheatSuccessTableForTest(chances?: number[]): void {
  if (typeof Bun === "undefined") throw new Error("Go cheat test injection is only available under Bun");
  goCheatSuccessByCount = chances;
}

let goPlaybookCheatSeedOverride: Readonly<Record<string, number>> | undefined;

export function setGoPlaybookCheatSeedForTest(overrides?: Record<string, number>): void {
  if (typeof Bun === "undefined") throw new Error("Go playbook test injection is only available under Bun");
  goPlaybookCheatSeedOverride = overrides;
}

/** Black turn index from which this opponent's certified move may seed a
 * double-move cheat, or undefined when the certified move always overrides. */
function goPlaybookCheatSeedFromTurn(opponent: string): number | undefined {
  return goPlaybookCheatSeedOverride?.[opponent]
    ?? GO_PLAYBOOK_OPPONENTS[opponent]?.cheatSeedFromTurn;
}

/** Wall-clock anchor for the 200 ms engine cycle, established by observing a
 * totalPlaytime transition. Held across turns: one observation keeps the phase
 * known for as long as the browser advances time normally. */
let goTickPhase: GoTickPhase | undefined;

/** Sampling period for the anchoring poll. Two milliseconds matches the final
 * read-to-call guard without busy-waiting. */
export const GO_ANCHOR_POLL_MS = 2;

/** A game that is paused or hard-throttled never rolls over, and retrying a
 * full-cycle poll every turn would spend most of a cycle on it each time. */
const GO_ANCHOR_RETRY_MS = 30_000;
let goAnchorFailedAt = 0;

/** Observe one engine-cycle rollover.
 *
 * Nothing but `getPlayer` is called: the reads are cheap, and the resident
 * pays for that member once however many times the loop polls. All the waiting
 * is realm timer, never `ns.sleep`, so a poll that spans most of a 200 ms
 * cycle holds no Netscript call open while it waits. */
async function observeGoTickPhase(
  readPlayer: () => Promise<ReturnType<NS["getPlayer"]>>,
): Promise<GoTickPhase | undefined> {
  const initial = (await readPlayer()).totalPlaytime;
  const attempts = Math.ceil(GO_ENGINE_CYCLE_MS / GO_ANCHOR_POLL_MS) + 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await realmSleep(GO_ANCHOR_POLL_MS);
    const playtime = (await readPlayer()).totalPlaytime;
    if (playtime !== initial) return { wallAt: Date.now(), playtime };
  }
  // A paused or heavily throttled game never rolls over; report failure and
  // let the caller fall back to dispatching against the current tick.
  return undefined;
}

function sameGoPosition(plan: GoPlan | undefined, topic: NonNullable<GameState["topics"]["go"]>): boolean {
  if (!plan || plan.input.status !== topic.status || plan.input.currentPlayer !== topic.currentPlayer) return false;
  return plan.input.board.length === topic.board?.length
    && plan.input.board.every((column, index) => column === topic.board?.[index]);
}

function goCheatUnlocked(caps: DriverContext["caps"]): boolean {
  const level = sfLevel(caps.sourceFiles, 14);
  return level > 1 || (caps.bitNode === 14 && level === 1);
}

/** The lifecycle transition the CURRENT public board calls for, independent of
 * the stored plan — so a freshly completed promise can act immediately even
 * though `topic.plan` still describes the preceding turn.
 *
 * Exported for tests: it is pure, and the alternative is asserting on it
 * through a whole detached turn. */
export function goClaimAction(state: GameState, caps: DriverContext["caps"]): GoAction["type"] | "hydrate" | undefined {
  const topic = state.topics.go;
  if (!topic?.status || !topic.currentPlayer) return undefined;
  // goRehydrate first: an unproven mirror must be rebuilt before it is
  // planned on, and the claim has to be sized for the read that will happen.
  if (goRehydrate || !topic.board || !topic.previousBoards || (goCheatUnlocked(caps) && (!topic.cheat || !goCheatSuccessByCount))) return "hydrate";
  if (topic.status === "gameOver" || topic.currentPlayer === "None") return "newGame";
  if (topic.currentPlayer !== "Black") return "resume";
  if (sameGoPosition(topic.plan, topic)) {
    const planned = topic.plan!.action.type;
    if (planned === "move" || planned === "pass" || planned === "newGame" || planned.startsWith("cheat")) return planned;
  }
  return topic.board.some((column) => column.includes(".")) ? "move" : "pass";
}

/** Finish active games, but start Go only when its fixed RAM cost is small
 * relative to the fleet. GoPower and SF14 scale the admission threshold.
 * Exported for tests, as `goClaimAction` is. */
export function goActionAdmitted(state: GameState, caps: DriverContext["caps"]): boolean {
  const topic = state.topics.go;
  if ((topic?.previousBoards?.length ?? 0) > 0 && topic?.status !== "gameOver") return true;
  const pie = state.topics.farm?.ramPie;
  if (!pie) return false;
  const usableGb = pie.farm + pie.prep + pie.share + pie.free + pie.reserve;
  const nodeMults = effectiveBitNodeMultipliers(
    caps.bitNode,
    sfLevel(caps.sourceFiles, 12),
    state.topics.progression?.multipliers,
  );
  const rewardScale = (nodeMults?.GoPower ?? 1) * (sfLevel(caps.sourceFiles, 14) > 0 ? 2 : 1);
  // Same displacement pricing as goGamePaysForRam: a resident the free arena
  // can absorb outright costs the fleet nothing, so admission never blocks it.
  const displacedGb = Math.max(0, GO_ESTIMATED_GB - pie.free);
  return usableGb > 0 && displacedGb / usableGb <= GO_MAX_FLEET_SHARE * rewardScale;
}

/** A Go candidate reports route-seconds saved per second spent playing. Its
 * opportunity cost is the fraction of productive fleet RAM the fixed Go
 * allocation actually DISPLACES: RAM the farm was going to use. Free arena RAM displaces
 * nothing, so with idle capacity any positive utility plays — pricing idle
 * gigabytes at full farm throughput zeroed Go out in exactly the windows
 * (node tail, saturated farm) where a marginal 0.5s was still free money.
 * This stays a marginal test: an asymptotically positive bonus does not
 * justify playing forever once its next increment is smaller than the
 * throughput it genuinely displaces. */
export function goGamePaysForRam(utilityPerSec: number, usableGb: number, freeGb = 0): boolean {
  if (!(utilityPerSec > 0) || !(usableGb > 0)) return false;
  const displacedGb = Math.max(0, GO_ESTIMATED_GB - Math.max(0, freeGb));
  return utilityPerSec > displacedGb / usableGb;
}

const go: FeatureDriver = {
  id: "go",
  everyMs: 5_000,
  wake: () => goContinuationReady || goCompletionReady,
  requires: "go",
  tick(ctx: DriverContext) {
    // Go is a self-contained asynchronous lifecycle. The controller's only
    // responsibility is to start (or poke) that lifecycle; it must never wait
    // for worker readiness, neural evaluation, engine-phase alignment, or an
    // opponent response. Those waits can legitimately span an entire 200 ms
    // engine cycle, and awaiting them here delays every other feature — most
    // importantly the JIT dispatcher — by the same amount.
    //
    // `goPlanning` admits exactly one lifecycle task. Once a move is issued,
    // `goTurnRunning` owns its response promise, and the task chains the next
    // prepared move directly when that promise settles. `goGeneration`
    // invalidates work that crosses a prestige reset.
    // Hold one guard across the whole asynchronous body, including planning.
    if (goTurnRunning || goPlanning) return;
    const generation = goGeneration;
    goPlanning = true;
    void goTick(ctx, generation).catch((error: unknown) => {
      if (!isScriptDeath(error)) record("go", "lifecycle", false, String(error));
    }).finally(() => {
      goPlanning = false;
    });
  },
};

async function goTick(ctx: DriverContext, generation: number): Promise<void> {
    if (generation !== goGeneration) return;
    // A completed game/new-game transition needs a fresh central claim. A
    // failed turn uses this pass only to release the stale claim, then retains
    // the five-second retry backoff.
    if (goCompletionReady) {
      goCompletionReady = false;
      if (!goContinuationReady) return;
    }
    // Consume the edge. A successful action below raises it again when the
    // authoritative game promise resolves. Failure falls back to the normal
    // cadence, except for a one-pass stale-claim transition corrected below.
    goContinuationReady = false;
    const topic = ctx.state.topics.go;
    if (
      !topic?.status || !topic.currentPlayer || !topic.opponent || !topic.stats || !isGoRewardOpponent(topic.opponent)
    ) return;
    if (!goActionAdmitted(ctx.state, ctx.caps)) return;
    const claimedAction = goClaimAction(ctx.state, ctx.caps);
    const cheatUnlocked = goCheatUnlocked(ctx.caps);
    if (goRehydrate || !topic.board || !topic.boardSize || !topic.previousBoards
      || (cheatUnlocked && (!topic.cheat || !goCheatSuccessByCount))) {
      const hydrated = await act(
        "go",
        "hydrate",
        async () => {
          const board = await ctx.nsp("go.getBoardState");
          const history = await ctx.nsp("go.getMoveHistory");
          if (!cheatUnlocked) return { board, history, cheat: undefined };
          // The whole chance curve is sampled once per hydration. Every sample
          // is a repeat of one memoised member on the resident, so the 1024
          // reads cost one price and settle without yielding to the engine.
          const successByCount: number[] = [];
          for (let count = 0; count < GO_CHEAT_CHANCE_SAMPLES; count++) {
            successByCount.push(await ctx.nsp("go.cheat.getCheatSuccessChance", count));
          }
          return {
            board,
            history,
            cheat: { unlocked: true, count: await ctx.nsp("go.cheat.getCheatCount"), successByCount },
          };
        },
        (value) => ({ ok: value.board.length > 0, detail: `read ${value.board.length}x${value.board.length} Go board` }),
      );
      if (generation !== goGeneration) return;
      if (hydrated) {
        if (hydrated.cheat) goCheatSuccessByCount = hydrated.cheat.successByCount;
        const boardSize = observedGoBoardSize(hydrated.board);
        const hydratedBoard = { rows: hydrated.board, size: boardSize };
        const controlled = goTerritory(hydratedBoard);
        // Komi is immutable opponent data; the pinned constant covers the gap
        // before the core probe has reported it, exactly as the planner view
        // does, so the score always lands with the board it describes.
        const hydratedKomi = topic.komi
          ?? (topic.opponent && isGoRewardOpponent(topic.opponent)
            ? GO_REWARD_RULES[topic.opponent].komi
            : undefined);
        const hydratedScore = hydratedKomi === undefined
          ? undefined
          : scoreBoard(hydratedBoard, hydratedKomi);
        merge(ctx.state, "go", {
          board: hydrated.board,
          boardSize,
          previousBoards: hydrated.history,
          moveCount: hydrated.history.length,
          territory: { black: controlled.X, white: controlled.O },
          ...(hydratedScore
            ? { blackScore: hydratedScore.X, whiteScore: hydratedScore.O, komi: hydratedKomi }
            : {}),
          ...(hydrated.cheat ? { cheat: {
            unlocked: true,
            count: hydrated.cheat.count,
            successChance: hydrated.cheat.successByCount[hydrated.cheat.count] ?? 0,
          } } : {}),
          boardUnverified: false,
          // Live state, not the `topic` snapshot taken above: merge replaces the
          // topic object, so a monotonic counter read from `topic` would reset.
          ...(goRehydrate ? {
            boardResyncs: (ctx.state.topics.go?.boardResyncs ?? 0) + 1,
            lastBoardResyncAt: Date.now(),
            ...(goRehydrateReason ? { lastBoardResyncReason: goRehydrateReason } : {}),
          } : {}),
        });
        goRehydrate = false;
        goRehydrateReason = undefined;
        // A rebuilt position invalidates the worker's committed parent and any
        // certified line the lost turns were on: both describe a board we no
        // longer believe we were ever on.
        goPredictionParent = undefined;
        resetGoPlaybookLine();
        // Wake rather than wait: recovery is hydrate -> play, not hydrate -> 5 s.
        goContinuationReady = true;
      }
      return;
    }
    if (
      goTurnReadyAt === undefined
      && claimedAction !== undefined
      && claimedAction !== "hydrate"
      && claimedAction !== "newGame"
    ) {
      // Cold start has no preceding Go promise to timestamp. The first pass
      // with a complete actionable Black position is its truthful boundary.
      // Every dispatching action kind is stamped, cheat turns included, so the
      // latency breakdown never has to invent a boundary it does not hold.
      goTurnReadyAt = Date.now();
    }
    const joined = new Set(ctx.state.topics.factions?.joined ?? []);
    const stats = topic.stats;
    const allowWorldDaemon = Boolean(ctx.state.topics.progression?.ownedAugs?.["The Red Pill"]);
    const nodeMults = effectiveBitNodeMultipliers(
      ctx.caps.bitNode,
      sfLevel(ctx.caps.sourceFiles, 12),
      ctx.state.topics.progression?.multipliers,
    );
    const installRemainingSec = installHorizonSec(ctx.horizons);
    const rewardOpponents: readonly GoRewardOpponent[] = allowWorldDaemon ? GO_REWARD_OPPONENTS : GO_OPPONENTS;
    // Certified entry windows for the wait-aware ranker. Measured only when a
    // new game could start and the phase clock is anchored — cheat games
    // follow certified lines too (certified moves override engine cheats
    // until a cheatSeedFromTurn threshold). Each lookup is a cheap worker
    // table read; opponents beyond their per-opponent wait cap are simply not
    // offered aligned.
    let playbookEntries: Partial<Record<GoRewardOpponent, { waitSec: number; entryPlaytime: number }>> | undefined;
    if (claimedAction === "newGame" && goTickPhase) {
      const runtime = goNeuralRuntime();
      const routePlaytime = goPredictedPlaytime(goTickPhase, Date.now());
      // One round trip per routed opponent, ISSUED TOGETHER: they are
      // independent table reads against the same tick, and awaiting them in
      // series added a worker latency per opponent to every new-game pass.
      const routes = await Promise.all(
        Object.entries(GO_PLAYBOOK_OPPONENTS)
          .filter(([, config]) => config.maxWaitPhases > 0)
          .map(async ([opponent, config]) => ({
            opponent,
            config,
            route: await runtime.playbookRoute(routePlaytime, opponent).catch(() => undefined),
          })),
      );
      if (generation !== goGeneration) return;
      for (const { opponent, config, route } of routes) {
        if (!route || route.waits > config.maxWaitPhases) continue;
        (playbookEntries ??= {})[opponent as GoRewardOpponent] = {
          waitSec: route.waits * GO_ENGINE_CYCLE_MS / 1_000,
          entryPlaytime: route.entryPlaytime,
        };
      }
    }
    const goIncomeShares = incomeShares(ctx.state);
    // The income-maximising crime, for the only reward whose elasticity has a
    // reachable ceiling. Absent without SF4, and the leg is then omitted rather
    // than guessed — the missing source file hides the cap as well as the rate.
    const bestCrime = (ctx.state.topics.career?.crimes ?? [])
      .reduce<CrimeOption | undefined>((best, crime) => best === undefined || crime.moneyPerSec > best.moneyPerSec ? crime : best, undefined);
    const crimeIncome = bestCrime
      ? {
        successChance: bestCrime.chance,
        perSec: bestCrime.moneyPerSec,
        careerBestPerSec: careerBestPerSec(ctx.state),
      }
      : undefined;
    const rewardView = {
      opponents: rewardOpponents,
      stats,
      joinedFactions: joined,
      factionFavor: goFactionFavor(ctx),
      demands: goDemands({
        horizons: ctx.horizons,
        // LIVE gross shares, not the since-install ledger. `MoneySource.total`
        // is net of expenses, so a run that had bought Hacknet nodes reported a
        // hacknet share above one — pinned at the cap by the clamp — for as
        // long as the ledger stayed skewed.
        incomeShares: goIncomeShares,
        openNeeds: ctx.board.open,
        canEarnFactionRep: ctx.caps.unlocked.factions === "yes",
        canRunBladeburner: ctx.caps.unlocked.bladeburner === "yes",
        ...(crimeIncome ? { crimeIncome } : {}),
      }),
      goPower: nodeMults?.GoPower ?? 1,
      hasSourceFile14: sfLevel(ctx.caps.sourceFiles, 14) > 0,
      favorRepCap: goFavorRepCap(sfLevel(ctx.caps.sourceFiles, 14)),
      installRemainingSec,
      ...(playbookEntries ? { playbookEntries } : {}),
    } as const;
    const candidates = rankGoGames(rewardView);
    const schedule = planGoSchedule({
      candidates,
      cadenceSec: 5,
      fillerMarginFactor: GO_FILLER_MARGIN,
      fillerOverheadSec: GO_FILLER_OVERHEAD_SEC,
    });
    if (!schedule) return;
    // The game to start next: the filler when one fits the preferred entry
    // window, otherwise the preferred candidate itself. A hold starts nothing
    // this pass but the engine still plans toward the preferred target.
    const preferred = schedule.kind === "hold" ? schedule.preferred : schedule.game;
    // Decided BEFORE the plan is published, so a refusal to start is visible
    // instead of a silent early return: a quiet Go used to look identical
    // whether it had judged the next game not worth the dodge or had failed
    // outright, which is miserable to debug from a screenshot.
    const ramPie = ctx.state.topics.farm?.ramPie;
    const usableGb = ramPie ? ramPie.farm + ramPie.prep + ramPie.share + ramPie.free + ramPie.reserve : 0;
    const freeGb = ramPie?.free ?? 0;
    const ramSubject = goRamPricingCandidate(schedule);
    const ramGate = {
      pays: goGamePaysForRam(ramSubject.utilityPerSec, usableGb, freeGb),
      opponent: ramSubject.opponent,
      utilityPerSec: ramSubject.utilityPerSec,
      displacedGb: Math.max(0, GO_ESTIMATED_GB - Math.max(0, freeGb)),
      usableGb,
    };
    const view: GoView = {
      board: { rows: topic.board, size: topic.boardSize },
      currentPlayer: topic.currentPlayer,
      opponent: topic.opponent,
      status: topic.status,
      previousBoards: topic.previousBoards,
      // resetBoardState returns the new board before the core probe refreshes
      // its metadata. Komi is immutable opponent data, so use the pinned
      // public constant during that one-pass gap and keep live and arena
      // scoring identical.
      komi: topic.komi ?? GO_REWARD_RULES[topic.opponent].komi,
      // Mirrors the exact count the confirm path derives after a turn, so the
      // planner sees the same pass state either way. Our own pass followed by
      // theirs is two, which a response-only test cannot express.
      consecutivePasses: topic.lastTurn?.opponentResponse?.type === "pass"
        ? topic.lastTurn.action.type === "pass" ? 2 : 1
        : 0,
      bonusCycles: topic.bonusCycles ?? 0,
      // candidateLimit is deliberately absent: the engine resolves the
      // production finalist budget from GO_PROFILE_CANDIDATE_LIMITS (strict
      // K=1 for the policy-only daemon19 profile, including 7/9/13 boards;
      // K=4 for small5), so live play and the arenas share one contract.
      ...(topic.cheat && goCheatSuccessByCount ? { cheat: {
        unlocked: topic.cheat.unlocked,
        count: topic.cheat.count,
        successByCount: goCheatSuccessByCount,
        // Budgets come from the shared per-size table so live play and the
        // arenas cannot drift apart; the rationale lives on the table itself.
        candidateLimit: GO_CHEAT_LIMITS_BY_SIZE[topic.boardSize]!.candidateLimit,
        doubleMoveLimit: GO_CHEAT_LIMITS_BY_SIZE[topic.boardSize]!.doubleMoveLimit,
      } } : {}),
      nextGame: {
        opponent: preferred.opponent,
        boardSize: preferred.boardSize,
      },
    };
    // Re-anchor the engine-cycle phase before planning when it is unknown or
    // has drifted. Nothing but clock reads, and only when needed; once
    // anchored, the wall clock carries the phase across turns.
    const playerPlaytime = ctx.state.topics.player?.totalPlaytime;
    if (
      playerPlaytime !== undefined
      && goTickPhase
      && !goPhaseAgrees(goTickPhase, playerPlaytime, ctx.state.playerObservedAt ?? Date.now())
    ) {
      goTickPhase = undefined;
    }
    if (
      !goTickPhase
      && (claimedAction === "move" || claimedAction === "pass")
      && Date.now() - goAnchorFailedAt > GO_ANCHOR_RETRY_MS
    ) {
      const anchored = await act(
        "go",
        "align",
        // On the LONG resident, like the turn it anchors: the phase these
        // polls establish is the one the dispatch below verifies against, so
        // both must queue behind the same calls.
        () => observeGoTickPhase(() => ctx.nspLong("getPlayer")),
        (value) => ({
          ok: value !== undefined,
          detail: value ? `anchored engine tick ${value.playtime}` : "no engine tick observed",
        }),
      );
      if (generation !== goGeneration) return;
      if (anchored) goTickPhase = anchored;
      else goAnchorFailedAt = Date.now();
    }

    let decision: GoDecision;
    // Candidate enumeration and reply option spaces are seed-independent. The
    // exact seed-dependent half runs immediately before the Go call, between
    // the verified clock read and the dispatch. Preparation never waits for a chosen seed; only dispatch inside
    // the rollover guard may target the next tick and wait its short remainder.
    // This decision is provisional: it uses the last observed playtime only to
    // fix the action type for RAM pricing and publish a plan digest.
    const planStartedAt = Date.now();
    const neuralRuntime = goNeuralRuntime();
    const expectedPredictionParent = goPredictionParent;
    const playbookEnabled = view.status === "inProgress"
      && view.currentPlayer === "Black"
      && view.board.size === 5
      && GO_PLAYBOOK_OPPONENTS[view.opponent] !== undefined;
    // Cheat games consult the playbook like any other: on an unseeded turn
    // the certified move overrides even an engine cheat (see
    // resolveGoExactAction), so the line survives, and cheats fire only off
    // the line or from an opponent's cheatSeedFromTurn threshold on. RAM is
    // not a constraint: every cheat-unlocked Black turn is priced by the 8 GB
    // playTwoMoves representative, which a plain certified makeMove fits
    // inside.
    // A committed aligned start binds only the first Black move of its game.
    const committedEntry = playbookEnabled
      && goPlaybookEntry
      && goPlaybookEntry.opponent === view.opponent
      && view.previousBoards.length === 0
      ? goPlaybookEntry
      : undefined;
    const installed = await neuralRuntime.install(view, expectedPredictionParent);
    const preparationMs = installed.preparationMs;
    const provisionalAt = Date.now();
    const observedPlaytime = goTickPhase
      ? goPredictedPlaytime(goTickPhase, provisionalAt)
      : ctx.state.topics.player?.totalPlaytime ?? 0;
    if (playbookEnabled && goPlaybookPendingCredit) {
      if (observedPlaytime >= goPlaybookPendingCredit.atPlaytime) {
        goPlaybookCredit = goPlaybookPendingCredit.credit;
        goPlaybookPendingCredit = undefined;
      } else {
        // A certified align/sleep wait is in progress; the line resumes on a
        // later pass once the engine clock reaches the granted tick.
        goContinuationReady = true;
        return;
      }
    }
    const provisionalDispatch = goTickPhase
      ? goChooseSeedTarget(
        goTickPhase,
        observedPlaytime,
        provisionalAt,
        GO_DISPATCH_GUARD_MS,
        committedEntry?.entryPlaytime,
      ).targetPlaytime
      : observedPlaytime;
    // The certified lookup runs BEFORE the evaluation: a certified move can
    // seed the double-move cheat family, so the evaluation must know it.
    const certifiedProvisional = playbookEnabled
      ? await neuralRuntime.playbook(installed.positionId, provisionalDispatch, goPlaybookCredit)
        .catch(() => undefined)
      : undefined;
    if (generation !== goGeneration) return;
    const provisionalPlaybookAction = certifiedProvisional?.action;
    if (provisionalPlaybookAction?.kind === "align") {
      goPlaybookPendingCredit = {
        atPlaytime: provisionalDispatch + GO_ENGINE_CYCLE_MS,
        credit: certifiedProvisional!.alignmentBoards,
      };
      goContinuationReady = true;
      return;
    }
    if (provisionalPlaybookAction?.kind === "sleep"
      && provisionalPlaybookAction.variant <= GO_PLAYBOOK_MAX_SLEEP_PHASES) {
      goPlaybookPendingCredit = {
        atPlaytime: provisionalDispatch + provisionalPlaybookAction.variant * GO_ENGINE_CYCLE_MS,
        credit: certifiedProvisional!.alignmentCredit,
      };
      goContinuationReady = true;
      return;
    }
    const provisionalPlaybookMoveOrPass = goPlaybookMoveOrPass(provisionalPlaybookAction);
    const cheatSeedTurn = goPlaybookCheatSeedFromTurn(view.opponent);
    const preferredFirstMove = goCheatSeedMove(view, provisionalPlaybookMoveOrPass, cheatSeedTurn);
    // This first request also covers a cold position. On normal chained
    // turns the worker already holds both the position and likely seed set
    // because it evaluated them during the preceding White response.
    const provisionalEvaluation = await neuralRuntime.evaluate(
      installed.positionId,
      provisionalDispatch,
      expectedPredictionParent,
      preferredFirstMove,
    );
    if (generation !== goGeneration) return;
    decision = provisionalEvaluation.decision;
    const provisionalAction = resolveGoExactAction(
      decision.action, provisionalPlaybookMoveOrPass,
      preferredFirstMove !== undefined && decision.preferredFirstMoveRetained !== false);
    if (provisionalAction !== decision.action) decision = { ...decision, action: provisionalAction };
    const decisionAt = Date.now();
    // Provisional planning ended here. The breakdown assembled at dispatch
    // uses this as the boundary between page-side preparation and the RAM
    // lease that follows.
    const preparedAt = decisionAt;
    const plan: GoPlan = {
      action: goActionDigest(decision.action),
      ranked: decision.ranked,
      input: {
        at: decisionAt,
        board: [...view.board.rows],
        previousBoards: view.previousBoards.map((position) => [...position]),
        status: view.status,
        currentPlayer: view.currentPlayer,
        komi: view.komi,
      },
      planning: {
        finalistCount: decision.finalists,
        positionValue: decision.positionValue,
        ...(decision.passReason ? { passReason: decision.passReason } : {}),
      },
      selection: {
        preferred,
        candidates,
        schedule: {
          kind: schedule.kind,
          ...(schedule.kind === "filler" ? { fillerOpponent: schedule.game.opponent } : {}),
          ...(schedule.kind === "hold" ? { holdSec: schedule.resumeInSec } : {}),
        },
        ramGate,
        context: {
          goPower: rewardView.goPower,
          hasSourceFile14: rewardView.hasSourceFile14,
          favorRepCap: rewardView.favorRepCap,
          installRemainingSec,
          joinedFactions: [...joined].sort(),
          // The single field that explains any ranking: which producer earns
          // what fraction of the run's dollars, and therefore how much of a
          // money bottleneck each reward can honestly claim.
          incomeShares: goIncomeShares,
          demands: rewardView.demands,
        },
      },
    };

    merge(ctx.state, "go", { plan });

    let action = decision.action;
    if (action.type === "newGame") {
      // The scheduler decided nothing fits before the preferred certified
      // entry: hold on the ordinary 5 s cadence without consuming the
      // makeMove-sized grant.
      if (schedule.kind === "hold") return;
      // Positive but vanishing Go power is not free: playing occupies RAM the
      // income engine could use. Decided above so the refusal is published
      // rather than a silent return.
      if (!ramGate.pays) return;
      const newGameAction = action;
      // Certified playbook lines are only reachable from a phase-aligned game
      // start. The opening board itself — obstacles and the Illuminati
      // handicap stone — is generated from the engine tick the game is created
      // in, so the reset, not merely the first move, has to land on the
      // route's entry phase. Only a candidate the scheduler selected AS
      // aligned confirms its route here — an unaligned or filler start must
      // never be captured by a nearby window the ranker already priced and
      // declined.
      goPlaybookEntry = undefined;
      const playbookStart = GO_PLAYBOOK_OPPONENTS[newGameAction.opponent];
      if (
        preferred.aligned
        && preferred.opponent === newGameAction.opponent
        && playbookStart
        && newGameAction.boardSize === 5
        && goTickPhase
      ) {
        // Confirm just before dispatch: waits computed at plan time drift
        // down one phase per 200 ms, and a slipped pass re-plans.
        const routeAt = Date.now();
        const route = await neuralRuntime
          .playbookRoute(goPredictedPlaytime(goTickPhase, routeAt), newGameAction.opponent)
          .catch(() => undefined);
        if (generation !== goGeneration) return;
        if (route && playbookStart.maxWaitPhases > 0 && route.waits <= playbookStart.maxWaitPhases) {
          // The schedule said play (wait within one cadence), so exceeding
          // the start slack here is a one-pass race at most: hold and re-plan.
          if (route.waits > GO_PLAYBOOK_START_SLACK_PHASES) return;
          goPlaybookEntry = { opponent: newGameAction.opponent, entryPlaytime: route.entryPlaytime };
        }
      }
      const alignedEntry = goPlaybookEntry;
      const actionStartedAt = Date.now();
      const reset = await act(
        "go",
        action.type,
        async () => {
          // A reset that lands in-game but whose result never comes back is a
          // desync source like any other dispatch, so invalidate before either
          // call.
          invalidateGoMirror("a board reset was dispatched and its result never merged");
          if (!alignedEntry || !goTickPhase) {
            return await ctx.nspLong("go.resetBoardState", newGameAction.opponent, newGameAction.boardSize);
          }
          const seeded = await runGoNeuralSeedDispatch({
            phase: goTickPhase,
            notBeforePlaytime: alignedEntry.entryPlaytime,
            clock: {
              now: Date.now,
              player: () => ctx.nspLong("getPlayer"),
              sleep: async (ms) => { await realmSleep(ms); },
            },
            infer: async () => undefined,
            dispatch: () => ctx.nspLong("go.resetBoardState", newGameAction.opponent, newGameAction.boardSize),
          });
          goTickPhase = seeded.phase;
          return seeded.response;
        },
        (value) => ({
          ok: value !== undefined,
          detail: value
            ? `new ${value.length}x${value.length} game against ${newGameAction.opponent}`
            : `could not start a game against ${newGameAction.opponent}`,
        }),
      );
      if (generation !== goGeneration) return;
      const result = requireResult("go");
      const lastTurn: GoTurnResult = {
        at: result.at,
        durationMs: Date.now() - actionStartedAt,
        action: goActionDigest(action),
        ok: result.ok,
        detail: result.detail,
      };
      if (reset) {
        // A fresh game starts a fresh certified line at zero credit; a
        // committed goPlaybookEntry deliberately survives for its first move.
        resetGoPlaybookLine();
        goPredictionParent = undefined;
        // The new game's first Black turn has no preceding opponent promise to
        // time from; leaving the finished game's boundary here would report a
        // ready-to-play latency spanning the reset.
        goTurnReadyAt = undefined;
        // A new opponent has a different komi. Clear every board-derived value
        // until the core probe supplies that public metadata; retaining the
        // completed game's score would make the first new-game record lie.
        const fresh: NonNullable<typeof topic> = {
          ...topic,
          board: reset,
          boardSize: observedGoBoardSize(reset),
          previousBoards: [],
          moveCount: 0,
          currentPlayer: "Black",
          status: "inProgress",
          opponent: action.opponent,
          territory: { black: 0, white: 0 },
          // `fresh` is built from the PREVIOUS topic, so an unverified flag set
          // by the turn before this reset would survive into a board the game
          // itself just handed us.
          boardUnverified: false,
          ...(topic.cheat ? { cheat: { ...topic.cheat, count: 0 } } : {}),
          plan,
          lastTurn,
        };
        delete fresh.blackScore;
        delete fresh.whiteScore;
        delete fresh.komi;
        set(ctx.state, "go", fresh);
        // The one merge that is authoritative without a separate read:
        // resetBoardState RETURNS the game's own rows, and the history of a
        // fresh game genuinely is empty.
        goRehydrate = false;
        goRehydrateReason = undefined;
        goContinuationReady = true;
      } else {
        merge(ctx.state, "go", { plan, lastTurn });
        // The board can transition between action kinds while the prior plan
        // is still stored. Retry that bookkeeping mismatch next pass; do not
        // hot-loop genuine RAM denial or an unavailable host.
        if (claimedAction !== action.type) goContinuationReady = true;
      }
      return;
    }

    goTurnRunning = true;
    let turnCompleted = false;
    let continueImmediately = false;
    const runTurn = async (): Promise<void> => {
      const actionStartedAt = Date.now();
      // The whole turn runs on the LONG resident: the Go call's promise
      // resolves only when the engine's AI has replied, and holding the
      // general-purpose resident for that would stall every other read in the
      // automation. Keeping the clock reads on the same resident is what makes
      // the verified read and the dispatch below adjacent — they queue in the
      // order they are issued, with nothing else interleaved.
      const readPlayer = (): Promise<ReturnType<NS["getPlayer"]>> => ctx.nspLong("getPlayer");
      const dispatchGo = (candidate: GoPlayingAction): Promise<RawGoResponse> => {
        switch (candidate.type) {
          case "move":
            return ctx.nspLong("go.makeMove", candidate.x, candidate.y);
          case "pass":
            return ctx.nspLong("go.passTurn");
          case "cheatTwoMoves":
            return ctx.nspLong("go.cheat.playTwoMoves", candidate.x1, candidate.y1, candidate.x2, candidate.y2);
          case "cheatRemoveRouter":
            return ctx.nspLong("go.cheat.removeRouter", candidate.x, candidate.y);
          case "cheatDestroyNode":
            return ctx.nspLong("go.cheat.destroyNode", candidate.x, candidate.y);
          case "cheatRepairNode":
            return ctx.nspLong("go.cheat.repairOfflineNode", candidate.x, candidate.y);
        }
      };
      const rawOutcome = await act(
        "go",
        action.type,
        async (): Promise<GoActionOutcome> => {
          // Prediction and timing are controller/web-worker work. Only each
          // immediate Netscript invocation below queues on the resident.
          const stubEnteredAt = Date.now();
          let finalizeMs = 0;
          let dispatchPlayer: ReturnType<NS["getPlayer"]> | undefined;
          let dispatchPlayerObservedAt: number | undefined;
          let dispatchedAction: GoPlayingAction | undefined = action.type === "resume" || action.type === "newGame"
            ? undefined : action;
          let dispatchedDecision: GoDecision | undefined;
          let dispatchPrediction: GoTurnPrediction | undefined;
          let predictionParentId: string | undefined;
          let boundaryRetries = 0;
          let response: RawGoResponse | undefined;
          let moveDispatchedAt: number | undefined;
          if (dispatchedAction) {
            const finalizeForSlot = async (
              player: ReturnType<NS["getPlayer"]>,
              target?: GoSeedTarget,
            ) => {
              const sampledAt = Date.now();
              // The AI seeds from the tick it is dispatched in, so forecast
              // for the tick this turn will actually land in rather than the
              // one that happens to be current while planning.
              const dispatchPlaytime = target?.targetPlaytime ?? player.totalPlaytime;
              // The certified lookup is bound to the exact dispatch tick and
              // runs BEFORE the evaluation so a certified move can seed the
              // double-move cheat family. A boundary retry that slips the slot
              // re-consults; when the new slot is off the line (including an
              // align/sleep there), the neural decision for that same slot
              // takes over.
              const certified = !playbookEnabled
                ? undefined
                : dispatchPlaytime === provisionalDispatch
                  ? certifiedProvisional
                  : await neuralRuntime.playbook(installed.positionId, dispatchPlaytime, goPlaybookCredit)
                    .catch(() => undefined);
              const playbookAction = goPlaybookMoveOrPass(certified?.action);
              const slotPreferredFirstMove = goCheatSeedMove(view, playbookAction, cheatSeedTurn);
              // Usually this is a completed pushed result. A missed seed
              // still reuses the worker's prepared position and GPU weights;
              // the main game thread only performs this small RPC.
              // The provisional lookup normally targeted this exact slot. Do
              // not turn an already-consumed pushed result into a redundant
              // worker round trip during the final verified dispatch path.
              const evaluated = dispatchPlaytime === provisionalDispatch
                ? provisionalEvaluation
                : await neuralRuntime.evaluate(
                  installed.positionId,
                  dispatchPlaytime,
                  expectedPredictionParent,
                  slotPreferredFirstMove,
                );
              const exactDecision = evaluated.decision;
              const decisionAt = Date.now();
              finalizeMs += decisionAt - sampledAt;
              const exactAction = resolveGoExactAction(
                exactDecision.action, playbookAction,
                slotPreferredFirstMove !== undefined && exactDecision.preferredFirstMoveRetained !== false);
              if (exactAction.type === "resume" || exactAction.type === "newGame") {
                throw new Error(`V9 returned ${exactAction.type} for an active Black turn`);
              }
              // An engine-chosen cheat leaves the certified line: it is not a
              // certified dispatch, so no credit may be refreshed from it.
              const dispatchedPlaybook = !isGoCheatAction(exactAction) && playbookAction !== undefined;
              return {
                action: exactAction,
                decision: exactAction === exactDecision.action
                  ? exactDecision
                  : { ...exactDecision, action: exactAction },
                playbookCertified: dispatchedPlaybook ? certified : undefined,
                positionId: installed.positionId,
                seeds: evaluated.opponentSeeds,
                nextRolloverAt: target
                  ? target.rolloverAt + (target.waitsForRollover ? GO_ENGINE_CYCLE_MS : 0)
                  : undefined,
                // A certified move is not the committed neural action, so the
                // worker's push-ahead commit (which verifies its own decision)
                // is skipped; the next turn issues a fresh install/evaluate.
                continuationHints: dispatchedPlaybook ? [] : evaluated.continuations,
                prediction: {
                  ...(dispatchedPlaybook ? { playbook: true as const } : {}),
                  model: GO_OPPONENT_MODEL,
                  backend: evaluated.backend ?? "webgpu",
                  modelProfile: evaluated.modelProfile,
                  // Every board above 5x5 is rated by the 19x19 daemon weights
                  // on a padded board. That is V9's deliberate profile routing
                  // for the selectable intermediate sizes, but it is out of
                  // distribution and must be visible when such a game plays badly.
                  ...(evaluated.modelExtent !== view.board.size ? { paddedToExtent: evaluated.modelExtent } : {}),
                  sampledTotalPlaytime: player.totalPlaytime,
                  sampledAt,
                  decisionAt,
                  ...(preparationMs === undefined ? {} : { preparationMs }),
                  finalizationMs: evaluated.finalizationMs,
                  totalPlanningMs: decisionAt - planStartedAt,
                  engineCycleMs: GO_ENGINE_CYCLE_MS,
                  aiWaitMs: goAiWaitMs(topic.bonusCycles),
                  seedCandidates: evaluated.opponentSeeds,
                  dispatchPlaytime,
                  ...(target ? { rolloverMarginMs: target.marginMs, waitedForRollover: target.waitsForRollover } : {}),
                  positionCacheHit: installed.cached,
                  pushedPredictionHit: evaluated.pushed,
                  seedCacheHit: evaluated.cached,
                  // boundaryRetries is deliberately absent: this closure runs
                  // before the retry count is known. The dispatch site below
                  // supplies the settled value.
                } satisfies Omit<GoTurnPrediction, "boundaryRetries">,
              };
            };

            const seeded = await runGoNeuralSeedDispatch({
              phase: goTickPhase,
              ...(committedEntry ? { notBeforePlaytime: committedEntry.entryPlaytime } : {}),
              clock: {
                now: Date.now,
                player: readPlayer,
                sleep: async (ms) => { await realmSleep(ms); },
              },
              infer: finalizeForSlot,
              dispatch: (finalized): Promise<RawGoResponse> => dispatchGo(finalized.action),
              // The verified read and the Go call are consecutive calls on the
              // one resident with nothing but this closure's own synchronous
              // work between them: no macrotask runs, so the engine cannot
              // advance a tick between proving the slot and using it.
              verifyAndDispatch: async (finalized, accept) => {
                const player = await readPlayer();
                const observedAt = Date.now();
                if (!accept(player, observedAt)) return { player, observedAt, dispatched: false as const };
                // Check at the last possible instant, after inference and
                // seed assurance but before the irreversible Go call.
                if (generation !== goGeneration) throw new Error("Go generation changed before dispatch");
                moveDispatchedAt = observedAt;
                invalidateGoMirror(GO_DISPATCH_UNMERGED);
                return {
                  player,
                  observedAt,
                  dispatched: true as const,
                  response: dispatchGo(finalized.action),
                };
              },
              onDispatched: (finalized, dispatchWallAt) => {
                // The game promise is now sleeping through White's response.
                // Start likely successor evaluations without awaiting them.
                if (finalized.continuationHints.length) {
                  predictionParentId = neuralRuntime.commit(
                    finalized.positionId,
                    finalized.prediction.dispatchPlaytime,
                    dispatchWallAt,
                    finalized.nextRolloverAt ?? dispatchWallAt + GO_ENGINE_CYCLE_MS,
                    finalized.action,
                    expectedPredictionParent,
                  );
                }
              },
            });
            goTickPhase = seeded.phase;
            boundaryRetries = seeded.boundaryRetries;
            dispatchPlayer = seeded.attempt.player;
            dispatchPlayerObservedAt = seeded.attempt.observedAt;
            dispatchedAction = seeded.attempt.value.action;
            dispatchedDecision = seeded.attempt.value.decision;
            // Without a preceding boundary there is no honest span to report.
            // Substituting planStartedAt would publish a flattering few
            // milliseconds in exactly the cold-start case worth seeing.
            const latency = goTurnReadyAt !== undefined && moveDispatchedAt !== undefined
              ? goDispatchLatency({
                turnReadyAt: goTurnReadyAt,
                planStartedAt,
                preparedAt,
                actionStartedAt,
                stubEnteredAt,
                finalizeMs,
                alignMs: seeded.waitedMs,
                verifiedAt: seeded.attempt.observedAt,
                dispatchedAt: moveDispatchedAt,
              })
              : undefined;
            dispatchPrediction = {
              ...seeded.attempt.value.prediction,
              dispatchPlaytime: seeded.attempt.dispatchPlaytime,
              boundaryRetries,
              ...(latency ? { dispatchBreakdown: latency } : {}),
            };
            response = seeded.response;
            if (playbookEnabled && dispatchedAction && isGoCheatAction(dispatchedAction)) {
              // The cheat deliberately left the certified line: the diverged
              // board can never match a certified entry again, so zero the
              // credit (and any pending align grant) rather than letting a
              // stale credit hold turns for a dead line. The game is fully
              // neural from here.
              resetGoPlaybookLine();
            } else if (playbookEnabled) {
              // Every dispatched turn spends one board of alignment credit,
              // certified or not. The credit records how many further boards
              // the certificate proved under controlled timing — a property of
              // the environment and our own prompt dispatch, not of who chose
              // the move — and it is part of an entry's lookup key, so zeroing
              // it on a turn the network merely reproduced would strand the
              // rest of the line (the residual pass strips exactly such
              // entries). A genuine divergence yields a board and history no
              // entry on the line carries, so the surviving credit cannot
              // match a wrong entry.
              const dispatchedCertified = seeded.attempt.value.playbookCertified;
              goPlaybookCredit = Math.max(0,
                (dispatchedCertified?.alignmentCredit ?? goPlaybookCredit) - 1);
              goPlaybookPendingCredit = undefined;
            }
            if (goPlaybookEntry?.opponent === view.opponent) goPlaybookEntry = undefined;
          }
          if (response !== undefined) {
            // Seed-assured neural dispatch above already started and awaited
            // the Go action at the verified tick, and invalidated the mirror.
          } else if (dispatchedAction?.type === "move" || action.type === "resume" || dispatchedAction?.type === "pass") {
            // One statement for all three unseeded dispatch paths: each issues a
            // board-changing call, so from here the mirror is unproven.
            invalidateGoMirror(GO_DISPATCH_UNMERGED);
            if (dispatchedAction?.type === "move") {
              response = await dispatchGo(dispatchedAction);
            } else if (action.type === "resume") {
              // makeMove/passTurn already await this same promise. This branch only
              // reattaches after a restart interrupted an in-flight white turn.
              response = await ctx.nspLong("go.opponentNextTurn", false, false);
            } else {
              response = await dispatchGo({ type: "pass" });
            }
          } else {
            throw new Error(`invalid Go turn action ${action.type}`);
          }
          const responseReadyAt = Date.now();
          return {
            response,
            ...(dispatchPlayer ? { player: dispatchPlayer } : {}),
            ...(dispatchPlayerObservedAt !== undefined ? { playerObservedAt: dispatchPlayerObservedAt } : {}),
            ...(dispatchedAction ? { action: dispatchedAction } : {}),
            ...(dispatchedDecision ? { decision: dispatchedDecision } : {}),
            ...(dispatchPrediction ? { prediction: dispatchPrediction } : {}),
            ...(predictionParentId ? { predictionParentId } : {}),
            responseReadyAt,
          } satisfies GoActionOutcome;
        },
        (value) => ({
          ok: value.response !== undefined,
          detail: `${value.action?.type ?? action.type}; opponent ${value.response?.type}`,
        }),
      );
      if (generation !== goGeneration) return;
      const result = requireResult("go");
      if (rawOutcome?.action && rawOutcome.decision) {
        action = rawOutcome.action;
        decision = rawOutcome.decision;
        plan.action = goActionDigest(decision.action);
        plan.ranked = decision.ranked;
        plan.planning = {
          finalistCount: decision.finalists,
          positionValue: decision.positionValue,
          ...(decision.passReason ? { passReason: decision.passReason } : {}),
        };
      }
      const dispatched = rawOutcome?.prediction;
      if (rawOutcome?.player) {
        set(ctx.state, "player", rawOutcome.player);
        ctx.state.playerObservedAt = rawOutcome.playerObservedAt ?? Date.now();
      }
      if (!rawOutcome?.response) {
        // Refused AFTER dispatch: the game may or may not have applied it, so
        // the mirror is unproven and goRehydrate is already set. The guard is
        // what keeps a PRE-dispatch failure (RAM denial, queueing, a missed seed
        // tick, a generation change) from forcing a pointless rebuild — the
        // discrimination is whether the call was issued, never its error text.
        if (goRehydrate) goRehydrateReason = `turn refused: ${result.detail}`;
        merge(ctx.state, "go", {
          plan,
          boardUnverified: goRehydrate,
          lastTurn: {
            at: result.at,
            durationMs: Date.now() - actionStartedAt,
            action: goActionDigest(action),
            ...(dispatched ? { prediction: dispatched } : {}),
            ok: result.ok,
            detail: result.detail,
          },
        });
        if (claimedAction !== action.type) goContinuationReady = true;
        return;
      }
      const response = normalizeGoResponse(rawOutcome.response);

      // makeMove/passTurn returns the AI's actual public response. Advance the
      // held board immediately so the driver never replays a stale move while
      // waiting for the next 30 s probe sweep. No hidden AI state is inferred.
      let board = view.board;
      const previousBoards = [...view.previousBoards];
      if (action.type === "move") {
        const ours = playMove(board, action.x, action.y, "X", new Set(previousBoards.map((prior) => prior.join(""))));
        if (!ours) throw new Error(`Go rules drift: accepted move ${action.x},${action.y} was locally illegal`);
        previousBoards.unshift(board.rows);
        board = ours.board;
      } else if (isGoCheatAction(action)) {
        const cheated = applyGoCheat(board, action);
        if (!cheated) throw new Error(`Go rules drift: accepted ${action.type} was locally invalid`);
        // Upstream cheats do not push the pre-cheat board into positional-
        // superko history. White's subsequent ordinary placement pushes this
        // post-cheat board below.
        board = cheated.board;
      }
      if (response.type === "move") {
        const theirs = playMove(board, response.x, response.y, "O", new Set(previousBoards.map((prior) => prior.join(""))));
        if (!theirs) throw new Error(`Go rules drift: accepted AI move ${response.x},${response.y} was locally illegal`);
        previousBoards.unshift(board.rows);
        board = theirs.board;
      }
      // Start the one authoritative settled-state read as soon as the local
      // board exists. Stub startup overlaps the pure scoring/telemetry work
      // below; awaiting it only where its values are first needed keeps that
      // bookkeeping off the next move's critical path.
      const settledPromise = observeGoSettledState(
        ctx,
        rawOutcome.predictionParentId !== undefined || (response.type === "gameOver" && action.type !== "resume"),
        response.type === "gameOver" ? undefined : { board: board.rows, history: previousBoards },
      );
      const predicted = decision.forecast ?? [];
      const predictionTotal = predicted.reduce((sum, candidate) => sum + candidate.count, 0);
      const matching = predicted.reduce((sum, candidate) => {
        const matches = response.type === "move"
          ? candidate.x === response.x && candidate.y === response.y
          : candidate.x === null && candidate.y === null;
        return sum + (matches ? candidate.count : 0);
      }, 0);
      const controlled = goTerritory(board);
      const score = scoreBoard(board, view.komi);
      // Hoisted out of the merge so the verification below can republish it with
      // its own result attached.
      const lastTurn: GoTurnResult = {
        at: result.at,
        durationMs: Date.now() - actionStartedAt,
        action: goActionDigest(action),
        opponentResponse: response,
        ...(dispatched ? { prediction: dispatched } : {}),
        ...(predictionTotal > 0 ? { predictionSupport: { matching, total: predictionTotal } } : {}),
        ok: result.ok,
        detail: result.detail,
      };
      merge(ctx.state, "go", {
        board: board.rows,
        previousBoards,
        moveCount: previousBoards.length,
        ...(topic.cheat ? { cheat: {
          ...topic.cheat,
          count: topic.cheat.count + (isGoCheatAction(action) ? 1 : 0),
          successChance: goCheatSuccessByCount?.[
            topic.cheat.count + (isGoCheatAction(action) ? 1 : 0)
          ] ?? 0,
        } } : {}),
        territory: { black: controlled.X, white: controlled.O },
        blackScore: score.X,
        whiteScore: score.O,
        komi: view.komi,
        currentPlayer: response.type === "gameOver" ? "None" : "Black",
        status: response.type === "gameOver" ? "gameOver" : "inProgress",
        plan,
        lastTurn,
        // The board above is locally advanced. The settled read clears this
        // only after the game agrees with both rows and superko history.
        boardUnverified: response.type !== "gameOver",
      });

      const {
        verification: verified,
        bonusCycles: bonusCyclesAfterResponse,
        player: responsePlayer,
        playerObservedAt: responsePlayerObservedAt,
      } = await settledPromise;
      if (generation !== goGeneration) return;

      if (rawOutcome.predictionParentId && responsePlayer && responsePlayerObservedAt !== undefined) {
        const confirmedPositionId = goNeuralPositionIdentity({
          ...view,
          board,
          previousBoards,
          currentPlayer: response.type === "gameOver" ? "None" : "Black",
          status: response.type === "gameOver" ? "gameOver" : "inProgress",
          consecutivePasses: response.type === "move" ? 0 : action.type === "pass" ? 2 : 1,
          ...(bonusCyclesAfterResponse !== undefined ? { bonusCycles: bonusCyclesAfterResponse } : {}),
          ...(view.cheat ? { cheat: {
            ...view.cheat,
            count: view.cheat.count + (isGoCheatAction(action) ? 1 : 0),
          } } : {}),
        }).id;
        neuralRuntime.confirm(
          rawOutcome.predictionParentId,
          response,
          confirmedPositionId,
          responsePlayer.totalPlaytime,
          responsePlayerObservedAt,
        );
      }
      if (responsePlayer && responsePlayerObservedAt !== undefined) {
        set(ctx.state, "player", responsePlayer);
        ctx.state.playerObservedAt = responsePlayerObservedAt;
      }
      if (verified.result === "match" || verified.result === "skipped") {
        goRehydrate = false;
        goRehydrateReason = undefined;
      } else if (verified.result === "drift") {
        invalidateGoMirror(verified.scope === "history"
          ? "the game move history disagreed with the simulated mirror"
          : "the game board disagreed with the simulated mirror");
      } else {
        // "unavailable" deliberately leaves the mirror invalidated: an unproven
        // mirror degrades into a hydrate, which reads board AND history — a
        // superset of what this verification would have told us. It gets its
        // own reason, though. The turn itself merged, so carrying the
        // dispatch-time reason forward would tell the panel a desync happened
        // when in fact only the proof could not be placed.
        invalidateGoMirror("the post-turn board verification could not be placed");
      }
      merge(ctx.state, "go", {
        ...(bonusCyclesAfterResponse !== undefined ? { bonusCycles: bonusCyclesAfterResponse } : {}),
        boardUnverified: goRehydrate,
        lastTurn: { ...lastTurn, boardVerify: { ms: verified.ms, result: verified.result } },
        // Live state, not the `topic` snapshot: merge replaced the topic object.
        ...(verified.result === "drift"
          ? {
            boardDrifts: (ctx.state.topics.go?.boardDrifts ?? 0) + 1,
            lastBoardDriftAt: Date.now(),
          }
          : {}),
      });
      // A drifted position means the worker's committed parent and the certified
      // alignment credit both describe a board that never existed.
      goPredictionParent = response.type === "gameOver" || goRehydrate
        ? undefined
        : rawOutcome.predictionParentId;
      if (goRehydrate) resetGoPlaybookLine();
      goTurnReadyAt = response.type === "gameOver" ? undefined : rawOutcome.responseReadyAt;
      // The other half of the publish above, not merely a backstop for it. A
      // game that ends on a RESUME never reads the player, so this is the only
      // way that path learns its multipliers moved; it also covers a move/pass
      // turn whose snapshot was lost. Either way the Node Power effect is already applied to the real
      // player, so the held one is wrong until the controller re-reads it.
      if (response.type === "gameOver" && !responsePlayer) ctx.state.playerDirty = true;
      turnCompleted = true;
      continueImmediately = response.type !== "gameOver";
    };
    void runTurn().catch((error: unknown) => {
      if (!isScriptDeath(error)) record("go", action.type, false, String(error));
    }).finally(() => {
      if (generation !== goGeneration) return;
      goTurnRunning = false;
      if (continueImmediately) {
        // The opponent and worker cleanup are complete; dispatch the next turn
        // without waiting for the controller cadence.
        go.tick(ctx);
        return;
      }
      goCompletionReady = true;
      // A finished game should select/start the next one on the next central
      // pass. Failure releases the claim now but retries on ordinary cadence.
      goContinuationReady = turnCompleted;
    });
}

// --- stanek -----------------------------------------------------------------

const stanek: FeatureDriver = {
  id: "stanek",
  // Packing is advisory and changes only with the probed grid. Charge
  // execution itself is owned by hacking's 200 ms fleet scheduler.
  everyMs: 30_000,
  requires: "stanek",
  tick(ctx: DriverContext) {
    const topic = ctx.state.topics.stanek;
    if (!topic) return;

    // `shape` is required by the topic TYPE but a persisted record from an older
    // build carries none, and `packFragments` maps over it unguarded — an absent
    // footprint throws rather than packing. Skip those definitions; treating an
    // unknown footprint as one cell would fabricate a packing instead.
    const fragments = (topic.availableTypes ?? []).flatMap((entry) => entry.shape ? [{
      id: entry.id,
      shape: entry.shape,
      power: entry.power,
      // Charging value comes from the board: a run that needs hacking charges
      // the hacking fragment.
      weight: entry.power,
    }] : []);

    const packed = packFragments(fragments, topic.width, topic.height);
    merge(ctx.state, "stanek", {
      plan: {
        placements: packed.placements,
        value: packed.value,
        approximated: packed.approximated,
      },
    });

    // Execution belongs to hacking's fleet scheduler. The feature retains
    // packing/observability only; a serial feature tick must never await the
    // one-second charge call or maintain a second RAM allocator.
  },
};

// --- progression ------------------------------------------------------------

/** Observed rate over a sliding window of samples. The window (30 min, 30 s
 * granularity) is long enough to smooth probe cadence and short enough that a
 * mid-run regime change (new augs, new fleet) shows up within the dwell the
 * route choice already applies. A NEGATIVE delta means the series was reset
 * under us (an install dropped money to zero, a node reset dropped a skill) —
 * the window restarts rather than reporting a nonsense negative rate. */
class RateTracker {
  private samples: { t: number; v: number }[] = [];

  /** `monotone` treats the series as cumulative earnings: small decreases (a
   * realized trading loss shaving the net) are clamped to the running maximum
   * instead of read as a prestige. Without this, every losing round trip
   * cleared the money tracker's whole window and the route priced a
   * market-driven node at the 250k/s FALLBACK rate while the market produced
   * 20k+/s measured — inverting the money/exp marginal ratio and funding
   * experience RAM out of the trading bankroll. Prestige still clears these
   * trackers, explicitly, at the reset boundary sampledRates already detects —
   * but a PLUNGE (below half the running max) still clears even a monotone
   * tracker: the explicit clear latches on `lastAugReset`, and if the
   * money-sources probe was queued on the post-install pass the clear fired
   * on, the first sample after it is the surviving PRE-install topic value.
   * Clamping to that fabricated high would pin the window there until real
   * earnings exceeded the previous run's total; the input series
   * (earnedSinceInstall) is cost-basis-corrected, so its only genuine
   * decreases are small realized losses and a halving is a boundary. */
  constructor(private readonly monotone = false) {}

  sample(t: number, v: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t - last.t < 30_000) return;
    if (last && v < last.v) {
      if (!this.monotone || v < last.v * 0.5) this.samples.length = 0;
      else v = last.v;
    }
    this.samples.push({ t, v });
    while (this.samples.length > 0 && t - this.samples[0]!.t > 1_800_000) this.samples.shift();
  }

  /** Per-second rate, or 0 while there is no signal (selects the fallback). */
  perSec(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t <= first.t) return 0;
    return ((last.v - first.v) / (last.t - first.t)) * 1000;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

interface ProgressionMemory {
  trackers: {
    moneyEarned: RateTracker;
    hacking: RateTracker;
    combat: RateTracker;
    augs: RateTracker;
    daedalusRep: RateTracker;
    gangRep: RateTracker;
    blackOps: RateTracker;
    rank: RateTracker;
  };
  choice?: RouteChoice;
  installArmedAt?: number;
  installQueueKey?: string;
  /** Marginal install-vs-push hysteresis: the candidate verdict, when it
   * first held, and the dwelled effective verdict. A raw verdict flip must
   * hold for VERDICT_DWELL_MS (either direction) before it takes effect; the
   * only permanent latch is the sweep reaching ready/armed, which is read
   * from the published plan rather than held here. */
  verdictCandidate?: "push" | "install";
  verdictCandidateSince?: number;
  effectiveVerdict?: "push" | "install";
  nodeCompletionArmedAt?: number;
  cyclePoints: CyclePoint[];
  previousCyclePoints?: CyclePoint[];
  cycleResetAt?: number;
  cycleStartAugCount?: number;
  /** Whether this controller observed the cycle from a clean prestige
   * boundary. A startup save can already contain queued augs and banked rep;
   * its next immediate reset is a censored partial cycle, not evidence that a
   * fresh install can reproduce that acquisition rate. */
  cycleObservedFromBoundary?: boolean;
  augmentationCycles: AugmentationCycle[];
}

function freshProgressionMemory(): ProgressionMemory {
  return {
    trackers: {
      moneyEarned: new RateTracker(true),
      hacking: new RateTracker(),
      combat: new RateTracker(),
      augs: new RateTracker(),
      daedalusRep: new RateTracker(),
      gangRep: new RateTracker(),
      blackOps: new RateTracker(),
      rank: new RateTracker(),
    },
    cyclePoints: [],
    augmentationCycles: [],
  };
}

let progressionMemory = freshProgressionMemory();

/** Install cycle in which the Darkscape purchase was attempted. The program is
 * wiped by every install, so this is keyed to the cycle rather than being a
 * plain boolean — a new cycle must be allowed to buy it again. */
let darkscapeGrantedAt: number | undefined;
/** Route change since the controller last asked, for the `endgame.route`
 * telemetry event — the takeTargetSwitch pattern: recorded here, emitted by
 * the controller, which is the only module that touches Telemetry. */
let routeChange:
  | { from?: RouteId; to: RouteId; etaSec: number; expectedEndAt: number; routes: RouteEtaDigest[] }
  | undefined;

/** What the last emitted `endgame.route` event said, so recalibration can be
 * reported when it becomes MATERIAL (>25% eta movement or a part flipping to
 * measured) without spamming an event per refresh. */
let lastRouteEmit: { at: number; etaSec: number; partsKey: string } | undefined;

const ROUTE_REEMIT_MOVE = 0.25;
const ROUTE_REEMIT_MIN_MS = 600_000;

export function takeRouteChange(): typeof routeChange {
  const value = routeChange;
  routeChange = undefined;
  return value;
}

/** Assemble the endgame view from the store. Every field is already acquired
 * by an existing probe; this composes, it never calls ns.
 *
 * Two aug sets with different meanings: `factions.ownedAugs` is owned
 * INCLUDING queued (getOwnedAugmentations(true)); `progression.ownedAugs` is
 * installed only (ResetInfo). Owning the pill and having installed it are
 * exactly that distinction, and Daedalus's aug count checks installed. */
/** The daemon's real destroy gate. The server observation wins; live node
 * multipliers (which the game itself reports) come second. Returns undefined
 * when neither exists, keeping the static-table fallback in stepEndgame. */
function worldDaemonRequiredSkillOf(ctx: NeedContext): number | undefined {
  const observed = ctx.state.topics.servers?.["w0r1d_d43m0n"]?.requiredHackingSkill;
  if (observed !== undefined && observed > 0) return observed;
  const live = ctx.state.topics.progression?.multipliers;
  if (!live) return undefined;
  const difficulty = (live as Record<string, number>)["WorldDaemonDifficulty"];
  return difficulty !== undefined ? WORLD_DAEMON_BASE_SKILL * difficulty : undefined;
}

function endgameView(ctx: NeedContext): EndgameView | undefined {
  const player = ctx.state.topics.player;
  if (!player) return undefined;
  const prog = ctx.state.topics.progression;
  const factions = ctx.state.topics.factions;
  const blade = ctx.state.topics.bladeburner;
  const observedWorldDaemonSkill = worldDaemonRequiredSkillOf(ctx);

  const installed = prog?.ownedAugs ?? {};
  const ownedAll = factions?.ownedAugs ?? Object.keys(installed);
  const installedOccurrences = new Set(Object.keys(installed));
  const seenInstalled = new Set<string>();
  const queuedAugs: string[] = [];
  for (const name of ownedAll) {
    if (installedOccurrences.has(name) && !seenInstalled.has(name)) seenInstalled.add(name);
    else queuedAugs.push(name);
  }
  // End-loaded packages are acquired in the strategic sense (their
  // reputation work is complete) but intentionally not purchased yet. Count
  // those commitments only in the projected queue used by route cadence; do
  // not add them to `ownedAll`, because no multiplier or Red Pill ownership
  // exists before the transaction.
  for (const name of factions?.plan?.bankedAugmentations ?? []) {
    if (!installedOccurrences.has(name) && !queuedAugs.includes(name)) queuedAugs.push(name);
  }
  const skills = player.skills;
  const gang = ctx.state.topics.gang;
  const gangFactionRep = gang
    ? factions?.standings?.find((standing) => standing.name === gang.faction)?.rep ?? 0
    : undefined;
  const gangCreateFaction = (factions?.joined ?? []).find((name) =>
    (GANG_FACTIONS as readonly string[]).includes(name));
  const bladeburnerAvailable = ctx.caps.restrictions.disableBladeburner !== true && (
    ctx.caps.bitNode === 6
    || ctx.caps.bitNode === 7
    || (ctx.caps.sourceFiles["6"] ?? 0) > 0
    || (ctx.caps.sourceFiles["7"] ?? 0) > 0
  );

  // Preferred source: the core probe's derived count (30 s cadence, 0 GB
  // extra). Fallback: count the detail probe's action table once it lands.
  // Neither present -> undefined; "unknown" must stay expressible, or a
  // fabricated 0 re-prices completed ops into the route estimate and feeds a
  // phantom 0->N jump into the rate tracker.
  const blackOpsFromActions = blade?.actions
    ? blade.actions.filter((action) => action.type === "blackop" && (action.countRemaining ?? 1) <= 0).length
    : undefined;
  const blackOpsComplete = blade?.blackOpsComplete ?? blackOpsFromActions;

  return {
    bitNode: ctx.caps.bitNode,
    sourceFiles: ctx.caps.sourceFiles ?? {},
    augCount: prog?.augCount ?? Object.keys(installed).length,
    installedAugs: installed,
    queuedAugs,
    ownsRedPill: ownedAll.includes(RED_PILL),
    redPillInstalled: RED_PILL in installed,
    worldDaemonRooted: ctx.state.topics.servers?.["w0r1d_d43m0n"]?.hasAdminRights === true,
    // The observed server is authoritative; live node multipliers are the
    // next-best source (the static table is one recursion level low inside
    // BN12). Absent both, stepEndgame falls back to the static formula.
    ...(observedWorldDaemonSkill !== undefined
      ? { worldDaemonRequiredSkill: observedWorldDaemonSkill }
      : {}),
    money: player.money,
    hackingSkill: skills.hacking,
    lowestCombatSkill: Math.min(skills.strength, skills.defense, skills.dexterity, skills.agility),
    daedalusRep: factions?.standings?.find((standing) => standing.name === "Daedalus")?.rep ?? 0,
    gangAvailable: ctx.caps.bitNode === 2 && ctx.caps.restrictions.disableGang !== true,
    inGang: gang !== undefined,
    ...(gang ? { gangFaction: gang.faction } : {}),
    ...(gangFactionRep !== undefined ? { gangFactionRep } : {}),
    karma: player.karma ?? 0,
    ...(gangCreateFaction ? { gangCreateFaction } : {}),
    bladeburnerAvailable,
    darknetAvailable: ctx.caps.unlocked.dnet === "yes",
    // The labyrinth needs FULL access, which DarkscapeNavigator.exe does not
    // grant. Passing only the first flag would advertise a Red Pill route that
    // does not exist in the node we are standing in.
    darknetFullAccess: ctx.caps.darknetFullAccess === "yes",
    // The current dnet driver can observe and plan traversal but deliberately
    // refuses host-local authentication/stasis actions until dispatch can
    // lease the intended darknet host. Do not select an ETA we cannot execute.
    labyrinthAutomationAvailable: false,
    inBladeburner: ctx.caps.unlocked.bladeburner === "yes",
    charismaSkill: skills.charisma,
    ...(blackOpsComplete !== undefined ? { blackOpsComplete } : {}),
    ...(blade?.rank !== undefined ? { bladeburnerRank: blade.rank } : {}),
  };
}

function sampledRates(ctx: NeedContext, view: EndgameView): RouteRates {
  const t = ctx.now;
  const trackers = progressionMemory.trackers;
  const progression = ctx.state.topics.progression;
  // Distortion-corrected (see earnedSinceInstall): the raw ledger plunges by a
  // position's whole cost at every open, and the decrease-clearing RateTracker
  // then never accumulates a window — a market-driven node measured 0.554 $/s
  // while the market produced 22,400 $/s, and every route ETA priced off it.
  const earned = earnedSinceInstall(ctx.state);
  const resetAt = progression?.lastAugReset;
  if (resetAt !== undefined && progressionMemory.cycleResetAt !== resetAt) {
    const previousResetAt = progressionMemory.cycleResetAt;
    const previousAugCount = progressionMemory.cycleStartAugCount;
    if (
      previousResetAt !== undefined
      && previousAugCount !== undefined
      && progressionMemory.cycleObservedFromBoundary === true
    ) {
      const completed: AugmentationCycle = {
        sec: Math.max(0, (resetAt - previousResetAt) / 1_000),
        augmentations: Math.max(0, view.augCount - previousAugCount),
      };
      if (completed.sec > 0 && completed.augmentations > 0) {
        progressionMemory.augmentationCycles.push(completed);
        if (progressionMemory.augmentationCycles.length > 6) progressionMemory.augmentationCycles.shift();
      }
    }
    if (progressionMemory.cyclePoints.length >= 2) {
      progressionMemory.previousCyclePoints = progressionMemory.cyclePoints;
    }
    progressionMemory.cyclePoints = [];
    progressionMemory.cycleResetAt = resetAt;
    progressionMemory.cycleStartAugCount = view.augCount;
    progressionMemory.cycleObservedFromBoundary = (view.queuedAugs?.length ?? 0) === 0;
    // Aug count does not decrease on prestige, so RateTracker's generic
    // decrease detector cannot discover the boundary. Without this explicit
    // clear, the install jump is divided by post-install idle time and remains
    // a fabricated acquisition rate for another 30 minutes. The monotone
    // moneyEarned tracker opted out of that detector, so it clears here too.
    trackers.augs.clear();
    trackers.moneyEarned.clear();
  }
  if (resetAt !== undefined && earned !== undefined) {
    const sec = Math.max(0, (t - resetAt) / 1_000);
    const last = progressionMemory.cyclePoints.at(-1);
    if (!last || sec - last.sec >= 60) {
      progressionMemory.cyclePoints.push({
        sec,
        money: Math.max(0, earned),
        hacking: view.hackingSkill,
        combat: view.lowestCombatSkill,
      });
      // Preserve the cold bootstrap instead of turning this into a sliding
      // window. Fresh-install ETA needs the first minutes where skill, RAM and
      // rooted hosts unlock one another; dropping those points after two
      // hours made every long cycle look like its late plateau and forecasts
      // grew *longer* as real progress accumulated. At the fixed bound retain
      // two dense hours at each end and discard only the oldest middle point.
      retainCycleCurve(progressionMemory.cyclePoints);
    }
  }
  if (earned !== undefined) trackers.moneyEarned.sample(t, earned);
  trackers.hacking.sample(t, view.hackingSkill);
  trackers.combat.sample(t, view.lowestCombatSkill);
  // Series whose zero can be FABRICATED (the backing probe has not landed
  // yet) are sampled only when the reading is real: a phantom (t0, 0) sample
  // would sit in the 30-minute window and inflate the rate ~24x when the
  // true value arrives — the increase-jump passes the decrease-only reset
  // guard by design.
  const augsKnown =
    ctx.state.topics.progression?.augCount !== undefined || ctx.state.topics.factions?.ownedAugs !== undefined;
  if (augsKnown) trackers.augs.sample(t, view.augCount);
  if (ctx.state.topics.factions?.standings !== undefined) trackers.daedalusRep.sample(t, view.daedalusRep);
  if (view.gangFactionRep !== undefined) trackers.gangRep.sample(t, view.gangFactionRep);
  if (view.blackOpsComplete !== undefined) trackers.blackOps.sample(t, view.blackOpsComplete);
  if (view.bladeburnerRank !== undefined) trackers.rank.sample(t, view.bladeburnerRank);
  // The rank tracker needs two samples 30s apart before it reports anything,
  // and reports 0 whenever bladeburner is idle — but the bladeburner plan
  // already SCORES its best action's rank/sec before ever executing it. Using
  // that forward estimate ahead of the static prior marks the route's
  // bladeburner leg `measured` as soon as the feature RUNS, instead of
  // pricing the route off a fallback constant for the first half hour. The
  // execution evidence matters: the tracker also reads 0 when the plan never
  // executes at all (no work slot, stamina gate), and pricing the route at a
  // planned rate while actual progress is zero forecast the node's end hours
  // early — an action in flight or a recent successful result is required.
  const blade = ctx.state.topics.bladeburner;
  const bladeExecuting =
    blade?.current !== undefined
    || (blade?.plan?.lastResult?.ok === true && t - blade.plan.lastResult.at < 300_000);
  const plannedRank = bladeExecuting ? blade?.plan?.ranked?.[0]?.rankPerSec : undefined;
  const sampledRank = trackers.rank.perSec();
  const curvePoints = progressionMemory.cyclePoints;
  const priorCyclePoints = progressionMemory.previousCyclePoints;
  const committedNames = new Set([
    ...(ctx.state.topics.factions?.plan?.bankedAugmentations ?? []),
    ...(view.queuedAugs ?? []),
  ]);
  const augMeta = ctx.state.topics.factions?.augMeta ?? {};
  const committedMultiplier = (field: string): number => {
    let result = 1;
    for (const name of committedNames) {
      const value = augMeta[name]?.mults?.[field];
      if (value !== undefined && value > 0) result *= value;
    }
    return result;
  };
  // The unmeasured-money PRIOR, composed per channel from the node's own
  // transcribed multipliers instead of one flat hacking-era constant. In BN1
  // this reduces to exactly the tuned FALLBACK_MONEY_PER_SEC (both hacking
  // multipliers are 1, the market is inaccessible), so nothing recalibrates.
  // In BN8 it is what the multipliers already say out loud: hacked money pays
  // `ScriptHackMoney x ScriptHackMoneyGain = 0`, and the accessible market's
  // rough worth is the same closed-form blind rate the unlock ladder prices
  // with, taken on the current bankroll. Without this, the route priced a
  // market-only node's money at 250k/s until the first trades were measured,
  // the money marginal read ~400k seconds while the hacking marginal read
  // millions, and the cold-start auction handed the trading bankroll to
  // experience RAM before the market could prove itself.
  const measuredMoneyPerSec = trackers.moneyEarned.perSec();
  const nodeMultsForPrior = effectiveBitNodeMultipliers(
    ctx.caps.bitNode,
    sfLevel(ctx.caps.sourceFiles, 12),
    progression?.multipliers,
  );
  const hackingPrior = FALLBACK_MONEY_PER_SEC
    * (nodeMultsForPrior?.["ScriptHackMoney"] ?? 1)
    * (nodeMultsForPrior?.["ScriptHackMoneyGain"] ?? 1);
  const stockTopicForPrior = ctx.state.topics.stock;
  const marketPrior = stockTopicForPrior?.hasTixApiAccess === true
    ? blindBankrollRatePerSec(
        (ctx.state.topics.player?.money ?? 0) + Math.max(0, stockTopicForPrior.portfolioValue ?? 0),
      )
    : 0;
  return {
    moneyPerSec: measuredMoneyPerSec > 0 ? measuredMoneyPerSec : hackingPrior + marketPrior,
    hackingSkillPerSec: trackers.hacking.perSec(),
    combatSkillPerSec: trackers.combat.perSec(),
    augsPerSec: augmentationAcquisitionRate(progressionMemory.augmentationCycles) || trackers.augs.perSec(),
    daedalusRepPerSec: trackers.daedalusRep.perSec(),
    gangRepPerSec: trackers.gangRep.perSec(),
    blackOpsPerSec: trackers.blackOps.perSec(),
    bladeburnerRankPerSec: sampledRank > 0 ? sampledRank : plannedRank ?? 0,
    postInstallHackingSkillMult: committedMultiplier("hacking"),
    postInstallCombatSkillMult: Math.min(
      committedMultiplier("strength"),
      committedMultiplier("defense"),
      committedMultiplier("dexterity"),
      committedMultiplier("agility"),
    ),
    ...(curvePoints.length >= 2 || (priorCyclePoints?.length ?? 0) >= 2
      ? {
          cycle: {
            points: curvePoints,
            elapsedSec: Math.max(0, (t - (resetAt ?? t)) / 1_000),
            ...(priorCyclePoints && priorCyclePoints.length >= 2 ? { priorPoints: priorCyclePoints } : {}),
          },
        }
      : {}),
  };
}

/** Value product of the augmentations affordable right now: the product over
 * each one's multiplier product. Multipliers MULTIPLY, which is why this is a
 * product of products rather than any sum. An offer with no reported mults
 * (NeuroFlux, the odd unstable aug) counts a token 1.01 — present, near-
 * worthless, never zeroing the whole product. */
function affordableValueProduct(ctx: NeedContext): number {
  const topic = ctx.state.topics.factions;
  const offers = topic?.offers ?? [];
  const money = ctx.state.topics.player?.money ?? 0;
  // Multipliers live once per AUGMENTATION, not once per (faction,
  // augmentation) offer — carrying them on every pair duplicated each table up
  // to four times and dominated this topic's wire size.
  const meta = topic?.augMeta ?? {};
  let product = 1;
  for (const offer of offers) {
    if (offer.owned || !offer.affordableRep || offer.price > money) continue;
    const mults = Object.values(meta[offer.name]?.mults ?? {});
    product *= mults.length > 0 ? mults.reduce((a, b) => a * b, 1) : 1.01;
  }
  return product;
}

/** The published plan, but only if THIS bundle can read it.
 *
 * The plan outlives the code that wrote it: module state dies with the old bundle
 * while the topic lives in the realm store, which is the whole point of
 * `previousChoice` below. The corollary is that a plan written before a field
 * existed will be missing it, and the type — which describes what we write, not
 * what we may find — says nothing about that.
 *
 * THE BUG this exists to prevent: `plan.forecasts.node` was read unguarded, so
 * after a rebuild that added `forecasts` the refresh threw
 * `Cannot read properties of undefined (reading 'node')` on every pass. It threw
 * BEFORE publishing, so it could never replace the plan that was breaking it —
 * permanently wedged, reporting "waiting for the progression planner" while every
 * other feature ran normally. A stale plan has to be discarded, not trusted.
 *
 * Checked by the fields later code dereferences rather than by a version number:
 * there is no schema version to bump, and this cannot drift out of date silently
 * the way a hand-maintained one would. */
function readablePlan(state: GameState): ProgressionPlan | undefined {
  const plan = state.topics.progression?.plan;
  if (!plan?.forecasts?.node || !plan.forecasts.install) return undefined;
  if (!plan.queuedAugmentations || !plan.installBlockers || typeof plan.liquidationWanted !== "boolean") return undefined;
  return plan;
}

/** The previous route decision, surviving a build handoff: module state dies
 * with the old bundle, but the published plan lives in the realm store. */
function previousChoice(ctx: NeedContext): RouteChoice | undefined {
  if (progressionMemory.choice) return progressionMemory.choice;
  const plan = readablePlan(ctx.state);
  if (!plan?.route || plan.decidedAt === undefined) return undefined;
  const node = plan.forecasts.node;
  return {
    route: plan.route,
    etaSec: node.state === "unknown" ? 0 : Math.max(0, (node.expectedAt - ctx.now) / 1_000),
    decidedAt: plan.decidedAt,
  };
}

/** An augmentation that could still be PURCHASED right now, if there is one.
 *
 * The half of the install barrier that is not about stocks. Cash does not survive
 * an install, so resetting while something is still affordable destroys money
 * that could have become a permanent multiplier — the reset should always lose
 * that race. Returned as a name so the blocker can say which one is holding it.
 *
 * The test is {@link nextPurchasableAugmentation}. It is deliberately NOT the same
 * code path factions buys through — see there for why the two converge instead of
 * matching, and why NeuroFlux holds this barrier without wedging it. */
export function purchasableAugmentation(ctx: NeedContext): string | undefined {
  const factions = ctx.state.topics.factions;
  const money = ctx.state.topics.player?.money ?? 0;
  if (!factions?.offers) return undefined;
  const owned = new Set(factions.ownedAugs ?? []);
  // During a drain, test the drain's own frozen budget, not live cash: income
  // arriving while the drain runs must not hold the barrier up — the drain has
  // already declined to spend it (see FactionPlan.drainCeiling).
  const plan = factions.plan;
  const ceiling = plan?.drainCeiling ?? Infinity;
  // Once the transaction starts, the drain's exact ordered batch is the sole
  // authority. Testing isolated live offers here ignores the price escalation
  // already paid by the queue and can resurrect an item the frozen package
  // deliberately dropped, deadlocking the install behind a purchase factions
  // will never make. The probed NeuroFlux offer can also be one pass stale.
  const draining = plan?.drainCeiling !== undefined;
  if (draining) return plan.nextBuy?.name;
  return nextPurchasableAugmentation({
    offers: factions.offers,
    joined: new Set(factions.joined ?? []),
    owned,
    prereqs: (name) => factions.augMeta?.[name]?.prereqs ?? [],
    money: Math.min(money, ceiling),
  })?.name;
}

/** Decide how this BitNode ends and when, then publish it before this pass's
 * needs, claims, and feature ticks consume the result. */
function progressionRefresh(ctx: NeedContext): void {
  const player = ctx.state.topics.player;
  if (!player) return;
  const factions = ctx.state.topics.factions;
  const prog = ctx.state.topics.progression;

  // --- route: how does the run END, and how long is each way expected to take
  const view = endgameView(ctx)!;
  const endgame = stepEndgame(view);
  const rates = sampledRates(ctx, view);
  const etas = routeEtas(view, endgame, rates);
  const previous = previousChoice(ctx);
  const { choice, switched } = chooseRoute(previous, etas, ctx.now);
  progressionMemory.choice = choice;

  const blockerOf = new Map(endgame.routes.map((route) => [route.id, route.blocker]));
  const statusOf = new Map(endgame.routes.map((route) => [route.id, route]));
  const routesDigest: RouteEtaDigest[] = etas.map((eta) => ({
    id: eta.id,
    available: eta.available,
    ...(eta.actionable !== undefined ? { actionable: eta.actionable } : {}),
    complete: eta.complete,
    blocker: blockerOf.get(eta.id) ?? "",
    etaSec: Math.round(eta.etaSec),
    parts: eta.parts.map((entry) => ({ what: entry.what, resource: entry.resource, sec: Math.round(entry.sec), measured: entry.measured })),
    ...(eta.stage ? { stage: eta.stage } : {}),
    ...(eta.needs ? { needs: eta.needs } : {}),
    ...(eta.nextMandatoryInstall
      ? { nextMandatoryInstall: { ...eta.nextMandatoryInstall, sec: Math.round(eta.nextMandatoryInstall.sec) } }
      : {}),
    ...(statusOf.get(eta.id)?.optionalInstall !== undefined
      ? { optionalInstall: statusOf.get(eta.id)!.optionalInstall }
      : {}),
  }));
  const selectedEta = choice ? etas.find((eta) => eta.id === choice.route) : undefined;
  const selectedStatus = choice ? endgame.routes.find((route) => route.id === choice.route) : undefined;
  let routeRequiresInstall = selectedStatus?.mandatoryInstall?.ready === true;
  const regrowOverride = regrowInstallOverride({
    ...(selectedStatus?.stage !== undefined ? { stage: selectedStatus.stage } : {}),
    ...(selectedStatus?.optionalInstall !== undefined
      ? { optionalInstallAllowed: selectedStatus.optionalInstall }
      : {}),
    ...(endgame.worldDaemonSkill !== undefined ? { worldDaemonSkill: endgame.worldDaemonSkill } : {}),
    hackingSkill: view.hackingSkill,
    rates,
  });
  // The OVERRIDDEN permission, as handed to installForecast and the digests:
  // the regrow comparison may flip the route's raw optional-install guard.
  const optionalInstallAllowed = regrowOverride || (selectedStatus?.optionalInstall ?? true);
  const nodeBasis = JSON.stringify({
    route: choice?.route,
    complete: selectedEta?.complete,
    blocker: endgame.routes.find((route) => route.id === choice?.route)?.blocker,
    parts: selectedEta?.parts.map((part) => [part.what, part.measured]),
  });
  const previousNodeForecast = readablePlan(ctx.state)?.forecasts.node;
  const nextNodeForecast = shouldReforecast(previousNodeForecast, ctx.now, nodeBasis)
    ? nodeForecast(ctx.now, selectedEta, nodeBasis)
    : forecastAt(previousNodeForecast!, ctx.now);
  // Emit on switch, and ALSO on material recalibration of the kept route:
  // the topic self-corrects continuously, but the decision record in
  // runs/*.jsonl only shows what was emitted — a single all-priors event per
  // run made every calibration look unrevised. Rate-limited so a noisy rate
  // tracker cannot flood the event ring.
  const partsKey = selectedEta?.parts.map((part) => `${part.what}:${part.measured}`).join("|") ?? "";
  const materialMove =
    choice !== undefined
    && lastRouteEmit !== undefined
    && ctx.now - lastRouteEmit.at >= ROUTE_REEMIT_MIN_MS
    && (Math.abs(choice.etaSec - lastRouteEmit.etaSec) > lastRouteEmit.etaSec * ROUTE_REEMIT_MOVE
      || partsKey !== lastRouteEmit.partsKey);
  if ((switched || materialMove) && choice && nextNodeForecast.state !== "unknown") {
    routeChange = {
      ...(switched && previous ? { from: previous.route } : {}),
      to: choice.route,
      etaSec: Math.round(choice.etaSec),
      expectedEndAt: nextNodeForecast.expectedAt,
      routes: routesDigest,
    };
    lastRouteEmit = { at: ctx.now, etaSec: choice.etaSec, partsKey };
  } else if (switched === false && choice !== undefined && lastRouteEmit === undefined) {
    // A choice that predates this bundle (plan read back from the store)
    // seeds the baseline without emitting.
    lastRouteEmit = { at: ctx.now, etaSec: choice.etaSec, partsKey };
  }

  // --- install cadence, on real inputs rather than the stubbed constants the
  // first cut shipped with (affordableValueProduct 1, runSec 0).
  const installed = prog?.ownedAugs ?? {};
  const occurrences = new Map<string, number>();
  for (const name of factions?.ownedAugs ?? []) occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
  const pending: string[] = [];
  for (const [name, count] of occurrences) {
    // Installed augmentations appear once in getOwnedAugmentations(true), even
    // when NeuroFlux's installed level is greater than one. Every additional
    // occurrence is queued and must survive into the reset record.
    const installedOccurrence = (installed[name] ?? 0) > 0 ? 1 : 0;
    for (let i = installedOccurrence; i < count; i++) pending.push(name);
  }
  pending.sort();
  const standings = Object.fromEntries(
    (factions?.standings ?? []).map((standing) => [standing.name, { rep: standing.rep, favor: standing.favor }]),
  );
  const purchasable = purchasableAugmentation(ctx);

  // --- install-vs-push: the marginal-value verdict --------------------------
  // Value the reset would ACTIVATE: multiplier-only score (flat bonuses mark
  // necessity, not rate, and the route-mandatory case is routeRequiresInstall's
  // job) of the queue PLUS what the final sweep would still convert — offers
  // whose reputation is met and price is within the bankroll. Purchases are
  // end-loaded, so mid-cycle the queue is empty by design; without the
  // realizable set the reset side reads zero and the verdict pushes forever.
  // Priced by the route's OWN marginals — the same measurement this feature
  // publishes — so the accrued side of the cadence comes out in BN-seconds and
  // can be compared with the push rate without either being a made-up unit.
  // Which branch of Daedalus binds is no longer a switch to set: a combat gate
  // that is not on the critical path measures zero and prices its
  // augmentations accordingly.
  // The PUBLISHED marginals: this pass computes its own further down, but the
  // valuation is wanted before then and a one-pass-old measurement of a slowly
  // moving route estimate is not a different answer.
  const publishedWorth = currencyWorth(ctx.state.topics.progression?.plan?.marginals);
  const verdictWeights = weightsFromMarginals(publishedWorth, {
    hackingTarget: endgame.worldDaemonSkill,
    combatTarget: DAEDALUS_COMBAT,
    multipliers: (player.mults ?? {}) as unknown as Record<string, number>,
    incomeShares: incomeShares(ctx.state),
  });
  // Clamped at zero per augmentation: cost-reduction multipliers sit BELOW 1,
  // so a beneficial aug can carry a negative log-score — the accrued signal
  // measures what an install would activate, and that is never negative.
  const scoreMults = (name: string): number => {
    const aug = AUGMENTATIONS[name];
    if (!aug) return 0;
    return Math.max(0, scoreAugMults(
      { name, baseCost: aug.cost, baseRepRequirement: aug.rep, factions: [...aug.factions], prereqs: [...(aug.prereqs ?? [])], mults: { ...(aug.mults ?? {}) }, ...(aug.multsUnknown ? { multsUnknown: true } : {}) },
      verdictWeights,
    ));
  };
  const realizable = new Set<string>();
  // The sweep's budget is cash PLUS the liquidatable stock book — the same
  // frozen ceiling the drain itself uses (cash + pendingProceeds). Cash alone
  // read near-zero on stock-funded nodes (BN8 keeps the bankroll invested by
  // design), so realizable stayed empty and the verdict pushed forever.
  const sweepBudget = player.money + liquidatableValue(ctx);
  // Joined factions only: the sweep can only buy from a faction we are IN,
  // and after a prestige the offers list can briefly describe factions the
  // reset just removed — counting those manufactured install pressure in a
  // cycle with nothing joined and deadlocked it (installRequested stops the
  // very faction work that would have made something realizable).
  const joinedSet = new Set(factions?.joined ?? []);
  const favorDonateAt = factions?.favorToDonate ?? 150;
  const donationEligible = new Set(
    (factions?.standings ?? [])
      .filter((standing) => joinedSet.has(standing.name) && standing.favor >= favorDonateAt)
      .map((standing) => standing.name),
  );
  const ownedOrQueued = new Set<string>(pending);
  for (const offer of factions?.offers ?? []) if (offer.owned) ownedOrQueued.add(offer.name);
  const affordable: string[] = [];
  for (const offer of factions?.offers ?? []) {
    if (offer.owned || !joinedSet.has(offer.faction)) continue;
    if ((!offer.affordableRep && !donationEligible.has(offer.faction)) || offer.price > sweepBudget) continue;
    affordable.push(offer.name);
  }
  // Prereq closure: every real purchase path skips a prereq-unmet aug
  // (augs.ts nextPurchasableAugmentation), so an offer only counts as
  // realizable when its prerequisites are owned, queued, or themselves
  // realizable this sweep — otherwise a rep-locked prereq chain manufactures
  // install pressure for value the sweep can never convert, the exact
  // deadlock shape the joined-factions filter above was added for.
  for (let moved = true; moved; ) {
    moved = false;
    for (const name of affordable) {
      if (realizable.has(name)) continue;
      const prereqs = AUGMENTATIONS[name]?.prereqs ?? [];
      if (prereqs.every((prereq) => ownedOrQueued.has(prereq) || realizable.has(prereq))) {
        realizable.add(name);
        moved = true;
      }
    }
  }
  for (const name of pending) realizable.delete(name);

  // "Every item fits this bankroll on its own" is not a funded reset set:
  // the second and later purchases pay the 1.9x queue escalation. Cadence used
  // to sum every individually affordable offer here, then the frozen sweep
  // could buy only a strict subset. That fabricated reset value and armed an
  // early install (measured in the full BN1 harness: eight candidates valued,
  // five actually bought). Select the jointly affordable one-shot set using
  // the same value-order / payment-order split as the transaction boundary.
  // Purchases remain entirely end-loaded; this is only the honest value of
  // what the current bankroll could convert if progression ended the cycle.
  const daedalusRequired = choice?.route === "daedalus" && view.bitNode !== undefined
    ? daedalusAugsRequired(view.bitNode, view.sf12Level ?? view.sourceFiles["12"] ?? 0)
    : undefined;
  const activationOwned = new Set([...ownedOrQueued, ...pending]);
  const activationNodeMults = effectiveBitNodeMultipliers(
    view.bitNode,
    view.sf12Level ?? view.sourceFiles["12"] ?? 0,
    prog?.multipliers,
  );
  const activationPriceContext = {
    queuedNonSoA: pending.filter((name) => !isSoA(name)).length,
    ownedSoA: Object.keys(installed).filter(isSoA).length,
    neurofluxLevel: (installed[NEUROFLUX] ?? 0) + pending.filter((name) => name === NEUROFLUX).length,
    sf11Level: view.sourceFiles["11"] ?? 0,
    augMoneyCost: activationNodeMults?.AugmentationMoneyCost ?? 1,
    augRepCost: activationNodeMults?.AugmentationRepCost ?? 1,
  };
  const activationDonation = {
    standings: (factions?.standings ?? []).map((standing) => ({
      ...standing,
      joined: joinedSet.has(standing.name),
    })),
    favorToDonate: favorDonateAt,
    factionRepMult: player.mults?.faction_rep ?? 1,
    factionWorkRepGain: activationNodeMults?.FactionWorkRepGain ?? 1,
  };
  const fundedActivation = fundedActivationBatch({
    realizable,
    owned: activationOwned,
    weights: verdictWeights,
    countSlotValue: countSlotValueFor(publishedWorth, daedalusRequired ?? Infinity, view.augCount),
    neurofluxCountable: daedalusRequired !== undefined && !activationOwned.has(NEUROFLUX),
    ctx: activationPriceContext,
    money: sweepBudget,
    donation: activationDonation,
  });

  if (daedalusRequired !== undefined && view.augCount < daedalusRequired) {
    const installedNames = new Set(Object.keys(view.installedAugs ?? {}));
    const queuedCountable = new Set(
      pending.filter((name) => name !== NEUROFLUX || !installedNames.has(NEUROFLUX)),
    );
    routeRequiresInstall = routeRequiresInstall || countClosureAffordable({
      realizable,
      owned: ownedOrQueued,
      wanted: Math.max(0, daedalusRequired - view.augCount - queuedCountable.size),
      neurofluxCountable: !installedNames.has(NEUROFLUX),
      ctx: activationPriceContext,
      money: sweepBudget,
      donation: activationDonation,
    });
  }
  // Banked-but-unrealized favor, priced with packageValue's OWN favor terms
  // (futureRateGain + crossesDonation) at current rep. The frontier's favor
  // packages accrue value that only an install banks — without this term the
  // push stream counts that value as income while the reset side never sees
  // it, and a favor-purpose objective can never conclude.
  const plannedRep = new Map<string, number>();
  for (const candidate of fundedActivation) {
    const target = augCost(candidate.aug, activationPriceContext).repCost;
    plannedRep.set(candidate.faction, Math.max(plannedRep.get(candidate.faction) ?? 0, target));
  }
  const bankedFavorValue = bankedFavorActivationValue({
    standings: (factions?.standings ?? [])
      .filter((standing) => joinedSet.has(standing.name))
      .map((standing) => ({ ...standing, rep: Math.max(standing.rep, plannedRep.get(standing.name) ?? 0) })),
    offers: factions?.offers ?? [],
    favorToDonate: favorDonateAt,
    reputationWorthSec: publishedWorth.get("reputation") ?? 0,
  });
  // Unit-consistent with packageValue (count + quality + favor terms): the
  // push rate is denominated in package value, where every augmentation
  // carries a flat +1 count on top of its multiplier quality — an accrued
  // side without the count term could never clear the threshold on cheap
  // augs however many of them an install would activate.
  // Count slots pay at the Daedalus gate rather than accelerating the next
  // cycle, but a sufficiently large partial tranche has persistent route
  // value: it avoids forcing every remaining slot through one exponential
  // 1.9^N transaction. The node-relative consolidation policy remains the
  // guard against tiny late resets; below it count contributes zero here.
  const resetMultiplierValue = [...pending, ...fundedActivation.map((candidate) => candidate.name)].reduce(
    (sum, name) => sum + scoreMults(name),
    0,
  );
  let routeCountValue = 0;
  let countCadenceReady = true;
  if (daedalusRequired !== undefined) {
    const installedNames = new Set(Object.keys(view.installedAugs ?? {}));
    const verdict = routeCountVerdict({
      required: daedalusRequired,
      installed: view.augCount,
      affordableDistinct: new Set(
        [...pending, ...fundedActivation.map((candidate) => candidate.name)]
          .filter((name) => !installedNames.has(name)),
      ).size,
      consolidationAllowed: selectedStatus?.optionalInstall === true,
      worth: publishedWorth,
    });
    countCadenceReady = verdict.ready;
    routeCountValue = verdict.value;
  }
  const resetValueMult = resetMultiplierValue + bankedFavorValue + routeCountValue;
  const intent = factions?.plan?.objective?.intent;
  // The package selector also values permanent Daedalus count slots. They
  // advance the route, but do not accelerate the next cycle, so cadence uses
  // its separately measured reset-activated stream. A nearly-complete package
  // can report eta=1 while purchases are deliberately end-loaded; treating
  // activationValue/1s as a production rate makes the renewal threshold blow
  // up exactly when a cycle is done. installCadencePushRate bounds that forward
  // estimate by value actually accrued over this cycle, so a completed package
  // remains a sample rather than masquerading as an exhausted frontier.
  const runSec = prog?.lastAugReset ? Math.max(0, (ctx.now - prog.lastAugReset) / 1000) : 0;
  const cadencePushRate = installCadencePushRate({
    runSec,
    resetValueMult,
    ...(intent?.activationValue !== undefined ? { intentActivationValue: intent.activationValue } : {}),
    ...(intent?.etaSec !== undefined ? { intentEtaSec: intent.etaSec } : {}),
    ...(intent?.marginalActivationRate !== undefined
      ? { intentMarginalActivationRate: intent.marginalActivationRate }
      : {}),
  });
  // Convert the measured nonlinear money bootstrap into an equivalent delay.
  // For cumulative y=a*t^p, the tangent at the current point reaches y=0 at
  // t*(1-1/p): that is the startup delay a steady-state stream would have to
  // pay to reproduce the observed curve. Linear production (p<=1) loses only
  // the physical install interruption; an accelerating cold start pays more,
  // without charging unrelated faction work and purchases as if they had to
  // be repeated. The exponent is the same bounded fit used by route ETA.
  const bootstrapExponent = cycleProgressExponent(progressionMemory.cyclePoints, "money");
  const measuredBootstrapDelay = bootstrapExponent !== undefined && bootstrapExponent > 1
    ? runSec * (1 - 1 / bootstrapExponent)
    : 0;
  const resetOverheadSec = Math.max(INSTALL_VERDICT_OVERHEAD_SEC, measuredBootstrapDelay);
  const rawVerdict = installVerdict({
    routeEtaKnown: selectedEta !== undefined,
    resetValueMult,
    resetOverheadSec,
    ...(cadencePushRate !== undefined ? { pushMarginalRate: cadencePushRate } : {}),
    // A published factions plan naming no intent is a concluded frontier; a
    // missing plan is a frontier that has not run yet (see installVerdict).
    // A HORIZON-STARVED objective is neither: raw candidates exist but the
    // node forecast currently prices them all out — a transient state that
    // recalibrates, and reading it as "concluded" armed a premature install
    // (irreversible once the sweep starts buying) at package boundaries.
    frontierIdle:
      factions?.plan !== undefined
      && intent === undefined
      && factions.plan.objective?.horizonStarved !== true,
  });
  // Install is irreversible: it must dwell before opening the transaction,
  // while contrary push evidence cancels immediately. The only true latch is
  // the point where the final sweep has become ready/armed.
  const pastPointOfNoReturn =
    pending.length > 0
    || factions?.plan?.drainCeiling !== undefined
    || prog?.plan?.installReady === true
    || progressionMemory.installArmedAt !== undefined;
  let marginalInstall: boolean | undefined;
  if (pastPointOfNoReturn) {
    marginalInstall = true;
  } else if (rawVerdict.verdict === "no-data") {
    marginalInstall = undefined;
  } else {
    const dwelled = dwellInstallVerdict(rawVerdict.verdict, {
      ...(progressionMemory.verdictCandidate !== undefined ? { candidate: progressionMemory.verdictCandidate } : {}),
      ...(progressionMemory.verdictCandidateSince !== undefined ? { candidateSince: progressionMemory.verdictCandidateSince } : {}),
      ...(progressionMemory.effectiveVerdict !== undefined ? { effective: progressionMemory.effectiveVerdict } : {}),
    }, ctx.now);
    progressionMemory.verdictCandidate = dwelled.state.candidate;
    progressionMemory.verdictCandidateSince = dwelled.state.candidateSince;
    progressionMemory.effectiveVerdict = dwelled.state.effective;
    marginalInstall = dwelled.install;
  }
  // On the finite Daedalus count route, a small multiplier package can clear
  // the generic renewal threshold while still being a terrible reset: it pays
  // another full cold bootstrap but barely advances the installed-count gate.
  // Do not even OPEN the end-loaded transaction until the currently funded
  // distinct set covers a target-relative early tranche. This is cadence
  // permission only; route-mandatory Red Pill/count-closure installs bypass it
  // through routeRequiresInstall and an already-started queue remains latched.
  if (marginalInstall === true && !routeRequiresInstall && !pastPointOfNoReturn && !countCadenceReady) {
    marginalInstall = false;
  }

  // The lab-cache deferral, and its deadline. The blocker is raised only while
  // `dnet` says the cache is openable RIGHT NOW, and abandoned once the window
  // has run out — so an install can never stall on a cache we do not have,
  // cannot reach, or asked for and never got.
  const labCacheOpen = ctx.state.topics.dnet?.labCache?.openable === true;
  const labCacheDefer = dnetLabCacheDeferral(labCacheOpen, ctx.now);

  const decision = stepProgression({
    queued: pending,
    ...(labCacheDefer ? { labCacheOpenable: true } : {}),
    affordableValueProduct: affordableValueProduct(ctx),
    factionWorkInProgress: ctx.state.topics.career?.currentWork?.type === "FACTION",
    // Once factions has published any plan it owns the pre-install handshake:
    // progression may reset only after the last-chance drain reports ready.
    factionsReadyToInstall:
      ctx.caps.unlocked.factions === "no" || Boolean(factions?.plan?.recommendInstall),
    factionsNeedLiquidation: Boolean(factions?.plan?.liquidationNeeded),
    // The market's OWN answer, not a scan of its positions: `flat` accounts for
    // an exit decided but not yet executed and for an entry wanted on the next
    // pass, neither of which a position snapshot can show. A market that has
    // never published a plan is not evidence of flatness, so it blocks — except
    // where there is no market to be flat at all, which the two guards cover.
    stockReadyToInstall:
      ctx.caps.unlocked.stock === "no"
      || ctx.state.topics.stock?.hasTixApiAccess !== true
      || ctx.state.topics.stock.plan?.flat === true,
    ...(purchasable !== undefined ? { purchasableAugmentation: purchasable } : {}),
    graftInProgress: ctx.state.topics.career?.currentWork?.type === "GRAFTING",
    money: player.money,
    // Distortion-corrected (see earnedSinceInstall): the raw ledger plunges by
    // an open position's whole cost, which held this figure at ~0 in a
    // market-driven run and silently disarmed phaseOf's cash-ratio install arm.
    earnedThisRun: earnedSinceInstall(ctx.state) ?? ctx.state.topics.farm?.totals?.moneyEarned ?? 0,
    factions: standings,
    favorToDonate: factions?.favorToDonate ?? 150,
    homeRam: ctx.state.topics.servers?.["home"]?.maxRam ?? 8,
    // No probe prices the home upgrade yet; Infinity keeps the budget advisory.
    homeRamUpgradeCost: Infinity,
    runSec,
    ...(selectedEta !== undefined ? { nodeRemainingSec: selectedEta.etaSec } : {}),
    routeRequiresInstall,
    optionalInstallAllowed,
    resetValueMult,
    // Banked favor may only OPEN the gate when the sweep can actually convert
    // something — any joined offer with rep met (NeuroFlux included), or a
    // donation path (favor past the donate wall on a faction with unowned
    // augs). Rep-locked value must not arm an install whose installRequested
    // then halts the very rep work that would unlock it: with nothing
    // convertible the queue stays empty and the "nothing queued yet" blocker
    // holds the reset forever, with faction work frozen.
    resetRealizable:
      realizable.size > 0
      || (bankedFavorValue > 0.01
        && ((factions?.offers ?? []).some((offer) => !offer.owned && joinedSet.has(offer.faction) && offer.affordableRep)
          || (factions?.standings ?? []).some(
            (standing) =>
              joinedSet.has(standing.name)
              && standing.favor >= favorDonateAt
              && (factions?.offers ?? []).some(
                (offer) => !offer.owned && offer.faction === standing.name,
              ),
          ))),
    ...(cadencePushRate !== undefined ? { pushMarginalRate: cadencePushRate } : {}),
    ...(intent?.etaSec !== undefined ? { pushEtaSec: intent.etaSec } : {}),
    ...(marginalInstall !== undefined ? { marginalInstall } : {}),
  });

  const queueKey = pending.join("\0");
  const persistedArm = prog?.plan?.installReady && prog.plan.installArmedAt !== undefined
    ? prog.plan.installArmedAt
    : undefined;
  if (progressionMemory.installArmedAt === undefined && persistedArm !== undefined) {
    progressionMemory.installArmedAt = persistedArm;
    progressionMemory.installQueueKey = prog?.plan?.queuedAugmentations.join("\0") ?? queueKey;
  }
  if (
    !decision.installReady
    || (progressionMemory.installQueueKey !== undefined && progressionMemory.installQueueKey !== queueKey)
  ) {
    progressionMemory.installArmedAt = undefined;
    progressionMemory.installQueueKey = undefined;
  }
  const armedAt = progressionMemory.installArmedAt;
  const cadenceRemainingSec = installCadenceRemainingSec({
    runSec,
    resetValueMult,
    ...(rawVerdict.pushRate !== undefined ? { pushMarginalRate: rawVerdict.pushRate } : {}),
    ...(bootstrapExponent !== undefined ? { bootstrapExponent } : {}),
  });

  const installBasis = JSON.stringify({
    phase: decision.phase,
    wanted: decision.installWanted,
    liquidate: decision.liquidationWanted,
    ready: decision.installReady,
    blockers: decision.installBlockers,
    optionalAllowed: optionalInstallAllowed,
    countCadenceReady,
    mandatory: selectedEta?.nextMandatoryInstall,
    queue: pending,
    intent: factions?.plan?.objective?.intent
      ? {
          faction: factions.plan.objective.intent.faction,
          repTarget: factions.plan.objective.intent.repTarget,
          augmentations: factions.plan.objective.intent.augmentations,
          purpose: factions.plan.objective.intent.purpose,
        }
      : undefined,
  });
  const previousInstallForecast = readablePlan(ctx.state)?.forecasts.install;
  const nextInstallForecast = shouldReforecast(previousInstallForecast, ctx.now, installBasis)
      ? installForecast(ctx.now, {
        installNow: decision.installReady && armedAt !== undefined,
        installWanted: decision.installWanted,
        queuedCount: pending.length,
        phase: decision.phase,
        ...(factions?.plan?.objective?.intent ? { intent: factions.plan.objective.intent } : {}),
        workMeasured: factions?.plan?.until?.kind === "rep",
        moneyMeasured: (factions?.plan?.context?.incomePerSec ?? 0) > 0,
        finalSweepReady: decision.installReady,
        ...(decision.installWanted
          && factions?.plan?.recommendInstall === undefined
          && factions?.plan?.objective?.intent?.etaSec !== undefined
            ? { committedPackageSec: factions.plan.objective.intent.etaSec }
            : {}),
        ...(cadenceRemainingSec !== undefined ? { cadenceSec: cadenceRemainingSec } : {}),
        countCadenceReady,
        optionalInstallAllowed,
        ...(selectedEta?.nextMandatoryInstall ? { mandatory: selectedEta.nextMandatoryInstall } : {}),
      }, installBasis)
    : forecastAt(previousInstallForecast!, ctx.now);
  const forecasts: PlanningHorizons = { node: nextNodeForecast, install: nextInstallForecast };
  const marginals = progressionMarginals({
    view,
    decision: endgame,
    rates,
    ...(choice ? { selectedRoute: choice.route } : {}),
    install: nextInstallForecast,
  });
  const nextBitNode = selectedEta?.complete && view.bitNode !== undefined
    ? chooseNextBitNode(view.bitNode, view.sourceFiles)
    : undefined;
  const canAutomateNodeCompletion =
    view.bitNode === 4 || (view.sourceFiles["4"] ?? 0) > 0;
  const routeAction =
    choice?.route === "bladeburner"
    && selectedStatus?.stage === "bladeburner-join"
    && view.lowestCombatSkill >= 100
      ? { type: "joinBladeburner" as const }
      : choice?.route === "gang"
        && selectedStatus?.stage === "gang-create"
        && (view.karma ?? 0) <= GANG_KARMA
        && view.gangCreateFaction
        ? {
            type: "createGang" as const,
            faction: view.gangCreateFaction,
          }
        : undefined;
  if (!selectedEta?.complete || STALL_BITNODE_COMPLETION) {
    progressionMemory.nodeCompletionArmedAt = undefined;
  }
  // "About to install" and "about to destroy the BitNode" are DIFFERENT
  // terminal modes with opposite money policies. An install preserves augs,
  // favor, and cash, so hoarding for the final sweep is right. A destroy
  // erases all three — the only surviving use of money is speeding up the
  // remaining minutes, so install-shaped reserves (aug-fund, donations) must
  // release and let infrastructure spending through. Conflating them held a
  // ~$9e14 sweep reserve while a RAM purchase that would have finished the
  // node sat outbid. Fail-open by design: if the forecast is wrong and the
  // node does NOT end, the released money bought productive RAM, not waste.
  const endingByDestroy =
    selectedEta !== undefined
    && selectedEta.etaSec < IMMINENT_INSTALL_SEC
    && selectedStatus?.mandatoryInstall === undefined
    && !routeRequiresInstall
    && decision.installWanted !== true;
  merge(ctx.state, "progression", {
    plan: {
      phase: decision.phase,
      ...(endingByDestroy ? { endingByDestroy: true } : {}),
      installWanted: decision.installWanted,
      liquidationWanted: decision.liquidationWanted,
      installBlockers: decision.installBlockers,
      installReady: decision.installReady,
      ...(armedAt !== undefined ? { installArmedAt: armedAt } : {}),
      queuedAugmentations: pending,
      ...(!routeRequiresInstall && decision.installWanted
        ? {
            installFundedAugmentations: fundedActivation
              .map((candidate) => candidate.name)
              .filter((name) => name !== NEUROFLUX),
          }
        : {}),
      install: decision.installReady && armedAt !== undefined,
      favorCrossings: decision.favorCrossings,
      // Published so `factions` prices a deep reputation breakpoint at the rate
      // it will actually be earned at. The exponents are already fitted here for
      // the bootstrap-delay term above; only the fit crosses the wire, never the
      // samples.
      pace: {
        elapsedSec: runSec,
        ...(bootstrapExponent !== undefined ? { money: bootstrapExponent } : {}),
        ...((): { hacking?: number; combat?: number } => {
          const hacking = cycleProgressExponent(progressionMemory.cyclePoints, "hacking");
          const combat = cycleProgressExponent(progressionMemory.cyclePoints, "combat");
          return {
            ...(hacking !== undefined ? { hacking } : {}),
            ...(combat !== undefined ? { combat } : {}),
          };
        })(),
        resetOverheadSec,
      },
      installDecision: {
        verdict: rawVerdict.verdict,
        effective: marginalInstall === undefined ? "legacy" : marginalInstall ? "install" : "push",
        ...(rawVerdict.pushRate !== undefined ? { pushRate: rawVerdict.pushRate } : {}),
        ...(rawVerdict.threshold !== undefined ? { threshold: rawVerdict.threshold } : {}),
        resetValueMult,
        ...(bankedFavorValue > 0 ? { resetFavorValue: bankedFavorValue } : {}),
        ...(intent?.etaSec !== undefined ? { pushEtaSec: Math.round(intent.etaSec) } : {}),
        ...(selectedEta !== undefined ? { remainingSec: Math.round(selectedEta.etaSec) } : {}),
        latched: pastPointOfNoReturn,
      },
      ...(choice
        ? {
            route: choice.route,
            decidedAt: choice.decidedAt,
          }
        : {}),
      routes: routesDigest,
      routeInstallRequired: routeRequiresInstall,
      forecasts,
      marginals,
      ...(routeAction ? { routeAction } : {}),
      ...(nextBitNode
        ? {
            completion: {
              ready: true,
              automatic: canAutomateNodeCompletion,
              nextBitNode: nextBitNode.bitNode,
              targetLevel: nextBitNode.targetLevel,
              ...(STALL_BITNODE_COMPLETION ? { stalled: true } : {}),
              ...(progressionMemory.nodeCompletionArmedAt !== undefined
                ? { armedAt: progressionMemory.nodeCompletionArmedAt }
                : {}),
              execute:
                canAutomateNodeCompletion
                && !STALL_BITNODE_COMPLETION
                && progressionMemory.nodeCompletionArmedAt !== undefined,
            },
          }
        : {}),
    },
  });
}

/** DarkscapeNavigator.exe: darknet access, and the only path to it without BN15
 * or an active SF15.
 *
 * **`progression` owns this purchase, not `dnet`, and that is forced.**
 * `driverEnabled` never ticks a driver whose own feature reads anything but
 * "yes", so a gated `dnet` can never buy its own unlock — the exact deadlock
 * `spec/features.md` records from the stock rebuild, where gating on
 * `hasWseAccount` made the account unbuyable. `progression` is always active and
 * already reads darknet availability for the endgame route, so it is the module
 * that can act. Moving this to `dnet` would silently stop it working. */
function shouldBuyDarkscape(ctx: DriverContext | NeedContext): boolean {
  const caps = ctx.caps;
  // The gate probe's raw `hasDarknetProgram` reading is consumed by
  // deriveCapabilities and not retained, but it is recoverable from the two
  // capability flags: access without full access can only have come from the
  // program. Safe because stepDarkscape returns on the BN15/SF15 guard before
  // it consults this, which is the one case where access does NOT imply the
  // file is present.
  const access = caps.unlocked.dnet;
  return stepDarkscape({
    dnetDisabled: disabledByProfile(caps, "dnet"),
    ...(caps.bitNode !== undefined ? { bitNode: caps.bitNode } : {}),
    sf15: sfLevel(caps.sourceFiles, 15),
    ...(access === "unknown" ? {} : { hasProgram: access === "yes" }),
    money: ctx.state.topics.player?.money ?? 0,
  });
}

const progression: FeatureDriver = {
  id: "progression",
  everyMs: 60_000,
  // Armed installs carry themselves pass-to-pass; the install signal covers
  // the FIRST evaluation after factions' drain concludes, which otherwise
  // waits out the 60-second cadence (game/lib/install-signal.ts).
  wake: () =>
    progressionMemory.installArmedAt !== undefined
    || progressionMemory.nodeCompletionArmedAt !== undefined
    || takeInstallSignal(),
  async tick(ctx: DriverContext) {
    const plan = readablePlan(ctx.state);
    if (plan?.completion?.ready && plan.completion.automatic && !STALL_BITNODE_COMPLETION) {
      if (progressionMemory.nodeCompletionArmedAt === undefined) {
        progressionMemory.nodeCompletionArmedAt = Date.now();
        merge(ctx.state, "progression", {
          plan: {
            ...plan,
            completion: {
              ...plan.completion,
              armedAt: progressionMemory.nodeCompletionArmedAt,
              execute: false,
            },
          },
        });
        return;
      }
      if (!plan.completion.execute || plan.completion.armedAt !== progressionMemory.nodeCompletionArmedAt) return;

      clearForCritical(ctx, "singularity.destroyW0r1dD43m0n");
      await ctx.nsp("singularity.destroyW0r1dD43m0n", plan.completion.nextBitNode, "/start.js");
      return;
    }
    if (plan?.routeAction?.type === "joinBladeburner") {
      await ctx.nsp("bladeburner.joinBladeburnerDivision");
      return;
    }

    if (shouldBuyDarkscape(ctx) && darkscapeGrantedAt !== progressionMemory.cycleResetAt) {
      // TOR first: purchaseProgram fails without it, and purchaseTor is
      // idempotent, so this is cheaper than probing for something the player
      // snapshot does not expose.
      await ctx.nsp("singularity.purchaseTor");
      // `purchaseProgram` returns TRUE for an already-owned program
      // (Singularity.ts logs "You already have..." and returns true), so a
      // true return means owned-or-bought and the latch below is safe on it.
      // False is a genuine refusal — no TOR, or the money moved between the
      // decision and this call — which retries next pass.
      const bought = await ctx.nsp("singularity.purchaseProgram", "DarkscapeNavigator.exe");
      if (bought) {
        // Latched because the gate probe only re-reads the file on its 30 s
        // sweep — without this the next few passes would re-attempt a purchase
        // that has already happened.
        darkscapeGrantedAt = progressionMemory.cycleResetAt;
        // The gate probe is what flips caps.unlocked.dnet; without this the
        // beachhead waits out the 30 s sweep (game/lib/gate-signal.ts).
        signalGateRecheck();
        record("progression", "unlock:darkscape", true, `bought for ${DARKSCAPE_TOTAL_COST}`);
      } else {
        record("progression", "unlock:darkscape", false, "purchase refused; retrying next pass");
      }
      return;
    }
    if (plan?.routeAction?.type === "createGang") {
      const faction = plan.routeAction.faction;
      await ctx.nsp("gang.createGang", faction as never);
      return;
    }
    if (!plan?.installReady) {
      progressionMemory.installArmedAt = undefined;
      progressionMemory.installQueueKey = undefined;
      return;
    }
    const queueKey = plan.queuedAugmentations.join("\0");
    if (progressionMemory.installArmedAt === undefined) {
      progressionMemory.installArmedAt = Date.now();
      progressionMemory.installQueueKey = queueKey;
      merge(ctx.state, "progression", {
        plan: { ...plan, install: false, installArmedAt: progressionMemory.installArmedAt },
      });
      return;
    }
    if (!plan.install || progressionMemory.installQueueKey !== queueKey) return;

    // The rooted callback is deliberate: relative "start.js" would resolve
    // beside the resident as lib/start.js.
    clearForCritical(ctx, "singularity.installAugmentations");
    await ctx.nsp("singularity.installAugmentations", "/start.js");
    return;
  },
};

// --- modules ----------------------------------------------------------------

const reset = (): void => {
  for (const key of Object.keys(results)) delete results[key];
};

/** Shared reset shape: drop the recorded outcomes AND this feature's
 * published topic — the digest describes a node that no longer exists, and
 * each module clears its own rather than the controller keeping a per-field
 * blacklist of what everyone publishes. */
const resetWithTopic =
  (topic: keyof GameState["topics"]) =>
  (state: GameState): void => {
    reset();
    delete state.topics[topic];
  };

export const gangModule: FeatureModule = {
  driver: gang,
  reset: resetWithTopic("gang"),
};

export const corpModule: FeatureModule = {
  driver: corp,
  reset: resetWithTopic("corp"),
  // NO money claim while corporation actions are unimplemented (the driver's
  // own contract: the stage machine plans but never executes). The old $150b
  // `corp:seed` reserve at priority 85 was doubly wrong: the corp feature only
  // unlocks once a corporation ALREADY exists (`hasCorporation` gates it), so
  // the claim could never fund the founding it named — and being a standing
  // reserve it permanently starved every investment band below 85 the moment
  // the bankroll crossed $150b. Re-post it (at `corp:seed`) the day execute()
  // spends money.
  claims: () => [],
};

export const bladeburnerModule: FeatureModule = {
  driver: bladeburner,
  reset: resetWithTopic("bladeburner"),
  claims: (ctx) => {
    const action = ctx.state.topics.bladeburner?.plan?.action.type;
    const claims: Claim[] = [];
    const hasSimulacrum = (ctx.state.topics.progression?.ownedAugs?.[BLADES_SIMULACRUM] ?? 0) > 0;
    if (action === "act" && !hasSimulacrum) {
      // ANNOUNCE THE RATE. A time claim with no `produces` is a HARD claim, and
      // hard claims outrank every priced one outright — so leaving this silent
      // would hand Bladeburner the exclusive work slot ahead of faction
      // reputation on nothing but the absence of a number. Rank is a priced
      // channel (`bladeburnerRank`), and the planner already publishes the rate
      // it would earn.
      const rankPerSec = ctx.state.topics.bladeburner?.plan?.ranked?.[0]?.rankPerSec;
      claims.push({
        by: "bladeburner",
        id: "work",
        resource: "time",
        amount: 1,
        shape: "step",
        pricing: "hard",
        value: { state: "unknown", reason: "a time claim is priced by `produces`, not by this field" },
        priority: PRIORITY["factions:work"],
        mode: "spend",
        ...(rankPerSec !== undefined && rankPerSec > 0
          ? { produces: { [BLADEBURNER_RANK_CHANNEL]: rankPerSec } }
          : {}),
      });
    }
    return claims;
  },
  needs: (ctx) => {
    // Bladeburner needs 100 in every combat stat to join at all, which career
    // owns. Posted as an outcome, never as "go to the gym".
    const skills = ctx.state.topics.player?.skills;
    if (!skills) return [];
    const weakest = Math.min(skills.strength, skills.defense, skills.dexterity, skills.agility);
    if (weakest >= 100) return [];
    return [
      {
        by: "bladeburner",
        kind: "combatSkills",
        target: 100,
        have: weakest,
        weight: 4,
        urgency: "blocking",
      },
    ];
  },
};

export const sleevesModule: FeatureModule = {
  driver: sleeves,
  reset: (state) => {
    resetSleeveCompletions();
    delete state.topics.sleeves;
  },
};

export const goModule: FeatureModule = {
  driver: go,
  reset: (state) => {
    goGeneration++;
    goTurnRunning = false;
    // goPlanning is deliberately not cleared here: its owner always clears it
    // in a finally, and clearing it early would let a fresh tick plan
    // concurrently with the reset one.
    goCompletionReady = false;
    goContinuationReady = false;
    // The topic is deleted below, so the next pass hydrates regardless; clearing
    // keeps the flag from outliving the board it described.
    goRehydrate = false;
    goRehydrateReason = undefined;
    goPredictionParent = undefined;
    goCheatSuccessByCount = undefined;
    goTurnReadyAt = undefined;
    resetGoPlaybookLine();
    goPlaybookEntry = undefined;
    // Drop board/seed work crossing a prestige. The worker itself remains the
    // single V9 owner across controller handoffs; its backend is rebuilt after
    // this reset before the successor game is evaluated.
    if (testGoRuntime) void testGoRuntime.reset();
    else resetGoNeuralWorkerRuntime();
    goTickPhase = undefined;
    goAnchorFailedAt = 0;
    delete state.topics.go;
  },
};

export const stanekModule: FeatureModule = {
  driver: stanek,
  reset: resetWithTopic("stanek"),
};


/** Positional-superko history equality. Both sides are newest-first lists of
 * board rows: the game's own `previousBoards` (go.getMoveHistory returns it
 * directly) and the mirror's copy, advanced by unshift. */
function sameGoHistory(live: readonly string[][], mirror: readonly string[][]): boolean {
  if (live.length !== mirror.length) return false;
  return live.every((position, index) => {
    const held = mirror[index];
    return held !== undefined && position.length === held.length
      && position.every((column, row) => column === held[row]);
  });
}

type GoVerification = {
  result: "match" | "drift" | "unavailable" | "skipped";
  ms: number;
  scope?: "board" | "history";
};

type GoSettledObservation = {
  bonusCycles?: number;
  player?: ReturnType<NS["getPlayer"]>;
  playerObservedAt?: number;
  verification: GoVerification;
};

/** Observe everything needed after White replies: the bonus-cycle count, the
 * player when a prediction or a finished game needs it, and the game's own
 * board and history when the local mirror is to be verified. */
async function observeGoSettledState(
  ctx: DriverContext,
  observePlayer: boolean,
  expected?: { board: readonly string[]; history: readonly string[][] },
): Promise<GoSettledObservation> {
  const startedAt = Date.now();
  const verifyMirror = expected !== undefined;
  // These are the general resident's reads, not the turn's: the move has
  // already settled, so nothing here is on the next turn's critical path.
  // getMoveHistory is free and is the authoritative check of the local
  // positional-superko history; keep it in the same settled observation.
  const player = observePlayer ? await ctx.nsp("getPlayer") : undefined;
  const playerObservedAt = player ? Date.now() : undefined;
  const live = {
    bonusCycles: (await ctx.nsp("go.getGameState")).bonusCycles,
    ...(player && playerObservedAt !== undefined ? { player, playerObservedAt } : {}),
    ...(verifyMirror ? {
      board: await ctx.nsp("go.getBoardState"),
      history: await ctx.nsp("go.getMoveHistory"),
    } : {}),
  };
  const ms = Date.now() - startedAt;
  const observed = {
    bonusCycles: live.bonusCycles,
    ...(live.player && live.playerObservedAt !== undefined
      ? { player: live.player, playerObservedAt: live.playerObservedAt }
      : {}),
  };
  if (!verifyMirror) return { ...observed, verification: { result: "skipped", ms } };
  if (!live.board?.length) return { ...observed, verification: { result: "unavailable", ms } };
  const sameBoard = live.board.length === expected.board.length
    && live.board.every((column, index) => column === expected.board[index]);
  if (!sameBoard) return { ...observed, verification: { result: "drift", ms, scope: "board" } };
  if (!sameGoHistory(live.history ?? [], expected.history)) {
    return { ...observed, verification: { result: "drift", ms, scope: "history" } };
  }
  return { ...observed, verification: { result: "match", ms } };
}

/** A dollar held through the install transaction advances the binding money
 * clock by 1 / measuredIncome seconds. Scale by how much of the install clock
 * the published money marginal actually binds. Missing income or marginal
 * evidence stays unknown; it is never fabricated as a zero curve. */
function progressionReserveValueCurve(claim: Claim, ctx: ClaimContext): ClaimValueCurve | undefined {
  if (
    claim.resource !== "money"
    || claim.shape !== "continuous"
    || (claim.id !== "imminent-install" && claim.id !== "install-freeze")
  ) return undefined;
  const marginal = ctx.state.topics.progression?.plan?.marginals?.money;
  if (!marginal || marginal.state === "unknown") return undefined;
  if (!(marginal.secondsPerRelativeRate > 0)) return { demandAt: () => 0 };

  const progression = ctx.state.topics.progression;
  // Same distortion-corrected earnings as the route rates (earnedSinceInstall).
  const earned = earnedSinceInstall(ctx.state);
  const resetAt = progression?.lastAugReset;
  const elapsedSec = resetAt === undefined ? 0 : Math.max(0, (ctx.now - resetAt) / 1_000);
  if (earned === undefined || !(earned > 0) || !(elapsedSec > 0)) return undefined;
  const incomePerSec = earned / elapsedSec;
  if (!(incomePerSec > 0)) return undefined;

  const installSec = usableForecastSec(ctx.horizons.install);
  const bindingFraction = installSec !== undefined && installSec > 0
    ? Math.min(1, marginal.secondsPerRelativeRate / installSec)
    : 1;
  const valuePerDollar = bindingFraction / incomePerSec;
  return {
    demandAt: (lambda) => Math.max(0, lambda) <= valuePerDollar ? claim.amount : 0,
  };
}

export const progressionModule: FeatureModule = {
  driver: progression,
  reset: (state: GameState, kind) => {
    reset();
    // Rates and the route choice describe the node that just ended; the next
    // one re-measures and re-decides from scratch.
    const completedCycle = progressionMemory.cyclePoints.length >= 2
      ? progressionMemory.cyclePoints
      : progressionMemory.previousCyclePoints;
    const augmentationCycles = [...progressionMemory.augmentationCycles];
    if (kind === "augmentation") {
      const next = state.topics.progression;
      const previousResetAt = progressionMemory.cycleResetAt;
      const previousAugCount = progressionMemory.cycleStartAugCount;
      if (next && previousResetAt !== undefined && previousAugCount !== undefined) {
        const completed: AugmentationCycle = {
          sec: Math.max(0, (next.lastAugReset - previousResetAt) / 1_000),
          augmentations: Math.max(0, next.augCount - previousAugCount),
        };
        if (completed.sec > 0 && completed.augmentations > 0) augmentationCycles.push(completed);
      }
    }
    progressionMemory = freshProgressionMemory();
    if (kind === "augmentation" && completedCycle) {
      progressionMemory.previousCyclePoints = completedCycle;
    }
    if (kind === "augmentation") {
      progressionMemory.augmentationCycles = augmentationCycles.slice(-6);
    }
    routeChange = undefined;
    lastRouteEmit = undefined;
    // The install that just happened wiped the program, so the next cycle must
    // be free to buy it again.
    darkscapeGrantedAt = undefined;
    resetInstallSignal();
    // A recheck raised for the dead node is moot; the post-reset path forces
    // its own sweep.
    resetGateSignal();
    // Field-level, not the whole topic: the gate batch has ALREADY written
    // the new node's bitNode/sourceFiles/ownedAugs into it by the time the
    // reset walk runs. The plan (route, ETA, phase) and the multiplier latch
    // are ours and describe the dead node — dropping the latch also re-arms
    // the progression.mults probe.
    if (state.topics.progression) {
      delete state.topics.progression.plan;
      delete state.topics.progression.multipliers;
    }
  },
  refresh: progressionRefresh,
  needs: (ctx) => {
    const plan = readablePlan(ctx.state);
    const route = plan?.route === undefined ? undefined : plan.routes?.find((candidate) => candidate.id === plan.route);
    if (!route?.needs) return [];
    return route.needs.map((need): Need => ({
      by: "progression",
      kind: need.kind,
      ...(need.subject !== undefined ? { subject: need.subject } : {}),
      target: need.target,
      have: need.have,
      weight: 5,
      urgency: "blocking",
    }));
  },
  claims: (ctx) => {
    const plan = readablePlan(ctx.state);
    // The terminal destroy asks the arbiter for nothing — no money, no work
    // slot — so once it is armed progression stops bidding rather than holding
    // the install brakes on a run that is about to end.
    if (plan?.completion?.execute && !STALL_BITNODE_COMPLETION) return [];
    // A pending route action is additive: it does NOT excuse the bankroll
    // reservations below. An unfunded createGang/joinBladeburner can stay
    // pending for many arbitration passes, and leaving the install brakes off
    // for that window lets investments spend cash the armed reset would wipe.
    const routeClaims: Claim[] = [];
    // Darknet access. Posted from routeClaims so it survives the imminent-install
    // reserve check below only when it should: the program is wiped by the very
    // install that reserve is protecting, so buying it minutes beforehand throws
    // the money away. Falling through to the brake is correct.
    if (shouldBuyDarkscape(ctx)) {
      routeClaims.push({
        by: "progression",
        id: "unlock:darkscape",
        resource: "money",
        amount: DARKSCAPE_TOTAL_COST,
        priority: PRIORITY["income:investment"],
        mode: "spend",
        // Indivisible: there is no smaller version of a program, and it cannot
        // be written (`create: null` upstream). Its complete cache payoff is
        // priced by the conservative early-BN1 matched-pair calibration.
        shape: "step",
        pricing: "economic",
        value: { state: "measured", value: DARKSCAPE_EARLY_BN1_ROUTE_SECONDS },
      });
    }

    if (!plan?.installReady) {
      // The IMMINENT-install brake: when the install forecast says the reset
      // is minutes away, everything with an install lifetime stops buying —
      // its ROI window is about to close. The reserve outranks ordinary
      // investments but not reset prerequisites; `installReady` later applies
      // the full freeze.
      const installSec = usableForecastSec(ctx.horizons.install);
      if (installSec !== undefined && installSec < IMMINENT_INSTALL_SEC) {
        routeClaims.push({
          by: "progression",
          id: "imminent-install",
          resource: "money",
          amount: ctx.state.topics.player?.money ?? 0,
          priority: PRIORITY["progression:imminent-install"],
          mode: "reserve",
          shape: "continuous",
        });
      }
      return routeClaims;
    }
    const claims: Claim[] = [...routeClaims, {
      by: "progression",
      id: "install-freeze",
      resource: "money",
      amount: ctx.state.topics.player?.money ?? 0,
      priority: PRIORITY["progression:install-freeze"],
      mode: "reserve",
      shape: "continuous",
    }];
    return claims;
  },
  valueCurve: progressionReserveValueCurve,
};

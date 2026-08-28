import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { successChance, type CrimeStats } from "../../../shared/strategy/career/crimes.ts";
import {
  factionWorkExpPerSec,
  workRepPerSec,
  type RepContext,
  type RepPerson,
} from "../../../shared/strategy/factions/rep.ts";
import { stepSleeves, type SleevesView, type SleeveTask } from "../../../shared/strategy/sleeves/decide.ts";
import type { SleeveDigest, SleevesPlan } from "../../../shared/telemetry/topics/sleeves.ts";
import {
  armSleeveCompletion,
  consumeSleeveCompletion,
  disarmSleeveCompletion,
  pendingSleeveCompletions,
  resetSleeveCompletions,
  sleeveTaskDigest,
} from "../sleeve-completion.ts";
import { merge, type GameState } from "../state.ts";
import type { WorkTaskLike } from "../work-completion.ts";
import type { DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

const SHOCK_CEILING = 50;
const SYNC_FLOOR = 50;

function taskLabel(task: SleeveTask): string {
  return `${task.type}${task.detail ? `:${task.detail}` : ""}${task.workType ? `:${task.workType}` : ""}`;
}

function sleevePerson(sleeve: SleeveDigest): RepPerson {
  const mults = sleeve.mults ?? {};
  return {
    skills: {
      hacking: sleeve.skills.hacking,
      strength: sleeve.skills.strength,
      defense: sleeve.skills.defense,
      dexterity: sleeve.skills.dexterity,
      agility: sleeve.skills.agility,
      charisma: sleeve.skills.charisma,
      intelligence: sleeve.skills.intelligence ?? 0,
    },
    mults: {
      faction_rep: mults["faction_rep"] ?? 1,
      hacking_exp: mults["hacking_exp"] ?? 1,
      strength_exp: mults["strength_exp"] ?? 1,
      defense_exp: mults["defense_exp"] ?? 1,
      dexterity_exp: mults["dexterity_exp"] ?? 1,
      agility_exp: mults["agility_exp"] ?? 1,
      charisma_exp: mults["charisma_exp"] ?? 1,
    },
  };
}

export function sleeveView(state: GameState): SleevesView | undefined {
  const topic = state.topics.sleeves;
  if (!topic) return undefined;
  const completed = pendingSleeveCompletions();
  const sleeves = (topic.sleeves ?? []).map((sleeve) => ({
    index: sleeve.index,
    shock: sleeve.shock,
    sync: sleeve.sync,
    ...(sleeve.task ? { task: { ...sleeve.task } } : {}),
    ...(completed.has(sleeve.index) ? { allowCrimeSwitch: true } : {}),
  }));
  const progression = state.topics.progression;
  const node = effectiveBitNodeMultipliers(
    progression?.bitNode,
    sfLevel(progression?.sourceFiles, 12),
    progression?.multipliers,
  ) ?? {};
  const playerMults = (state.topics.player?.mults ?? {}) as unknown as Record<string, number>;
  // The per-run option zeros every sleeve experience field in the game's work
  // formulas, while leaving money, reputation, karma, and kills intact.
  // Source: src/Work/Formulas.ts:24-35 @ v3.0.1.
  const sleeveExpEnabled = state.topics.capabilities?.restrictions.disableSleeveExpAndAugmentation !== true;
  const tasks: SleeveTask[] = [
    { type: "recovery", outcomes: [{ rates: {} }] },
    { type: "synchro", outcomes: [{ rates: {} }] },
  ];

  for (const crime of state.topics.career?.crimes ?? []) {
    // getCrimeStats returns gains calculated for the player. Undo those
    // factors before applying the working sleeve's multipliers.
    // Source: src/NetscriptFunctions/Singularity.ts:1068-1090 and
    // src/Work/Formulas.ts:58-79 @ v3.0.1.
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
    const outcomes = (topic.sleeves ?? []).map((sleeve) => {
      const mults = sleeve.mults ?? {};
      const chance = successChance(
        stats,
        {
          skills: sleeve.skills as unknown as Record<string, number>,
          mults: {
            crime_success: mults["crime_success"] ?? 1,
            crime_money: mults["crime_money"] ?? 1,
          },
        },
        { crimeSuccessRate: node["CrimeSuccessRate"] ?? 1, crimeMoney: node["CrimeMoney"] ?? 1 },
      );
      const seconds = crime.timeMs / 1_000;
      const sync = sleeve.sync / 100;
      const expectedExp = 0.25 + 0.75 * chance;
      const expRate = (skill: string): number =>
        sleeveExpEnabled
          ? expectedExp * sync * (baseExp[skill] ?? 0) * (mults[`${skill}_exp`] ?? 1)
            * (node["CrimeExpGain"] ?? 1) / seconds
          : 0;
      const moneyPerSec = chance * baseMoney * (mults["crime_money"] ?? 1)
        * (node["CrimeMoney"] ?? 1) / seconds;
      const rates = {
        combatSkills: Math.min(expRate("strength"), expRate("defense"), expRate("dexterity"), expRate("agility")),
        charisma: expRate("charisma"),
      };
      const contributions = Object.keys(baseExp)
        .map((skill) => ({ kind: "skill" as const, subject: skill, perSec: expRate(skill) }))
        .filter((entry) => entry.perSec > 0);
      // SleeveCrimeWork applies these directly rather than through shocked
      // WorkStats. Karma alone is sync-scaled; money and kills are not.
      // Source: src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts:31-50 @ v3.0.1.
      const shockExemptRates = {
        money: moneyPerSec,
        karma: chance * Math.abs(crime.karma) * sync / seconds,
        kills: chance * (crime.kills ?? 0) / seconds,
      };
      return { sleeve: sleeve.index, rates, contributions, shockExemptRates };
    });
    tasks.push({ type: "crime", detail: crime.name, outcomes });
  }

  const factionTopic = state.topics.factions;
  const repTarget = factionTopic?.plan?.until;
  if (repTarget?.kind === "rep" && repTarget.faction && factionTopic?.joined.includes(repTarget.faction)) {
    const standing = factionTopic.standings?.find((entry) => entry.name === repTarget.faction);
    const offered = factionTopic.workTypes?.[repTarget.faction] ?? [];
    const sourceFiles = progression?.sourceFiles ?? {};
    const repContext: RepContext = {
      factionWorkRepGain: node["FactionWorkRepGain"] ?? 1,
      factionWorkExpGain: node["FactionWorkExpGain"] ?? 1,
      shareBonus: state.topics.fleet?.sharePower ?? 1,
      sf15Level: sfLevel(sourceFiles, 15),
      hasFocusAug: true,
    };
    for (const workType of ["hacking", "field", "security"] as const) {
      if (!offered.includes(workType)) continue;
      const outcomes = (topic.sleeves ?? []).map((sleeve) => {
        const person = sleevePerson(sleeve);
        const sync = sleeve.sync / 100;
        const exp = sleeveExpEnabled ? factionWorkExpPerSec(workType, person, repContext, true) : {};
        const expRate = (skill: keyof typeof exp): number => (exp[skill] ?? 0) * sync;
        const rates = {
          combatSkills: Math.min(
            expRate("strength"),
            expRate("defense"),
            expRate("dexterity"),
            expRate("agility"),
          ),
          charisma: expRate("charisma"),
        };
        const contributions = [
          {
            kind: "factionRep" as const,
            subject: repTarget.faction,
            // Sleeve faction reputation is shocked later by stepSleeves, but
            // is not sync-scaled.
            // Source: src/PersonObjects/Sleeve/Work/SleeveFactionWork.ts:30-38 @ v3.0.1.
            perSec: workRepPerSec(workType, person, standing?.favor ?? 0, repContext, true),
          },
          ...Object.entries(exp).map(([skill, perSec]) => ({
            kind: "skill" as const,
            subject: skill,
            perSec: perSec * sync,
          })),
        ].filter((entry) => entry.perSec > 0);
        return { sleeve: sleeve.index, rates, contributions };
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

  return { sleeves, tasks, shockCeiling: SHOCK_CEILING, syncFloor: SYNC_FLOOR };
}

async function setSleeveTask(ctx: DriverContext, index: number, task: SleeveTask): Promise<boolean> {
  if (task.type === "recovery") return await ctx.nsp("sleeve.setToShockRecovery", index);
  if (task.type === "synchro") return await ctx.nsp("sleeve.setToSynchronize", index);
  if (task.type === "crime") return await ctx.nsp("sleeve.setToCommitCrime", index, task.detail as never);
  return Boolean(await ctx.nsp("sleeve.setToFactionWork", index, task.detail as never, task.workType as never));
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

    const plan: SleevesPlan = {
      assignments: decision.assignments.map((entry) => ({ index: entry.index, task: taskLabel(entry.task) })),
      selection: decision.assignment.choices.map((entry) => ({
        index: entry.agent.index,
        task: taskLabel(entry.task),
        score: entry.score,
      })),
      totalScore: decision.assignment.total,
      ...(topic.plan?.lastResult ? { lastResult: topic.plan.lastResult } : {}),
    };

    const completed = [...pendingSleeveCompletions()];
    if (decision.assignments.length === 0 && completed.length === 0) {
      merge(ctx.state, "sleeves", { plan });
      return;
    }

    // The final allocation may move a faction slot between sleeves. Release
    // every departing owner first so index order and swap cycles cannot make
    // setToFactionWork throw on an otherwise valid final assignment.
    const currentByIndex = new Map((topic.sleeves ?? []).map((sleeve) => [sleeve.index, sleeve.task]));
    for (const next of decision.assignments) {
      const current = currentByIndex.get(next.index);
      if (current?.type.toUpperCase() !== "FACTION" || current.detail === next.task.detail) continue;
      disarmSleeveCompletion(next.index);
      try {
        await ctx.nsp("sleeve.setToIdle", next.index);
      } catch {
        // The final setter and readback below will report the assignment as
        // refused without letting one stale index abort the whole batch.
      }
    }

    let changed = 0;
    for (const next of decision.assignments) {
      disarmSleeveCompletion(next.index);
      try {
        if (await setSleeveTask(ctx, next.index, next.task)) changed++;
      } catch {
        // Sleeve setters can throw for source-enforced exclusivity. A failed
        // member is counted as refused and the remaining assignments continue.
      }
    }
    const refused = decision.assignments.length - changed;

    const observed = new Map<number, SleeveDigest["task"] | undefined>();
    for (const sleeve of topic.sleeves ?? []) {
      const task = await ctx.nsp("sleeve.getTask", sleeve.index) as (WorkTaskLike & Record<string, unknown>) | null;
      armSleeveCompletion(sleeve.index, task);
      observed.set(sleeve.index, sleeveTaskDigest(task));
    }
    for (const index of completed) consumeSleeveCompletion(index);
    merge(ctx.state, "sleeves", {
      sleeves: (topic.sleeves ?? []).map((sleeve) => ({ ...sleeve, task: observed.get(sleeve.index) })),
      plan: {
        ...plan,
        lastResult: {
          action: "batch",
          ok: refused === 0,
          detail: refused === 0
            ? `updated ${changed} sleeves`
            : `updated ${changed} sleeves; the game refused ${refused} assignments`,
          at: Date.now(),
        },
      },
    });
  },
};

export const sleevesModule: FeatureModule = {
  driver: sleeves,
  reset: (state) => {
    resetSleeveCompletions();
    delete state.topics.sleeves;
  },
};

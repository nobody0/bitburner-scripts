import { stepGang, type GangAction } from "../../../shared/strategy/gang/decide.ts";
import { isScriptDeath } from "../errors.ts";
import { merge, type GameState } from "../state.ts";
import type { DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

type Result = { action: string; ok: boolean; detail: string; at: number };
let lastResults: Result[] = [];

function result(action: string, ok: boolean, detail: string): void {
  lastResults.push({ action, ok, detail, at: Date.now() });
}

async function execute(ctx: DriverContext, action: GangAction): Promise<void> {
  try {
    if (action.type === "warfare") {
      await ctx.nsp("gang.setTerritoryWarfare", false);
      result("warfare", true, "disabled");
      return;
    }
    if (action.type === "assign") {
      const ok = await ctx.nsp("gang.setMemberTask", action.member, action.task);
      result("assign", ok, `${action.member} -> ${action.task}`);
      return;
    }
    if (action.type === "recruit") {
      const recruited = await ctx.nsp("gang.recruitMember", action.name);
      const assigned = recruited && await ctx.nsp("gang.setMemberTask", action.name, action.task);
      result("recruit", Boolean(recruited && assigned), recruited
        ? `${action.name} -> ${action.task}${assigned ? "" : " refused"}`
        : `${action.name} refused`);
      return;
    }
    const ascended = await ctx.nsp("gang.ascendMember", action.member);
    const assigned = ascended !== undefined && await ctx.nsp("gang.setMemberTask", action.member, action.task);
    result("ascend", Boolean(ascended !== undefined && assigned), ascended === undefined
      ? `${action.member} refused`
      : `${action.member} -> ${action.task}${assigned ? "" : " refused"}`);
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    result(action.type, false, String(error));
  }
}

const driver: FeatureDriver = {
  id: "gang",
  everyMs: 10_000,
  requires: "gang",
  async tick(ctx) {
    const topic = ctx.state.topics.gang;
    if (!topic) return;
    const decision = stepGang({
      isHacking: topic.isHacking,
      respect: topic.respect,
      wantedLevel: topic.wantedLevel,
      territory: topic.territory,
      territoryWarfareEngaged: topic.territoryWarfareEngaged,
      gangSoftcap: topic.gangSoftcap,
      recruitsAvailable: topic.recruitsAvailable,
      tasks: topic.tasks,
      members: topic.members.map((member) => ({
        name: member.name,
        task: member.task,
        skills: member.skills,
        ascensionGain: topic.ascensionGain?.[member.name] ?? 0,
      })),
    });
    if (decision.actions.length > 0) lastResults = [];
    for (const action of decision.actions) await execute(ctx, action);
    merge(ctx.state, "gang", {
      plan: {
        phase: decision.phase,
        reason: decision.reason,
        actions: decision.actions,
        assignments: decision.assignments,
        ...(lastResults.length > 0 ? { lastResults: [...lastResults] } : {}),
      },
    });
  },
};

export const gangModule: FeatureModule = {
  driver,
  reset(state: GameState) {
    lastResults = [];
    delete state.topics.gang;
  },
};

import type { Action } from "../world.ts";
import { allOf, goalFrom, type Goal } from "./goal.ts";

/** String forms for the CLI (bun run sim -- --goal ...):
 *   earn:1e9            money earned from hacking >= 1e9
 *   money:1e9           player money on hand >= 1e9
 *   ram:home:512        server maxRam >= 512 (host defaults to home: ram:512)
 *   skill:100           hacking skill >= 100
 *   only:hack,grow,weaken  restrict allowed action types (sleep always allowed)
 * Repeat --goal to combine; they compose with allOf. */

export function parseGoal(spec: string): Goal {
  const [kind, ...rest] = spec.split(":");
  switch (kind) {
    case "earn":
      return goalFrom(spec, { totals: { moneyEarned: { gte: parseAmount(rest[0], spec) } } });
    case "money":
      return goalFrom(spec, { player: { money: { gte: parseAmount(rest[0], spec) } } });
    case "skill":
      return goalFrom(spec, { player: { hackingSkill: { gte: parseAmount(rest[0], spec) } } });
    case "ram": {
      const host = rest.length > 1 ? rest[0]! : "home";
      const amount = parseAmount(rest[rest.length - 1], spec);
      return goalFrom(spec, { servers: { [host]: { maxRam: { gte: amount } } } });
    }
    case "only": {
      const allowed = new Set(rest.join(":").split(","));
      allowed.add("sleep");
      return {
        id: spec,
        describe: () => `only actions: ${[...allowed].join(",")}`,
        allows: (action: Action) => allowed.has(action.type),
        done: () => true,
      };
    }
    default:
      throw new Error(`unknown goal spec: ${spec} (want earn:|money:|skill:|ram:|only:)`);
  }
}

export function parseGoals(specs: string[]): Goal {
  if (specs.length === 0) throw new Error("at least one --goal is required");
  const goals = specs.map(parseGoal);
  return goals.length === 1 ? goals[0]! : allOf(...goals);
}

function parseAmount(raw: string | undefined, spec: string): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error(`bad amount in goal spec: ${spec}`);
  }
  return value;
}

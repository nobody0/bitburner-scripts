import type { Action } from "../world.ts";
import { allOf, goalFrom, type Goal } from "./goal.ts";

/** String forms for the CLI (bun run sim -- --goal ...):
 *   earn:1e9            money earned from hacking >= 1e9
 *   money:1e9           player money on hand >= 1e9
 *   ram:home:512        server maxRam >= 512 (host defaults to home: ram:512)
 *   skill:100           hacking skill >= 100
 *   only:hack,grow,weaken  restrict allowed action types (sleep always allowed)
 *   faction:CyberSec    joined that faction
 *   rep:CyberSec:1e5    reputation with that faction >= 1e5
 * Repeat --goal to combine; they compose with allOf.
 *
 * The two faction forms are what a feature-isolation run asks for: "unlock
 * this faction within an hour", "reach this reputation". Membership is free to
 * observe, but reputation needs the singularity API, so a rep goal in a save
 * without BN4/SF4 is legitimately unreachable rather than merely unmeasured. */

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
    case "faction": {
      const name = rest.join(":");
      if (name === "") throw new Error(`bad faction in goal spec: ${spec}`);
      return {
        id: spec,
        describe: () => `joined ${name}`,
        done: (ctx) => ctx.factions.get(name)?.joined === true,
      };
    }
    case "karma": {
      // Karma is an UPPER bound on a negative number: `karma:-9` is reached by
      // going BELOW -9. Parsing it as a `gte` would make it instantly true.
      const target = Number(rest.join(":"));
      if (!Number.isFinite(target)) throw new Error(`bad karma in goal spec: ${spec}`);
      return {
        id: spec,
        describe: () => `karma <= ${target}`,
        done: (ctx) => ctx.player.karma <= target,
      };
    }
    case "augs": {
      const count = parseAmount(rest[0], spec);
      return {
        id: spec,
        describe: () => `${count} augmentations owned (installed or queued)`,
        done: (ctx) => ctx.augmentations.size >= count,
      };
    }
    case "aug": {
      const name = rest.join(":");
      if (name === "") throw new Error(`bad augmentation in goal spec: ${spec}`);
      return {
        id: spec,
        describe: () => `owns ${name}`,
        done: (ctx) => ctx.augmentations.has(name),
      };
    }
    case "favor": {
      const amount = parseAmount(rest[rest.length - 1], spec);
      const name = rest.slice(0, -1).join(":");
      if (name === "") throw new Error(`bad faction in goal spec: ${spec}`);
      return {
        id: spec,
        describe: () => `${name} favor >= ${amount}`,
        // Favor is banked ONLY at install, so this goal is unreachable without
        // one — which is exactly what makes it the install-cadence test.
        done: (ctx) => (ctx.factions.get(name)?.favor ?? 0) >= amount,
      };
    }
    case "rep": {
      const amount = parseAmount(rest[rest.length - 1], spec);
      const name = rest.slice(0, -1).join(":");
      if (name === "") throw new Error(`bad faction in goal spec: ${spec}`);
      return {
        id: spec,
        describe: () => `${name} reputation >= ${amount}`,
        done: (ctx) => (ctx.factions.get(name)?.rep ?? 0) >= amount,
      };
    }
    default:
      throw new Error(
        `unknown goal spec: ${spec} (want earn:|money:|skill:|ram:|only:|faction:|rep:|karma:|augs:|aug:|favor:)`,
      );
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

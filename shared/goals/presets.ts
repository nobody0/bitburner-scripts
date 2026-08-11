import type { Action } from "../world.ts";
import { bitNodeMultipliers, worldDaemonSkill } from "../features/bitnode.ts";
import { allOf, goalFrom, type Goal } from "./goal.ts";

/** The augmentation that makes w0r1d_d43m0n reachable. Not a free-text name:
 * it is load-bearing in `bn:` and a typo would make the goal unreachable
 * rather than failing loudly. */
const RED_PILL = "The Red Pill";

/** String forms for the CLI (bun run sim -- --goal ...):
 *   earn:1e9            money earned from hacking >= 1e9
 *   money:1e9           player money on hand >= 1e9
 *   wealth:1e9          cash + stock liquidation value >= 1e9
 *   ram:home:512        server maxRam >= 512 (host defaults to home: ram:512)
 *   skill:100           hacking skill >= 100
 *   only:hack,grow,weaken  restrict allowed action types (sleep always allowed)
 *   faction:CyberSec    joined that faction
 *   rep:CyberSec:1e5    reputation with that faction >= 1e5
 *   daedalus / daedalus:6   Daedalus's invite gate for that BitNode
 *   redpill             owns The Red Pill
 *   installs:2          two destructive augmentation installs
 *   wd / wd:14          hacking >= that node's w0r1d_d43m0n requirement
 *   bn / bn:6           the whole node: daedalus, then redpill, then wd
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
    case "wealth": {
      const target = parseAmount(rest[0], spec);
      const current = (ctx: Parameters<Goal["done"]>[0]) =>
        ctx.stockWealth ?? ctx.player.money + ctx.stockPortfolioValue;
      return {
        id: spec,
        describe: () => `cash plus stock liquidation value >= ${target}`,
        remainingMoney: (ctx) => Math.max(0, target - current(ctx)),
        done: (ctx) => current(ctx) >= target,
      };
    }
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
    case "installs": {
      const count = parseAmount(rest[0], spec);
      return {
        id: spec,
        describe: () => `${count} augmentation installs`,
        done: (ctx) => ctx.installs >= count,
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
    // --- BitNode milestones -------------------------------------------------
    // The composed "beat this node" goal, which is what makes time-to-BitNode
    // measurable at all. Node-parameterised rather than BN1-only, because the
    // two numbers that move (`DaedalusAugsRequirement` and the w0r1d_d43m0n
    // skill) are exactly what `shared/features/bitnode.ts` now knows for free.
    case "daedalus": {
      // BN12's requirement also depends on the SF12 level, which a goal spec
      // has no way to carry; level 0 is assumed, and the difference is one
      // augmentation until SF12 is very deep (31 at level 0, 32 by level 50).
      const node = rest.length > 0 ? parseAmount(rest[0], spec) : 1;
      const mults = bitNodeMultipliers(node);
      if (!mults) throw new Error(`unknown BitNode in goal spec: ${spec}`);
      const augs = mults.DaedalusAugsRequirement!;
      return {
        id: spec,
        describe: () => `Daedalus invite in BN${node}: ${augs} augs, $100b, hacking 2500`,
        // Daedalus accepts hacking 2500 OR all four combat at 1500. Only the
        // hacking branch is expressible here — GoalContext carries no combat
        // skills — so this is the hacking route's milestone specifically, and
        // a combat-route run would satisfy Daedalus without satisfying this.
        done: (ctx) =>
          ctx.augmentations.size >= augs && ctx.player.money >= 100e9 && ctx.player.hackingSkill >= 2500,
      };
    }
    case "redpill":
      return {
        id: spec,
        describe: () => `owns ${RED_PILL}`,
        done: (ctx) => ctx.augmentations.has(RED_PILL),
      };
    case "wd": {
      const node = rest.length > 0 ? parseAmount(rest[0], spec) : 1;
      const skill = worldDaemonSkill(node);
      if (skill === undefined) throw new Error(`unknown BitNode in goal spec: ${spec}`);
      return {
        id: spec,
        describe: () => `hacking ${skill} — w0r1d_d43m0n in BN${node}`,
        done: (ctx) => ctx.player.hackingSkill >= skill,
      };
    }
    case "bn": {
      // The whole node, in the order the constraints bind. The skill goal is
      // deliberately LAST and separate from `daedalus`: owning The Red Pill
      // requires an install, which resets hacking to 1, so "reach 2500" and
      // "reach the w0r1d_d43m0n level" are two different climbs with a reset
      // between them. Collapsing them would hide a whole regrow phase.
      const node = rest.length > 0 ? parseAmount(rest[0], spec) : 1;
      return allOf(parseGoal(`daedalus:${node}`), parseGoal("redpill"), parseGoal(`wd:${node}`));
    }
    default:
      throw new Error(
        `unknown goal spec: ${spec} ` +
          `(want earn:|money:|wealth:|skill:|ram:|only:|faction:|rep:|karma:|augs:|aug:|favor:|installs:|daedalus:|redpill|wd:|bn:)`,
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

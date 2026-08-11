import type { Action } from "../world.ts";

/** Goals are predicates over the recorded state stream (spec/goals.md): the
 * same GoalContext is reduced from LogRecords whether they came from the live
 * game or the simulator, so "did we reach the goal, and when" has exactly one
 * implementation. */

export interface GoalPlayer {
  money: number;
  hackingSkill: number;
  hackingExp: number;
  /** Negative and decreasing; a karma goal is an UPPER bound. */
  karma: number;
  numPeopleKilled: number;
}

export interface GoalServer {
  hostname: string;
  hasAdminRights: boolean;
  purchasedByPlayer: boolean;
  moneyAvailable: number;
  moneyMax: number;
  hackDifficulty: number;
  maxRam: number;
}

export interface GoalFaction {
  name: string;
  joined: boolean;
  rep: number;
  favor: number;
}

export interface GoalContext {
  time: number;
  player: GoalPlayer;
  servers: Map<string, GoalServer>;
  totals: { moneyEarned: number; hacks: number };
  /** Liquidation value of the stock book from the latest authoritative stock
   * topic. Kept separate from cash so ordinary `money:` goals still mean money
   * on hand, while `wealth:` can measure a trading policy without forcing a
   * gratuitous sale merely to trip the benchmark. */
  stockPortfolioValue: number;
  /** Coherent cash + liquidation value published by the stock feature. Once
   * present, wealth goals ignore independently timed player/position records. */
  stockWealth?: number;
  /** Faction membership and standing, for feature-isolation goals. Membership
   *  is free (Player.factions); rep needs the singularity API, so it stays 0
   *  without BN4/SF4 and a rep goal is simply unreachable there. */
  factions: Map<string, GoalFaction>;
  /** Augmentations OWNED — installed or queued, matching what
   *  `ns.singularity.getOwnedAugmentations(true)` reports. These goals are
   *  acquisition-oriented; positive faction augmentation gates differ and
   *  count installed entries only. */
  augmentations: Set<string>;
  /** Destructive augmentation installs observed in this run. */
  installs: number;
}

/** Sim-only initial conditions a goal may demand. */
export interface GoalSetup {
  homeRam?: number;
  startingMoney?: number;
}

export interface Goal {
  id: string;
  describe(): string;
  setup?: GoalSetup;
  /** Strategy-space restriction ("do ONLY hacking"). The driver filters
   * planner output through this and emits action.blocked for the rest. */
  allows?(action: Action): boolean;
  /** Money still needed, when the goal is money-shaped. Sets the switching
   * horizon: prep time is amortized against how long the goal will last. */
  remainingMoney?(ctx: GoalContext): number;
  done(ctx: GoalContext): boolean;
}

export interface Cmp {
  gte?: number;
  lte?: number;
}

function matches(value: number, cmp: Cmp): boolean {
  if (cmp.gte !== undefined && !(value >= cmp.gte)) return false;
  if (cmp.lte !== undefined && !(value <= cmp.lte)) return false;
  return true;
}

/** Declarative minimum-state form, compiled into a predicate. */
export interface StateConstraints {
  player?: Partial<Record<keyof GoalPlayer, Cmp>>;
  servers?: Record<string, Partial<Record<"moneyAvailable" | "moneyMax" | "maxRam" | "hackDifficulty", Cmp>> & { hasAdminRights?: boolean }>;
  totals?: Partial<Record<"moneyEarned" | "hacks", Cmp>>;
}

export function goalFrom(id: string, constraints: StateConstraints, setup?: GoalSetup): Goal {
  // Money-shaped goals expose their remaining distance so the switching
  // horizon can amortize prep time against how long the goal will last.
  const earnedTarget = constraints.totals?.moneyEarned?.gte;
  const moneyTarget = earnedTarget ?? constraints.player?.money?.gte;
  const progress =
    earnedTarget !== undefined
      ? (ctx: GoalContext) => ctx.totals.moneyEarned
      : (ctx: GoalContext) => ctx.player.money;
  return {
    id,
    setup,
    describe: () => `${id}: ${JSON.stringify(constraints)}`,
    remainingMoney: moneyTarget !== undefined ? (ctx) => Math.max(0, moneyTarget - progress(ctx)) : undefined,
    done(ctx) {
      for (const [field, cmp] of Object.entries(constraints.player ?? {})) {
        if (!matches(ctx.player[field as keyof GoalPlayer], cmp)) return false;
      }
      for (const [field, cmp] of Object.entries(constraints.totals ?? {})) {
        if (!matches(ctx.totals[field as "moneyEarned" | "hacks"], cmp)) return false;
      }
      for (const [hostname, wants] of Object.entries(constraints.servers ?? {})) {
        const server = ctx.servers.get(hostname);
        if (!server) return false;
        for (const [field, want] of Object.entries(wants)) {
          if (field === "hasAdminRights") {
            if (server.hasAdminRights !== want) return false;
          } else if (!matches(server[field as "moneyAvailable" | "moneyMax" | "maxRam" | "hackDifficulty"], want as Cmp)) {
            return false;
          }
        }
      }
      return true;
    },
  };
}

/** Compose sub-goals: done = all done; allows = intersection; setup = merged. */
export function allOf(...goals: Goal[]): Goal {
  const restricting = goals.filter((g) => g.allows);
  return {
    id: goals.map((g) => g.id).join("+"),
    describe: () => goals.map((g) => g.describe()).join(" AND "),
    setup: goals.reduce<GoalSetup | undefined>(
      (acc, g) => (g.setup ? { ...acc, ...g.setup } : acc),
      undefined,
    ),
    allows: restricting.length > 0 ? (a) => restricting.every((g) => g.allows!(a)) : undefined,
    done: (ctx) => goals.every((g) => g.done(ctx)),
  };
}

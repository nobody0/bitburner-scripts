import type { LogRecord } from "../telemetry/schema.ts";
import type { GoalContext, GoalFaction, GoalServer } from "./goal.ts";

/** The single goal stream→state reducer. Consumes compatible LogRecords (live
 * game, live sim, or a replayed JSONL) and maintains the GoalContext goals
 * evaluate against. The browser keeps a separate, UI-shaped projection.
 * State keys follow the watched-getter convention: `getPlayer`,
 * `getServer:<host>`; totals accumulate from hack.done events. */

export function initialContext(): GoalContext {
  return {
    time: 0,
    player: { money: 0, hackingSkill: 1, hackingExp: 0, karma: 0, numPeopleKilled: 0 },
    servers: new Map(),
    totals: { moneyEarned: 0, hacks: 0 },
    stockPortfolioValue: 0,
    factions: new Map(),
    augmentations: new Set(),
    installedAugmentations: new Set(),
    installs: 0,
  };
}

interface FactionsData {
  joined?: string[];
  standings?: { name?: string; rep?: number; favor?: number }[];
  ownedAugs?: string[];
}

function applyFactions(ctx: GoalContext, data: FactionsData): void {
  const upsert = (name: string): GoalFaction => {
    const existing = ctx.factions.get(name);
    if (existing) return existing;
    const fresh: GoalFaction = { name, joined: false, rep: 0, favor: 0 };
    ctx.factions.set(name, fresh);
    return fresh;
  };
  // Membership lasts only until the next augmentation install. A factions
  // topic is an authoritative snapshot, so clear the previous cycle before
  // applying the currently joined set. Reputation/favor remain useful history
  // for factions that are not joined in this cycle.
  for (const faction of ctx.factions.values()) faction.joined = false;
  for (const name of data.joined ?? []) upsert(name).joined = true;
  // Accumulated, never replaced: the probe caps its list, and an augmentation
  // already seen does not stop being owned because a later digest was
  // truncated.
  for (const aug of data.ownedAugs ?? []) ctx.augmentations.add(aug);
  for (const standing of data.standings ?? []) {
    if (typeof standing.name !== "string") continue;
    const faction = upsert(standing.name);
    if (typeof standing.rep === "number") faction.rep = standing.rep;
    if (typeof standing.favor === "number") faction.favor = standing.favor;
  }
}

interface PlayerData {
  money?: number;
  skills?: { hacking?: number };
  exp?: { hacking?: number };
  karma?: number;
  numPeopleKilled?: number;
}

interface ProgressionData {
  ownedAugs?: Record<string, number>;
}

interface ServerData {
  hostname?: string;
  hasAdminRights?: boolean;
  purchasedByPlayer?: boolean;
  moneyAvailable?: number;
  moneyMax?: number;
  hackDifficulty?: number;
  maxRam?: number;
}

/** Mutates and returns ctx (hot path: one call per record). */
export function reduceRecord(ctx: GoalContext, record: LogRecord): GoalContext {
  ctx.time = record.t;

  if (record.kind === "state") {
    if (record.key === "getPlayer" || record.key === "player") {
      const data = record.data as PlayerData;
      if (typeof data.money === "number") ctx.player.money = data.money;
      if (typeof data.skills?.hacking === "number") ctx.player.hackingSkill = data.skills.hacking;
      if (typeof data.exp?.hacking === "number") ctx.player.hackingExp = data.exp.hacking;
      if (typeof data.karma === "number") ctx.player.karma = data.karma;
      if (typeof data.numPeopleKilled === "number") ctx.player.numPeopleKilled = data.numPeopleKilled;
    } else if (record.key.startsWith("getServer:")) {
      applyServer(ctx, record.data as ServerData, record.key.slice("getServer:".length));
    } else if (record.key === "servers") {
      // Typed topic from StateMap: a whole Record<hostname, Server> at once.
      for (const [hostname, data] of Object.entries(record.data as Record<string, ServerData>)) {
        applyServer(ctx, data, hostname);
      }
    } else if (record.key === "factions") {
      applyFactions(ctx, record.data as FactionsData);
    } else if (record.key === "progression") {
      const data = record.data as ProgressionData;
      if (data.ownedAugs) {
        ctx.installedAugmentations = new Set(
          Object.entries(data.ownedAugs)
            .filter(([, level]) => level > 0)
            .map(([name]) => name),
        );
      }
    } else if (record.key === "farm") {
      // Dispatcher rollup: cumulative totals are authoritative (they replace
      // per-op hack.done accumulation, which only exists in verbose runs).
      const data = record.data as { totals?: { moneyEarned?: number; hacks?: number } };
      if (typeof data.totals?.moneyEarned === "number") ctx.totals.moneyEarned = data.totals.moneyEarned;
      if (typeof data.totals?.hacks === "number") ctx.totals.hacks = data.totals.hacks;
    } else if (record.key === "stock") {
      const data = record.data as { portfolioValue?: number; wealth?: number };
      if (typeof data.portfolioValue === "number") ctx.stockPortfolioValue = data.portfolioValue;
      if (typeof data.wealth === "number") ctx.stockWealth = data.wealth;
    }
    return ctx;
  }

  if (record.kind === "event" && record.name === "hack.done") {
    return reduceHackDone(ctx, record);
  }
  if (record.kind === "event" && record.name === "aug.installed") ctx.installs++;
  return ctx;
}

function applyServer(ctx: GoalContext, data: ServerData, fallbackHostname: string): void {
  const hostname = data.hostname ?? fallbackHostname;
  const server: GoalServer = ctx.servers.get(hostname) ?? {
    hostname,
    hasAdminRights: false,
    purchasedByPlayer: false,
    moneyAvailable: 0,
    moneyMax: 0,
    hackDifficulty: 0,
    maxRam: 0,
  };
  if (typeof data.hasAdminRights === "boolean") server.hasAdminRights = data.hasAdminRights;
  if (typeof data.purchasedByPlayer === "boolean") server.purchasedByPlayer = data.purchasedByPlayer;
  if (typeof data.moneyAvailable === "number") server.moneyAvailable = data.moneyAvailable;
  if (typeof data.moneyMax === "number") server.moneyMax = data.moneyMax;
  if (typeof data.hackDifficulty === "number") server.hackDifficulty = data.hackDifficulty;
  if (typeof data.maxRam === "number") server.maxRam = data.maxRam;
  ctx.servers.set(hostname, server);
}

function reduceHackDone(ctx: GoalContext, record: LogRecord & { kind: "event" }): GoalContext {
  const data = record.data as { success?: boolean; moneyGained?: number } | undefined;
  if (data?.success && typeof data.moneyGained === "number") {
    ctx.totals.moneyEarned += data.moneyGained;
    ctx.totals.hacks += 1;
  }
  return ctx;
}

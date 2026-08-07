import type { LogRecord } from "../telemetry/schema.ts";
import type { GoalContext, GoalServer } from "./goal.ts";

/** The single goal stream→state reducer. Consumes compatible LogRecords (live
 * game, live sim, or a replayed JSONL) and maintains the GoalContext goals
 * evaluate against. The browser keeps a separate, UI-shaped projection.
 * State keys follow the watched-getter convention: `getPlayer`,
 * `getServer:<host>`; totals accumulate from hack.done events. */

export function initialContext(): GoalContext {
  return {
    time: 0,
    player: { money: 0, hackingSkill: 1, hackingExp: 0 },
    servers: new Map(),
    totals: { moneyEarned: 0, hacks: 0 },
  };
}

interface PlayerData {
  money?: number;
  skills?: { hacking?: number };
  exp?: { hacking?: number };
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
    } else if (record.key.startsWith("getServer:")) {
      applyServer(ctx, record.data as ServerData, record.key.slice("getServer:".length));
    } else if (record.key === "servers") {
      // Typed topic from StateMap: a whole Record<hostname, Server> at once.
      for (const [hostname, data] of Object.entries(record.data as Record<string, ServerData>)) {
        applyServer(ctx, data, hostname);
      }
    }
    return ctx;
  }

  if (record.kind === "event" && record.name === "hack.done") {
    return reduceHackDone(ctx, record);
  }
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

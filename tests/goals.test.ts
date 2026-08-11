import { describe, expect, test } from "bun:test";
import { initialContext, reduceRecord } from "../shared/goals/evaluate.ts";
import { goalFrom } from "../shared/goals/goal.ts";
import { parseGoal, parseGoals } from "../shared/goals/presets.ts";
import type { LogRecord } from "../shared/telemetry/schema.ts";

function record(partial: Partial<LogRecord> & { kind: LogRecord["kind"] }, t = 0): LogRecord {
  return { seq: 0, t, run: "test", src: "sim", ...partial } as LogRecord;
}

describe("evaluate.reduceRecord", () => {
  test("reduces player and server state, accumulates hack totals", () => {
    const ctx = initialContext();
    reduceRecord(ctx, record({ kind: "state", key: "getPlayer", data: { money: 5, skills: { hacking: 3 } } }, 10));
    reduceRecord(ctx, record({ kind: "state", key: "getServer:home", data: { hostname: "home", maxRam: 32 } }, 20));
    reduceRecord(ctx, record({ kind: "event", name: "hack.done", data: { success: true, moneyGained: 100 } }, 30));
    reduceRecord(ctx, record({ kind: "event", name: "hack.done", data: { success: false, moneyGained: 0 } }, 40));

    expect(ctx.player.money).toBe(5);
    expect(ctx.player.hackingSkill).toBe(3);
    expect(ctx.servers.get("home")!.maxRam).toBe(32);
    expect(ctx.totals).toEqual({ moneyEarned: 100, hacks: 1 });
    expect(ctx.stockPortfolioValue).toBe(0);
    expect(ctx.time).toBe(40);
  });

  test("reduces the typed 'servers' record topic", () => {
    const ctx = initialContext();
    reduceRecord(
      ctx,
      record({
        kind: "state",
        key: "servers",
        data: {
          home: { hostname: "home", maxRam: 8, hasAdminRights: true },
          n00dles: { hostname: "n00dles", moneyAvailable: 70000, hasAdminRights: false },
        },
      }),
    );
    expect(ctx.servers.get("home")!.hasAdminRights).toBe(true);
    expect(ctx.servers.get("n00dles")!.moneyAvailable).toBe(70000);
  });
});

describe("goals", () => {
  test("goalFrom compiles declarative constraints", () => {
    const goal = goalFrom("test", {
      player: { money: { gte: 100 } },
      servers: { home: { maxRam: { gte: 64 } } },
    });
    const ctx = initialContext();
    expect(goal.done(ctx)).toBe(false);
    ctx.player.money = 150;
    reduceRecord(ctx, record({ kind: "state", key: "getServer:home", data: { hostname: "home", maxRam: 64 } }));
    expect(goal.done(ctx)).toBe(true);
  });

  test("parseGoal handles all preset kinds", () => {
    expect(parseGoal("earn:1e6").id).toBe("earn:1e6");
    const wealth = parseGoal("wealth:100");
    const wealthCtx = initialContext();
    wealthCtx.player.money = 40;
    wealthCtx.stockPortfolioValue = 60;
    expect(wealth.done(wealthCtx)).toBe(true);
    expect(wealth.remainingMoney!(wealthCtx)).toBe(0);
    expect(parseGoal("ram:512").describe()).toContain("home");
    expect(parseGoal("ram:pserv-0:128").describe()).toContain("pserv-0");
    const only = parseGoal("only:hack,weaken");
    expect(only.allows!({ type: "hack", target: "x", source: "home", threads: 1 })).toBe(true);
    expect(only.allows!({ type: "sleep", ms: 1 })).toBe(true);
    expect(only.allows!({ type: "buyServer", ram: 64, name: "p" })).toBe(false);
    expect(() => parseGoal("bogus:1")).toThrow("unknown goal spec");
  });

  test("stock topics feed wealth at liquidation value without changing cash", () => {
    const ctx = initialContext();
    reduceRecord(ctx, record({ kind: "state", key: "getPlayer", data: { money: 25 } }));
    reduceRecord(ctx, record({ kind: "state", key: "stock", data: { portfolioValue: 80 } }));
    expect(parseGoal("wealth:100").done(ctx)).toBe(true);
    expect(parseGoal("money:100").done(ctx)).toBe(false);
  });

  test("wealth uses the stock feature's coherent snapshot around trades", () => {
    const ctx = initialContext();
    reduceRecord(ctx, record({ kind: "state", key: "player", data: { money: 950 } }, 1));
    reduceRecord(ctx, record({ kind: "state", key: "stock", data: { portfolioValue: 100, wealth: 900 } }, 2));

    // 950 + 100 is an impossible mixed-time view (cash from before the buy,
    // holdings from after it). The feature's atomic snapshot is authoritative.
    const wealth = parseGoal("wealth:1000");
    expect(wealth.done(ctx)).toBe(false);
    expect(wealth.remainingMoney!(ctx)).toBe(100);
  });

  test("allOf combines done, allows, and setup", () => {
    const combined = parseGoals(["earn:100", "only:hack"]);
    const ctx = initialContext();
    expect(combined.done(ctx)).toBe(false);
    ctx.totals.moneyEarned = 100;
    expect(combined.done(ctx)).toBe(true);
    expect(combined.allows!({ type: "grow", target: "x", source: "home", threads: 1 })).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import type { NS, ProcessInfo, Server } from "@ns";
import {
  deployStarters,
  HOME_RESERVE_GB,
  planDeploy,
  STARTER_RAM,
  STARTER_SCRIPT,
  type ProcessSnapshot,
} from "../../game/lib/net.ts";

function server(hostname: string, maxRam: number, ramUsed: number, overrides: Partial<Server> = {}): Server {
  return {
    hostname,
    maxRam,
    ramUsed,
    hasAdminRights: true,
    purchasedByPlayer: false,
    ...overrides,
  } as Server;
}

function process(target: string, threads: number, overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    filename: STARTER_SCRIPT,
    threads,
    args: [target],
    pid: 1,
    temporary: false,
    ...overrides,
  };
}

function plansFor(host: Server, processes: ProcessInfo[], target = "joesguns") {
  return planDeploy({ [host.hostname]: host }, { [host.hostname]: processes }, target);
}

describe("starter deployment planning", () => {
  test("reclaims a full old-target starter at its complete thread count", () => {
    const host = server("n00dles", 16, 6 * STARTER_RAM);
    expect(plansFor(host, [process("foodnstuff", 6)])).toEqual([
      { hostname: "n00dles", threads: 6, replace: true },
    ]);
  });

  test("preserves RAM used by unrelated scripts", () => {
    const starterThreads = 4;
    const unrelatedRam = 4.8;
    const host = server("n00dles", 16, starterThreads * STARTER_RAM + unrelatedRam);
    const processes = [
      process("foodnstuff", starterThreads),
      process("", 2, { filename: "user-script.js", args: [] }),
    ];
    expect(plansFor(host, processes)).toEqual([{ hostname: "n00dles", threads: 4, replace: true }]);
  });

  test("leaves one correctly targeted starter untouched", () => {
    const host = server("n00dles", 16, 4 * STARTER_RAM);
    expect(plansFor(host, [process("joesguns", 4)])).toEqual([]);
  });

  test("starts a missing worker from currently free RAM", () => {
    const host = server("n00dles", 16, 4);
    expect(plansFor(host, [])).toEqual([{ hostname: "n00dles", threads: 5, replace: false }]);
  });

  test("keeps the home reserve", () => {
    const home = server("home", 32, 2);
    const [plan] = plansFor(home, []);
    expect(plan).toEqual({
      hostname: "home",
      threads: Math.floor((32 - 2 - HOME_RESERVE_GB) / STARTER_RAM),
      replace: false,
    });
  });

  test("preserves an old worker when replacement cannot fit", () => {
    const home = server("home", 8, STARTER_RAM);
    expect(plansFor(home, [process("foodnstuff", 1)])).toEqual([]);
  });
});

describe("starter deployment effects", () => {
  test("reports a failed launch so a fresh process snapshot can retry it", async () => {
    const calls: unknown[][] = [];
    const stubNs = {
      scp: async (...args: unknown[]) => {
        calls.push(["scp", ...args]);
        return true;
      },
      scriptKill: (...args: unknown[]) => {
        calls.push(["scriptKill", ...args]);
        return true;
      },
      exec: (...args: unknown[]) => {
        calls.push(["exec", ...args]);
        return 0;
      },
    } as unknown as NS;

    const result = await deployStarters(
      stubNs,
      [{ hostname: "n00dles", threads: 6, replace: true }],
      "joesguns",
    );
    expect(result).toEqual({ started: [], failed: ["n00dles"] });
    expect(calls.map((call) => call[0])).toEqual(["scp", "scriptKill", "exec"]);

    const retryProcesses: ProcessSnapshot = { n00dles: [] };
    expect(planDeploy({ n00dles: server("n00dles", 16, 0) }, retryProcesses, "joesguns")).toEqual([
      { hostname: "n00dles", threads: 6, replace: false },
    ]);
  });

  test("does not kill an old worker when the remote copy fails", async () => {
    let killed = false;
    const stubNs = {
      scp: async () => false,
      scriptKill: () => {
        killed = true;
        return true;
      },
      exec: () => 1,
    } as unknown as NS;

    const result = await deployStarters(
      stubNs,
      [{ hostname: "n00dles", threads: 6, replace: true }],
      "joesguns",
    );
    expect(result).toEqual({ started: [], failed: ["n00dles"] });
    expect(killed).toBe(false);
  });
});

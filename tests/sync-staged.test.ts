import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseSyncControl, SYNC_CONTROL_FILE } from "../shared/deployment.ts";
import type { BitburnerConfig } from "../tools/config.ts";
import type { RfaSession } from "../tools/rfa-session.ts";
import { runSync } from "../tools/sync.ts";

const buildDir = `build-test-sync-staged-${process.pid}`;
const config: BitburnerConfig = {
  host: "127.0.0.1",
  port: 12525,
  server: "home",
  buildDir,
  entries: [
    { source: "game/start.ts", target: "start.js" },
    { source: "game/main.ts", target: "main.js" },
    { source: "game/lib/ns-resident.ts", target: "lib/ns-resident.js" },
  ],
};

afterAll(async () => rm(buildDir, { recursive: true, force: true }));

function fakeSession(refuseDelete = false): { session: RfaSession; events: string[] } {
  const events: string[] = [];
  const session = {
    getAllServers: async () => [
      { hostname: "home", hasAdminRights: true, purchasedByPlayer: false },
      { hostname: "n00dles", hasAdminRights: true, purchasedByPlayer: false },
    ],
    pushFile: async (_server: string, filename: string, content: string) => {
      const control = filename === SYNC_CONTROL_FILE ? parseSyncControl(content) : undefined;
      events.push(control ? "staged" : `push:${filename}`);
    },
    getFileNames: async (host: string) => {
      events.push(`list:${host}`);
      return host === "home" ? ["start.js", "lib/ns-resident.js", "lib/old.js"] : ["lib/old.js"];
    },
    deleteFile: async (host: string, filename: string) => {
      events.push(`delete:${host}:${filename}`);
      return !refuseDelete;
    },
  } as unknown as RfaSession;
  return { session, events };
}

describe("staged sync", () => {
  test("stages the complete build before requesting activation", async () => {
    const { session, events } = fakeSession();
    await runSync(session, config, {}, () => {});
    expect(events.indexOf("push:main.js")).toBeLessThan(events.indexOf("push:start.js"));
    expect(events.indexOf("delete:home:lib/old.js")).toBeGreaterThan(events.indexOf("push:main.js"));
    expect(events.indexOf("staged")).toBeGreaterThan(events.indexOf("push:start.js"));
    expect(events.at(-1)).toBe("staged");
  });

  test("a blocked stale sweep does not prevent staging", async () => {
    const { session, events } = fakeSession(true);
    const logs: string[] = [];
    await runSync(session, config, {}, (line) => logs.push(line));
    expect(logs.some((line) => line.startsWith("deferred stale sweep"))).toBe(true);
    expect(events.at(-1)).toBe("staged");
  });
});

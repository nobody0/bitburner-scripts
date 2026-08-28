import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseSyncControl, syncControl, SYNC_CONTROL_FILE } from "../shared/deployment.ts";
import type { BitburnerConfig } from "../tools/config.ts";
import type { RfaSession } from "../tools/rfa-session.ts";
import { runSync } from "../tools/sync.ts";

const buildDir = `build-test-sync-transaction-${process.pid}`;
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
  let ready: string | undefined;
  const session = {
    getAllServers: async () => [
      { hostname: "home", hasAdminRights: true, purchasedByPlayer: false },
      { hostname: "n00dles", hasAdminRights: true, purchasedByPlayer: false },
    ],
    pushFile: async (_server: string, filename: string, content: string) => {
      const control = filename === SYNC_CONTROL_FILE ? parseSyncControl(content) : undefined;
      events.push(control ? control.phase : `push:${filename}`);
      if (control?.phase === "prepare") {
        ready = syncControl({ id: control.id, phase: "ready" });
      }
    },
    getFile: async () => ready,
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

describe("clean sync transaction", () => {
  test("waits for ready, pushes, sweeps, and commits last", async () => {
    const { session, events } = fakeSession();
    await runSync(session, config, {}, () => {});
    expect(events[0]).toBe("prepare");
    expect(events.indexOf("push:start.js")).toBeGreaterThan(events.indexOf("prepare"));
    expect(events.indexOf("push:main.js")).toBeGreaterThan(events.indexOf("push:start.js"));
    expect(events.indexOf("delete:home:lib/old.js")).toBeGreaterThan(events.indexOf("push:main.js"));
    expect(events.at(-1)).toBe("commit");
  });

  test("never commits a deployment whose stale sweep fails", async () => {
    const { session, events } = fakeSession(true);
    await expect(runSync(session, config, {}, () => {})).rejects.toThrow("failed to delete stale file");
    expect(events).not.toContain("commit");
  });
});

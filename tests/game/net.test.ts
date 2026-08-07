import { describe, expect, test } from "bun:test";
import type { Server } from "@ns";
import { canRoot, isUseful } from "../../game/lib/net.ts";

function server(overrides: Partial<Server> = {}): Server {
  return {
    hostname: "target",
    hasAdminRights: false,
    maxRam: 16,
    ramUsed: 0,
    openPortCount: 0,
    numOpenPortsRequired: 2,
    sshPortOpen: false,
    ftpPortOpen: false,
    smtpPortOpen: false,
    httpPortOpen: false,
    sqlPortOpen: false,
    ...overrides,
  } as Server;
}

describe("canRoot", () => {
  test("counts only crackers for ports that are still closed", () => {
    expect(canRoot(server(), ["BruteSSH.exe"])).toBe(false);
    expect(canRoot(server(), ["BruteSSH.exe", "FTPCrack.exe"])).toBe(true);
    // One port already open: a single cracker suffices.
    expect(canRoot(server({ openPortCount: 1, sshPortOpen: true }), ["BruteSSH.exe"])).toBe(false);
    expect(canRoot(server({ openPortCount: 1, sshPortOpen: true }), ["FTPCrack.exe"])).toBe(true);
  });

  test("hacking level is irrelevant; zero-port servers always root", () => {
    expect(canRoot(server({ numOpenPortsRequired: 0, requiredHackingSkill: 9999 }), [])).toBe(true);
  });
});

describe("isUseful", () => {
  test("requires root and RAM, and skips hacknet servers", () => {
    expect(isUseful(server({ hasAdminRights: true }))).toBe(true);
    expect(isUseful(server({ hasAdminRights: false }))).toBe(false);
    expect(isUseful(server({ hasAdminRights: true, maxRam: 0 }))).toBe(false);
    expect(isUseful(server({ hasAdminRights: true, hostname: "hacknet-server-0" }))).toBe(false);
  });
});

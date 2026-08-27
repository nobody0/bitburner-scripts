import { describe, expect, test } from "bun:test";
import type { Server } from "@ns";
import { canRoot, isUseful, reapStrayScripts, reclaimFleet } from "../../game/lib/net.ts";
import type { NsProxy } from "../../game/lib/ns-proxy.ts";

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
  test("requires root and RAM, including RAM-bearing hacknet servers", () => {
    expect(isUseful(server({ hasAdminRights: true }))).toBe(true);
    expect(isUseful(server({ hasAdminRights: false }))).toBe(false);
    expect(isUseful(server({ hasAdminRights: true, maxRam: 0 }))).toBe(false);
    expect(isUseful(server({ hasAdminRights: true, hostname: "hacknet-server-0" }))).toBe(true);
  });
});

/** Minimal proxy double: these functions only reach the game through dotted
 * string paths, so a lookup table keyed by path is a complete stand-in. `self`
 * is what the reclaim uses to find the resident it must not kill. */
function proxy(
  processes: Record<string, { pid: number; filename: string; args: (string | number)[] }[]>,
  self = { pid: 1, server: "home" },
) {
  const killed: number[] = [];
  const cleared: string[] = [];
  const impl: Record<string, (...args: never[]) => unknown> = {
    self: () => self,
    ps: (host: string) => processes[host] ?? [],
    kill: (target: number) => {
      killed.push(target);
      return true;
    },
    killall: (host: string) => {
      cleared.push(host);
      return true;
    },
  } as unknown as Record<string, (...args: never[]) => unknown>;
  return {
    killed,
    cleared,
    call: ((path: string, ...args: unknown[]) =>
      Promise.resolve((impl[path] as (...a: unknown[]) => unknown)(...args))) as NsProxy,
  };
}

function rooted(hostname: string, ramUsed: number): Server {
  return { hostname, hasAdminRights: true, ramUsed, maxRam: 64 } as Server;
}

describe("reclaimFleet", () => {
  test("clears busy hosts but never kills the controller or the resident", async () => {
    const stub = proxy(
      {
        home: [
          { pid: 1, filename: "start.js", args: [] },
          { pid: 2, filename: "lib/ns-resident.js", args: [] },
          { pid: 3, filename: "worker/starter.js", args: ["n00dles"] },
        ],
      },
      { pid: 2, server: "home" }, // the resident doing the killing
    );
    const servers = {
      home: rooted("home", 100),
      "pserv-0": rooted("pserv-0", 8191),
      idle: rooted("idle", 0),
    };
    const reclaimed = await reclaimFleet(stub.call, servers, 1);

    expect(stub.killed).toEqual([3]); // only the orphan
    expect(stub.cleared).toEqual(["pserv-0"]); // idle host untouched
    expect(reclaimed.sort()).toEqual(["home", "pserv-0"]);
  });

  test("skips servers we do not own", async () => {
    const stub = proxy({});
    const servers = { locked: { hostname: "locked", hasAdminRights: false, ramUsed: 32, maxRam: 64 } as Server };
    expect(await reclaimFleet(stub.call, servers, 1)).toEqual([]);
    expect(stub.cleared).toEqual([]);
  });

  test("never killalls the host the resident is running on", async () => {
    // Residents are placed wherever the broker has room, so this reclaim may
    // be executing on a client. A blanket killall there would kill the very
    // process doing the killing, and the awaited call would never settle —
    // every cold boot, non-deterministically, depending only on placement.
    const stub = proxy(
      {
        home: [{ pid: 1, filename: "start.js", args: [] }],
        "pserv-0": [
          { pid: 7, filename: "lib/ns-resident.js", args: [] }, // us
          { pid: 8, filename: "worker/worker.js", args: [42] }, // a real orphan
        ],
      },
      { pid: 7, server: "pserv-0" },
    );
    const servers = { home: rooted("home", 4), "pserv-0": rooted("pserv-0", 40), other: rooted("other", 12) };
    const reclaimed = await reclaimFleet(stub.call, servers, 1);

    // pserv-0 is cleared per-process, sparing the resident; only `other` is nuked.
    expect(stub.cleared).toEqual(["other"]);
    expect(stub.killed).toEqual([8]);
    expect(reclaimed.sort()).toEqual(["other", "pserv-0"]);
  });
});

describe("reapStrayScripts", () => {
  test("kills unregistered workers and spares the rest", async () => {
    const stub = proxy({
      "pserv-0": [
        { pid: 10, filename: "worker/worker.js", args: [7] }, // registered
        { pid: 11, filename: "worker/worker.js", args: [99] }, // unreachable
        { pid: 13, filename: "something-else.js", args: [] }, // not ours
      ],
    });
    const reaped = await reapStrayScripts(stub.call, ["pserv-0"], "worker/worker.js", new Set([10]));
    expect(reaped).toBe(1);
    expect(stub.killed).toEqual([11]);
  });

  test("registered workers survive a build handoff", async () => {
    // After a handoff the dispatcher ledger is fresh but the realm registry
    // still holds every live op, so nothing may be killed.
    const stub = proxy({
      "pserv-0": [
        { pid: 20, filename: "worker/worker.js", args: [1] },
        { pid: 21, filename: "worker/worker.js", args: [2] },
      ],
    });
    const reaped = await reapStrayScripts(stub.call, ["pserv-0"], "worker/worker.js", new Set([20, 21]));
    expect(reaped).toBe(0);
    expect(stub.killed).toEqual([]);
  });
});

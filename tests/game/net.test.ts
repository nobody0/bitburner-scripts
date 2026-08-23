import { describe, expect, test } from "bun:test";
import type { Server } from "@ns";
import { canRoot, isUseful, reapStrayScripts, reclaimFleet } from "../../game/lib/net.ts";

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

/** Minimal ns double for the dodged closures: they only use bracket-notation
 * calls, so a plain object with the right methods is enough. */
function stubNs(
  processes: Record<string, { pid: number; filename: string; args: (string | number)[] }[]>,
  pid = 1,
  /** Where this stub is running. Since dodges can be placed on the fleet, the
   *  reclaim may itself be executing on a client rather than on home. */
  stubHost = "home",
) {
  const killed: number[] = [];
  const cleared: string[] = [];
  return {
    killed,
    cleared,
    ns: {
      pid,
      ps: (host: string) => processes[host] ?? [],
      kill: (target: number) => {
        killed.push(target);
        return true;
      },
      killall: (host: string) => {
        cleared.push(host);
        return true;
      },
    } as unknown as Parameters<typeof reclaimFleet>[0],
  };
}

function rooted(hostname: string, ramUsed: number): Server {
  return { hostname, hasAdminRights: true, ramUsed, maxRam: 64 } as Server;
}

describe("reclaimFleet", () => {
  test("clears busy hosts but never kills the controller or its dodge stub", () => {
    const stub = stubNs(
      {
        home: [
          { pid: 1, filename: "start.js", args: [] },
          { pid: 2, filename: "lib/dodge-stub.js", args: [] },
          { pid: 3, filename: "worker/starter.js", args: ["n00dles"] },
        ],
      },
      2, // the stub's own pid
    );
    const servers = {
      home: rooted("home", 100),
      "pserv-0": rooted("pserv-0", 8191),
      idle: rooted("idle", 0),
    };
    const reclaimed = reclaimFleet(stub.ns, servers, 1, "home");

    expect(stub.killed).toEqual([3]); // only the orphan
    expect(stub.cleared).toEqual(["pserv-0"]); // idle host untouched
    expect(reclaimed.sort()).toEqual(["home", "pserv-0"]);
  });

  test("skips servers we do not own", () => {
    const stub = stubNs({});
    const servers = { locked: { hostname: "locked", hasAdminRights: false, ramUsed: 32, maxRam: 64 } as Server };
    expect(reclaimFleet(stub.ns, servers, 1)).toEqual([]);
    expect(stub.cleared).toEqual([]);
  });

  test("never killalls the host the stub is running on", () => {
    // Since dodges can be placed on the fleet, this reclaim may be executing
    // on a client. A blanket killall there would kill the very stub doing the
    // killing, and the dodge would hang until its 10s watchdog fired — every
    // cold boot, non-deterministically, depending only on where placement
    // happened to put it.
    const stub = stubNs(
      {
        home: [{ pid: 1, filename: "start.js", args: [] }],
        "pserv-0": [
          { pid: 7, filename: "lib/dodge-stub.js", args: [] }, // us
          { pid: 8, filename: "worker/worker.js", args: [42] }, // a real orphan
        ],
      },
      7,
      "pserv-0",
    );
    const servers = { home: rooted("home", 4), "pserv-0": rooted("pserv-0", 40), other: rooted("other", 12) };
    const reclaimed = reclaimFleet(stub.ns, servers, 1, "pserv-0");

    // pserv-0 is cleared per-process, sparing the stub; only `other` is nuked.
    expect(stub.cleared).toEqual(["other"]);
    expect(stub.killed).toEqual([8]);
    expect(reclaimed.sort()).toEqual(["other", "pserv-0"]);
  });
});

describe("reapStrayScripts", () => {
  test("kills unregistered workers and spares the rest", () => {
    const stub = stubNs({
      "pserv-0": [
        { pid: 10, filename: "worker/worker.js", args: [7] }, // registered
        { pid: 11, filename: "worker/worker.js", args: [99] }, // unreachable
        { pid: 13, filename: "something-else.js", args: [] }, // not ours
      ],
    });
    const reaped = reapStrayScripts(stub.ns, ["pserv-0"], "worker/worker.js", new Set([10]));
    expect(reaped).toBe(1);
    expect(stub.killed).toEqual([11]);
  });

  test("registered workers survive a build handoff", () => {
    // After a handoff the dispatcher ledger is fresh but the realm registry
    // still holds every live op, so nothing may be killed.
    const stub = stubNs({
      "pserv-0": [
        { pid: 20, filename: "worker/worker.js", args: [1] },
        { pid: 21, filename: "worker/worker.js", args: [2] },
      ],
    });
    const reaped = reapStrayScripts(stub.ns, ["pserv-0"], "worker/worker.js", new Set([20, 21]));
    expect(reaped).toBe(0);
    expect(stub.killed).toEqual([]);
  });
});

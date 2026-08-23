import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { captureLaunch, handoffLaunch } from "../game/lib/launch-shared.ts";
import type { DnetAgentLaunch, DnetProberLaunch } from "../game/dnet/launch.ts";
import { main as agentMain } from "../game/dnet/agent.ts";
import { makeJobBodies } from "../game/dnet/jobs.ts";
import { JOB_METHODS, RENDEZVOUS_PROTOCOL, dnetRealm, type DnetRendezvous } from "../game/dnet/realm.ts";
import type { ProvisionalCredential } from "../shared/strategy/dnet/courier.ts";
import { exactNeighbourClueEpoch } from '../shared/strategy/dnet/file-clues.ts';

afterEach(() => {
  delete dnetRealm().dnet_overseer;
});

describe('unnamed first-auth clue epochs', () => {
  test('only authentication, probe and inventory from one mutation are exact', () => {
    expect(exactNeighbourClueEpoch(7, 7, 7)).toBe(true);
    expect(exactNeighbourClueEpoch(7, 8, 8)).toBe(false);
    expect(exactNeighbourClueEpoch(7, 7, 8)).toBe(false);
    expect(exactNeighbourClueEpoch(undefined, 7, 7)).toBe(false);
  });
});

function winningPhish(files: readonly string[]): NS {
  return {
    dnet: {
      phishingAttack: async () => ({
        success: true,
        code: 200,
        message: "Phishing attack succeeded! Found a cache file.",
      }),
      getServerDetails: () => ({
        isOnline: true,
        depth: 0,
        blockedRam: 0,
        requiredCharismaSkill: 0,
        difficulty: 1,
        isStationary: true,
        modelId: "darkweb",
        passwordLength: 0,
        passwordFormat: "ASCII",
        passwordHint: "",
        data: "",
        logTrafficInterval: 30,
      }),
    },
    getServerMaxRam: () => 16,
    getServerUsedRam: () => 8,
    ls: () => [...files],
  } as unknown as NS;
}

describe("darknet farm job cache observations", () => {
  test("inventory consumes every actionable clue and removes generated files", async () => {
    const removed: string[] = [];
    const neighbours: { source: string; password: string }[] = [];
    const provisionals: ProvisionalCredential[] = [];
    const evidence: { hostname: string; chars: string[] }[] = [];
    const contents: Record<string, string> = {
      "password.data.txt": "Remember this password: 1234",
      "secrets.data.txt": 'Server: dn-2 Password: "Republic of Cyprus"',
      "key.data.txt": "The password for dn-3 contains A and 7",
      "notes.data.txt": "The truth is out there.",
    };
    const ns = {
      dnet: { getServerDetails: () => ({
        isOnline: true, depth: 1, blockedRam: 0, requiredCharismaSkill: 0,
        difficulty: 1, isStationary: false, modelId: "ZeroLogon",
        passwordLength: 4, passwordFormat: "numeric", passwordHint: "", data: "", logTrafficInterval: 30,
      }) },
      dnsLookup: () => "10.0.0.1",
      ls: () => [
        "vault_123.cache",
        "password.data.txt",
        "secrets.data.txt",
        "key.data.txt",
        "notes.data.txt",
        "cache-note-1.lit",
        "j0.msg",
        "notes.txt",
      ],
      read: (name: string) => contents[name] ?? "",
      rm: (name: string) => { removed.push(name); return true; },
    } as unknown as NS;
    const result = await makeJobBodies({
      charisma: () => 1_000,
      ledgerFor: () => undefined,
      recordNeighbourPassword: (source, password) => neighbours.push({ source, password }),
      recordProvisional: (entry) => provisionals.push(entry),
      recordFileEvidence: (hostname, clue) => {
        if (clue.kind === "contains") evidence.push({ hostname, chars: clue.chars });
      },
    }).inventory!(ns, { host: "dn-1", from: "dn-1" });

    expect(result.hosts?.[0]?.caches).toEqual(["vault_123.cache"]);
    expect(neighbours).toEqual([{ source: "dn-1", password: "1234" }]);
    expect(provisionals).toEqual([{
      hostname: "dn-2",
      password: "Republic of Cyprus",
      via: "data-file",
      at: expect.any(Number),
    }]);
    expect(evidence).toEqual([{ hostname: "dn-3", chars: ["A", "7"] }]);
    expect(removed).toEqual([
      "password.data.txt",
      "secrets.data.txt",
      "key.data.txt",
      "notes.data.txt",
      "cache-note-1.lit",
    ]);
  });

  test("a winning phish flags the host dirty instead of spending a thread on ls", async () => {
    const result = await makeJobBodies({
      charisma: () => 1_000,
      ledgerFor: () => undefined,
    }).phish!(
      winningPhish(["bankdata_577.d.cache"]),
      { host: "darkweb", from: "darkweb" },
    );

    expect(result.ok).toBe(true);
    // No inline listing — that would be 0.2 GB on every phishing thread. The win
    // sets `dirtied`, and the overseer files one instant inventory job.
    expect(result.dirtied).toBe(true);
    expect(result.hosts?.[0]?.caches).toBeUndefined();
    expect(JOB_METHODS.phish).not.toContain("ls");
    // The dedicated inventory job is the one that lists.
    expect(JOB_METHODS.inventory).toContain("ls");
  });

  test("reclaim hands the host back when another worker thread becomes legal", async () => {
    let calls = 0;
    let blockedRam = 4;
    const ns = {
      dnet: {
        memoryReallocation: async () => {
          calls++;
          blockedRam = 2.5;
          return { success: true, code: 200, message: "freed RAM" };
        },
        getServerDetails: () => ({
          isOnline: true,
          depth: 1,
          blockedRam,
          requiredCharismaSkill: 0,
          difficulty: 1,
          isStationary: false,
          modelId: "ZeroLogon",
          passwordLength: 1,
          passwordFormat: "ASCII",
          passwordHint: "",
          data: "",
          logTrafficInterval: 30,
        }),
      },
    } as unknown as NS;
    const result = await makeJobBodies({ charisma: () => 1_000, ledgerFor: () => undefined }).reclaim!(
      ns,
      { host: "dn-1", from: "dn-1", resizeAtBlockedRam: 3 },
    );
    expect(calls).toBe(1);
    expect(result.hosts?.[0]?.blockedRam).toBe(2.5);
    expect(result.detail).toContain("another worker thread");
  });

  test("reclaim dirties a host when the final successful call clears its block", async () => {
    let blockedRam = 1;
    const ns = {
      dnet: {
        memoryReallocation: async () => {
          blockedRam = 0;
          return { success: true, code: 200, message: "freed final block" };
        },
        getServerDetails: () => ({
          isOnline: true, depth: 1, blockedRam, requiredCharismaSkill: 0,
          difficulty: 1, isStationary: false, modelId: "ZeroLogon",
          passwordLength: 1, passwordFormat: "ASCII", passwordHint: "", data: "", logTrafficInterval: 30,
        }),
      },
    } as unknown as NS;
    const result = await makeJobBodies({ charisma: () => 1_000, ledgerFor: () => undefined }).reclaim!(
      ns,
      { host: "dn-1", from: "dn-1", resizeAtBlockedRam: 0 },
    );

    expect(result.hosts?.[0]?.blockedRam).toBe(0);
    expect(result.dirtied).toBe(true);
  });

  test("plant waits for the prober's first report before preparing and launching the resident", async () => {
    const launches: { file: string; options: { temporary?: boolean } }[] = [];
    const order: string[] = [];
    const killed: number[] = [];
    let residentAccepted = true;
    let autoFirstReport = false;
    let reportFirst: (() => void) | undefined;
    dnetRealm().dnet_overseer = {
      protocol: RENDEZVOUS_PROTOCOL,
      preparePlantedHost: (host: string) => { order.push(`prepare:${host}`); },
    } as unknown as DnetRendezvous;
    const ns = {
      dnet: {
        connectToSession: () => ({ success: true, code: 200, message: "connected" }),
        getServerDetails: () => ({
          isOnline: true, depth: 1, blockedRam: 0, requiredCharismaSkill: 0,
          difficulty: 1, isStationary: false, modelId: "ZeroLogon",
          passwordLength: 1, passwordFormat: "ASCII", passwordHint: "", data: "", logTrafficInterval: 30,
        }),
      },
      scp: () => { order.push("scp"); return true; },
      dnsLookup: () => "10.0.0.1",
      exec: (file: string, _host: string, options: { temporary?: boolean }) => {
        launches.push({ file, options });
        if (file.includes("prober")) {
          order.push("prober");
          const launch = captureLaunch<DnetProberLaunch>("dnet-prober");
          const report = () => {
            order.push("first-probe");
            launch?.firstReport?.();
          };
          if (autoFirstReport) report();
          else reportFirst = report;
        }
        else {
          order.push("agent");
          captureLaunch<DnetAgentLaunch>("dnet-agent");
        }
        if (!file.includes("prober") && !residentAccepted) return 0;
        return launches.length;
      },
      kill: (pid: number) => { killed.push(pid); return true; },
      getFunctionRamCost: (method: string) => method === "dnet.probe" ? 0.2 : method === "spawn" ? 2 : 0,
    } as unknown as NS;
    const planting = makeJobBodies({ charisma: () => 1_000, ledgerFor: () => undefined }).plant!(
      ns,
      {
        host: "dn-1", from: "darkweb", password: "pw",
        payloads: ["dnet/agent.js", "dnet/prober.js"],
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(launches.map((entry) => entry.file)).toEqual(["dnet/prober.js"]);
    expect(order).toEqual(["scp", "prober"]);

    reportFirst?.();
    const result = await planting;
    expect(result.ok).toBe(true);
    expect(launches.map((entry) => entry.file)).toEqual(["dnet/prober.js", "dnet/agent.js"]);
    expect(order).toEqual(["scp", "prober", "first-probe", "prepare:dn-1", "agent"]);
    expect(launches.every((entry) => entry.options.temporary === true)).toBe(true);

    // If the second launch loses a RAM race, the first launch must not poison
    // every retry by leaving a lone prober in the reserved space.
    launches.length = 0;
    order.length = 0;
    autoFirstReport = true;
    residentAccepted = false;
    const refused = await makeJobBodies({ charisma: () => 1_000, ledgerFor: () => undefined }).plant!(
      ns,
      {
        host: "dn-2", from: "darkweb", password: "pw",
        payloads: ["dnet/agent.js", "dnet/prober.js"],
      },
    );
    expect(refused.ok).toBe(false);
    expect(killed).toEqual([1]);
  });

  test("a cramped plant launches only the thread-scaled local reclaimer", async () => {
    const launches: { file: string; options: { temporary?: boolean; threads?: number; ramOverride?: number } }[] = [];
    const rendezvous = {
      protocol: RENDEZVOUS_PROTOCOL,
      buildId: "test",
      bootstraps: new Map(),
    } as unknown as DnetRendezvous;
    dnetRealm().dnet_overseer = rendezvous;
    const ns = {
      dnet: {
        connectToSession: () => ({ success: true, code: 200, message: "connected" }),
        getServerDetails: () => ({
          isOnline: true, depth: 1, blockedRam: 12, requiredCharismaSkill: 0,
          difficulty: 1, isStationary: false, modelId: "ZeroLogon",
          passwordLength: 1, passwordFormat: "ASCII", passwordHint: "", data: "", logTrafficInterval: 30,
        }),
      },
      scp: () => true,
      exec: (file: string, _host: string, options: { temporary?: boolean; threads?: number; ramOverride?: number }) => {
        launches.push({ file, options });
        captureLaunch<DnetAgentLaunch>("dnet-agent");
        return 7;
      },
      getFunctionRamCost: (method: string) => method === "dnet.memoryReallocation" ? 1 : 0,
    } as unknown as NS;
    const result = await makeJobBodies({ charisma: () => 1_000, ledgerFor: () => undefined }).plant!(
      ns,
      {
        host: "dn-1", from: "darkweb", password: "pw",
        payloads: ["dnet/agent.js", "dnet/prober.js"],
        bootstrapReclaim: true,
        bootstrapThreads: 3,
      },
    );
    expect(result.ok).toBe(true);
    expect(launches).toEqual([{
      file: "dnet/agent.js",
      options: { threads: 3, ramOverride: 2.6, temporary: true },
    }]);
    expect(rendezvous.bootstraps.get("dn-1")?.pid).toBe(7);
  });

  test("bootstrap mode reclaims exactly once, wakes derivation, and exits", async () => {
    let reallocations = 0;
    let spawns = 0;
    let wakes = 0;
    const rendezvous = {
      protocol: RENDEZVOUS_PROTOCOL,
      buildId: "test",
      bootstraps: new Map(),
      bootstrapDone: new Set<string>(),
      signalDerive: () => { wakes++; },
    } as unknown as DnetRendezvous;
    dnetRealm().dnet_overseer = rendezvous;
    const ns = {
      pid: 77,
      args: [],
      disableLog: () => {},
      atExit: () => {},
      spawn: () => { spawns++; return 0; },
      dnet: {
        memoryReallocation: async () => {
          reallocations++;
          return { success: true, code: 200, message: "freed RAM" };
        },
      },
    } as unknown as NS;
    let running!: Promise<void>;
    await handoffLaunch<DnetAgentLaunch>(
      { kind: "dnet-agent", host: "dn-1", bootstrapReclaim: true },
      () => {
        running = agentMain(ns);
        return ns.pid;
      },
    );
    await running;

    expect(reallocations).toBe(1);
    expect(spawns).toBe(0);
    expect(rendezvous.bootstraps.has("dn-1")).toBe(false);
    expect(rendezvous.bootstrapDone.has("dn-1")).toBe(true);
    expect(wakes).toBeGreaterThan(0);
  });
});

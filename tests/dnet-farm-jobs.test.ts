import { makeOrder } from './support/dnet-order.ts';
import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { captureLaunch, handoffLaunch } from "../game/lib/launch-shared.ts";
import type { DnetAgentLaunch, DnetProbeRefresh, DnetProbeReport, DnetProberLaunch } from "../game/dnet/launch.ts";
import { main as agentMain } from "../game/dnet/agent.ts";
import { runOrder } from "../game/dnet/orders.ts";
import {
  DNET_PROTOCOL,
  KIND_CALLS,
  REFUSED_EXEC_RETRY_MS,
  dnetRealm,
  type AgentIo,
  type ControllerDeps,
  type ControllerHandle,
  type Order,
  type OrderKind,
} from "../game/dnet/shared.ts";
import type { ProvisionalCredential } from "../shared/strategy/dnet/courier.ts";
import { exactNeighbourClueEpoch } from '../shared/strategy/dnet/file-clues.ts';

afterEach(() => {
  delete dnetRealm().dnet_controller;
});


function makeDeps(over: Partial<ControllerDeps> = {}): ControllerDeps {
  return {
    charisma: () => 1_000,
    ledgerFor: () => undefined,
    ringFor: () => undefined,
    recordAttempt: () => {},
    recordLogDrain: () => {},
    recordCredential: () => {},
    recordLoose: () => {},
    recordProvisional: () => {},
    recordNeighbourPassword: () => {},
    recordFileEvidence: () => {},
    labField: () => undefined,
    publishLabField: () => {},
    ...over,
    timing: over.timing ?? (() => ({ charisma: 1_000, intelligence: 0, hasBoots: false, sf15Level: 0, authenticationDurationMultiplier: 1 })),
    expectedDelayMs: over.expectedDelayMs ?? (() => 0),
  };
}

function makeIo(over: Partial<ControllerDeps> = {}): AgentIo {
  return { beat: () => {}, setExpectedDoneAt: () => {}, hold: () => {},
  inFlight: () => {}, cancelled: () => undefined, deps: makeDeps(over) };
}

function probeRefreshMethods() {
  const pending = new Map<string, DnetProbeRefresh>();
  return {
    async beginProbeRefresh(host: string) {
      const existing = pending.get(host);
      if (existing !== undefined) return { refresh: existing, launch: false };
      let resolve!: (value: DnetProbeReport | undefined) => void;
      let settled = false;
      const refresh: DnetProbeRefresh = {
        refreshed: new Promise<DnetProbeReport | undefined>((done) => { resolve = done; }),
        settle(value) { if (!settled) { settled = true; resolve(value); } },
      };
      pending.set(host, refresh);
      return { refresh, launch: true };
    },
    cancelProbeRefresh(host: string, refresh: DnetProbeRefresh) {
      if (pending.get(host) === refresh) pending.delete(host);
      refresh.settle(undefined);
    },
  };
}

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
  test("opening a phishing cache re-lists, ingests data files, and attributes spawned contracts", async () => {
    let files = ["mail_123.d.cache"];
    const removed: string[] = [];
    const provisionals: ProvisionalCredential[] = [];
    const ns = {
      dnet: {
        openCache: () => {
          files = ["spawned.cct", "password.data.txt"];
          return { success: true, message: "New coding contracts are now available on the network!", karmaLoss: 0 };
        },
        getServerDetails: () => ({
          isOnline: true, depth: 1, blockedRam: 0, requiredCharismaSkill: 0,
          difficulty: 5, isStationary: false, modelId: "ZeroLogon",
          passwordLength: 4, passwordFormat: "ASCII", passwordHint: "", data: "", logTrafficInterval: 30,
        }),
      },
      dnsLookup: () => "10.0.0.1",
      ls: () => [...files],
      read: () => 'Server: dn-2 Password: "Republic of Cyprus"',
      rm: (name: string) => {
        removed.push(name);
        files = files.filter((file) => file !== name);
        return true;
      },
    } as unknown as NS;

    const result = await runOrder(
      ns,
      makeOrder("cache", { host: "dn-1", from: "dn-1" }, { filename: "mail_123.d.cache" }),
      makeIo({ recordProvisional: (entry) => provisionals.push(entry) }),
    );

    expect(result.ok).toBe(true);
    expect(result.profit).toMatchObject({
      cachesOpened: 1,
      phishCachesOpened: 1,
      cacheContractsCreated: 1,
      cacheDataFilesRead: 1,
      cacheDataFilesParsed: 1,
    });
    expect(result.hosts?.[0]?.contracts).toEqual(["spawned.cct"]);
    expect(provisionals).toEqual([{
      hostname: "dn-2", password: "Republic of Cyprus", via: "data-file", at: expect.any(Number),
    }]);
    expect(removed).toEqual(["password.data.txt"]);
  });

  test("a follower bleed waits for the complete authentication wave", async () => {
    let release!: () => void;
    const waveDone = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    let followed: readonly string[] = [];
    dnetRealm().dnet_controller = {
      protocol: DNET_PROTOCOL,
      afterOrders: (ids: readonly string[]) => { followed = ids; return waveDone; },
    } as unknown as ControllerHandle;
    const ns = {
      dnet: {
        heartbleed: async () => {
          calls++;
          return { success: true, code: 200, message: "drained", logs: [] };
        },
        getServerDetails: () => ({
          isOnline: true, depth: 1, blockedRam: 0, requiredCharismaSkill: 0,
          difficulty: 1, isStationary: false, modelId: "AccountsManager_4.2",
          passwordLength: 2, passwordFormat: "numeric", passwordHint: "", data: "", logTrafficInterval: 30,
        }),
      },
    } as unknown as NS;

    const running = runOrder(
      ns,
      makeOrder("bleed", { host: "target", from: "listener" }, { followAttemptIds: ["a", "b", "c"] }),
      makeIo(),
    );
    await Promise.resolve();
    expect(followed).toEqual(["a", "b", "c"]);
    expect(calls).toBe(0);
    release();
    expect((await running).ok).toBe(true);
    expect(calls).toBe(1);
  });

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
    const result = await runOrder(ns, makeOrder("inventory", { host: "dn-1", from: "dn-1" }, {}), makeIo({
      recordNeighbourPassword: (source, password) => neighbours.push({ source, password }),
      recordProvisional: (entry) => provisionals.push(entry),
      recordFileEvidence: (hostname, clue) => {
        if (clue.kind === "contains") evidence.push({ hostname, chars: clue.chars });
      },
    }));

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
    const result = await runOrder(
      winningPhish(["bankdata_577.d.cache"]),
      makeOrder("phish", { host: "darkweb", from: "darkweb" }, {}),
      makeIo(),
    );

    expect(result.ok).toBe(true);
    // No inline listing — that would be 0.2 GB on every phishing thread. The win
    // invalidates files, and the controller files one instant inventory job.
    expect(result.hosts?.[0]?.invalidates).toEqual(["files"]);
    expect(result.hosts?.[0]?.caches).toBeUndefined();
    expect(result.profit).toMatchObject({ phishAttempts: 1, phishSuccesses: 1, phishCachesCreated: 1 });
    expect(KIND_CALLS.phish).not.toContain("ls");
    // The dedicated inventory job is the one that lists.
    expect(KIND_CALLS.inventory).toContain("ls");
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
    const result = await runOrder(
      ns,
      makeOrder("reclaim", { host: "dn-1", from: "dn-1" }, { resizeAtBlockedRam: 3 }),
      makeIo(),
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
    const result = await runOrder(
      ns,
      makeOrder("reclaim", { host: "dn-1", from: "dn-1" }, { resizeAtBlockedRam: 0 }),
      makeIo(),
    );

    expect(result.hosts?.[0]?.blockedRam).toBe(0);
    expect(result.hosts?.[0]?.invalidates).toEqual(["files"]);
  });

  test("plant claims recovery first but waits for the prober report before launching the resident", async () => {
    const launches: { file: string; options: { temporary?: boolean } }[] = [];
    const order: string[] = [];
    const killed: number[] = [];
    let proberRefusals = 0;
    let residentRefusals = 0;
    let reuseProber = false;
    let retiringAllocation = false;
    let claimedOrder: Order | undefined = makeOrder(
      "inventory",
      { host: "dn-1", from: "dn-1" },
      {},
    );
    let autoFirstReport = false;
    let reportFirst: (() => void) | undefined;
    dnetRealm().dnet_controller = {
      protocol: DNET_PROTOCOL,
      ...probeRefreshMethods(),
      announceLaunch: () => {},
      announceProbeRefresh: () => {},
      preparePlant: (host: string) => {
        order.push(`prepare:${host}`);
        return { reuseProber, retiringAllocation };
      },
      claimPlanted: (host: string) => { order.push(`claim:${host}`); return claimedOrder; },
      abandonPlant: () => {},
    } as unknown as ControllerHandle;
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
      exec: (file: string, _host: string, options: { temporary?: boolean }, launchId: unknown) => {
        launches.push({ file, options });
        if (file.includes("prober")) {
          order.push("prober");
          if (proberRefusals-- > 0) return 0;
          const launch = captureLaunch<DnetProberLaunch>("dnet-prober", launchId);
          const report = () => {
            order.push("first-probe");
            launch?.refresh?.settle({ host: launch.host, neighbours: [], at: Date.now(), pid: 41 });
          };
          if (autoFirstReport) report();
          else reportFirst = report;
        }
        else {
          order.push("agent");
          if (residentRefusals-- > 0) return 0;
          captureLaunch<DnetAgentLaunch>("dnet-agent", launchId);
        }
        return launches.length;
      },
      kill: (pid: number) => { killed.push(pid); return true; },
      getFunctionRamCost: (method: string) => method === "dnet.probe" ? 0.2 : method === "spawn" ? 2 : 0,
    } as unknown as NS;
    const planting = runOrder(
      ns,
      makeOrder("plant", { host: "dn-1", from: "darkweb" }, { targets: [{ host: "dn-1", password: "pw" }], payloads: ["dnet/agent.js", "dnet/prober.js"] }),
      makeIo(),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(launches.map((entry) => entry.file)).toEqual(["dnet/prober.js"]);
    expect(order).toEqual(["scp", "prepare:dn-1", "prober"]);

    reportFirst?.();
    const result = await planting;
    expect(result.ok).toBe(true);
    expect(launches.map((entry) => entry.file)).toEqual(["dnet/prober.js", "dnet/agent.js"]);
    expect(order).toEqual(["scp", "prepare:dn-1", "prober", "first-probe", "claim:dn-1", "agent"]);
    expect(launches.every((entry) => entry.options.temporary === true)).toBe(true);

    // If the second launch loses a RAM race, the first launch must not poison
    // every retry by leaving a lone prober in the reserved space.
    launches.length = 0;
    order.length = 0;
    autoFirstReport = true;
    residentRefusals = 1;
    const refused = await runOrder(
      ns,
      makeOrder("plant", { host: "dn-2", from: "darkweb" }, { targets: [{ host: "dn-2", password: "pw" }], payloads: ["dnet/agent.js", "dnet/prober.js"] }),
      makeIo(),
    );
    expect(refused.ok).toBe(false);
    expect(killed).toEqual([1]);

    // Retirement is its own fact: retireVantage clears both process handles,
    // so a replacement with no surviving prober must still grace both execs.
    launches.length = 0;
    order.length = 0;
    reuseProber = false;
    retiringAllocation = true;
    proberRefusals = 1;
    residentRefusals = 1;
    const retrying = runOrder(
      ns,
      makeOrder("plant", { host: "dn-3", from: "darkweb" }, { targets: [{ host: "dn-3", password: "pw" }], payloads: ["dnet/agent.js", "dnet/prober.js"] }),
      makeIo(),
    );
    await Promise.resolve();
    expect(launches).toHaveLength(1);
    await new Promise<void>((resolve) => setTimeout(resolve, REFUSED_EXEC_RETRY_MS + 25));
    await Promise.resolve();
    expect(launches).toHaveLength(3);
    await new Promise<void>((resolve) => setTimeout(resolve, REFUSED_EXEC_RETRY_MS + 25));
    await expect(retrying).resolves.toMatchObject({ ok: true });
    expect(launches).toHaveLength(4);

    // A surviving prober is already a standing vantage. With no order to run,
    // the plant closes cleanly instead of exec'ing a base agent that exits on
    // its first line.
    launches.length = 0;
    order.length = 0;
    reuseProber = true;
    retiringAllocation = false;
    claimedOrder = undefined;
    const ready = await runOrder(
      ns,
      makeOrder("plant", { host: "dn-3", from: "darkweb" }, { targets: [{ host: "dn-3", password: "pw" }], payloads: ["dnet/agent.js", "dnet/prober.js"] }),
      makeIo(),
    );
    expect(ready.ok).toBe(true);
    expect(launches).toEqual([]);
    expect(order).toEqual(["scp", "prepare:dn-3", "claim:dn-3"]);
  });

  test("prober repair stays active until the replacement has filed its first probe", async () => {
    let reportFirst: (() => void) | undefined;
    dnetRealm().dnet_controller = {
      protocol: DNET_PROTOCOL,
      ...probeRefreshMethods(),
    } as unknown as ControllerHandle;
    const ns = {
      exec: (_file: string, _host: string, _opts: unknown, launchId: unknown) => {
        const launch = captureLaunch<DnetProberLaunch>("dnet-prober", launchId);
        reportFirst = () => launch?.refresh?.settle({ host: launch.host, neighbours: [], at: Date.now(), pid: 41 });
        return 91;
      },
      getFunctionRamCost: (method: string) => method === "dnet.probe" ? 0.2 : method === "spawn" ? 2 : 0,
    } as unknown as NS;

    let settled = false;
    const repairing = runOrder(
      ns,
      makeOrder("relaunchProbe", { host: "dn-1", from: "dn-1" }, { proberFile: "dnet/prober.js" }),
      makeIo(),
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(reportFirst).toBeFunction();
    expect(settled).toBe(false);

    reportFirst?.();
    await expect(repairing).resolves.toMatchObject({ ok: true, detail: "prober pid 91" });
  });

  test("a cramped plant launches only the thread-scaled local reclaimer", async () => {
    const launches: { file: string; options: { temporary?: boolean; threads?: number; ramOverride?: number; preventDuplicates?: boolean } }[] = [];
    const registered: { host: string; pid: number }[] = [];
    dnetRealm().dnet_controller = {
      protocol: DNET_PROTOCOL,
      buildId: "test",
      registerBootstrap: (host: string, pid: number) => registered.push({ host, pid }),
    } as unknown as ControllerHandle;
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
      exec: (file: string, _host: string, options: { temporary?: boolean; threads?: number; ramOverride?: number }, launchId: unknown) => {
        launches.push({ file, options });
        captureLaunch<DnetAgentLaunch>("dnet-agent", launchId);
        return 7;
      },
      getFunctionRamCost: (method: string) => method === "dnet.memoryReallocation" ? 1 : 0,
    } as unknown as NS;
    const result = await runOrder(
      ns,
      makeOrder("plant", { host: "dn-1", from: "darkweb" }, { targets: [{ host: "dn-1", password: "pw", bootstrapReclaim: true, bootstrapThreads: 3 }], payloads: ["dnet/agent.js", "dnet/prober.js"] }),
      makeIo(),
    );
    expect(result.ok).toBe(true);
    expect(launches).toEqual([{
      file: "dnet/agent.js",
      // `preventDuplicates: false` rides on every launch: each one already
      // carries a unique handoff id, so the engine's filename+args duplicate
      // check can only ever produce a false refusal.
      options: { threads: 3, ramOverride: 2.6, temporary: true, preventDuplicates: false },
    }]);
    expect(registered).toEqual([{ host: "dn-1", pid: 7 }]);
  });

  test("bootstrap mode reclaims exactly once, reports itself done, and exits", async () => {
    let reallocations = 0;
    let spawns = 0;
    const registered: { host: string; pid: number }[] = [];
    const doneHosts: string[] = [];
    dnetRealm().dnet_controller = {
      protocol: DNET_PROTOCOL,
      buildId: "test",
      registerBootstrap: (host: string, pid: number) => registered.push({ host, pid }),
      // The controller's own `bootstrapDone` is what wakes derivation, so the
      // agent's obligation is simply to call it.
      bootstrapDone: (host: string) => doneHosts.push(host),
    } as unknown as ControllerHandle;
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
      (launchId) => {
        (ns.args as unknown[]).push(launchId);
        running = agentMain(ns);
        return ns.pid;
      },
    );
    await running;

    expect(reallocations).toBe(1);
    expect(spawns).toBe(0);
    expect(registered).toEqual([{ host: "dn-1", pid: 77 }]);
    expect(doneHosts).toEqual(["dn-1"]);
  });
});

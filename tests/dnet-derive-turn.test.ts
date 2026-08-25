import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { dnetRealm, type ControllerHandle, type HostEntry } from "../game/dnet/shared.ts";
import { resetLaunchState } from "../game/lib/launch-shared.ts";

/** Derivation is FACT-driven: a write-through files its consequences in the
 * same engine turn, not on the controller's 2 s watchdog.
 *
 * The deadline is real. A winning `authenticate` must reach the vantage's
 * staged queue before the SAME process's exit chain reads it, or the plant
 * waits a tick — and the `.d` hint file waiting on the opened host names a
 * neighbour as of the authenticate instant, so a tick of slack loses it to
 * `exactNeighbourClueEpoch`. These tests therefore advance NO timers: every
 * assertion is reached by draining microtasks alone. */

const VANTAGE = "vantage";
const TARGET = "target";
const REMOTE = "remote";

interface SimHost {
  maxRam: number;
  blockedRam: number;
  depth: number;
  neighbours: string[];
}

const net = new Map<string, SimHost>();

function mockNs(): NS {
  const details = (host: string) => {
    const sim = net.get(host);
    if (!sim) return { isOnline: false } as never;
    return {
      isOnline: true,
      depth: sim.depth,
      blockedRam: sim.blockedRam,
      requiredCharismaSkill: 1,
      difficulty: 1,
      isStationary: false,
      modelId: "factory_default",
      passwordLength: 4,
      passwordFormat: "numeric",
      passwordHint: "",
      data: "",
      logTrafficInterval: 30,
    };
  };
  return {
    args: [],
    pid: 1,
    disableLog: () => {},
    getScriptName: () => "dnet/controller.js",
    getFunctionRamCost: () => 0.2,
    getServerMaxRam: (host: string) => net.get(host)?.maxRam ?? 0,
    getServerUsedRam: () => 0,
    dnsLookup: (host: string) => `ip-${host}`,
    isRunning: () => true,
    kill: () => true,
    dnet: { getServerDetails: details },
  } as unknown as NS;
}

/** Start the real controller and stop at its first `await`. */
async function bootController(): Promise<ControllerHandle> {
  const { main } = await import("../game/dnet/controller.ts");
  (globalThis as Record<string, unknown>)["spawning_script"] = {
    descriptor: {
      kind: "dnet-controller",
      host: VANTAGE,
      buildId: "test",
      generation: "test",
      charisma: 1_000,
    },
    acknowledge: () => {},
  };
  void main(mockNs());
  const handle = dnetRealm().dnet_controller;
  expect(handle, "the controller never published its rendezvous").toBeDefined();
  return handle!;
}

/** Let every queued microtask run, without advancing a single timer. */
const settleMicrotasks = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};

/** A live resident, exactly as an agent registers one. */
function standResident(handle: ControllerHandle, host: string, pid: number): HostEntry {
  handle.adopt(host, {
    pid,
    order: { id: `idle:${host}`, kind: "idle", host, from: host, ramOverrideGb: 3.6, threads: 1, priority: 1_000_000, longLived: false, label: "resident" },
    startedAt: Date.now(),
    beatAt: Date.now(),
    armored: false,
    done: new Promise(() => {}),
    settle: () => {},
  });
  return handle.hosts.get(host)!;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>)["__TELEMETRY__"] = false;
  net.clear();
  net.set(VANTAGE, { maxRam: 64, blockedRam: 0, depth: 0, neighbours: [TARGET] });
  net.set(TARGET, { maxRam: 32, blockedRam: 0, depth: 1, neighbours: [VANTAGE] });
});

afterEach(() => {
  const handle = dnetRealm().dnet_controller;
  if (handle) handle.order({ charisma: 1_000, standDown: true });
  delete dnetRealm().dnet_controller;
  resetLaunchState();
});

describe("a fact derives in its own turn", () => {
  test("a verified credential stages the plant without a tick", async () => {
    const handle = await bootController();
    const vantage = standResident(handle, VANTAGE, 11);
    handle.reportProbe(VANTAGE, [TARGET], Date.now(), 11);

    handle.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();

    const plant = (vantage.staged ?? []).find((order) => order.kind === "plant");
    expect(plant, "the plant was not staged in the credential's own turn").toBeDefined();
    expect(plant!.host).toBe(TARGET);
    expect(plant!.password).toBe("1234");
  });

  test("a reload's restored vault stages a remote plant before it has a map", async () => {
    const handle = await bootController();
    standResident(handle, VANTAGE, 11);
    // The vantage knows its own capacity and nothing else. No probe names
    // REMOTE: on a cold boot the only thing home hands back is the file it
    // saved — passwords and stasis links, never topology.
    handle.reportProbe(VANTAGE, [], Date.now(), 11);
    net.set(REMOTE, { maxRam: 32, blockedRam: 0, depth: 4, neighbours: [] });
    const at = Date.now();
    handle.order({
      charisma: 1_000,
      vaultSnapshot: { entries: [{ hostname: REMOTE, password: "1234", at }], at },
      stasisSnapshot: { hosts: [REMOTE], at },
    });
    await settleMicrotasks();

    const plant = (handle.hosts.get(VANTAGE)?.staged ?? []).find((order) => order.kind === "plant");
    expect(plant, "the restored credential waited for a prober to rediscover its host").toBeDefined();
    expect(plant!.host).toBe(REMOTE);
    // A stasis link is a backdoor, so the vantage never needed to be adjacent.
    expect(plant!.sessionOnly).toBe(true);
  });

  test("a resident standing on a host with dirty files stages its own `ls`", async () => {
    const handle = await bootController();
    standResident(handle, VANTAGE, 11);
    handle.reportProbe(VANTAGE, [TARGET], Date.now(), 11);
    handle.deps.recordCredential({ hostname: TARGET, password: "1234", at: Date.now() });
    await settleMicrotasks();

    // `preparePlant` is what the plant order calls just before exec'ing the
    // resident; it is where the opened host joins `needsInventory`.
    handle.preparePlant(TARGET);
    const target = standResident(handle, TARGET, 12);
    await settleMicrotasks();

    const listing = (target.staged ?? []).find((order) => order.kind === "inventory");
    expect(listing, "the new resident was left waiting for a tick to be told to `ls`").toBeDefined();
    expect(listing!.from).toBe(TARGET);
  });
});

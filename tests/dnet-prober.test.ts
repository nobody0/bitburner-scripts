import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { main as proberMain } from "../game/dnet/prober.ts";
import type { DnetProberLaunch } from "../game/dnet/launch.ts";
import { handoffLaunch } from "../game/lib/launch-shared.ts";
import {
  DNET_PROTOCOL,
  dnetRealm,
  type ControllerHandle,
  type HostEntry,
} from "../game/dnet/shared.ts";

const HOST = "hydro_org";
const NEIGHBOURS = ["darkweb", "stasis_link", "hydro_org_cache"];
const PROBER_PID = 4242;

/** A minimal live controller: it accepts probe reports (storing them on the
 * host entry exactly as the real controller does) and counts derive wakes. */
function installController(): { controller: ControllerHandle; wakes: () => number } {
  let wakeCount = 0;
  const hosts = new Map<string, HostEntry>();
  const controller = {
    protocol: DNET_PROTOCOL,
    generation: "15:0",
    hosts,
    mutationEpoch: 0,
    noteMutation(at: number) {
      void at;
      controller.mutationEpoch++;
      return controller.mutationEpoch;
    },
    wake() { wakeCount++; },
    reportProbe(host: string, neighbours: readonly string[], at: number, pid: number) {
      const entry = hosts.get(host) ?? { hostname: host, lastSeenAt: at, seenAt: {}, dirty: {}, staged: [] };
      entry.prober = { neighbours: [...neighbours], at, pid, epoch: controller.mutationEpoch };
      hosts.set(host, entry);
      wakeCount++;
    },
  } as unknown as ControllerHandle;
  dnetRealm().dnet_controller = controller;
  return { controller, wakes: () => wakeCount };
}

function mutationGate(): { wait: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const wait = new Promise<void>((resolve) => { fire = resolve; });
  return { wait, fire };
}

afterEach(() => {
  delete dnetRealm().dnet_controller;
});

describe("the darknet prober", () => {
  test("readiness waits until a report is stored in a live controller", async () => {
    let gate = mutationGate();
    let stopping = false;
    let ready = 0;
    const ns = {
      disableLog: () => {},
      pid: PROBER_PID,
      dnet: {
        probe: () => [...NEIGHBOURS],
        nextMutation: async () => { await gate.wait; if (stopping) throw new Error("stop prober"); },
      },
    } as unknown as NS;

    delete dnetRealm().dnet_controller;
    let running!: Promise<void>;
    await handoffLaunch<DnetProberLaunch>(
      { kind: "dnet-prober", host: HOST, firstReport: () => { ready++; } },
      () => { running = proberMain(ns); return PROBER_PID; },
    );
    expect(ready).toBe(0);

    const live = installController();
    const firstGate = gate;
    gate = mutationGate();
    firstGate.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(1);
    expect(live.controller.hosts.get(HOST)?.prober?.neighbours).toEqual(NEIGHBOURS);

    stopping = true;
    gate.fire();
    await expect(running).rejects.toThrow("stop prober");
  });

  test("reports at boot and sends later mutations to the current controller", async () => {
    let gate = mutationGate();
    let stopping = false;
    let probes = 0;
    const ns = {
      disableLog: () => {},
      pid: PROBER_PID,
      dnet: {
        probe: () => { probes++; return [...NEIGHBOURS]; },
        nextMutation: async () => { await gate.wait; if (stopping) throw new Error("stop prober"); },
      },
    } as unknown as NS;

    const first = installController();
    let firstReports = 0;
    let running!: Promise<void>;
    expect(await handoffLaunch<DnetProberLaunch>(
      {
        kind: "dnet-prober",
        host: HOST,
        firstReport: () => {
          expect(first.controller.hosts.get(HOST)?.prober?.neighbours).toEqual(NEIGHBOURS);
          firstReports++;
        },
      },
      () => { running = proberMain(ns); return PROBER_PID; },
    )).toBe(PROBER_PID);

    expect(probes).toBe(1);
    expect(first.controller.hosts.get(HOST)?.prober).toMatchObject({ neighbours: NEIGHBOURS, pid: PROBER_PID, epoch: 0 });
    expect(first.wakes()).toBe(1);
    expect(firstReports).toBe(1);

    const replacement = installController();
    const firstGate = gate;
    gate = mutationGate();
    firstGate.fire();
    await Promise.resolve();
    await Promise.resolve();

    expect(probes).toBe(2);
    expect(replacement.controller.hosts.get(HOST)?.prober).toMatchObject({ neighbours: NEIGHBOURS, pid: PROBER_PID, epoch: 1 });
    expect(replacement.wakes()).toBe(1);

    stopping = true;
    gate.fire();
    await expect(running).rejects.toThrow("stop prober");
  });
});

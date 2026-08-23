import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { main as proberMain } from "../game/dnet/prober.ts";
import type { DnetProberLaunch } from "../game/dnet/launch.ts";
import { handoffLaunch } from "../game/lib/launch-shared.ts";
import {
  RENDEZVOUS_PROTOCOL,
  dnetRealm,
  type DnetRendezvous,
} from "../game/dnet/realm.ts";

const HOST = "hydro_org";
const NEIGHBOURS = ["darkweb", "stasis_link", "hydro_org_cache"];
const PROBER_PID = 4242;

function installRendezvous(): { rendezvous: DnetRendezvous; wakes: () => number } {
  let wakeCount = 0;
  const rendezvous = {
    protocol: RENDEZVOUS_PROTOCOL,
    generation: "15:0",
    mutationEpoch: 0,
    noteMutation(this: { mutationEpoch: number }) {
      this.mutationEpoch++;
      return this.mutationEpoch;
    },
    probes: new Map(),
    signalDerive: () => { wakeCount++; },
  } as unknown as DnetRendezvous;
  dnetRealm().dnet_overseer = rendezvous;
  return { rendezvous, wakes: () => wakeCount };
}

function mutationGate(): { wait: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const wait = new Promise<void>((resolve) => { fire = resolve; });
  return { wait, fire };
}

afterEach(() => {
  delete dnetRealm().dnet_overseer;
});

describe("the darknet prober", () => {
  test("readiness waits until a report is stored in a live rendezvous", async () => {
    let gate = mutationGate();
    let stopping = false;
    let ready = 0;
    const ns = {
      disableLog: () => {},
      pid: PROBER_PID,
      dnet: {
        probe: () => [...NEIGHBOURS],
        nextMutation: async () => {
          await gate.wait;
          if (stopping) throw new Error("stop prober");
        },
      },
    } as unknown as NS;

    delete dnetRealm().dnet_overseer;
    let running!: Promise<void>;
    await handoffLaunch<DnetProberLaunch>(
      { kind: "dnet-prober", host: HOST, firstReport: () => { ready++; } },
      () => {
        running = proberMain(ns);
        return PROBER_PID;
      },
    );
    expect(ready).toBe(0);

    const live = installRendezvous();
    const firstGate = gate;
    gate = mutationGate();
    firstGate.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(1);
    expect(live.rendezvous.probes.get(HOST)?.neighbours).toEqual(NEIGHBOURS);

    stopping = true;
    gate.fire();
    await expect(running).rejects.toThrow("stop prober");
  });

  test("reports at boot and sends later mutations to the current overseer", async () => {
    let gate = mutationGate();
    let stopping = false;
    let probes = 0;
    const ns = {
      disableLog: () => {},
      pid: PROBER_PID,
      dnet: {
        probe: () => {
          probes++;
          return [...NEIGHBOURS];
        },
        nextMutation: async () => {
          await gate.wait;
          if (stopping) throw new Error("stop prober");
        },
      },
    } as unknown as NS;

    const first = installRendezvous();
    let firstReports = 0;
    let running!: Promise<void>;
    expect(await handoffLaunch<DnetProberLaunch>(
      {
        kind: "dnet-prober",
        host: HOST,
        firstReport: () => {
          // Readiness means the adjacency is already in the shared realm, not
          // merely that the child captured its launch descriptor.
          expect(first.rendezvous.probes.get(HOST)?.neighbours).toEqual(NEIGHBOURS);
          firstReports++;
        },
      },
      () => {
        running = proberMain(ns);
        return PROBER_PID;
      },
    )).toBe(PROBER_PID);

    expect(probes).toBe(1);
    expect(first.rendezvous.probes.get(HOST)).toMatchObject({
      neighbours: NEIGHBOURS,
      pid: PROBER_PID,
      epoch: 0,
    });
    expect(first.wakes()).toBe(1);
    expect(firstReports).toBe(1);

    const replacement = installRendezvous();
    const firstGate = gate;
    gate = mutationGate();
    firstGate.fire();
    await Promise.resolve();
    await Promise.resolve();

    expect(probes).toBe(2);
    expect(replacement.rendezvous.probes.get(HOST)).toMatchObject({
      neighbours: NEIGHBOURS,
      pid: PROBER_PID,
      epoch: 1,
    });
    expect(replacement.wakes()).toBe(1);

    stopping = true;
    gate.fire();
    await expect(running).rejects.toThrow("stop prober");
  });
});

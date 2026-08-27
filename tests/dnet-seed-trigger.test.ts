import { beforeEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { dnetModule } from "../game/lib/features/dnet.ts";
import type { DriverContext } from "../game/lib/features/index.ts";
import type { NsProxy } from "../game/lib/ns-proxy.ts";
import type { GameState } from "../game/lib/state.ts";
import { postNeeds } from "../shared/strategy/needs.ts";
import { emptyKnowledge } from "../shared/strategy/dnet/host.ts";
import { DNET_RECOVERY_VERSION, type DnetRecoveryState, type DnetSnapshot } from "../game/dnet/wire.ts";
import { emptyDnetProfit } from "../game/dnet/profit.ts";
import type { ControllerHandle } from "../game/dnet/shared.ts";

/** What the beachhead costs when it has nothing to do.
 *
 * The seed is the only part of the home driver that ACTS, and it is gated on a
 * backoff rather than on a beat — so a gate term that can never be satisfied
 * does not fail loudly, it re-execs on a timer for ever while reporting
 * success. That is exactly what a resident term did here once the controller
 * started dispatching darkweb's agents itself: `scp` every 30 s, "everything
 * kept", backoff reset, repeat. Nothing observable distinguished it from a
 * healthy net, which is why it is pinned here rather than left to a panel. */

const GENERATION = "15:0";

function recovery(): DnetRecoveryState {
  return {
    version: DNET_RECOVERY_VERSION,
    generation: GENERATION,
    capturedAt: 0,
    knowledge: emptyKnowledge(GENERATION),
    vault: [],
    codes: {},
    karmaLoss: 0,
    profit: emptyDnetProfit(),
    unknownModels: {},
    agentHostsSeen: [],
    residentsLost: 0,
  };
}

/** A controller standing on `darkweb` with a live beat and a live prober —
 * the healthy steady state, in which home has nothing left to place. */
function standController(now: number, proberPid = 4242): ControllerHandle {
  const handle = {
    protocol: 1,
    buildId: "dev",
    generation: GENERATION,
    pid: 99,
    startedAt: now,
    lastBeatAt: now,
    hosts: new Map([["darkweb", { hostname: "darkweb", prober: { pid: proberPid, at: now } }]]),
    mutationEpoch: 0,
    snapshot: (): DnetSnapshot => ({
      recovery: recovery(),
      residents: [],
      ram: [],
      controllerBeatAt: now,
    }),
    configure() {},
    standDown() {},
    beginProbeRefresh: async () => ({ refresh: { refreshed: Promise.resolve(1) }, launch: true }),
    cancelProbeRefresh() {},
  } as unknown as ControllerHandle;
  (globalThis as Record<string, unknown>).dnet_controller = handle;
  return handle;
}

function harness(now: number) {
  const calls: string[] = [];
  const nsp = ((path: string, ..._args: unknown[]) => {
    calls.push(path);
    return Promise.resolve(true);
  }) as unknown as NsProxy;
  const execs: string[] = [];
  const ns = {
    read: () => "",
    write: () => {},
    exec: (file: string) => { execs.push(file); return 1; },
  } as unknown as NS;
  const state = {
    topics: {
      dnet: {},
      progression: { bitNode: 15, lastAugReset: 0, ownedAugs: {}, sourceFiles: {} },
      player: { skills: { charisma: 100, intelligence: 1 }, mults: {} },
    },
    dirty: new Set(), mirrors: {}, mirrorDirty: new Set(), probeFailures: {}, featureLastRun: {},
  } as unknown as GameState;
  const ctx = {
    ns,
    nsp,
    nspLong: nsp,
    state,
    board: postNeeds([]),
    caps: { unlocked: {} },
    grants: { money: 0, slot: false },
  } as unknown as DriverContext;
  return { ctx, state, calls, execs, now };
}

describe("the darknet beachhead seeds only when something is missing", () => {
  // The driver keeps its working memory at module scope, so without this a
  // seed in one test leaves its backoff standing in the next.
  beforeEach(() => {
    dnetModule.reset?.({ topics: {}, contractQueue: [] } as unknown as GameState, "augmentation");
  });

  test("a healthy controller and prober are left alone, tick after tick", async () => {
    const now = Date.now();
    standController(now);
    const h = harness(now);

    // Many ticks, spanning far more than the 30 s seed backoff. A gate term
    // that can never be satisfied would re-seed on every one of them.
    for (let i = 0; i < 5; i++) await dnetModule.driver.tick(h.ctx);

    expect(h.calls.filter((c) => c === "scp")).toEqual([]);
    expect(h.execs).toEqual([]);
  });

  test("a dead prober is still re-seeded", async () => {
    const now = Date.now();
    standController(now, 0);
    const h = harness(now);

    await dnetModule.driver.tick(h.ctx);

    // The prober is the half home tops up, so its absence must still place one.
    expect(h.calls).toContain("scp");
  });
});

import { describe, expect, test } from "bun:test";
import type { Server } from "@ns";
// Load the probe registry first: local.ts and index.ts import each other, and
// entering the cycle through local.ts trips ALL_PROBES initialization.
import "../game/lib/probes/index.ts";
import { fleetFrom } from "../game/lib/probes/local.ts";
import { stepEndgame, type EndgameView } from "../shared/strategy/progression/endgame.ts";

/** Regressions from the 2026-08-18 wedged BN12 run: the port-opener inference
 * counted home's always-open five ports as an owned toolkit, and the static
 * world-daemon skill formula ran one recursion level low — together freezing
 * rooting, the fleet, and the endgame forecast for the whole node. */

function server(hostname: string, over: Partial<Server> = {}): Server {
  return {
    hostname,
    hasAdminRights: false,
    openPortCount: 0,
    numOpenPortsRequired: 5,
    purchasedByPlayer: false,
    maxRam: 0,
    ramUsed: 0,
    cpuCores: 1,
    ...over,
  } as Server;
}

describe("port-opener inference", () => {
  test("home's always-open ports are not an owned toolkit", () => {
    const rollup = fleetFrom({
      home: { ...server("home", { purchasedByPlayer: true }), hasAdminRights: true, openPortCount: 5 } as Server,
      zer0: { ...server("zer0"), hasAdminRights: true, openPortCount: 1 } as Server,
      phantasy: server("phantasy", { numOpenPortsRequired: 2 }),
    });
    // Only BruteSSH is evidenced by the network (zer0's one open port).
    expect(rollup.portOpeners).toBe(1);
  });

  test("ports opened on ordinary servers still count", () => {
    const rollup = fleetFrom({
      home: { ...server("home", { purchasedByPlayer: true }), hasAdminRights: true, openPortCount: 5 } as Server,
      omnia: server("omnia", { openPortCount: 4 }),
    });
    expect(rollup.portOpeners).toBe(4);
  });
});

describe("world-daemon destroy gate", () => {
  const base: EndgameView = {
    bitNode: 12,
    sourceFiles: { "12": 17 },
    augCount: 40,
    installedAugs: { "The Red Pill": 1 },
    queuedAugs: [],
    ownsRedPill: true,
    redPillInstalled: true,
    worldDaemonRooted: false,
    money: 1e15,
    hackingSkill: 4222,
    lowestCombatSkill: 5000,
    daedalusRep: 3e6,
    gangAvailable: false,
    inGang: false,
    karma: -1e5,
    bladeburnerAvailable: false,
    darknetAvailable: false,
    labyrinthAutomationAvailable: false,
    inBladeburner: false,
    charismaSkill: 5000,
  };

  test("the observed server requirement is authoritative over the static formula", () => {
    // Static BN12@17 believes ~4201 <= 4222 and reports the root stage; the
    // game's actual server demands 4284.74, so the honest stage is the skill
    // regrow — with the hacking need posted so somebody grinds it.
    const observed = stepEndgame({ ...base, worldDaemonRequiredSkill: 4284.73874272882 });
    const daedalus = observed.routes.find((route) => route.id === "daedalus")!;
    expect(daedalus.stage).toBe("world-daemon-regrow");
    expect(daedalus.needs).toContainEqual(expect.objectContaining({ kind: "skill", subject: "hacking", target: 4284.73874272882 }));

    const unobserved = stepEndgame(base);
    const staticRoute = unobserved.routes.find((route) => route.id === "daedalus")!;
    expect(staticRoute.stage).toBe("world-daemon-root");
  });

  test("meeting the observed gate moves on to rooting", () => {
    const decision = stepEndgame({ ...base, hackingSkill: 4300, worldDaemonRequiredSkill: 4284.73874272882 });
    const daedalus = decision.routes.find((route) => route.id === "daedalus")!;
    expect(daedalus.stage).toBe("world-daemon-root");
    expect(daedalus.needs).toContainEqual(expect.objectContaining({ kind: "root", subject: "w0r1d_d43m0n" }));
  });
});

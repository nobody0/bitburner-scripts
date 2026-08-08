import { describe, expect, test } from "bun:test";
import { buildFactionsView } from "../game/lib/features/factions.ts";
import { emptyBoard, noGrants, type DriverContext } from "../game/lib/features/index.ts";
import { DODGED_PROBES, isStepped, type ProbeAcc } from "../game/lib/probes/index.ts";
import { initState } from "../game/lib/state.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";
import { selectFactions } from "../shared/strategy/factions/objective.ts";
import type { FactionsState } from "../shared/telemetry/topics/factions.ts";

function metadataView() {
  const state = initState();
  state.topics.player = {
    money: 1e9,
    factions: [],
    skills: { hacking: 500, strength: 500, defense: 500, dexterity: 500, agility: 500, charisma: 500, intelligence: 0 },
    mults: {}, jobs: {}, city: "Sector-12", location: "home", karma: -100_000, numPeopleKilled: 100,
  } as never;
  state.topics.factions = {
    joined: [],
    invites: [],
    standings: [],
    requirements: { Tetrads: [], "Sector-12": [], Chongqing: [] },
    workTypes: { Tetrads: ["field", "security"], "Sector-12": ["hacking"], Chongqing: ["hacking"] },
    enemies: { Tetrads: [], "Sector-12": ["Chongqing"], Chongqing: ["Sector-12"] },
  };
  const ctx = {
    state,
    caps: deriveCapabilities({ bitNode: 4 }),
    board: emptyBoard(),
    grants: noGrants(),
  } as unknown as DriverContext;
  return buildFactionsView(ctx, 1)!;
}

describe("full faction catalogue metadata", () => {
  test("the stepped probe queries every enum value, not only members", async () => {
    const probe = DODGED_PROBES.find((entry) => entry.id === "factions.standings")!;
    expect(isStepped(probe)).toBe(true);
    if (!isStepped(probe)) return;
    const queried = { work: [] as string[], enemies: [] as string[] };
    const stub = {
      enums: { FactionName: { Tetrads: "Tetrads", Sector12: "Sector-12" } },
      singularity: {
        getFactionWorkTypes: (name: string) => { queried.work.push(name); return name === "Tetrads" ? ["field", "security"] : ["hacking"]; },
        getFactionEnemies: (name: string) => { queried.enemies.push(name); return name === "Sector-12" ? ["Chongqing"] : []; },
      },
    };
    const acc: ProbeAcc = {};
    await probe.steps.find((step) => step.id === "workTypes")!.run(stub as never, {} as never, acc);
    await probe.steps.find((step) => step.id === "enemies")!.run(stub as never, {} as never, acc);
    const data = probe.finish(acc)[0]!.data as FactionsState;
    expect(queried.work).toEqual(["Tetrads", "Sector-12"]);
    expect(queried.enemies).toEqual(["Tetrads", "Sector-12"]);
    expect(data.workTypes?.Tetrads).toEqual(["field", "security"]);
    expect(data.enemies?.["Sector-12"]).toEqual(["Chongqing"]);
  });

  test("an unjoined, uninvited Tetrads remains field/security-only", () => {
    const tetrads = metadataView().factions.find((faction) => faction.name === "Tetrads")!;
    expect(tetrads.joined).toBe(false);
    expect(tetrads.invited).toBe(false);
    expect(tetrads.offers).toEqual({ hacking: false, field: true, security: true });
  });

  test("the objective sees city conflicts before either invitation exists", () => {
    const view = metadataView();
    const candidates = view.factions
      .filter((faction) => faction.name === "Sector-12" || faction.name === "Chongqing")
      .map((faction) => ({ name: faction.name, value: faction.name === "Sector-12" ? 10 : 9, enemies: faction.enemies, reachable: true }));
    const selected = selectFactions(candidates);
    expect(selected.chosen).toEqual(["Sector-12"]);
    expect(selected.foreclosed).toContainEqual({ name: "Chongqing", bannedBy: "Sector-12" });
  });

  test("full maps survive telemetry JSON round trips without entering standings", () => {
    const topic: FactionsState = {
      joined: ["CyberSec"],
      standings: [{ name: "CyberSec", rep: 12, favor: 3 }],
      workTypes: { Tetrads: ["field", "security"] },
      enemies: { "Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"] },
    };
    const roundTrip = JSON.parse(JSON.stringify(topic)) as FactionsState;
    expect(roundTrip.workTypes).toEqual(topic.workTypes);
    expect(roundTrip.enemies).toEqual(topic.enemies);
    expect(roundTrip.standings).toEqual([{ name: "CyberSec", rep: 12, favor: 3 }]);
  });
});

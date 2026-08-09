import { describe, expect, test } from "bun:test";
import { buildFactionsView } from "../game/lib/features/factions.ts";
import { emptyBoard, noGrants, type DriverContext } from "../game/lib/features/index.ts";
import { DODGED_PROBES, isStepped, type ProbeAcc } from "../game/lib/probes/index.ts";
import { initState } from "../game/lib/state.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";
import { selectFactions } from "../shared/strategy/factions/objective.ts";
import { unknownForecast } from "../shared/strategy/progression/forecast.ts";
import type { FactionsState } from "../shared/telemetry/topics/factions.ts";

function metadataView(factionPatch: Partial<FactionsState> = {}, stockPatch?: unknown) {
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
    ...factionPatch,
  };
  if (stockPatch) state.topics.stock = stockPatch as never;
  const ctx = {
    state,
    caps: deriveCapabilities({ bitNode: 4 }),
    board: emptyBoard(),
    grants: noGrants(),
    horizons: {
      node: unknownForecast(0, "test-node", "test fixture"),
      install: unknownForecast(0, "test-install", "test fixture"),
    },
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

  test("only a Shadows of Anarchy invitation or membership proves an infiltration", () => {
    expect(metadataView().requirementView.numInfiltrations).toBe(0);
    expect(metadataView({ invites: ["Shadows of Anarchy"] }).requirementView.numInfiltrations).toBe(1);
    expect(metadataView({ joined: ["Shadows of Anarchy"] }).requirementView.numInfiltrations).toBe(1);
  });
});

describe("the market book counts toward the purchase budget", () => {
  // The seam between the two halves of the fix: the strategy is tested with
  // `pendingProceeds` injected, so without this the driver could stop supplying it
  // — or supply a gross figure — and every strategy test would still pass. The book
  // is liquidated before every install, so it is money the purchase plan may count
  // on; getting it wrong understates the bankroll and picks a worse purchase order.
  function withPositions(positions: unknown[]) {
    return metadataView({}, {
      hasTixApiAccess: true,
      positions,
      portfolioValue: 0,
    } as never);
  }

  const long = { sym: "ECP", shares: 100, sharesShort: 0, value: 5_000_000, avgPx: 1, avgPxShort: 0 };

  test("nets one commission per position off the marked value", () => {
    // `value` is already marked at the bid for longs and the short payoff at the
    // ask, so the spread is priced in; what remains is the exit commission.
    expect(withPositions([long]).pendingProceeds).toBeCloseTo(5_000_000 - 100_000, 6);
    expect(withPositions([long, { ...long, sym: "MGCP" }]).pendingProceeds).toBeCloseTo(
      10_000_000 - 200_000,
      6,
    );
  });

  test("a flat symbol is not a position", () => {
    // Every symbol is probed every tick, held or not. Counting the empty ones would
    // charge commission for exits that will never happen.
    expect(withPositions([{ ...long, shares: 0, value: 0 }]).pendingProceeds).toBe(0);
    expect(withPositions([]).pendingProceeds).toBe(0);
  });

  test("a book worth less than its exit is not a source of funds", () => {
    expect(withPositions([{ ...long, value: 10_000 }]).pendingProceeds).toBe(0);
  });

  test("no market means no proceeds", () => {
    expect(metadataView().pendingProceeds).toBe(0);
  });
});

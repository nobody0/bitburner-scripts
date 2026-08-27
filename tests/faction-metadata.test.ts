import { describe, expect, test } from "bun:test";
import { buildFactionsView } from "../game/lib/features/factions.ts";
import { emptyBoard, noGrants, type DriverContext } from "../game/lib/features/index.ts";
import { PRICED_PROBES } from "../game/lib/probes/index.ts";
import { probeCtx } from "./support/probe-fixture.ts";
import { initState } from "../game/lib/state.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";
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
  test("the standings probe queries every enum value, not only members", async () => {
    const probe = PRICED_PROBES.find((entry) => entry.id === "factions.standings")!;
    const queried = { work: [] as string[], enemies: [] as string[] };
    const ctx = probeCtx({
      "getFavorToDonate": () => 150,
      "singularity.checkFactionInvitations": () => [],
      "singularity.getFactionWorkTypes": (name: never) => {
        queried.work.push(name);
        return name === "Tetrads" ? ["field", "security"] : ["hacking"];
      },
      "singularity.getFactionEnemies": (name: never) => {
        queried.enemies.push(name);
        return name === "Sector-12" ? ["Chongqing"] : [];
      },
    }, { factionNames: { Tetrads: "Tetrads", Sector12: "Sector-12" } });
    const data = (await probe.run(ctx))[0]!.data as FactionsState;
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

  test("city conflicts are visible before either invitation exists", () => {
    const view = metadataView();
    const sector12 = view.factions.find((faction) => faction.name === "Sector-12")!;
    const chongqing = view.factions.find((faction) => faction.name === "Chongqing")!;
    expect(sector12).toMatchObject({ joined: false, invited: false, enemies: ["Chongqing"] });
    expect(chongqing).toMatchObject({ joined: false, invited: false, enemies: ["Sector-12"] });
  });

  test("the live catalogue keeps repeatable NeuroFlux after one level is owned", async () => {
    const probe = PRICED_PROBES.find((entry) => entry.id === "factions.augs")!;
    const ctx = probeCtx({
      "singularity.getOwnedAugmentations": () => ["BitWire", "NeuroFlux Governor"],
      "singularity.getAugmentationsFromFaction": () => ["BitWire", "NeuroFlux Governor"],
      "singularity.getAugmentationPrice": () => 1e6,
      "singularity.getAugmentationRepReq": () => 1e3,
      "singularity.getAugmentationPrereq": () => [],
      "singularity.getAugmentationStats": () => ({ hacking: 1.1 }),
    }, { factionNames: { CyberSec: "CyberSec" } });
    const data = (await probe.run(ctx))[0]!.data as FactionsState;
    // BitWire is owned and drops out; NeuroFlux is repeatable and must not.
    expect(data.offers?.map((offer) => [offer.faction, offer.name]))
      .toEqual([["CyberSec", "NeuroFlux Governor"]]);
    expect(data.augTotal).toBe(1);
  });

  test("only a Shadows of Anarchy invitation or membership proves an infiltration", () => {
    expect(metadataView().requirementView.numInfiltrations).toBe(0);
    expect(metadataView({ invites: ["Shadows of Anarchy"] }).requirementView.numInfiltrations).toBe(1);
    expect(metadataView({ joined: ["Shadows of Anarchy"] }).requirementView.numInfiltrations).toBe(1);
  });

  test("special factions are excluded from the ordinary invitation/work planner", () => {
    const view = metadataView({
      requirements: {
        Bladeburners: [],
        "Church of the Machine God": [],
        "Shadows of Anarchy": [],
      },
    });
    expect(view.factions.map(({ name, special }) => [name, special])).toEqual([
      ["Bladeburners", true],
      ["Church of the Machine God", true],
      ["Shadows of Anarchy", true],
    ]);
  });

  test("a complete live offer catalogue replaces static sellers", () => {
    const view = metadataView({
      ownedAugs: ["NeuroFlux Governor"],
      offers: [
        { name: "BitWire", faction: "CyberSec", price: 1, repReq: 0, affordableRep: true, owned: false },
        { name: "NeuroFlux Governor", faction: "CyberSec", price: 2, repReq: 0, affordableRep: true, owned: false },
      ],
      augTotal: 2,
      requirements: { CyberSec: [], Daedalus: [] },
    });
    expect(view.catalog.get("BitWire")?.factions).toEqual(["CyberSec"]);
    expect(view.catalog.get("NeuroFlux Governor")?.factions).toEqual(["CyberSec"]);
    // Static v3 metadata says Daedalus, but a complete live getter result that
    // omits it is authoritative (as happens for The Red Pill in BN15).
    expect(view.catalog.get("The Red Pill")?.factions).toEqual([]);
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

});

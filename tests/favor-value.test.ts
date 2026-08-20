import { describe, expect, test } from "bun:test";
import { NEUROFLUX, weightsFromMarginals, type AugInfo } from "../shared/strategy/factions/augs.ts";
import { factionFavorPointValues } from "../shared/strategy/factions/favorValue.ts";
import { favorPointValuesFrom } from "../game/lib/features/factions.ts";
import { goFactionFavor } from "../game/lib/features/remaining.ts";
import type { FactionsView } from "../shared/strategy/factions/state.ts";
import type { FactionStanding } from "../shared/strategy/factions/state.ts";

/** A measured route: reputation binds, hacking is the climb behind it. */
const WORTH = new Map([["money", 1_000], ["hacking", 19_174], ["reputation", 49_505]]);

function aug(name: string, factions: string[], overrides: Partial<AugInfo> = {}): AugInfo {
  return {
    name,
    baseCost: 1e9,
    baseRepRequirement: 100_000,
    factions,
    prereqs: [],
    mults: { hacking: 1.1 },
    ...overrides,
  };
}

function standing(name: string, overrides: Partial<FactionStanding> = {}): FactionStanding {
  return {
    name,
    joined: true,
    invited: false,
    rep: 0,
    favor: 0,
    requirements: [],
    enemies: [],
    offers: { hacking: true, field: false, security: false },
    special: false,
    ...overrides,
  };
}

function view(overrides: Partial<FactionsView> = {}): FactionsView {
  return {
    time: 0,
    person: {
      skills: { hacking: 1_000, strength: 100, defense: 100, dexterity: 100, agility: 100, charisma: 100, intelligence: 100 },
      mults: { faction_rep: 1 },
    },
    requirementView: {
      money: 0, skills: {}, karma: 0, numPeopleKilled: 0, augCount: 0, jobs: {}, companyRep: {},
      jobTitles: [], city: "Sector-12", location: "home", backdoored: new Set(), files: new Set(),
      hacknetRam: 0, hacknetCores: 0, hacknetLevels: 0, bitNode: 1, sourceFiles: {}, bladeburnerRank: 0,
      numInfiltrations: 0,
    },
    repContext: { factionWorkRepGain: 1, shareBonus: 1, sf15Level: 0, hasFocusAug: false },
    priceContext: { queuedNonSoA: 0, ownedSoA: 0, neurofluxLevel: 0, sf11Level: 0, augMoneyCost: 1, augRepCost: 1 },
    factions: [],
    catalog: new Map(),
    owned: new Set(),
    queued: new Set(),
    weights: weightsFromMarginals(WORTH),
    horizonSec: 40_000,
    targetAugCount: Infinity,
    favorToDonate: 150,
    moneyGranted: 0,
    moneyAvailable: 0,
    pendingProceeds: 0,
    proceedsSettling: false,
    holdsWorkSlot: false,
    incomePerSec: 0,
    sf4Level: 3,
    bitNode: 1,
    ...overrides,
  };
}

describe("factionFavorPointValues", () => {
  test("an aug-exhausted faction prices at zero", () => {
    const values = factionFavorPointValues(view({
      factions: [standing("Daedalus", { rep: 1_000, favor: 30 })],
      catalog: new Map([["A", aug("A", ["Daedalus"])]]),
      owned: new Set(["A"]),
    }));
    expect(values.get("Daedalus")).toMatchObject({ remainingWorkSec: 0, donationUnlockSec: 0 });
  });

  test("remaining ladder work prices the favor rate channel, bounded by the node horizon", () => {
    const values = factionFavorPointValues(view({
      factions: [standing("Daedalus", { rep: 0, favor: 30 })],
      catalog: new Map([["A", aug("A", ["Daedalus"], { baseRepRequirement: 2_500_000 })]]),
      horizonSec: 5_000,
    }));
    const daedalus = values.get("Daedalus")!;
    expect(daedalus.remainingWorkSec).toBeGreaterThan(0);
    expect(daedalus.remainingWorkSec).toBeLessThanOrEqual(5_000);
  });

  test("high income below the donation gate creates one-time unlock value; above the gate the rate channel dies", () => {
    const catalog = new Map([["A", aug("A", ["Daedalus"], { baseRepRequirement: 2_500_000 })]]);
    // Income so high donation dwarfs work rep.
    const below = factionFavorPointValues(view({
      factions: [standing("Daedalus", { favor: 100 })],
      catalog,
      incomePerSec: 1e12,
    })).get("Daedalus")!;
    expect(below.donationUnlockSec).toBeGreaterThan(0);
    expect(below.remainingWorkSec).toBeGreaterThan(0);
    const above = factionFavorPointValues(view({
      factions: [standing("Daedalus", { favor: 200 })],
      catalog,
      incomePerSec: 1e12,
    })).get("Daedalus")!;
    expect(above.donationUnlockSec).toBe(0);
    expect(above.remainingWorkSec).toBe(0);
  });

  test("the NeuroFlux ladder counts only at the top-favor seller", () => {
    const nfg = aug(NEUROFLUX, ["Sector-12", "Daedalus"], { baseCost: 750e6, baseRepRequirement: 500 });
    const values = factionFavorPointValues(view({
      factions: [
        standing("Daedalus", { favor: 120 }),
        standing("Sector-12", { favor: 40 }),
      ],
      catalog: new Map([[NEUROFLUX, nfg]]),
      incomePerSec: 1e9,
      horizonSec: 10_000,
    }));
    expect(values.get("Daedalus")!.includesNeuroflux).toBe(true);
    expect(values.get("Sector-12")!.includesNeuroflux).toBe(false);
    expect(values.get("Daedalus")!.remainingWorkSec).toBeGreaterThan(0);
    expect(values.get("Sector-12")!.remainingWorkSec).toBe(0);
  });
});
/** Favor value is a FACTIONS fact. Go used to derive it itself, rebuilding the
 * whole augmentation catalogue and re-walking every joined faction's rep
 * ladder on each five-second tick. The factions driver publishes it as a
 * by-product of the view it already builds; Go reads it. */
describe("published favor point values", () => {
  const catalog = new Map([["NeuroCore", aug("NeuroCore", ["Netburners"], { baseRepRequirement: 12_500 })]]);

  test("factions publishes a rounded digest for joined factions only", () => {
    const digest = favorPointValuesFrom(view({
      factions: [standing("Netburners"), standing("Tetrads", { joined: false })],
      catalog,
    }));
    expect(Object.keys(digest)).toEqual(["Netburners"]);
    expect(digest.Netburners!.donateThreshold).toBe(150);
    expect(Number.isInteger(digest.Netburners!.remainingWorkSec)).toBe(true);
    expect(Number.isInteger(digest.Netburners!.donationUnlockSec)).toBe(true);
  });

  test("Go reads the published digest instead of rebuilding the view", () => {
    const favor = goFactionFavor({
      state: {
        topics: {
          factions: {
            joined: ["Netburners"],
            standings: [{ name: "Netburners", rep: 0, favor: 12 }],
            favorPointValues: {
              Netburners: { remainingWorkSec: 4_200, donationUnlockSec: 900, donateThreshold: 150 },
            },
          },
        },
      },
    } as never);
    expect(favor.Netburners).toEqual({
      favor: 12,
      remainingWorkSec: 4_200,
      pointValue: { donationUnlockSec: 900, donateThreshold: 150 },
    });
  });

  test("without the digest Go still reports favor, priced only by the committed intent", () => {
    const favor = goFactionFavor({
      state: {
        topics: {
          factions: {
            joined: ["Netburners"],
            standings: [{ name: "Netburners", rep: 0, favor: 3 }],
            plan: { objective: { intent: { faction: "Netburners", repSec: 600 } } },
          },
        },
      },
    } as never);
    expect(favor.Netburners).toEqual({ favor: 3, remainingWorkSec: 600 });
  });
});

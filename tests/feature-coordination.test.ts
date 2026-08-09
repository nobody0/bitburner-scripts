import { describe, expect, test } from "bun:test";
import { ContributionCache } from "../game/lib/features/contributions.ts";
import { factionsModule } from "../game/lib/features/factions.ts";
import type { ClaimContext } from "../game/lib/features/index.ts";
import type { GameState } from "../game/lib/state.ts";
import { holdsSlot, resolveClaims, type Claim } from "../shared/strategy/arbiter.ts";
import { emptyBoard } from "../shared/strategy/needs.ts";

const time = (by: Claim["by"], id: string, priority: number, holdUntil?: number): Claim => ({
  by, id, resource: "time", amount: 1, priority, mode: "reserve", why: "test", ...(holdUntil ? { holdUntil } : {}),
});
const money = (by: Claim["by"], id: string, amount: number, mode: Claim["mode"]): Claim => ({
  by, id, resource: "money", amount, priority: 50, mode, why: "test",
});

describe("standing feature contributions", () => {
  test("faction work bootstraps its RAM claim with the work-slot claim", () => {
    const state = {
      topics: {
        factions: {
          joined: ["Slum Snakes"],
          standings: [{ name: "Slum Snakes", rep: 0, favor: 0 }],
          offers: [{
            name: "Aug",
            faction: "Slum Snakes",
            price: 1,
            repReq: 100,
            affordableRep: false,
            owned: false,
          }],
          ownedAugs: [],
          plan: {
            context: { holdsWorkSlot: false },
            objective: { factions: ["Slum Snakes"], augmentations: [] },
            action: { type: "idle", reason: "slot", why: "work slot held elsewhere" },
            alternatives: [],
            blockers: [],
          },
        },
      },
    } as unknown as GameState;
    const claims = factionsModule.claims!({
      state,
      now: 0,
      caps: {} as ClaimContext["caps"],
      budgetGb: 8,
      board: emptyBoard(),
      horizons: {} as ClaimContext["horizons"],
      ramPrice: () => 3.5,
    });

    expect(claims).toContainEqual(expect.objectContaining({
      id: "work:Slum Snakes",
      resource: "time",
    }));
    expect(claims).toContainEqual(expect.objectContaining({
      id: "action:workForFaction",
      resource: "ram",
      amount: 3.5,
    }));
  });

  test("faction work survives hacking-only passes and career holdUntil remains effective", () => {
    const cache = new ContributionCache();
    cache.replaceClaims("factions", [time("factions", "work:CyberSec", 60)]);
    let result = resolveClaims({ now: 1_000, pools: { money: 0, ram: 0 }, claims: cache.claims() });
    expect(holdsSlot(result, "factions")).toBe(true);

    // No faction collection on these passes: only the cached contribution is
    // supplied again, exactly as on hacking's 200 ms cadence.
    result = resolveClaims({ now: 1_200, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: result.slot });
    expect(holdsSlot(result, "factions")).toBe(true);

    cache.replaceClaims("career", [time("career", "crime", 75, 2_000)]);
    result = resolveClaims({ now: 1_300, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: result.slot });
    expect(holdsSlot(result, "career")).toBe(true);
    cache.replaceClaims("factions", [time("factions", "urgent", 99)]);
    result = resolveClaims({ now: 1_999, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: result.slot });
    expect(holdsSlot(result, "career")).toBe(true);
    result = resolveClaims({ now: 2_000, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: result.slot });
    expect(holdsSlot(result, "factions")).toBe(true);
  });

  test("dropping a claim releases the slot and locking removes stale claims and needs", () => {
    const cache = new ContributionCache();
    cache.replaceClaims("factions", [time("factions", "work", 60)]);
    cache.replaceNeeds("factions", [{ by: "factions", kind: "backdoor", subject: "CSEC", target: 1, have: 0, weight: 1, urgency: "blocking", why: "test" }]);
    const first = resolveClaims({ now: 1, pools: { money: 0, ram: 0 }, claims: cache.claims() });
    cache.replaceClaims("factions", []);
    const released = resolveClaims({ now: 2, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: first.slot });
    expect(released.slot).toBeUndefined();
    cache.remove("factions");
    expect(cache.claims()).toEqual([]);
    expect(cache.needs()).toEqual([]);
  });

  test("reserves persist between cadences while spend and RAM claims are transient", () => {
    const cache = new ContributionCache();
    const transient = cache.replaceClaims("factions", [
      money("factions", "aug-fund", 70, "reserve"),
      money("factions", "buy-now", 10, "spend"),
      { by: "factions", id: "action", resource: "ram", amount: 2, priority: 50, mode: "spend", why: "test" },
    ]);
    expect(transient.map((claim) => claim.id)).toEqual(["buy-now", "action"]);
    const due = resolveClaims({ now: 1, pools: { money: 100, ram: 2 }, claims: cache.claims(transient) });
    expect(due.remaining.money).toBe(20);
    const between = resolveClaims({ now: 2, pools: { money: 100, ram: 2 }, claims: cache.claims() });
    expect(between.remaining.money).toBe(30);
    expect(between.remaining.ram).toBe(2);
    expect(between.grants.map((grant) => grant.claimId)).toEqual(["aug-fund"]);
  });
});

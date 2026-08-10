import { describe, expect, test } from "bun:test";
import { ContributionCache } from "../game/lib/features/contributions.ts";
import { factionsModule } from "../game/lib/features/factions.ts";
import type { ClaimContext } from "../game/lib/features/index.ts";
import type { GameState } from "../game/lib/state.ts";
import { holdsSlot, PRIORITY, resolveClaims, type Claim } from "../shared/strategy/arbiter.ts";
import { coordinate, emptyDigest, postNeeds } from "../shared/strategy/coordination.ts";
import { emptyBoard, type Need } from "../shared/strategy/needs.ts";

const karmaNeed: Need = {
  by: "factions",
  kind: "karma",
  target: -45,
  have: 0,
  weight: 12,
  urgency: "blocking",
  why: "Slum Snakes requires karma <= -9 and Tetrads -18",
};

const workClaim: Claim = {
  by: "factions",
  id: "work:CyberSec",
  resource: "time",
  amount: 1,
  priority: PRIORITY["factions:work"],
  mode: "spend",
  why: "hacking contracts for CyberSec",
};

const crimeClaim: Claim = {
  by: "career",
  id: "crime:Mug",
  resource: "time",
  amount: 1,
  priority: PRIORITY["career:blocking-need"],
  mode: "spend",
  why: "clearing a blocking karma need",
};

describe("the coordination pass", () => {
  test("stays completely silent when nothing is posted", () => {
    // The Phase-0 neutrality property: a hacking-only run must not gain a
    // single telemetry record from this machinery existing.
    const result = coordinate({ now: 0, money: 1e6, ramGb: 8, board: postNeeds([]), claims: [] });
    expect(result.digest).toBeUndefined();
    expect(result.arbitration.grants).toEqual([]);
  });

  test("a need alone is enough to report, even with no claims", () => {
    const result = coordinate({ now: 0, money: 0, ramGb: 0, board: postNeeds([karmaNeed]), claims: [] });
    expect(result.digest!.needs).toHaveLength(1);
    expect(result.digest!.needs[0]).toMatchObject({
      by: "factions",
      kind: "karma",
      target: -45,
      progress: 0,
      satisfied: false,
    });
  });

  test("a blocking need lets career outbid factions for the single work slot", () => {
    // The end-to-end point of the whole mechanism: factions asks for karma
    // rather than for a crime, and career — which knows HOW — wins the slot.
    const board = postNeeds([karmaNeed]);
    const result = coordinate({ now: 1_000, money: 0, ramGb: 0, board, claims: [workClaim, crimeClaim] });
    expect(result.arbitration.slot).toMatchObject({ by: "career", claimId: "crime:Mug" });
    expect(result.digest!.arbitration.denied).toEqual([
      expect.objectContaining({ by: "factions", id: "work:CyberSec", reason: "slot-held" }),
    ]);
  });

  test("once the karma need is satisfied, factions takes the slot back", () => {
    // career's claim is only high-priority WHILE something is blocked on it;
    // with the need met it would bid `career:income` instead.
    const satisfied = postNeeds([{ ...karmaNeed, have: -50 }]);
    expect(satisfied.open).toEqual([]);
    const idleCrime: Claim = { ...crimeClaim, priority: PRIORITY["career:income"] };
    const result = coordinate({ now: 1_000, money: 0, ramGb: 0, board: satisfied, claims: [workClaim, idleCrime] });
    expect(result.arbitration.slot).toMatchObject({ by: "factions" });
  });

  test("the digest reports slot hold time relative to `now`, bucketed to 10s", () => {
    // Bucketing is deliberate: a per-pass-precise heldMs made the digest
    // differ every 200ms tick, so the change-filtered store wrote ~5 records
    // per second for as long as anyone held the slot.
    const board = postNeeds([]);
    const result = coordinate({
      now: 65_000,
      money: 0,
      ramGb: 0,
      board,
      claims: [workClaim],
      slot: { claimId: "work:CyberSec", by: "factions", priority: PRIORITY["factions:work"], since: 1_500 },
    });
    expect(result.digest!.arbitration.slot).toEqual({
      by: "factions",
      id: "work:CyberSec",
      priority: PRIORITY["factions:work"],
      heldMs: 60_000,
    });
  });

  test("pre-emption is reported so a cancelled activity is never silent", () => {
    const result = coordinate({
      now: 5_000,
      money: 0,
      ramGb: 0,
      board: postNeeds([karmaNeed]),
      claims: [workClaim, crimeClaim],
      slot: { claimId: "work:CyberSec", by: "factions", priority: PRIORITY["factions:work"], since: 1_000 },
    });
    // workForFaction silently cancels whatever was running, so losing the slot
    // is a real loss of progress and has to be visible. heldMs is bucketed to
    // 10s (see the slot test above); 4s of holding reads as 0.
    expect(result.digest!.arbitration.preempted).toEqual({ by: "factions", id: "work:CyberSec", heldMs: 0 });
  });

  test("money and the work slot are allocated in the same pass", () => {
    const fund: Claim = {
      by: "factions",
      id: "aug-fund",
      resource: "money",
      amount: 5e6,
      priority: PRIORITY["factions:aug-fund"],
      mode: "reserve",
      why: "Cranial Signal Processors G1",
    };
    const upgrade: Claim = {
      by: "hacknet",
      id: "level",
      resource: "money",
      amount: 4e6,
      priority: PRIORITY["hacknet:upgrade"],
      mode: "spend",
      why: "node 0 level 40->50",
    };
    const result = coordinate({
      now: 0,
      money: 6e6,
      ramGb: 0,
      board: postNeeds([]),
      claims: [fund, upgrade, workClaim],
    });
    expect(result.digest!.arbitration.grants).toEqual([
      {
        by: "factions", id: "aug-fund", resource: "money", amount: 5e6, mode: "reserve", partial: false,
        wanted: 5e6, priority: PRIORITY["factions:aug-fund"],
      },
      {
        by: "factions", id: "work:CyberSec", resource: "time", amount: 1, mode: "spend", partial: false,
        wanted: 1, priority: PRIORITY["factions:work"],
      },
    ]);
    expect(result.digest!.arbitration.denied[0]).toMatchObject({
      by: "hacknet",
      id: "level",
      priority: PRIORITY["hacknet:upgrade"],
    });
    expect(result.digest!.arbitration.remaining.money).toBe(1e6);
  });

  test("the empty digest clears rather than leaving a stale board behind", () => {
    // merge() drops undefined fields, so `arbitration: undefined` would leave
    // the last arbitration on screen forever — reading as "still blocked" when
    // the truth is "nobody asked".
    const empty = emptyDigest();
    expect(empty.needs).toEqual([]);
    expect(empty.arbitration.grants).toEqual([]);
    expect(empty.arbitration.denied).toEqual([]);
    expect(empty.arbitration.slot).toBeUndefined();
  });
});

const timeClaim = (by: Claim["by"], id: string, priority: number, holdUntil?: number): Claim => ({
  by, id, resource: "time", amount: 1, priority, mode: "reserve", why: "test", ...(holdUntil ? { holdUntil } : {}),
});
const moneyClaim = (by: Claim["by"], id: string, amount: number, mode: Claim["mode"]): Claim => ({
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
    cache.replaceClaims("factions", [timeClaim("factions", "work:CyberSec", 60)]);
    let result = resolveClaims({ now: 1_000, pools: { money: 0, ram: 0 }, claims: cache.claims() });
    expect(holdsSlot(result, "factions")).toBe(true);

    // No faction collection on these passes: only the cached contribution is
    // supplied again, exactly as on hacking's 200 ms cadence.
    result = resolveClaims({ now: 1_200, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: result.slot });
    expect(holdsSlot(result, "factions")).toBe(true);

    cache.replaceClaims("career", [timeClaim("career", "crime", 75, 2_000)]);
    result = resolveClaims({ now: 1_300, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: result.slot });
    expect(holdsSlot(result, "career")).toBe(true);
    cache.replaceClaims("factions", [timeClaim("factions", "urgent", 99)]);
    result = resolveClaims({ now: 1_999, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: result.slot });
    expect(holdsSlot(result, "career")).toBe(true);
    result = resolveClaims({ now: 2_000, pools: { money: 0, ram: 0 }, claims: cache.claims(), slot: result.slot });
    expect(holdsSlot(result, "factions")).toBe(true);
  });

  test("dropping a claim releases the slot and locking removes stale claims and needs", () => {
    const cache = new ContributionCache();
    cache.replaceClaims("factions", [timeClaim("factions", "work", 60)]);
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
      moneyClaim("factions", "aug-fund", 70, "reserve"),
      moneyClaim("factions", "buy-now", 10, "spend"),
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

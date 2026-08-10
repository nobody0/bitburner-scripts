import { describe, expect, test } from "bun:test";
import { MONEY_SPAN, REP_SPAN } from "../shared/strategy/income.ts";
import {
  grantFor,
  grantedAmount,
  holdsSlot,
  PREEMPT_MARGIN,
  PRIORITY,
  priorityOf,
  resolveClaims,
  type ArbiterInput,
  type Claim,
} from "../shared/strategy/arbiter.ts";

function claim(partial: Partial<Claim> & Pick<Claim, "id" | "resource" | "amount" | "priority">): Claim {
  return { by: "factions", mode: "spend", why: "test", ...partial };
}

function input(partial: Partial<ArbiterInput> & Pick<ArbiterInput, "claims">): ArbiterInput {
  return { now: 1_000, pools: { money: 0, ram: 0 }, ...partial };
}

describe("money arbitration", () => {
  test("grants in priority order against a shrinking pool", () => {
    const result = resolveClaims(
      input({
        pools: { money: 100, ram: 0 },
        claims: [
          claim({ id: "hacknet", by: "hacknet", resource: "money", amount: 80, priority: PRIORITY["hacknet:upgrade"] }),
          claim({ id: "augs", by: "factions", resource: "money", amount: 60, priority: PRIORITY["factions:aug-fund"] }),
        ],
      }),
    );
    // The aug fund is higher priority, so it eats first even though the
    // hacknet claim was listed first and is cheaper.
    expect(grantedAmount(result, "factions", "money")).toBe(60);
    expect(result.remaining.money).toBe(40);
    expect(result.denied.map((d) => [d.claimId, d.reason])).toEqual([["hacknet", "partial"]]);
  });

  test("an indivisible claim that cannot be met does NOT consume the pool", () => {
    // Load-bearing: half an augmentation is nothing, so a short indivisible
    // claim must leave its money for a cheaper claim behind it rather than
    // burning the pool and starving everyone.
    const result = resolveClaims(
      input({
        pools: { money: 50, ram: 0 },
        claims: [
          claim({ id: "augs", by: "factions", resource: "money", amount: 1_000, priority: 90 }),
          claim({ id: "node", by: "hacknet", resource: "money", amount: 40, priority: 25 }),
        ],
      }),
    );
    expect(grantedAmount(result, "factions", "money")).toBe(0);
    expect(grantedAmount(result, "hacknet", "money")).toBe(40);
    expect(result.remaining.money).toBe(10);
  });

  test("a divisible claim takes what is left and is flagged partial", () => {
    const result = resolveClaims(
      input({
        pools: { money: 30, ram: 0 },
        claims: [claim({ id: "levels", by: "hacknet", resource: "money", amount: 100, priority: 25, divisible: true })],
      }),
    );
    const grant = grantFor(result, "hacknet", "levels")!;
    expect(grant.amount).toBe(30);
    expect(grant.partial).toBe(true);
    expect(result.remaining.money).toBe(0);
  });

  test("a reserve consumes the pool exactly like a spend — that IS the reservation", () => {
    const result = resolveClaims(
      input({
        pools: { money: 100, ram: 0 },
        claims: [
          claim({ id: "fund", by: "factions", resource: "money", amount: 70, priority: 90, mode: "reserve" }),
          claim({ id: "node", by: "hacknet", resource: "money", amount: 70, priority: 25 }),
        ],
      }),
    );
    expect(result.reserved.map((g) => g.claimId)).toEqual(["fund"]);
    expect(result.remaining.money).toBe(30);
    expect(grantedAmount(result, "hacknet", "money")).toBe(0);
  });

  test("an empty pool denies with `outbid`, a zero claim with `empty`", () => {
    const result = resolveClaims(
      input({
        pools: { money: 0, ram: 0 },
        claims: [
          claim({ id: "a", resource: "money", amount: 5, priority: 10 }),
          claim({ id: "b", resource: "money", amount: 0, priority: 10 }),
        ],
      }),
    );
    expect(new Map(result.denied.map((d) => [d.claimId, d.reason]))).toEqual(
      new Map([
        ["a", "outbid"],
        ["b", "empty"],
      ]),
    );
  });

  test("equal priority breaks on rate, then feature, then claim id — never input order", () => {
    const claims = [
      claim({ id: "z", by: "stock", resource: "money", amount: 10, priority: 50, ratePerSec: 1 }),
      claim({ id: "a", by: "gang", resource: "money", amount: 10, priority: 50, ratePerSec: 9 }),
      claim({ id: "m", by: "corp", resource: "money", amount: 10, priority: 50, ratePerSec: 1 }),
    ];
    const forward = resolveClaims(input({ pools: { money: 20, ram: 0 }, claims }));
    const backward = resolveClaims(input({ pools: { money: 20, ram: 0 }, claims: [...claims].reverse() }));
    const winners = (r: typeof forward) => r.grants.map((g) => g.claimId);
    expect(winners(forward)).toEqual(["a", "m"]);
    expect(winners(backward)).toEqual(winners(forward));
  });

  test("ram is arbitrated on the same rules as money, in its own pool", () => {
    const result = resolveClaims(
      input({
        pools: { money: 0, ram: 8 },
        claims: [
          claim({ id: "detail", by: "gang", resource: "ram", amount: 6, priority: PRIORITY["probe:detail"] }),
          claim({ id: "core", by: "factions", resource: "ram", amount: 5, priority: PRIORITY["probe:core"] }),
        ],
      }),
    );
    expect(grantedAmount(result, "factions", "ram")).toBe(5);
    expect(grantedAmount(result, "gang", "ram")).toBe(0);
    expect(result.remaining.ram).toBe(3);
  });
});

describe("the player-time slot", () => {
  const work = (id: string, by: Claim["by"], priority: number, extra: Partial<Claim> = {}) =>
    claim({ id, by, resource: "time", amount: 1, priority, ...extra });

  test("the highest bidder takes an empty slot, everyone else is slot-held", () => {
    const result = resolveClaims(
      input({ claims: [work("crime", "career", 30), work("faction", "factions", 60)] }),
    );
    expect(result.slot).toMatchObject({ claimId: "faction", by: "factions", since: 1_000 });
    expect(holdsSlot(result, "factions")).toBe(true);
    expect(result.denied.map((d) => [d.claimId, d.reason])).toEqual([["crime", "slot-held"]]);
  });

  test("an incumbent keeps the slot against a marginally better challenger", () => {
    const result = resolveClaims(
      input({
        slot: { claimId: "faction", by: "factions", priority: 60, since: 0 },
        claims: [work("faction", "factions", 60), work("crime", "career", 60 + PREEMPT_MARGIN)],
      }),
    );
    // Exactly at the margin is NOT enough — the challenger must exceed it.
    expect(holdsSlot(result, "factions")).toBe(true);
    expect(result.preempted).toBeUndefined();
    // and it keeps its original `since`, so hold time keeps accumulating.
    expect(result.slot!.since).toBe(0);
  });

  test("a decisively better challenger preempts, and the loss is reported", () => {
    const result = resolveClaims(
      input({
        slot: { claimId: "faction", by: "factions", priority: 60, since: 250 },
        claims: [work("faction", "factions", 60), work("crime", "career", 60 + PREEMPT_MARGIN + 1)],
      }),
    );
    expect(holdsSlot(result, "career")).toBe(true);
    expect(result.preempted).toEqual({ claimId: "faction", by: "factions", heldMs: 750 });
    expect(result.slot!.since).toBe(1_000);
  });

  test("holdUntil refuses pre-emption even by a decisive challenger", () => {
    const base = {
      slot: { claimId: "faction", by: "factions" as const, priority: 60, since: 0 },
      claims: [work("faction", "factions", 60, { holdUntil: 5_000 }), work("crime", "career", 99)],
    };
    expect(holdsSlot(resolveClaims(input({ ...base, now: 4_999 })), "factions")).toBe(true);
    // ...and yields the moment the hold expires.
    expect(holdsSlot(resolveClaims(input({ ...base, now: 5_000 })), "career")).toBe(true);
  });

  test("an incumbent that stops re-issuing has released the slot", () => {
    // This is the release protocol: no separate message, just silence.
    const result = resolveClaims(
      input({
        slot: { claimId: "faction", by: "factions", priority: 60, since: 0 },
        claims: [work("crime", "career", 30)],
      }),
    );
    expect(result.slot).toMatchObject({ claimId: "crime", by: "career", since: 1_000 });
    expect(result.preempted).toBeUndefined();
  });

  test("no time claims leaves the slot unassigned rather than reasserting the old holder", () => {
    const result = resolveClaims(input({ slot: { claimId: "faction", by: "factions", priority: 60, since: 0 }, claims: [] }));
    expect(result.slot).toBeUndefined();
  });

  test("re-issuing the same id across ticks preserves the hold, a new id does not", () => {
    const first = resolveClaims(input({ claims: [work("faction:CyberSec", "factions", 60)] }));
    const second = resolveClaims(
      input({ now: 2_000, slot: first.slot!, claims: [work("faction:CyberSec", "factions", 60)] }),
    );
    expect(second.slot!.since).toBe(1_000);
    const renamed = resolveClaims(
      input({ now: 2_000, slot: first.slot!, claims: [work("faction:NiteSec", "factions", 60)] }),
    );
    expect(renamed.slot!.since).toBe(2_000);
  });
});

describe("arbiter shape", () => {
  test("resolveClaims does not mutate its input", () => {
    const claims = [claim({ id: "a", resource: "money", amount: 10, priority: 5 })];
    const args = input({ pools: { money: 10, ram: 0 }, claims });
    resolveClaims(args);
    expect(args.pools).toEqual({ money: 10, ram: 0 });
    expect(args.claims).toEqual(claims);
  });

  test("negative pools are clamped rather than granting phantom resources", () => {
    const result = resolveClaims(
      input({ pools: { money: -500, ram: 0 }, claims: [claim({ id: "a", resource: "money", amount: 1, priority: 1 })] }),
    );
    expect(result.grants).toEqual([]);
    expect(result.remaining.money).toBe(0);
  });

  test("every named priority is distinct enough to order and resolvable", () => {
    expect(priorityOf("factions:aug-fund")).toBe(PRIORITY["factions:aug-fund"]);
    // Acquisition outranks spending: a decision on stale state is worse than
    // a decision deferred.
    expect(PRIORITY["probe:core"]).toBeGreaterThan(PRIORITY["hacknet:upgrade"]);
    // The aug fund outranks the upgrades that would otherwise always win by
    // being cheaper and always ready.
    expect(PRIORITY["factions:aug-fund"]).toBeGreaterThan(PRIORITY["hacknet:upgrade"]);
    expect(PRIORITY["factions:aug-fund"]).toBeGreaterThan(PRIORITY["stock:position"]);
  });

  test("a blocking need can actually PREEMPT faction work, not merely outbid it", () => {
    // Without this the priority gap is decorative: a blocking need arising
    // while faction work is already running could never interrupt it, and the
    // feature that posted it would wait for the incumbent to give up.
    expect(PRIORITY["career:blocking-need"]).toBeGreaterThan(PRIORITY["factions:work"] + PREEMPT_MARGIN);
    // ...while ordinary career income must NOT be able to.
    expect(PRIORITY["career:income"]).toBeLessThan(PRIORITY["factions:work"]);
    // A blocking need must clear BOTH rates the slot can be scored on, not just
    // reputation. It is usually the gate on a faction UNLOCK, and at 75 it sat below
    // a best-in-game earner's 80 — so crime could outrank the unlock it was funding.
    expect(PRIORITY["career:blocking-need"]).toBeGreaterThan(MONEY_SPAN + PREEMPT_MARGIN);
    expect(PRIORITY["career:blocking-need"]).toBeGreaterThan(REP_SPAN + PREEMPT_MARGIN);
    // ...and still below the lock that protects unbanked progress.
    expect(PRIORITY["career:blocking-need"]).toBeLessThan(PRIORITY["career:progress-lock"]);
    // Wanted/nice requests stay queued behind faction reputation. The margin
    // is large enough that faction work can also take the slot back when one
    // of those requests was the incumbent.
    expect(PRIORITY["factions:work"]).toBeGreaterThan(PRIORITY["career:wanted-request"] + PREEMPT_MARGIN);
    expect(PRIORITY["career:wanted-request"]).toBeGreaterThan(PRIORITY["career:nice-request"]);
    // Progress protection is a transaction lock, independent of objective
    // value, and must beat every ordinary time bid until completion fires.
    expect(PRIORITY["career:progress-lock"]).toBeGreaterThan(PRIORITY["career:blocking-need"]);
  });
});

describe("reinvestment preference — the return tolerance band", () => {
  const band = (over: Partial<Claim> & Pick<Claim, "id">): Claim =>
    claim({ resource: "money", amount: 100, priority: PRIORITY["income:investment"], ...over });

  test("a clearly faster payback wins regardless of absolute rate", () => {
    // The canonical example: a 5-minute payback at $5/s beats a 60-minute
    // payback at $6/s — the early money reinvests. returnPerDollarSec is
    // 1/paybackSec, so 12x apart is far outside the tolerance band.
    const result = resolveClaims(input({
      pools: { money: 100, ram: 0 },
      claims: [
        band({ id: "slow-big", ratePerSec: 6, returnPerDollarSec: 1 / 3600 }),
        band({ id: "fast-small", ratePerSec: 5, returnPerDollarSec: 1 / 300 }),
      ],
    }));
    expect(result.grants[0]!.claimId).toBe("fast-small");
  });

  test("within the band, the bigger absolute earner wins", () => {
    // Near-equal growth rates: prefer the larger stream. This tiebreak was
    // unreachable before the band — float-exact returnPerDollarSec equality
    // never happens.
    const result = resolveClaims(input({
      pools: { money: 100, ram: 0 },
      claims: [
        band({ id: "small", ratePerSec: 5, returnPerDollarSec: 1 / 300 }),
        band({ id: "big", ratePerSec: 50, returnPerDollarSec: 1 / 330 }),
      ],
    }));
    expect(result.grants[0]!.claimId).toBe("big");
  });
});

describe("the imminent-install band sits where the endgame needs it", () => {
  test("above every investment band, below the endgame conversion", () => {
    expect(PRIORITY["progression:imminent-install"]).toBeGreaterThan(PRIORITY["income:investment"]);
    expect(PRIORITY["progression:imminent-install"]).toBeGreaterThan(PRIORITY["hacking:infrastructure"]);
    expect(PRIORITY["progression:imminent-install"]).toBeLessThan(PRIORITY["factions:donate"]);
    expect(PRIORITY["progression:imminent-install"]).toBeLessThan(PRIORITY["factions:aug-fund"]);
    expect(PRIORITY["progression:imminent-install"]).toBeLessThan(PRIORITY["career:blocking-need"]);
  });
});

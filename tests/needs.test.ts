import { describe, expect, test } from "bun:test";
import {
  isSatisfied,
  needDirection,
  needKey,
  needProgress,
  needValueSeconds,
  needWeights,
  openFor,
  postNeeds,
  weightFor,
  type Need,
} from "../shared/strategy/needs.ts";

function need(partial: Partial<Need> & Pick<Need, "kind" | "target" | "have">): Need {
  return {
    by: "factions",
    weight: 1,
    urgency: "wanted",
    ...partial,
  };
}

describe("need direction", () => {
  test("karma is satisfied by going DOWN, everything accumulating by going up", () => {
    // The bug this pins: treating karma like a normal stat makes a satisfied
    // gang precondition look permanently blocking, and career never stops.
    expect(needDirection("karma")).toBe("atMost");
    expect(isSatisfied({ kind: "karma", target: -54_000, have: -54_000 })).toBe(true);
    expect(isSatisfied({ kind: "karma", target: -54_000, have: -60_000 })).toBe(true);
    expect(isSatisfied({ kind: "karma", target: -54_000, have: -10 })).toBe(false);

    expect(isSatisfied({ kind: "skill", target: 100, have: 100 })).toBe(true);
    expect(isSatisfied({ kind: "skill", target: 100, have: 99 })).toBe(false);
  });

  test("quitCompany is satisfied at zero", () => {
    expect(isSatisfied({ kind: "quitCompany", target: 0, have: 0 })).toBe(true);
    expect(isSatisfied({ kind: "quitCompany", target: 0, have: 1 })).toBe(false);
  });
});

describe("needProgress", () => {
  test("is a fraction of the way there, in both directions", () => {
    expect(needProgress({ kind: "skill", target: 100, have: 25 })).toBeCloseTo(0.25, 10);
    expect(needProgress({ kind: "karma", target: -45, have: -10 })).toBeCloseTo(10 / 45, 10);
  });

  test("saturates at 1 once satisfied, never overshoots", () => {
    expect(needProgress({ kind: "skill", target: 100, have: 400 })).toBe(1);
    expect(needProgress({ kind: "karma", target: -45, have: -900 })).toBe(1);
  });

  test("reports 0 rather than inventing a fraction across zero", () => {
    // karma 0 heading to -45: a signed ratio would be -0, and a magnitude
    // ratio would claim progress that has not happened.
    expect(needProgress({ kind: "karma", target: -45, have: 0 })).toBe(0);
    expect(needProgress({ kind: "karma", target: -45, have: 12 })).toBe(0);
    expect(needProgress({ kind: "quitCompany", target: 0, have: 1 })).toBe(0);
  });
});

describe("postNeeds", () => {
  test("indexes by kind and keeps satisfied needs on the board", () => {
    const board = postNeeds([
      need({ kind: "karma", target: -45, have: -50 }),
      need({ kind: "skill", target: 100, have: 10 }),
    ]);
    expect(board.needs).toHaveLength(2);
    expect(board.byKind.karma).toHaveLength(1);
    expect(board.byKind.skill).toHaveLength(1);
    // Satisfied needs stay visible; only `open` filters.
    expect(board.open.map((n) => n.kind)).toEqual(["skill"]);
  });

  test("ordering is blocking-first, then weight, and is independent of input order", () => {
    const a = need({ kind: "karma", target: -45, have: 0, weight: 5, urgency: "wanted", by: "factions" });
    const b = need({ kind: "skill", target: 100, have: 0, weight: 1, urgency: "blocking", by: "gang" });
    const c = need({ kind: "charisma", target: 50, have: 0, weight: 9, urgency: "wanted", by: "career" });
    const forward = postNeeds([a, b, c]).needs.map((n) => n.kind);
    const backward = postNeeds([c, b, a]).needs.map((n) => n.kind);
    expect(forward).toEqual(["skill", "charisma", "karma"]);
    expect(backward).toEqual(forward);
  });

  test("ties break deterministically down to the requester", () => {
    const one = need({ kind: "karma", target: -45, have: 0, by: "gang" });
    const two = need({ kind: "karma", target: -45, have: 0, by: "factions" });
    expect(postNeeds([one, two]).needs.map((n) => n.by)).toEqual(["factions", "gang"]);
    expect(postNeeds([two, one]).needs.map((n) => n.by)).toEqual(["factions", "gang"]);
  });
});

describe("needWeights", () => {
  test("two requesters wanting the same outcome ADD — delivering it unblocks both", () => {
    const board = postNeeds([
      need({ by: "factions", kind: "karma", target: -45, have: 0, weight: 3 }),
      need({ by: "gang", kind: "karma", target: -54_000, have: 0, weight: 7 }),
    ]);
    expect(needWeights(board, ["karma"])).toEqual({ karma: 10 });
  });

  test("a satisfied need contributes nothing — this is what stops career grinding", () => {
    const board = postNeeds([
      need({ by: "factions", kind: "karma", target: -45, have: -50, weight: 3 }),
      need({ by: "gang", kind: "karma", target: -54_000, have: -50, weight: 7 }),
    ]);
    expect(weightFor(needWeights(board, ["karma"]), "karma")).toBe(7);
  });

  test("subjects are separate outcomes", () => {
    const board = postNeeds([
      need({ kind: "backdoor", subject: "CSEC", target: 1, have: 0, weight: 4 }),
      need({ kind: "backdoor", subject: "avmnite-02h", target: 1, have: 0, weight: 6 }),
    ]);
    const weights = needWeights(board, ["backdoor"]);
    expect(weights).toEqual({ "backdoor:CSEC": 4, "backdoor:avmnite-02h": 6 });
    expect(weightFor(weights, "backdoor", "CSEC")).toBe(4);
    expect(weightFor(weights, "backdoor", "nowhere")).toBe(0);
    expect(needKey({ kind: "backdoor", subject: "CSEC" })).toBe("backdoor:CSEC");
    expect(needKey({ kind: "karma" })).toBe("karma");
  });

  test("kinds the consumer cannot act on are excluded", () => {
    const board = postNeeds([
      need({ kind: "karma", target: -45, have: 0, weight: 3 }),
      need({ kind: "hacknetRam", target: 8, have: 1, weight: 5 }),
    ]);
    // career can do crime but cannot buy hacknet RAM.
    expect(needWeights(board, ["karma", "kills"])).toEqual({ karma: 3 });
    expect(openFor(board, ["karma"]).map((n) => n.kind)).toEqual(["karma"]);
  });
});

describe("needValueSeconds", () => {
  test("sums measured values per key, unsatisfied needs only, and omits unmeasured keys", () => {
    const board = postNeeds([
      need({ kind: "backdoor", subject: "CSEC", target: 1, have: 0, weight: 5, valueSec: 3_600, by: "factions" }),
      need({ kind: "backdoor", subject: "CSEC", target: 1, have: 0, weight: 1, valueSec: 400, by: "career" }),
      // Unmeasured poster: contributes nothing — absence is not zero.
      need({ kind: "backdoor", subject: "avmnite-02h", target: 1, have: 0, weight: 2 }),
      // Satisfied: its value has been delivered and must vanish.
      need({ kind: "backdoor", subject: "run4theh111z", target: 1, have: 1, weight: 2, valueSec: 9_999 }),
      // Kind filtered out.
      need({ kind: "root", subject: "CSEC", target: 1, have: 0, weight: 1, valueSec: 50 }),
    ]);
    expect(needValueSeconds(board, ["backdoor"])).toEqual({ "backdoor:CSEC": 4_000 });
  });

  test("valueSec passes through postNeeds untouched and does not perturb weight ordering", () => {
    const board = postNeeds([
      need({ kind: "backdoor", subject: "a", target: 1, have: 0, weight: 1, valueSec: 100_000 }),
      need({ kind: "backdoor", subject: "b", target: 1, have: 0, weight: 5 }),
    ]);
    // The huge BN-second value must NOT outrank the higher weight: ordering
    // stays on (urgency, weight, ...) so existing consumers are unaffected.
    expect(board.open[0]!.subject).toBe("b");
    expect(board.open[1]!.valueSec).toBe(100_000);
  });
});

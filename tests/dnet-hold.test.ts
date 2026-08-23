import { describe, expect, test } from "bun:test";
import { isOnAirGap } from "../shared/strategy/dnet/rates.ts";
import { deriveTasks } from "../shared/strategy/dnet/queue.ts";
import { emptyKnowledge } from "../shared/strategy/dnet/knowledge.ts";
import {
  BACKDOOR_RECYCLER_LIMIT,
  canReachBottomRow,
  chooseLabVantage,
  migrationCalls,
  normalRamForDifficulty,
  openSpareTargets,
  planBackdoors,
  planInduce,
  planStasis,
  stasisTargetDepths,
  type HoldHost,
  type HoldView,
} from "../shared/strategy/dnet/hold.ts";

/** The three darknet actions that cost something, and therefore the three that
 * need a policy rather than a loop.
 *
 * What these tests mostly pin is the set of REFUSALS, because each one encodes a
 * mechanic that is easy to get backwards — and getting one backwards does not
 * produce an error, it produces a run that quietly spends a scarce resource on
 * nothing. */

const host = (over: Partial<HoldHost> & { hostname: string }): HoldHost => ({
  agentAlive: false,
  hasCredential: false,
  ...over,
});

const spent = (over: Partial<HoldHost> & { hostname: string }): HoldHost => host({
  difficulty: 6,
  maxRam: 32,
  blockedRam: 0,
  caches: [],
  contracts: [],
  stormSeed: false,
  hasCredential: true,
  ...over,
});

const view = (hosts: HoldHost[], over: Partial<HoldView> = {}): HoldView => ({
  hosts,
  netDepth: 7,
  stasisLimit: 1,
  charisma: 1000,
  authDurationMultiplier: 1,
  ...over,
});

describe("backdoors recycle the worst fully-harvested servers", () => {
  test("the normal RAM baseline follows immutable difficulty", () => {
    // The generator changes baseline only at six-difficulty boundaries.
    expect(BACKDOOR_RECYCLER_LIMIT).toBe(2);
    expect(normalRamForDifficulty(0)).toBe(16);
    expect(normalRamForDifficulty(5)).toBe(16);
    expect(normalRamForDifficulty(6)).toBe(32);
    expect(normalRamForDifficulty(12)).toBe(64);
  });

  test("a host we hold no credential for is refused because it is not harvested", () => {
    const plan = planBackdoors(view([spent({ hostname: "dn-1", hasCredential: false })]));
    expect(plan.install).toEqual([]);
    expect(plan.refused[0]?.why).toBe("no-credential");
  });

  test("a stationary host is refused", () => {
    const plan = planBackdoors(view([spent({ hostname: "darkweb", isStationary: true })]));
    expect(plan.refused[0]?.why).toBe("stationary");
  });

  test("a pinned host is never a backdoor candidate, because pinning already backdoored it", () => {
    // setStasisLink writes BOTH `hasStasisLink` and `backdoorInstalled`
    // (effects.ts:233-234). An earlier version of this policy sorted pinned
    // hosts first as "free"; that branch could never fire, because such a host
    // is already backdoored and filtered out above.
    const plan = planBackdoors(view([
      spent({ hostname: "reachy" }),
      spent({ hostname: "pinned", stasisLinked: true, backdoored: true }),
    ]));
    expect(plan.install).toEqual(["reachy"]);
  });

  test("a pinned host's implicit backdoor does not eat a recycler slot", () => {
    // The surplus is counted over getBackdooredDarknetServers, which filters
    // !hasStasisLink — so two pinned hosts still leave both free backdoors
    // available. Counting them would silently halve the allowance.
    const plan = planBackdoors(view([
      spent({ hostname: "pin-a", stasisLinked: true, backdoored: true }),
      spent({ hostname: "pin-b", stasisLinked: true, backdoored: true }),
      spent({ hostname: "one" }),
      spent({ hostname: "two" }),
    ]));
    expect(plan.install.sort()).toEqual(["one", "two"]);
  });

  test("true generation outliers lead, normalized across difficulties", () => {
    const plan = planBackdoors(view([
      spent({ hostname: "normal-small", difficulty: 6, maxRam: 32 }),
      spent({ hostname: "outlier-big", difficulty: 18, maxRam: 64 }),
      spent({ hostname: "outlier-small", difficulty: 12, maxRam: 32 }),
    ]));
    expect(plan.install).toEqual(["outlier-small", "outlier-big"]);
  });

  test("two fixed slots are filled with normal fallbacks", () => {
    const hosts = Array.from({ length: 6 }, (_, i) =>
      spent({ hostname: `dn-${i}`, maxRam: 32 + i }));
    const plan = planBackdoors(view(hosts));
    expect(plan.install.length).toBe(2);
    expect(plan.install).toEqual(["dn-0", "dn-1"]);
    expect(plan.refused.some((r) => r.why === "slots-filled")).toBe(true);
  });

  test("only fresh, fully-harvested, disposable hosts are eligible", () => {
    const plan = planBackdoors(view([
      spent({ hostname: "blocked", blockedRam: 1 }),
      spent({ hostname: "cache", caches: ["reward.cache"] }),
      spent({ hostname: "contract", contracts: ["reward.cct"] }),
      spent({ hostname: "seed", stormSeed: true }),
      spent({ hostname: "unknown", caches: undefined }),
      spent({ hostname: "walker", protected: true }),
    ]));
    expect(plan.install).toEqual([]);
    expect(new Set(plan.refused.map((entry) => entry.why))).toEqual(new Set([
      "ram-blocked", "cache-held", "contract-held", "seed-held", "harvest-unknown", "protected",
    ]));
  });

  test("inherited ordinary backdoors consume slots until churn removes them", () => {
    const plan = planBackdoors(view([
      spent({ hostname: "held-a", backdoored: true }),
      spent({ hostname: "held-b", backdoored: true }),
      spent({ hostname: "held-c", backdoored: true }),
      spent({ hostname: "candidate" }),
    ]));
    expect(plan.install).toEqual([]);
    expect(plan.refused.find((entry) => entry.hostname === "candidate")?.why).toBe("slots-filled");
  });

});

describe("stasis is spent on what cannot be rebuilt", () => {
  test("an existing lab pin is a commitment, even when an unpinned neighbour has more RAM", () => {
    const pinned = host({ hostname: "pinned", stasisLinked: true, maxRam: 32 });
    const larger = host({ hostname: "larger", maxRam: 512 });
    expect(chooseLabVantage([larger, pinned])).toBe(pinned);
    expect(chooseLabVantage([host({ hostname: "small", maxRam: 32 }), larger])).toBe(larger);
  });

  test("setStasisLink pins the CALLING host, so a host with nobody on it is refused", () => {
    const plan = planStasis(view([host({ hostname: "dn-1", maxRam: 128 })]));
    expect(plan.pin).toEqual([]);
    expect(plan.refused[0]?.why).toBe("nobody-there");
  });

  test("a stationary host is refused: it is already immune", () => {
    const plan = planStasis(view([host({ hostname: "darkweb", agentAlive: true, isStationary: true })]));
    expect(plan.refused[0]?.why).toBe("already-immune");
  });

  test("the irreplaceable host wins, however big the alternatives are", () => {
    // The maze walker's position is keyed by PID, so a restart costs the whole
    // walk with no way to resume — hours, on the deep labs. Nothing else in the
    // feature has that property, and no amount of RAM outranks it.
    const plan = planStasis(view([
      host({ hostname: "huge", agentAlive: true, maxRam: 512, backdoored: true }),
      host({ hostname: "walker", agentAlive: true, maxRam: 128, blockedRam: 0, irreplaceable: true }),
    ]));
    expect(plan.pin).toEqual(["walker"]);
  });

  test("blocked RAM does not prevent an in-position lab candidate from winning stasis", () => {
    const plan = planStasis(view([
      host({ hostname: "walker", agentAlive: true, maxRam: 128, blockedRam: 96, irreplaceable: true }),
    ]));
    expect(plan.pin).toEqual(["walker"]);
    expect(plan.refused.some((entry) => entry.why === "ram-blocked")).toBe(false);
  });

  test("with the limit spent, a link is recycled only for something strictly better", () => {
    // A release costs the same 12 GB and 30 s to re-apply, so churning links is
    // worse than holding one imperfectly.
    const spent = planStasis(view([
      host({ hostname: "held", agentAlive: true, stasisLinked: true, maxRam: 64 }),
      host({ hostname: "walker", agentAlive: true, blockedRam: 0, irreplaceable: true }),
    ]));
    expect(spent.release).toEqual(["held"]);

    const noBetter = planStasis(view([
      host({ hostname: "held", agentAlive: true, blockedRam: 0, stasisLinked: true, irreplaceable: true }),
      host({ hostname: "ordinary", agentAlive: true, maxRam: 32 }),
    ]));
    expect(noBetter.release).toEqual([]);
  });

  test("the limit really is one until the labyrinth pays out", () => {
    // "b" qualifies for a spare on its own merits — it stands inside an open
    // target's window — so the only thing refusing it is the slot count.
    const plan = planStasis(view([
      host({ hostname: "a", agentAlive: true, blockedRam: 0, irreplaceable: true }),
      host({ hostname: "b", agentAlive: true, depth: 4, maxRam: 128 }),
    ], { spareTargets: [4] }));
    expect(plan.pin).toEqual(["a"]);
    expect(plan.refused.some((r) => r.hostname === "b" && r.why === "no-slot")).toBe(true);
  });

  test("spare targets sit at band centers, allocated to bands by depth mass", () => {
    // netDepth 12: eligible rows are [0-7] (mass 36) and [9] (mass 10) — the
    // walker owns 10-11 and depth 8 is a gap. d'Hondt keeps handing spares to
    // [0-7] (36, 18, 12 all beat 10); centers of 3/2/1 even slices of an
    // 8-row band avoid the gap-adjacent edge rows.
    expect(stasisTargetDepths(12, 3)).toEqual([6, 4, 1]);
    expect(stasisTargetDepths(12, 2)).toEqual([6, 2]);
    expect(stasisTargetDepths(12, 1)).toEqual([4]);
    expect(stasisTargetDepths(12, 0)).toEqual([]);
    // A small early net has one band; centers spread inside it.
    expect(stasisTargetDepths(7, 2)).toEqual([3, 1]);
    // Deeper nets: the deep band's mass wins it the extra spare — one spare at
    // each band's middle, the deepest band densest.
    expect(stasisTargetDepths(19, 3)).toEqual([14, 10, 4]);
    expect(stasisTargetDepths(36, 3)).toEqual([30, 26, 20]);
  });

  test("no target ever sits on a gap row or the walker's rows", () => {
    // Gap rows are structurally empty; the walker's pin covers netDepth-1 and
    // netDepth-2. Band construction makes both impossible by construction.
    for (const netDepth of [7, 12, 19, 23, 36]) {
      for (const spares of [1, 2, 3]) {
        for (const target of stasisTargetDepths(netDepth, spares)) {
          expect(isOnAirGap(target), `gap row targeted at netDepth ${netDepth}`).toBe(false);
          expect(target, `walker row targeted at netDepth ${netDepth}`).toBeLessThanOrEqual(netDepth - 3);
        }
      }
    }
    // Quota is capped at a band's row count: a tiny net cannot hold more
    // targets than it has rows.
    expect(stasisTargetDepths(7, 3)).toEqual([4, 2, 0]);
  });

  test("a lab-less world's first anchor is the bottom row itself", () => {
    // No walker owns it there, and the limit can never grow (the +1s are
    // labyrinth augmentations), so the one link the world ever gets sits at
    // the deepest, hardest-to-reconquer row.
    expect(stasisTargetDepths(5, 1, false)).toEqual([4]);
    const plan = planStasis(view([
      host({ hostname: "deep-big", agentAlive: true, depth: 4, maxRam: 64 }),
      host({ hostname: "mid", agentAlive: true, depth: 2, maxRam: 128 }),
    ], { netDepth: 5, spareTargets: stasisTargetDepths(5, 1, false) }));
    expect(plan.pin).toEqual(["deep-big"]);
  });

  test("per target the biggest host within slack wins, and deeper targets claim first", () => {
    // Both stand within one row of target 7; the bigger takes it, and the
    // smaller — beaten for the only window it could reach — is refused by name.
    const contested = planStasis(view([
      host({ hostname: "small-at-7", agentAlive: true, depth: 7, maxRam: 64 }),
      host({ hostname: "big-at-6", agentAlive: true, depth: 6, maxRam: 256 }),
    ], { stasisLimit: 2, netDepth: 12, spareTargets: [7, 4] }));
    expect(contested.pin).toEqual(["big-at-6"]);
    expect(contested.refused.find((r) => r.hostname === "small-at-7")?.why).toBe("spare-outranked");

    // A host inside TWO windows serves the deeper one, freeing the shallower
    // for somebody else.
    const both = planStasis(view([
      host({ hostname: "between", agentAlive: true, depth: 6, maxRam: 256 }),
      host({ hostname: "at-4", agentAlive: true, depth: 4, maxRam: 32 }),
    ], { stasisLimit: 2, netDepth: 12, spareTargets: [7, 5] }));
    expect(both.pin).toEqual(["between", "at-4"]);
  });

  test("off-target hosts and unmeasured hosts are refused by name, not pinned somewhere clever", () => {
    const plan = planStasis(view([
      host({ hostname: "too-shallow", agentAlive: true, depth: 1, maxRam: 512 }),
      host({ hostname: "unmeasured", agentAlive: true, depth: 7 }),
    ], { stasisLimit: 2, netDepth: 12, spareTargets: [7, 4] }));
    expect(plan.pin).toEqual([]);
    expect(plan.refused.find((r) => r.hostname === "too-shallow")?.why).toBe("spare-off-target");
    expect(plan.refused.find((r) => r.hostname === "unmeasured")?.why).toBe("spare-unmeasured");
  });

  test("a target a held link already serves is closed", () => {
    // The held link at depth 7 serves that target; the candidate beside it has
    // nothing left to claim, and openSpareTargets says exactly which windows
    // remain.
    const hosts = [
      host({ hostname: "held", agentAlive: true, stasisLinked: true, depth: 7, maxRam: 64 }),
      host({ hostname: "rival", agentAlive: true, depth: 7, maxRam: 256 }),
    ];
    expect(openSpareTargets({ hosts, spareTargets: [7, 4] })).toEqual([4]);
    const plan = planStasis(view(hosts, { stasisLimit: 2, netDepth: 12, spareTargets: [7, 4] }));
    expect(plan.pin).toEqual([]);
    expect(plan.refused.find((r) => r.hostname === "rival")?.why).toBe("spare-off-target");
    // And no churn: the on-target held link is never released for a rival.
    expect(plan.release).toEqual([]);
  });

  test("while the labyrinth needs walking, the last free slot is HELD for the walker", () => {
    // The walker is the one thing that cannot be rebuilt, and a run that spent
    // every link on spare coverage and then found the walk's vantage
    // unpinnable has traded the critical thing for a nice one.
    const onTarget = host({ hostname: "spare-4", agentAlive: true, depth: 4, maxRam: 256 });
    const held = planStasis(view([onTarget], { reserveForWalker: true, spareTargets: [4] }));
    expect(held.pin).toEqual([]);
    expect(held.refused.find((r) => r.hostname === "spare-4")?.why).toBe("reserved-for-walker");

    // With TWO slots, the deep spare is pinned and the reservation holds the
    // other from the shallower one.
    const second = host({ hostname: "spare-2", agentAlive: true, depth: 2, maxRam: 256 });
    const roomy = planStasis(view(
      [onTarget, second],
      { stasisLimit: 2, reserveForWalker: true, spareTargets: [4, 2] },
    ));
    expect(roomy.pin).toEqual(["spare-4"]);
    expect(roomy.refused.find((r) => r.hostname === "spare-2")?.why).toBe("reserved-for-walker");
  });

  test("the reservation stands down for the walker itself, and once its link is held", () => {
    // An irreplaceable candidate IS the walker's slot being spent: it takes the
    // reserved slot, and an on-target spare may take any remaining one.
    const walker = host({ hostname: "walker", agentAlive: true, blockedRam: 0, irreplaceable: true });
    const spare = host({ hostname: "spare-4", agentAlive: true, depth: 4, maxRam: 256 });
    const spending = planStasis(view(
      [walker, spare],
      { stasisLimit: 2, reserveForWalker: true, spareTargets: [4] },
    ));
    expect(spending.pin).toEqual(["walker", "spare-4"]);

    // And once the walker's host is LINKED, spares flow freely again.
    const pinnedWalker = host({
      hostname: "walker", agentAlive: true, blockedRam: 0, irreplaceable: true, stasisLinked: true,
    });
    const after = planStasis(view(
      [pinnedWalker, spare],
      { stasisLimit: 2, reserveForWalker: true, spareTargets: [4] },
    ));
    expect(after.pin).toEqual(["spare-4"]);
  });

  test("a held link serving no target is recycled when an on-target candidate waits", () => {
    // Churn-averse in both directions: the off-target link goes only because a
    // strictly better placement is ready, and an on-target link is never
    // released for a same-shaped rival (see the closed-target test above).
    const plan = planStasis(view([
      host({ hostname: "held-shallow", agentAlive: true, stasisLinked: true, depth: 0, maxRam: 64 }),
      host({ hostname: "on-target", agentAlive: true, depth: 4, maxRam: 128 }),
    ], { netDepth: 7, spareTargets: [4] }));
    expect(plan.release).toEqual(["held-shallow"]);
  });

  test("an unqualified candidate can never evict a held link", () => {
    // The release path compares only QUALIFIED challengers: a link held on a
    // modest host is not churned for a mid-net host the spare standard would
    // itself refuse to pin.
    const plan = planStasis(view([
      host({ hostname: "held", agentAlive: true, stasisLinked: true, maxRam: 32 }),
      host({ hostname: "mid-net-big", agentAlive: true, backdoored: true, depth: 3, maxRam: 512 }),
    ]));
    expect(plan.release).toEqual([]);
  });
});

describe("induced migration is anchored on difficulty, not depth", () => {
  test("the band is [difficulty - 2, difficulty + 4], so a shallow host can NEVER reach the bottom", () => {
    // This is the fact that kills the naive "charge it until it sinks" plan.
    // moveDarknetServer's startingDepth defaults to server.difficulty.
    expect(canReachBottomRow(2, 7)).toBe(true);   // 2 + 4 >= 6
    expect(canReachBottomRow(1, 7)).toBe(false);  // 1 + 4 < 6
    expect(canReachBottomRow(18, 23)).toBe(true);
    expect(canReachBottomRow(17, 23)).toBe(false);
    expect(canReachBottomRow(30, 36)).toBe(false);
    expect(canReachBottomRow(31, 36)).toBe(true);
  });

  test("a band that cannot reach the lab still pushes the FRONTIER — when the roll favours down", () => {
    // The band's centre is difficulty + 1. A host at or above that depth moves
    // deeper on average, so general movement down is worth the charge even
    // when the bottom row is out of reach for ever.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["edge"] }),
      host({ hostname: "edge", depth: 2, difficulty: 1, maxRam: 16, hasCredential: true }),
    ], { netDepth: 12 }));
    expect(plan.pushes[0]?.host).toBe("edge");
    expect(plan.pushes[0]?.purpose).toBe("frontier");
  });

  test("...but a host already below its band's centre is left alone: the roll would likely lift it", () => {
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["sunk"] }),
      host({ hostname: "sunk", depth: 4, difficulty: 1, maxRam: 16, hasCredential: true }),
    ], { netDepth: 12 }));
    expect(plan.pushes).toEqual([]);
    expect(plan.refused.find((r) => r.hostname === "sunk")?.why).toBe("no-gain");
  });

  test("a lab candidate outranks any frontier push", () => {
    // Seating the walker's future vantage is what the whole project is for;
    // general movement is what we do when there is nothing to seat.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["edge", "giant"] }),
      host({ hostname: "edge", depth: 2, difficulty: 1, maxRam: 16, hasCredential: true }),
      host({ hostname: "giant", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7 }));
    expect(plan.pushes[0]?.host).toBe("giant");
    expect(plan.pushes[0]?.purpose).toBe("lab");
  });

  test("a full bottom row evicts the smallest STRANGER to free a seat for the candidate", () => {
    // NET_WIDTH seats a row; a landing needs an open one. The evictee is the
    // one push that wants a small uncracked host — the cheapest loss for the
    // same one seat — and ours down there are never touched.
    const strangers = Array.from({ length: 8 }, (_, i) =>
      host({ hostname: `seat-${i}`, depth: 6, difficulty: 5, maxRam: i === 3 ? 16 : 32 }));
    const full = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["seat-3", "giant"] }),
      host({ hostname: "giant", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
      ...strangers,
    ], { netDepth: 7 }));
    expect(full.pushes[0]?.host).toBe("seat-3");
    expect(full.pushes[0]?.purpose).toBe("free-slot");
    // The seats not chosen read as any other bottom-row host.
    expect(full.refused.find((r) => r.hostname === "seat-0")?.why).toBe("already-there");

    // One seat short of full: no eviction, the candidate is simply pushed.
    const roomy = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["seat-3", "giant"] }),
      host({ hostname: "giant", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
      ...strangers.slice(0, 7),
    ], { netDepth: 7 }));
    expect(roomy.pushes[0]?.host).toBe("giant");
    expect(roomy.pushes[0]?.purpose).toBe("lab");

    // And a full row with NO candidate waiting evicts nobody: a freed seat
    // would be a seat freed for nobody.
    const noCandidate = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["seat-3"] }),
      ...strangers,
    ], { netDepth: 7 }));
    expect(noCandidate.pushes).toEqual([]);
  });

  test("the biggest host is chosen, which is also the one whose band reaches deepest", () => {
    // maxRam = 16 * 2^floor(difficulty/6), so size and eligibility are the same
    // property seen twice.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["small", "big"] }),
      host({ hostname: "small", depth: 3, difficulty: 3, maxRam: 16, hasCredential: true }),
      host({ hostname: "big", depth: 4, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7 }));
    expect(plan.pushes[0]?.host).toBe("big");
    expect(plan.pushes[0]?.from).toBe("pusher");
  });

  test("with the walk done, big hosts are pushed into open stasis windows instead", () => {
    // `needLabVantage: false` retires the bottom-row purpose (a landing there
    // buys nothing after the walk), and the same band-capable giants serve the
    // spare seats: difficulty 5 bands to [3, 9], covering the open target at 4.
    const seated = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"] }),
      host({ hostname: "giant", depth: 0, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7, spareTargets: [4], needLabVantage: false }));
    expect(seated.pushes[0]?.host).toBe("giant");
    expect(seated.pushes[0]?.purpose).toBe("seat");

    // A host already INSIDE the open window is never pushed — a re-roll is the
    // one thing that could move it out; `planStasis` pins it where it stands.
    const standing = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"] }),
      host({ hostname: "giant", depth: 4, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7, spareTargets: [4], needLabVantage: false }));
    expect(standing.pushes).toEqual([]);
    expect(standing.refused.find((r) => r.hostname === "giant")?.why).toBe("on-target");

    // A target a held link already serves opens no seat push at all.
    const served = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"] }),
      host({ hostname: "held", stasisLinked: true, depth: 4, maxRam: 64 }),
      host({ hostname: "giant", depth: 0, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7, spareTargets: [4], needLabVantage: false }));
    expect(served.pushes[0]?.purpose).not.toBe("seat");
  });

  test("a resident-carrying host is FERRIED across the air gap into an unconquered band", () => {
    // netDepth 12: bands [0-7] and [9-11], and no edge ever crosses the gap at
    // 8 — a leaked password is unusable over there, so pushing a credentialed
    // host with its resident riding is the only deliberate way in. The
    // carrier's difficulty 6 bands it to [4, 10], reaching rows 9-10.
    const carrier = host({ hostname: "carrier", agentAlive: true, depth: 5, difficulty: 6, maxRam: 128, hasCredential: true });
    const ferry = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, depth: 3, neighbours: ["carrier"] }),
      carrier,
    ], { netDepth: 12, needLabVantage: false }));
    expect(ferry.pushes[0]?.host).toBe("carrier");
    expect(ferry.pushes[0]?.purpose).toBe("ferry");

    // With a resident already standing across the gap, the band is conquered
    // and the same carrier is just frontier movement.
    const conquered = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, depth: 3, neighbours: ["carrier"] }),
      host({ hostname: "outpost", agentAlive: true, depth: 10 }),
      carrier,
    ], { netDepth: 12, needLabVantage: false }));
    expect(conquered.pushes[0]?.purpose).toBe("frontier");

    // And a seat outranks a ferry: the same band also covers an open stasis
    // window, and a slot that survives the storm beats a foothold.
    const seated = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, depth: 3, neighbours: ["carrier"] }),
      { ...carrier, depth: 6 },
    ], { netDepth: 12, needLabVantage: false, spareTargets: [4] }));
    expect(seated.pushes[0]?.purpose).toBe("seat");

    // A carrier with NO resident has no payload, and is not ferried.
    const empty = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, depth: 3, neighbours: ["carrier"] }),
      { ...carrier, agentAlive: false },
    ], { netDepth: 12, needLabVantage: false }));
    expect(empty.pushes[0]?.purpose).toBe("frontier");
  });

  test("every idle neighbour pushes: one push per pusher, several per target", () => {
    // The migration charge accumulates on the TARGET
    // (DarknetState.migrationInductionServers), so two agents flanking one
    // carrier both join it and move it ~2x faster.
    const carrier = host({ hostname: "carrier", agentAlive: true, depth: 5, difficulty: 6, maxRam: 128, hasCredential: true });
    const both = planInduce(view([
      host({ hostname: "p1", agentAlive: true, depth: 4, neighbours: ["carrier"] }),
      host({ hostname: "p2", agentAlive: true, depth: 5, neighbours: ["carrier"] }),
      carrier,
    ], { netDepth: 12, needLabVantage: false }));
    expect(both.pushes.map((entry) => entry.from).sort()).toEqual(["p1", "p2"]);
    expect(both.pushes.every((entry) => entry.host === "carrier")).toBe(true);

    // Separate targets with separate neighbours push IN PARALLEL...
    const spread = planInduce(view([
      host({ hostname: "p1", agentAlive: true, depth: 2, neighbours: ["a"] }),
      host({ hostname: "p2", agentAlive: true, depth: 3, neighbours: ["b"] }),
      host({ hostname: "a", depth: 2, difficulty: 3, maxRam: 32, hasCredential: true }),
      host({ hostname: "b", depth: 3, difficulty: 3, maxRam: 64, hasCredential: true }),
    ], { netDepth: 7, needLabVantage: false }));
    expect(spread.pushes.length).toBe(2);
    expect(new Set(spread.pushes.map((entry) => entry.host))).toEqual(new Set(["a", "b"]));

    // ...but a pusher spent on one target is unavailable for the next: the
    // bigger frontier host takes the only agent, the other waits.
    const contested = planInduce(view([
      host({ hostname: "p1", agentAlive: true, depth: 2, neighbours: ["a", "b"] }),
      host({ hostname: "a", depth: 2, difficulty: 3, maxRam: 32, hasCredential: true }),
      host({ hostname: "b", depth: 3, difficulty: 3, maxRam: 64, hasCredential: true }),
    ], { netDepth: 7, needLabVantage: false }));
    expect(contested.pushes.length).toBe(1);
    expect(contested.pushes[0]?.host).toBe("b");
    expect(contested.refused.find((r) => r.hostname === "a")?.why).toBe("no-pusher");
  });

  test("one host per landing: a second candidate for the same window is push-covered", () => {
    // Racing two hosts toward the same seat wastes the loser; the also-ran is
    // refused by name and its would-be pusher stays free for other work.
    const plan = planInduce(view([
      host({ hostname: "p1", agentAlive: true, depth: 2, neighbours: ["big"] }),
      host({ hostname: "p2", agentAlive: true, depth: 3, neighbours: ["small"] }),
      host({ hostname: "big", depth: 0, difficulty: 5, maxRam: 128, hasCredential: true }),
      host({ hostname: "small", depth: 1, difficulty: 5, maxRam: 32, hasCredential: true }),
    ], { netDepth: 7, needLabVantage: false, spareTargets: [4] }));
    expect(plan.pushes.filter((entry) => entry.purpose === "seat").map((entry) => entry.host)).toEqual(["big"]);
    expect(plan.refused.find((r) => r.hostname === "small")?.why).toBe("push-covered");
  });

  test("a host with no neighbour of ours is refused: it cannot push itself", () => {
    // "scripts cannot target the server they are running on".
    const plan = planInduce(view([
      host({ hostname: "lonely", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7 }));
    expect(plan.pushes).toEqual([]);
    expect(plan.refused.find((r) => r.hostname === "lonely")?.why).toBe("no-pusher");
  });

  test("anything irreplaceable is never pushed, because a failed move DELETES it", () => {
    // moveDarknetServer deletes rather than leaving a server floating when no
    // open position exists. Rare — getAllOpenPositions widens recursively — but
    // total when it happens.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["walker"] }),
      host({ hostname: "walker", depth: 3, difficulty: 5, maxRam: 128, irreplaceable: true }),
    ], { netDepth: 7 }));
    expect(plan.refused.find((r) => r.hostname === "walker")?.why).toBe("irreplaceable");
  });

  test("a host already on the bottom row is left alone — it is already lab-adjacent", () => {
    // addServerToNetwork connects anything landing at netDepth - 1 to the lab.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["there"] }),
      host({ hostname: "there", depth: 6, difficulty: 5, maxRam: 128 }),
    ], { netDepth: 7 }));
    expect(plan.pushes).toEqual([]);
    expect(plan.refused.find((r) => r.hostname === "there")?.why).toBe("already-there");
  });

  test("a pinned host is refused, since pinning it is what stops it moving", () => {
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["pinned"] }),
      host({ hostname: "pinned", depth: 3, difficulty: 5, maxRam: 128, stasisLinked: true }),
    ], { netDepth: 7 }));
    expect(plan.refused.find((r) => r.hostname === "pinned")?.why).toBe("pinned");
  });

  test("threads come from the pusher, and they divide the project directly", () => {
    // The charge is linear in the calling script's threads and the 6 s wait is
    // constant, so a 40 GB pusher against a ~5.6 GB/thread induce job turns a
    // 334-call project into ~48.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"], freeGb: 40 }),
      host({ hostname: "giant", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7, induceGbPerThread: 5.6 }));
    expect(plan.pushes[0]?.threads).toBe(7);
    expect(plan.pushes[0]?.expectedCalls).toBe(migrationCalls(5, 1000, 7));

    // Without the pricing input, one thread — today's behaviour.
    const unpriced = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"], freeGb: 40 }),
      host({ hostname: "giant", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7 }));
    expect(unpriced.pushes[0]?.threads).toBe(1);
  });

  test("only an authenticated host is pushed — the refusal that fixes itself", () => {
    // A push moves the host wherever it lands, but only a host we hold the
    // password for carries our session with it and can be re-planted where it
    // arrives. The answer to this refusal is the cracking queue, not charge.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["stranger"] }),
      host({ hostname: "stranger", depth: 3, difficulty: 5, maxRam: 128 }),
    ], { netDepth: 7 }));
    expect(plan.pushes).toEqual([]);
    expect(plan.refused.find((r) => r.hostname === "stranger")?.why).toBe("not-ours");
  });

  test("the charge cost is priced from the engine's own formula", () => {
    // ((charisma + 500) / (difficulty * 200 + 1000)) * 0.01 * threads, to 1.0.
    // At charisma 1000 against difficulty 20 that is 0.003 a call.
    expect(migrationCalls(20, 1000, 1)).toBe(334);
    // Threads divide it directly, which is what makes this affordable at all.
    expect(migrationCalls(20, 1000, 16)).toBe(21);
    // And charisma helps, which is why the charisma engines come first.
    expect(migrationCalls(20, 5000, 16)).toBeLessThan(migrationCalls(20, 1000, 16));
  });
});

describe("the queue files pushes per vantage", () => {
  // The migration charge accumulates on the TARGET, so several vantages may
  // legitimately charge one host at once — the dedup that must survive is
  // per (kind, target, vantage), like the walk's, never per target.
  test("two vantages may charge one target; the same vantage never twice", () => {
    const tasks = deriveTasks(emptyKnowledge("t"), 0, {
      agents: new Set(["v1", "v2"]),
      hold: [
        { kind: "induce", host: "t1", from: "v1", reason: "push" },
        { kind: "induce", host: "t1", from: "v2", reason: "push" },
      ],
      inFlight: new Map([["t1", [{ from: "v1", kind: "induce" as const }]]]),
    });
    const induces = tasks.filter((task) => task.kind === "induce");
    expect(induces.map((task) => task.id)).toEqual(["induce:t1:v2"]);
  });
});

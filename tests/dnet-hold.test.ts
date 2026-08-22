import { describe, expect, test } from "bun:test";
import {
  canReachBottomRow,
  freeBackdoorAllowance,
  migrationCalls,
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

const view = (hosts: HoldHost[], over: Partial<HoldView> = {}): HoldView => ({
  hosts,
  netDepth: 7,
  stasisLimit: 1,
  charisma: 1000,
  authDurationMultiplier: 1,
  ...over,
});

describe("backdoors are spent only where they buy reach", () => {
  test("two are always free, and the allowance grows as the net is rooted", () => {
    // max(rootedMovable / (NET_WIDTH * 3), 2) — effects.ts:91-97.
    expect(freeBackdoorAllowance(0)).toBe(2);
    expect(freeBackdoorAllowance(24)).toBe(2);
    expect(freeBackdoorAllowance(48)).toBe(2);
    expect(freeBackdoorAllowance(240)).toBe(10);
  });

  test("a host we hold no credential for is refused, because exec still checks the session", () => {
    // The bypass covers the CONNECTION requirement only. This is the refusal
    // that stops us spending instability on a host we cannot exec to anyway.
    const plan = planBackdoors(view([host({ hostname: "dn-1", neighbours: ["dn-2"] })]));
    expect(plan.install).toEqual([]);
    expect(plan.refused[0]?.why).toBe("no-credential");
  });

  test("a stationary host is refused", () => {
    const plan = planBackdoors(view([host({ hostname: "darkweb", hasCredential: true, isStationary: true })]));
    expect(plan.refused[0]?.why).toBe("stationary");
  });

  test("a pinned host is never a backdoor candidate, because pinning already backdoored it", () => {
    // setStasisLink writes BOTH `hasStasisLink` and `backdoorInstalled`
    // (effects.ts:233-234). An earlier version of this policy sorted pinned
    // hosts first as "free"; that branch could never fire, because such a host
    // is already backdoored and filtered out above.
    const plan = planBackdoors(view([
      host({ hostname: "reachy", hasCredential: true, agentAlive: true, neighbours: ["a", "b", "c", "d"] }),
      host({ hostname: "pinned", hasCredential: true, agentAlive: true, stasisLinked: true, backdoored: true, neighbours: ["a"] }),
    ]));
    expect(plan.install).toEqual(["reachy"]);
  });

  test("a pinned host's backdoor does NOT eat the free allowance", () => {
    // The surplus is counted over getBackdooredDarknetServers, which filters
    // !hasStasisLink — so two pinned hosts still leave both free backdoors
    // available. Counting them would silently halve the allowance.
    const plan = planBackdoors(view([
      host({ hostname: "pin-a", hasCredential: true, agentAlive: true, stasisLinked: true, backdoored: true, neighbours: ["x"] }),
      host({ hostname: "pin-b", hasCredential: true, agentAlive: true, stasisLinked: true, backdoored: true, neighbours: ["x"] }),
      host({ hostname: "one", hasCredential: true, agentAlive: true, neighbours: ["x"] }),
      host({ hostname: "two", hasCredential: true, agentAlive: true, neighbours: ["x"] }),
    ]));
    expect(plan.install.sort()).toEqual(["one", "two"]);
  });

  test("nothing is installed once authentication is already slowed", () => {
    // Instability taxes EVERY authenticate in the run, which is the thing we do
    // most — so past the ceiling more backdoors make the net slower, not bigger.
    const plan = planBackdoors(view(
      [host({ hostname: "dn-1", hasCredential: true, agentAlive: true, neighbours: ["x"] })],
      { authDurationMultiplier: 1.4 },
    ));
    expect(plan.install).toEqual([]);
    expect(plan.refused[0]?.why).toBe("unstable");
  });

  test("the free allowance bounds how many are installed", () => {
    const hosts = Array.from({ length: 6 }, (_, i) =>
      host({ hostname: `dn-${i}`, hasCredential: true, agentAlive: true, neighbours: ["x"] }));
    const plan = planBackdoors(view(hosts));
    expect(plan.install.length).toBe(2);
    expect(plan.refused.some((r) => r.why === "allowance-spent")).toBe(true);
  });
});

describe("stasis is spent on what cannot be rebuilt", () => {
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
      host({ hostname: "walker", agentAlive: true, maxRam: 128, irreplaceable: true }),
    ]));
    expect(plan.pin).toEqual(["walker"]);
  });

  test("with the limit spent, a link is recycled only for something strictly better", () => {
    // A release costs the same 12 GB and 30 s to re-apply, so churning links is
    // worse than holding one imperfectly.
    const spent = planStasis(view([
      host({ hostname: "held", agentAlive: true, stasisLinked: true, maxRam: 64 }),
      host({ hostname: "walker", agentAlive: true, irreplaceable: true }),
    ]));
    expect(spent.release).toEqual(["held"]);

    const noBetter = planStasis(view([
      host({ hostname: "held", agentAlive: true, stasisLinked: true, irreplaceable: true }),
      host({ hostname: "ordinary", agentAlive: true, maxRam: 32 }),
    ]));
    expect(noBetter.release).toEqual([]);
  });

  test("the limit really is one until the labyrinth pays out", () => {
    // "b" qualifies for a spare on its own merits — it stands inside an open
    // target's window — so the only thing refusing it is the slot count.
    const plan = planStasis(view([
      host({ hostname: "a", agentAlive: true, irreplaceable: true }),
      host({ hostname: "b", agentAlive: true, depth: 4, maxRam: 128 }),
    ], { spareTargets: [4] }));
    expect(plan.pin).toEqual(["a"]);
    expect(plan.refused.some((r) => r.hostname === "b" && r.why === "no-slot")).toBe(true);
  });

  test("spare targets are depth-weighted: evenly spread by mass, denser toward the bottom", () => {
    // Equal-mass centers under w(d) = d + 1, over the rows below the walker's
    // own coverage (netDepth - 1 and netDepth - 2 are his).
    expect(stasisTargetDepths(12, 3)).toEqual([9, 7, 4]);
    expect(stasisTargetDepths(12, 1)).toEqual([7]);
    expect(stasisTargetDepths(7, 2)).toEqual([4, 2]);
    expect(stasisTargetDepths(12, 0)).toEqual([]);
    // The walker's rows never appear: nothing in a 12-deep net targets 10 or 11.
    for (const target of stasisTargetDepths(12, 3)) expect(target).toBeLessThanOrEqual(9);
  });

  test("an air-gap target steps to the row beside it — nothing can sit on the gap", () => {
    // Depth 8 is structurally empty (isOnAirGap), and the two-spare split of a
    // 12-deep net would land its deep center exactly there.
    expect(stasisTargetDepths(12, 2)).toEqual([7, 5]);
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
    const walker = host({ hostname: "walker", agentAlive: true, irreplaceable: true });
    const spare = host({ hostname: "spare-4", agentAlive: true, depth: 4, maxRam: 256 });
    const spending = planStasis(view(
      [walker, spare],
      { stasisLimit: 2, reserveForWalker: true, spareTargets: [4] },
    ));
    expect(spending.pin).toEqual(["walker", "spare-4"]);

    // And once the walker's host is LINKED, spares flow freely again.
    const pinnedWalker = host({
      hostname: "walker", agentAlive: true, irreplaceable: true, stasisLinked: true,
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
    expect(plan.push?.host).toBe("edge");
    expect(plan.push?.purpose).toBe("frontier");
  });

  test("...but a host already below its band's centre is left alone: the roll would likely lift it", () => {
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["sunk"] }),
      host({ hostname: "sunk", depth: 4, difficulty: 1, maxRam: 16, hasCredential: true }),
    ], { netDepth: 12 }));
    expect(plan.push).toBeUndefined();
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
    expect(plan.push?.host).toBe("giant");
    expect(plan.push?.purpose).toBe("lab");
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
    expect(full.push?.host).toBe("seat-3");
    expect(full.push?.purpose).toBe("free-slot");
    // The seats not chosen read as any other bottom-row host.
    expect(full.refused.find((r) => r.hostname === "seat-0")?.why).toBe("already-there");

    // One seat short of full: no eviction, the candidate is simply pushed.
    const roomy = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["seat-3", "giant"] }),
      host({ hostname: "giant", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
      ...strangers.slice(0, 7),
    ], { netDepth: 7 }));
    expect(roomy.push?.host).toBe("giant");
    expect(roomy.push?.purpose).toBe("lab");

    // And a full row with NO candidate waiting evicts nobody: a freed seat
    // would be a seat freed for nobody.
    const noCandidate = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["seat-3"] }),
      ...strangers,
    ], { netDepth: 7 }));
    expect(noCandidate.push).toBeUndefined();
  });

  test("the biggest host is chosen, which is also the one whose band reaches deepest", () => {
    // maxRam = 16 * 2^floor(difficulty/6), so size and eligibility are the same
    // property seen twice.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["small", "big"] }),
      host({ hostname: "small", depth: 3, difficulty: 3, maxRam: 16, hasCredential: true }),
      host({ hostname: "big", depth: 4, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7 }));
    expect(plan.push?.host).toBe("big");
    expect(plan.push?.from).toBe("pusher");
  });

  test("with the walk done, big hosts are pushed into open stasis windows instead", () => {
    // `needLabVantage: false` retires the bottom-row purpose (a landing there
    // buys nothing after the walk), and the same band-capable giants serve the
    // spare seats: difficulty 5 bands to [3, 9], covering the open target at 4.
    const seated = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"] }),
      host({ hostname: "giant", depth: 0, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7, spareTargets: [4], needLabVantage: false }));
    expect(seated.push?.host).toBe("giant");
    expect(seated.push?.purpose).toBe("seat");

    // A host already INSIDE the open window is never pushed — a re-roll is the
    // one thing that could move it out; `planStasis` pins it where it stands.
    const standing = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"] }),
      host({ hostname: "giant", depth: 4, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7, spareTargets: [4], needLabVantage: false }));
    expect(standing.push).toBeUndefined();
    expect(standing.refused.find((r) => r.hostname === "giant")?.why).toBe("on-target");

    // A target a held link already serves opens no seat push at all.
    const served = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"] }),
      host({ hostname: "held", stasisLinked: true, depth: 4, maxRam: 64 }),
      host({ hostname: "giant", depth: 0, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7, spareTargets: [4], needLabVantage: false }));
    expect(served.push?.purpose).not.toBe("seat");
  });

  test("a host with no neighbour of ours is refused: it cannot push itself", () => {
    // "scripts cannot target the server they are running on".
    const plan = planInduce(view([
      host({ hostname: "lonely", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7 }));
    expect(plan.push).toBeUndefined();
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
    expect(plan.push).toBeUndefined();
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
    expect(plan.push?.threads).toBe(7);
    expect(plan.push?.expectedCalls).toBe(migrationCalls(5, 1000, 7));

    // Without the pricing input, one thread — today's behaviour.
    const unpriced = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["giant"], freeGb: 40 }),
      host({ hostname: "giant", depth: 3, difficulty: 5, maxRam: 128, hasCredential: true }),
    ], { netDepth: 7 }));
    expect(unpriced.push?.threads).toBe(1);
  });

  test("only an authenticated host is pushed — the refusal that fixes itself", () => {
    // A push moves the host wherever it lands, but only a host we hold the
    // password for carries our session with it and can be re-planted where it
    // arrives. The answer to this refusal is the cracking queue, not charge.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["stranger"] }),
      host({ hostname: "stranger", depth: 3, difficulty: 5, maxRam: 128 }),
    ], { netDepth: 7 }));
    expect(plan.push).toBeUndefined();
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

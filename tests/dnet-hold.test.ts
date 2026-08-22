import { describe, expect, test } from "bun:test";
import {
  canReachBottomRow,
  freeBackdoorAllowance,
  migrationCalls,
  planBackdoors,
  planInduce,
  planStasis,
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
      host({ hostname: "huge", agentAlive: true, maxRam: 512, blockedRam: 0, backdoored: true }),
      host({ hostname: "walker", agentAlive: true, maxRam: 128, irreplaceable: true }),
    ]));
    expect(plan.pin).toEqual(["walker"]);
  });

  test("with the limit spent, a link is recycled only for something strictly better", () => {
    // A release costs the same 12 GB and 30 s to re-apply, so churning links is
    // worse than holding one imperfectly.
    const spent = planStasis(view([
      host({ hostname: "held", agentAlive: true, stasisLinked: true, maxRam: 64, blockedRam: 0 }),
      host({ hostname: "walker", agentAlive: true, irreplaceable: true }),
    ]));
    expect(spent.release).toEqual(["held"]);

    const noBetter = planStasis(view([
      host({ hostname: "held", agentAlive: true, stasisLinked: true, irreplaceable: true }),
      host({ hostname: "ordinary", agentAlive: true, maxRam: 32, blockedRam: 0 }),
    ]));
    expect(noBetter.release).toEqual([]);
  });

  test("the limit really is one until the labyrinth pays out", () => {
    const plan = planStasis(view([
      host({ hostname: "a", agentAlive: true, irreplaceable: true }),
      host({ hostname: "b", agentAlive: true, backdoored: true }),
    ]));
    expect(plan.pin.length).toBe(1);
    expect(plan.refused.some((r) => r.why === "no-slot")).toBe(true);
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

  test("a host whose band cannot reach the bottom is refused as NEVER, not as not-yet", () => {
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["shallow"] }),
      host({ hostname: "shallow", depth: 1, difficulty: 1, maxRam: 16 }),
    ], { netDepth: 7 }));
    expect(plan.push).toBeUndefined();
    expect(plan.refused.find((r) => r.hostname === "shallow")?.why).toBe("band-too-shallow");
  });

  test("the biggest host is chosen, which is also the one whose band reaches deepest", () => {
    // maxRam = 16 * 2^floor(difficulty/6), so size and eligibility are the same
    // property seen twice.
    const plan = planInduce(view([
      host({ hostname: "pusher", agentAlive: true, neighbours: ["small", "big"] }),
      host({ hostname: "small", depth: 3, difficulty: 3, maxRam: 16 }),
      host({ hostname: "big", depth: 4, difficulty: 5, maxRam: 128 }),
    ], { netDepth: 7 }));
    expect(plan.push?.host).toBe("big");
    expect(plan.push?.from).toBe("pusher");
  });

  test("a host with no neighbour of ours is refused: it cannot push itself", () => {
    // "scripts cannot target the server they are running on".
    const plan = planInduce(view([
      host({ hostname: "lonely", depth: 3, difficulty: 5, maxRam: 128 }),
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

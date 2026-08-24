/** `DispatchMemory` carries four indices derived from `tracked` — byTarget,
 * ourGbByHost, weakenPending and heldGbByRole — that replaced eight full walks
 * of the in-flight ledger per dispatcher pass. They are only worth anything if
 * they cannot drift, so this holds every one of them against a full recompute
 * after every single mutation, over randomized op lifecycles.
 *
 * The float sums are the real hazard: subtract-then-add is not associative, so
 * a host or role that should reach exactly zero can retain a phantom fraction
 * of a GB and keep a dead entry alive forever. */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../sim/core/rng.ts";
import {
  initDispatch,
  releaseFailed,
  trackOp,
  type DispatchMemory,
  type Tracked,
} from "../shared/strategy/dispatch.ts";

type Role = "h" | "w1" | "g" | "w2";

/** Mirrors dispatch.ts `weakenGroupKey`, which is module-private. */
const groupKey = (target: string, landing: number): string =>
  `${target}${String.fromCharCode(0)}${landing}`;

/** What the eight deleted walks would have computed. */
function recompute(memory: DispatchMemory) {
  const byTarget = new Map<string, number[]>();
  const ourGbByHost = new Map<string, number>();
  const weakenPending = new Map<string, number>();
  const heldGbByRole: Record<Role, number> = { h: 0, w1: 0, g: 0, w2: 0 };
  for (const [opId, tracked] of memory.tracked) {
    byTarget.set(tracked.target, [...(byTarget.get(tracked.target) ?? []), opId]);
    if (tracked.workerId === undefined) {
      ourGbByHost.set(tracked.hostname, (ourGbByHost.get(tracked.hostname) ?? 0) + tracked.gb);
      if (tracked.segment === "farm" && tracked.jitRole) heldGbByRole[tracked.jitRole] += tracked.gb;
    }
    if (tracked.kind === "weaken" && tracked.landing !== undefined) {
      const key = groupKey(tracked.target, tracked.landing);
      weakenPending.set(key, (weakenPending.get(key) ?? 0) + 1);
    }
  }
  return { byTarget, ourGbByHost, weakenPending, heldGbByRole };
}

function compare(memory: DispatchMemory): void {
  const expected = recompute(memory);

  // byTarget must agree on membership AND on per-target opId order: which of
  // two same-instant ops folds first is observable in the landing prediction.
  const actualTargets = new Map([...memory.byTarget].map(([host, ops]) => [host, [...ops.keys()]]));
  expect(actualTargets).toEqual(expected.byTarget);
  for (const [host, opIds] of expected.byTarget) {
    const expectedLandingIds = opIds
      .filter((opId) => memory.tracked.get(opId)?.landing !== undefined)
      .sort((a, b) =>
        memory.tracked.get(a)!.landing! - memory.tracked.get(b)!.landing! || a - b
      );
    const actualLandingIds = memory.landingByTarget.get(host)?.chunks
      .flatMap((chunk) => chunk.map((entry) => entry.op.opId)) ?? [];
    expect(actualLandingIds).toEqual(expectedLandingIds);
  }

  expect([...memory.weakenPending].sort()).toEqual([...expected.weakenPending].sort());

  expect([...memory.ourGbByHost.keys()].sort()).toEqual([...expected.ourGbByHost.keys()].sort());
  for (const [host, gb] of expected.ourGbByHost) {
    expect(memory.ourGbByHost.get(host)!).toBeCloseTo(gb, 6);
  }
  for (const role of ["h", "w1", "g", "w2"] as const) {
    expect(memory.heldGbByRole[role]).toBeCloseTo(expected.heldGbByRole[role], 6);
  }
}

const HOSTS = ["home", "pserv-0", "pserv-1", "foodnstuff"];
const TARGETS = ["n00dles", "joesguns", "phantasy"];
const KINDS = ["hack", "grow", "weaken"] as const;
const ROLES: (Role | undefined)[] = ["h", "w1", "g", "w2", undefined];

describe("dispatch ledger indices", () => {
  test("match a full recompute across randomized op lifecycles", () => {
    const random = mulberry32(20260819);
    const memory = initDispatch();
    const liveOps: number[] = [];
    let nextOpId = 1;

    for (let step = 0; step < 3_000; step++) {
      if (random() < 0.55 || liveOps.length === 0) {
        const opId = nextOpId++;
        const kind = KINDS[Math.floor(random() * KINDS.length)]!;
        const pooled = random() < 0.3;
        const tracked: Tracked = {
          hostname: HOSTS[Math.floor(random() * HOSTS.length)]!,
          target: TARGETS[Math.floor(random() * TARGETS.length)]!,
          kind,
          segment: random() < 0.7 ? "farm" : "prep",
          // Sizes that do not sum cleanly in binary, so residue shows up.
          gb: 1.75 * (1 + Math.floor(random() * 4)) + 0.1,
          wave: random() < 0.2,
          // Landings collide deliberately: a spread weaken is several ops on
          // one (target, landing) group and only the last settles it.
          ...(random() < 0.85 ? { landing: 1_000 * (1 + Math.floor(random() * 3)) } : {}),
          ...(pooled ? { workerId: 500_000 + opId } : {}),
          ...(random() < 0.8 ? { jitRole: ROLES[Math.floor(random() * ROLES.length)] } : {}),
        };
        trackOp(memory, opId, tracked);
        memory.inFlight[kind]++;
        liveOps.push(opId);
      } else {
        const at = Math.floor(random() * liveOps.length);
        releaseFailed(memory, [liveOps[at]!]);
        liveOps.splice(at, 1);
      }
      compare(memory);
    }

    // Draining everything must leave the indices genuinely empty, not holding
    // zero-valued entries for hosts and groups that are long gone.
    releaseFailed(memory, [...liveOps]);
    compare(memory);
    expect(memory.tracked.size).toBe(0);
    expect(memory.byTarget.size).toBe(0);
    expect(memory.ourGbByHost.size).toBe(0);
    expect(memory.weakenPending.size).toBe(0);
    expect(memory.heldGbByRole).toEqual({ h: 0, w1: 0, g: 0, w2: 0 });
  });

  test("counts a spread weaken as one group until its last fragment settles", () => {
    const memory = initDispatch();
    const fragment = (): Tracked => ({
      hostname: "home",
      target: "n00dles",
      kind: "weaken",
      segment: "farm",
      gb: 1.75,
      wave: false,
      landing: 2_000,
      jitRole: "w2",
    });
    trackOp(memory, 1, fragment());
    trackOp(memory, 2, fragment());
    expect([...memory.weakenPending.values()]).toEqual([2]);
    releaseFailed(memory, [1]);
    expect([...memory.weakenPending.values()]).toEqual([1]);
    releaseFailed(memory, [2]);
    expect(memory.weakenPending.size).toBe(0);
  });

  test("a pooled op holds no host or role RAM of its own", () => {
    const memory = initDispatch();
    trackOp(memory, 1, {
      hostname: "home",
      target: "n00dles",
      kind: "grow",
      segment: "farm",
      gb: 1.75,
      wave: false,
      landing: 10,
      jitRole: "g",
      workerId: 42,
    });
    // Its RAM belongs to the resident worker, which the pool ledger counts.
    expect(memory.ourGbByHost.size).toBe(0);
    expect(memory.heldGbByRole.g).toBe(0);
    expect([...memory.byTarget.get("n00dles")!.keys()]).toEqual([1]);
  });
});

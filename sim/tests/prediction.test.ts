import { beforeAll, describe, expect, test } from "bun:test";
import { hackPercent, makeHackContext, type HackContext } from "../../shared/formulas.ts";
import { growThreadsAtLanding, hackThreadsAtLanding, predictAtLanding, projectedSkill, sizeBatchAtLanding, type LedgerOp } from "../../shared/strategy/prediction.ts";
import { calculateSkill } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { solveCycle, type TargetStatics } from "../../shared/strategy/targeting.ts";
import { applyGrow, applyHack, applyWeaken, serverFromSpec, type SimServer } from "../core/effects.ts";
import { mockPerson, mockServer } from "../core/mocks.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { calculateExp } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";

beforeAll(() => replaceCurrentNodeMults(getBitNodeMultipliers(1, 1)));

/** The landing-state fold vs the REAL game effects (sim/core/effects.ts is the
 * vendored-formula oracle). Success-assumed hacks, frozen skill — exactly the
 * assumptions the dispatcher sizes under. */

const JOESGUNS: TargetStatics = {
  hostname: "joesguns",
  minDifficulty: 5,
  moneyMax: 62_500_000,
  requiredHackingSkill: 10,
  serverGrowth: 20,
  baseDifficulty: 15,
};

function scenario(skill: number): { ctx: HackContext; person: ReturnType<typeof mockPerson>; server: SimServer } {
  const person = mockPerson();
  person.skills.hacking = skill;
  person.exp.hacking = calculateExp(skill);
  const ctx = makeHackContext({ skill, intelligence: 0, mults: person.mults }, {});
  const server = serverFromSpec(
    {
      hostname: JOESGUNS.hostname,
      hackDifficulty: JOESGUNS.baseDifficulty,
      // serverFromSpec derives moneyMax = 25x the spec's available money.
      moneyAvailable: JOESGUNS.moneyMax / 25,
      requiredHackingSkill: JOESGUNS.requiredHackingSkill,
      serverGrowth: JOESGUNS.serverGrowth,
      numOpenPortsRequired: 0,
      maxRam: 16,
    },
    mockServer() as SimServer,
  );
  server.hasAdminRights = true;
  server.hackDifficulty = server.minDifficulty;
  server.moneyAvailable = server.moneyMax;
  return { ctx, person, server };
}

function relClose(a: number, b: number, tol = 1e-9): void {
  expect(Math.abs(a - b) / Math.max(1, Math.abs(b))).toBeLessThan(tol);
}

describe("predictAtLanding", () => {
  test("a full HWGW batch folds to exactly what the game effects produce", () => {
    const skill = 300;
    const { ctx, person, server } = scenario(skill);
    const s = solveCycle(ctx, JOESGUNS)!;
    const ops: LedgerOp[] = [
      { kind: "hack", threads: s.hackThreads, effectThreads: s.hackThreads, landing: 100, opId: 1 },
      { kind: "weaken", threads: s.weaken1Threads, effectThreads: s.weaken1Threads, landing: 200, opId: 2 },
      { kind: "grow", threads: s.growThreads, effectThreads: s.growThreads, landing: 300, opId: 3 },
      { kind: "weaken", threads: s.weaken2Threads, effectThreads: s.weaken2Threads, landing: 400, opId: 4 },
    ];
    const start = { hackDifficulty: server.hackDifficulty, moneyAvailable: server.moneyAvailable };

    // Mid-fold: after H and W1 only.
    const mid = predictAtLanding(ctx, JOESGUNS, start, ops, 250);
    applyHack(server, person, s.hackThreads, 0); // forced success
    person.skills.hacking = skill;
    person.exp.hacking = calculateExp(skill);
    applyWeaken(server, person, s.weaken1Threads, 1);
    person.skills.hacking = skill;
    person.exp.hacking = calculateExp(skill);
    relClose(mid.hackDifficulty, server.hackDifficulty);
    // The game floors drained dollars; the fold is exact-real. Sub-dollar slack.
    relClose(mid.moneyAvailable, server.moneyAvailable, 1e-6);

    // Full fold: back at (minSec, moneyMax).
    const full = predictAtLanding(ctx, JOESGUNS, start, ops, 400);
    applyGrow(server, person, s.growThreads, 1);
    person.skills.hacking = skill;
    person.exp.hacking = calculateExp(skill);
    applyWeaken(server, person, s.weaken2Threads, 1);
    relClose(full.hackDifficulty, server.hackDifficulty);
    relClose(full.moneyAvailable, server.moneyAvailable, 1e-6);
    expect(full.hackDifficulty).toBe(JOESGUNS.minDifficulty);
  });

  test("equal modeled landings fold in deterministic opId order", () => {
    const { ctx } = scenario(300);
    const start = { hackDifficulty: 5, moneyAvailable: 62_500_000 };
    const hack: Omit<LedgerOp, "opId"> = { kind: "hack", threads: 10, effectThreads: 10, landing: 500 };
    const grow: Omit<LedgerOp, "opId"> = { kind: "grow", threads: 50, effectThreads: 50, landing: 500 };
    // Array order must not matter; opId order must.
    const hackFirst = predictAtLanding(ctx, JOESGUNS, start, [{ ...grow, opId: 2 }, { ...hack, opId: 1 }], 500);
    const growFirst = predictAtLanding(ctx, JOESGUNS, start, [{ ...hack, opId: 2 }, { ...grow, opId: 1 }], 500);
    // A hack landing first steals from full money; landing second it steals
    // from the (capped) grown value — either way the two orders differ in
    // security-at-grow, so the folds must differ deterministically.
    expect(hackFirst.moneyAvailable).not.toBe(growFirst.moneyAvailable);
    // Same opId order, shuffled array -> identical result.
    const again = predictAtLanding(ctx, JOESGUNS, start, [{ ...hack, opId: 1 }, { ...grow, opId: 2 }], 500);
    expect(again).toEqual(hackFirst);
  });

  test("ops landing after the query time are ignored", () => {
    const { ctx } = scenario(300);
    const start = { hackDifficulty: 6, moneyAvailable: 1_000 };
    const later: LedgerOp[] = [{ kind: "weaken", threads: 100, effectThreads: 100, landing: 900, opId: 1 }];
    expect(predictAtLanding(ctx, JOESGUNS, start, later, 800)).toEqual(start);
  });

  test("split grow calls preserve the upstream per-call additive term", () => {
    const skill = 300;
    const { ctx, person, server } = scenario(skill);
    server.moneyAvailable = 1_000;
    const start = { hackDifficulty: server.hackDifficulty, moneyAvailable: server.moneyAvailable };
    const ops: LedgerOp[] = [
      { kind: "grow", threads: 7, effectThreads: 7 * (1 + 7 / 16), landing: 100, opId: 1 },
      { kind: "grow", threads: 11, effectThreads: 11, landing: 100, opId: 2 },
    ];

    const predicted = predictAtLanding(ctx, JOESGUNS, start, ops, 100);
    applyGrow(server, person, 7, 8);
    person.skills.hacking = skill;
    person.exp.hacking = calculateExp(skill);
    applyGrow(server, person, 11, 1);

    relClose(predicted.moneyAvailable, server.moneyAvailable, 1e-12);
    relClose(predicted.hackDifficulty, server.hackDifficulty, 1e-12);
  });
});

describe("sizeBatchAtLanding", () => {
  test("at 90% money planning retains H and strengthens its support solve", () => {
    const { ctx } = scenario(300);
    const base = solveCycle(ctx, JOESGUNS)!;
    const sized = sizeBatchAtLanding(
      ctx,
      JOESGUNS,
      { hackDifficulty: JOESGUNS.minDifficulty, moneyAvailable: 0.9 * JOESGUNS.moneyMax },
      base,
    )!;
    expect(sized.hackThreads).toBe(base.hackThreads);
    expect(sized.growThreads).toBeGreaterThan(base.growThreads);
    expect(sized.weaken2Threads).toBeGreaterThanOrEqual(base.weaken2Threads);
  });

  test("dispatch shrink subtracts exactly the missing-money threads", () => {
    const { ctx } = scenario(300);
    const base = solveCycle(ctx, JOESGUNS)!;
    const predicted = { hackDifficulty: JOESGUNS.minDifficulty, moneyAvailable: 0.9 * JOESGUNS.moneyMax };
    const percentPerThread = hackPercent(ctx, JOESGUNS.minDifficulty, JOESGUNS.requiredHackingSkill);
    expect(hackThreadsAtLanding(ctx, JOESGUNS, predicted, base.hackThreads)).toBe(
      Math.max(0, base.hackThreads - Math.ceil(0.1 / percentPerThread)),
    );
  });

  test("grow is clamped by the weaken cover, never by what the money asks for", () => {
    // The asymmetry is the point. Under-growing costs money for one batch and
    // the next hack's arrival-money brake absorbs it; over-growing adds
    // security the already-committed W2 was not sized for, which is the error
    // that outruns its own cover. So the cover wins even when a larger grow
    // would pay.
    const { ctx } = scenario(300);
    const cover = 3;
    const drained = { hackDifficulty: JOESGUNS.minDifficulty, moneyAvailable: 1 };
    const sized = growThreadsAtLanding(ctx, JOESGUNS, drained, 1_000_000, cover);
    expect(sized).toBeDefined();
    expect(sized!).toBeCloseTo(cover, 9);

    // ...and by the spawned block, which `opts.threads` may never exceed.
    const spawnBound = growThreadsAtLanding(ctx, JOESGUNS, drained, 2, 1_000_000);
    expect(spawnBound!).toBeCloseTo(2, 9);
  });

  test("a fully-grown arrival needs no grow at all", () => {
    const { ctx } = scenario(300);
    expect(growThreadsAtLanding(
      ctx,
      JOESGUNS,
      { hackDifficulty: JOESGUNS.minDifficulty, moneyAvailable: JOESGUNS.moneyMax },
      50,
      1_000,
    )).toBe(0);
  });

  test("grow refuses to launch above the prepped security tolerance", () => {
    // Same contract as hackThreadsAtLanding: undefined means do not launch,
    // because the whole solve assumed minimum security.
    const { ctx } = scenario(300);
    expect(growThreadsAtLanding(
      ctx,
      JOESGUNS,
      { hackDifficulty: JOESGUNS.minDifficulty + 5, moneyAvailable: 1 },
      50,
      1_000,
    )).toBeUndefined();
  });

  test("money too low for one safe thread cancels only the hack", () => {
    const { ctx } = scenario(300);
    const base = solveCycle(ctx, JOESGUNS)!;
    expect(hackThreadsAtLanding(
      ctx,
      JOESGUNS,
      { hackDifficulty: JOESGUNS.minDifficulty, moneyAvailable: 0 },
      base.hackThreads,
    )).toBe(0);
  });

  test("HGW sizes grow and weaken cover from admitted predicted security", () => {
    const skill = 300;
    const { ctx, person, server } = scenario(skill);
    const base = solveCycle(ctx, JOESGUNS, 1, undefined, undefined, "hgw")!;
    const predicted = {
      hackDifficulty: JOESGUNS.minDifficulty + 1,
      moneyAvailable: 0.9 * JOESGUNS.moneyMax,
    };
    const sized = sizeBatchAtLanding(ctx, JOESGUNS, predicted, base)!;

    expect(sized.growThreads).toBeGreaterThan(base.growThreads);
    expect(sized.weaken2Threads).toBeGreaterThan(base.weaken2Threads);

    // Apply the emitted H -> G -> W shape through the vendored game effects.
    // It must restore both invariants even from the top of isPrepped's
    // admitted security band.
    server.hackDifficulty = predicted.hackDifficulty;
    server.moneyAvailable = predicted.moneyAvailable;
    applyHack(server, person, sized.hackThreads, 0);
    person.skills.hacking = skill;
    person.exp.hacking = calculateExp(skill);
    applyGrow(server, person, sized.growThreads, 1);
    person.skills.hacking = skill;
    person.exp.hacking = calculateExp(skill);
    applyWeaken(server, person, sized.weaken2Threads, 1);
    expect(server.moneyAvailable).toBe(server.moneyMax);
    expect(server.hackDifficulty).toBe(server.minDifficulty);
  });

  test("predicted security above the prepped tolerance skips the batch", () => {
    const { ctx } = scenario(300);
    const base = solveCycle(ctx, JOESGUNS)!;
    expect(
      sizeBatchAtLanding(
        ctx,
        JOESGUNS,
        { hackDifficulty: JOESGUNS.minDifficulty + 1.5, moneyAvailable: JOESGUNS.moneyMax },
        base,
      ),
    ).toBeUndefined();
  });

  test("at the exact steady state the sizing reproduces the solution", () => {
    const { ctx } = scenario(300);
    const base = solveCycle(ctx, JOESGUNS)!;
    const sized = sizeBatchAtLanding(
      ctx,
      JOESGUNS,
      { hackDifficulty: JOESGUNS.minDifficulty, moneyAvailable: JOESGUNS.moneyMax },
      base,
    )!;
    expect(sized.growThreads).toBe(base.growThreads);
    expect(sized.weaken2Threads).toBe(base.weaken2Threads);
  });
});

describe("projectedSkill", () => {
  const base = { hackingExp: 1_000_000, expPerSec: 0, hackingMult: 1, currentSkill: 0 };

  test("is the identity when no experience rate is known", () => {
    const current = calculateSkill(base.hackingExp, 1);
    const input = { ...base, currentSkill: current };
    expect(projectedSkill(input, 60_000)).toBe(current);
    expect(projectedSkill({ ...input, expPerSec: 500 }, 0)).toBe(current);
    expect(projectedSkill({ ...input, expPerSec: 500 }, Infinity)).toBe(current);
  });

  test("matches the vendored skill curve at the horizon", () => {
    const expPerSec = 25_000;
    const horizonMs = 90_000;
    const input = {
      ...base,
      expPerSec,
      currentSkill: calculateSkill(base.hackingExp, 1),
    };
    expect(projectedSkill(input, horizonMs)).toBe(
      calculateSkill(base.hackingExp + expPerSec * (horizonMs / 1_000), 1),
    );
  });

  test("honours the multiplier, and never projects BELOW the current skill", () => {
    const expPerSec = 25_000;
    const horizonMs = 90_000;
    // BN9's HackingLevelMultiplier, folded into the mult by the caller. It has
    // to reach the curve: at 0.25 the projected level is a quarter of what the
    // unmultiplied curve would claim.
    const mult = 0.25;
    const projected = calculateSkill(base.hackingExp + expPerSec * (horizonMs / 1_000), mult);
    const unmultiplied = calculateSkill(base.hackingExp + expPerSec * (horizonMs / 1_000), 1);
    expect(projected).toBeLessThan(unmultiplied);
    expect(projectedSkill({ ...base, expPerSec, hackingMult: mult, currentSkill: 1 }, horizonMs))
      .toBe(projected);
    // A stale/high current skill wins: the projection may only ever shrink a
    // hack, so over-estimating the level is the recoverable direction.
    expect(projectedSkill(
      { ...base, expPerSec, hackingMult: mult, currentSkill: projected + 50 },
      horizonMs,
    )).toBe(projected + 50);
  });
});

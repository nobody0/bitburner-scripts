import { beforeAll, describe, expect, test } from "bun:test";
import { makeHackContext, type HackContext } from "../../shared/formulas.ts";
import { predictAtLanding, sizeBatchAtLanding, type LedgerOp } from "../../shared/strategy/prediction.ts";
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
  test("at 90% money the grow cover GROWS relative to the steady-state solve", () => {
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

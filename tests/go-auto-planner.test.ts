import { describe, expect, test } from "bun:test";
import { planNextGame } from "../tools/combined-standalone/auto-planner.ts";

const ROUTES: Record<string, { entryPhase: number; waits: number }> = {
  Netburners: { entryPhase: 10, waits: 2 },
  "Slum Snakes": { entryPhase: 14, waits: 6 },
  Illuminati: { entryPhase: 400, waits: 392 },
};

function input(overrides: Partial<Parameters<typeof planNextGame>[0]> = {}) {
  return {
    enemies: Object.keys(ROUTES),
    routeFor: (enemy: string) => ROUTES[enemy],
    winsFor: () => 0,
    expectedGamePhases: () => 30,
    ...overrides,
  };
}

describe("combined standalone auto planner", () => {
  test("reserves the rare enemy as target on a win tie and fills the gap", () => {
    const decision = planNextGame(input());
    expect(decision.target).toBe("Illuminati");
    expect(decision.kind).toBe("filler");
    // Least-wins tie broken toward the rarer window means fillers still play
    // in scarcity order among themselves: Slum Snakes (waits 6) outranks
    // Netburners (waits 2) as the first filler that fits.
    expect(decision.enemy).toBe("Slum Snakes");
  });

  test("dodges to the target when no filler fits its window", () => {
    const decision = planNextGame(input({ expectedGamePhases: () => 1_000 }));
    expect(decision.kind).toBe("target");
    expect(decision.enemy).toBe("Illuminati");
    expect(decision.targetWaits).toBe(392);
  });

  test("the least-wins enemy is always the target regardless of scarcity", () => {
    const decision = planNextGame(input({
      winsFor: (enemy: string) => enemy === "Netburners" ? 0 : 5,
    }));
    expect(decision.target).toBe("Netburners");
    // Netburners' window is only 2 phases away: nothing fits before it.
    expect(decision.kind).toBe("target");
    expect(decision.enemy).toBe("Netburners");
  });

  test("fillers are chosen by fewest wins first", () => {
    const decision = planNextGame(input({
      winsFor: (enemy: string) =>
        enemy === "Illuminati" ? 0 : enemy === "Netburners" ? 1 : 3,
    }));
    expect(decision.target).toBe("Illuminati");
    expect(decision.kind).toBe("filler");
    expect(decision.enemy).toBe("Netburners");
  });

  test("a target beyond the dodge budget defers to the next candidate this round", () => {
    const decision = planNextGame(input({ maxDodgePhases: 100 }));
    expect(decision.target).not.toBe("Illuminati");
  });

  test("unroutable enemies are skipped", () => {
    const decision = planNextGame(input({
      routeFor: (enemy: string) => enemy === "Illuminati" ? undefined : ROUTES[enemy],
    }));
    expect(decision.target).not.toBe("Illuminati");
  });
});

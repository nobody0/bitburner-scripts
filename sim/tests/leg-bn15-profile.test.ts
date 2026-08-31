import { afterAll, beforeAll, expect, test } from "bun:test";
import { setGoNeuralRuntimeForTest } from "../../game/lib/features/remaining.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";
import { TestGoNeuralRuntime } from "../../tests/support/go-neural-runtime.ts";
import { runGame } from "../game-run.ts";
import { findProfile } from "../profiles.ts";
import { lane } from "../../tests/support/lanes.ts";

/** Validity smoke for `leg-bn15.1`, the route's first labyrinth leg: the full
 * controller surface entering BN15 chained — holding SF1.3 + SF4.3 on the
 * 32 GB home `Prestige.ts` grants that entrance. `bun run long bn15` /
 * `bun run long dnet` / `bun run long progression`.
 *
 * ONE runGame, one case: the simulator's contract is one run per process
 * (spec/simulator.md — module state in the vendored core and the game's own
 * driver memory), and a second in-process run measurably diverges.
 *
 * The complete leg (24h horizon, `bun run bench:sim:leg-bn15.1`) is a
 * benchmark, not a test; this case only proves the scenario is SIMULATABLE —
 * no unmodeled calls, no script crashes — so a day-long run cannot die on a
 * fidelity gap an hour in. BN15 is the widest darknet surface any leg
 * schedules, so this is also where a fresh dnet fidelity gap surfaces first.
 *
 * BN15 bring-up realities this smoke deliberately does NOT assert, and the
 * full leg must watch for:
 *  - Daedalus never offers the pill here: the route is the labyrinth —
 *    five charisma-gated lab walks (300/600/1500/2500/3000), each reward
 *    installed, each install resetting charisma to 1.
 *  - The walks themselves are cheap (~34 min measured, LAB_WALK_ATTEMPTS);
 *    the charisma climbs between rungs are the leg's real cost.
 *  - The lab-cache deferral window (150 s from blocker-raise) must be honored
 *    or the install destroys the walked maze with the reward unclaimed.
 *  - Post-pill, `HackingLevelMultiplier` 0.6 slows the regrow to the node's
 *    doubled `w0r1d_d43m0n` gate — the tail that dominates the leg's ETA.
 *  - Darknet telemetry publishes only while a live resident stands on the
 *    net, so early passes legitimately publish nothing. */

lane({ feature: ["progression", "dnet"], bn: 15 }).describe("BN15 first-leg validity smoke", () => {
  beforeAll(() => {
    setGoNeuralRuntimeForTest(new TestGoNeuralRuntime((weights) => new StubGoValueBackend(weights)));
  });

  afterAll(() => {
    setGoNeuralRuntimeForTest();
  });

  test("the full BN15 surface runs fidelity-clean from the chained entrance", async () => {
    const profile = findProfile("leg-bn15.1");
    const result = await runGame({
      goal: parseGoals([...profile.goals]),
      seed: 1,
      horizonMs: 15 * 60_000,
      bitnode: profile.bitnode,
      homeRam: profile.homeRam,
      startingMoney: profile.startingMoney,
      features: profile.features,
      ...profile.world,
    });

    expect(result.unmodeled).toEqual({});
    expect(result.crashes).toEqual([]);
    expect(result.validity).toBe("valid");
    // Fifteen minutes cannot clear five charisma gates; asserting it keeps
    // the case honest about being a smoke rather than a benchmark.
    expect(result.reached).toBe(false);
    expect(result.stock.wealth).toBe(result.stock.cash + result.stock.liquidationValue);
  }, 600_000);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { setGoNeuralRuntimeForTest } from "../../game/lib/features/remaining.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";
import { TestGoNeuralRuntime } from "../../tests/support/go-neural-runtime.ts";
import { runGame } from "../game-run.ts";
import { findProfile } from "../profiles.ts";
import { lane } from "../../tests/support/lanes.ts";

/** Validity smoke for `leg-bn4.1`, the speedrun route's FIRST leg: the full
 * controller surface on a genuinely fresh BN4 world — 8 GB home, $1,000, no
 * Source-Files. `bun run long bn4` / `bun run long progression`.
 *
 * ONE runGame, one case: the simulator's contract is one run per process
 * (spec/simulator.md — module state in the vendored core and the game's own
 * driver memory), and a second in-process run measurably diverges.
 *
 * The complete leg (24h horizon, `bun run bench:sim:leg-bn4.1`) is a
 * benchmark, not a test; this case only proves the scenario is SIMULATABLE —
 * no unmodeled calls, no script crashes — so a day-long run cannot die on a
 * fidelity gap an hour in. It is also the gate on the dnet-triggered
 * zero-delay clock stall, which ate BN1 seeds outright
 * (sim/tests/baselines/bn1.json) and is now a diagnosable crash via the clock
 * tripwire: BN4's surface includes `dnet`, so if the stall is still live this
 * is where it surfaces.
 *
 * BN4 bring-up realities this smoke deliberately does NOT assert, and the full
 * leg must watch for:
 *  - `WorldDaemonDifficulty` 3 puts the daemon at hacking 9000, three times
 *    BN1's gate, while `HackExpGain` 0.4 slows every level toward it.
 *  - `ScriptHackMoney` 0.2 x `ServerMaxMoney` 0.1125 leaves hacking earning
 *    ~2% of BN1. Stocks and coding contracts are the only unnerfed channels,
 *    so the market and `side` decide the leg's bankroll.
 *  - `HacknetNodeMoney` 0.05 is the lowest non-zero in the game. The ordinary
 *    ROI gate refuses those nodes; Netburners' hacknet milestones bypass it.
 *  - Singularity is node-native and costs its BASE ram here, so a 5 GB
 *    SingularityFn3 call is indivisible on an 8 GB home and must dodge onto
 *    the fleet. */

lane({ feature: "progression", bn: 4 }).describe("BN4 first-leg validity smoke", () => {
  beforeAll(() => {
    setGoNeuralRuntimeForTest(new TestGoNeuralRuntime((weights) => new StubGoValueBackend(weights)));
  });

  afterAll(() => {
    setGoNeuralRuntimeForTest();
  });

  test("the full BN4 surface runs fidelity-clean from a cold fresh start", async () => {
    const profile = findProfile("leg-bn4.1");
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
    // Fifteen minutes cannot destroy a BitNode; asserting it explicitly keeps
    // the case honest about being a smoke rather than a benchmark.
    expect(result.reached).toBe(false);
    expect(result.stock.wealth).toBe(result.stock.cash + result.stock.liquidationValue);
  }, 600_000);
});

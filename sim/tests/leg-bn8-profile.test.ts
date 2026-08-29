import { afterAll, beforeAll, expect, test } from "bun:test";
import { setGoNeuralRuntimeForTest } from "../../game/lib/features/remaining.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";
import { TestGoNeuralRuntime } from "../../tests/support/go-neural-runtime.ts";
import { runGame } from "../game-run.ts";
import { findProfile } from "../profiles.ts";
import { lane } from "../../tests/support/lanes.ts";

/** Validity smoke for the `leg-bn8.1` route leg: the full controller surface
 * on a BN8 vanilla world, where every income multiplier except the market's
 * is zero. `bun run long bn8` / `bun run long progression`.
 *
 * ONE runGame, one case: the simulator's contract is one run per process
 * (spec/simulator.md — module state in the vendored core and the game's own
 * driver memory), and a second in-process run measurably diverges. All the
 * smoke's claims are therefore asserted against a single run.
 *
 * The complete leg (24h horizon, `bun run sim/run.ts --profile leg-bn8.1
 * --compact --perf`) is a benchmark, not a test; this case only proves the
 * scenario is SIMULATABLE — no unmodeled calls, no script crashes, the
 * node-granted WSE+TIX visible from the first account probe, and the market
 * actually trading — so a day-long run cannot die on a fidelity gap an
 * eighth of the way in.
 *
 * BN8 bring-up realities this smoke deliberately does NOT assert, and the
 * full leg must watch for:
 *  - Daedalus wants a $100b bankroll as CASH while the strategy keeps capital
 *    deployed — the liquidation coordination with `factions` decides the leg.
 *  - hacknet/career/crime pay zero; the arbiter must starve them.
 *  - hacking EXP is unmultiplied, so the w0r1d_d43m0n skill gate is reachable;
 *    only the money is zeroed. */

lane({ feature: "progression", bn: 8 }).describe("BN8 full-route validity smoke", () => {
  beforeAll(() => {
    setGoNeuralRuntimeForTest(new TestGoNeuralRuntime((weights) => new StubGoValueBackend(weights)));
  });

  afterAll(() => {
    setGoNeuralRuntimeForTest();
  });

  test("the full BN8 surface runs fidelity-clean, with node-granted market access and live trading", async () => {
    const profile = findProfile("leg-bn8.1");
    let firstAccount: { hasWseAccount?: boolean; hasTixApiAccess?: boolean } | undefined;
    const result = await runGame({
      goal: parseGoals([...profile.goals]),
      seed: 1,
      horizonMs: 15 * 60_000,
      bitnode: profile.bitnode,
      homeRam: profile.homeRam,
      startingMoney: profile.startingMoney,
      features: profile.features,
      ...profile.world,
      recordFilter: (record) => record.kind === "state" && record.key === "stock",
      onRecord: (line) => {
        if (firstAccount) return;
        const record = JSON.parse(line) as {
          key?: string;
          data?: { hasWseAccount?: boolean; hasTixApiAccess?: boolean };
        };
        if (record.key === "stock" && record.data?.hasWseAccount !== undefined) {
          firstAccount = record.data;
        }
      },
    });

    expect(result.unmodeled).toEqual({});
    expect(result.crashes).toEqual([]);
    expect(result.validity).toBe("valid");
    expect(result.reached).toBe(false);
    expect(result.stock.wealth).toBe(result.stock.cash + result.stock.liquidationValue);

    // BN8 grants WSE + TIX at node entry (Prestige.ts): the very first account
    // probe must already read both, with nothing bought.
    expect(firstAccount).toBeDefined();
    expect(firstAccount!.hasWseAccount).toBe(true);
    expect(firstAccount!.hasTixApiAccess).toBe(true);

    // The retired probe-blind finding's inverse: the node's only income source
    // is live inside fifteen minutes from a cold 8 GB home — the market SEES
    // prices and trades, where it once had no plan until t=212 s.
    expect(result.stock.tradesMade).toBeGreaterThan(0);

    // The retired cold-start ALLOCATION finding's inverse. The route's
    // unmeasured money rate is now a node-aware prior — hacked money scaled by
    // the node's own `ScriptHackMoney x ScriptHackMoneyGain` (zero in BN8)
    // plus the accessible market's closed-form blind rate on the bankroll —
    // so the money marginal is large from the first pass and the auction can
    // defend the grant before any income is measured.
    expect(result.stock.wealth).toBeGreaterThan(100e6);
    console.info(
      "[leg-bn8.1] smoke wealth=" + result.stock.wealth.toExponential(3)
      + " trades=" + String(result.stock.tradesMade),
    );
  }, 600_000);
});

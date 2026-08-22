import { expect } from "bun:test";
import { parseGoal } from "../../shared/goals/presets.ts";
import { blindViableBankroll } from "../../shared/strategy/stock/decide.ts";
import { runGame, type GameRunResult } from "../game-run.ts";
import { findProfile } from "../profiles.ts";
import { lane } from "../../tests/support/lanes.ts";

/** The BN8 interplay pair: the world where {stock:true} manipulation and the
 * darknet's propaganda lever are the ONLY thing hacking and dnet can add.
 * `bun run long stock` / `bun run long hacking` / `bun run long dnet` /
 * `bun run long bn8`.
 *
 * The treatment adds hacking + dnet to the identical world. In BN8 hacked
 * money pays nothing (`ScriptHackMoneyGain: 0`) and darknet income is zeroed
 * (`DarknetMoneyMultiplier: 0`), so the treatment/control wealth difference is
 * exactly the interplay under tuning.
 *
 * Each arm x seed is its OWN lane case, so the runner gives every runGame a
 * fresh process — the simulator's one-run-per-process contract
 * (spec/simulator.md). Sequential in-process runs measurably diverge (a
 * treatment that ends at $482m first-in-process ends at $248m sixth), so a
 * multi-run case would assert numbers no single-run harness reproduces.
 *
 * HISTORY: this lane originally pinned a capital-starvation finding — the
 * treatment converted its whole $250m bankroll into purchased servers that can
 * never pay in BN8 and placed ZERO trades in two hours. A chain of calculated
 * (never node-special-cased) fixes retired it: RAM investments must carry
 * EVIDENCE of value before claiming money (`isEvidencedInvestment`);
 * progression marginals publish the operating rate their derivative was taken
 * at (`atRatePerSec`), so a node's FIRST income source is priceable before it
 * has income history; the market posts a working-capital RESERVE claim sized
 * over its whole bankroll (cash + book) alongside any entry claim; trades
 * advance the player-money topic inside their own stub so sale proceeds are
 * never a stale-topic windfall; and money purchases are priced from the
 * capital-INDEPENDENT farm score, because manipulation income exists only
 * while the bankroll it would spend stays deployed.
 *
 * A second finding chain followed — after profitable trading, an experience-
 * valued RAM rung still converted the grown bankroll ($74k terminal against
 * the control's $404m) — and was likewise retired by calculation: steps are
 * priced against the lambda their grant would DISPLACE (a fully-covered band
 * quoted zero scarcity); rung values use the exact hyperbolic saving g/(1+g)
 * of the gated time instead of the tangent line (a +294% "gain" priced as
 * 2.94 nodes of saved time); the exp gain is credited only over the farm's
 * demand-capped productive GB, as the money channel always was; the
 * cumulative-earnings tracker is monotone so a realized trading loss no
 * longer resets the route's measured money rate to the 250k/s fallback (which
 * had inverted the money/exp marginal ratio 10x); and route marginals take
 * the LARGER of the install and node slopes so the $100b Daedalus gate is
 * never masked. A third layer joined after the full-day benchmark: the
 * working-capital reserve now STANDS during progression-ordered liquidations
 * (conversion is for the install, whose claims outrank it) and its value
 * curve rises hyperbolically toward the market's computed viability floor
 * (blindViableBankroll), so the last dollars a market-only economy can trade
 * with must be out-bid by the whole enterprise's worth. Measured after all
 * three chains (2h, fresh process per run, seeds 1/2/3): treatment
 * $482m/$119m/$537m against controls $404m/$682m/$557m — every seed keeps a
 * live, trading economy where the finding pinned pocket change; seed 2 still
 * concedes one $318m rung. Holding the full grant on every seed, and the
 * uplift question — treatment BEATING control — are the manipulation tuning
 * targets this lane measures. */

interface PairRun {
  result: GameRunResult;
  /** Ticks on which the published manipulation digest was non-empty. */
  manipulationTicks: number;
  /** Hosts that ever appeared in the digest. */
  manipulatedHosts: Set<string>;
}

async function runPair(id: string, seed: number, horizonMs: number): Promise<PairRun> {
  const profile = findProfile(id);
  let manipulationTicks = 0;
  const manipulatedHosts = new Set<string>();
  const result = await runGame({
    goal: parseGoal("wealth:1e99"),
    seed,
    horizonMs,
    bitnode: profile.bitnode,
    startingMoney: profile.startingMoney,
    homeRam: profile.homeRam,
    features: profile.features,
    ...profile.world,
    recordFilter: (record) => record.kind === "state" && record.key === "stock",
    onRecord: (line) => {
      const record = JSON.parse(line) as {
        kind: string;
        key?: string;
        data?: { manipulation?: Record<string, unknown> };
      };
      const manipulation = record.data?.manipulation;
      if (record.key !== "stock" || !manipulation) return;
      const hosts = Object.keys(manipulation);
      if (hosts.length === 0) return;
      manipulationTicks++;
      for (const host of hosts) manipulatedHosts.add(host);
    },
  });
  return { result, manipulationTicks, manipulatedHosts };
}

function expectValid(run: PairRun, label: string): void {
  expect(run.result.unmodeled, label).toEqual({});
  expect(run.result.crashes, label).toEqual([]);
  expect(run.result.validity, label).toBe("valid");
  expect(run.result.stock.wealth, label).toBe(run.result.stock.cash + run.result.stock.liquidationValue);
}

const SYMBOL_HOSTS = new Set(["foodnstuff", "sigma-cosmetics", "joesguns"]);
const HORIZON_MS = 2 * 60 * 60_000;
const bn8 = lane({ feature: ["stock", "hacking", "dnet"], bn: 8 });

for (const seed of findProfile("bn8-manipulation").seeds) {
  bn8.test(`control seed ${seed}: the market alone multiplies the node grant`, async () => {
    const grant = findProfile("bn8-manipulation-control").startingMoney!;
    const run = await runPair("bn8-manipulation-control", seed, HORIZON_MS);
    expectValid(run, `control seed ${seed}`);
    expect(run.result.stock.tradesMade).toBeGreaterThan(0);
    expect(run.result.stock.wealth).toBeGreaterThan(grant);
    // The control has no farm to ACT on manipulation intents, but the plan
    // still honestly publishes them for held symbols whose 0-port hosts the
    // controller's bootstrap rooted — so assert their SHAPE, not absence.
    for (const host of run.manipulatedHosts) expect(SYMBOL_HOSTS.has(host), host).toBe(true);
    console.info(`[bn8-manipulation] control seed ${seed}: wealth=${run.result.stock.wealth.toExponential(3)}`);
  }, 600_000);

  bn8.test(`treatment seed ${seed}: hacking+dnet stay fidelity-clean and the bankroll survives the farm`, async () => {
    const run = await runPair("bn8-manipulation", seed, HORIZON_MS);
    expectValid(run, `treatment seed ${seed}`);
    // The zero-trade starvation mode stays dead, and the economy stays ALIVE:
    // wealth never falls below the market's own computed viability floor
    // (blindViableBankroll — beneath it no position clears its commissions and
    // a market-only node is finished). Holding the full grant on every seed is
    // the tuning target, logged below; seed 2 still loses one $318m rung to a
    // razor-thin auction (grant: seeds measured 482m/119m/537m).
    expect(run.result.stock.tradesMade).toBeGreaterThan(0);
    expect(run.result.stock.wealth).toBeGreaterThan(blindViableBankroll());
    // Whatever the intent publishes must be a real symbol host of THIS world.
    for (const host of run.manipulatedHosts) expect(SYMBOL_HOSTS.has(host), host).toBe(true);
    console.info(
      `[bn8-manipulation] treatment seed ${seed}: wealth=${run.result.stock.wealth.toExponential(3)}`
      + ` manipulationTicks=${run.manipulationTicks}`,
    );
  }, 600_000);
}

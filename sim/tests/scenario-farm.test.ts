import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";

/** FOCUSED SCENARIOS — the farm/prep split.
 *
 * Prep is an INVESTMENT: it spends RAM now so a better target can earn later.
 * The farm is the thing currently paying for that investment. So prep must be
 * sized against what the farm gives up, not simply handed whatever is spare.
 *
 * Measured on bn1-speedrun seed 1, this is worth ~20% of the whole run. The
 * reference and the regressed run are IDENTICAL for 15 virtual minutes
 * ($1.9m earned, ~117 GB fleet each), then income diverges hard:
 *
 *     minute   30      45      60      90
 *     ref      $5.31m  $9.65m  $15.4m  $27.0m
 *     current  $3.49m  $3.67m  $4.46m  $6.26m
 *
 * The cause is visible in the RAM split — secondary prep takes the entire
 * fleet and the farm segment goes to ZERO GB:
 *
 *     min 25   farm 42.0 GB   prep 0 GB
 *     min 30   farm  0.0 GB   prep 78.75 GB   (prep target: harakiri-sushi)
 *     min 35   farm  0.0 GB   prep 119 GB
 *     min 45   farm 20.6 GB   prep 26.25 GB
 *
 * `allocateSegments` gives prep absolute priority (`farm = fleet - prep -
 * share`), and the guard reserves only ONE executable farm batch
 * (`secondaryPrepGbLimit = fleetGb - farmModel.ramPerBatch`). When the farm
 * target is small — n00dles early in BN1 — one batch is a few GB, so prep can
 * legitimately claim almost everything and stop all income. */

/** Already prepped and genuinely profitable: this is the earner whose income
 *  must not be switched off. `moneyMax` is derived by the simulator as 25x the
 *  spec's `moneyAvailable`, so "at max" means `currentMoney = 25x`. */
const EARNER = {
  hostname: "earner",
  organizationName: "scenario",
  hackDifficulty: 1,
  moneyAvailable: 2e6,
  moneyMax: 2e6,
  requiredHackingSkill: 1,
  serverGrowth: 3000,
  numOpenPortsRequired: 0,
  maxRam: 0,
  currentDifficulty: 1,
  currentMoney: 5e7,
} as const;

/** Fat, unprepped, and therefore an attractive prep candidate: high security
 *  and far below max money, so its prep wave is large. */
const PREP_CANDIDATE = {
  hostname: "prep-candidate",
  organizationName: "scenario",
  hackDifficulty: 20,
  moneyAvailable: 5e8,
  moneyMax: 5e8,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
} as const;

scenarioDescribe("scenario: prep must not switch off the farm", () => {
  test("a profitable farm keeps earning while a second target preps", async () => {
    const earnedAt = new Map<number, number>();
    const farmGbAt = new Map<number, number>();

    await runGame({
      goal: parseGoals(["earn:1e30"]),
      seed: 1,
      horizonMs: 45 * 60_000,
      bitnode: 1,
      homeRam: 128,
      startingMoney: 1e6,
      features: only("hacking", "progression"),
      network: [EARNER as never, PREP_CANDIDATE as never],
      topology: {
        home: ["earner", "prep-candidate"],
        earner: ["home"],
        "prep-candidate": ["home"],
      },
      telemetry: true,
      onRecord: (line: string) => {
        let record: { kind?: string; key?: string; t?: number; data?: Record<string, unknown> };
        try {
          record = JSON.parse(line) as typeof record;
        } catch {
          return;
        }
        if (record.kind !== "state" || record.key !== "farm") return;
        const minute = Math.floor((record.t ?? 0) / 60_000);
        const data = record.data as {
          totals?: { moneyEarned?: number };
          ramPie?: { farm?: number };
        } | undefined;
        const earned = data?.totals?.moneyEarned;
        if (typeof earned === "number") {
          earnedAt.set(minute, Math.max(earnedAt.get(minute) ?? 0, earned));
        }
        const farmGb = data?.ramPie?.farm;
        if (typeof farmGb === "number") {
          farmGbAt.set(minute, Math.max(farmGbAt.get(minute) ?? 0, farmGb));
        }
      },
    });

    const earnedBy = (minute: number): number => {
      for (let m = minute; m >= 0; m--) {
        const value = earnedAt.get(m);
        if (value !== undefined) return value;
      }
      return 0;
    };
    // The farm must be earning before we can say anything about it stalling.
    expect(earnedBy(20)).toBeGreaterThan(0);

    // THE ASSERTION: income must keep accruing while prep runs. A flat stretch
    // means the earner was switched off to fund the investment, which is never
    // right — prep is supposed to be paid for out of surplus, not out of the
    // income stream that funds everything.
    const gained = earnedBy(40) - earnedBy(25);
    expect(gained).toBeGreaterThan(0);

    // And the farm must never be reduced to literally nothing. Reserving a
    // single executable batch is not enough when the farm target is small:
    // one n00dles batch is a few GB, so "everything above one batch" is
    // effectively the whole fleet.
    const starved = [...farmGbAt.entries()].filter(([minute, gb]) => minute >= 20 && gb === 0);
    expect(starved.length).toBe(0);
  }, 600_000);
});

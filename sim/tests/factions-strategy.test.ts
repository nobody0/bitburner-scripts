import { describe, expect, test } from "bun:test";
import { parseGoals } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";
import { FACTION_DONATION_TARGET, findProfile } from "../profiles.ts";
import { DEFAULT_EPOCH_MS } from "../realm/timers.ts";
import { AUGMENTATION_TABLE } from "../vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";

describe("faction and hacking strategy simulation", () => {
  test("the armed reset prestiges the world and restarts the real controller", async () => {
    const profile = findProfile("factions-install");
    let armed = false;
    let installed = 0;
    let prestiged = 0;
    let resetDetected = 0;
    let prestigeAt: number | undefined;
    const resetSamples: { t: number; lastAugReset: number }[] = [];
    const installGoal = parseGoals([...profile.goals]);
    let satisfiedAt: number | undefined;

    const result = await runGame({
      goal: {
        ...installGoal,
        id: `${installGoal.id}+callback`,
        // What this test is really watching is the RESTART, which cannot be
        // observed until after the install. Measure the grace period from the
        // install rather than from an absolute clock time: the last-chance drain
        // buys NeuroFlux levels until the cash runs out, so the install lands
        // whenever it lands and a fixed deadline would either cut the restart off
        // or pad every run.
        done: (ctx) => {
          if (!installGoal.done(ctx)) return false;
          satisfiedAt ??= ctx.time;
          return ctx.time >= satisfiedAt + 5_000;
        },
      },
      seed: 1,
      horizonMs: 10 * 60_000,
      bitnode: profile.bitnode,
      homeRam: profile.homeRam,
      startingMoney: profile.startingMoney,
      features: profile.features,
      ...profile.world,
      onRecord: (line) => {
        const record = JSON.parse(line) as {
          kind: string;
          key?: string;
          name?: string;
          t: number;
          data?: { lastAugReset?: number; plan?: { install?: boolean; installArmedAt?: number } };
        };
        if (record.key === "progression" && record.data?.plan?.installArmedAt !== undefined) armed = true;
        if (record.name === "aug.installed") installed++;
        if (record.name === "sim.prestige") {
          prestiged++;
          prestigeAt = record.t;
        }
        if (record.name === "augmentation.reset") resetDetected++;
        if (record.key === "progression" && typeof record.data?.lastAugReset === "number") {
          resetSamples.push({ t: record.t, lastAugReset: record.data.lastAugReset });
        }
      },
    });

    expect(result.reached).toBe(true);
    expect(result.crashes).toEqual([]);
    expect(armed).toBe(true);
    expect(installed).toBe(1);
    expect(prestiged).toBe(1);
    expect(resetDetected).toBe(1);
    expect(resetSamples[0]?.lastAugReset).toBe(DEFAULT_EPOCH_MS);
    expect(prestigeAt).toBeDefined();
    expect(resetSamples.some((sample) => sample.lastAugReset === DEFAULT_EPOCH_MS + prestigeAt!)).toBe(true);
    expect(result.output.filter((line) => line.includes("main.js online"))).toHaveLength(2);
    expect(Object.keys(result.unmodeled)).not.toContain("ns getMoneySources");
  }, 10_000);

  // `install-cadence` remains the full synthetic two-reset pressure profile,
  // invoked by `bun run bench:sim:install-cadence`. The test above pins the
  // same controller restart/prestige contract with a bounded one-reset world.

  test("hacking funds an exact donation breakpoint without purchasing before the install boundary", async () => {
    const profile = findProfile("factions-donation");
    if (!profile.bitnode || !profile.homeRam || !profile.startingMoney || !profile.features) {
      throw new Error("factions-donation profile is missing its required world setup");
    }
    const startingMoney = profile.startingMoney;
    const entropy = profile.world?.playerState?.entropy ?? 0;
    const factionRepMult = (profile.world?.playerState?.augmentations ?? []).reduce((mult, owned) => {
      const aug = AUGMENTATION_TABLE[owned.name];
      const rolled = profile.world?.augmentationStats?.[owned.name];
      return mult * (rolled?.faction_rep ?? aug?.mults.faction_rep ?? 1);
    }, Math.pow(CONSTANTS.EntropyEffect, entropy));
    let donated = 0;
    let donationReputation = 0;
    let donationCount = 0;
    let hackingIncome = 0;
    let purchased = false;
    let purchaseResult = false;
    let maxRecordTime = 0;

    const result = await runGame({
      goal: parseGoals([...profile.goals]),
      seed: 1,
      horizonMs: 30 * 60_000,
      bitnode: profile.bitnode,
      homeRam: profile.homeRam,
      startingMoney,
      features: profile.features,
      ...profile.world,
      onRecord: (line) => {
        const record = JSON.parse(line) as {
          kind: string;
          t?: number;
          key?: string;
          name?: string;
          data?: {
            action?: string;
            amount?: number;
            reputation?: number;
            augmentation?: string;
            ok?: boolean;
            totals?: { moneyEarned?: number };
          };
        };
        maxRecordTime = Math.max(maxRecordTime, record.t ?? 0);
        if (record.name === "faction.donated") {
          donated += record.data?.amount ?? 0;
          donationReputation += record.data?.reputation ?? 0;
          donationCount++;
        }
        if (record.name === "aug.purchased" && record.data?.augmentation === FACTION_DONATION_TARGET) purchased = true;
        if (record.name === "faction.result" && record.data?.action === "purchaseAugmentation") {
          purchaseResult ||= record.data.ok === true;
        }
        if (record.key === "farm") hackingIncome = Math.max(hackingIncome, record.data?.totals?.moneyEarned ?? 0);
      },
    });

    expect(result.reached).toBe(true);
    expect(result.crashes).toEqual([]);
    // Unlocking reputation is planning progress, not a purchase boundary.
    // Paying now would activate nothing and prematurely consume a 1.9x queue
    // slot; the eventual install sweep chooses the full set and payment order.
    expect(purchased).toBe(false);
    expect(purchaseResult).toBe(false);
    expect(donationCount).toBe(1);
    // BN4 applies FactionWorkRepGain 0.75 to donations. The absolute amount is
    // deliberately not pinned: reputation keeps accruing while the arbiter
    // funds the action, and successful work-slot/RAM bootstrapping makes that
    // remaining gap smaller. Pin the conversion invariant instead.
    expect(donationReputation).toBeGreaterThan(0);
    expect(donated).toBeCloseTo(donationReputation * 1e6 / factionRepMult / 0.75, 5);
    expect(hackingIncome).toBeGreaterThan(donated - startingMoney);
    expect(maxRecordTime).toBeGreaterThan(0);
    expect(Object.keys(result.unmodeled)).not.toContain("ns getTotalScriptIncome");
  }, 10_000);
});

import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";

/** FOCUSED SCENARIOS — one assumption per test.
 *
 * The full BN1 profiles are end-to-end: 300k records where income, skill,
 * factions, installs and RAM all move at once, so a defect anywhere shows up
 * as "slower" and every diagnosis has to fight through the confounds. These
 * scenarios do the opposite. Each one pins ONE assumption about the game or
 * the arbiter, with everything else held still, and runs in seconds.
 *
 * This file covers the money -> RAM conversion path, which is where the
 * infrastructure supply curve, the arbiter's claim shapes and the purchase
 * execution meet. Four separate defects have hidden in that seam:
 *   - `capInfrastructureByObservedFleet` priced capacity by income that only
 *     exists after buying the capacity (bootstrap deadlock)
 *   - a continuous claim accepted partial grants toward an indivisible rung
 *   - the supply curve picked the cheapest-$/GB rung regardless of whether it
 *     was affordable (a second bootstrap deadlock)
 *   - with cost linear below the softcap knee, every size ties on $/GB, so the
 *     tiebreak spent all 25 irreplaceable server slots on 2 GB servers
 * Every one of them is visible here in seconds. */

/** One fat target so hacking has something worth scaling into, and nothing
 * else to spend attention on. Deliberately zero-port so no cracker is needed. */
const TARGET = {
  hostname: "scenario-target",
  organizationName: "scenario",
  hackDifficulty: 10,
  moneyAvailable: 1e12,
  moneyMax: 1e12,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
} as const;

async function fleetRun(startingMoney: number, horizonMin: number, withProgression = true) {
  let peakFleetGb = 0;
  const bought: number[] = [];
  const upgraded: number[] = [];
  let purchasedCount = 0;
  const failures = new Map<string, number>();

  const result = await runGame({
    // Unreachable on purpose: we want the whole horizon, not a race.
    goal: parseGoals(["earn:1e30"]),
    seed: 1,
    horizonMs: horizonMin * 60_000,
    bitnode: 1,
    homeRam: 32,
    startingMoney,
    features: withProgression ? only("hacking", "progression") : only("hacking"),
    network: [TARGET],
    topology: { home: [TARGET.hostname], [TARGET.hostname]: ["home"] },
    telemetry: true,
    onRecord: (line: string) => {
      let record: {
        kind?: string;
        key?: string;
        name?: string;
        data?: Record<string, unknown>;
      };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        return;
      }
      if (record.kind === "event") {
        const data = (record.data ?? {}) as { ram?: number; reason?: string; action?: { type?: string } };
        if (record.name === "buyServer" && typeof data.ram === "number") bought.push(data.ram);
        if (record.name === "upgradeServer" && typeof data.ram === "number") upgraded.push(data.ram);
        if (record.name === "action.failed" && data.reason) {
          const key = `${data.action?.type ?? "?"}:${data.reason}`;
          failures.set(key, (failures.get(key) ?? 0) + 1);
        }
      }
      if (record.kind === "state" && record.key === "fleet") {
        const data = record.data as { maxRam?: number; purchased?: { count?: number } } | undefined;
        if (typeof data?.maxRam === "number") peakFleetGb = Math.max(peakFleetGb, data.maxRam);
        if (typeof data?.purchased?.count === "number") purchasedCount = Math.max(purchasedCount, data.purchased.count);
      }
    },
  });

  return { result, peakFleetGb, bought, upgraded, purchasedCount, failures };
}

/** A target that is ALREADY prepped: at min security and at max money.
 *
 * `moneyMax` is derived by the simulator as 25x the spec's `moneyAvailable`
 * (see sim/core/effects.ts), so "at max" is `currentMoney = 25 * moneyAvailable`
 * — using the spec's own `moneyMax` leaves the server at 4% and the farm grows
 * for the entire horizon without ever hacking. */
const PREPPED_TARGET = {
  hostname: "prepped-target",
  organizationName: "scenario",
  hackDifficulty: 3,
  moneyAvailable: 1e9,
  moneyMax: 1e9,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
  currentDifficulty: 1,
  currentMoney: 2.5e10,
} as const;

async function scenarioRun(
  target: Record<string, unknown>,
  startingMoney: number,
  horizonMin: number,
) {
  let peakFleetGb = 0;
  let hacks = 0;
  let firstSecurity: number | undefined;
  let lastSecurity: number | undefined;

  const result = await runGame({
    goal: parseGoals(["earn:1e30"]),
    seed: 1,
    horizonMs: horizonMin * 60_000,
    bitnode: 1,
    homeRam: 32,
    startingMoney,
    features: only("hacking", "progression"),
    network: [target as never],
    topology: { home: [target["hostname"] as string], [target["hostname"] as string]: ["home"] },
    telemetry: true,
    onRecord: (line: string) => {
      let record: { kind?: string; key?: string; data?: Record<string, unknown> };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        return;
      }
      if (record.kind !== "state") return;
      if (record.key === "fleet") {
        const max = (record.data as { maxRam?: number } | undefined)?.maxRam;
        if (typeof max === "number") peakFleetGb = Math.max(peakFleetGb, max);
      }
      if (record.key === "farm") {
        const data = record.data as { totals?: { hacks?: number }; security?: number } | undefined;
        if (typeof data?.totals?.hacks === "number") hacks = Math.max(hacks, data.totals.hacks);
        if (typeof data?.security === "number") {
          firstSecurity ??= data.security;
          lastSecurity = data.security;
        }
      }
    },
  });

  const securityDrop = firstSecurity !== undefined && lastSecurity !== undefined
    ? firstSecurity - lastSecurity
    : 0;
  return { result, peakFleetGb, hacks, securityDrop };
}

const preppedRun = (money: number, mins: number) => scenarioRun(PREPPED_TARGET, money, mins);
const freshRun = (money: number, mins: number) => scenarioRun(TARGET, money, mins);

scenarioDescribe("scenario: money becomes fleet RAM", () => {
  test("cash on hand is converted into fleet capacity", async () => {
    // $200m against a $55k/GB cloud price is ~3,600 GB of theoretical RAM. We
    // do not require optimality here — only that the money-to-RAM path works
    // at all. A run that ends near its 32 GB home has a broken conversion,
    // which is precisely the failure four separate defects produced.
    const run = await fleetRun(200e6, 20);
    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(run.peakFleetGb).toBeGreaterThan(500);
  }, 120_000);

  test("a spender falls back when BN-seconds valuation is unavailable", async () => {
    // Pins the spender/taker asymmetry: an unknown hacking marginal must keep
    // share (a taker) at zero, but it must not make infrastructure (a spender)
    // halt the economy. This hacking-only run has no progression topic, so a
    // purchase proves the explicit legacy-ROI fallback remained live.
    const run = await fleetRun(200e6, 20, false);
    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(run.peakFleetGb).toBeGreaterThan(32);
  }, 120_000);

  test("server slots are not spent on degenerate rungs", async () => {
    // Cloud cost is `ram * 55000 * softcap^max(0, log2(ram) - 6)`, so every
    // size at or below 64 GB has IDENTICAL $/GB. Nothing in a pure $/GB
    // comparison prefers a big server — but a purchased-server slot is capped
    // (25 by default) and cannot be reclaimed, so spending one on a 2 GB
    // server permanently forfeits capacity. Slot scarcity is the real rule
    // behind the old hardcoded `PSERV_RAM = 64`.
    const run = await fleetRun(200e6, 20);
    if (run.bought.length === 0) return; // covered by the conversion test above
    const median = [...run.bought].sort((a, b) => a - b)[Math.floor(run.bought.length / 2)]!;
    expect(median).toBeGreaterThanOrEqual(8);
  }, 120_000);

  test("purchases are attempted only when they can be paid for", async () => {
    // A grant is an authorisation, not cash. Attempting a rung the grant does
    // not cover burns a dodge and leaves a stale "purchase refused" that reads
    // like repeated failure. Any `insufficient money` here means the claim,
    // the grant and the execution disagree about the same number.
    const run = await fleetRun(200e6, 20);
    const insufficient = [...run.failures.entries()]
      .filter(([key]) => key.includes("insufficient money"))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(insufficient).toBe(0);
  }, 120_000);
});

scenarioDescribe("scenario: bootstrap from a cold start", () => {
  // THE DISCRIMINATING TEST. Every scenario above hands the run $200m and asks
  // only whether it can convert cash into RAM. A real BN1 starts with ~$1k and
  // has to BOOTSTRAP: earn a little, buy a little, earn more. That compounding
  // loop is where two deadlocks have already lived — `capInfrastructureByObservedFleet`
  // pricing capacity by income that only exists after the purchase, and the
  // supply curve selecting a cheapest-$/GB rung it could never afford.
  //
  // The target starts PREPPED (at min security, at max money) on purpose. Prep
  // is a separate concern with its own scenario below, and mixing them makes a
  // failure unattributable — which is exactly the confound the BN profiles have.
  //
  // Note the fixture arithmetic: the simulator derives `moneyMax` as 25x the
  // spec's `moneyAvailable`, so "already at max" means `currentMoney` = 25x,
  // not the spec's own `moneyMax`. Getting that wrong makes the farm grow
  // forever and looks exactly like a broken economy.
  test("a cold start compounds into a fleet", async () => {
    const run = await preppedRun(1_000, 30);
    expect(run.result.validity).not.toBe("invalid-for-goal");
    // Modest on purpose: this asks whether the loop turns over AT ALL, not
    // whether it is well tuned. Staying near the 32 GB home is the deadlock
    // signature.
    expect(run.peakFleetGb).toBeGreaterThan(64);
    expect(run.hacks).toBeGreaterThan(0);
  }, 120_000);
});

scenarioDescribe("scenario: prep reaches a hackable state", () => {
  // The other half, isolated. A fresh server starts above min security and
  // below max money, and NOTHING earns until it is prepped. Measured on the
  // unprepped fixture: 30 virtual minutes produced 11 weakens, 0 hacks and
  // $0 — security crawled 10 -> 4.5 against a floor of 3, with one weaken in
  // flight at a time and no allocation failures. The farm was working
  // correctly and simply could not finish, which is indistinguishable from a
  // broken economy unless prep is measured on its own.
  test("a fresh target is driven toward min security", async () => {
    const run = await freshRun(1_000, 30);
    expect(run.result.validity).not.toBe("invalid-for-goal");
    // Progress, not completion: prep speed depends on hacking skill, which is
    // itself bootstrapping. What must never happen is standing still.
    expect(run.securityDrop).toBeGreaterThan(0);
  }, 120_000);
});

scenarioDescribe("scenario: target selection respects time-to-prep", () => {
  // A target is worth nothing until it is prepped, so a high $/GB/sec score on
  // a server that needs 30+ minutes of weakening earns strictly less than a
  // poor score on one that is hackable now. Early game this is the whole
  // ballgame: n00dles is trivial to prep and bootstraps both cash and skill.
  //
  // Measured on this fixture: with an easy target (skill 1, security 1, huge
  // growth) and a fatter one (security 10) both available, the farm selected
  // the fatter one for 1801 of 1801 samples, landed 0 hacks, and earned $0 in
  // 30 virtual minutes. The easy target was never chosen.
  //
  // This is the isolated form of the BN1 symptom: with a prepped target the
  // same code earns $978b and builds a 472 TB fleet in the same 30 minutes,
  // so neither the farm nor the arbiter nor infrastructure is at fault —
  // selection is.
  test("an immediately hackable target is preferred over an unpreppable one", async () => {
    const easy = {
      hostname: "easy", organizationName: "scenario",
      hackDifficulty: 1, moneyAvailable: 70e3, moneyMax: 70e3,
      requiredHackingSkill: 1, serverGrowth: 3000, numOpenPortsRequired: 0, maxRam: 4,
    };
    const fat = {
      hostname: "fat", organizationName: "scenario",
      hackDifficulty: 10, moneyAvailable: 4e6, moneyMax: 4e6,
      requiredHackingSkill: 1, serverGrowth: 100, numOpenPortsRequired: 0, maxRam: 16,
    };
    let hacks = 0;
    await runGame({
      goal: parseGoals(["earn:1e30"]),
      seed: 1,
      horizonMs: 30 * 60_000,
      bitnode: 1,
      homeRam: 32,
      startingMoney: 1_000,
      features: only("hacking", "progression"),
      network: [easy as never, fat as never],
      topology: { home: ["easy", "fat"], easy: ["home"], fat: ["home"] },
      telemetry: true,
      onRecord: (line: string) => {
        try {
          const record = JSON.parse(line) as { kind?: string; key?: string; data?: { totals?: { hacks?: number } } };
          if (record.kind === "state" && record.key === "farm" && typeof record.data?.totals?.hacks === "number") {
            hacks = Math.max(hacks, record.data.totals.hacks);
          }
        } catch { /* not a record */ }
      },
    });
    // The bar is deliberately the floor: earn ANYTHING. Landing zero hacks in
    // half an hour with a trivially hackable server available means selection
    // ignored time-to-prep entirely.
    expect(hacks).toBeGreaterThan(0);
  }, 120_000);
});

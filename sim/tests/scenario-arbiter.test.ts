import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import type { ArbitrationDigest } from "../../shared/telemetry/topics/progression.ts";
import { runGame } from "../game-run.ts";
import { calculateExp } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";

/** One already-prepped target keeps these scenarios about arbitration rather
 * than prep latency. Every assertion reads telemetry emitted by the real
 * controller; none reaches into resolveClaims or simulator-owned state. */
const TARGET = {
  hostname: "arbiter-target",
  organizationName: "scenario",
  hackDifficulty: 3,
  currentDifficulty: 1,
  moneyAvailable: 1e12,
  currentMoney: 25e12,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
} as const;

interface ArbiterTrace {
  arbitrations: ArbitrationDigest[];
  purchases: string[];
  failures: string[];
}

async function arbiterRun(options: {
  startingMoney: number;
  horizonMs: number;
  hacknet?: boolean;
  homeRam?: number;
  hackingSkill?: number;
  targetMoney?: number;
}): Promise<ArbiterTrace> {
  const trace: ArbiterTrace = { arbitrations: [], purchases: [], failures: [] };
  await runGame({
    goal: parseGoals(["earn:1e30"]),
    seed: 1,
    horizonMs: options.horizonMs,
    bitnode: 1,
    homeRam: options.homeRam ?? 32,
    startingMoney: options.startingMoney,
    ...(options.hackingSkill ? {
      person: {
        skills: { hacking: options.hackingSkill },
        exp: { hacking: options.hackingSkill * options.hackingSkill * 100 },
      },
    } : {}),
    features: options.hacknet ? only("hacking", "hacknet", "progression") : only("hacking", "progression"),
    network: [{
      ...TARGET,
      ...(options.targetMoney !== undefined
        ? { moneyAvailable: options.targetMoney, currentMoney: options.targetMoney * 25 }
        : {}),
    }],
    topology: { home: [TARGET.hostname], [TARGET.hostname]: ["home"] },
    telemetry: true,
    onRecord: (line) => {
      let record: { kind?: string; key?: string; name?: string; data?: Record<string, unknown> };
      try { record = JSON.parse(line) as typeof record; } catch { return; }
      // `arbitration` is a topic of its own: it moves on nearly every tick and
      // was split out of `progression` so a state record does not republish the
      // whole plan behind it.
      if (record.kind === "state" && record.key === "arbitration" && record.data) {
        trace.arbitrations.push(record.data as unknown as ArbitrationDigest);
      }
      if (record.kind === "event") {
        if (record.name === "buyServer" || record.name === "upgradeServer") trace.purchases.push(record.name);
        if (record.name === "action.failed") {
          const data = record.data as { reason?: string } | undefined;
          if (data?.reason) trace.failures.push(data.reason);
        }
      }
    },
  });
  return trace;
}

function grants(trace: ArbiterTrace, by: string, id: string) {
  return trace.arbitrations.flatMap((entry) => entry.grants).filter((grant) => grant.by === by && grant.id === id);
}

scenarioDescribe("scenario: arbiter outcomes", () => {
  test("a lone affordable economic claim is granted", async () => {
    // Pins the integration defect that motivated this suite: a positive RAM
    // claim with ample cash and no competitor was denied as a zero-value outbid.
    const trace = await arbiterRun({ startingMoney: 200e6, horizonMs: 60_000 });
    expect(grants(trace, "hacking", "infrastructure:ram").some((grant) => grant.amount > 0)).toBe(true);
    expect(trace.purchases.length).toBeGreaterThan(0);
  }, 120_000);

  test("a step claim reserves income until its rung becomes affordable", async () => {
    // An indivisible infrastructure rung must accumulate cash across passes and
    // land once affordable; attempting it early recreates the stale-grant bug.
    const trace = await arbiterRun({
      startingMoney: 50_000,
      horizonMs: 20 * 60_000,
      homeRam: 256,
      hackingSkill: 500,
      targetMoney: 100_000,
    });
    expect(grants(trace, "hacking", "infrastructure:ram").some((grant) => grant.mode === "reserve" && grant.partial)).toBe(true);
    expect(trace.purchases.length).toBeGreaterThan(0);
    expect(trace.failures.some((reason) => reason.includes("insufficient money"))).toBe(false);
  }, 120_000);

  test("lambda reports both real priced participants", async () => {
    // A one-claim waterline is not a shadow price. With hacking infrastructure
    // and Hacknet both bidding in the investment band, telemetry must preserve
    // that the same lambda compared more than one priced participant.
    const trace = await arbiterRun({
      startingMoney: 5e6,
      horizonMs: 20 * 60_000,
      hacknet: true,
      hackingSkill: 100,
      targetMoney: 1e6,
    });
    const waterlines = trace.arbitrations.flatMap((entry) => entry.waterlines ?? []);
    expect(waterlines.some((entry) => entry.pricedClaimCount > 1)).toBe(true);
  }, 120_000);

  /** Career and factions both want `Player.currentWork`, with a farm earning
   * money in the background. This is the live BN12 failure in miniature: crime
   * paid $1.8e4/s against a farm at $3.25e8/s and held the slot for 5.8 hours
   * while the only source of faction reputation was denied `slot-held` on every
   * pass. Nothing about it was BitNode-specific — the slot was allocated by a
   * band that could not see the difference. */
  async function slotContentionRun(options: { joinedRep?: number }): Promise<{
    holders: string[];
    deniedFactions: number;
  }> {
    const holders: string[] = [];
    let deniedFactions = 0;
    await runGame({
      goal: parseGoals(["earn:1e30"]),
      seed: 1,
      horizonMs: 4 * 60_000,
      bitnode: 4,
      homeRam: 256,
      startingMoney: 5e6,
      features: only("hacking", "career", "factions", "progression"),
      network: [{ ...TARGET, maxRam: 512 }],
      topology: { home: [TARGET.hostname], [TARGET.hostname]: ["home"] },
      person: { skills: { hacking: 1_000 }, exp: { hacking: calculateExp(1_000) } },
      playerState: { factions: ["CyberSec"] },
      factions: { CyberSec: { rep: options.joinedRep ?? 0, favor: 0 } },
      telemetry: true,
      onRecord: (line) => {
        let record: { kind?: string; key?: string; data?: ArbitrationDigest };
        try { record = JSON.parse(line) as typeof record; } catch { return; }
        if (record.kind !== "state" || record.key !== "arbitration" || !record.data) return;
        if (record.data.slot) holders.push(record.data.slot.by);
        deniedFactions += record.data.denied
          .filter((entry) => entry.by === "factions" && entry.resource === "time").length;
      },
    });
    return { holders, deniedFactions };
  }

  /** The announcement has to be TRUE, not merely forward-looking. A prediction
   * nobody checks is just a different way to be wrong, and every work-slot
   * decision now rests on this one. Run a farm to steady state and compare what
   * it SAID its committed solution would produce against what it produced.
   *
   * The two channels are checked differently on purpose. Money is farm-only on
   * both sides, so it is a two-sided band. Experience is not: the prediction
   * covers the farm segment's batch, while the realized figure is every script
   * on the fleet — prep's grow and weaken threads earn experience and no money.
   * The farm quote is therefore a LOWER bound on fleet experience, which is
   * exactly why the announcement takes the larger of prediction and
   * measurement rather than replacing one with the other. */
  test("the farm's announced forward rate matches what it then produces", async () => {
    const samples: { predMoney: number; realMoney: number; predExp: number; realExp: number }[] = [];
    await runGame({
      goal: parseGoals(["earn:1e30"]),
      seed: 1,
      horizonMs: 5 * 60_000,
      bitnode: 1,
      homeRam: 256,
      startingMoney: 50e6,
      person: { skills: { hacking: 500 }, exp: { hacking: calculateExp(500) } },
      features: only("hacking", "progression"),
      network: [{ ...TARGET, maxRam: 512 }],
      topology: { home: [TARGET.hostname], [TARGET.hostname]: ["home"] },
      telemetry: true,
      onRecord: (line) => {
        let record: { kind?: string; key?: string; data?: Record<string, unknown> };
        try { record = JSON.parse(line) as typeof record; } catch { return; }
        if (record.kind !== "state" || record.key !== "farm" || !record.data) return;
        const farm = record.data as {
          predicted?: { moneyPerSec: number; expPerSec: number };
          moneyRate?: number;
          expRate?: number;
          landed?: { hack: number };
        };
        // Only once hacks are actually landing is there a realized rate to
        // compare against; before that the prediction is the ONLY answer, which
        // is the whole point of publishing it.
        if (!farm.predicted || !((farm.landed?.hack ?? 0) > 0)) return;
        samples.push({
          predMoney: farm.predicted.moneyPerSec,
          realMoney: farm.moneyRate ?? 0,
          predExp: farm.predicted.expPerSec,
          realExp: farm.expRate ?? 0,
        });
      },
    });

    // The EMA needs a while to catch up with a rate that started at zero, so
    // steady state is the tail.
    const settled = samples.slice(Math.floor(samples.length * 0.75));
    expect(settled.length).toBeGreaterThan(0);
    const mean = (of: (s: typeof settled[number]) => number) =>
      settled.reduce((sum, entry) => sum + of(entry), 0) / settled.length;

    const moneyRatio = mean((s) => s.realMoney / s.predMoney);
    // Loose on purpose: the claim under test is that the quote is the right
    // ORDER of magnitude and the right direction, which is all the auction
    // needs and all a solver quote can honestly promise.
    expect(moneyRatio, `realized/predicted money = ${moneyRatio}`).toBeGreaterThan(0.5);
    expect(moneyRatio, `realized/predicted money = ${moneyRatio}`).toBeLessThan(3);

    // Experience: a lower bound, never an over-claim. An over-claiming quote
    // would hand the slot to hacking on work it is not doing.
    const expRatio = mean((s) => s.realExp / Math.max(1e-9, s.predExp));
    expect(expRatio, `realized/predicted experience = ${expRatio}`).toBeGreaterThan(0.5);
  }, 240_000);

  test("reputation work takes the slot from crime once the farm out-earns it", async () => {
    const { holders } = await slotContentionRun({});
    expect(holders.length).toBeGreaterThan(0);
    // The whole point: factions gets the slot at all. Under the bands it never
    // did — career's crime touched a blocking money need and won every pass.
    expect(holders.some((by) => by === "factions")).toBe(true);
  }, 180_000);

  test("with no reputation left to earn, career keeps the slot", async () => {
    // The mirror image, and the reason this cannot be a rule about reputation
    // always winning: a faction with nothing left to work toward releases the
    // slot, and the next best rate takes it.
    const { holders, deniedFactions } = await slotContentionRun({ joinedRep: 1e12 });
    expect(deniedFactions).toBe(0);
    expect(holders.every((by) => by !== "factions")).toBe(true);
  }, 180_000);
});
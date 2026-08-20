import { beforeEach, describe, expect, test } from "bun:test";
import { resetHackingState, serverAccessPlan } from "../game/lib/features/hacking.ts";
import type { ClaimContext } from "../game/lib/features/index.ts";
import { postNeeds, type Need } from "../shared/strategy/needs.ts";

/** Server access is ranked by VALUE DENSITY, so what an action costs decides
 * what the feature does next. A port opener the career slot has to WRITE is
 * not free: BruteSSH is ten minutes of player work, and pricing it at one
 * second gave every opener candidate its raw valueSec as a score. The measured
 * symptom was an early run that spent its first ten to thirty minutes writing
 * openers with the whole backdoor pipeline frozen behind them. */

const CSEC = "CSEC";
const AVMNITE = "avmnite-02h";

function need(overrides: Partial<Need> & Pick<Need, "kind" | "subject" | "valueSec">): Need {
  return {
    by: "factions",
    target: 1,
    have: 0,
    weight: 8,
    urgency: "blocking",
    why: "test",
    ...overrides,
  } as Need;
}

function ctx(options: {
  needs: Need[];
  career?: boolean;
  /** Best money rate on the career board — the write's money opportunity cost. */
  careerMoneyPerSec?: number;
  /** What the top career option is serving, in career's own score units. */
  careerContributions?: { kind: string; perSec: number; weight: number; score: number }[];
  lambda?: number;
}): Pick<ClaimContext, "board" | "state" | "activeFeatures"> {
  return {
    board: postNeeds(options.needs),
    activeFeatures: new Set(options.career === false ? [] : ["career"]),
    state: {
      topics: {
        player: { skills: { hacking: 100, intelligence: 0 } },
        fleet: { portOpeners: 0 },
        servers: {
          // Rooted and skill-met: the backdoor is ready to install right now.
          [CSEC]: {
            hasAdminRights: true,
            backdoorInstalled: false,
            requiredHackingSkill: 50,
            numOpenPortsRequired: 0,
          },
          // Needs one port we do not have, so the opener is the blocker.
          [AVMNITE]: {
            hasAdminRights: false,
            backdoorInstalled: false,
            requiredHackingSkill: 50,
            numOpenPortsRequired: 1,
          },
        },
        career: {
          plan: {
            ranked: [{
              label: "crime: Mug",
              score: 0,
              moneyPerSec: options.careerMoneyPerSec ?? 100,
              contributions: options.careerContributions ?? [],
            }],
          },
        },
        ...(options.lambda !== undefined
          ? { arbitration: { waterlines: [{ resource: "money", priority: 100, lambda: options.lambda, claimCount: 1, pricedClaimCount: 1 }] } }
          : {}),
      },
    },
  } as never;
}

describe("server access plan", () => {
  // The evaluator context is module state: another suite leaving one behind
  // changes every backdoor's priced install time, and with it the ranking.
  beforeEach(() => resetHackingState());

  test("an opener the career slot must WRITE is priced at its create-program time", () => {
    // BruteSSH at hacking 100 is 500s of player work. The root need is worth
    // 4_000 BN-seconds (density 8/s at write cost); the backdoor is worth
    // 1_000 over the 300s nominal install (density 3.3/s). Priced at one
    // second the opener would score 4_000 and win outright.
    const plan = serverAccessPlan(ctx({
      needs: [
        need({ kind: "root", subject: AVMNITE, valueSec: 4_000 }),
        need({ kind: "backdoor", subject: CSEC, valueSec: 1_000 }),
      ],
    }));
    expect(plan?.primary.action).toBe("port-opener");
    expect(plan?.primary.host).toBe(AVMNITE);

    // Same board, a backdoor worth enough to beat the write's density.
    const denser = serverAccessPlan(ctx({
      needs: [
        need({ kind: "root", subject: AVMNITE, valueSec: 4_000 }),
        need({ kind: "backdoor", subject: CSEC, valueSec: 5_000 }),
      ],
    }));
    expect(denser?.primary.action).toBe("backdoor");
    expect(denser?.primary.host).toBe(CSEC);
    // Nothing to write: the opener lost the ranking outright this pass.
    expect(denser?.writeProgram).toBeUndefined();
  });

  test("a write does not freeze the backdoor pipeline behind it", () => {
    const plan = serverAccessPlan(ctx({
      needs: [
        need({ kind: "root", subject: AVMNITE, valueSec: 4_000 }),
        need({ kind: "backdoor", subject: CSEC, valueSec: 1_000 }),
      ],
    }));
    expect(plan?.writeProgram?.name).toBe("BruteSSH.exe");
    // The write spends player time, not RAM and not money, so the ready
    // backdoor must still be offered alongside it.
    expect(plan?.concurrentBackdoor?.host).toBe(CSEC);
    expect(plan?.concurrentBackdoor?.action).toBe("backdoor");
  });

  test("buying instead of writing keeps the opener effectively instant", () => {
    // A career slot earning $10k/s makes a 500s write cost $5m against a
    // $700k purchase, so the opener is bought — and a purchase is instant.
    const plan = serverAccessPlan(ctx({
      needs: [
        need({ kind: "root", subject: AVMNITE, valueSec: 4_000 }),
        need({ kind: "backdoor", subject: CSEC, valueSec: 5_000 }),
      ],
      careerMoneyPerSec: 10_000,
    }));
    expect(plan?.writeProgram).toBeUndefined();
    expect(plan?.primary.action).toBe("port-opener");
    expect(plan?.concurrentBackdoor).toBeUndefined();
  });

  test("the career slot's need progress — not just its income — can veto a write", () => {
    const board = [
      need({ kind: "root", subject: AVMNITE, valueSec: 4_000 }),
      need({ kind: "backdoor", subject: CSEC, valueSec: 1_000 }),
    ];
    // $0.01 of BN-value per dollar: the $700k purchase is worth 7_000
    // BN-seconds and the 500s write forgoes 500 * 100 * 0.01 = 500 of income.
    // On income alone the write is far cheaper.
    expect(serverAccessPlan(ctx({ needs: board, lambda: 0.01 }))?.writeProgram?.name).toBe("BruteSSH.exe");

    // Same board, but the slot is serving a weight-40 need at 1% per second:
    // the whole need completes inside the write window, so 40 * 300 = 12_000
    // BN-seconds are forgone. Invisible in dollars, decisive in BN-seconds.
    const busy = serverAccessPlan(ctx({
      needs: board,
      lambda: 0.01,
      careerContributions: [{ kind: "karma", perSec: 1, weight: 40, score: 0.4 }],
    }));
    expect(busy?.writeProgram).toBeUndefined();
    // And with the opener bought rather than written, it is instant again and
    // reclaims the top of the ranking.
    expect(busy?.primary.action).toBe("port-opener");
  });

  test("without career the opener is bought, never written", () => {
    const plan = serverAccessPlan(ctx({
      needs: [need({ kind: "root", subject: AVMNITE, valueSec: 4_000 })],
      career: false,
    }));
    expect(plan?.primary.action).toBe("port-opener");
    expect(plan?.writeProgram).toBeUndefined();
  });
});

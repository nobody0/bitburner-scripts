import { describe, expect, test } from "bun:test";
import {
  addRepToFavor,
  donationForRep,
  favorNeededToDonate,
  favorToRep,
  fieldWorkRepGain,
  hackingWorkRepGain,
  passiveRepPerSec,
  repFromDonation,
  repToFavor,
  securityWorkRepGain,
  workBeatsIdleSkill,
  workRepPerSec,
  type RepContext,
  type RepPerson,
} from "../../shared/strategy/factions/rep.ts";
import {
  donationForRep as vendoredDonationForRep,
  favorNeededToDonate as vendoredFavorNeeded,
  repFromDonation as vendoredRepFromDonation,
} from "../vendor/bitburner/src/Faction/formulas/Donation.ts";
import { addRepToFavor as vendoredAddRepToFavor, favorToRep as vendoredFavorToRep, repToFavor as vendoredRepToFavor } from "../vendor/bitburner/src/Faction/formulas/favor.ts";
import {
  getFactionFieldWorkRepGain,
  getFactionSecurityWorkRepGain,
  getHackingWorkRepGain,
  setReputationContext,
} from "../vendor/bitburner/src/PersonObjects/formulas/Reputation.ts";
import { currentNodeMults, replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { mockPerson } from "../core/mocks.ts";

/** Bit-identity against the vendored originals, with `toBe` rather than
 * `toBeCloseTo`.
 *
 * The strategy's copies live in `shared/` because `shared/` ships INTO THE
 * GAME and must not drag the vendored tree into the bundle. That duplication
 * is only safe if it is checked, and checked exactly: a transcription that is
 * merely close would make the planner optimise a slightly different game than
 * the one it is playing, and the divergence would show up as unexplainable
 * run-to-run variance rather than as a test failure. */

function person(overrides: Partial<RepPerson["skills"]> = {}, factionRep = 1): RepPerson & { skills: Record<string, number> } {
  const base = mockPerson();
  return {
    skills: {
      hacking: 250,
      strength: 120,
      defense: 130,
      dexterity: 140,
      agility: 150,
      charisma: 90,
      intelligence: 17,
      ...overrides,
    },
    mults: { ...base.mults, faction_rep: factionRep },
  } as RepPerson & { skills: Record<string, number> };
}

const CTX: RepContext = { factionWorkRepGain: 1, shareBonus: 1, sf15Level: 0, hasFocusAug: false };

/** The vendored module reads share bonus and SF15 from injected state. */
function syncVendorContext(ctx: RepContext): void {
  setReputationContext({ shareBonus: ctx.shareBonus, sf15Level: ctx.sf15Level });
}

describe("work reputation parity", () => {
  const cases: { label: string; ctx: RepContext; favor: number; p: ReturnType<typeof person> }[] = [
    { label: "fresh character, favor 0", ctx: CTX, favor: 0, p: person({ hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 }) },
    { label: "mid-game, favor 42", ctx: CTX, favor: 42, p: person() },
    { label: "faction_rep multiplier", ctx: CTX, favor: 10, p: person({}, 1.54) },
    { label: "sharing fleet", ctx: { ...CTX, shareBonus: 1.37 }, favor: 25, p: person() },
    { label: "SF15 level 3 (charisma counts)", ctx: { ...CTX, sf15Level: 3 }, favor: 25, p: person() },
    { label: "high intelligence", ctx: CTX, favor: 100, p: person({ intelligence: 450 }) },
  ];

  test("hacking work matches across representative contexts", () => {
    for (const { label, ctx, favor, p } of cases) {
      syncVendorContext(ctx);
      expect(hackingWorkRepGain(p, favor, ctx), label).toBe(getHackingWorkRepGain(p as never, favor));
    }
  });

  test("security work matches across representative contexts", () => {
    for (const { label, ctx, favor, p } of cases) {
      syncVendorContext(ctx);
      expect(securityWorkRepGain(p, favor, ctx), label).toBe(getFactionSecurityWorkRepGain(p as never, favor));
    }
  });

  test("field work matches across representative contexts", () => {
    for (const { label, ctx, favor, p } of cases) {
      syncVendorContext(ctx);
      expect(fieldWorkRepGain(p, favor, ctx), label).toBe(getFactionFieldWorkRepGain(p as never, favor));
    }
  });

  test("BitNode FactionWorkRepGain flows through identically", () => {
    const original = { ...currentNodeMults };
    try {
      replaceCurrentNodeMults(getBitNodeMultipliers(2, 1));
      const ctx: RepContext = { ...CTX, factionWorkRepGain: currentNodeMults.FactionWorkRepGain };
      syncVendorContext(ctx);
      const p = person();
      expect(hackingWorkRepGain(p, 30, ctx)).toBe(getHackingWorkRepGain(p as never, 30));
    } finally {
      replaceCurrentNodeMults(original);
    }
  });
});

describe("favor parity", () => {
  const samples = [0, 1, 13, 74, 150, 999, 5_000, 35_331];

  test("favorToRep is bit-identical", () => {
    for (const favor of samples) expect(favorToRep(favor)).toBe(vendoredFavorToRep(favor));
  });

  test("repToFavor is bit-identical, and clamps at MaxFavor", () => {
    for (const rep of [0, 1, 500, 12_500, 1e6, 1e12, 1e300]) {
      expect(repToFavor(rep)).toBe(vendoredRepToFavor(rep));
    }
  });

  test("addRepToFavor is bit-identical", () => {
    for (const favor of samples) {
      for (const rep of [0, 1_000, 250_000]) {
        expect(addRepToFavor(favor, rep)).toBe(vendoredAddRepToFavor(favor, rep));
      }
    }
  });

  test("the log constant is the representable one, not Math.log(1.02)", () => {
    // The game says so explicitly. Using Math.log(1.02) diverges at high rep,
    // which is exactly where favor decisions are made.
    expect(favorToRep(35_331)).toBe(vendoredFavorToRep(35_331));
    expect(favorToRep(35_331)).not.toBe(25000 * Math.expm1(Math.log(1.02) * 35_331));
  });
});

describe("donation parity", () => {
  const person1 = { mults: { faction_rep: 1 } } as never;
  const person2 = { mults: { faction_rep: 1.83 } } as never;

  test("repFromDonation and donationForRep are bit-identical", () => {
    for (const amount of [1e6, 5e8, 1.25e10]) {
      expect(repFromDonation(amount, 1, currentNodeMults.FactionWorkRepGain)).toBe(
        vendoredRepFromDonation(amount, person1),
      );
      expect(repFromDonation(amount, 1.83, currentNodeMults.FactionWorkRepGain)).toBe(
        vendoredRepFromDonation(amount, person2),
      );
    }
    for (const rep of [100, 75_000, 2.5e6]) {
      expect(donationForRep(rep, 1.83, currentNodeMults.FactionWorkRepGain)).toBe(vendoredDonationForRep(rep, person2));
    }
  });

  test("the two directions round-trip", () => {
    const rep = 123_456;
    const money = donationForRep(rep, 1.4, 1);
    expect(repFromDonation(money, 1.4, 1)).toBeCloseTo(rep, 6);
  });

  test("favorNeededToDonate matches, and is the RENAMED multiplier", () => {
    // v3.0.1 renamed RepToDonateToFaction -> FavorToDonateToFaction. The
    // predecessor scripts still use the old name, which reads as undefined and
    // silently makes the gate NaN.
    expect(favorNeededToDonate(currentNodeMults.FavorToDonateToFaction)).toBe(vendoredFavorNeeded());
    expect(favorNeededToDonate(1)).toBe(150);
  });
});

describe("the work-vs-idle crossover", () => {
  // The sharpest boundary in the whole feature. Passive rep has a
  // 1/120-per-cycle floor and SKIPS the faction you are working, so below a
  // threshold skill, working a faction is strictly worse than idling.
  test("below the crossover, working earns less than the passive tick it suppresses", () => {
    const ctx = CTX;
    const p = person({ hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 });
    const crossover = workBeatsIdleSkill("hacking", p, 0, ctx, true);
    expect(crossover).toBeGreaterThan(0);

    const below = person({ hacking: Math.floor(crossover) - 1, intelligence: 0 });
    const above = person({ hacking: Math.ceil(crossover) + 1, intelligence: 0 });
    expect(workRepPerSec("hacking", below, 0, ctx, true)).toBeLessThan(passiveRepPerSec(below, 0, ctx));
    expect(workRepPerSec("hacking", above, 0, ctx, true)).toBeGreaterThan(passiveRepPerSec(above, 0, ctx));
  });

  test("the crossover moves with the BitNode's FactionWorkRepGain", () => {
    // Both sides scale with it, but not identically — passive rep is driven by
    // the best skill while work is driven by the relevant one, so the node
    // genuinely changes where the line sits.
    const p = person({ intelligence: 0 });
    const bn1 = workBeatsIdleSkill("hacking", p, 0, { ...CTX, factionWorkRepGain: 1 }, true);
    const bn4 = workBeatsIdleSkill("hacking", p, 0, { ...CTX, factionWorkRepGain: 0.75 }, true);
    expect(bn1).toBeGreaterThan(0);
    expect(bn4).toBeGreaterThan(0);
  });
});

describe("focus penalty", () => {
  test("unfocused work is exactly 1/0.8 = 1.25x slower", () => {
    const p = person();
    const focused = workRepPerSec("hacking", p, 0, CTX, true);
    const unfocused = workRepPerSec("hacking", p, 0, CTX, false);
    expect(focused / unfocused).toBeCloseTo(1.25, 12);
  });

  test("Neuroreceptor Management Implant removes the penalty entirely", () => {
    const p = person();
    const ctx = { ...CTX, hasFocusAug: true };
    expect(workRepPerSec("hacking", p, 0, ctx, false)).toBe(workRepPerSec("hacking", p, 0, ctx, true));
  });
});

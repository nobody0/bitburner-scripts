import { describe, expect, test } from "bun:test";
import { parseContractReward } from "../shared/strategy/side/rewards.ts";

describe("contract reward parsing", () => {
  test("a contract that paid nothing is not a parse failure", () => {
    expect(parseContractReward("No reward for this contract")).toEqual({ kind: "none" });
  });

  test("a single faction award is exact, name taken whole", () => {
    expect(parseContractReward("Gained 833.3333333333334 faction reputation for CyberSec"))
      .toEqual({ kind: "factionRep", rep: 833.3333333333334, to: ["CyberSec"] });
    // The name is the whole remainder and is never split on ", ".
    expect(parseContractReward("Gained 2500 faction reputation for Tian Di Hui, Inc"))
      .toEqual({ kind: "factionRep", rep: 2500, to: ["Tian Di Hui, Inc"] });
  });

  test("the multi-faction award is split, and totals to repEach x recipients", () => {
    const parsed = parseContractReward(
      "Gained 277 reputation for each of the following factions: CyberSec, NiteSec, The Black Hand",
    );
    expect(parsed).toEqual({
      kind: "factionRep",
      rep: 831,
      repEach: 277,
      to: ["CyberSec", "NiteSec", "The Black Hand"],
    });
  });

  test("the multi-faction form is NOT read as one faction called 'each of the...'", () => {
    // Regression: this string also contains "reputation for", so a looser
    // single-faction pattern matches it and takes the tail as a faction name.
    const parsed = parseContractReward(
      "Gained 100 reputation for each of the following factions: CyberSec, NiteSec",
    );
    expect(parsed.kind).toBe("factionRep");
    if (parsed.kind !== "factionRep") throw new Error("unreachable");
    expect(parsed.to).toEqual(["CyberSec", "NiteSec"]);
    expect(parsed.to.some((name) => name.includes("each of the following"))).toBe(false);
  });

  test("a company award is exact", () => {
    expect(parseContractReward("Gained 1333.3 company reputation for ECorp"))
      .toEqual({ kind: "companyRep", rep: 1333.3, to: ["ECorp"] });
  });

  test("money is read across every suffix, and either symbol placement", () => {
    const cases: [string, number][] = [
      ["Gained $999", 999],
      ["Gained $1m", 1e6],
      ["Gained $1.235m", 1.235e6],
      ["Gained $1.235k", 1235],
      ["Gained $2b", 2e9],
      ["Gained $3t", 3e12],
      ["Gained $1n", 1e30],
      ["Gained 1.235m$", 1.235e6],   // CurrencySymbolAfterValue
      ["Gained 1.5m", 1.5e6],        // no symbol at all
      ["Gained $1.235e33", 1.235e33], // disableSuffixes / >= 1e33 branch
    ];
    for (const [text, money] of cases) {
      expect(parseContractReward(text), text).toEqual({ kind: "money", money });
    }
  });

  test("the suffix table is case-sensitive", () => {
    // q and Q, s and S are different magnitudes.
    expect(parseContractReward("Gained $1q")).toEqual({ kind: "money", money: 1e15 });
    expect(parseContractReward("Gained $1Q")).toEqual({ kind: "money", money: 1e18 });
    expect(parseContractReward("Gained $1s")).toEqual({ kind: "money", money: 1e21 });
    expect(parseContractReward("Gained $1S")).toEqual({ kind: "money", money: 1e24 });
  });

  test("a zero money award is REAL, not a parse failure", () => {
    // BN8 sets CodingContractMoney to 0, so every money reward there is "$0".
    // Folding this into `unparsed` would destroy the one signal that says the
    // node zeroes contract money.
    expect(parseContractReward("Gained $0")).toEqual({ kind: "money", money: 0 });
  });

  test("a grouping separator is rejected rather than read 1000x wrong", () => {
    // A canonical formatNumber output can never contain a thousands separator,
    // so one is proof the player's locale is not the one we read. de-DE's
    // "$1,235m" means 1.235e6; stripping the comma would yield 1235e6.
    for (const text of ["Gained $1,235m", "Gained 1.234.567", "Gained 1 234,5m"]) {
      expect(parseContractReward(text), text).toEqual({ kind: "unparsed", why: "money-format" });
    }
  });

  test("unreadable strings report which half failed, and never a zero", () => {
    expect(parseContractReward("")).toEqual({ kind: "unparsed", why: "no-pattern" });
    expect(parseContractReward("Solved!")).toEqual({ kind: "unparsed", why: "no-pattern" });
    expect(parseContractReward("Gained NaN")).toEqual({ kind: "unparsed", why: "money-format" });
    expect(parseContractReward("Gained $∞")).toEqual({ kind: "unparsed", why: "money-format" });
    expect(parseContractReward("Gained ")).toEqual({ kind: "unparsed", why: "money-format" });
    // A rep string whose number is unreadable must NOT slide into the money
    // fallback and be reported as money.
    expect(parseContractReward("Gained abc faction reputation for CyberSec"))
      .toEqual({ kind: "unparsed", why: "rep-number" });
    expect(parseContractReward("Gained abc company reputation for ECorp"))
      .toEqual({ kind: "unparsed", why: "rep-number" });
  });

  test("no input yields money 0 unless the text's number really is zero", () => {
    const zeroish = ["Gained $", "Gained ", "Gained NaN", "Gained abc", "", "Gained $1,000"];
    for (const text of zeroish) {
      const parsed = parseContractReward(text);
      expect(parsed.kind === "money" && parsed.money === 0, text).toBe(false);
    }
  });

  test("the parser is total: no input throws", () => {
    const templates = [
      "No reward for this contract",
      "Gained 277 reputation for each of the following factions: A, B",
      "Gained 100 faction reputation for CyberSec",
      "Gained 100 company reputation for ECorp",
      "Gained $1.235m",
      "",
    ];
    const mutations = ["", "$", " ", "−", "e", ",", ".", "NaN", "∞", "0", "٣"];
    for (const template of templates) {
      for (const mutation of mutations) {
        for (let cut = 0; cut <= template.length; cut++) {
          const text = template.slice(0, cut) + mutation + template.slice(cut);
          expect(() => parseContractReward(text)).not.toThrow();
        }
      }
    }
  });

  test("both faction award forms report the same kind", () => {
    expect(parseContractReward("Gained 100 faction reputation for X").kind).toBe("factionRep");
    expect(parseContractReward("Gained 5 reputation for each of the following factions: X, Y").kind)
      .toBe("factionRep");
    expect(parseContractReward("Gained $1m").kind).toBe("money");
    expect(parseContractReward("No reward for this contract").kind).toBe("none");
    expect(parseContractReward("junk").kind).toBe("unparsed");
  });
});

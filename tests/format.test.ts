import { describe, expect, test } from "bun:test";
import { formatMoney, formatNumber, formatScientific } from "../shared/format.ts";
import { fmtMoney, fmtNum } from "../ui/app/lib/format.ts";

describe("scientific number output", () => {
  test("matches Bitburner v3.0.1's scientific formatter", () => {
    expect(formatScientific(2_230_000_000_000)).toBe("2.230e12");
    expect(formatScientific(-1_024_500)).toBe("-1.025e6");
    expect(formatScientific(Infinity)).toBe("∞");
  });

  test("replaces every compact magnitude suffix at 1e3", () => {
    expect(formatNumber(999, 2)).toBe("999.00");
    expect(formatNumber(1_000, 2)).toBe("1.000e3");
    expect(formatNumber(2_230_000_000_000)).toBe("2.230e12");
    expect(formatMoney(-9_230_000_000_000)).toBe("$-9.230e12");
  });

  test("UI wrappers retain missing-value handling without suffixing", () => {
    expect(fmtNum(undefined)).toBe("–");
    expect(fmtMoney(Number.NaN)).toBe("–");
    expect(fmtNum(31_305)).toBe("3.131e4");
    expect(fmtMoney(945_200_000)).toBe("$9.452e8");
  });
});

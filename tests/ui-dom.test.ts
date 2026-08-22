import { describe, expect, test } from "bun:test";

import { hint, outcome, rankedTable, shownOf, waiting } from "../ui/app/lib/dom.ts";

/** The shared copy helpers are the single source of truth for recurring
 * wording; these tests pin their exact output so per-tab assertions can rely
 * on stable fragments. */

describe("dom helpers", () => {
  test("waiting words the empty state once", () => {
    expect(waiting("the corporation probe")).toBe('<p class="muted">waiting for the corporation probe</p>');
    expect(waiting("the corporation probe", "getCorporation is 10 GB")).toBe(
      '<p class="muted" title="getCorporation is 10 GB">waiting for the corporation probe</p>',
    );
  });

  test("outcome renders a status dot plus the detail", () => {
    const ok = outcome({ ok: true, detail: "bought 1 node" });
    expect(ok).toContain('class="dot good"');
    expect(ok).toContain('title="last action succeeded"');
    expect(ok).toContain("bought 1 node");
    const bad = outcome({ ok: false, detail: "not enough money" });
    expect(bad).toContain('class="dot bad"');
    expect(bad).toContain('title="last action failed"');
  });

  test("shownOf words truncation once", () => {
    expect(shownOf(10, 42)).toBe('<p class="muted">10 of 42 — sort or filter to see the rest</p>');
    expect(shownOf(5, 9, "scored options")).toBe('<p class="muted">5 of 9 — scored options</p>');
  });

  test("hint carries its explanation in the title", () => {
    expect(hint("estimated", "no 4S API").toString()).toBe('<span class="hint" title="no 4S API">estimated</span>');
  });

  test("rankedTable marks the chosen row", () => {
    const html = rankedTable(
      ["option", "cost"],
      [
        ["a", "1"],
        ["b", "2"],
      ],
      { selected: (i) => i === 1, shown: 2, total: 5 },
    );
    expect(html).toContain('<tr class="picked">');
    expect(html).toContain("▶");
    expect(html).toContain("2 of 5 — scored options");
  });
});

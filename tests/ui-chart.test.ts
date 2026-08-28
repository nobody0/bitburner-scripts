import { describe, expect, test } from "bun:test";
import { seriesBounds, type ChartSeries } from "../ui/app/lib/chart.ts";

/** The chart's y-domain, including negative values needed by realized P/L. */

function series(...values: number[]): ChartSeries[] {
  return [{ pts: values.map((v, i) => [i, v] as [number, number]), color: "--series-1" }];
}

describe("seriesBounds", () => {
  test("a non-negative series still floors at zero", () => {
    // The guarantee that made the change safe for the four charts that predate
    // it: with y0 === 0 the caller's mapping reduces to exactly what it was.
    expect(seriesBounds(series(0, 5, 12))).toEqual({ x0: 0, x1: 2, y0: 0, y1: 12 });
    expect(seriesBounds(series(3, 5, 12)).y0).toBe(0);
  });

  test("a signed series extends the domain to its minimum", () => {
    expect(seriesBounds(series(4, -7, 12))).toEqual({ x0: 0, x1: 2, y0: -7, y1: 12 });
  });

  test("an all-negative series keeps zero in range", () => {
    // A run that has only ever lost money still reads against the break-even
    // line, so zero stays on the axis rather than becoming the top of it.
    expect(seriesBounds(series(-4, -7, -2))).toEqual({ x0: 0, x1: 2, y0: -7, y1: 0 });
  });

  test("a flat-at-zero series gets a span rather than dividing by nothing", () => {
    expect(seriesBounds(series(0, 0, 0))).toEqual({ x0: 0, x1: 2, y0: 0, y1: 1 });
  });

  test("the extent spans every series", () => {
    const bounds = seriesBounds([
      { pts: [[0, 10], [10, 20]], color: "--series-1" },
      { pts: [[-5, -30], [4, 5]], color: "--series-2" },
    ]);
    expect(bounds).toEqual({ x0: -5, x1: 10, y0: -30, y1: 20 });
  });
});

/** The fitted y-domain, for a series that lives in a narrow band far from zero.
 * Anchoring zero is right for a magnitude and destroys a ratio: an in-order
 * share between 0.97 and 1.00 on a 0..1 axis is a flat line hugging the top,
 * and the 3% that is the whole finding is a fraction of a pixel. */
describe("seriesBounds — fitted", () => {
  test("a band far from zero is scaled to the band, not to zero", () => {
    const { y0, y1 } = seriesBounds(series(0.97, 0.99, 1.0), true);
    // The floor rises off zero, so the band occupies the panel...
    expect(y0).toBeGreaterThan(0.9);
    // ...with a margin, so its extremes are not clipped to the frame.
    expect(y0).toBeLessThan(0.97);
    expect(y1).toBeGreaterThan(1.0);
  });

  test("fitting is opt-in — the default still floors at zero", () => {
    expect(seriesBounds(series(0.97, 0.99, 1.0)).y0).toBe(0);
  });

  test("fitting does not snap back to zero for a band near it", () => {
    // 0.01 to 0.03 is a threefold swing. Re-flooring it at zero would flatten
    // the one thing the caller asked to see.
    expect(seriesBounds(series(0.01, 0.03), true).y0).toBeGreaterThan(0);
  });

  test("a fitted signed band keeps its negative floor", () => {
    expect(seriesBounds(series(-3, 4), true).y0).toBeLessThan(-3);
  });

  test("a dead-flat band still gets a drawable span", () => {
    const { y0, y1 } = seriesBounds(series(5, 5, 5), true);
    expect(y1).toBeGreaterThan(y0);
    // And it sits in the middle rather than on an edge.
    expect(y0).toBeLessThan(5);
    expect(y1).toBeGreaterThan(5);
  });

  test("the x extent scans every point, not just the ends", () => {
    // A point series is a scatter of independent observations, and nothing
    // promises the dispatcher hands them over sorted by time: batches are
    // ordered by when they SETTLED while ids are assigned when they opened.
    const bounds = seriesBounds([
      { pts: [[50, 1], [10, 2], [90, 3], [30, 4]], color: "--series-1", kind: "points" },
    ]);
    expect(bounds.x0).toBe(10);
    expect(bounds.x1).toBe(90);
  });
});

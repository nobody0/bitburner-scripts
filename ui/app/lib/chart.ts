import { fmtMoney, fmtTime } from "./format.ts";

/** Line chart on a canvas. Lifted from the original inline dashboard:
 * recessive grid, 2px series lines, crosshair + tooltip on hover. Colours
 * come from the CSS custom properties so it follows the light/dark theme
 * without a second palette.
 *
 * Generalised from the original single-series money chart: any number of
 * series, an injectable y-formatter, and PER-CANVAS geometry (the original
 * kept one module-level geom, so a second chart on any tab corrupted the
 * first one's hover). */

export interface ChartSeries {
  pts: [number, number][];
  /** CSS custom property naming the stroke, e.g. "--series-1". */
  color: string;
  label?: string;
  /** How to render it. `"points"` draws a mark per sample instead of joining
   * them, for a series whose samples are INDEPENDENT observations rather than
   * a quantity moving over time — one settled batch each, say. Joining those
   * with a line asserts a continuity between neighbours that does not exist,
   * and the shape of the resulting zig-zag is an artefact of arrival order.
   *
   * Defaults to `"line"`, so every existing caller is unchanged. */
  kind?: "line" | "points";
}

/** Per-draw geometry choices. A small multiple has ~200px of width, where the
 * full chart's 56px y-axis gutter and five gridlines are most of the panel. */
export interface ChartOptions {
  compact?: boolean;
  /** Scale y to the data instead of anchoring the axis at zero.
   *
   * Zero is the right floor for a magnitude — money, op counts, RAM — where
   * "how big" is the reading. It destroys a series that lives in a narrow band
   * far from zero, which is what every RATIO and every LATENCY here is: an
   * in-order share sitting between 0.97 and 1.00 renders as a flat line hugging
   * the top of a 0..1 axis, and the 3% that is the entire finding is a third of
   * one pixel.
   *
   * Off by default. Only a caller that knows its series is a band should ask,
   * because a fitted axis exaggerates noise into mountains for anything else —
   * and because the gridline labels are what tell the reader the axis does not
   * start at zero, so it is only honest on a chart big enough to show them. */
  fitY?: boolean;
}

/** Canvas heights, from `canvas`, `canvas.minichart` and `canvas.microchart`
 * in app.css. A size is a layout decision and `compact` a geometry one: the
 * 88px microchart needs both, the 140px minichart only the first. */
export type ChartSize = "full" | "mini" | "micro";

export interface ChartGeom {
  series: ChartSeries[];
  sx(t: number): number;
  sy(v: number): number;
  t0: number;
  pad: { l: number; r: number; t: number; b: number };
  w: number;
  h: number;
  fmtY(v: number): string;
  options: ChartOptions;
}

const geoms = new WeakMap<HTMLCanvasElement, ChartGeom>();

function color(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The chartwrap / canvas / charttip trio, worded once.
 *
 * `${id}tip` is the tooltip id by convention, so `mountChart` needs only the
 * canvas id. The wrapper is what makes the tooltip's absolute position relative
 * to its OWN chart rather than to the page, so the two cannot be emitted
 * separately — which is the whole reason this lives here and not in dom.ts. */
export function chartCanvas(id: string, size: ChartSize = "mini"): string {
  const cls = size === "full" ? "" : ` class="${size}chart"`;
  return `<div class="chartwrap"><canvas id="${id}"${cls}></canvas><div class="charttip" id="${id}tip"></div></div>`;
}

export interface SeriesBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** The drawn extent of a set of series.
 *
 * `y0` is `min(0, …)` rather than the data minimum: zero is the reading the
 * eye takes off a money chart, so it stays on the axis even when nothing is
 * near it. That also makes a SIGNED series drawable at all — a realized-P/L
 * curve dips below zero on a genuine loss, and the earlier fixed zero floor
 * clipped exactly that case into the bottom padding.
 *
 * Pure, and separate from the drawing, because this is the part worth
 * asserting: with every point >= 0 it returns `y0 === 0` and the caller's
 * arithmetic reduces to what it was before signed series existed.
 *
 * With `fit`, the floor is the data minimum instead — for a series that lives
 * in a band far from zero, where anchoring zero flattens the whole reading. The
 * fitted range carries a small margin so the extreme points do not sit exactly
 * on the frame.
 *
 * Every series must carry at least one point; `drawSeries` filters to the ones
 * that can be drawn before asking. */
export function seriesBounds(series: ChartSeries[], fit = false): SeriesBounds {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = fit ? Infinity : 0;
  let y1 = fit ? -Infinity : 0;
  for (const s of series) {
    // NOT pts[0] / pts[last]: a point series is a scatter of independent
    // observations and nothing promises they arrive sorted by x.
    for (const p of s.pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
      if (p[1] < y0) y0 = p[1];
    }
  }
  if (fit) {
    // A margin, so the min and max are readable rather than clipped to the
    // frame. Proportional to the span, with a fallback for a dead-flat band —
    // whose span is zero, and which must still occupy the middle of the chart
    // rather than divide by it.
    const span = y1 - y0;
    const margin = span > 0 ? span * 0.08 : Math.max(Math.abs(y1), 1) * 0.08;
    y0 -= margin;
    y1 += margin;
    // No snapping back to zero when the band happens to sit near it. Fitting is
    // opt-in and means what it says: a caller asks for it because the SHAPE of
    // its band is the reading, and a band from 0.01 to 0.03 varies threefold —
    // re-flooring that at zero would hide exactly what was asked for. Signed
    // data needs no special case either; the minimum is simply negative, and
    // `drawSeries` already rules zero in whenever the domain crosses it.
  }
  // A flat-at-zero series would otherwise divide by a zero span.
  if (y1 === y0) y1 = y0 + 1;
  return { x0, x1, y0, y1 };
}

/** Whether a set of series has a TIMELINE to draw, not merely points.
 *
 * The point count is the wrong test, and it is the one every caller reached for
 * first. `game/lib/telemetry-sink.ts` mirrors `player` to `getPlayer` in the
 * same flush, so a game run pushes each money sample into the series twice at
 * one millisecond: two points, zero span. `drawSeries`' x-scale then divides by
 * `Math.max(1, x1 - x0)`, which collapses both to the left edge and draws a
 * full-width axis with three identical time labels — a chart asserting a
 * timeline over a single observation, which is worse than drawing nothing.
 *
 * A caller gates on this and swaps in `note(...)`; the empty state stays HTML,
 * in the same vocabulary as every other "nothing yet" in the viewer, rather than
 * becoming a second one painted into a bitmap. */
export function hasSpan(...series: readonly (readonly [number, number][])[]): boolean {
  for (const pts of series) {
    if (pts.length < 2) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const p of pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
    }
    if (x1 > x0) return true;
  }
  return false;
}

export function drawSeries(
  canvas: HTMLCanvasElement,
  series: ChartSeries[],
  t0: number | null,
  fmtY: (v: number) => string = fmtMoney,
  options: ChartOptions = {},
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const drawn = series.filter((s) => s.pts.length >= 2);
  if (drawn.length === 0) {
    geoms.delete(canvas);
    return;
  }

  // Resolved ONCE. Each `color()` is a fresh getComputedStyle on the document
  // element — a forced style resolution — and the loops below asked for the same
  // four tokens per gridline. They still come from the CSS custom properties, so
  // the chart follows the theme with no second palette; they simply cannot
  // change in the middle of one draw.
  const baselineColor = color("--baseline");
  const gridColor = color("--grid");
  const mutedColor = color("--muted");
  const monoFont = color("--font-mono") || 'JetBrainsMono, "Courier New", monospace';

  const pad = options.compact ? { l: 34, r: 4, t: 4, b: 14 } : { l: 56, r: 10, t: 8, b: 22 };
  const lines = options.compact ? 2 : 4;
  const { x0, x1, y0, y1 } = seriesBounds(drawn, options.fitY);
  const base = t0 ?? x0;
  const sx = (t: number) => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (w - pad.l - pad.r);
  const sy = (v: number) => h - pad.b - ((v - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  geoms.set(canvas, { series: drawn, sx, sy, t0: base, pad, w, h, fmtY, options });

  // Below this fraction of the span, a gridline IS the zero line and takes the
  // stronger stroke. With `y0 === 0` that is the bottom line, exactly as when
  // zero was the hard floor.
  const zeroish = (v: number) => Math.abs(v) <= (y1 - y0) * 1e-9;
  ctx.font = `${options.compact ? 9 : 11}px ${monoFont}`;
  let drewZero = false;
  for (let i = 0; i <= lines; i++) {
    const v = y0 + ((y1 - y0) / lines) * i;
    const y = sy(v);
    if (zeroish(v)) drewZero = true;
    ctx.strokeStyle = zeroish(v) ? baselineColor : gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = mutedColor;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(fmtY(v), pad.l - 6, y);
  }
  // A signed chart's gridlines rarely land on zero, and the sign of the curve
  // is the reading — so where no gridline drew it, zero gets its own rule.
  if (!drewZero && y0 < 0 && y1 > 0) {
    ctx.strokeStyle = baselineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, sy(0));
    ctx.lineTo(w - pad.r, sy(0));
    ctx.stroke();
  }
  ctx.textBaseline = "top";
  // A compact chart labels only its ends, and anchors them INWARD: a centred
  // label at f=0 would hang into the y-axis gutter it no longer has room for.
  for (const f of options.compact ? [0, 1] : [0, 0.5, 1]) {
    const t = x0 + (x1 - x0) * f;
    ctx.textAlign = options.compact ? (f === 0 ? "left" : "right") : "center";
    ctx.fillText(fmtTime(t - base), sx(t), h - pad.b + 2);
  }
  const dot = options.compact ? 1.6 : 2.4;
  for (const s of drawn) {
    const stroke = color(s.color);
    if (s.kind === "points") {
      // Independent observations: a mark each, no path between them.
      ctx.fillStyle = stroke;
      for (const p of s.pts) {
        ctx.beginPath();
        ctx.arc(sx(p[0]), sy(p[1]), dot, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    s.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p[0]), sy(p[1])) : ctx.lineTo(sx(p[0]), sy(p[1]))));
    ctx.stroke();
  }
}

/** Canvases that already carry their listeners.
 *
 * `mount` runs after every render, and the canvas node now SURVIVES a render
 * (the panel is patched, not rebuilt), so an unguarded attach would add a
 * fresh pair of listeners twice a second and redraw the chart once per
 * accumulated listener on every mouse move. */
const wired = new WeakSet<HTMLCanvasElement>();

/** Wire crosshair + tooltip once; the chart itself is redrawn on every frame.
 *
 * Coalesce pointer updates through requestAnimationFrame. A redraw is not
 * cheap: `drawSeries` reassigns
 * `canvas.width`/`height`, which reallocates the bitmap, then re-strokes every
 * point of every series — the allocation chart carries three series of up to
 * SERIES_LIMIT points each, so ~6,000 path ops, on the same main thread that is
 * already repainting panels twice a second. Several pointer events therefore
 * collapse into one frame.
 *
 * Two details the coalescing makes load-bearing: `mouseleave` has to CANCEL a
 * pending frame, or a queued crosshair repaints itself after the tooltip is
 * hidden; and the frame has to re-read the geometry, because the 500 ms render
 * loop may have replaced the series between the event and the frame. */
export function attachChartHover(canvas: HTMLCanvasElement, tooltip: HTMLElement): void {
  if (wired.has(canvas)) return;
  wired.add(canvas);
  let frame = 0;
  let pointerX = 0;

  const paint = (): void => {
    frame = 0;
    // Re-read rather than close over: the panel re-renders on its own clock and
    // the geom under this canvas is replaced wholesale when it does.
    const geom = geoms.get(canvas);
    if (!geom) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const mx = pointerX;
    // Nearest point on the FIRST series anchors the crosshair; the tooltip
    // reports every series at that time.
    const anchor = geom.series[0]!;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const p of anchor.pts) {
      const d = Math.abs(geom.sx(p[0]) - mx);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;
    drawSeries(canvas, geom.series, geom.t0, geom.fmtY, geom.options);
    const redrawn = geoms.get(canvas);
    if (!redrawn) return;
    ctx.strokeStyle = color("--baseline");
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(redrawn.sx(best[0]), redrawn.pad.t);
    ctx.lineTo(redrawn.sx(best[0]), redrawn.h - redrawn.pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    const at = best[0];
    const readings: string[] = [];
    for (const s of redrawn.series) {
      let closest: [number, number] | null = null;
      let closestD = Infinity;
      for (const p of s.pts) {
        const d = Math.abs(p[0] - at);
        if (d < closestD) {
          closestD = d;
          closest = p;
        }
      }
      if (!closest) continue;
      ctx.fillStyle = color(s.color);
      ctx.beginPath();
      ctx.arc(redrawn.sx(closest[0]), redrawn.sy(closest[1]), 4, 0, Math.PI * 2);
      ctx.fill();
      readings.push(`${s.label ? `${s.label} ` : ""}${redrawn.fmtY(closest[1])}`);
    }
    tooltip.style.display = "block";
    tooltip.textContent = `${fmtTime(at - redrawn.t0)} — ${readings.join(" · ")}`;
    // Measure after setting the text because a hidden element has zero width;
    // clamp against the actual nowrap tooltip rather than an assumed width. A
    // wide reading can otherwise land outside the card, which clips because `overflow-x: auto`
    // on `section.card` makes the vertical axis compute to `auto` as well and the
    // card a scroll container in both. Flipping the tip to the left of the
    // crosshair when it will not fit on the right keeps it whole.
    const width = tooltip.offsetWidth;
    const right = redrawn.sx(at) + 10;
    const left = right + width > redrawn.w ? Math.max(0, redrawn.sx(at) - 10 - width) : right;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(0, redrawn.sy(best[1]) - 30)}px`;
  };

  canvas.addEventListener("mousemove", (ev) => {
    pointerX = ev.clientX - canvas.getBoundingClientRect().left;
    if (frame === 0) frame = requestAnimationFrame(paint);
  });
  canvas.addEventListener("mouseleave", () => {
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    tooltip.style.display = "none";
    const geom = geoms.get(canvas);
    if (geom) drawSeries(canvas, geom.series, geom.t0, geom.fmtY, geom.options);
  });
}

/** Draw one chart emitted by `chartCanvas`, if it is present and has something
 * to say. A series with fewer than two points draws nothing (see drawSeries),
 * so an empty chart is silence rather than a misleading flat line at zero.
 *
 * Called from a tab's `mount`, i.e. after every render, so it must stay
 * idempotent — `attachChartHover` wires a given canvas exactly once. A canvas
 * inside a collapsed `<details>` measures 0x0 and draws a blank bitmap; opening
 * the disclosure re-renders, which redraws it at its real size. */
export function mountChart(
  el: HTMLElement,
  canvasId: string,
  series: ChartSeries[],
  t0: number | null,
  fmtY?: (value: number) => string,
  options: ChartOptions = {},
): void {
  const canvas = el.querySelector<HTMLCanvasElement>(`#${canvasId}`);
  const tooltip = el.querySelector<HTMLElement>(`#${canvasId}tip`);
  if (!canvas || !tooltip) return;
  drawSeries(canvas, series, t0, fmtY, options);
  attachChartHover(canvas, tooltip);
}

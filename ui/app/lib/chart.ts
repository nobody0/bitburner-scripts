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
}

export interface ChartGeom {
  series: ChartSeries[];
  sx(t: number): number;
  sy(v: number): number;
  t0: number;
  pad: { l: number; r: number; t: number; b: number };
  w: number;
  h: number;
  fmtY(v: number): string;
}

const geoms = new WeakMap<HTMLCanvasElement, ChartGeom>();

function color(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function drawSeries(
  canvas: HTMLCanvasElement,
  series: ChartSeries[],
  t0: number | null,
  fmtY: (v: number) => string = fmtMoney,
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

  const pad = { l: 56, r: 10, t: 8, b: 22 };
  let x0 = Infinity;
  let x1 = -Infinity;
  let y1 = 0;
  for (const s of drawn) {
    x0 = Math.min(x0, s.pts[0]![0]);
    x1 = Math.max(x1, s.pts[s.pts.length - 1]![0]);
    for (const p of s.pts) if (p[1] > y1) y1 = p[1];
  }
  y1 = y1 || 1;
  const base = t0 ?? x0;
  const sx = (t: number) => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (w - pad.l - pad.r);
  const sy = (v: number) => h - pad.b - (v / y1) * (h - pad.t - pad.b);
  geoms.set(canvas, { series: drawn, sx, sy, t0: base, pad, w, h, fmtY });

  ctx.font = "11px system-ui, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const v = (y1 / 4) * i;
    const y = sy(v);
    ctx.strokeStyle = i === 0 ? color("--baseline") : color("--grid");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = color("--muted");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(fmtY(v), pad.l - 6, y);
  }
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  for (const f of [0, 0.5, 1]) {
    const t = x0 + (x1 - x0) * f;
    ctx.fillText(fmtTime(t - base), sx(t), h - pad.b + 4);
  }
  for (const s of drawn) {
    ctx.strokeStyle = color(s.color);
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    s.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p[0]), sy(p[1])) : ctx.lineTo(sx(p[0]), sy(p[1]))));
    ctx.stroke();
  }
}

/** The original single-series entry point, kept because the overview tab and
 * its tests use it directly. */
export function drawChart(canvas: HTMLCanvasElement, pts: [number, number][], t0: number | null): void {
  drawSeries(canvas, [{ pts, color: "--series-1" }], t0);
}

/** Wire crosshair + tooltip once; the chart itself is redrawn on every frame. */
export function attachChartHover(canvas: HTMLCanvasElement, tooltip: HTMLElement): void {
  canvas.addEventListener("mousemove", (ev) => {
    const geom = geoms.get(canvas);
    if (!geom) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
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
    drawSeries(canvas, geom.series, geom.t0, geom.fmtY);
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
    tooltip.style.left = `${Math.min(redrawn.w - 140, redrawn.sx(at) + 10)}px`;
    tooltip.style.top = `${Math.max(0, redrawn.sy(best[1]) - 30)}px`;
  });
  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    const geom = geoms.get(canvas);
    if (geom) drawSeries(canvas, geom.series, geom.t0, geom.fmtY);
  });
}

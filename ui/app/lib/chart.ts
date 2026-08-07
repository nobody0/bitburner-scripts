import { fmtMoney, fmtTime } from "./format.ts";

/** Single-series line chart on a canvas. Lifted from the original inline
 * dashboard: recessive grid, one 2px series line, crosshair + tooltip on
 * hover. Colours come from the CSS custom properties so it follows the
 * light/dark theme without a second palette. */

export interface ChartGeom {
  pts: [number, number][];
  sx(t: number): number;
  sy(v: number): number;
  t0: number;
  pad: { l: number; r: number; t: number; b: number };
  w: number;
  h: number;
}

let geom: ChartGeom | null = null;

function color(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function drawChart(canvas: HTMLCanvasElement, pts: [number, number][], t0: number | null): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (pts.length < 2) {
    geom = null;
    return;
  }

  const pad = { l: 56, r: 10, t: 8, b: 22 };
  const base = t0 ?? pts[0]![0];
  const x0 = pts[0]![0];
  const x1 = pts[pts.length - 1]![0];
  let y1 = 0;
  for (const p of pts) if (p[1] > y1) y1 = p[1];
  y1 = y1 || 1;
  const sx = (t: number) => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (w - pad.l - pad.r);
  const sy = (v: number) => h - pad.b - (v / y1) * (h - pad.t - pad.b);
  geom = { pts, sx, sy, t0: base, pad, w, h };

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
    ctx.fillText(fmtMoney(v), pad.l - 6, y);
  }
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  for (const f of [0, 0.5, 1]) {
    const t = x0 + (x1 - x0) * f;
    ctx.fillText(fmtTime(t - base), sx(t), h - pad.b + 4);
  }
  ctx.strokeStyle = color("--series-1");
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p[0]), sy(p[1])) : ctx.lineTo(sx(p[0]), sy(p[1]))));
  ctx.stroke();
}

/** Wire crosshair + tooltip once; the chart itself is redrawn on every frame. */
export function attachChartHover(canvas: HTMLCanvasElement, tooltip: HTMLElement): void {
  canvas.addEventListener("mousemove", (ev) => {
    if (!geom) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const p of geom.pts) {
      const d = Math.abs(geom.sx(p[0]) - mx);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;
    const current = geom;
    drawChart(canvas, current.pts, current.t0);
    if (!geom) return;
    ctx.strokeStyle = color("--baseline");
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(geom.sx(best[0]), geom.pad.t);
    ctx.lineTo(geom.sx(best[0]), geom.h - geom.pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color("--series-1");
    ctx.beginPath();
    ctx.arc(geom.sx(best[0]), geom.sy(best[1]), 4, 0, Math.PI * 2);
    ctx.fill();
    tooltip.style.display = "block";
    tooltip.textContent = `${fmtTime(best[0] - geom.t0)} — ${fmtMoney(best[1])}`;
    tooltip.style.left = `${Math.min(geom.w - 140, geom.sx(best[0]) + 10)}px`;
    tooltip.style.top = `${Math.max(0, geom.sy(best[1]) - 30)}px`;
  });
  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    if (geom) drawChart(canvas, geom.pts, geom.t0);
  });
}

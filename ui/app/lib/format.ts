import { formatMoney, formatNumber } from "../../../shared/format.ts";
import { escapeText } from "./html.ts";

/** Formatting + escaping helpers shared by every tab. */

export function fmtMoney(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  return formatMoney(n);
}

export function fmtNum(n: number | undefined | null, digits = 0): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  return formatNumber(n, digits);
}

export function fmtRam(gb: number | undefined | null): string {
  if (gb === undefined || gb === null || Number.isNaN(gb)) return "–";
  if (gb >= 1e6) return `${(gb / 1e6).toFixed(2)}PB`;
  if (gb >= 1e3) return `${(gb / 1e3).toFixed(2)}TB`;
  return `${gb.toFixed(gb < 10 ? 2 : 0)}GB`;
}

export function fmtTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "–";
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(0)}s`;
  if (s < 5400) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400 * 1.5) return `${(s / 3600).toFixed(2)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export function fmtPct(fraction: number | undefined | null, digits = 1): string {
  if (fraction === undefined || fraction === null || Number.isNaN(fraction)) return "–";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Escape a value for interpolation into a RAW slot — a table cell, a card
 * body, an attribute inside a hand-built fragment.
 *
 * Do NOT call it on the way into a TEXT slot (`note`, a tile value, a `title`
 * argument, an html`` interpolation): those escape for you, so a second pass
 * prints `&amp;quot;` in the middle of a server name. See lib/html.ts. */
export const esc = escapeText;

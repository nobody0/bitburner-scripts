/** Formatting + escaping helpers shared by every tab. Lifted verbatim in
 * behaviour from the original inline dashboard script so charts and tables
 * keep reading identically. */

export function fmtMoney(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const units: [string, number][] = [
    ["q", 1e15],
    ["t", 1e12],
    ["b", 1e9],
    ["m", 1e6],
    ["k", 1e3],
  ];
  for (const [suffix, size] of units) if (abs >= size) return `${sign}$${(abs / size).toFixed(2)}${suffix}`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtNum(n: number | undefined | null, digits = 0): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return n.toFixed(digits);
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

/** Every value interpolated into a template goes through this. Telemetry
 * payloads are game-controlled strings (server names, faction names, error
 * messages); none of it should be able to inject markup into the viewer. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

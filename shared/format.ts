/**
 * Numeric display shared by telemetry producers and the external UI.
 *
 * Bitburner v3.0.1 formats its exponential branch with an
 * `Intl.NumberFormat` configured for scientific (or optional engineering)
 * notation and three fractional digits. This dependency-free copy fixes the
 * locale to English for stable telemetry; game bundles cannot import the
 * upstream UI module.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/ui/formatNumber.ts#L29-L56
 */
const scientificFormatter = new Intl.NumberFormat(["en"], {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
  notation: "scientific",
});

/** Bitburner's scientific display, including its lowercase exponent marker.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/ui/formatNumber.ts#L29-L56 */
export function formatScientific(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (Math.abs(n) === Infinity) return n < 0 ? "-∞" : "∞";
  return scientificFormatter.format(n).toLocaleLowerCase();
}

/**
 * Fixed-point for ordinary values; this stable telemetry form switches to
 * Bitburner's exponential formatter from 1e3 onward. The game UI normally
 * uses compact suffixes below 1e33 unless suffixes are disabled.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/ui/formatNumber.ts#L122-L157
 */
export function formatNumber(n: number, fractionalDigits = 0): string {
  if (Number.isNaN(n)) return "NaN";
  if (Math.abs(n) === Infinity) return n < 0 ? "-∞" : "∞";
  if (Math.abs(n) >= 1e3) return formatScientific(n);
  return n.toFixed(fractionalDigits);
}

export function formatMoney(n: number, fractionalDigits = 0): string {
  return `$${formatNumber(n, fractionalDigits)}`;
}

/** Round to `digits` significant figures. For REPORTS (digests, why-strings),
 * never decisions: full precision makes every digest whose signature embeds a
 * drifting value differ on each pass, and the change-filtered store then
 * writes a record per tick for the whole run. One shared primitive because
 * two private copies (the arbitration digest's and the horizon's) had already
 * grown different edge-case guards. */
export function roundSigFigs(value: number, digits: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const scale = 10 ** (Math.floor(Math.log10(Math.abs(value))) - (digits - 1));
  return Math.round(value / scale) * scale;
}

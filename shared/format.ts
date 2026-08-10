/**
 * Numeric display shared by telemetry producers and the external UI.
 *
 * Bitburner v3.0.1 formats its exponential branch with an English
 * `Intl.NumberFormat` configured for scientific notation and three fractional
 * digits. Keep this small, dependency-free copy aligned with
 * `src/ui/formatNumber.ts`; game bundles cannot import the upstream UI module.
 */
const scientificFormatter = new Intl.NumberFormat(["en"], {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
  notation: "scientific",
});

/** Bitburner's scientific display, including its lowercase exponent marker. */
export function formatScientific(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (Math.abs(n) === Infinity) return n < 0 ? "-∞" : "∞";
  return scientificFormatter.format(n).toLocaleLowerCase();
}

/**
 * Fixed-point for ordinary values; Bitburner's scientific form replaces all
 * compact k/m/b/t/q suffixes from 1e3 onward.
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

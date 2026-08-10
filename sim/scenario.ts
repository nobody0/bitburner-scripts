import { createHash } from "node:crypto";

/** Canonical JSON used to prove two A/B inputs are the same experiment.
 * Object keys are sorted recursively; array order remains meaningful. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** Versioned because adding a newly relevant initial condition should make old
 * and new runs incomparable, not silently preserve an incomplete identity. */
export function scenarioFingerprint(input: unknown): string {
  const payload = JSON.stringify({ version: 1, input: canonical(input) });
  return `v1:${createHash("sha256").update(payload).digest("hex")}`;
}

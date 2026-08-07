// Vendored from bitburner-src v3.0.1:src/PersonObjects/formulas/intelligence.ts by tools/vendor.ts — DO NOT EDIT
export function calculateIntelligenceBonus(intelligence: number, weight = 1): number {
  return 1 + (weight * Math.pow(intelligence, 0.8)) / 600;
}

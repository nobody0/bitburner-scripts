// Vendored from bitburner-src v3.0.1:src/utils/helpers/isValidNumber.ts by tools/vendor.ts — DO NOT EDIT
/**
 * Checks that a variable is a valid number. A valid number
 * must be a "number" type and cannot be NaN
 */
export function isValidNumber(n: number): boolean {
  return typeof n === "number" && !isNaN(n);
}

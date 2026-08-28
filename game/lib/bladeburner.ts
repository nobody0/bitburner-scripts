import type { BladeburnerAction } from "../../shared/strategy/bladeburner/decide.ts";

/** The wire/strategy model uses compact action kinds; Netscript accepts only
 * these exact enum values (for example, "Contracts", not "contract"). */
const API_ACTION_TYPES = {
  general: "General",
  contract: "Contracts",
  operation: "Operations",
  blackop: "Black Operations",
} as const satisfies Record<BladeburnerAction["type"], string>;

export function bladeburnerApiActionType(type: BladeburnerAction["type"]): (typeof API_ACTION_TYPES)[typeof type] {
  return API_ACTION_TYPES[type];
}

import type { FeatureId } from "../../../shared/features/ids.ts";
import type { Claim } from "../../../shared/strategy/arbiter.ts";

/** A broker admission declaration. It shares identity and priority with
 * arbiter claims, but RAM itself is host-local and is never water-filled. */
export interface RamClaim {
  by: FeatureId;
  id: string;
  resource: "ram";
  /** Exact dynamic API price; the broker adds its executable stub. */
  amount: number;
  priority: number;
}

export type FeatureClaim = Claim | RamClaim;

export function isRamClaim(claim: FeatureClaim): claim is RamClaim {
  return claim.resource === "ram";
}

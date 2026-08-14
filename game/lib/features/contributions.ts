import type { FeatureId } from "../../../shared/features/ids.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { isRamClaim, type FeatureClaim } from "./claims.ts";

/** Persistent half of feature coordination. Collection happens outside this
 * class so a throwing callback cannot partially replace a known-good entry. */
export class ContributionCache {
  readonly needsByFeature: Partial<Record<FeatureId, Need[]>> = {};
  readonly claimsByFeature: Partial<Record<FeatureId, FeatureClaim[]>> = {};

  replaceNeeds(id: FeatureId, needs: Need[]): void {
    this.needsByFeature[id] = needs;
  }

  /** Store standing claims and return the one-pass claims to arbitrate now. */
  replaceClaims(id: FeatureId, claims: FeatureClaim[]): FeatureClaim[] {
    this.claimsByFeature[id] = claims.filter(isStandingClaim);
    return claims.filter((claim) => !isStandingClaim(claim));
  }

  remove(id: FeatureId): void {
    delete this.needsByFeature[id];
    delete this.claimsByFeature[id];
  }

  clear(): void {
    for (const id of Object.keys(this.needsByFeature) as FeatureId[]) delete this.needsByFeature[id];
    for (const id of Object.keys(this.claimsByFeature) as FeatureId[]) delete this.claimsByFeature[id];
  }

  needs(): Need[] {
    return Object.values(this.needsByFeature).flat();
  }

  claims(transient: readonly FeatureClaim[] = []): FeatureClaim[] {
    return [...Object.values(this.claimsByFeature).flat(), ...transient];
  }
}

export function isStandingClaim(claim: FeatureClaim): boolean {
  return !isRamClaim(claim) && (claim.resource === "time" || (claim.resource === "money" && claim.mode === "reserve"));
}

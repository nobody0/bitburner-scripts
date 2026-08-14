/** Why a simulation is being run. Performance route legs and synthetic
 * pressure experiments are intentionally incomparable even when they happen
 * to share the same BitNode, goal and initial numbers. */
export type ExperimentClass = "bitnode-route" | "feature-scenario";

export interface RouteLegIdentity {
  /** Stable route name. Different completion orders use different ids. */
  route: string;
  /** Stable name within that route, e.g. `bn1-first`. */
  leg: string;
  /** Zero-based order. Informational; route+leg is the durable identity. */
  index: number;
  /** BitNode this leg must enter. Checkpoint selection may change the exact
   * save, never the node whose timing this leg claims to measure. */
  bitNode: number;
}

export type EntranceIdentity =
  | { kind: "fresh"; bitNode: 1 }
  | {
      kind: "save";
      saveId: string;
      bitNode: number;
      /** SHA-256 of the exact registered save bytes. A replaced checkpoint
       * invalidates every downstream fingerprint even if its id is reused. */
      sha256: string;
    }
  | { kind: "synthetic"; bitNode: number; profile?: string };

export interface ExperimentIdentity {
  class: ExperimentClass;
  entrance: EntranceIdentity;
  route?: RouteLegIdentity;
}

/** Route legs may start at a real checkpoint, or at the one canonical state
 * that needs no checkpoint: a brand-new BN1 save. */
export function assertValidExperiment(identity: ExperimentIdentity): void {
  if (identity.class === "bitnode-route") {
    if (!identity.route) throw new Error("a bitnode-route experiment requires route-leg identity");
    if (identity.entrance.kind === "synthetic") {
      throw new Error("a bitnode-route experiment cannot use synthetic entrance state");
    }
    if (identity.entrance.bitNode !== identity.route.bitNode) {
      throw new Error(
        `route leg ${identity.route.leg} expects BN${identity.route.bitNode}, but its entrance is BN${identity.entrance.bitNode}`,
      );
    }
  } else if (identity.route) {
    throw new Error("a feature-scenario experiment cannot claim a speedrun route leg");
  }
}

import type { ScriptLaunch } from "../lib/launch-shared.ts";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";

export interface DnetOverseerLaunch extends ScriptLaunch {
  readonly kind: "dnet-overseer";
  readonly host: string;
  readonly buildId: string;
  readonly generation: string;
  readonly identity?: ArtifactIdentity;
  readonly charisma: number;
}

export interface DnetAgentLaunch extends ScriptLaunch {
  readonly kind: "dnet-agent";
  readonly host: string;
  /** Minimal local worker used while owner-blocked RAM cannot yet fit the
   * ordinary prober+resident pair. */
  readonly bootstrapReclaim?: boolean;
}

export interface DnetProberLaunch extends ScriptLaunch {
  readonly kind: "dnet-prober";
  readonly host: string;
  /** Resolve after the first host-local adjacency report is in the realm. */
  firstReport?: () => void;
}

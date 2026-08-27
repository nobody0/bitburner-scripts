import type { ScriptLaunch } from "../lib/launch-shared.ts";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import type { DnetRecoveryState } from "./wire.ts";

export interface DnetControllerLaunch extends ScriptLaunch {
  readonly kind: "dnet-controller";
  readonly host: string;
  readonly buildId: string;
  readonly generation: string;
  readonly identity?: ArtifactIdentity;
  readonly charisma: number;
  /** Last immutable controller checkpoint, cached by home for replacement.
   * Passed through the realm handoff, never
   * through visible script arguments. */
  readonly recovery?: DnetRecoveryState;
}

export interface DnetAgentLaunch extends ScriptLaunch {
  readonly kind: "dnet-agent";
  readonly host: string;
  /** Minimal local worker used while owner-blocked RAM cannot yet fit the
   * ordinary prober+resident pair. */
  readonly bootstrapReclaim?: boolean;
}

/** Controller-owned readiness barrier for one exact prober launch. Object
 * identity is the token: an old prober cannot accidentally satisfy a newer
 * launch's barrier while both are runnable in the same mutation turn. */
export interface DnetProbeRefresh {
  readonly refreshed: Promise<DnetProbeReport | undefined>;
  settle(report: DnetProbeReport | undefined): void;
}

/** The controller's hands: one parked process for the whole net whose `ns` is
 * lent for every global call. Carries nothing — the realm slot is the whole
 * handshake — but still takes a descriptor so the launch is acknowledged the
 * same way every other one is. */
export interface DnetHandsLaunch extends ScriptLaunch {
  readonly kind: "dnet-hands";
}

/** The first observation produced by one exact prober launch. Returning the
 * value through the readiness barrier keeps first-probe dataflow explicit. */
export interface DnetProbeReport {
  readonly host: string;
  readonly neighbours: readonly string[];
  readonly at: number;
  readonly pid: number;
}

export interface DnetProberLaunch extends ScriptLaunch {
  readonly kind: "dnet-prober";
  readonly host: string;
  /** The host-entry barrier this exact process must satisfy with its first
   * host-local adjacency report. */
  readonly refresh?: DnetProbeRefresh;
}

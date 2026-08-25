import type { ScriptLaunch } from "../lib/launch-shared.ts";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";

export interface DnetControllerLaunch extends ScriptLaunch {
  readonly kind: "dnet-controller";
  readonly host: string;
  readonly buildId: string;
  readonly generation: string;
  readonly identity?: ArtifactIdentity;
  readonly charisma: number;
}

export interface DnetAgentLaunch extends ScriptLaunch {
  readonly kind: "dnet-agent";
  readonly host: string;
  /** Stasis-linked agents hand recovery and successor dispatch to the
   * controller, so their process never needs the spawn surface. */
  readonly controllerManaged?: boolean;
  /** Minimal local worker used while owner-blocked RAM cannot yet fit the
   * ordinary prober+resident pair. */
  readonly bootstrapReclaim?: boolean;
  /** A LINKED ONE-OFF: claim the order the `launchSidecar` hop staged into
   * `entry.sidecarOrder`, report through the entry's sidecar slot, and exit —
   * no resident, no spawn, no successor. */
  readonly oneOff?: boolean;
}

/** Controller-owned readiness barrier for one exact prober launch. Object
 * identity is the token: an old prober cannot accidentally satisfy a newer
 * launch's barrier while both are runnable in the same mutation turn. */
export interface DnetProbeRefresh {
  readonly refreshed: Promise<DnetProbeReport | undefined>;
  settle(report: DnetProbeReport | undefined): void;
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

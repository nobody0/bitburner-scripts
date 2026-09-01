import type { ScriptLaunch } from "../lib/launch-shared.ts";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import type { DnetRecoveryState } from "./wire.ts";
import type { Order } from "./shared.ts";

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
  /** The exact one-shot job. The child never consults a second global slot. */
  readonly order?: Order;
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
  /** This launch paid the extra 2 GB for `spawn`, so it defends itself against
   * a host restart by scheduling its own successor out of `atExit`.
   *
   * It is a property of the LAUNCH rather than of the host: the size was
   * decided when the process was sized, and a process must never believe it
   * carries a call its `ramOverride` did not buy — the engine bills the union
   * of everything actually called and would kill it mid-`spawn`. */
  readonly armoured?: boolean;
}

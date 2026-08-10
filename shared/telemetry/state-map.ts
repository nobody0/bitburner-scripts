import type { Player, Server } from "@ns";
import type { Capabilities } from "../features/unlock.ts";
import type { BladeburnerState } from "./topics/bladeburner.ts";
import type { CareerState } from "./topics/career.ts";
import type { CorpState } from "./topics/corp.ts";
import type { DarknetState } from "./topics/dnet.ts";
import type { FactionsState } from "./topics/factions.ts";
import type { GangState } from "./topics/gang.ts";
import type { GoState } from "./topics/go.ts";
import type { FarmRollup, FleetRollup } from "./topics/hacking.ts";
import type { HacknetState } from "./topics/hacknet.ts";
import type { Progression } from "./topics/progression.ts";
import type { SideState } from "./topics/side.ts";
import type { SleevesState } from "./topics/sleeves.ts";
import type { StanekState } from "./topics/stanek.ts";
import type { StockState } from "./topics/stock.ts";

/** Named application-state topics. One declaration gives every consumer the
 * same types: `tel.state("servers", x)` compiles only if x matches,
 * `gameGlobal.servers` (game/lib/globals.ts) carries the same shape, and the
 * ui/sim reducers narrow records by these keys. Getter auto-mirrors
 * (`getServer:home`, ...) are separate — see Telemetry.mirror.
 *
 * Beyond the core three there is one topic per feature
 * (shared/features/registry.ts). Two rules hold for all of them:
 *  - DIGESTS, NOT DUMPS. Records are last-write-wins and rare, but a raw
 *    corporation or bladeburner object would still dominate the JSONL. Emit
 *    what the panel shows.
 *  - NO Map IN A PAYLOAD. The wire is JSON and `JSON.stringify(new Map())` is
 *    `{}`. ResetInfo.ownedSF, ownedAugs and bitNodeOptions.sourceFileOverrides
 *    are all Maps upstream; probes flatten them with Object.fromEntries.
 *    Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1486-L1500 */
export interface StateMap {
  player: Player;
  servers: Record<string, Server>;
  farm: FarmRollup;

  /** Which features this save can play. Cheap heartbeat; drives the tab bar. */
  capabilities: Capabilities;

  progression: Progression;
  fleet: FleetRollup;
  factions: FactionsState;
  career: CareerState;
  hacknet: HacknetState;
  stock: StockState;
  gang: GangState;
  corp: CorpState;
  bladeburner: BladeburnerState;
  sleeves: SleevesState;
  go: GoState;
  stanek: StanekState;
  dnet: DarknetState;
  side: SideState;
}

export type StateKey = keyof StateMap;

/** Re-exported so existing importers of FarmRollup keep working; the payload
 * types themselves live in ./topics/. */
export type { FarmRollup, FleetRollup } from "./topics/hacking.ts";

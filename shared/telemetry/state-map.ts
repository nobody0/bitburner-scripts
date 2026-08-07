import type { Player, Server } from "@ns";

/** Named application-state topics. One declaration gives every consumer the
 * same types: `tel.state("servers", x)` compiles only if x matches,
 * `gameGlobal.servers` (game/lib/globals.ts) carries the same shape, and the
 * ui/sim reducers narrow records by these keys. Getter auto-mirrors
 * (`getServer:home`, ...) are separate — see Telemetry.mirror. */
export interface StateMap {
  player: Player;
  servers: Record<string, Server>;
}

export type StateKey = keyof StateMap;

import type { Player, Server } from "@ns";

/** Named application-state topics. One declaration gives every consumer the
 * same types: `tel.state("servers", x)` compiles only if x matches,
 * `gameGlobal.servers` (game/lib/globals.ts) carries the same shape, and the
 * ui/sim reducers narrow records by these keys. Getter auto-mirrors
 * (`getServer:home`, ...) are separate — see Telemetry.mirror. */
/** 1 Hz dispatcher rollup — the ONLY steady-state farm telemetry (per-op
 * events would be ~3/16ms at scale and are never emitted; transitions get
 * their own rare events). Optional fields fill in as the dispatcher lands. */
export interface FarmRollup {
  target?: string;
  prepTarget?: string;
  segOrder?: string[];
  inFlight?: { hack: number; grow: number; weaken: number };
  launched?: { hack: number; grow: number; weaken: number };
  landed?: { hack: number; grow: number; weaken: number };
  moneyRate?: number;
  expRate?: number;
  security?: number;
  minSecurity?: number;
  money?: number;
  moneyMax?: number;
  ramPie?: { farm: number; prep: number; share: number; free: number; reserve: number };
  allocFails?: number;
  execFails?: number;
  batchesSkipped?: number;
  pumpMaxMs?: number;
  /** Cumulative — goal evaluation reads these (replaces per-op hack.done). */
  totals: { moneyEarned: number; hacks: number };
}

export interface StateMap {
  player: Player;
  servers: Record<string, Server>;
  farm: FarmRollup;
}

export type StateKey = keyof StateMap;

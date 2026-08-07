import type { Player, Server } from "@ns";
import { unknownCapabilities, type Capabilities } from "../../shared/features/unlock.ts";
import type { DebugRecord, EventRecord, LogRecord } from "../../shared/telemetry/schema.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";

/** The viewer's projection of a record stream.
 *
 * Deliberately separate from shared/goals/evaluate.ts (spec/telemetry.md): the
 * goal reducer keeps only what a predicate needs, while the UI retains raw
 * server fields, the event feed and every feature topic. Same stream, two
 * consumers with different retention. */

export type Topics = { [K in StateKey]?: StateMap[K] };

export interface ProjectedState {
  runId: string | null;
  src: "game" | "sim" | null;
  live: boolean;
  t0: number | null;
  lastT: number;
  player: Player | null;
  servers: Map<string, Server>;
  topics: Topics;
  caps: Capabilities;
  /** State records are folded into `topics`; only the discrete records reach
   *  the feed, so this is never a StateRecord. */
  events: (EventRecord | DebugRecord)[];
  /** Money earned by hacking and successful hack count. */
  earned: number;
  hacks: number;
  /** True when totals come from a `farm` rollup rather than hack.done events.
   *  When neither source is present the tiles show "–" instead of a wrong 0. */
  hasTotals: boolean;
  moneySeries: [number, number][];
}

export function emptyState(): ProjectedState {
  return {
    runId: null,
    src: null,
    live: false,
    t0: null,
    lastT: 0,
    player: null,
    servers: new Map(),
    topics: {},
    caps: unknownCapabilities(),
    events: [],
    earned: 0,
    hacks: 0,
    hasTotals: false,
    moneySeries: [],
  };
}

export interface RunMeta {
  id: string | null;
  src: "game" | "sim" | null;
  live: boolean;
  t0: number | null;
}

/** Fold the (optionally truncated) record list into one renderable state. */
export function project(records: LogRecord[], cutoff: number, meta: RunMeta): ProjectedState {
  const state = emptyState();
  state.runId = meta.id;
  state.src = meta.src;
  state.live = meta.live;
  state.t0 = meta.t0;

  let hackDoneEarned = 0;
  let hackDoneCount = 0;
  let sawHackDone = false;

  for (const record of records) {
    if (record.t > cutoff) break;
    state.lastT = record.t;

    if (record.kind === "state") {
      // The money chart must follow whichever player source the emitter uses:
      // the `getPlayer` auto-mirror (game) or the `player` topic (sim).
      if (record.key === "getPlayer" || record.key === "player") {
        state.player = record.data as Player;
        const money = (record.data as Player | undefined)?.money;
        if (typeof money === "number") state.moneySeries.push([record.t, money]);
      } else if (record.key.startsWith("getServer:")) {
        state.servers.set(record.key.slice("getServer:".length), record.data as Server);
      } else if (record.key === "servers" && record.data) {
        for (const [host, server] of Object.entries(record.data as Record<string, Server>)) {
          state.servers.set(host, server);
        }
      } else if (record.key === "capabilities") {
        state.caps = record.data as Capabilities;
      }
      // Every state key is retained as a topic, including the three above, so
      // tabs can read `topics.servers` or `topics.player` directly too.
      (state.topics as Record<string, unknown>)[record.key] = record.data;
      continue;
    }

    if (record.kind === "event" && record.name === "hack.done") {
      const data = record.data as { success?: boolean; moneyGained?: number } | undefined;
      sawHackDone = true;
      if (data?.success) {
        hackDoneEarned += data.moneyGained ?? 0;
        hackDoneCount++;
      }
    }
    state.events.push(record);
  }

  // The `farm` rollup is authoritative when present: it is cumulative and it
  // is the only totals source once per-op events are compiled out (which is
  // the steady state for both game and non-verbose sim runs).
  const farm = state.topics.farm;
  if (farm?.totals) {
    state.earned = farm.totals.moneyEarned;
    state.hacks = farm.totals.hacks;
    state.hasTotals = true;
  } else if (sawHackDone) {
    state.earned = hackDoneEarned;
    state.hacks = hackDoneCount;
    state.hasTotals = true;
  }

  return state;
}

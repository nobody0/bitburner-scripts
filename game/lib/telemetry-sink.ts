import { stateKey } from "../../shared/telemetry/schema.ts";
import type { StateKey } from "../../shared/telemetry/state-map.ts";
import type { GameState } from "./state.ts";
import type { Telemetry } from "./telemetry.ts";

/** The only place the game-state store reaches the wire.
 *
 * Everything upstream of here runs unconditionally and writes to the store; a
 * --perf build simply never constructs a sink, and esbuild drops this module
 * along with the telemetry client. That is the whole design: telemetry is an
 * extra send, never a reason to read.
 *
 * Every call site of this module sits inside `TELEMETRY: if (__TELEMETRY__)`. */

export interface TelemetrySink {
  /** Publish everything written since the last call. */
  flush(state: GameState): void;
}

export function makeSink(tel: Telemetry): TelemetrySink {
  // Report-once bookkeeping. The store holds the current facts; the sink holds
  // what it has already said about them, so a permanently unaffordable probe
  // reports once per PRICE and a permanently failing one once per MESSAGE,
  // rather than crowding everything else out of the event feed every sweep.
  const sentSkips = new Map<string, number>();
  const sentFailures = new Map<string, string>();
  let sentBatch: string | undefined;

  return {
    flush(state: GameState): void {
      for (const key of state.dirty) {
        const value = state.topics[key];
        if (value === undefined) continue;
        tel.state(key, value as never);
        // Compat alias: shared/goals/evaluate.ts reduces the getter-mirror key
        // space, and ui/app/project.ts charts money from either. Emitting both
        // keeps goals, sim replays and the UI working off one acquisition.
        if (key === "player") tel.mirror(stateKey("getPlayer"), value);
      }
      state.dirty.clear();

      for (const key of state.mirrorDirty) {
        tel.mirror(key, state.mirrors[key]);
      }
      state.mirrorDirty.clear();

      for (const [id, skip] of Object.entries(state.probeSkips)) {
        if (sentSkips.get(id) === skip.cost) continue;
        sentSkips.set(id, skip.cost);
        tel.event("probe.skipped", { id, cost: skip.cost, budget: skip.budget });
      }
      for (const id of sentSkips.keys()) {
        if (state.probeSkips[id] === undefined) sentSkips.delete(id);
      }

      for (const [id, error] of Object.entries(state.probeFailures)) {
        if (sentFailures.get(id) === error) continue;
        sentFailures.set(id, error);
        tel.event("probe.failed", { id, error });
      }
      for (const id of sentFailures.keys()) {
        if (state.probeFailures[id] === undefined) sentFailures.delete(id);
      }

      // In steady state the same handful of probes runs every sweep forever;
      // repeating that trace would be pure noise.
      const batch = state.probeBatch;
      if (batch) {
        const signature = batch.ids.join(",");
        if (signature !== sentBatch) {
          sentBatch = signature;
          tel.debug("probe.batch", { ids: batch.ids, cost: batch.cost, budget: batch.budget });
        }
      }
    },
  };
}

/** Mark every known topic for republication — used after a BitNode reset, when
 * the store has been rebuilt from scratch and the UI is still showing the
 * previous node's world. */
export function republish(state: GameState): void {
  for (const key of Object.keys(state.topics) as StateKey[]) state.dirty.add(key);
}

import type { NS } from "@ns";
import { TELEMETRY_PORT, WIRE_VERSION, type LogRecord } from "../../shared/telemetry/schema.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";
import { shortIdentity, type ArtifactIdentity } from "../../shared/run-identity.ts";

/** In-game telemetry client. Streams LogRecords to the ui/ process over a bare
 * `new WebSocket()` (browser global — 0 GB ns RAM).
 * Source (only `window`/`document` trigger DOM RAM): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Script/RamCalculations.ts#L180-L193
 *
 * Every record is serialized ONCE, at push time: no second stringify at
 * flush, and the buffer holds strings rather than references into live game
 * state — so a buffered snapshot can never observe a later mutation, and
 * memory while the hub is down is bounded in bytes, the unit that actually
 * costs something.
 *
 * The sink publishes the game-state store; controller lifecycle events use
 * the same client. Acquisition runs in every build, and every reference to
 * this module sits behind
 * `TELEMETRY: if (__TELEMETRY__)` so --perf builds eliminate it entirely
 * (see game/flags.d.ts). */

const MAX_BUFFER_BYTES = 4_000_000;
const FLUSH_AT = 100;
const FLUSH_MS = 500;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface RecordBuffer {
  /** Append one serialized record. May evict older entries to stay bounded. */
  push(line: string, debug: boolean): void;
  count(): number;
  bytes(): number;
  /** Evictions since the last takeDropped(); reading resets the counter. */
  takeDropped(): number;
  /** All buffered lines joined with "," (a JSON array body), oldest first;
   * empties the buffer. */
  drain(): string;
  clear(): void;
}

/** Byte-bounded FIFO of pre-serialized records.
 *
 * Eviction drops the oldest debug records first, then the oldest of anything —
 * amortized: one O(n) pass frees a quarter of the budget instead of shifting
 * the remaining records on every push while the hub is unavailable. */
export function makeRecordBuffer(maxBytes = MAX_BUFFER_BYTES): RecordBuffer {
  let entries: { line: string; debug: boolean }[] = [];
  let bytes = 0;
  let dropped = 0;

  function evict(): void {
    const target = (maxBytes * 3) / 4;
    const drop = new Set<number>();
    for (let pass = 0; pass < 2 && bytes > target; pass++) {
      for (let i = 0; i < entries.length && bytes > target; i++) {
        if (drop.has(i)) continue;
        if (pass === 0 && !entries[i]!.debug) continue;
        drop.add(i);
        bytes -= entries[i]!.line.length;
      }
    }
    entries = entries.filter((_, i) => !drop.has(i));
    dropped += drop.size;
  }

  return {
    push(line, debug) {
      entries.push({ line, debug });
      bytes += line.length;
      if (bytes > maxBytes) evict();
    },
    count: () => entries.length,
    bytes: () => bytes,
    takeDropped() {
      const count = dropped;
      dropped = 0;
      return count;
    },
    drain() {
      let joined = "";
      for (let i = 0; i < entries.length; i++) joined += (i === 0 ? "" : ",") + entries[i]!.line;
      entries = [];
      bytes = 0;
      return joined;
    },
    clear() {
      entries = [];
      bytes = 0;
      dropped = 0;
    },
  };
}

export interface Telemetry {
  /** Typed app-state topic (shared/telemetry/state-map.ts): the payload type
   * is checked against StateMap[key] at compile time. */
  state<K extends StateKey>(key: K, data: StateMap[K]): void;
  /** Untyped getter auto-mirror (`getServer:home`, ...), where the key is
   * derived from the ns call itself rather than from StateMap. */
  mirror(key: string, data: unknown): void;
  event(name: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
  flush(): void;
  dispose(): void;
}

export function initTelemetry(ns: NS, script: string, identity: ArtifactIdentity): Telemetry {
  // Derived from the identity this run already holds, never from Math.random.
  // The simulator replaces Math.random with the run's SEEDED stream
  // (sim/realm/timers.ts), so one draw here shifted every later random number
  // in the process: a telemetry build and a --perf build played measurably
  // different games from the same seed, which is exactly what the "--perf must
  // be behaviourally identical, only quieter" rule forbids. `install.id`
  // already encodes lineage, BitNode and start epoch, so this is at least as
  // unique and is reproducible.
  //
  // The SCRIPT is part of it because the install id is not: main.js and the
  // darknet controller are two emitters of the SAME install, so without it the
  // only thing separating their run ids is the millisecond they happened to
  // start in -- and under the simulator's virtual clock, which only advances on
  // a sleep, that is routinely the same instant. `RunStore.append` dedupes by
  // `(run, seq)` and both emitters count from 0, so a collision does not merge
  // the streams, it silently DISCARDS most of both.
  const emitter = script.replaceAll(/[^a-z0-9]/gi, "") || "script";
  const run = `${Date.now().toString(36)}-${shortIdentity(identity.install.id)}-${emitter}`;
  const startedAt = Date.now();
  const buffer = makeRecordBuffer();
  let seq = 0;
  let ws: WebSocket | undefined;
  let backoff = BACKOFF_MIN_MS;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function connect(): void {
    if (disposed) return;
    const socket = new WebSocket(`ws://127.0.0.1:${TELEMETRY_PORT}/ingest`);
    ws = socket;
    socket.onopen = () => {
      // Opening is asynchronous. Teardown or a newer reconnect may have
      // replaced this socket before the callback runs.
      if (disposed || ws !== socket) {
        socket.close();
        return;
      }
      backoff = BACKOFF_MIN_MS;
      socket.send(JSON.stringify({ v: WIRE_VERSION, hello: { run, src: "game", script, startedAt, identity } }));
      flush();
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = undefined;
      if (disposed) return;
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
    socket.onerror = () => socket.close();
  }

  function push(record: LogRecord, debug = false): void {
    buffer.push(JSON.stringify(record), debug);
    if (buffer.count() >= FLUSH_AT) flush();
  }

  function flushTo(socket: WebSocket): void {
    const dropped = buffer.takeDropped();
    if (dropped > 0) {
      buffer.push(
        JSON.stringify({ seq: seq++, t: Date.now(), run, src: "game", kind: "event", name: "telemetry.dropped", data: { count: dropped } }),
        false,
      );
    }
    if (buffer.count() === 0) return;
    // The frame is assembled from the already-serialized lines; it must parse
    // as a WireMessage exactly as JSON.stringify of one would (pinned by
    // tests/telemetry-client.test.ts).
    socket.send(`{"v":${WIRE_VERSION},"records":[${buffer.drain()}]}`);
  }

  function flush(): void {
    const socket = ws;
    if (disposed || socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    flushTo(socket);
  }

  const flushTimer = setInterval(flush, FLUSH_MS);
  connect();

  // One object literal per record: no intermediate base() + spread copy on
  // what is the hottest telemetry-build path on the game's main thread.
  const telemetry: Telemetry = {
    state: (key, data) => push({ seq: seq++, t: Date.now(), run, src: "game", kind: "state", key, data }),
    mirror: (key, data) => push({ seq: seq++, t: Date.now(), run, src: "game", kind: "state", key, data }),
    event: (name, data) => push({ seq: seq++, t: Date.now(), run, src: "game", kind: "event", name, data }),
    debug: (msg, data) => push({ seq: seq++, t: Date.now(), run, src: "game", kind: "debug", msg, data }, true),
    flush,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(flushTimer);
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      // Detach ownership before any WebSocket callback can run. In particular,
      // close() may synchronously deliver onclose in tests and a queued onopen
      // may arrive after teardown in the browser.
      const socket = ws;
      ws = undefined;
      try {
        if (socket?.readyState === WebSocket.OPEN) flushTo(socket);
      } catch {
        // Telemetry is best-effort, including during script teardown.
      } finally {
        buffer.clear();
        socket?.close();
      }
    },
  };

  ns.atExit(() => telemetry.dispose(), "telemetry");
  return telemetry;
}

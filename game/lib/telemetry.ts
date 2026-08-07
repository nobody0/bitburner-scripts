import type { NS } from "@ns";
import {
  TELEMETRY_PORT,
  WIRE_VERSION,
  type LogRecord,
  type WireMessage,
} from "../../shared/telemetry/schema.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";

/** In-game telemetry client. Streams LogRecords to the ui/ process over a bare
 * `new WebSocket()` (browser global — 0 GB ns RAM).
 *
 * Its only caller is ./telemetry-sink.ts, which publishes the game-state
 * store. Nothing else in game/ may reference it: acquisition runs in every
 * build, and every reference to this module sits behind
 * `TELEMETRY: if (__TELEMETRY__)` so --perf builds eliminate it entirely
 * (see game/flags.d.ts). */

const MAX_BUFFER = 5_000;
const FLUSH_AT = 100;
const FLUSH_MS = 500;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

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

export function initTelemetry(ns: NS, script: string): Telemetry {
  const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const buffer: LogRecord[] = [];
  let seq = 0;
  let dropped = 0;
  let ws: WebSocket | undefined;
  let backoff = BACKOFF_MIN_MS;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function send(message: WireMessage): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  function connect(): void {
    if (disposed) return;
    ws = new WebSocket(`ws://127.0.0.1:${TELEMETRY_PORT}/ingest`);
    ws.onopen = () => {
      backoff = BACKOFF_MIN_MS;
      send({ v: WIRE_VERSION, hello: { run, src: "game", script, startedAt } });
      flush();
    };
    ws.onclose = () => {
      ws = undefined;
      if (disposed) return;
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
    ws.onerror = () => ws?.close();
  }

  function push(record: LogRecord): void {
    if (buffer.length >= MAX_BUFFER) {
      const debugIndex = buffer.findIndex((r) => r.kind === "debug");
      buffer.splice(debugIndex === -1 ? 0 : debugIndex, 1);
      dropped++;
    }
    buffer.push(record);
    if (buffer.length >= FLUSH_AT) flush();
  }

  function base() {
    return { seq: seq++, t: Date.now(), run, src: "game" as const };
  }

  function flush(): void {
    if (buffer.length === 0 && dropped === 0) return;
    if (dropped > 0) {
      buffer.push({ ...base(), kind: "event", name: "telemetry.dropped", data: { count: dropped } });
      dropped = 0;
    }
    if (send({ v: WIRE_VERSION, records: buffer })) buffer.length = 0;
  }

  const flushTimer = setInterval(flush, FLUSH_MS);
  connect();

  const telemetry: Telemetry = {
    state: (key, data) => push({ ...base(), kind: "state", key, data }),
    mirror: (key, data) => push({ ...base(), kind: "state", key, data }),
    event: (name, data) => push({ ...base(), kind: "event", name, data }),
    debug: (msg, data) => push({ ...base(), kind: "debug", msg, data }),
    flush,
    dispose: () => {
      flush();
      disposed = true;
      clearInterval(flushTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };

  ns.atExit(() => telemetry.dispose(), "telemetry");
  return telemetry;
}

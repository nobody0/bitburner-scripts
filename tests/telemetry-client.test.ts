import { afterEach, describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { initTelemetry, makeRecordBuffer } from "../game/lib/telemetry.ts";
import type { ArtifactIdentity } from "../shared/run-identity.ts";

const originalWebSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
});

describe("makeRecordBuffer", () => {
  const line = (id: number, pad: number) => JSON.stringify({ id, pad: "x".repeat(pad) });

  test("stays under its byte bound and counts evictions", () => {
    const buffer = makeRecordBuffer(10_000);
    for (let i = 0; i < 100; i++) buffer.push(line(i, 200), false);
    expect(buffer.bytes()).toBeLessThanOrEqual(10_000);
    const dropped = buffer.takeDropped();
    expect(dropped).toBeGreaterThan(0);
    expect(dropped + buffer.count()).toBe(100);
    expect(buffer.takeDropped()).toBe(0);
  });

  test("evicts oldest debug records before anything else", () => {
    // Sized so exactly one eviction fires, after all 20 pushes: the pass must
    // free 25% of the budget from the 10 debug lines alone, keeping every
    // discrete record. (Two-digit ids keep every line the same length.)
    const bytes = line(10, 200).length;
    const buffer = makeRecordBuffer(19 * bytes);
    for (let i = 0; i < 10; i++) buffer.push(line(10 + i, 200), true);
    for (let i = 0; i < 10; i++) buffer.push(line(50 + i, 200), false);
    const kept = (JSON.parse(`[${buffer.drain()}]`) as { id: number }[]).map((entry) => entry.id);
    expect(buffer.takeDropped()).toBe(20 - kept.length);
    for (let i = 0; i < 10; i++) expect(kept).toContain(50 + i);
    expect(kept.length).toBeLessThan(20);
  });

  test("falls back to evicting the oldest of anything once debug is gone", () => {
    const buffer = makeRecordBuffer(2_000);
    for (let i = 0; i < 50; i++) buffer.push(line(i, 200), false);
    const kept = (JSON.parse(`[${buffer.drain()}]`) as { id: number }[]).map((entry) => entry.id);
    expect(kept.length).toBeGreaterThan(0);
    // FIFO under pressure: whatever survived is the newest contiguous run.
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => 50 - kept.length + i));
  });

  test("drain joins the lines into a JSON array body and resets the buffer", () => {
    const buffer = makeRecordBuffer(1_000);
    buffer.push(line(1, 10), false);
    buffer.push(line(2, 10), true);
    expect(buffer.drain()).toBe(`${line(1, 10)},${line(2, 10)}`);
    expect(buffer.count()).toBe(0);
    expect(buffer.bytes()).toBe(0);
  });
});

describe("telemetry socket teardown", () => {
  test("a late open cannot send, reconnect, or retake ownership after disposal", () => {
    const reconnects: (() => void)[] = [];
    class ControlledSocket {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: ControlledSocket[] = [];
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      readonly sent: string[] = [];
      closes = 0;

      constructor(_url: string) {
        ControlledSocket.instances.push(this);
      }

      send(data: string): void {
        this.sent.push(data);
      }

      close(): void {
        this.closes++;
        this.readyState = ControlledSocket.CLOSED;
        this.onclose?.({} as CloseEvent);
      }

      deliverLateOpen(): void {
        this.readyState = ControlledSocket.OPEN;
        this.onopen?.({} as Event);
      }
    }

    globalThis.WebSocket = ControlledSocket as unknown as typeof WebSocket;
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler === "function") reconnects.push(handler as () => void);
      return 1;
    }) as typeof setTimeout;
    const exits: (() => void)[] = [];
    const ns = { atExit: (callback: () => void) => { exits.push(callback); } } as unknown as NS;
    const identity: ArtifactIdentity = {
      lineage: { id: "lineage", kind: "game", label: "test", createdAt: 1 },
      install: { id: "install", startedAt: 1 },
    };

    const telemetry = initTelemetry(ns, "test.js", identity);
    const socket = ControlledSocket.instances[0]!;
    telemetry.event("buffered");
    telemetry.dispose();
    socket.deliverLateOpen();
    telemetry.dispose();
    exits[0]!();

    expect(socket.sent).toEqual([]);
    expect(reconnects).toEqual([]);
    expect(ControlledSocket.instances).toHaveLength(1);
    // The first close tears down the connecting socket; the late open is
    // rejected and closes that stale transport again. Repeated disposal is a
    // no-op.
    expect(socket.closes).toBe(2);
  });
});

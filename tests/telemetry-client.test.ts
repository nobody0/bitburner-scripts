import { describe, expect, test } from "bun:test";
import { makeRecordBuffer } from "../game/lib/telemetry.ts";
import { WIRE_VERSION, type WireMessage } from "../shared/telemetry/schema.ts";

test("a hand-assembled frame parses as the same WireMessage JSON.stringify produces", () => {
  const records = [
    { seq: 0, t: 1, run: "r", src: "game", kind: "event", name: "start.boot" },
    { seq: 1, t: 2, run: "r", src: "game", kind: "state", key: "player", data: { hp: 9 } },
  ];
  const lines = records.map((record) => JSON.stringify(record));
  const frame = `{"v":${WIRE_VERSION},"records":[${lines.join(",")}]}`;
  const reference: WireMessage = { v: WIRE_VERSION, records: records as never };
  expect(JSON.parse(frame)).toEqual(JSON.parse(JSON.stringify(reference)));
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

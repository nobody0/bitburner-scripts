import { expect, test } from "bun:test";
import { waitForRfaConnection } from "../tools/rfa-connect.ts";
import { RfaSession, type JsonSocket } from "../tools/rfa-session.ts";

class FakeSocket implements JsonSocket {
  sent: unknown[] = [];
  listeners = new Map<string, (data?: unknown) => void>();

  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string; params: unknown };
    this.sent.push(request);
    queueMicrotask(() => this.listeners.get("message")?.(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "OK" })));
  }

  on(event: "message" | "close", listener: (data?: unknown) => void): void {
    this.listeners.set(event, listener);
  }
}

test("pushFile sends the Bitburner JSON-RPC shape", async () => {
  const socket = new FakeSocket();
  const session = new RfaSession(socket);
  await session.pushFile("home", "start.js", "export async function main() {}\n");

  expect(socket.sent).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "pushFile",
      params: { server: "home", filename: "start.js", content: "export async function main() {}\n" },
    },
  ]);
});

/** The Remote File API port is an unauthenticated localhost listener the hub
 * holds for its whole lifetime, and a throw out of this handler escapes into the
 * ws emitter and exits the process — taking the buffered tail and held spans of
 * every live telemetry run with it. `null` parses fine and then throws on `.id`,
 * so the whole handler is guarded, not just the parse. */
test("a frame that is not JSON-RPC is ignored, not thrown", () => {
  const socket = new FakeSocket();
  new RfaSession(socket);
  const deliver = (frame: string): void => socket.listeners.get("message")!(frame);
  expect(() => deliver("hello not json")).not.toThrow();
  expect(() => deliver("null")).not.toThrow();
  expect(() => deliver("42")).not.toThrow();
  expect(() => deliver('{"jsonrpc":"2.0"}')).not.toThrow();
});

test("an unanswered Remote API listener times out instead of becoming stale", async () => {
  await expect(waitForRfaConnection({ host: "127.0.0.1", port: 0 }, 20)).rejects.toThrow("timed out after 20ms");
});

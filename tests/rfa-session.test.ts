import { expect, test } from "bun:test";
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

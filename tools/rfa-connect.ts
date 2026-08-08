import { WebSocketServer, type WebSocket } from "ws";
import type { BitburnerConfig } from "./config.ts";
import { RfaSession } from "./rfa-session.ts";

export const RFA_CONNECTION_TIMEOUT_MS = 30_000;

export interface RfaConnection {
  session: RfaSession;
  close(): void;
}

/** Listen for exactly one Bitburner Remote API connection. The bounded wait is
 * important for dashboard-launched syncs: closing the UI must not leave an
 * orphaned child listening forever. */
export function waitForRfaConnection(
  config: Pick<BitburnerConfig, "host" | "port">,
  timeoutMs = RFA_CONNECTION_TIMEOUT_MS,
): Promise<RfaConnection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let server: WebSocketServer;
    try {
      server = new WebSocketServer({ host: config.host, port: config.port });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`timed out after ${timeoutMs}ms waiting for Bitburner at ws://${config.host}:${config.port}`)),
      timeoutMs,
    );

    server.once("error", fail);
    server.once("connection", (socket: WebSocket) => {
      if (settled) {
        socket.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close();
      const session = new RfaSession(socket);
      resolve({
        session,
        close() {
          session.dispose();
          socket.close();
        },
      });
    });
  });
}

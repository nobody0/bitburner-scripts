export interface JsonSocket {
  send(data: string): void;
  on(event: "message" | "close", listener: (data?: unknown) => void): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RfaResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export class RfaSession {
  readonly #socket: JsonSocket;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;

  constructor(socket: JsonSocket) {
    this.#socket = socket;
    socket.on("message", (data) => this.#handleMessage(data));
    socket.on("close", () => this.dispose(new Error("Bitburner disconnected")));
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Remote File API request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async pushFile(server: string, filename: string, content: string): Promise<void> {
    const result = await this.request("pushFile", { server, filename, content });
    if (result !== "OK") throw new Error(`Unexpected pushFile result for ${filename}: ${String(result)}`);
  }

  dispose(reason = new Error("Remote File API session closed")): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #handleMessage(data: unknown): void {
    const text =
      typeof data === "string" ? data : data instanceof Uint8Array ? Buffer.from(data).toString("utf8") : String(data);
    const message = JSON.parse(text) as RfaResponse;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }
}


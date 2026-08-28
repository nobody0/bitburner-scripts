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

  /** Scripts and text files only: the game answers this from `server.scripts`
   * and `server.textFiles`, so .msg/.lit/.exe/.cct are not even enumerable. */
  async getFileNames(server: string): Promise<string[]> {
    const result = await this.request("getFileNames", { server });
    if (!Array.isArray(result) || result.some((name) => typeof name !== "string")) {
      throw new Error(`Unexpected getFileNames result for ${server}: ${String(result)}`);
    }
    return result as string[];
  }

  /** Undefined when the file does not exist. */
  async getFile(server: string, filename: string): Promise<string | undefined> {
    const result = await this.request("getFile", { server, filename }).catch(() => undefined);
    return typeof result === "string" ? result : undefined;
  }

  /** False on refusal or transport failure; strict sync turns that into a
   * failed transaction and leaves the wrapper parked. */
  async deleteFile(server: string, filename: string): Promise<boolean> {
    const result = await this.request("deleteFile", { server, filename }).catch(() => undefined);
    return result === "OK";
  }

  async getAllServers(): Promise<{ hostname: string; hasAdminRights: boolean; purchasedByPlayer: boolean }[]> {
    const result = await this.request("getAllServers");
    if (!Array.isArray(result)) throw new Error(`Unexpected getAllServers result: ${String(result)}`);
    return result as { hostname: string; hasAdminRights: boolean; purchasedByPlayer: boolean }[];
  }

  dispose(reason = new Error("Remote File API session closed")): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #handleMessage(data: unknown): void {
    // A frame that is not JSON-RPC is a warning, never a fatality. The hub owns
    // the Remote File API port for its whole lifetime and it is an
    // unauthenticated localhost listener, so anything on the machine can put a
    // frame here — and a throw out of this ws 'message' listener escapes into
    // the emitter, exits the process, and takes the buffered tail and held spans
    // of every live telemetry run with it. A stranger's frame does not get to
    // decide the hub's lifetime. The whole body is guarded rather than the parse
    // alone: `JSON.parse("null")` succeeds and reading `.id` off it throws next.
    try {
      const text =
        typeof data === "string" ? data : data instanceof Uint8Array ? Buffer.from(data).toString("utf8") : String(data);
      const message = JSON.parse(text) as RfaResponse;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    } catch (error) {
      console.warn(`ignoring unusable Remote File API frame: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}


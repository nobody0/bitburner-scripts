import type { GoProposalRaw, GoValueBackend, GoValueBatch } from "../../shared/strategy/go/neural/backend.ts";

interface BackendResponse { error?: string; value?: number[]; moves?: number[] }

export class PythonV9Backend implements GoValueBackend {
  readonly extent: number;
  readonly behaviorFeatures: number;
  readonly inputChannels: 8 | 16;
  readonly #process: Bun.Subprocess<"pipe", "pipe", "inherit">;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  /** Copies of proposal outputs, retained so corpus generation can record the
   * exact production shortlist without changing the shared selector API. */
  readonly proposals: GoProposalRaw[] = [];
  #buffer = "";

  private constructor(
    process: Bun.Subprocess<"pipe", "pipe", "inherit">,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    extent: number,
    behaviorFeatures: number,
    inputChannels: 8 | 16,
  ) {
    this.#process = process;
    this.extent = extent;
    this.behaviorFeatures = behaviorFeatures;
    this.inputChannels = inputChannels;
    this.#reader = reader;
  }

  static async create(
    model: string,
    device = "mps",
    python = "go-ai/.venv-gpu/bin/python",
  ): Promise<PythonV9Backend> {
    const process = Bun.spawn([
      python, "-u", "go-ai/gpu/serve_v9_backend.py",
      "--model", model, "--device", device,
    ], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const reader = (process.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    if (first.done) throw new Error(`Python V9 backend exited (${await process.exited})`);
    const ready = JSON.parse(new TextDecoder().decode(first.value).trim()) as {
      ready?: boolean; extent?: number; behaviorFeatures?: number; inputChannels?: number;
    };
    if (!ready.ready || !ready.extent || !ready.behaviorFeatures
      || (ready.inputChannels !== 8 && ready.inputChannels !== 16)) {
      throw new Error("Python V9 backend did not start");
    }
    return new PythonV9Backend(
      process, reader, ready.extent, ready.behaviorFeatures, ready.inputChannels);
  }

  async #line(): Promise<Record<string, unknown>> {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return JSON.parse(line) as Record<string, unknown>;
      }
      const chunk = await this.#reader.read();
      if (chunk.done) throw new Error(`Python V9 backend exited (${await this.#process.exited})`);
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  async #request(kind: "proposal" | "value", batch: GoValueBatch): Promise<BackendResponse> {
    const request = JSON.stringify({
      kind, count: batch.count, packed: Array.from(batch.packed.slice(0, Math.ceil(this.extent ** 2 / 16) * batch.count)),
      legal: Array.from(batch.legal), state: Array.from(batch.state), behavior: Array.from(batch.behavior),
      tactical: batch.tactical ? Array.from(batch.tactical) : undefined,
    });
    this.#process.stdin.write(`${request}\n`);
    this.#process.stdin.flush();
    const response = await this.#line() as BackendResponse;
    if (response.error) throw new Error(response.error);
    return response;
  }

  async evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    const response = await this.#request("value", batch);
    if (!response.value) throw new Error("Python V9 value response missing values");
    return Float32Array.from(response.value);
  }

  async evaluateProposal(batch: GoValueBatch): Promise<GoProposalRaw> {
    const response = await this.#request("proposal", batch);
    if (!response.value || !response.moves) throw new Error("Python V9 proposal response incomplete");
    const result = { value: Float32Array.from(response.value), moves: Float32Array.from(response.moves) };
    this.proposals.push({ value: new Float32Array(result.value), moves: new Float32Array(result.moves) });
    return result;
  }

  dispose(): void {
    try { this.#process.stdin.write('{"kind":"close"}\n'); } catch { /* already closed */ }
    try { this.#process.stdin.end(); } catch { /* already closed */ }
  }
}

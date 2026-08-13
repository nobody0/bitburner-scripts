/** WebGPU implementation of the v7 forward pass.
 *
 * One workgroup evaluates one result board: unpack the 2-bit cells into
 * workgroup memory, compute the shared 3x3 convolution pooled straight into
 * its 5x5 bins, then the dense tanh layer (one hidden unit per thread) and
 * the selected 3-value head. Weights live in one storage buffer uploaded at
 * creation, so per-turn main-thread work is packing a ~KB batch, one
 * writeBuffer, and command encoding; the arithmetic and the readback wait
 * happen off-thread behind mapAsync.
 *
 * Types are declared locally and structurally: the game's Chromium provides
 * `navigator.gpu` at runtime, and the deploy toolchain should not depend on
 * browser typings. The RAM analyzer also never sees a `window`/`document`
 * token this way.
 */
import {
  GO_SPATIAL_CHANNELS,
  GO_SPATIAL_POOL_EXTENT,
  GO_VALUE_OUTPUTS,
  type GoValueWeights,
} from "./artifact.ts";
import { goBoardWords, type GoValueBackend, type GoValueBatch } from "./backend.ts";

interface GpuBufferLike {
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GpuQueueLike {
  writeBuffer(buffer: GpuBufferLike, offset: number, data: ArrayBufferView, dataOffset?: number, size?: number): void;
  submit(commandBuffers: unknown[]): void;
}

interface GpuComputePassLike {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

interface GpuCommandEncoderLike {
  beginComputePass(): GpuComputePassLike;
  copyBufferToBuffer(source: GpuBufferLike, sourceOffset: number, target: GpuBufferLike, targetOffset: number, size: number): void;
  finish(): unknown;
}

interface GpuDeviceLike {
  readonly lost: Promise<unknown>;
  readonly queue: GpuQueueLike;
  createBuffer(descriptor: { size: number; usage: number }): GpuBufferLike;
  createShaderModule(descriptor: { code: string }): unknown;
  createComputePipeline(descriptor: {
    layout: "auto";
    compute: { module: unknown; entryPoint: string };
  }): { getBindGroupLayout(index: number): unknown };
  createBindGroup(descriptor: {
    layout: unknown;
    entries: { binding: number; resource: { buffer: GpuBufferLike } }[];
  }): unknown;
  createCommandEncoder(): GpuCommandEncoderLike;
  destroy(): void;
}

interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>;
}

interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_STORAGE = 0x0080;
const BUFFER_UNIFORM = 0x0040;
const MAP_MODE_READ = 0x0001;

function webGpuApi(): GpuLike | undefined {
  return (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu;
}

function shaderSource(weights: GoValueWeights): string {
  const extent = weights.extent;
  const area = extent * extent;
  const words = goBoardWords(extent);
  const bins = GO_SPATIAL_POOL_EXTENT * GO_SPATIAL_POOL_EXTENT;
  const pooled = GO_SPATIAL_CHANNELS * bins;
  const convOffset = 0;
  const convBiasOffset = convOffset + weights.conv.length;
  const w1Offset = convBiasOffset + weights.convBias.length;
  const b1Offset = w1Offset + weights.w1.length;
  const w2Offset = b1Offset + weights.b1.length;
  const b2Offset = w2Offset + weights.w2.length;
  return `
const EXTENT: u32 = ${extent}u;
const AREA: u32 = ${area}u;
const WORDS_PER_BOARD: u32 = ${words}u;
const POOL_EXTENT: u32 = ${GO_SPATIAL_POOL_EXTENT}u;
const POOL_BINS: u32 = ${bins}u;
const CHANNELS: u32 = ${GO_SPATIAL_CHANNELS}u;
const POOLED: u32 = ${pooled}u;
const HIDDEN: u32 = ${weights.hidden}u;
const DENSE_INPUT: u32 = ${weights.denseInputSize}u;
const OPPONENT_FEATURES: u32 = ${weights.opponentFeatures}u;
const OUTPUTS: u32 = ${GO_VALUE_OUTPUTS}u;
const CONV_OFFSET: u32 = ${convOffset}u;
const CONV_BIAS_OFFSET: u32 = ${convBiasOffset}u;
const W1_OFFSET: u32 = ${w1Offset}u;
const B1_OFFSET: u32 = ${b1Offset}u;
const W2_OFFSET: u32 = ${w2Offset}u;
const B2_OFFSET: u32 = ${b2Offset}u;

struct Params { opponentIndex: u32, boardCount: u32 }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> weights: array<f32>;
@group(0) @binding(2) var<storage, read> boards: array<u32>;
@group(0) @binding(3) var<storage, read_write> results: array<f32>;

var<workgroup> cells: array<u32, AREA>;
var<workgroup> dense: array<f32, DENSE_INPUT>;
var<workgroup> hidden: array<f32, HIDDEN>;

// Cells within a pool bin form a rectangle: bin b covers coordinates v with
// floor(v * POOL_EXTENT / EXTENT) == b, i.e. v in [ceil(b*E/P), ceil((b+1)*E/P)).
fn binStart(bin: u32) -> u32 {
  return (bin * EXTENT + POOL_EXTENT - 1u) / POOL_EXTENT;
}

fn convolve(channel: u32, x: u32, y: u32) -> f32 {
  var value = weights[CONV_BIAS_OFFSET + channel];
  for (var dx = -1i; dx <= 1i; dx++) {
    let nx = i32(x) + dx;
    if (nx < 0i || nx >= i32(EXTENT)) { continue; }
    for (var dy = -1i; dy <= 1i; dy++) {
      let ny = i32(y) + dy;
      if (ny < 0i || ny >= i32(EXTENT)) { continue; }
      let code = cells[u32(nx) * EXTENT + u32(ny)];
      if (code == 0u) { continue; }
      // Codes 1/2/3 are the X/O/offline one-hot planes in trainer order.
      let plane = code - 1u;
      value += weights[CONV_OFFSET
        + ((channel * 3u + plane) * 3u + u32(dx + 1i)) * 3u + u32(dy + 1i)];
    }
  }
  return value;
}

@compute @workgroup_size(HIDDEN)
fn evaluate(
  @builtin(workgroup_id) group_id: vec3<u32>,
  @builtin(local_invocation_index) lane: u32,
) {
  let board = group_id.x;
  let wordBase = board * WORDS_PER_BOARD;
  for (var index = lane; index < AREA; index += HIDDEN) {
    cells[index] = (boards[wordBase + (index >> 4u)] >> ((index & 15u) * 2u)) & 3u;
  }
  workgroupBarrier();

  for (var task = lane; task < DENSE_INPUT; task += HIDDEN) {
    if (task < POOLED) {
      let channel = task / POOL_BINS;
      let bin = task % POOL_BINS;
      let x0 = binStart(bin / POOL_EXTENT);
      let x1 = binStart(bin / POOL_EXTENT + 1u);
      let y0 = binStart(bin % POOL_EXTENT);
      let y1 = binStart(bin % POOL_EXTENT + 1u);
      var sum = 0.0;
      for (var x = x0; x < x1; x++) {
        for (var y = y0; y < y1; y++) {
          sum += tanh(convolve(channel, x, y));
        }
      }
      dense[task] = sum / f32((x1 - x0) * (y1 - y0));
    } else {
      dense[task] = select(0.0, 1.0, task - POOLED == params.opponentIndex);
    }
  }
  workgroupBarrier();

  let row = lane * DENSE_INPUT;
  var accumulator = weights[B1_OFFSET + lane];
  for (var index = 0u; index < DENSE_INPUT; index++) {
    accumulator += weights[W1_OFFSET + row + index] * dense[index];
  }
  hidden[lane] = tanh(accumulator);
  workgroupBarrier();

  if (lane < OUTPUTS && board < params.boardCount) {
    var head = 0u;
    if (OPPONENT_FEATURES > 0u) { head = params.opponentIndex; }
    var value = weights[B2_OFFSET + head * OUTPUTS + lane];
    let outputRow = (head * OUTPUTS + lane) * HIDDEN;
    for (var index = 0u; index < HIDDEN; index++) {
      value += weights[W2_OFFSET + outputRow + index] * hidden[index];
    }
    results[board * OUTPUTS + lane] = value;
  }
}
`;
}

const INITIAL_BOARD_CAPACITY = 512;

export class WebGpuGoValueBackend implements GoValueBackend {
  readonly extent: number;

  #device: GpuDeviceLike;
  #pipeline: { getBindGroupLayout(index: number): unknown };
  #weightsBuffer: GpuBufferLike;
  #uniformBuffer: GpuBufferLike;
  #boardsBuffer: GpuBufferLike;
  #resultsBuffer: GpuBufferLike;
  #stagingBuffer: GpuBufferLike;
  #bindGroup: unknown;
  #boardCapacity: number;
  #uniform = new Uint32Array(2);
  #raw = new Float32Array(0);
  #queue: Promise<unknown> = Promise.resolve();
  #lost = false;
  #lostDetail = "";
  lastTiming: WebGpuInferenceTiming | undefined;

  private constructor(weights: GoValueWeights, device: GpuDeviceLike) {
    this.extent = weights.extent;
    this.#device = device;
    void device.lost.then((info) => {
      this.#lost = true;
      if (info && typeof info === "object") {
        const loss = info as { reason?: unknown; message?: unknown };
        const reason = typeof loss.reason === "string" ? loss.reason : "unknown reason";
        const message = typeof loss.message === "string" && loss.message ? `: ${loss.message}` : "";
        this.#lostDetail = ` (${reason}${message})`;
      }
    });
    const module = device.createShaderModule({ code: shaderSource(weights) });
    this.#pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "evaluate" },
    });
    const flat = new Float32Array(
      weights.conv.length + weights.convBias.length + weights.w1.length
      + weights.b1.length + weights.w2.length + weights.b2.length,
    );
    let offset = 0;
    for (const view of [weights.conv, weights.convBias, weights.w1, weights.b1, weights.w2, weights.b2]) {
      flat.set(view, offset);
      offset += view.length;
    }
    this.#weightsBuffer = device.createBuffer({
      size: flat.byteLength,
      usage: BUFFER_STORAGE | BUFFER_COPY_DST,
    });
    device.queue.writeBuffer(this.#weightsBuffer, 0, flat);
    this.#uniformBuffer = device.createBuffer({
      size: this.#uniform.byteLength,
      usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
    });
    this.#boardCapacity = INITIAL_BOARD_CAPACITY;
    this.#boardsBuffer = this.#createBoardsBuffer();
    this.#resultsBuffer = device.createBuffer({
      size: this.#boardCapacity * GO_VALUE_OUTPUTS * 4,
      usage: BUFFER_STORAGE | BUFFER_COPY_SRC,
    });
    this.#stagingBuffer = device.createBuffer({
      size: this.#boardCapacity * GO_VALUE_OUTPUTS * 4,
      usage: BUFFER_MAP_READ | BUFFER_COPY_DST,
    });
    this.#bindGroup = this.#createBindGroup();
  }

  static async create(weights: GoValueWeights): Promise<WebGpuGoValueBackend> {
    const gpu = webGpuApi();
    if (!gpu) throw new Error("WebGPU is unavailable in this environment");
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter request returned null");
    const device = await adapter.requestDevice();
    return new WebGpuGoValueBackend(weights, device);
  }

  #createBoardsBuffer(): GpuBufferLike {
    return this.#device.createBuffer({
      size: this.#boardCapacity * goBoardWords(this.extent) * 4,
      usage: BUFFER_STORAGE | BUFFER_COPY_DST,
    });
  }

  #createBindGroup(): unknown {
    return this.#device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#uniformBuffer } },
        { binding: 1, resource: { buffer: this.#weightsBuffer } },
        { binding: 2, resource: { buffer: this.#boardsBuffer } },
        { binding: 3, resource: { buffer: this.#resultsBuffer } },
      ],
    });
  }

  #ensureCapacity(count: number): void {
    if (count <= this.#boardCapacity) return;
    this.#boardCapacity = Math.ceil(count * 1.5);
    this.#boardsBuffer.destroy();
    this.#resultsBuffer.destroy();
    this.#stagingBuffer.destroy();
    this.#boardsBuffer = this.#createBoardsBuffer();
    this.#resultsBuffer = this.#device.createBuffer({
      size: this.#boardCapacity * GO_VALUE_OUTPUTS * 4,
      usage: BUFFER_STORAGE | BUFFER_COPY_SRC,
    });
    this.#stagingBuffer = this.#device.createBuffer({
      size: this.#boardCapacity * GO_VALUE_OUTPUTS * 4,
      usage: BUFFER_MAP_READ | BUFFER_COPY_DST,
    });
    this.#bindGroup = this.#createBindGroup();
  }

  evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    // The staging buffer cannot be re-mapped while a previous readback is in
    // flight; decisions are sequential in practice, so a chain suffices.
    const requestedAt = performance.now();
    const run = this.#queue
      .then(() => this.#evaluate(batch, requestedAt))
      .catch((error: unknown) => {
        const loss = this.#lost ? `; device lost${this.#lostDetail}` : "";
        throw new Error(`required WebGPU inference failed${loss}: ${String(error)}`, { cause: error });
      });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #evaluate(batch: GoValueBatch, requestedAt: number): Promise<Float32Array> {
    const submitStartedAt = performance.now();
    if (this.#lost) throw new Error(`WebGPU device was lost${this.#lostDetail}`);
    this.#ensureCapacity(batch.count);
    const words = goBoardWords(this.extent);
    this.#uniform[0] = batch.opponentIndex;
    this.#uniform[1] = batch.count;
    const queue = this.#device.queue;
    queue.writeBuffer(this.#uniformBuffer, 0, this.#uniform);
    queue.writeBuffer(this.#boardsBuffer, 0, batch.packed, 0, batch.count * words);
    const resultBytes = batch.count * GO_VALUE_OUTPUTS * 4;
    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.dispatchWorkgroups(batch.count);
    pass.end();
    encoder.copyBufferToBuffer(this.#resultsBuffer, 0, this.#stagingBuffer, 0, resultBytes);
    queue.submit([encoder.finish()]);
    const submitMainThreadMs = performance.now() - submitStartedAt;
    await this.#stagingBuffer.mapAsync(MAP_MODE_READ, 0, resultBytes);
    const parseStartedAt = performance.now();
    const outputs = batch.count * GO_VALUE_OUTPUTS;
    if (this.#raw.length < outputs) this.#raw = new Float32Array(outputs);
    this.#raw.set(new Float32Array(this.#stagingBuffer.getMappedRange(0, resultBytes)));
    this.#stagingBuffer.unmap();
    const parsedAt = performance.now();
    this.lastTiming = {
      mainThreadMs: Math.max(submitMainThreadMs, parsedAt - parseStartedAt),
      requestToParsedMs: parsedAt - requestedAt,
    };
    return this.#raw.subarray(0, outputs);
  }

  dispose(): void {
    this.#lost = true;
    this.#device.destroy();
  }
}

export interface WebGpuInferenceTiming {
  /** Total synchronous main-thread work used to submit and parse this request. */
  mainThreadMs: number;
  /** Wall time from evaluateBatch() invocation through copied, parsed output. */
  requestToParsedMs: number;
}

/** Production factory. Correctness is pinned off-game against C++ golden
 * vectors; runtime creation and evaluation failures are fatal to the Go turn. */
export async function createRequiredWebGpuGoValueBackend(
  weights: GoValueWeights,
): Promise<WebGpuGoValueBackend> {
  try {
    return await WebGpuGoValueBackend.create(weights);
  } catch (error) {
    throw new Error(`required WebGPU backend unavailable: ${String(error)}`, { cause: error });
  }
}

/** WebGPU implementation of the deployed V9 shared trunk with parallel value
 * and move-proposal heads.
 *
 * V9 uses a staged multi-dispatch trunk and one combined readback for value,
 * and policy outputs. The training-only response-branch head is not exported.
 * Weights live in one storage buffer uploaded at creation, so per-turn
 * main-thread work is packing a ~KB batch, one
 * writeBuffer, and command encoding; the arithmetic and the readback wait
 * happen off-thread behind mapAsync.
 *
 * Types are declared locally and structurally: the game's Chromium provides
 * `navigator.gpu` at runtime, and the deploy toolchain should not depend on
 * browser typings. The RAM analyzer also never sees a `window`/`document`
 * token this way.
 */
import {
  type GoV9Weights,
} from "./artifact.ts";
import { goBoardWords, goLegalWords, type GoProposalRaw, type GoValueBackend, type GoValueBatch } from "./backend.ts";

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
  pushErrorScope?(filter: "validation" | "out-of-memory" | "internal"): void;
  popErrorScope?(): Promise<{ message?: string } | null>;
  destroy(): void;
}

interface GpuAdapterLike {
  readonly features?: { has(name: string): boolean };
  requestDevice(descriptor?: { requiredFeatures?: string[] }): Promise<GpuDeviceLike>;
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

export interface GoWebGpuOptimizationFlags {
  /** Reuse convolution kernels and behavior conditioning through workgroup memory. */
  workgroupCache: boolean;
  /** Store trunk activations in IEEE float16 while retaining float32 accumulation. */
  f16Activations: boolean;
  /** Accumulate convolution input channels four at a time with WGSL vec4 dot products. */
  vectorizedChannels: boolean;
}

export const DEFAULT_GO_WEBGPU_OPTIMIZATIONS: Readonly<GoWebGpuOptimizationFlags> = {
  workgroupCache: true,
  f16Activations: true,
  vectorizedChannels: true,
};

function v9ShaderSource(weights: GoV9Weights, flags: GoWebGpuOptimizationFlags): string {
  const area = weights.extent * weights.extent;
  const candidates = area + 1;
  const stride = 3 + candidates;
  let offset = 0;
  const stem = offset; offset += weights.stem.length;
  const stemBias = offset; offset += weights.stemBias.length;
  const residual = offset; offset += weights.residual.length;
  const residualBias = offset; offset += weights.residualBias.length;
  const conditioningW = offset; offset += weights.conditioningW.length;
  const conditioningB = offset; offset += weights.conditioningB.length;
  const valueW1 = offset; offset += weights.valueW1.length;
  const valueW1Right = offset; offset += weights.valueW1Right.length;
  const valueB1 = offset; offset += weights.valueB1.length;
  const valueW2 = offset; offset += weights.valueW2.length;
  const valueB2 = offset; offset += weights.valueB2.length;
  const valueOutW = offset; offset += weights.valueOutW.length;
  const valueOutB = offset; offset += weights.valueOutB.length;
  const policyW = offset; offset += weights.policyW.length;
  const policyB = offset; offset += weights.policyB.length;
  const passW = offset; offset += weights.passW.length;
  const passB = offset; offset += weights.passB.length;
  const activationStorage = flags.f16Activations ? "f16" : "f32";
  const activationHelpers = flags.f16Activations
    ? `fn activationAt(index:u32)->f32{return f32(activation[index]);}
fn scratchAt(index:u32)->f32{return f32(scratch[index]);}
fn setActivation(index:u32,value:f32){activation[index]=f16(value);}
fn setScratch(index:u32,value:f32){scratch[index]=f16(value);}`
    : `fn activationAt(index:u32)->f32{return activation[index];}
fn scratchAt(index:u32)->f32{return scratch[index];}
fn setActivation(index:u32,value:f32){activation[index]=value;}
fn setScratch(index:u32,value:f32){scratch[index]=value;}`;
  return `${flags.f16Activations ? "enable f16;" : ""}
const EXTENT:u32=${weights.extent}u; const AREA:u32=${area}u;
const BOARD_WORDS:u32=${goBoardWords(weights.extent)}u;
const LEGAL_WORDS:u32=${goLegalWords(weights.extent)}u;
const CHANNELS:u32=${weights.channels}u; const BLOCKS:u32=${weights.residualBlocks}u;
const BEHAVIOR:u32=${weights.behaviorFeatures}u; const HIDDEN:u32=${weights.hidden}u;
const TOWER:u32=${weights.valueTower}u;
const VALUE_RANK:u32=${weights.valueRank}u;
const WORKGROUP_CACHE:bool=${flags.workgroupCache};
const VECTOR_CHANNELS:bool=${flags.vectorizedChannels};
const CANDIDATES:u32=${candidates}u; const STRIDE:u32=${stride}u; const POOLED:u32=${weights.channels * 25}u;
const STEM:u32=${stem}u; const STEM_BIAS:u32=${stemBias}u;
const RESIDUAL:u32=${residual}u; const RESIDUAL_BIAS:u32=${residualBias}u;
const COND_W:u32=${conditioningW}u; const COND_B:u32=${conditioningB}u;
const VALUE_W1:u32=${valueW1}u; const VALUE_B1:u32=${valueB1}u;
const VALUE_W1_RIGHT:u32=${valueW1Right}u;
const VALUE_W2:u32=${valueW2}u; const VALUE_B2:u32=${valueB2}u;
const VALUE_OUT_W:u32=${valueOutW}u; const VALUE_OUT_B:u32=${valueOutB}u;
const POLICY_W:u32=${policyW}u; const POLICY_B:u32=${policyB}u;
const PASS_W:u32=${passW}u; const PASS_B:u32=${passB}u;
struct Params { count:u32, block:u32, unused0:u32, unused1:u32 }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> weights:array<f32>;
@group(0) @binding(2) var<storage,read> boards:array<u32>;
@group(0) @binding(3) var<storage,read> legal:array<u32>;
@group(0) @binding(4) var<storage,read> states:array<f32>;
@group(0) @binding(5) var<storage,read> behaviors:array<f32>;
@group(0) @binding(6) var<storage,read_write> activation:array<${activationStorage}>;
@group(0) @binding(7) var<storage,read_write> scratch:array<${activationStorage}>;
@group(0) @binding(8) var<storage,read_write> results:array<f32>;
@group(0) @binding(9) var<storage,read_write> values:array<f32>;
fn ai(board:u32,channel:u32,point:u32)->u32{return(board*CHANNELS+channel)*AREA+point;}
fn weightAt(index:u32)->f32{return weights[index];}
${activationHelpers}
fn inputValue(board:u32,channel:u32,point:u32)->f32{
  if(channel<3u){let code=(boards[board*BOARD_WORDS+(point>>4u)]>>((point&15u)*2u))&3u;
    return select(0.0,1.0,code==channel+1u);}
  if(channel==3u){return f32((legal[board*LEGAL_WORDS+(point>>5u)]>>(point&31u))&1u);}
  return states[board*4u+channel-4u];
}
fn behaviorCondition(board:u32,output:u32)->f32{
  let row=(params.block*CHANNELS+output)*BEHAVIOR;
  var condition=weightAt(COND_B+params.block*CHANNELS+output);
  for(var feature=0u;feature<BEHAVIOR;feature++){
    condition+=weightAt(COND_W+row+feature)*behaviors[board*BEHAVIOR+feature];}
  return condition;
}
var<workgroup> convolutionKernel:array<f32,${weights.channels * 9}>;
var<workgroup> sharedCondition:f32;
fn stemKernel(output:u32,input:u32,kernel:u32)->f32{
  let local=input*9u+kernel;var value=weightAt(STEM+output*72u+local);
  if(WORKGROUP_CACHE){value=convolutionKernel[local];}return value;
}
fn residualKernel(base:u32,output:u32,input:u32,kernel:u32)->f32{
  let local=input*9u+kernel;var value=weightAt(RESIDUAL+base+output*CHANNELS*9u+local);
  if(WORKGROUP_CACHE){value=convolutionKernel[local];}return value;
}
fn policyKernel(channel:u32)->f32{
  var value=weightAt(POLICY_W+channel);if(WORKGROUP_CACHE){value=convolutionKernel[channel];}
  return value;
}
@compute @workgroup_size(64)
fn stemPass(@builtin(global_invocation_id) id:vec3<u32>,
  @builtin(local_invocation_index) lane:u32){
  let point=id.x;let output=id.y;let board=id.z;
  if(WORKGROUP_CACHE){
    for(var task=lane;task<72u;task+=64u){convolutionKernel[task]=weightAt(STEM+output*72u+task);}
    workgroupBarrier();}
  if(point>=AREA||board>=params.count){return;}
  let x=i32(point/EXTENT);let y=i32(point%EXTENT);var value=weightAt(STEM_BIAS+output);
  if(VECTOR_CHANNELS){for(var dx=-1i;dx<=1i;dx++){
    let nx=x+dx;if(nx<0i||nx>=i32(EXTENT)){continue;}
    for(var dy=-1i;dy<=1i;dy++){let ny=y+dy;if(ny<0i||ny>=i32(EXTENT)){continue;}
      let source=u32(nx)*EXTENT+u32(ny);let kernel=u32(dx+1i)*3u+u32(dy+1i);
      for(var input=0u;input<8u;input+=4u){
        let w=vec4<f32>(stemKernel(output,input,kernel),stemKernel(output,input+1u,kernel),
          stemKernel(output,input+2u,kernel),stemKernel(output,input+3u,kernel));
        let a=vec4<f32>(inputValue(board,input,source),inputValue(board,input+1u,source),
          inputValue(board,input+2u,source),inputValue(board,input+3u,source));value+=dot(w,a);}
  }}}else{for(var input=0u;input<8u;input++){for(var dx=-1i;dx<=1i;dx++){
    let nx=x+dx;if(nx<0i||nx>=i32(EXTENT)){continue;}
    for(var dy=-1i;dy<=1i;dy++){let ny=y+dy;if(ny<0i||ny>=i32(EXTENT)){continue;}
      value+=stemKernel(output,input,u32(dx+1i)*3u+u32(dy+1i))
        *inputValue(board,input,u32(nx)*EXTENT+u32(ny));
  }}}}setActivation(ai(board,output,point),tanh(value));
}
@compute @workgroup_size(64)
fn residualFirst(@builtin(global_invocation_id) id:vec3<u32>,
  @builtin(local_invocation_index) lane:u32){
  let point=id.x;let output=id.y;let board=id.z;
  let base=(params.block*2u)*CHANNELS*CHANNELS*9u;
  if(WORKGROUP_CACHE){
    for(var task=lane;task<CHANNELS*9u;task+=64u){
      convolutionKernel[task]=weightAt(RESIDUAL+base+output*CHANNELS*9u+task);}
    workgroupBarrier();}
  if(point>=AREA||board>=params.count){return;}
  let x=i32(point/EXTENT);let y=i32(point%EXTENT);
  var value=weightAt(RESIDUAL_BIAS+(params.block*2u)*CHANNELS+output);
  if(VECTOR_CHANNELS){for(var dx=-1i;dx<=1i;dx++){
    let nx=x+dx;if(nx<0i||nx>=i32(EXTENT)){continue;}
    for(var dy=-1i;dy<=1i;dy++){let ny=y+dy;if(ny<0i||ny>=i32(EXTENT)){continue;}
      let source=u32(nx)*EXTENT+u32(ny);let kernel=u32(dx+1i)*3u+u32(dy+1i);
      for(var input=0u;input<CHANNELS;input+=4u){
        let w=vec4<f32>(residualKernel(base,output,input,kernel),residualKernel(base,output,input+1u,kernel),
          residualKernel(base,output,input+2u,kernel),residualKernel(base,output,input+3u,kernel));
        let a=vec4<f32>(activationAt(ai(board,input,source)),activationAt(ai(board,input+1u,source)),
          activationAt(ai(board,input+2u,source)),activationAt(ai(board,input+3u,source)));value+=dot(w,a);}
  }}}else{for(var input=0u;input<CHANNELS;input++){for(var dx=-1i;dx<=1i;dx++){
    let nx=x+dx;if(nx<0i||nx>=i32(EXTENT)){continue;}
    for(var dy=-1i;dy<=1i;dy++){let ny=y+dy;if(ny<0i||ny>=i32(EXTENT)){continue;}
      value+=residualKernel(base,output,input,u32(dx+1i)*3u+u32(dy+1i))
        *activationAt(ai(board,input,u32(nx)*EXTENT+u32(ny)));
  }}}}setScratch(ai(board,output,point),tanh(value));
}
@compute @workgroup_size(64)
fn residualSecond(@builtin(global_invocation_id) id:vec3<u32>,
  @builtin(local_invocation_index) lane:u32){
  let point=id.x;let output=id.y;let board=id.z;
  let base=(params.block*2u+1u)*CHANNELS*CHANNELS*9u;
  if(WORKGROUP_CACHE){
    for(var task=lane;task<CHANNELS*9u;task+=64u){
      convolutionKernel[task]=weightAt(RESIDUAL+base+output*CHANNELS*9u+task);}
    if(lane==0u){sharedCondition=behaviorCondition(board,output);}
    workgroupBarrier();}
  if(point>=AREA||board>=params.count){return;}
  let x=i32(point/EXTENT);let y=i32(point%EXTENT);
  var value=weightAt(RESIDUAL_BIAS+(params.block*2u+1u)*CHANNELS+output);
  if(VECTOR_CHANNELS){for(var dx=-1i;dx<=1i;dx++){
    let nx=x+dx;if(nx<0i||nx>=i32(EXTENT)){continue;}
    for(var dy=-1i;dy<=1i;dy++){let ny=y+dy;if(ny<0i||ny>=i32(EXTENT)){continue;}
      let source=u32(nx)*EXTENT+u32(ny);let kernel=u32(dx+1i)*3u+u32(dy+1i);
      for(var input=0u;input<CHANNELS;input+=4u){
        let w=vec4<f32>(residualKernel(base,output,input,kernel),residualKernel(base,output,input+1u,kernel),
          residualKernel(base,output,input+2u,kernel),residualKernel(base,output,input+3u,kernel));
        let a=vec4<f32>(scratchAt(ai(board,input,source)),scratchAt(ai(board,input+1u,source)),
          scratchAt(ai(board,input+2u,source)),scratchAt(ai(board,input+3u,source)));value+=dot(w,a);}
  }}}else{for(var input=0u;input<CHANNELS;input++){for(var dx=-1i;dx<=1i;dx++){
    let nx=x+dx;if(nx<0i||nx>=i32(EXTENT)){continue;}
    for(var dy=-1i;dy<=1i;dy++){let ny=y+dy;if(ny<0i||ny>=i32(EXTENT)){continue;}
      value+=residualKernel(base,output,input,u32(dx+1i)*3u+u32(dy+1i))
        *scratchAt(ai(board,input,u32(nx)*EXTENT+u32(ny)));
  }}}}
  var condition=sharedCondition;if(!WORKGROUP_CACHE){condition=behaviorCondition(board,output);}
  let index=ai(board,output,point);setActivation(index,tanh(activationAt(index)+value+condition));
}
@compute @workgroup_size(64)
fn pointHeads(@builtin(global_invocation_id) id:vec3<u32>,
  @builtin(local_invocation_index) lane:u32){
  let point=id.x;let board=id.y;
  if(WORKGROUP_CACHE){
    for(var task=lane;task<CHANNELS;task+=64u){convolutionKernel[task]=weightAt(POLICY_W+task);}
    workgroupBarrier();}
  if(point>=AREA||board>=params.count){return;}
  let base=board*STRIDE;var moveScore=weightAt(POLICY_B);
  if(VECTOR_CHANNELS){for(var channel=0u;channel<CHANNELS;channel+=4u){
    let w=vec4<f32>(policyKernel(channel),policyKernel(channel+1u),policyKernel(channel+2u),policyKernel(channel+3u));
    let a=vec4<f32>(activationAt(ai(board,channel,point)),activationAt(ai(board,channel+1u,point)),
      activationAt(ai(board,channel+2u,point)),activationAt(ai(board,channel+3u,point)));
    moveScore+=dot(w,a);}}
  else{for(var channel=0u;channel<CHANNELS;channel++){
    moveScore+=policyKernel(channel)*activationAt(ai(board,channel,point));}}
  results[base+3u+point]=moveScore;
}
var<workgroup> pooled:array<f32,${weights.channels * 25}>;
var<workgroup> valueHidden:array<f32,${weights.hidden}>;
var<workgroup> valueRankHidden:array<f32,${Math.max(weights.valueRank, 1)}>;
var<workgroup> tower:array<f32,${weights.valueTower}>;
fn binStart(bin:u32)->u32{return (bin*EXTENT+4u)/5u;}
fn poolValueInput(board:u32,lane:u32){
  for(var task=lane;task<POOLED;task+=256u){let channel=task/25u;let bin=task%25u;
    let x0=binStart(bin/5u);let x1=binStart(bin/5u+1u);let y0=binStart(bin%5u);let y1=binStart(bin%5u+1u);var sum=0.0;
    for(var x=x0;x<x1;x++){for(var y=y0;y<y1;y++){sum+=activationAt(ai(board,channel,x*EXTENT+y));}}
    pooled[task]=sum/f32((x1-x0)*(y1-y0));}workgroupBarrier();
}
fn firstValueLayer(lane:u32){
  if(VALUE_RANK>0u){
    if(lane<VALUE_RANK){var sum=0.0;for(var i=0u;i<POOLED;i++){sum+=weightAt(VALUE_W1_RIGHT+lane*POOLED+i)*pooled[i];}valueRankHidden[lane]=sum;}
    workgroupBarrier();
    if(lane<HIDDEN){var sum=weightAt(VALUE_B1+lane);for(var i=0u;i<VALUE_RANK;i++){sum+=weightAt(VALUE_W1+lane*VALUE_RANK+i)*valueRankHidden[i];}valueHidden[lane]=tanh(sum);}
  }else if(lane<HIDDEN){var sum=weightAt(VALUE_B1+lane);for(var i=0u;i<POOLED;i++){sum+=weightAt(VALUE_W1+lane*POOLED+i)*pooled[i];}valueHidden[lane]=tanh(sum);}workgroupBarrier();
}
@compute @workgroup_size(256)
fn aggregateHeads(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let board=group.x;if(board>=params.count){return;}let base=board*STRIDE;
  poolValueInput(board,lane);firstValueLayer(lane);
  if(lane<TOWER){var sum=weightAt(VALUE_B2+lane);for(var i=0u;i<HIDDEN;i++){sum+=weightAt(VALUE_W2+lane*HIDDEN+i)*valueHidden[i];}
    tower[lane]=tanh(sum);}workgroupBarrier();
  if(lane<3u){var sum=weightAt(VALUE_OUT_B+lane);for(var i=0u;i<TOWER;i++){sum+=weightAt(VALUE_OUT_W+lane*TOWER+i)*tower[i];}
    results[base+lane]=sum;}
  if(lane==3u){var sum=weightAt(PASS_B);for(var i=0u;i<POOLED;i++){sum+=weightAt(PASS_W+i)*pooled[i];}
    results[base+3u+AREA]=sum;}
}
@compute @workgroup_size(256)
fn aggregateValue(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let board=group.x;if(board>=params.count){return;}
  poolValueInput(board,lane);firstValueLayer(lane);
  if(lane<TOWER){var sum=weightAt(VALUE_B2+lane);for(var i=0u;i<HIDDEN;i++){sum+=weightAt(VALUE_W2+lane*HIDDEN+i)*valueHidden[i];}
    tower[lane]=tanh(sum);}workgroupBarrier();
  if(lane<3u){var sum=weightAt(VALUE_OUT_B+lane);for(var i=0u;i<TOWER;i++){sum+=weightAt(VALUE_OUT_W+lane*TOWER+i)*tower[i];}
    values[board*3u+lane]=sum;}
}`;
}

type V9PipelineName = "stemPass" | "residualFirst" | "residualSecond" | "pointHeads" | "aggregateHeads" | "aggregateValue";
type V9BindGroups = { stemPass: unknown; residualFirst: unknown[]; residualSecond: unknown[];
  pointHeads: unknown; aggregateHeads: unknown; aggregateValue: unknown };

class V9WebGpuGoBackend implements GoValueBackend {
  readonly extent: number;
  readonly behaviorFeatures: number;
  lastTiming: WebGpuInferenceTiming | undefined;
  #device: GpuDeviceLike;
  #pipelines: Record<V9PipelineName, { getBindGroupLayout(index: number): unknown }>;
  #weights: GpuBufferLike;
  #params: GpuBufferLike;
  #blockParams: GpuBufferLike[];
  #boards!: GpuBufferLike;
  #legal!: GpuBufferLike;
  #state!: GpuBufferLike;
  #behavior!: GpuBufferLike;
  #activation!: GpuBufferLike;
  #scratch!: GpuBufferLike;
  #results!: GpuBufferLike;
  #staging!: GpuBufferLike;
  #values!: GpuBufferLike;
  #valueStaging!: GpuBufferLike;
  #bindGroup!: V9BindGroups;
  #capacity = 8;
  #proposalCapacity = 8;
  #valueCapacity = 8;
  #channels: number;
  #blocks: number;
  #stride: number;
  #activationBytes: number;
  #uniform = new Uint32Array(4);
  #queue: Promise<unknown> = Promise.resolve();
  #lost = false;

  private constructor(weights: GoV9Weights, device: GpuDeviceLike,
    flags: GoWebGpuOptimizationFlags) {
    this.extent = weights.extent;
    this.behaviorFeatures = weights.behaviorFeatures;
    this.#channels = weights.channels;
    this.#blocks = weights.residualBlocks;
    this.#activationBytes = flags.f16Activations ? 2 : 4;
    const candidates = weights.extent * weights.extent + 1;
    this.#stride = 3 + candidates;
    this.#device = device;
    void device.lost.then(() => { this.#lost = true; });
    const module = device.createShaderModule({ code: v9ShaderSource(weights, flags) });
    const pipeline = (entryPoint: V9PipelineName) =>
      device.createComputePipeline({ layout: "auto", compute: { module, entryPoint } });
    this.#pipelines = {
      stemPass: pipeline("stemPass"),
      residualFirst: pipeline("residualFirst"),
      residualSecond: pipeline("residualSecond"),
      pointHeads: pipeline("pointHeads"),
      aggregateHeads: pipeline("aggregateHeads"),
      aggregateValue: pipeline("aggregateValue"),
    };
    this.#weights = device.createBuffer({ size: weights.flat.byteLength,
      usage: BUFFER_STORAGE | BUFFER_COPY_DST });
    device.queue.writeBuffer(this.#weights, 0, weights.flat);
    this.#params = device.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DST });
    this.#blockParams = Array.from({ length: this.#blocks }, () =>
      device.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DST }));
    this.#allocate();
    this.#bindGroup = this.#createBindGroups();
  }

  static async create(weights: GoV9Weights,
    options: Partial<GoWebGpuOptimizationFlags> = {}): Promise<V9WebGpuGoBackend> {
    const flags = { ...DEFAULT_GO_WEBGPU_OPTIMIZATIONS, ...options };
    const gpu = webGpuApi();
    if (!gpu) throw new Error("WebGPU is unavailable");
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter returned null");
    if (flags.f16Activations && !adapter.features?.has("shader-f16")) {
      throw new Error("f16 activation storage requested but shader-f16 is unavailable");
    }
    const device = await adapter.requestDevice(flags.f16Activations
      ? { requiredFeatures: ["shader-f16"] } : undefined);
    device.pushErrorScope?.("validation");
    const backend = new V9WebGpuGoBackend(weights, device, flags);
    const error = await device.popErrorScope?.();
    if (error) {
      backend.dispose();
      throw new Error(`V9 WebGPU validation failed: ${error.message ?? "unknown"}`);
    }
    return backend;
  }

  #allocate(): void {
    const storage = BUFFER_STORAGE | BUFFER_COPY_DST;
    this.#boards = this.#device.createBuffer({ size: this.#capacity * goBoardWords(this.extent) * 4, usage: storage });
    this.#legal = this.#device.createBuffer({ size: this.#capacity * goLegalWords(this.extent) * 4, usage: storage });
    this.#state = this.#device.createBuffer({ size: this.#capacity * 16, usage: storage });
    this.#behavior = this.#device.createBuffer({ size: this.#capacity * this.behaviorFeatures * 4, usage: storage });
    const activation = this.#capacity * this.#channels * this.extent * this.extent
      * this.#activationBytes;
    this.#activation = this.#device.createBuffer({ size: activation, usage: BUFFER_STORAGE });
    this.#scratch = this.#device.createBuffer({ size: activation, usage: BUFFER_STORAGE });
    const resultBytes = this.#proposalCapacity * this.#stride * 4;
    this.#results = this.#device.createBuffer({ size: resultBytes, usage: BUFFER_STORAGE | BUFFER_COPY_SRC });
    this.#staging = this.#device.createBuffer({ size: resultBytes, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
    const valueBytes = this.#valueCapacity * 3 * 4;
    this.#values = this.#device.createBuffer({ size: valueBytes, usage: BUFFER_STORAGE | BUFFER_COPY_SRC });
    this.#valueStaging = this.#device.createBuffer({ size: valueBytes, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
  }

  #createBindGroups(): V9BindGroups {
    const entry = (binding: number, buffer: GpuBufferLike) => ({ binding, resource: { buffer } });
    const spatial = (params: GpuBufferLike) => [entry(0, params), entry(1, this.#weights),
      entry(6, this.#activation), entry(7, this.#scratch)];
    return {
      stemPass: this.#device.createBindGroup({ layout: this.#pipelines.stemPass.getBindGroupLayout(0), entries: [
        entry(0, this.#params), entry(1, this.#weights), entry(2, this.#boards), entry(3, this.#legal),
        entry(4, this.#state), entry(6, this.#activation)] }),
      residualFirst: this.#blockParams.map((params) => this.#device.createBindGroup({
        layout: this.#pipelines.residualFirst.getBindGroupLayout(0), entries: spatial(params) })),
      residualSecond: this.#blockParams.map((params) => this.#device.createBindGroup({
        layout: this.#pipelines.residualSecond.getBindGroupLayout(0), entries: [
          ...spatial(params), entry(5, this.#behavior)] })),
      pointHeads: this.#device.createBindGroup({ layout: this.#pipelines.pointHeads.getBindGroupLayout(0), entries: [
        entry(0, this.#params), entry(1, this.#weights), entry(6, this.#activation), entry(8, this.#results)] }),
      aggregateHeads: this.#device.createBindGroup({ layout: this.#pipelines.aggregateHeads.getBindGroupLayout(0), entries: [
        entry(0, this.#params), entry(1, this.#weights), entry(6, this.#activation), entry(8, this.#results)] }),
      aggregateValue: this.#device.createBindGroup({ layout: this.#pipelines.aggregateValue.getBindGroupLayout(0), entries: [
        entry(0, this.#params), entry(1, this.#weights), entry(6, this.#activation), entry(9, this.#values)] }),
    };
  }

  #ensure(count: number, proposal: boolean): void {
    const needsSpatial = count > this.#capacity;
    const needsOutput = proposal ? count > this.#proposalCapacity : count > this.#valueCapacity;
    if (!needsSpatial && !needsOutput) return;
    if (needsSpatial) this.#capacity = Math.ceil(count * 1.25);
    if (proposal && needsOutput) this.#proposalCapacity = Math.ceil(count * 1.25);
    if (!proposal && needsOutput) this.#valueCapacity = Math.ceil(count * 1.25);
    for (const buffer of [this.#boards, this.#legal, this.#state, this.#behavior,
      this.#activation, this.#scratch, this.#results, this.#staging,
      this.#values, this.#valueStaging]) buffer.destroy();
    this.#allocate();
    this.#bindGroup = this.#createBindGroups();
  }

  evaluateProposal(batch: GoValueBatch): Promise<GoProposalRaw> {
    const requested = performance.now();
    const run = this.#queue.then(() => this.#evaluate(batch, requested, true) as Promise<GoProposalRaw>);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    const requested = performance.now();
    const run = this.#queue.then(() => this.#evaluate(batch, requested, false) as Promise<Float32Array>);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #evaluate(
    batch: GoValueBatch,
    requested: number,
    proposal: boolean,
  ): Promise<GoProposalRaw | Float32Array> {
    const submitAt = performance.now();
    if (this.#lost) throw new Error("WebGPU device was lost");
    if (!Number.isSafeInteger(batch.count) || batch.count < 1) {
      throw new Error(`V9 inference requires a positive integer batch count, got ${batch.count}`);
    }
    const boardValues = batch.count * goBoardWords(this.extent);
    const legalValues = batch.count * goLegalWords(this.extent);
    const stateValues = batch.count * 4;
    const behaviorValues = batch.count * this.behaviorFeatures;
    if (batch.packed.length < boardValues || batch.legal.length < legalValues
      || batch.state.length < stateValues || batch.behavior.length < behaviorValues) {
      throw new Error("V9 inference requires complete packed, legal, state, and behavior tensors");
    }
    this.#ensure(batch.count, proposal);
    const queue = this.#device.queue;
    queue.writeBuffer(this.#boards, 0, batch.packed, 0, boardValues);
    queue.writeBuffer(this.#legal, 0, batch.legal, 0, legalValues);
    queue.writeBuffer(this.#state, 0, batch.state, 0, stateValues);
    queue.writeBuffer(this.#behavior, 0, batch.behavior, 0, behaviorValues);
    this.#uniform.set([batch.count, 0, 0, 0]);
    queue.writeBuffer(this.#params, 0, this.#uniform);
    for (let block = 0; block < this.#blocks; block++) {
      this.#uniform[1] = block;
      queue.writeBuffer(this.#blockParams[block]!, 0, this.#uniform);
    }
    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const groups = Math.ceil(this.extent * this.extent / 64);
    pass.setPipeline(this.#pipelines.stemPass);
    pass.setBindGroup(0, this.#bindGroup.stemPass);
    pass.dispatchWorkgroups(groups, this.#channels, batch.count);
    for (let block = 0; block < this.#blocks; block++) {
      pass.setPipeline(this.#pipelines.residualFirst);
      pass.setBindGroup(0, this.#bindGroup.residualFirst[block]!);
      pass.dispatchWorkgroups(groups, this.#channels, batch.count);
      pass.setPipeline(this.#pipelines.residualSecond);
      pass.setBindGroup(0, this.#bindGroup.residualSecond[block]!);
      pass.dispatchWorkgroups(groups, this.#channels, batch.count);
    }
    if (proposal) {
      pass.setPipeline(this.#pipelines.pointHeads);
      pass.setBindGroup(0, this.#bindGroup.pointHeads);
      pass.dispatchWorkgroups(groups, batch.count);
    }
    pass.setPipeline(proposal ? this.#pipelines.aggregateHeads : this.#pipelines.aggregateValue);
    pass.setBindGroup(0, proposal ? this.#bindGroup.aggregateHeads : this.#bindGroup.aggregateValue);
    pass.dispatchWorkgroups(batch.count);
    pass.end();
    const bytes = batch.count * (proposal ? this.#stride : 3) * 4;
    const source = proposal ? this.#results : this.#values;
    const staging = proposal ? this.#staging : this.#valueStaging;
    encoder.copyBufferToBuffer(source, 0, staging, 0, bytes);
    queue.submit([encoder.finish()]);
    const mainThreadMs = performance.now() - submitAt;
    await staging.mapAsync(MAP_MODE_READ, 0, bytes);
    const mappedAt = performance.now();
    const raw = new Float32Array(staging.getMappedRange(0, bytes)).slice();
    staging.unmap();
    const parsedAt = performance.now();
    this.lastTiming = { mainThreadMs: mainThreadMs + parsedAt - mappedAt,
      requestToParsedMs: parsedAt - requested };
    if (!proposal) return raw;
    const candidates = this.extent * this.extent + 1;
    const value = new Float32Array(batch.count * 3);
    const moves = new Float32Array(batch.count * candidates);
    for (let board = 0; board < batch.count; board++) {
      const base = board * this.#stride;
      value.set(raw.subarray(base, base + 3), board * 3);
      moves.set(raw.subarray(base + 3, base + 3 + candidates), board * candidates);
    }
    return { value, moves };
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
  weights: GoV9Weights,
  options: Partial<GoWebGpuOptimizationFlags> = {},
): Promise<GoValueBackend & { lastTiming: WebGpuInferenceTiming | undefined }> {
  try {
    return await V9WebGpuGoBackend.create(weights, options);
  } catch (error) {
    throw new Error(`required WebGPU backend unavailable: ${String(error)}`, { cause: error });
  }
}

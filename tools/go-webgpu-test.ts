/** WGSL shader gate: execute the deployed WebGPU backend in headless Chrome
 * (Dawn on Metal, like Bitburner's Electron) against the C++ golden fixture.
 *
 *   bun run go:gpu            # golden vectors, batching, capacity, latency
 *   bun run go:gpu -- --arena # additionally play real oracle games on the GPU
 */
import { join } from "node:path";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";

const HERE = join(import.meta.dir, "webgpu");

const golden = await runInHeadlessChrome(join(HERE, "entry-golden.ts"), 120_000);
console.log(JSON.stringify(golden.result, null, 2));
const goldenOk = (golden.result as { ok?: boolean })?.ok === true;
if (!goldenOk) {
  console.error("WGSL golden gate FAILED");
  process.exit(1);
}

if (Bun.argv.includes("--arena")) {
  const arena = await runInHeadlessChrome(join(HERE, "entry-arena.ts"), 900_000);
  console.log(JSON.stringify(arena.result, null, 2));
  const arenaOk = (arena.result as { ok?: boolean })?.ok === true;
  if (!arenaOk) {
    console.error("WebGPU arena gate FAILED");
    process.exit(1);
  }
}
console.log("WGSL shader gate passed");

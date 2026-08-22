/** WGSL shader gate: execute the deployed WebGPU backend in headless Chrome
 * (Dawn on Metal, like Bitburner's Electron) against full-precision C++
 * champion outputs.
 *
 *   bun run go:gpu            # golden vectors, batching, capacity, latency
 *   bun run go:gpu -- --arena # additionally play real oracle games on the GPU
 */
import { join } from "node:path";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";
import type { GoWebGpuOptimizationFlags } from "../shared/strategy/go/neural/webgpu.ts";

const HERE = join(import.meta.dir, "webgpu");

const optimizationNames = ["workgroupCache", "f16Activations", "vectorizedChannels"] as const satisfies readonly (keyof GoWebGpuOptimizationFlags)[];
const optimizations: Partial<GoWebGpuOptimizationFlags> = {};
for (const name of optimizationNames) {
  const prefix = `--${name}=`;
  const argument = Bun.argv.find((value) => value.startsWith(prefix));
  if (!argument) continue;
  const value = argument.slice(prefix.length);
  if (value !== "on" && value !== "off") {
    throw new Error(`${prefix} expects on or off`);
  }
  optimizations[name] = value === "on";
}

const golden = await runInHeadlessChrome(join(HERE, "entry-golden.ts"), 120_000,
  { __goWebGpuOptimizations: optimizations });
console.log(JSON.stringify(golden.result, null, 2));
const goldenOk = (golden.result as { ok?: boolean })?.ok === true;
if (!goldenOk) {
  console.error("WGSL golden gate FAILED");
  process.exit(1);
}

if (Bun.argv.includes("--arena")) {
  const valueAfter = (name: string): string | undefined => {
    const exact = Bun.argv.indexOf(name);
    if (exact >= 0) return Bun.argv[exact + 1];
    return Bun.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const games = Number(valueAfter("--games") ?? 12);
  const opponent = valueAfter("--opponent");
  const daemonRun = opponent === "secret" || opponent === "world-daemon";
  // Daemon games are an order of magnitude slower than 5x5; give an explicit
  // daemon bench room to finish instead of the default gate's 15 minutes.
  const arenaTimeout = Math.max(900_000, games * (daemonRun ? 240_000 : 15_000));
  const arena = await runInHeadlessChrome(join(HERE, "entry-arena.ts"), arenaTimeout, {
    __goArenaOptions: {
      cheat: Bun.argv.includes("--cheat"),
      games,
      opponent,
      boardSize: valueAfter("--board-size") === undefined
        ? undefined : Number(valueAfter("--board-size")),
      cheatChance: valueAfter("--cheat-chance") === undefined
        ? undefined : Number(valueAfter("--cheat-chance")),
      cheatK: valueAfter("--cheat-k") === undefined ? undefined : Number(valueAfter("--cheat-k")),
      cheatDoubleK: valueAfter("--cheat-double-k") === undefined
        ? undefined : Number(valueAfter("--cheat-double-k")),
    },
  });
  console.log(JSON.stringify(arena.result, null, 2));
  const arenaOk = (arena.result as { ok?: boolean })?.ok === true;
  if (!arenaOk) {
    console.error("WebGPU arena gate FAILED");
    process.exit(1);
  }
}
console.log("V9 WGSL shader gate passed");

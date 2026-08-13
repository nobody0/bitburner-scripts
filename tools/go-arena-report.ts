import { join } from "node:path";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";

const run = await runInHeadlessChrome(join(import.meta.dir, "webgpu", "entry-arena.ts"), 900_000);
console.log(JSON.stringify(run.result, null, 2));
if ((run.result as { ok?: boolean })?.ok !== true) process.exit(1);

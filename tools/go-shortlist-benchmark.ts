import { join } from "node:path";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";

const result = await runInHeadlessChrome(
  join(import.meta.dir, "webgpu", "entry-shortlist-arena.ts"), 900_000);
console.log(JSON.stringify(result.result, null, 2));
if ((result.result as { ok?: boolean })?.ok !== true) process.exit(1);

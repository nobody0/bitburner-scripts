import { lane } from "../../tests/support/lanes.ts";

/** Pressure scenarios are intentionally expensive and install process-wide
 * virtual time, so they run in the `hacking` lane rather than the default
 * correctness suite: `bun run long hacking --file scenario-`, or as part of
 * `bun run long hacking`. The runner executes every case in its own Bun
 * process, so one timeout cannot contaminate any other scenario or parity
 * test. Scenarios pinned to a BitNode add their own tag; see
 * tests/support/lanes.ts. */
export const scenarioDescribe = lane({ feature: "hacking" }).describe;

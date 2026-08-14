import { describe } from "bun:test";

/** Pressure scenarios are intentionally expensive and install process-wide
 * virtual time. Keep them out of the default correctness process; the
 * dedicated runner executes every test case in its own Bun process so one timeout
 * cannot contaminate any other scenario or parity test. */
export const scenarioDescribe = process.env.SIM_SCENARIOS === "1"
  ? describe
  : describe.skip;

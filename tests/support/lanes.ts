import { describe, test } from "bun:test";
import { appendFileSync } from "node:fs";

/** LANES — the split between correctness tests and simulations.
 *
 * The default `bun test` is a correctness suite: it proves our rewritten code
 * matches the Bitburner source, and that our own logic does what it claims.
 * Every case in it is cheap, deterministic, and worth running on any change.
 *
 * Simulations are a different thing. They drive the real controller through
 * virtual game time — a 900-second farm soak, a full BN1 progression, a
 * thousand Go games against the faction AI — to measure how our scripts GROW,
 * not whether a function returns the right number. They matter when the
 * feature they exercise changed, or when we want a fresh completion-time
 * benchmark, and they cost minutes rather than milliseconds. They are also
 * where a timeout does real damage: several install process-wide virtual time,
 * so a case killed mid-run leaves the primitive installed and every later file
 * in the same Bun process fails on the wreckage.
 *
 * So simulations declare their lane here and are skipped unless asked for:
 *
 *     const soak = lane({ feature: "hacking" });
 *     soak.test("keeps the farm target inside its bands", () => { ... });
 *
 *     lane({ feature: "progression", bn: 1 }).describe("BN1 profile", () => { ... });
 *
 * `bun run long <token>` runs them, one Bun process per case, so no soak can
 * contaminate another. Tokens are the feature names below plus `bn<N>`:
 *
 *     bun run long go            every long Go run
 *     bun run long bn1           everything specific to BitNode 1
 *     bun run long hacking stock two features at once
 *     bun run long --all
 *
 * A handful of lane files import `ipvgobruteforce/`, which lives outside this
 * repository, and so throw before any call here can run. Those are excluded by
 * `bunfig.toml` and listed in `tools/test-lanes.ts` instead. */

/** The subsystem a simulation exercises. Deliberately coarse: a token is
 * useful when it answers "I changed X, what should I re-measure?", and a
 * taxonomy finer than that just means nobody remembers the right token. */
export type Feature =
  | "go"
  | "hacking"
  | "progression"
  | "stock"
  | "world";

export interface LaneTags {
  /** Which subsystem this run measures. */
  feature?: Feature | Feature[];
  /** Which BitNode it is specific to. Omit when the run is node-agnostic. */
  bn?: number | number[];
}

const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The selection tokens a set of tags answers to. */
export const laneTokens = (tags: LaneTags): string[] => [
  ...list(tags.feature),
  ...list(tags.bn).map((bn) => `bn${bn}`),
];

const requested = new Set(
  (process.env.BB_LANES ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0),
);

/** Set by the runner's discovery pass, which registers every lane case so it
 * can be enumerated, and pairs this with a test-name pattern that matches
 * nothing so no body actually executes. */
const manifestPath = process.env.BB_LANE_MANIFEST;

const isRequested = (tags: LaneTags): boolean =>
  requested.has("all") || laneTokens(tags).some((token) => requested.has(token));

const TEST_FILE = /([A-Za-z]:[\\/][^\s()]+\.test\.ts|\/[^\s()]+\.test\.ts)/;

/** The runner spawns one process per case and needs the file to spawn it
 * against; the registration call site is the only place that knows it. */
function callerFile(): string | undefined {
  for (const frame of (new Error().stack ?? "").split("\n").slice(2)) {
    const match = TEST_FILE.exec(frame);
    if (match) return match[1]!.replaceAll("\\", "/");
  }
  return undefined;
}

function announce(kind: "describe" | "test", name: string, tags: LaneTags): void {
  if (manifestPath === undefined) return;
  appendFileSync(
    manifestPath,
    JSON.stringify({ kind, name, file: callerFile(), tags: laneTokens(tags) }) + "\n",
  );
}

export interface Lane {
  /** Gate a whole suite. The runner drives it as one process. */
  describe: (name: string, body: () => void) => void;
  /** Gate a single case inside an otherwise fast file. */
  test: (
    name: string,
    body: Parameters<typeof test>[1],
    options?: Parameters<typeof test>[2],
  ) => void;
}

export function lane(tags: LaneTags): Lane {
  if (laneTokens(tags).length === 0) {
    throw new Error("a lane needs at least one feature or bn tag, or nothing can select it");
  }
  // Discovery registers everything: it is the pass that learns what exists.
  const run = manifestPath !== undefined || isRequested(tags);
  return {
    describe: (name, body) => {
      announce("describe", name, tags);
      (run ? describe : describe.skip)(name, body);
    },
    test: (name, body, options) => {
      announce("test", name, tags);
      (run ? test : test.skip)(name, body, options);
    },
  };
}

/** Compile-time telemetry switch. Defined by esbuild (`tools/build.ts`) for
 * game bundles: `true` by default, `false` under `--perf`, where every
 * `TELEMETRY: if (__TELEMETRY__)` branch — including payload construction —
 * is eliminated. Never reference this outside `game/`. */
declare const __TELEMETRY__: boolean;

/** Unique id baked into every artifact emitted by one build. */
declare const __BUILD_ID__: string;

/** V9 worker bundle emitted by tools/build.ts and embedded into main.js so
 * Bitburner does not need a separately addressable browser-worker file. */
declare const __GO_NEURAL_WORKER_SOURCE__: string;

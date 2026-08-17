import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { versionedScript } from "../shared/deployment.ts";
import { loadConfig, safeBuildDir, type BitburnerConfig, type BuildEntry } from "./config.ts";

export interface BuiltArtifact {
  filename: string;
  content: string;
}

export interface BuildOptions {
  /** When false, esbuild defines __TELEMETRY__ = false and drops every
   * labelled telemetry branch, including payload construction. */
  telemetry: boolean;
}

/** In-game filename of the build stamp. game/start.ts compares it against its
 * baked-in __BUILD_ID__ each tick and respawns itself when they differ, so a
 * push is enough to roll a new version — no manual restarts. */
export const BUILD_ID_FILE = "build-id.txt";

function createBuildId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function artifactName(entry: BuildEntry, buildId: string): string {
  return entry.versioned ? versionedScript(entry.target, buildId) : entry.target;
}

async function bundleEntry(
  config: BitburnerConfig,
  entry: BuildEntry,
  filename: string,
  buildId: string,
  options: BuildOptions,
  goWorkerSource: string,
): Promise<BuiltArtifact> {
  const outfile = path.join(config.buildDir, filename);
  await mkdir(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [entry.source],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    sourcemap: "external",
    logLevel: "warning",
    // Whitespace-only minification shrinks the large embedded strategy data
    // without rewriting property access or identifier bindings. Syntax
    // minification remains forbidden because it can turn bracketed dodged ns
    // calls into dotted calls and change the game's static RAM accounting.
    minifyWhitespace: true,
    define: {
      __TELEMETRY__: options.telemetry ? "true" : "false",
      __BUILD_ID__: JSON.stringify(buildId),
      __GO_NEURAL_WORKER_SOURCE__: JSON.stringify(goWorkerSource),
    },
    // Keep bracket-notation ns calls intact (syntax minification rewrites
    // them and breaks dodge RAM accounting), while still removing guarded
    // telemetry payloads completely from performance bundles.
    dropLabels: options.telemetry ? [] : ["TELEMETRY"],
  });
  return { filename, content: await readFile(outfile, "utf8") };
}

/** Installed by `go:playbook:install`; absent builds ship without a certified
 * playbook and every worker lookup reports a miss. */
export const GO_PLAYBOOK_MODULE = "game/lib/generated/go-playbook.phase.js";

/** Bundle the V9 engine as a classic worker. The resulting source is embedded
 * into start.js and opened through a Blob URL in game, which keeps deployment
 * atomic and avoids relying on Bitburner's script server as a Worker URL.
 *
 * The merged phase playbook cannot join the IIFE bundle (it inflates its
 * certificate blob with top-level await), so it is prepended as an inlined
 * classic script that publishes `__combinedPlaybook`/`__combinedPlaybookReady`
 * on the worker global — the same transform the standalone build uses. */
export async function bundleGoWorkerSource(): Promise<string> {
  const result = await build({
    entryPoints: ["game/lib/go-neural-worker-entry.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    logLevel: "warning",
    minifyWhitespace: true,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("V9 Go worker bundle produced no output");
  const playbookSource = await readFile(GO_PLAYBOOK_MODULE, "utf8").catch(() => undefined);
  if (playbookSource === undefined) return output.text;
  const { inlinePlaybookScript } = await import("./go-playbook-inline.ts");
  return `${inlinePlaybookScript(playbookSource)}\n${output.text}`;
}

/** Build one maintenance entrypoint without clearing or building the normal
 * deployment set. save:restore is intentionally the only caller. */
export async function buildScript(
  config: BitburnerConfig,
  entry: BuildEntry,
  options: BuildOptions = { telemetry: true },
): Promise<BuiltArtifact> {
  safeBuildDir(config.buildDir);
  await mkdir(config.buildDir, { recursive: true });
  const buildId = createBuildId();
  const goWorkerSource = await bundleGoWorkerSource();
  return bundleEntry(config, entry, artifactName(entry, buildId), buildId, options, goWorkerSource);
}

export async function buildScripts(
  config: BitburnerConfig,
  options: BuildOptions = { telemetry: true },
): Promise<BuiltArtifact[]> {
  safeBuildDir(config.buildDir);
  await rm(config.buildDir, { recursive: true, force: true });
  await mkdir(config.buildDir, { recursive: true });
  const buildId = createBuildId();
  const goWorkerSource = await bundleGoWorkerSource();

  const built: { artifact: BuiltArtifact; versioned: boolean }[] = [];
  for (const entry of config.entries) {
    const filename = artifactName(entry, buildId);
    built.push({
      artifact: await bundleEntry(config, entry, filename, buildId, options, goWorkerSource),
      versioned: entry.versioned === true,
    });
  }

  // Immutable helpers go first. The stable controller is replaced only after
  // every helper exists, and the stamp remains the final commit point.
  const artifacts = [
    ...built.filter((item) => item.versioned).map((item) => item.artifact),
    ...built.filter((item) => !item.versioned).map((item) => item.artifact),
  ];
  await writeFile(path.join(config.buildDir, BUILD_ID_FILE), buildId, "utf8");
  artifacts.push({ filename: BUILD_ID_FILE, content: buildId });
  return artifacts;
}

if (import.meta.main) {
  const config = await loadConfig();
  const artifacts = await buildScripts(config, { telemetry: !process.argv.includes("--perf") });
  for (const artifact of artifacts) console.log(`built ${artifact.filename}`);
}

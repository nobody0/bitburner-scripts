import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { loadConfig, type BitburnerConfig } from "./config.ts";

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

export async function buildScripts(
  config: BitburnerConfig,
  options: BuildOptions = { telemetry: true },
): Promise<BuiltArtifact[]> {
  await rm(config.buildDir, { recursive: true, force: true });
  await mkdir(config.buildDir, { recursive: true });
  const buildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  for (const entry of config.entries) {
    const outfile = path.join(config.buildDir, entry.target);
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
      define: {
        __TELEMETRY__: options.telemetry ? "true" : "false",
        __BUILD_ID__: JSON.stringify(buildId),
      },
      // Keep bracket-notation ns calls intact (syntax minification rewrites
      // them and breaks dodge RAM accounting), while still removing guarded
      // telemetry payloads completely from performance bundles.
      dropLabels: options.telemetry ? [] : ["TELEMETRY"],
    });
  }

  const artifacts = await Promise.all(
    config.entries.map(async (entry) => ({
      filename: entry.target,
      content: await readFile(path.join(config.buildDir, entry.target), "utf8"),
    })),
  );
  // Synthetic artifact: pushed like any other file, read in-game via ns.read.
  artifacts.push({ filename: BUILD_ID_FILE, content: buildId });
  return artifacts;
}

if (import.meta.main) {
  const config = await loadConfig();
  const artifacts = await buildScripts(config, { telemetry: !process.argv.includes("--perf") });
  for (const artifact of artifacts) console.log(`built ${artifact.filename}`);
}

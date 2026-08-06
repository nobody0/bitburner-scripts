import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { loadConfig, type BitburnerConfig } from "./config.ts";

export interface BuiltArtifact {
  filename: string;
  content: string;
}

export async function buildScripts(config: BitburnerConfig): Promise<BuiltArtifact[]> {
  await rm(config.buildDir, { recursive: true, force: true });
  await mkdir(config.buildDir, { recursive: true });

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
    });
  }

  return Promise.all(
    config.entries.map(async (entry) => ({
      filename: entry.target,
      content: await readFile(path.join(config.buildDir, entry.target), "utf8"),
    })),
  );
}

if (import.meta.main) {
  const config = await loadConfig();
  const artifacts = await buildScripts(config);
  for (const artifact of artifacts) console.log(`built ${artifact.filename}`);
}


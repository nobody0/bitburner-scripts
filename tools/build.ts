import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as acorn from "acorn";
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
  /** When false, local identifiers keep their source names. Deployment
   * minifies by default; `sync --readable` and tests that inspect the bundle's
   * ns-call surface disable it — identifier renaming never touches property
   * names or string literals, so the surface is provably identical (see
   * ram-budget.test.ts). */
  minifyNames?: boolean;
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

/** Bitburner's static analyzer honours `ns.ramOverride(<literal>)` only as
 * the first statement of a top-level function declaration literally named
 * `main`. Whether the bundle still has one depends on the build flavour, so
 * the decoy below is appended conditionally — see mainOverrideStatus. */
function ramOverrideDirective(entrySource: string): { gb: number; decoy: string } | undefined {
  const match = /ns\.ramOverride\((\d+(?:\.\d+)?)\)/.exec(entrySource);
  if (!match) return undefined;
  return { gb: Number(match[1]), decoy: `async function main(ns){ns.ramOverride(${match[1]})}` };
}

/** Whether the bundle already carries the syntactic override the game's
 * analyzer looks for. The two build flavours end in different places:
 *
 *  - minified: identifier renaming strips the source `main` (the export alias
 *    survives, the declaration name does not), no top-level `main` exists, and
 *    the decoy must be appended. It is dead code — the exported renamed main
 *    is what runs.
 *  - names-preserved: the source `main` survives and already satisfies the
 *    analyzer. Appending the decoy here would be worse than redundant: a later
 *    duplicate `function main` re-binds the module's bare `export { main }`,
 *    so the game would import and run the no-op decoy instead of the
 *    controller.
 *
 * A top-level `main` that does NOT begin with the expected override is a build
 * error either way: the analyzer would misprice it, and appending the decoy
 * beside it would shadow whichever the game resolves. */
export function mainOverrideStatus(moduleSource: string, expectedGb: number): "satisfied" | "absent" {
  const program = acorn.parse(moduleSource, { ecmaVersion: "latest", sourceType: "module" });
  let status: "satisfied" | "absent" = "absent";
  for (const node of program.body) {
    const declaration =
      node.type === "FunctionDeclaration"
        ? node
        : node.type === "ExportNamedDeclaration" && node.declaration?.type === "FunctionDeclaration"
          ? node.declaration
          : undefined;
    if (declaration?.id?.name !== "main") continue;
    const first = declaration.body.body[0];
    const call = first?.type === "ExpressionStatement" && first.expression.type === "CallExpression" ? first.expression : undefined;
    const callee = call?.callee;
    const argument = call?.arguments.length === 1 ? call.arguments[0] : undefined;
    const overrides =
      callee?.type === "MemberExpression" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "ramOverride" &&
      argument?.type === "Literal" &&
      typeof argument.value === "number" &&
      Math.round(argument.value * 100) === Math.round(expectedGb * 100);
    if (!overrides) {
      throw new Error(`a top-level \`main\` declaration does not begin with ns.ramOverride(${expectedGb})`);
    }
    status = "satisfied";
  }
  return status;
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
  const directive = ramOverrideDirective(await readFile(entry.source, "utf8"));
  await build({
    entryPoints: [entry.source],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    sourcemap: "external",
    logLevel: "warning",
    // Whitespace and identifier minification shrink the bundle without
    // rewriting property access: identifier renaming touches only local
    // bindings, never property names or string literals, so bracketed dodged
    // ns calls survive verbatim. Syntax minification remains forbidden
    // because it can turn bracketed dodged ns calls into dotted calls and
    // change the game's static RAM accounting.
    minifyWhitespace: true,
    minifyIdentifiers: options.minifyNames !== false,
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
  let content = await readFile(outfile, "utf8");
  if (directive) {
    // The sourcemap comment must stay the last line, so the decoy is inserted
    // in front of it rather than appended.
    const mapComment = /\/\/# sourceMappingURL=\S*\s*$/.exec(content);
    const body = mapComment ? content.slice(0, mapComment.index) : content;
    try {
      if (mainOverrideStatus(body, directive.gb) === "absent") {
        content = `${body.trimEnd()}\n${directive.decoy}\n${mapComment ? content.slice(mapComment.index) : ""}`;
        // The on-disk artifact must stay byte-identical to the pushed one.
        await writeFile(outfile, content, "utf8");
      }
    } catch (error) {
      throw new Error(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { filename, content };
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
    // The worker never runs under ns: it executes as a Blob-URL Worker and is
    // embedded into start.js as a string literal the game's static RAM parser
    // never reads, so full minification (syntax included) is safe here.
    minify: true,
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

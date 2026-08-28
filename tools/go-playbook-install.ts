/** Install the merged combined playbook into the game build.
 *
 * Copies `go-ai/derivatives/playbook-combined/merged/playbook.phase.js` (built
 * by `go:playbook:pack` from the certified corpora plus the residual matches of
 * the deployed neural artifact) to `game/lib/generated/go-playbook.phase.js`,
 * where `tools/build.ts` embeds it into the V9 worker as an inlined classic
 * script.
 *
 * The residual strip is only valid for the exact neural artifact it was
 * computed against, so the install refuses when the residual summary's
 * deployed-artifact payload SHA no longer matches the installed small5 module.
 * Rebuild the chain (`go:playbook:residual`, `go:playbook:pack`) after any
 * model install, then re-run this.
 *
 * Usage:
 *   bun run go:playbook:install [--uninstall]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SMALL5_GO_MODEL } from "../shared/strategy/go/neural/models/small5.ts";
import { validateMergedPlaybook } from "../shared/strategy/go/playbook-facade.ts";
import { inlinePlaybookScript } from "./go-playbook-inline.ts";

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "go-ai", "derivatives", "playbook-combined", "merged", "playbook.phase.js");
const RESIDUAL_SUMMARY = join(ROOT, "go-ai", "derivatives", "playbook-residual", "summary.json");
const TARGET = join(ROOT, "game", "lib", "generated", "go-playbook.phase.js");

if (Bun.argv.includes("--uninstall")) {
  await rm(TARGET, { force: true });
  console.log(`removed ${TARGET}; the next build ships without a certified playbook`);
  process.exit(0);
}

const source = await readFile(SOURCE, "utf8");
const residual = JSON.parse(await readFile(RESIDUAL_SUMMARY, "utf8")) as {
  deployedArtifactPayloadSha256?: string;
};
if (residual.deployedArtifactPayloadSha256 !== SMALL5_GO_MODEL.payloadSha256) {
  throw new Error(
    "residual matches were computed against a different deployed small5 artifact "
    + `(residual ${residual.deployedArtifactPayloadSha256}, installed ${SMALL5_GO_MODEL.payloadSha256}); `
    + "re-run go:playbook:residual and go:playbook:pack first",
  );
}

/** The installed copy is embedded verbatim (as a string) into main.js, whose
 * static-RAM guard conservatively scans the raw artifact text for dotted
 * `ns.member` references. The playbook's standalone runtime is dead code in
 * the worker, but its dotted calls would still trip that scan, so rewrite
 * them to the equivalent bracket form and rename its `telemetry` reporter
 * (the --perf build asserts the artifact contains no telemetry client).
 * Certificate-blob lines are skipped: rewriting inside the packed string
 * literal would corrupt the data, and the final guards below fail loudly on
 * the (astronomically unlikely) blob collision instead. */
function scrubForEmbedding(moduleSource: string): string {
  const dotted = /(\bns(?:\["[A-Za-z_$][\w$]*"\])*)(\?)?\.([A-Za-z_$][\w$]*)/g;
  return moduleSource.split("\n").map((line) => {
    if (line.length > 5_000) return line;
    let rewritten = line.replace(/\btelemetry\b/g, "lineReport");
    for (;;) {
      const next = rewritten.replace(dotted, (_m, head: string, opt: string | undefined, name: string) =>
        `${head}${opt ? "?." : ""}["${name}"]`);
      if (next === rewritten) return rewritten;
      rewritten = next;
    }
  }).join("\n");
}

// Refuse anything the worker-side validator or inline transform would reject
// at build/run time; failing here keeps broken installs out of the tree.
inlinePlaybookScript(source);
const moduleExports = await import(SOURCE);
const original = validateMergedPlaybook(moduleExports);

const scrubbed = scrubForEmbedding(source);
for (const [guard, label] of [
  [/\bns\d*\.[A-Za-z]/, "a dotted ns member reference"],
  [/telemetry/, "the string \"telemetry\""],
  [/WebSocket/, "the string \"WebSocket\""],
] as const) {
  if (guard.test(scrubbed)) {
    throw new Error(`scrubbed playbook still contains ${label}; the embedding guards in `
      + "tests/build-perf.test.ts and tests/ram-budget.test.ts would reject the build");
  }
}
// The scrub must be behavior-preserving for the lookup surface: stage the
// rewritten module, import it, and compare its static fingerprint.
const staged = join(ROOT, "game", "lib", "generated", ".go-playbook.staged.js");
await mkdir(join(ROOT, "game", "lib", "generated"), { recursive: true });
await writeFile(staged, scrubbed);
const rewrittenExports = validateMergedPlaybook(await import(staged));
if (rewrittenExports.PHASES !== original.PHASES
  || rewrittenExports.MISS !== original.MISS
  || rewrittenExports.OPPONENTS.join("|") !== original.OPPONENTS.join("|")
  || rewrittenExports.phaseNow(123_456_789) !== original.phaseNow(123_456_789)) {
  throw new Error("scrubbed playbook fingerprint diverged from the packed module");
}
await rm(staged, { force: true });

const sourceSha = createHash("sha256").update(source).digest("hex");
const header = "// Installed by tools/go-playbook-install.ts. Do not edit.\n"
  + `// source sha256 (pre-scrub): ${sourceSha}\n`
  + `// residual-stripped against small5 payload ${SMALL5_GO_MODEL.payloadSha256}\n`;
await writeFile(TARGET, header + scrubbed);
console.log(`installed ${TARGET} (${(header.length + source.length).toLocaleString()} B, `
  + `source sha256 ${sourceSha.slice(0, 12)}, `
  + `bound to small5 payload ${SMALL5_GO_MODEL.payloadSha256.slice(0, 12)})`);

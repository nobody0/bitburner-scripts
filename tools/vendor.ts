import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Re-extracts the pure formula core from the pinned game source tag into
 * sim/vendor/bitburner/. Reads git objects directly (`git show tag:path`), so
 * the sparse checkout stays untouched. Patches hard-fail when their find
 * string is absent — that is the drift detector when bumping TAG. */

const TAG = "v3.0.1";
const SRC_REPO = process.env.BITBURNER_SRC ?? "/Users/bob/git/bitburner-src";
const OUT_DIR = "sim/vendor/bitburner";

interface Patch {
  find: string;
  replace: string;
}

interface VendorFile {
  path: string;
  patches?: Patch[];
}

const MANIFEST: VendorFile[] = [
  {
    path: "src/Hacking.ts",
    patches: [
      // DarknetServer's import graph detonates into the whole game UI. Cost:
      // we lose the "darknet servers hack in a flat 16s" special case.
      { find: `import { DarknetServer } from "./Server/DarknetServer";\n`, replace: "" },
      { find: `  if (server instanceof DarknetServer) return 16;\n`, replace: "" },
    ],
  },
  {
    path: "src/Server/formulas/grow.ts",
    patches: [
      // ServerHelpers pulls in the game; getCoreBonus is one line.
      {
        find: `import { getCoreBonus } from "../ServerHelpers";`,
        replace: `const getCoreBonus = (cores = 1): number => 1 + (cores - 1) / 16;`,
      },
    ],
  },
  { path: "src/PersonObjects/formulas/skill.ts" },
  { path: "src/PersonObjects/formulas/intelligence.ts" },
  { path: "src/PersonObjects/Multipliers.ts" },
  { path: "src/Hacknet/formulas/HacknetNodes.ts" },
  { path: "src/Hacknet/formulas/HacknetServers.ts" },
  {
    path: "src/BitNode/BitNodeMultipliers.ts",
    patches: [
      // Mixed type/value import fails our verbatimModuleSyntax typecheck.
      {
        find: `import { PartialRecord, getRecordEntries } from "../Types/Record";`,
        replace: `import { getRecordEntries, type PartialRecord } from "../Types/Record";`,
      },
    ],
  },
  { path: "src/Constants.ts" },
  { path: "src/Server/data/Constants.ts" },
  { path: "src/Hacknet/data/Constants.ts" },
  { path: "src/Types/Record.ts" },
  { path: "src/utils/helpers/clampNumber.ts" },
  { path: "src/utils/helpers/isValidNumber.ts" },
  { path: "src/utils/helpers/isPowerOfTwo.ts" },
];

function gitShow(objectPath: string): string {
  return execFileSync("git", ["-C", SRC_REPO, "show", `${TAG}:${objectPath}`], { encoding: "utf8" });
}

function vendorStatusDirty(): boolean {
  try {
    return execFileSync("git", ["status", "--porcelain", "--", OUT_DIR], { encoding: "utf8" }).trim() !== "";
  } catch {
    return false;
  }
}

if (vendorStatusDirty() && !process.argv.includes("--force")) {
  throw new Error(`${OUT_DIR} has uncommitted changes; commit or discard them (or pass --force)`);
}

const written: { path: string; sha256: string }[] = [];
for (const file of MANIFEST) {
  let content = gitShow(file.path);
  for (const patch of file.patches ?? []) {
    if (!content.includes(patch.find)) {
      throw new Error(`${file.path}: patch target not found (source drifted?):\n${patch.find}`);
    }
    content = content.replace(patch.find, patch.replace);
  }
  // @nsdefs exports only types; make that explicit so the import erases at
  // runtime (Bun would otherwise try to load the .d.ts as a module).
  content = content.replace(/^import \{([^}]*)\} from "@nsdefs";$/gm, `import type {$1} from "@nsdefs";`);

  const outPath = path.join(OUT_DIR, file.path);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const header = `// Vendored from bitburner-src ${TAG}:${file.path} by tools/vendor.ts — DO NOT EDIT\n`;
  writeFileSync(outPath, header + content, "utf8");
  written.push({ path: file.path, sha256: createHash("sha256").update(header + content).digest("hex") });
  console.log(`vendored ${file.path}`);
}

/** Slice a single `export function name(...)` out of a source file whose other
 * contents are not portable (react/@player imports). Ends at the first
 * column-zero `}`. */
function extractFunction(sourcePath: string, name: string, prologue: string[], outRelPath: string, patches: Patch[] = []): void {
  const lines = gitShow(sourcePath).split("\n");
  const start = lines.findIndex((l) => l.startsWith(`export function ${name}`));
  if (start === -1) throw new Error(`${sourcePath}: ${name} not found (source drifted?)`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  let fn = lines.slice(start, end + 1).join("\n");
  for (const patch of patches) {
    if (!fn.includes(patch.find)) throw new Error(`${sourcePath}#${name}: patch target not found:\n${patch.find}`);
    fn = fn.replace(patch.find, patch.replace);
  }
  const synthesized = [
    `// Vendored from bitburner-src ${TAG}:${sourcePath} (${name} only, extracted by`,
    `// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT`,
    ...prologue,
    ``,
    fn,
    ``,
  ].join("\n");
  const outPath = path.join(OUT_DIR, outRelPath);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, synthesized, "utf8");
  written.push({ path: `${sourcePath}#${name}`, sha256: createHash("sha256").update(synthesized).digest("hex") });
  console.log(`vendored ${sourcePath}#${name} -> ${outRelPath}`);
}

// Pure BitNodeMultipliers literals; the rest of BitNode.tsx imports react/@player.
extractFunction(
  "src/BitNode/BitNode.tsx",
  "getBitNodeMultipliers",
  [
    `import { BitNodeMultipliers } from "./BitNodeMultipliers";`,
    ``,
    `const defaultMultipliers = new BitNodeMultipliers();`,
    `Object.freeze(defaultMultipliers);`,
  ],
  "src/BitNode/BitNodeMults.ts",
);

// The Newton-Raphson grow-thread inverse: precision-tuned, worth vendoring
// verbatim. Only patch: drop the `= Player` default so callers pass a person.
extractFunction(
  "src/Server/ServerHelpers.ts",
  "numCycleForGrowthCorrected",
  [
    `import type { Person as IPerson, Server as IServer } from "@nsdefs";`,
    `import { calculateServerGrowthLog } from "./formulas/grow";`,
  ],
  "src/Server/GrowthCycles.ts",
  [{ find: `person: IPerson = Player,`, replace: `person: IPerson,` }],
);

writeFileSync(
  path.join("sim/vendor", "manifest.json"),
  JSON.stringify({ tag: TAG, files: written }, null, 2) + "\n",
  "utf8",
);
console.log(`wrote sim/vendor/manifest.json (${written.length} files @ ${TAG})`);

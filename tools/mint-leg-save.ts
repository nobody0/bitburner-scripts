/** Mint the registered checkpoint that STARTS a speedrun leg.
 *
 * A leg's entrance is derived from the route rather than captured from a
 * game, so the checkpoint has to be written. This is the manual entry point;
 * `sim/run.ts` mints the next leg's checkpoint automatically when a leg run
 * reaches its goal.
 *
 *   bun run tools/mint-leg-save.ts bn4.1          # the fresh start of the route
 *   bun run tools/mint-leg-save.ts bn4.2 --force  # replace an existing id
 */
import { gzipSync } from "bun";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { encodeSaveJson } from "../shared/save/encode.ts";
import { deriveRouteLegs, SPEEDRUN_ROUTE_ID, type RouteLeg } from "../shared/strategy/progression/route-legs.ts";
import { routeLegEntranceSnapshot } from "../sim/save-mint.ts";
import { SIMULATOR_MODEL_VERSION, SIMULATOR_VENDOR_COMMIT } from "../sim/fidelity.ts";
import { readIndex, registerSave, SAVES_DIR, type SaveEntry } from "./save-io.ts";

function legSaveId(leg: Pick<RouteLeg, "leg">): string {
  return `leg-${leg.leg}-start`;
}

export interface MintedLegSave {
  entry: SaveEntry;
  file: string;
}

/** Write and register the checkpoint for a leg's entrance. Refuses an id that
 * is already registered unless `force` is set: a registered blob's bytes are
 * embedded in route lineage, so replacing one silently would invalidate every
 * downstream result without saying so. */
export function mintLegSave(
  leg: RouteLeg,
  options: { force?: boolean; note?: string } = {},
): MintedLegSave {
  const id = legSaveId(leg);
  if (!options.force && readIndex().saves.some((save) => save.id === id)) {
    throw new Error(
      `"${id}" is already registered. Registered bytes are embedded in route lineage — ` +
        "register a new id, or pass --force if you intend to replace it.",
    );
  }
  const file = path.join(SAVES_DIR, `${id}.json.gz`);
  writeFileSync(file, gzipSync(Buffer.from(encodeSaveJson(routeLegEntranceSnapshot(leg)), "utf8")));
  const sourceFiles = Object.entries(leg.entranceSourceFiles)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([sf, level]) => `${sf}.${level}`)
    .join(", ") || "none";
  const entry = registerSave(id, file, `start of ${leg.leg}`, {
    minted: true,
    notes: options.note ??
      `minted entrance for route ${SPEEDRUN_ROUTE_ID} leg ${leg.index} (${leg.leg}, milestone ${leg.milestone}): ` +
        `SF ${sourceFiles}, intelligence ${leg.entranceIntelligence} (${leg.intelligenceSource}); ` +
        `simulator model ${SIMULATOR_MODEL_VERSION}, vendor ${SIMULATOR_VENDOR_COMMIT}`,
  });
  return { entry, file };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const name = args.find((arg) => !arg.startsWith("--"));
  const force = args.includes("--force");
  const legs = deriveRouteLegs();
  if (!name) {
    console.error("usage: bun run tools/mint-leg-save.ts <leg> [--force]");
    console.error(`legs: ${legs.map((leg) => leg.leg).join(", ")}`);
    process.exit(1);
  }
  const leg = legs.find((entry) => entry.leg === name);
  if (!leg) {
    console.error(`unknown leg "${name}"`);
    console.error(`legs: ${legs.map((entry) => entry.leg).join(", ")}`);
    process.exit(1);
  }
  if (existsSync(path.join(SAVES_DIR, `${legSaveId(leg)}.json.gz`)) && !force) {
    console.error(`${legSaveId(leg)}.json.gz already exists; pass --force to replace it`);
    process.exit(1);
  }
  const minted = mintLegSave(leg, { force });
  console.log(`minted ${minted.entry.id} -> ${path.basename(minted.file)}`);
  console.log(`  BN${minted.entry.bitNode}, ${minted.entry.notes}`);
  console.log(`  bun run sim -- --profile leg-${leg.leg} --save ${minted.entry.id}`);
}

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { effectiveBitNodeMultipliers } from "../shared/features/bitnode.ts";

/** WHERE A BITNODE MULTIPLIER MAY COME FROM.
 *
 * `state.topics.progression.multipliers` is populated only from
 * `ns.getBitNodeMultipliers`, which is gated behind BN5/SF5
 * (game/lib/probes/priced.ts, shared/telemetry/topics/progression.ts). Reading
 * a field off it directly therefore returns `undefined` in every run without
 * SF5 — and a `?? 1` fallback turns that into "this node does not scale it",
 * which is a different and usually wrong claim.
 *
 * `effectiveBitNodeMultipliers` exists to close exactly that gap: the pinned
 * static table supplies the baseline and an observed getter result still wins
 * field-by-field. Decision code must go through it.
 *
 * The bug this pins: `game/lib/features/dnet.ts` read
 * `progression?.multipliers?.["DarknetMoneyMultiplier"] ?? 1`, so a fresh BN4
 * priced darknet phishing at 1.0 instead of 0.4 and overvalued it 2.5x against
 * crime and hacking in the arbiter's rate comparison. BN9 (0.05) was off 20x. */

const root = resolve(import.meta.dir, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative(root, path));
    return extname(entry.name) === ".ts" ? [path] : [];
  });
}

/** A field lookup hanging directly off a `multipliers` topic read. Passing the
 * topic on as an argument (`effectiveBitNodeMultipliers(n, sf12, mults)`) is
 * the supported use and does not match: only a following `[` or `.` does. */
const DIRECT_FIELD_READ = /\bmultipliers\s*\??\.\s*\[|\bmultipliers\s*\?\.\s*[A-Z]/g;

describe("bitnode multipliers come from the table, not the SF5-gated getter", () => {
  test("no decision code reads a field straight off the progression multipliers topic", () => {
    const offenders: string[] = [];
    for (const directory of ["game/lib", "shared/strategy"]) {
      for (const path of sourceFiles(directory)) {
        const source = readFileSync(path, "utf8");
        for (const line of source.split("\n")) {
          // `context.multipliers` on the factions view is the PLAYER's
          // augmentation multiplier bag, not the BitNode's — different object,
          // no SF5 gate, and legitimately read by field.
          if (line.includes("context.multipliers")) continue;
          if (DIRECT_FIELD_READ.test(line)) {
            offenders.push(`${relative(root, path).split(sep).join("/")}: ${line.trim()}`);
          }
          DIRECT_FIELD_READ.lastIndex = 0;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the table supplies every node's darknet multiplier with no SF5 and no observed getter", () => {
    // The exact values the dnet driver was getting wrong. `undefined` observed
    // is the fresh-BN4 case: no SF5, so the topic carries no multipliers.
    expect(effectiveBitNodeMultipliers(4, 0, undefined)?.["DarknetMoneyMultiplier"]).toBe(0.4);
    expect(effectiveBitNodeMultipliers(9, 0, undefined)?.["DarknetMoneyMultiplier"]).toBe(0.05);
    expect(effectiveBitNodeMultipliers(1, 0, undefined)?.["DarknetMoneyMultiplier"]).toBe(1);
    // An observed getter result still wins, so a BitNode option that moves the
    // field is not overridden by the table.
    expect(
      effectiveBitNodeMultipliers(4, 0, { DarknetMoneyMultiplier: 0.9 })?.["DarknetMoneyMultiplier"],
    ).toBe(0.9);
  });
});

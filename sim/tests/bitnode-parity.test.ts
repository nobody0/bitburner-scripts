import { describe, expect, test } from "bun:test";
import { BITNODES, DEFAULT_BITNODE_MULTIPLIERS } from "../../shared/features/bitnode.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { BitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";

/** `shared/features/bitnode.ts` hand-transcribes BitNode reference data that
 * `sim/vendor/` already carries, because `shared/` may not import the vendored
 * game source (tests/boundaries.test.ts) and the UI needs these values at
 * runtime to show which multipliers the active node actually changes.
 *
 * That is the same trade `shared/formulas.ts` makes, so it gets the same
 * safety net: a parity suite living in `sim/`, which MAY read the vendored
 * originals. Without it the transcription silently rots the next time
 * `bun run vendor` pulls a newer game — the UI would keep diffing against last
 * year's baseline and quietly report wrong "changed" multipliers.
 *
 * If this suite fails after a vendor bump, the fix is to update
 * shared/features/bitnode.ts to match the new game data. */

describe("BitNode reference data parity", () => {
  const vendored = { ...new BitNodeMultipliers() } as Record<string, number>;

  test("the default multiplier field set matches the vendored class exactly", () => {
    // Sorted so an added/removed/renamed field reads as a clean diff.
    expect(Object.keys(DEFAULT_BITNODE_MULTIPLIERS).sort()).toEqual(Object.keys(vendored).sort());
  });

  test("every default value matches the vendored class", () => {
    // Catches the two that are not 1 (DaedalusAugsRequirement, and
    // StaneksGiftExtraSize) drifting, as well as any new non-unit default.
    for (const [field, value] of Object.entries(vendored)) {
      expect(DEFAULT_BITNODE_MULTIPLIERS[field], `default for ${field}`).toBe(value);
    }
  });

  test("BITNODES covers exactly the BitNodes the game defines", () => {
    // getBitNodeMultipliers throws "Invalid BitNodeN" outside the known range,
    // so this pins both ends: a node we list that the game dropped, and a node
    // the game added that our grid would silently omit.
    for (const node of BITNODES) {
      expect(() => getBitNodeMultipliers(node.n, 1), `BN${node.n} is listed but unknown to the game`).not.toThrow();
    }
    expect(() => getBitNodeMultipliers(BITNODES.length + 1, 1)).toThrow();
  });

  test("no BitNode overrides a multiplier missing from the defaults", () => {
    // The UI diffs an active node's multipliers against DEFAULT_BITNODE_MULTIPLIERS.
    // A field present in an override but absent from the defaults would be
    // rendered against a guessed baseline of 1 — wrong for anything like
    // DaedalusAugsRequirement.
    const unknown = new Set<string>();
    for (const node of BITNODES) {
      for (const field of Object.keys(getBitNodeMultipliers(node.n, 1))) {
        if (!(field in DEFAULT_BITNODE_MULTIPLIERS)) unknown.add(`BN${node.n}:${field}`);
      }
    }
    expect([...unknown]).toEqual([]);
  });
});

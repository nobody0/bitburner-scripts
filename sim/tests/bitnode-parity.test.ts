import { describe, expect, test } from "bun:test";
import {
  BITNODES,
  DEFAULT_BITNODE_MULTIPLIERS,
  bitNodeMultipliers,
  worldDaemonSkill,
} from "../../shared/features/bitnode.ts";
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

  // The transcribed per-node table is what lets the controller know its own
  // multipliers without SF5 and without the 4 GB getter. It is also the single
  // most tedious thing in `shared/` to keep correct by hand, so it is pinned
  // field-by-field rather than spot-checked.
  test("every node's transcribed multipliers match the vendored getter exactly", () => {
    for (const node of BITNODES) {
      // lvl only affects BN12; pass 0 so the non-BN12 comparison is unambiguous.
      const vendoredMults = { ...getBitNodeMultipliers(node.n, 0) } as Record<string, number>;
      const ours = bitNodeMultipliers(node.n, 0);
      expect(ours, `BN${node.n} is missing from the transcription`).toBeDefined();
      for (const [field, value] of Object.entries(vendoredMults)) {
        expect(ours![field], `BN${node.n}.${field}`).toBe(value);
      }
      // And nothing invented: same field set, so a stray key cannot hide.
      expect(Object.keys(ours!).sort()).toEqual(Object.keys(vendoredMults).sort());
    }
  });

  test("BN12 tracks the vendored source-file-level formula", () => {
    // BN12 is a formula, not a table, and it is the one node whose multipliers
    // change between visits — so it is swept rather than sampled once.
    for (const lvl of [0, 1, 2, 3, 5, 10, 25, 50, 100]) {
      const vendoredMults = { ...getBitNodeMultipliers(12, lvl) } as Record<string, number>;
      const ours = bitNodeMultipliers(12, lvl)!;
      for (const [field, value] of Object.entries(vendoredMults)) {
        expect(ours[field], `BN12.${field} at SF12 level ${lvl}`).toBe(value);
      }
    }
  });

  test("an unknown BitNode yields undefined rather than BN1's defaults", () => {
    // "We do not know what node this is" and "this is BN1" must not collapse
    // into the same value: BN1 is the all-ones baseline, so a wrong guess of
    // BN1 is silently the most dangerous default possible.
    expect(bitNodeMultipliers(undefined)).toBeUndefined();
    expect(bitNodeMultipliers(BITNODES.length + 1)).toBeUndefined();
  });

  test("worldDaemonSkill matches the server's scaled requirement", () => {
    // ServerHelpers multiplies the 3000 base by WorldDaemonDifficulty.
    for (const node of BITNODES) {
      const expected = 3000 * getBitNodeMultipliers(node.n, 0).WorldDaemonDifficulty;
      expect(worldDaemonSkill(node.n, 0), `BN${node.n} w0r1d_d43m0n skill`).toBe(expected);
    }
  });
});

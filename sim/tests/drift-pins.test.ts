import { describe, expect, test } from "bun:test";
import manifest from "../vendor/manifest.json";
import { TRANSCRIPTION_SOURCE_HASHES } from "../transcription-sources.ts";
import { RAM_COST_CONSTANTS } from "../../shared/strategy/ram-supply.ts";
import { ServerConstants } from "../vendor/bitburner/src/Server/data/Constants.ts";

/** DRIFT PINS — the cheapest tests in the repository, and the ones that decide
 * whether every expensive test is still measuring the right game.
 *
 * Neither of these proves any behaviour. They prove that the things we COPIED
 * out of the game still match the game we pinned. That matters because the
 * copies are invisible once made: a vendor bump moves upstream, our
 * transcription stays where it was, and nothing else in the suite would notice
 * — the parity suites would keep comparing our copy against our copy's own
 * vendored snapshot and keep passing while both drifted away from the release
 * the player is running.
 *
 * A failure here is never "fix the assertion". It is "upstream changed; go
 * audit what changed and re-transcribe", and the accepted hashes only move
 * after that audit.
 *
 * See spec/game-source.md for the full transcription-to-parity-suite table. */

describe("handwritten simulator source drift", () => {
  test("every accepted transcription source matches the generated upstream manifest", () => {
    expect(manifest.transcriptionSources).toEqual(TRANSCRIPTION_SOURCE_HASHES);
  });
});

describe("constants copied into the game bundle", () => {
  /** `shared/strategy/ram-supply.ts` cannot import the vendored constants — it
   * ships inside the game bundle, and `sim/` is the only place allowed to read
   * both sides — so it transcribes them and this is where the two meet. */
  test("game-bundle RAM constants match the pinned vendor", () => {
    expect(RAM_COST_CONSTANTS.BaseCostFor1GBOfRamHome).toBe(ServerConstants.BaseCostFor1GBOfRamHome);
    expect(RAM_COST_CONSTANTS.BaseCostFor1GBOfRamServer).toBe(ServerConstants.BaseCostFor1GBOfRamServer);
  });
});

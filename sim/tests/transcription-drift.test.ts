import { describe, expect, test } from "bun:test";
import manifest from "../vendor/manifest.json";
import { TRANSCRIPTION_SOURCE_HASHES } from "../transcription-sources.ts";

describe("handwritten simulator source drift", () => {
  test("every accepted transcription source matches the generated upstream manifest", () => {
    expect(manifest.transcriptionSources).toEqual(TRANSCRIPTION_SOURCE_HASHES);
  });
});
